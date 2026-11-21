/**
 * 出图接口 —— 全站统一的海报入口
 * ---------------------------------------------------------------------------
 * 前端只认 `/api/img/anime/{id}`。**图源是一条三级链，缺哪级补哪级**：
 *
 *   ① 本地缓存（磁盘）→ 直接发文件，不打上游
 *   ② 库里的 `poster_src` → 回源抓一次 → 校验确实是图片 → 落盘 → 路径写回库
 *   ③ `poster_src` 为空 → **现场问 Bangumi 要封面**（`bgm_id` → `images.large/common`）
 *      → 拿到就回写 `poster_src`（这条上游请求一辈子只花一次）→ 再走 ②
 *   ④ 回源失败（防盗链 / 图床挂 / 图已失效）→ **302 把原图交给浏览器**去取
 *      （浏览器带的是本站 Referer，常常反而能拿到；拿不到也只是裂图，
 *        前端 PosterImage 的 onerror 会兜到占位底纹 —— 绝不会"接口报错、页面空着"）
 *
 * 为什么必须有 ③：**扫描出来的行只有 `bgm_id`、没有封面**（实测 2607/3237 条，占八成）。
 * 早先写成「没有 poster_src 就给空地址 / 直接 404」，结果八成作品直接显示占位底纹 ——
 * 就是用户看到的"没有图"。图源的兜底属于后端，前端只认这一个入口。
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
import { readdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  MAX_BYTES,
  MIN_BYTES,
  TYPE_BY_EXT,
  cacheDir,
  downloadAndSaveAny,
  ensurePosterSrc,
  hashOf,
  findCached,
} from './../cache/poster.js'
import { config } from './../config.js'
import { findById, setPosterPath } from './../db/anime.js'
import { fail } from './../lib/errors.js'
import { logger } from './../lib/logger.js'

export const imgRouter = Router()


/** GET /api/img/anime/:id —— 图源三级链：本地缓存 → poster_src → 现场问 Bangumi */
imgRouter.get('/img/anime/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id)
    if (!Number.isInteger(id) || id <= 0) throw fail('BAD_REQUEST', 'id 需要是正整数')

    const row = findById(id)
    if (!row) throw fail('NOT_FOUND', `没有 id=${id} 的作品记录`)

    res.setHeader('Cache-Control', `public, max-age=${Math.max(0, Math.round(config.image.maxAgeMs / 1000))}`)

    // ① 磁盘命中 → 直接发（顺便把数据库里缺失的路径补上；不回源、不问 BGM）
    if (row.poster_src) {
      const hit = findCached(id, row.poster_src)
      if (hit) {
        if (row.poster_path !== hit.name) setPosterPath(id, hit.name)
        res.setHeader('Content-Type', TYPE_BY_EXT[hit.name.slice(hit.name.lastIndexOf('.'))] || 'image/jpeg')
        return res.sendFile(hit.file)
      }
    }

    // ② 定图源：**一条候选链**（库里那条 → 各 Mikan 镜像 → Bangumi 封面）
    //    不是"库里存了就用它"：那条地址可能已经 404（Mikan 换域名 / 老图被清）。
    const primary = row.poster_src || (await ensurePosterSrc(row)) || null
    if (!primary) throw fail('NOT_FOUND', `id=${id} 没有可用海报：库内与 Bangumi 均无封面`)

    // ③ 逐个候选试 → 第一个真图片胜出 → 落盘 + 把胜出的地址写回库（自愈）
    try {
      const hit = await downloadAndSaveAny(id, row, { log: req.log ?? logger })
      if (hit) {
        res.setHeader('Content-Type', TYPE_BY_EXT[hit.ext] || 'image/jpeg')
        return res.send(hit.buf)
      }
      throw fail('UPSTREAM', '所有候选图源都取不到（含镜像与 Bangumi 封面）')
    } catch (err) {
      // ④ 我们抓不动（防盗链 / 图床挂 / 图已失效）→ 把原图地址交给浏览器自己取
      //    （浏览器带的是本站 Referer，偶尔反而能取到；取不到也只是裂图，
      //      前端 PosterImage 的 onerror 会继续走 posterFallbacks → 最终兜到占位底纹）
      logger.warn({ id, src: primary, err: err.message, action: 'redirect' }, 'img.fetch fail')
      return res.redirect(302, primary)
    }
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

