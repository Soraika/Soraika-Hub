/**
 * 海报多源验收 —— 「一个源 404 就换下一个，不是没图」
 * ---------------------------------------------------------------------------
 * 用法：由 `npm run verify` 串联执行，也可单独 `node scripts/verify-poster.mjs`
 * 隔离：独立库 + 独立端口 + **两个本地假图床**（一个故意 404、一个正常发图），
 *       全程不碰外网 —— 否则验收会随图床的状态飘。
 *
 * 覆盖：
 *   · 静态候选链：库里那条 → 各镜像域名上的同一条路径 → 后端代理
 *   · 镜像只换 host、**路径与协议原样保留**（路径里有日期目录与文件名哈希，换不得）
 *   · 非 Mikan 图床的地址不瞎换域名（Bangumi 的图不在 mikan 镜像上）
 *   · 接口层：首页卡片带 `posterFallbacks`，第一条是镜像、最后一条是代理
 *   · 出图接口：主图 404 → 自动换镜像 → 落盘 → **把可用地址写回库里**（自愈）
 *   · 全部源都挂 → 302 交给浏览器，不 500
 *   · 刚 404 过的地址进黑名单，不会每次都重试（否则首页每张图都慢）
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, rmSync, readdirSync } from 'node:fs'

const PORT = Number(process.env.VERIFY_POSTER_PORT || 3308)
const base = `http://127.0.0.1:${PORT}`
const DB_FILE = 'data/tmp-verify-poster.db'
/* 落盘目录是 import 时从配置算出来的常量（image.dir 标了 restart），测试改不了它 ——
   所以改成「跑前快照 → 跑后只删这次新建的文件」，不污染真实缓存，也不删别人的 */
const IMG_DIR = 'data/img'

let failed = 0
const check = (ok, msg, detail = '') => {
  if (!ok) failed++
  console.log(`${ok ? '✓' : '✗'} ${msg}${detail ? ` → ${detail}` : ''}`)
}

const imgSnapshot = () => (existsSync(IMG_DIR) ? new Set(readdirSync(IMG_DIR)) : new Set())
const imgBefore = imgSnapshot()

const clean = () => {
  for (const suffix of ['', '-wal', '-shm']) {
    const file = `${DB_FILE}${suffix}`
    if (existsSync(file)) rmSync(file, { force: true })
  }
  /* 只删这一轮新写进来的图（按文件名比对，绝不整目录删） */
  if (existsSync(IMG_DIR)) {
    for (const name of readdirSync(IMG_DIR)) {
      if (imgBefore.has(name)) continue
      try { rmSync(`${IMG_DIR}/${name}`, { force: true }) } catch { /* 占用中就留着 */ }
    }
  }
}
clean()

/* 一张最小的「合法」JPEG（magic bytes 正确、体积够 MIN_BYTES）——嗅探只看头几个字节 */
const FAKE_JPG = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]),
  Buffer.alloc(1200, 0x20),
  Buffer.from([0xff, 0xd9]),
])

/** 假图床：路径里带 `gone` 的 404，其它一律 200 + 假 JPEG；记录被请求的 host/path */
const imageHits = []
/** dead 永远 404（相当于 mikanani.me：域名活着但图没了）；alive 正常发图（相当于镜像） */
const mkImageHost = (name, { alwaysFail = false } = {}) =>
  createServer((req, res) => {
    imageHits.push({ host: name, path: req.url })
    if (alwaysFail || /gone|missing/i.test(req.url)) {
      res.statusCode = 404
      return res.end('not found')
    }
    res.setHeader('Content-Type', 'image/jpeg')
    res.end(FAKE_JPG)
  })

const dead = mkImageHost('dead', { alwaysFail: true })
const alive = mkImageHost('alive')
await new Promise((r) => dead.listen(0, '127.0.0.1', r))
await new Promise((r) => alive.listen(0, '127.0.0.1', r))
const deadPort = dead.address().port
const alivePort = alive.address().port

/* ── 起服务 ─────────────────────────────────────────────────────────────── */
const logs = []
const child = spawn(process.execPath, ['--env-file-if-exists=.env', 'src/index.js'], {
  env: {
    ...process.env,
    PORT: String(PORT),
    DB_FILE,
    LOG_LEVEL: 'warn',
    /* 落盘目录也隔离，别污染真的 data/img */
    IMAGE_CACHE_DIR: IMG_DIR,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
child.stdout.on('data', (d) => logs.push(String(d)))
child.stderr.on('data', (d) => logs.push(String(d)))

const waitReady = async () => {
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) return
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error('服务没起来')
}
const api = async (method, path, body) => {
  const res = await fetch(base + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* 非 JSON */ }
  return { status: res.status, body: json, text }
}

try {
  await waitReady()

  /* ── 1. 纯函数：镜像改写只换 host，路径原样 ─────────────────────────── */
  const { staticCandidates, isMikanImage, rewriteToMirror, mikanMirrors, candidateSources } =
    await import('./../src/cache/poster-sources.js')
  const { config } = await import('./../src/config.js')

  const deadBase = `http://127.0.0.1:${deadPort}`
  const aliveBase = `http://127.0.0.1:${alivePort}`
  /* 本地两个假图床充当「老域名 + 镜像」，只在本进程内改配置（服务进程走设置接口） */
  config.image.mirrors = [deadBase, aliveBase]

  const src = `${deadBase}/images/bangumi/202112/18ca807f.jpg`
  const cands = staticCandidates({ poster_src: src })
  check(cands[0] === src, '候选链第一条就是库里存的那条', cands[0]?.slice(0, 48))
  check(cands.length >= 2, `还有镜像候选 → 共 ${cands.length} 条`)
  check(
    cands.slice(1).every((u) => new URL(u).pathname === '/images/bangumi/202112/18ca807f.jpg'),
    '镜像只换 host、路径原样（日期目录 + 文件名哈希不能动）',
  )
  check(new Set(cands).size === cands.length, '候选去重（不重复试同一个地址）')

  check(isMikanImage('https://mikanani.me/images/bangumi/202112/18ca807f.jpg'), '认得出 Mikan 图床地址')
  check(!isMikanImage('https://lain.bgm.tv/pic/cover/l/c9/f0/8_wK0z3.jpg'), 'Bangumi 图床不当作可换镜像的地址（它没有 mikan 镜像）')
  check(!isMikanImage('https://mikanime.tv/Home/Bangumi/123'), '页面地址不是图片地址')
  check(rewriteToMirror(src, 'https://mikanime.tv').endsWith('/images/bangumi/202112/18ca807f.jpg'), 'rewriteToMirror 只改 origin')
  check(mikanMirrors().length >= 2 && mikanMirrors().every((u) => /^https?:/.test(u)), `镜像表 ${mikanMirrors().length} 条（设置 + 排期源 + 内置兜底）`)

  const withBgm = await candidateSources(
    { poster_src: src, bgm_id: '8' },
    { resolveBgm: async () => 'https://lain.bgm.tv/pic/cover/l/c9/f0/8_wK0z3.jpg' },
  )
  check(withBgm.at(-1) === 'https://lain.bgm.tv/pic/cover/l/c9/f0/8_wK0z3.jpg', 'Bangumi 封面排在候选链最后（要打一次 API，只在前面全挂时才花）')
  check(withBgm[0] === src && withBgm.includes(`${aliveBase}/images/bangumi/202112/18ca807f.jpg`), '候选链 = 库里那条 → 镜像 → Bangumi')
  const noBgm = await candidateSources({ poster_src: src, bgm_id: null }, { resolveBgm: async () => 'https://lain.bgm.tv/x.jpg' })
  check(!noBgm.some((u) => u.includes('lain.bgm.tv')), '没有 bgm_id 就不去问 Bangumi（不瞎花请求）')

  /* ── 2. 播种：一条首页排期 + 两个图源（一个死、一个活）────────────────── */
  const { DatabaseSync } = await import('node:sqlite')
  {
    const db = new DatabaseSync(DB_FILE)
    db.prepare(
      `INSERT INTO anime (id, mikan_id, bgm_id, title_mikan, poster_src, year, season, weekday, updated_at)
       VALUES (7001, '6001', NULL, '坏图测试番', ?, 2026, '秋', 2, ?)`,
    ).run(src, Date.now())
    db.prepare(
      `INSERT INTO anime (id, mikan_id, bgm_id, title_mikan, poster_src, year, season, weekday, updated_at)
       VALUES (7002, '6002', NULL, '全挂测试番', ?, 2026, '秋', 2, ?)`,
    ).run(`${deadBase}/images/gone.jpg`, Date.now())
    db.prepare(
      `INSERT INTO bgm_subject (bgm_id, title_bgm, score, rating_total, tags, type, source)
       VALUES ('30001', '坏图测试番', 8.1, 100, '["测试"]', 2, 'dump')`,
    ).run()
    db.prepare(
      `INSERT INTO bgm_subject (bgm_id, title_bgm, score, rating_total, tags, type, source)
       VALUES ('30002', '全挂测试番', 7.9, 100, '["测试"]', 2, 'dump')`,
    ).run()
    db.close()
  }

  /* 镜像指向本地两个假图床（服务进程走设置接口；这条要在出图之前设好） */
  await api('PUT', '/api/settings', { values: { 'image.mirrors': `${deadBase}\n${aliveBase}` } })

  /* ── 3. 出图接口：主图 404 → 换镜像 → 落盘 → 回写库 ──────────────────── */
  imageHits.length = 0
  const img = await fetch(`${base}/api/img/anime/7001`)
  const bytes = Buffer.from(await img.arrayBuffer())
  check(img.status === 200, `出图接口 200（主图 404 后换源成功）→ HTTP ${img.status}`)
  check(img.headers.get('content-type')?.includes('image/jpeg'), `返回的是图片 → ${img.headers.get('content-type')}`)
  check(bytes[0] === 0xff && bytes[1] === 0xd8, '发出去的是 JPEG 字节（不是错误页）')
  check(imageHits.filter((h) => h.host === 'dead').length >= 1, '先试了坏的那个源')
  check(imageHits.some((h) => h.host === 'alive'), '换到镜像源并成功取到图')
  const newFiles = [...imgSnapshot()].filter((n) => !imgBefore.has(n))
  check(newFiles.length >= 1, `图已落盘（下次直接命中本地）→ ${newFiles.join(',') || '无'}`)

  const after = (await api('GET', '/api/home/schedule?year=2026&season=秋')).body?.data
  const healed = after?.days?.flatMap((d) => d.items)?.find((i) => i.id === 7001)
  check(
    String(healed?.poster).startsWith(aliveBase) || String(healed?.poster).startsWith('/api/img/'),
    '胜出的图源写回库：下次首页拿到的就是能用的那条',
    String(healed?.poster).slice(0, 56),
  )

  /* ── 4. 接口层：首页卡片带 posterFallbacks ──────────────────────────── */
  const home = (await api('GET', '/api/home/schedule?year=2026&season=秋')).body?.data
  const card = home?.days?.flatMap((d) => d.items)?.find((i) => i.id === 7001)
  check(Boolean(card), '首页返回到这条排期')
  check(Array.isArray(card?.posterFallbacks) && card.posterFallbacks.length >= 2, `卡片带降级链 ${card?.posterFallbacks?.length} 条`)
  check(card?.posterFallbacks?.at(-1) === '/api/img/anime/7001', '降级链最后一条是后端代理（后端还会再试镜像 + Bangumi）')
  check(
    card?.posterFallbacks?.slice(0, -1).every((u) => new URL(u).pathname === '/images/bangumi/202112/18ca807f.jpg'),
    '降级链前面几条是同一张图的镜像地址',
  )

  /* ── 5. 全部源都挂 → 302 交浏览器，不 500 ──────────────────────────── */
  const dead2 = await fetch(`${base}/api/img/anime/7002`, { redirect: 'manual' })
  check(dead2.status === 302, `所有源都取不到 → 302 交给浏览器（不 500）→ HTTP ${dead2.status}`)
  check(String(dead2.headers.get('location') || '').includes('/images/gone.jpg'), '重定向到原始图源地址')

  /* ── 6. 刚失败的地址不该每次都被重试 ──────────────────────────────── */
  imageHits.length = 0
  await fetch(`${base}/api/img/anime/7002`, { redirect: 'manual' })
  check(
    imageHits.filter((h) => h.host === 'dead').length <= 1,
    `10 分钟内的坏地址进黑名单，不反复重试 → 这次打了 ${imageHits.filter((h) => h.host === 'dead').length} 次`,
  )

  /* ── 7. 没有 bgm_id、也没有图源 → 明确 404（不是空图）──────────────── */
  const noSrc = await fetch(`${base}/api/img/anime/999999`)
  check(noSrc.status === 404, `不存在的作品 → 404 → HTTP ${noSrc.status}`)
} catch (err) {
  failed++
  console.log(`✗ 验收中断：${err?.message || err}`)
  console.log(logs.join('').slice(-3000))
} finally {
  child.kill()
  await new Promise((r) => child.once('exit', r))
  await new Promise((r) => dead.close(r))
  await new Promise((r) => alive.close(r))
  clean()
}

console.log(failed ? `\n✗ 失败 ${failed} 项` : '\n✓ 全部通过')
process.exit(failed ? 1 : 0)
