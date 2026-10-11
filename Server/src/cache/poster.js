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
import { fetchSubject } from '../api/sources/bgm.js'
import { config } from '../config.js'
import { setPosterSource } from '../db/anime.js'
import { fail } from '../lib/errors.js'
import { request } from '../lib/http-client.js'
import { logger } from '../lib/logger.js'

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

/** 回源一张海报并校验是不是真图片（不落盘、不写库） */
export async function fetchPoster(id, src) {
  const key = String(id)
  if (inflight.has(key)) return inflight.get(key)
  const task = request(src, {
    expect: 'buffer',
    timeoutMs: 20000,
    retries: 2, // 图床抖一下很常见：多试两次，最后仍失败就走「302 交浏览器」
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
 * 回源 → 落盘 → 把文件名写回库
 * 连图一起返回（`buf` / `ext` / `rel`）：调用方要发图时**不用再回源一次** ——
 * 出图接口就是「下载并保存，然后直接把这份字节发出去」。
 * @returns {Promise<{buf:Buffer, ext:string, rel:string}>}
 */
export async function downloadAndSave(id, src) {
  const { buf, ext } = await fetchPoster(id, src)
  const rel = `${hashOf(src)}${ext}`
  writeFileSync(join(cacheDir, rel), buf)
  setPosterSource(id, { src, path: rel })
  return { buf, ext, rel }
}

/**
 * 库里没存图源时，问一次 Bangumi 要封面
 * ---------------------------------------------------------------------------
 * 扫描出来的行**只有 bgm_id、没有封面**（实测 2607/3237 条，占八成），不补就只能显示占位底纹。
 * 拿到就回写 `poster_src` —— 所以这条上游请求一辈子只花一次。
 * 失败返回 null（**不当错误**）：调用方照常给空地址，前端显示占位底纹。
 */
export async function ensurePosterSrc(row) {
  if (!row) return null
  if (row.poster_src) return row.poster_src
  if (!row.bgm_id) return null
  try {
    const subject = await fetchSubject(row.bgm_id)
    const img = subject?.images || {}
    const src = img.large || img.common || img.medium || img.small || null
    if (src) {
      setPosterSource(row.id, { src })
      logger.info({ id: row.id, bgmId: row.bgm_id }, 'img 图源来自 Bangumi（已回写）')
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
      const src = await ensurePosterSrc(row)
      if (src) await downloadAndSave(row.id, src)
      warmed.add(row.id)
    } catch (err) {
      logger.debug({ id: row.id, err: err.message }, 'img 预热失败（不影响请求）')
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
