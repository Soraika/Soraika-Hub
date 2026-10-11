/**
 * 出图接口 —— 全站统一的海报入口
 * ---------------------------------------------------------------------------
 * 前端只认 `/api/img/anime/{id}`：
 *   · 本地有缓存 → 直接发文件（不再打上游）
 *   · 没有 → 回源抓一次 → **校验确实是图片** → 落盘 → 路径写回数据库 → 发出去
 * 好处：换源/防盗链/加尺寸参数都只改这里；浏览器侧还能吃长缓存。
 *
 * 两个**必须**按这里实现、不能省的判断（都踩过）：
 *   1. 命中先看**磁盘**，不是看 `poster_path` 字段。
 *      那个字段只有"回源成功"那一瞬间才写；目录里可能已经有 `{id}.jpg`（换过库、
 *      上次写库失败、手动迁移），只认字段就会**每次都回源** —— 缓存形同虚设，
 *      还容易被图床限流。命中磁盘就顺手把字段补上（自愈）。
 *   2. 回源后按 **magic bytes** 校验、并用它推扩展名。
 *      图床防盗链/图片失效时返回的是 **200 + HTML 或占位图**，`res.ok` 挡不住；
 *      不校验就等于把错误页当海报缓存下来（前端一片裂图，而且以后永远命中这个坏文件）。
 *      URL 后缀也不可信（`/images/x.jpg?width=400`、Bangumi 的 hash 名都要靠内容判断）。
 */
import { Router } from 'express'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { config } from '../config.js'
import { findById, setPosterPath } from '../db/anime.js'
import { fail } from '../lib/errors.js'
import { logger } from '../lib/logger.js'
import { request } from '../lib/http-client.js'

export const imgRouter = Router()

const cacheDir = resolve(process.cwd(), config.image.dir)
mkdirSync(cacheDir, { recursive: true })

const TYPE_BY_EXT = {
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
const MIN_BYTES = 512
/** 单张上限：超过就当上游返回了别的东西，别往磁盘里灌 */
const MAX_BYTES = 12 * 1024 * 1024

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
function pickExt(src) {
  try {
    const ext = new URL(src).pathname.slice(src.lastIndexOf('.')).toLowerCase()
    return CACHE_EXTS.includes(ext) ? (ext === '.jpeg' ? '.jpg' : ext) : '.jpg'
  } catch {
    return '.jpg'
  }
}

/** URL 的 origin（图床普遍校验 Referer，不带就给你防盗链占位图） */
function refererOf(src) {
  try {
    return `${new URL(src).origin}/`
  } catch {
    return ''
  }
}

/**
 * 缓存文件名 —— 用**海报地址的哈希**
 * ---------------------------------------------------------------------------
 * 为什么不用 `{id}`（自增主键）：它**不跨库稳定**。重建库 / 重新抓取后 id 全变，
 * 磁盘上抓好的几百张图瞬间变成对不上的孤儿 —— 实测 469 条里 313 条正是如此：
 * 文件都在、体积也正常，但按 id 找不到，于是每次访问都回源，缓存等于不存在。
 * 海报地址才是稳定身份：同一个 src 永远对应同一张图。
 * 旧命名（`{id}.jpg`）仍然兼容查找，命中后由 `healPosterPaths` 迁到新名字。
 */
const hashOf = (src) => createHash('sha1').update(String(src)).digest('hex').slice(0, 16)

/**
 * 在磁盘上找这个作品的缓存文件
 * 顺序：新命名（哈希）→ 旧命名（{id}）；都不看数据库字段。
 * 顺手清掉明显是坏的文件（HTML 错误页 / 空文件）——留着只会让人以为"缓存过了"。
 */
function findCached(id, src) {
  const key = hashOf(src)
  const candidates = [...CACHE_EXTS.map((ext) => `${key}${ext}`), ...CACHE_EXTS.map((ext) => `${id}${ext}`)]
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

async function fetchPoster(id, src) {
  if (inflight.has(id)) return inflight.get(id)
  const task = request(src, {
    expect: 'buffer',
    timeoutMs: 20000,
    retries: 1,
    tip: '海报回源',
    headers: { Accept: 'image/*,*/*;q=0.8', ...(refererOf(src) ? { Referer: refererOf(src) } : {}) },
  })
    .then((buf) => {
      const ext = sniffImage(buf)
      if (!ext) {
        throw fail('UPSTREAM', `回源拿到的不是图片（${buf.length} 字节，可能是防盗链或图片已失效）`, {
          url: src,
        })
      }
      if (buf.length > MAX_BYTES) throw fail('UPSTREAM', `回源的图片过大（${buf.length} 字节）`, { url: src })
      return { buf, ext }
    })
    .finally(() => inflight.delete(id))
  inflight.set(id, task)
  return task
}

/** GET /api/img/anime/:id */
imgRouter.get('/img/anime/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id)
    if (!Number.isInteger(id) || id <= 0) throw fail('BAD_REQUEST', 'id 需要是正整数')

    const row = findById(id)
    if (!row) throw fail('NOT_FOUND', `没有 id=${id} 的作品记录`)
    if (!row.poster_src) throw fail('NOT_FOUND', '这条作品没有海报地址')

    res.setHeader('Cache-Control', `public, max-age=${config.image.maxAgeSec}`)

    // 1) 磁盘命中 → 直接发（顺便把数据库里缺失的路径补上）
    const hit = findCached(id, row.poster_src)
    if (hit) {
      if (row.poster_path !== hit.name) setPosterPath(id, hit.name)
      res.setHeader('Content-Type', TYPE_BY_EXT[hit.name.slice(hit.name.lastIndexOf('.'))] || 'image/jpeg')
      return res.sendFile(hit.file)
    }

    // 2) 回源 → 校验 → 落盘 → 回写路径
    const { buf, ext } = await fetchPoster(id, row.poster_src)
    const rel = `${hashOf(row.poster_src)}${ext}`
    writeFileSync(join(cacheDir, rel), buf)
    setPosterPath(id, rel)

    res.setHeader('Content-Type', TYPE_BY_EXT[ext] || 'image/jpeg')
    res.send(buf)
  } catch (err) {
    next(err)
  }
})

/**
 * 启动时自愈一次（两个都做）：
 *   1. **旧命名迁移**：`{id}.ext` 但库里 id 还在 → 改名成 `{hash}.ext`（跨库稳定），
 *      路径字段跟着更新 —— 不迁的话换一次库它们就永久失效；
 *   2. **补字段**：磁盘上已有、但 `poster_path` 为空/过期的，补上。
 * 实测：469 条里 313 条的字段是空的（文件其实在磁盘上，只是没登记）。
 */
function healPosterPaths() {
  let migrated = 0
  let patched = 0
  const names = readdirSync(cacheDir)

  for (const name of names) {
    const m = /^(\d+)\.(jpe?g|png|webp|gif|avif)$/i.exec(name)
    if (!m) continue
    const id = Number(m[1])
    const from = join(cacheDir, name)
    const size = statSync(from).size
    if (size < MIN_BYTES || size > MAX_BYTES) continue

    const row = findById(id)
    if (!row?.poster_src) continue

    const ext = `.${m[2].toLowerCase() === 'jpeg' ? 'jpg' : m[2].toLowerCase()}`
    const target = `${hashOf(row.poster_src)}${ext}`
    try {
      renameSync(from, join(cacheDir, target))
      migrated++
    } catch {
      continue // 改不动就留着，路由里仍能按旧名命中
    }
    if (row.poster_path !== target) {
      setPosterPath(id, target)
      patched++
    }
  }

  logger.info({ scanned: names.length, migrated, patched, dir: cacheDir }, 'img.cache 自愈完成')
}

healPosterPaths()

