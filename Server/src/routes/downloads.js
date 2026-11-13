/**
 * 下载路由 —— 下载页（卡片墙 + 面板资源区）+ 资源列表的「下载」按钮
 * ---------------------------------------------------------------------------
 *   GET  /api/downloads               卡片墙：一部番一张卡（已下几集 / 体积 / 状态）+ 未识别项
 *   GET  /api/downloads/:animeId      面板：已下载的按字幕组分组
 *   POST /api/downloads               加种 `{ animeId, subgroup?, season?, items:[{title,magnet|torrentUrl}] }`
 *   GET  /api/downloads/torrent/:hash      单个种子：当前任务名 + 种子内文件 + 建议改名
 *   POST /api/downloads/torrent/:hash/rename  单个种子改名（任务名 / 文件名可分开传）
 *   GET  /api/baidu/status            百度网盘连通性（当前账号）
 *   POST /api/baidu/offline           把磁力/电驴/直链丢给百度做离线下载
 *   GET  /api/baidu/offline           百度离线任务列表
 *   POST /api/baidu/transfer          转存分享链接（可带提取码）
 *   GET  /api/xunlei/status           迅雷连通性 + 容量（飞牛 NAS 上的迅雷应用）
 *   GET  /api/xunlei/tasks            迅雷任务列表（只读；迅雷没有改名接口）
 *   GET  /api/qb/status               qB 状态（两个版本 + 速度）；设置页与下载页顶部用
 * 业务在 api/pages/downloads.js，这里只做参数整形与信封。
 */
import { Router } from 'express'
import {
  addDownloads,
  getAnimeDownloads,
  getDownloads,
  getTorrentNaming,
  renameAllDownloads,
  renameDownloads,
  renameTorrentItem,
} from './../api/pages/downloads.js'
import { qbConfigured, qbTransfer, qbVersions } from './../api/sources/qb.js'
import { xunleiAbout, xunleiConfigured, xunleiDevice, xunleiTasks } from './../api/sources/xunlei.js'
import { baiduConfigured, baiduOfflineAdd, baiduOfflineList, baiduTransfer, baiduWho } from './../api/sources/baidu.js'
import { fail } from './../lib/errors.js'

export const downloadsRouter = Router()

/** 解析作品主键（与 /api/anime/:id 同一套校验） */
function animeIdOf(raw) {
  const id = Number(raw)
  if (!Number.isInteger(id) || id <= 0) throw fail('BAD_REQUEST', 'animeId 需要是正整数')
  return id
}

/** 改名范围：只改任务名 / 只改文件名 / 两个都改（默认） */
function scopeOf(raw) {
  const text = String(raw || '').trim()
  if (text === 'torrentName' || text === 'fileName') return text
  return 'all'
}

/** GET /api/downloads?fresh=1 —— fresh 跳过 4 秒缓存（用户点「刷新」） */
downloadsRouter.get('/downloads', async (req, res, next) => {
  try {
    const fresh = req.query.fresh === '1' || req.query.fresh === 'true'
    res.json({ ok: true, data: await getDownloads({ fresh }) })
  } catch (err) {
    next(err)
  }
})

/** GET /api/downloads/:animeId —— 面板资源区（字幕组 → 已下的集） */
downloadsRouter.get('/downloads/:animeId', async (req, res, next) => {
  try {
    res.json({ ok: true, data: await getAnimeDownloads(animeIdOf(req.params.animeId), { log: req.log }) })
  } catch (err) {
    next(err)
  }
})

/** POST /api/downloads —— 勾选若干条资源加种 */
downloadsRouter.post('/downloads', async (req, res, next) => {
  try {
    const { animeId, subgroup, season, items } = req.body || {}
    if (!Array.isArray(items) || !items.length) throw fail('BAD_REQUEST', 'items 需要是非空数组')
    const data = await addDownloads(
      { animeId: animeIdOf(animeId), subgroup: String(subgroup || ''), season: Number(season) || 1, items },
      { log: req.log },
    )
    res.json({ ok: true, data })
  } catch (err) {
    next(err)
  }
})

/**
 * POST /api/downloads/rename —— 重命名（任务名 + 文件名）
 * body：{ animeId, dryRun? }，**dryRun 默认 true**（只返回计划）；要真改必须显式传 false。
 */
downloadsRouter.post('/downloads/rename', async (req, res, next) => {
  try {
    const { animeId, dryRun, scope } = req.body || {}
    const data = await renameDownloads(
      { animeId: animeIdOf(animeId), dryRun: dryRun !== false, scope: scopeOf(scope) },
      { log: req.log },
    )
    res.json({ ok: true, data })
  } catch (err) {
    next(err)
  }
})

/**
 * POST /api/downloads/rename-all —— 全库重命名（队列手动触发 / CLI）
 * body：{ limit?, dryRun? }，**dryRun 默认 true**。
 */
downloadsRouter.post('/downloads/rename-all', async (req, res, next) => {
  try {
    const { limit, dryRun, scope } = req.body || {}
    const data = await renameAllDownloads(
      { limit: Math.max(1, Math.min(100, Number(limit) || 10)), dryRun: dryRun !== false, scope: scopeOf(scope) },
      { log: req.log },
    )
    res.json({ ok: true, data })
  } catch (err) {
    next(err)
  }
})

/**
 * GET /api/downloads/torrent/:hash —— 单个种子的两种名字（界面弹窗用）
 * 返回里 `suggest` 就是按规则算出来的目标：任务名一份、每个文件一份。
 */
downloadsRouter.get('/downloads/torrent/:hash', async (req, res, next) => {
  try {
    res.json({ ok: true, data: await getTorrentNaming({ hash: req.params.hash }) })
  } catch (err) {
    next(err)
  }
})

/**
 * POST /api/downloads/torrent/:hash/rename —— 单个种子改名
 * body：
 *   `{ torrentName?: string, files?: [{ oldPath, newPath }], dryRun?: boolean }`
 * 两个名字**互不影响**：只传 torrentName 就只改任务名，只传 files 就只改文件。
 */
downloadsRouter.post('/downloads/torrent/:hash/rename', async (req, res, next) => {
  try {
    const { torrentName, files, dryRun } = req.body || {}
    const data = await renameTorrentItem(
      { hash: req.params.hash, torrentName, files, dryRun: dryRun === true },
      { log: req.log },
    )
    res.json({ ok: true, data })
  } catch (err) {
    next(err)
  }
})

/**
 * GET /api/baidu/status —— 百度连得上吗、当前是哪个账号
 */
downloadsRouter.get('/baidu/status', async (req, res, next) => {
  try {
    if (!baiduConfigured()) return res.json({ ok: true, data: { configured: false } })
    const who = await baiduWho().catch((err) => ({ error: err.message }))
    res.json({ ok: true, data: { configured: true, who: who?.raw || '', error: who?.error || '' } })
  } catch (err) {
    next(err)
  }
})

/**
 * POST /api/baidu/offline —— 加离线下载
 * body：`{ urls: string[], path?: string }`（磁力 / 电驴 / http 直链都行）
 */
downloadsRouter.post('/baidu/offline', async (req, res, next) => {
  try {
    const { urls, path } = req.body || {}
    if (!Array.isArray(urls) && typeof urls !== 'string') throw fail('BAD_REQUEST', 'urls 需要是数组或字符串')
    const data = await baiduOfflineAdd({ urls, path })
    res.json({ ok: true, data })
  } catch (err) {
    next(err)
  }
})

/** GET /api/baidu/offline —— 离线任务列表（原样文本 + 逐行） */
downloadsRouter.get('/baidu/offline', async (req, res, next) => {
  try {
    if (!baiduConfigured()) return res.json({ ok: true, data: { configured: false } })
    res.json({ ok: true, data: { configured: true, ...(await baiduOfflineList()) } })
  } catch (err) {
    next(err)
  }
})

/**
 * POST /api/baidu/transfer —— 转存分享链接
 * body：`{ shareUrl: string, pwd?: string, path?: string }`
 */
downloadsRouter.post('/baidu/transfer', async (req, res, next) => {
  try {
    const { shareUrl, pwd, path } = req.body || {}
    res.json({ ok: true, data: await baiduTransfer({ shareUrl, pwd, path }) })
  } catch (err) {
    next(err)
  }
})

/**
 * GET /api/xunlei/status —— 迅雷连得上吗、盘还剩多少
 * 没配时同样不报错：`{ configured:false }`，界面照旧只显示 qB
 */
downloadsRouter.get('/xunlei/status', async (req, res, next) => {
  try {
    if (!xunleiConfigured()) return res.json({ ok: true, data: { configured: false } })
    const [about, device] = await Promise.all([
      xunleiAbout().catch((err) => ({ error: err.message })),
      xunleiDevice().catch((err) => ({ error: err.message })),
    ])
    const quota = about?.quota || null
    res.json({
      ok: true,
      data: {
        configured: true,
        quota: quota ? { limit: quota.limit, usage: quota.usage } : null,
        user: device?.user || null,
        downloads: device?.downloads || [],
        error: about?.error || device?.error || '',
      },
    })
  } catch (err) {
    next(err)
  }
})

/** GET /api/xunlei/tasks —— 迅雷任务列表（只读） */
downloadsRouter.get('/xunlei/tasks', async (req, res, next) => {
  try {
    if (!xunleiConfigured()) return res.json({ ok: true, data: { configured: false, items: [] } })
    const items = await xunleiTasks({ limit: Math.min(200, Number(req.query.limit) || 100) })
    res.json({ ok: true, data: { configured: true, items, count: items.length } })
  } catch (err) {
    next(err)
  }
})

/**
 * GET /api/qb/status —— 设置页「已连接」那一行 & 下载页顶部
 * 没配时不报错：`{ configured:false }` 让界面显示引导文案（报错反而像服务坏了）
 */
downloadsRouter.get('/qb/status', async (req, res, next) => {
  try {
    if (!qbConfigured()) return res.json({ ok: true, data: { configured: false } })
    const [versions, transfer] = await Promise.all([qbVersions(), qbTransfer().catch(() => null)])
    res.json({ ok: true, data: { configured: true, versions, transfer } })
  } catch (err) {
    next(err)
  }
})
