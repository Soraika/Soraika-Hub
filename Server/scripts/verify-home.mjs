/**
 * 首页链路验收 —— 起一个隔离实例，把接口契约逐项断言一遍
 * ---------------------------------------------------------------------------
 * 用法：`npm run verify`
 * 约定：任一项失败都打印 ✗ 并以非 0 退出（提交前 / CI 跑）
 * 隔离：用独立端口（默认 3300，可用 VERIFY_PORT 覆盖），不与开发中的 3100 抢端口，
 *       也不受它内存缓存的影响 —— 验收结果只取决于代码与库。
 */
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'

const PORT = Number(process.env.VERIFY_PORT || 3300)
const base = `http://127.0.0.1:${PORT}`

let failed = 0
const check = (ok, msg) => {
  if (!ok) failed++
  console.log(`${ok ? '✓' : '✗'} ${msg}`)
}

const logs = []
const child = spawn(process.execPath, ['--env-file-if-exists=.env', 'src/index.js'], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
})
child.stdout.on('data', (d) => logs.push(String(d)))
child.stderr.on('data', (d) => logs.push(String(d)))

const get = async (path) => {
  const res = await fetch(base + path)
  let body = null
  try {
    body = await res.json()
  } catch {
    /* 图片等非 JSON 响应 */
  }
  return { res, body }
}

const waitReady = async () => {
  for (let i = 0; i < 80; i++) {
    try {
      const { res } = await get('/api/health')
      if (res.ok) return
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error('服务没起来')
}

try {
  await waitReady()

  /* ── 健康检查 / 看板 ─────────────────────────────────────────────────── */
  const health = (await get('/api/health')).body?.data
  check(health?.status === 'up', "health: status = 'up'")
  check(
    typeof health?.coverage?.total === 'number' && typeof health?.coverage?.missingDue === 'number',
    `health: coverage 完整 → ${JSON.stringify(health?.coverage)}`,
  )
  check(typeof health?.worker?.running === 'boolean', `health: worker 是只读快照 → running=${health?.worker?.running}`)
  /* 运行时认识的分组要能自证 —— 加这个是为了排「改了代码但跑的是旧进程」：
     界面上看不到新分组时，先看这里有没有它。 */
  check(
    Array.isArray(health?.settingsGroups) && health.settingsGroups.includes('dump'),
    `health: 运行时认识「离线数据」分组 → ${JSON.stringify(health?.settingsGroups)}`,
  )
  check(
    typeof health?.startedAt === 'string' && !Number.isNaN(Date.parse(health.startedAt)),
    `health: 进程启动时间 → ${health?.startedAt}`,
  )

  /* ── 首页接口契约 ───────────────────────────────────────────────────── */
  const first = (await get('/api/home/schedule')).body?.data
  check(/^\d{4}$/.test(String(first?.season?.year)), `season.year 是 4 位年份 → ${first?.season?.year}`)
  check(typeof first?.season?.label === 'string' && first.season.label.length > 0, `season.label 是成品字符串 → ${first?.season?.label}`)
  check(
    Array.isArray(first?.years) && first.years.every((y) => typeof y.year === 'number' && Array.isArray(y.disabled)),
    `years 形状 = [{ year, disabled[] }]（${first?.years?.length} 条）`,
  )
  check(Array.isArray(first?.days) && first.days.length >= 7, `days ≥ 7 个区块 → ${first?.days?.length}`)
  const weekdays = first.days.filter((d) => d.day <= 6)
  check(weekdays.length === 7, `0–6 七个星期区块齐全 → ${weekdays.length}`)
  check(
    first.days.every((d) => typeof d.dayLabel === 'string' && typeof d.badge === 'string' && Array.isArray(d.items)),
    '每个区块都有 dayLabel / badge / items',
  )

  const cards = first.days.flatMap((d) => d.items)
  check(cards.length > 0, `卡片数 > 0 → ${cards.length}`)
  const fields = ['id', 'title', 'poster', 'score', 'scoreText', 'ratingText', 'metaText', 'bgmId', 'mikanId']
  check(
    cards.every((c) => fields.every((f) => f in c)),
    `卡片字段齐全：${fields.join(' / ')}`,
  )
  check(
    cards.every((c) => c.poster === '' || c.poster.startsWith('/api/img/anime/') || /^https?:\/\//.test(c.poster)),
    '海报地址来自后端（统一出图入口 / 图源直链），连 bgm_id 都没有才给空',
  )
  check(
    cards.every((c) => (c.score === null ? c.ratingText === '' : c.ratingText.length > 0)),
    '评分与人数文案一致（有分必有文案，无分不渲染）',
  )
  check(
    cards.every((c) => (c.score === null ? c.scoreText === '' : /^\d+\.\d$/.test(c.scoreText))),
    '评分成品字符串固定一位小数（整数分也是 8.0，不在模板里补零）',
  )
  const scored = cards.filter((c) => c.score != null)
  console.log(`  └ 本季 ${cards.length} 张卡片，其中 ${scored.length} 张有评分`)

  /* ── 缓存：第二次应直接读库 ─────────────────────────────────────────── */
  const second = (await get('/api/home/schedule')).body?.data
  check(second?.meta?.source === 'db' && second?.meta?.cached === true, `第二次请求走库 → meta=${JSON.stringify(second?.meta)}`)

  /* ── 出错路径：统一信封 + 正确错误码 ───────────────────────────────── */
  const bad = await get('/api/home/schedule?season=xx')
  check(bad.res.status === 400 && bad.body?.error?.code === 'BAD_REQUEST', `非法 season → 400 / BAD_REQUEST`)
  const badYear = await get('/api/home/schedule?year=26')
  check(badYear.res.status === 400 && badYear.body?.error?.code === 'BAD_REQUEST', '非法 year → 400 / BAD_REQUEST')
  const missingImg = await get('/api/img/anime/99999999')
  check(missingImg.res.status === 404 && missingImg.body?.error?.code === 'NOT_FOUND', '不存在的作品 → 404 / NOT_FOUND')
  const noRoute = await get('/api/not-exist')
  check(noRoute.res.status === 404 && noRoute.body?.error?.code === 'NOT_FOUND', '未知路由 → 404 / NOT_FOUND')

  /* ── 出图：缓存头 + content-type ──────────────────────────────────────
   * 海报地址有两种（都合法）：**统一出图入口**（本地已缓存 / 需要中转）与
   * **图源直链**（本地还没缓存，直接给上游地址让浏览器先显示，后端同时预热）。
   * 两种都要真的能出图 —— 分别验。 */
  const viaProxy = cards.find((c) => c.poster?.startsWith('/api/img/anime/'))
  if (viaProxy) {
    const res = await fetch(`${base}${viaProxy.poster}`)
    check(
      res.ok && /^image\//.test(res.headers.get('content-type') || ''),
      `出图（统一入口）${viaProxy.poster} → ${res.status} ${res.headers.get('content-type')}`,
    )
    check(/max-age=\d+/.test(res.headers.get('cache-control') || ''), `出图带 Cache-Control → ${res.headers.get('cache-control')}`)
  }
  const direct = cards.find((c) => /^https?:\/\//.test(c.poster || ''))
  if (direct) {
    const res = await fetch(direct.poster, { redirect: 'follow' })
    check(
      res.ok && /^image\//.test(res.headers.get('content-type') || ''),
      `出图（图源直链）${String(direct.poster).slice(0, 56)}… → ${res.status} ${res.headers.get('content-type')}`,
    )
  }

  /* ── 图片缓存：命名要跨库稳定、回源要校验内容 ──────────────────────────
     踩过的两个坑：① 文件名用自增 id → 重建库后 id 全变，几百张图变孤儿，
     每次都回源（缓存等于不存在）；② 回源不校验内容 → 图床防盗链返回的 200+HTML
     被当海报存下来。这里直接测嗅探函数 + 源码级钉住命名规则。 */
  const { sniffImage } = await import('./../src/cache/poster.js')
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(20)])
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(20)])
  const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(8)])
  check(
    sniffImage(jpeg) === '.jpg' && sniffImage(png) === '.png' && sniffImage(webp) === '.webp',
    `按 magic bytes 识别图片（不靠 URL 后缀）→ jpg/png/webp 都对`,
  )
  check(
    sniffImage(Buffer.from('<html><body>403 Forbidden</body></html>')) === null &&
      sniffImage(Buffer.alloc(4)) === null,
    'HTML 错误页 / 空文件一律不算图片（否则会被当海报缓存下来）',
  )
  const imgSource = readFileSync(new URL('../src/routes/img.js', import.meta.url), 'utf8')
  const posterSource = readFileSync(new URL('../src/cache/poster.js', import.meta.url), 'utf8')
  const homeSource = readFileSync(new URL('../src/api/pages/home.js', import.meta.url), 'utf8')
  check(
    /const hashOf = \(src\)/.test(posterSource) && /const rel = `\$\{hashOf\(src\)\}\$\{ext\}`/.test(posterSource),
    '缓存文件名用**海报地址哈希**（不是自增 id）—— 重建库后缓存依然命中',
  )
  check(
    imgSource.includes('findCached(id, row.poster_src)') && imgSource.includes('renameSync'),
    '命中先查磁盘（哈希名 → 旧 id 名），并把旧命名的文件迁移成哈希名',
  )
  check(
    /downloadAndSaveAny\(id, row/.test(imgSource) && /res\.redirect\(302, primary\)/.test(imgSource),
    '回源走**候选链**（库里那条 → 镜像 → Bangumi）；全挂才 302 交给浏览器（页面绝不空着）',
  )
  check(
    /posterFallbacksOf/.test(readFileSync(new URL('../src/lib/format.js', import.meta.url), 'utf8')),
    '卡片带降级链 posterFallbacks（主图 404 时前端换下一张，不会只剩占位底纹）',
  )
  check(
    /warmPosters\(rows\)/.test(homeSource) && /export function warmPosters/.test(posterSource),
    '首页会**后台预热**海报（库里没图源就先问 Bangumi，拿到就存本地）',
  )
  check(
    /export const posterUrlOf/.test(readFileSync(new URL('../src/lib/format.js', import.meta.url), 'utf8')),
    '海报地址规则只有一处（lib/format.js#posterUrlOf：本地 → 图源直链 → 出图入口）',
  )

  /* ── 优雅停机 ──────────────────────────────────────────────────────────
   * Windows 上没法给别的进程「投递信号」（child.kill('SIGINT') 只会硬杀），
   * 所以换成一个自发 SIGINT 的子进程来验真实停机路径（见 verify-shutdown.mjs）。
   */
  child.kill()
  const shutdownLogs = []
  const shutdown = spawn(process.execPath, ['--env-file-if-exists=.env', 'scripts/verify-shutdown.mjs'], {
    env: { ...process.env, PORT: String(PORT + 1) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  shutdown.stdout.on('data', (d) => shutdownLogs.push(String(d)))
  shutdown.stderr.on('data', (d) => shutdownLogs.push(String(d)))
  const exitCode = await new Promise((resolve) => shutdown.on('exit', resolve))
  const shutdownText = shutdownLogs.join('')
  check(exitCode === 0, `优雅停机退出码干净 → ${exitCode}`)
  check(shutdownText.includes('api.shutdown start'), '停机时打 api.shutdown start')
  check(shutdownText.includes('api.shutdown ok'), '停机完成打 api.shutdown ok（worker 已停、DB 已关）')

  console.log(failed ? `\n✗ 失败 ${failed} 项` : '\n✓ 全部通过')
  process.exitCode = failed ? 1 : 0
} catch (err) {
  console.error('\n✗ 验收中断：', err.message)
  console.error(logs.join('').slice(-1500))
  process.exitCode = 1
  child.kill()
}
