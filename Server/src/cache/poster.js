/**
 * 海报本地缓存 —— 「定图源 → 回源 → 校验 → 落盘 → 回写库」这套动作只写一遍
 * ---------------------------------------------------------------------------
 * 两个调用方：
 *   ① `rout/img.js`：浏览器请求 `/api/img/anime/{id}` 时**同步**走一遍并直接发图
 *   ② `api/pages/*`（列表 / 详情）：「库里有图源、但本地还没缓存」时**后台预热** ——
 *      前端拿到的仍然是**图源直链**（浏览器立刻就能显示），后端同时把图存到本地，
 *      下次这条就变成本地命中（不再依赖图床、不吃防盗链）。
 *      这就是「直接返回图源 url，同时后端也下载存到本地」。
 *
 * 两个刻意的实现（都踩过）：
 *   · 缓存文件名用**海报地址的哈希**，不是 `{id}`：它跨库稳定。重建库 / 重新抓取后
 *     id 全变，按 id 命名的文件会集体变孤儿（实测 469 条里 313 条如此：文件都在、
 *     体积也正常，就是按 id 找不到，于是每次访问都回源）。
 *   · 回源后必须按 **magic bytes** 校验：图床防盗链 / 图失效时返回的是
 *     **200 + HTML 或占位图**，`res.ok` 挡不住；不校验就等于把错误页当海报缓存下来。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fetchSubject } from './../api/sources/bgm.js'
import { config } from './../config.js'
import { setPosterSource } from './../db/anime.js'
import { subjectsByFold } from './../db/subject.js'
import { foldTitle } from './../domain/titles.js'
import { candidateSources, staticCandidates } from './poster-sources.js'
import { fail } from './../lib/errors.js'
import { request } from './../lib/http-client.js'
import { logger } from './../lib/logger.js'

export const cacheDir = resolve(process.cwd(), config.image.dir)
mkdirSync(cacheDir, { recursive: true })

export const TYPE_BY_EXT = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
}
/** 磁盘上会去找的扩展名（按可能性排序） */
const CACHE_EXTS = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif']
/** 比这个还小的文件不可能是海报（是 HTML 错误页 / 空文件） */
export const MIN_BYTES = 512
/** 单张上限：超过就当上游返回了别的东西，别往磁盘里灌 */
export const MAX_BYTES = 12 * 1024 * 1024

/**
 * 图片内容嗅探：返回**真实**扩展名，不是图片返回 null
 * 支持 JPEG / PNG / GIF / WebP / AVIF —— 覆盖 Mikan 与 Bangumi 两个源。
 */
export function sniffImage(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return '.jpg'
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return '.png'
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return '.gif'
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') {
    return '.webp'
  }
  if (buf.subarray(4, 8).toString('latin1') === 'ftyp') return '.avif'
  return null
}

/** 从原始地址推扩展名（仅供嗅探失败时兜底使用） */
export function pickExt(src) {
  try {
    const ext = new URL(src).pathname.slice(src.lastIndexOf('.')).toLowerCase()
    return CACHE_EXTS.includes(ext) ? (ext === '.jpeg' ? '.jpg' : ext) : '.jpg'
  } catch {
    return '.jpg'
  }
}

export const hashOf = (src) => createHash('sha1').update(String(src)).digest('hex').slice(0, 16)

/** URL 的 origin（图床普遍校验 Referer，不带就给你防盗链占位图） */
function refererOf(src) {
  try {
    return `${new URL(src).origin}/`
  } catch {
    return ''
  }
}

/**
 * 在磁盘上找这部作品的缓存文件
 * 顺序：新命名（哈希）→ 旧命名（`{id}`）；**都不看数据库字段**。
 * 顺手清掉明显是坏的文件（HTML 错误页 / 空文件）——留着只会让人以为"缓存过了"。
 * @returns {{ file:string, name:string }|null}
 */
export function findCached(id, src) {
  const candidates = [
    ...(src ? CACHE_EXTS.map((ext) => `${hashOf(src)}${ext}`) : []),
    ...CACHE_EXTS.map((ext) => `${id}${ext}`),
  ]
  for (const name of candidates) {
    const file = join(cacheDir, name)
    if (!existsSync(file)) continue
    const { size } = statSync(file)
    if (size >= MIN_BYTES && size <= MAX_BYTES) return { file, name }
    try {
      unlinkSync(file)
      logger.warn({ file, size }, 'img.cache 丢掉坏文件')
    } catch {
      /* 删不掉也不影响：下面会重新回源覆盖它 */
    }
  }
  return null
}

/** 同一个 id 的回源只跑一次（并发进来时共用同一个 Promise） */
const inflight = new Map()

/**
 * 图源「刚刚 404 过」的黑名单（内存，10 分钟）
 * ---------------------------------------------------------------------------
 * 为什么需要：一条坏地址会在首页每次请求里都被重试一遍（测活要 1~3 秒），
 * 结果是「每张图都慢」而不是「一张图不显示」。记下来直接跳到下一个源。
 * 只记内存：图床修好了重启一次就恢复，不用管数据库。
 */
const BROKEN_TTL_MS = 10 * 60 * 1000
const broken = new Map()
const isBroken = (src) => {
  const at = broken.get(src)
  if (!at) return false
  if (Date.now() - at < BROKEN_TTL_MS) return true
  broken.delete(src)
  return false
}
const markBroken = (src) => broken.set(src, Date.now())

/**
 * 回源一张海报并校验是不是真图片（不落盘、不写库）
 * @param {number|string} id 只用于并发去重
 * @param {string} src
 * @param {{ timeoutMs?: number, retries?: number }} [options]
 *   多源候选链里每次只给 6 秒、不重试：一条坏地址不该拖住后面的好地址
 */
export async function fetchPoster(id, src, { timeoutMs = 20000, retries = 2 } = {}) {
  const key = String(id)
  if (inflight.has(key)) return inflight.get(key)
  const task = request(src, {
    expect: 'buffer',
    timeoutMs,
    retries, // 图床抖一下很常见：多试两次，最后仍失败就走「302 交浏览器」
    tip: '海报回源',
    headers: { Accept: 'image/*,*/*;q=0.8', ...(refererOf(src) ? { Referer: refererOf(src) } : {}) },
  })
    .then((buf) => {
      const ext = sniffImage(buf)
      if (!ext) {
        throw fail('UPSTREAM', `回源拿到的不是图片（${buf.length} 字节，可能是防盗链或图片已失效）`, { url: src })
      }
      if (buf.length > MAX_BYTES) throw fail('UPSTREAM', `回源的图片过大（${buf.length} 字节）`, { url: src })
      return { buf, ext }
    })
    .finally(() => inflight.delete(key))
  inflight.set(key, task)
  return task
}

/**
 * 依次试候选源，第一个拿到真图片的胜出（**落盘 + 回写库**）
 * ---------------------------------------------------------------------------
 * 与 `downloadAndSave` 的区别：那个只认一条地址，这个走整条候选链
 * （库里的地址 → 各镜像 → Bangumi 封面）。
 *
 * 命中之后**把胜出的地址写回 `poster_src`** —— 这一步是"自愈"：
 * 下次首页拿到的直链就是能用的那条，不用再走一遍探测。
 *
 * @param {number} id 作品主键
 * @param {{poster_src?: string|null, bgm_id?: string|number|null}} row
 * @param {{ log?: object, slowMs?: number }} [options]
 * @returns {Promise<{ buf: Buffer, ext: string, rel: string, src: string, tried: string[] } | null>}
 */
export async function downloadAndSaveAny(id, row, { log = logger, timeoutMs = 6000, mirrorTimeoutMs = 4000 } = {}) {
  const tried = []
  const statics = staticCandidates(row)

  /* Bangumi 封面**与镜像探测并行**去拿：
     串行的话最坏情况是「3 个镜像各超时 4s + Bangumi 一次 15s」= 30 秒以上（容器里实测 35s），
     并行之后等的是两者里慢的那个，不是和。 */
  const bgmPromise = row?.bgm_id ? bgmCoverUrl(row, { log }).catch(() => null) : Promise.resolve(null)

  const attempt = async (src, timeout) => {
    const { buf, ext } = await fetchPoster(`${id}:${src}`, src, { timeoutMs: timeout, retries: 0 })
    const rel = `${hashOf(src)}${ext}`
    writeFileSync(join(cacheDir, rel), buf)
    /* 图源变了（比如 Mikan 那条 404、改用 Bangumi 封面）→ 路径一起换，
       顺手把旧缓存文件留着不管（按地址哈希命名，不会误命中） */
    setPosterSource(id, { src, path: rel })
    if (src !== row?.poster_src) {
      log.info({ id, from: row?.poster_src || null, to: src, tried: tried.length }, 'img.src 换源成功')
    }
    return { buf, ext, rel, src, tried }
  }

  /* ① 静态候选（库里那条 + 各镜像）：镜像给更短的超时 —— 同一个图床换 host，
     4 秒还不回基本就是不通，没必要等 6 秒 */
  for (const src of statics) {
    if (isBroken(src)) {
      tried.push(`${src} (跳过:刚失败过)`)
      continue
    }
    try {
      return await attempt(src, statics[0] === src ? timeoutMs : mirrorTimeoutMs)
    } catch (err) {
      markBroken(src)
      tried.push(`${src} (${String(err?.message || err).slice(0, 60)})`)
    }
  }

  /* ② Bangumi 封面（前面全挂才用；这时它通常早就拿回来了，几乎不用等） */
  const bgmSrc = await bgmPromise
  if (bgmSrc && !isBroken(bgmSrc)) {
    try {
      return await attempt(bgmSrc, timeoutMs)
    } catch (err) {
      markBroken(bgmSrc)
      tried.push(`${bgmSrc} (${String(err?.message || err).slice(0, 60)})`)
    }
  } else if (bgmSrc) {
    tried.push(`${bgmSrc} (跳过:刚失败过)`)
  }

  return null
}

/**
 * 问一次 Bangumi 要封面地址（**不写库**，调用方决定写不写）
 * ---------------------------------------------------------------------------
 * 与 `ensurePosterSrc` 的区别：那个「库里有地址就不问」；这里**强制问**
 * —— 库里的地址可能已经 404（Mikan 换域名/清图），那时它是唯一的救命源。
 *
 * `lain.bgm.tv` 的封面路径带两层 hash（`/pic/cover/l/c9/f0/8_wK0z3.jpg`），
 * 从 id 拼不出来，所以必须打一次 API。结果按 bgm_id 缓存 1 小时：
 * 同一部作品在一次首页加载里可能被问多次（直链失败 → 代理 → 预热）。
 */
const bgmCoverCache = new Map()
const BGM_COVER_TTL_MS = 60 * 60 * 1000

export async function bgmCoverUrl(row, { log = logger, ttlMs = BGM_COVER_TTL_MS } = {}) {
  /* 没有 bgm_id 时先在**本地档案库**里按番名找一次（dump 里 3 万部动画的名字索引）：
     实测有一批作品只有 mikan_id（映射还没补上），但它们的番名在全站索引里能唯一命中 ——
     这一步纯 SQL、不发请求，命中了就不用干等映射补齐才有封面。 */
  let bgmId = row?.bgm_id ? String(row.bgm_id) : ''
  if (!bgmId) {
    const title = row?.title_bgm || row?.title_mikan || row?.title_bgm_origin || ''
    const fold = foldTitle(title)
    if (fold) {
      const hits = subjectsByFold(fold).filter((item) => item.bgm_id)
      if (hits.length === 1) {
        bgmId = String(hits[0].bgm_id)
        log.debug?.({ id: row?.id, title, bgmId }, 'img 按番名找到条目（映射还没补）')
      }
    }
  }
  if (!bgmId) return null
  const key = bgmId
  const hit = bgmCoverCache.get(key)
  if (hit && Date.now() - hit.at < ttlMs) return hit.url

  if (hit?.pending) return hit.pending
  const task = (async () => {
    try {
      const subject = await fetchSubject(bgmId)
      const img = subject?.images || {}
      const url = img.large || img.common || img.medium || img.small || null
      if (url) bgmCoverCache.set(key, { at: Date.now(), url })
      return url
    } catch (err) {
      log.warn({ bgmId, err: err?.message }, 'img 问 Bangumi 封面失败')
      return null
    }
  })()
  bgmCoverCache.set(key, { at: 0, url: null, pending: task })
  const url = await task
  if (url) bgmCoverCache.set(key, { at: Date.now(), url })
  else bgmCoverCache.delete(key)
  return url
}

export async function ensurePosterSrc(row) {
  if (!row) return null
  if (row.poster_src) return row.poster_src
  if (!row.bgm_id) return null
  try {
    const src = await bgmCoverUrl(row, { log: logger })
    if (src) {
      setPosterSource(row.id, { src })
      logger.info({ id: row.id, bgmId: row.bgm_id, source: 'bgm' }, 'img.src resolved')
    }
    return src
  } catch (err) {
    logger.warn({ id: row.id, bgmId: row.bgm_id, err: err.message }, 'img 取 Bangumi 封面失败')
    return null
  }
}

/* ── 后台预热 ──────────────────────────────────────────────────────────────
 * 列表 / 详情里遇到「有图源但本地没缓存」的行就顺手存一份。三条护栏：
 *   · 一次请求最多预热 12 张（别让首页滚动把上游打爆）
 *   · 同时在跑的下载不超过 3 张
 *   · 预热过 / 正在预热的 id 不重复
 * 全程 fire-and-forget：**不 await、不拖接口响应**（前端早在用图源直链显示了）。
 */
const WARM_PER_REQUEST = 12
const WARM_CONCURRENCY = 3
const warmed = new Set()
const warming = new Set()
let warmingCount = 0

/** 后台把这一个作品的图存到本地（库里没图源就先问 Bangumi） */
export function warmPoster(row) {
  if (!row?.id || warmed.has(row.id) || warming.has(row.id)) return
  if (row.poster_path) {
    warmed.add(row.id) // 已登记过本地缓存 → 不必预热（文件真丢了由出图接口自愈）
    return
  }
  if (!row.poster_src && !row.bgm_id) return
  if (warmingCount >= WARM_CONCURRENCY) return
  warming.add(row.id)
  warmingCount++
  void (async () => {
    try {
      /* 预热也走**候选链**（不是只认库里那条）：库里那条可能已经 404，
         这时预热会换到镜像 / Bangumi 封面，并把可用地址写回库 —— 首页下次就对了 */
      const hit = await downloadAndSaveAny(row.id, row, { log: logger })
      if (hit) warmed.add(row.id)
    } catch (err) {
      logger.debug({ id: row.id, err: err.message }, 'img.warm fail')
    } finally {
      warming.delete(row.id)
      warmingCount--
    }
  })()
}

/** 一批行做有限次预热（列表 / 详情入口调用）—— 返回本次真正排上队的张数 */
export function warmPosters(rows = []) {
  let n = 0
  for (const row of rows) {
    if (n >= WARM_PER_REQUEST) break
    if (row?.id && !row.poster_path && !warmed.has(row.id)) n++
    warmPoster(row)
  }
  return n
}

/** 给接口层用的静态候选（不发请求、不打上游）：首页/列表的第二、第三张牌 */
export const staticPosterCandidates = (row) => staticCandidates(row)
