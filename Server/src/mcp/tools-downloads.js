/**
 * MCP 写入工具 —— 加种 / 暂停 / 继续 / 删除 / 改名 / 迅雷 / 百度
 * ---------------------------------------------------------------------------
 * **这一组全部要 `mcp.allowWrite = true`**（服务层统一拦，工具自己不再判断）。
 * 为什么单独一个文件还不够、还要再拦一层：
 *   · 提示词说得再清楚，模型也可能理解反（「把没下完的整理一下」→ 删了 40 个任务）
 *   · 用户可能只想让 agent「看看」，开关是唯一可靠的边界
 *
 * 三条实现原则：
 *   ① **删除必须显式带 deleteFiles**：默认只从任务列表移除，**不动磁盘文件**。
 *      删文件是不可逆的，不能让"顺手"决定它。
 *   ② **改名默认 dry-run**：`planNaming` 会算出目标名，先返回计划让人/模型确认，
 *      真要改再传 `apply: true` —— 这是仓库里既有的铁律，MCP 不破例。
 *   ③ **批量操作要回报逐条结果**：10 个里有 1 个失败不能被总结成"完成"。
 */
import { config } from '../config.js'
import { addDownloads, getDownloads, renameAllDownloads, renameTorrentItem } from '../api/pages/downloads.js'
import { deleteTasks, listTasks, pauseTasks, resumeTasks } from '../api/sources/qb-control.js'
import { qbAddTorrent, qbConfigured } from '../api/sources/qb.js'
import { baiduConfigured, baiduOfflineAdd, baiduOfflineList } from '../api/sources/baidu.js'
import { xunleiAddTask, xunleiConfigured, xunleiDeleteTask, xunleiTasks } from '../api/sources/xunlei.js'
import { fail } from '../lib/errors.js'

const hashesOf = (raw) => {
  const list = (Array.isArray(raw) ? raw : String(raw || '').split(/[\s,，]+/))
    .map((h) => String(h || '').trim())
    .filter(Boolean)
  if (!list.length) throw fail('BAD_REQUEST', '需要 hash（种子 info hash，可从 list_downloads 里取）')
  return [...new Set(list)]
}

/**
 * 批量写操作的结论
 * ---------------------------------------------------------------------------
 * `qb-control` 的写接口是**全批一起发**（qB 的 hashes 参数本来就是 `a|b|c`），
 * 所以结论只有"成功 N 条"或"整批失败（原因）"两种 —— 不存在部分成功。
 * 这里把失败也转成数据返回，而不是抛给协议层：模型看到原因才知道下一步做什么。
 */
async function batchWrite(list, fn) {
  try {
    const result = await fn(list)
    /* 注意字段名：`ok` 是布尔（上游成功与否），`succeeded` 才是条数 ——
       两个都叫 ok 会被 spread 覆盖，验收里就是"成功但数字对不上" */
    return { requested: list.length, ok: true, succeeded: result?.count ?? list.length, failed: 0 }
  } catch (err) {
    return { requested: list.length, ok: false, succeeded: 0, failed: list.length, error: err?.message || String(err), code: err?.code || null }
  }
}

export const downloadTools = [
  {
    name: 'list_downloads',
    title: '下载任务总览',
    write: false,
    description:
      '列出下载情况：qBittorrent 任务（进度 / 速度 / 状态 / 保存路径）+ 迅雷与百度的连通状态。' +
      '拿 hash 去调 pause/resume/delete；filter 可只看 downloading / paused / completed / error。',
    inputSchema: {
      type: 'object',
      properties: {
        filter: { type: 'string', enum: ['all', 'downloading', 'paused', 'completed', 'error'], description: '筛选，默认 all' },
        limit: { type: 'integer', description: '返回条数，默认 30' },
      },
    },
    async handler({ filter = 'all', limit } = {}) {
      const cap = Math.max(1, Math.min(Number(limit) || Number(config.mcp?.maxResults) || 20, 100))
      const out = { qb: { configured: qbConfigured(), connected: false, items: [] }, xunlei: { configured: xunleiConfigured() }, baidu: { configured: baiduConfigured() } }

      if (qbConfigured()) {
        try {
          const tasks = await listTasks({ filter })
          out.qb.connected = true
          out.qb.total = tasks.length
          out.qb.items = tasks.slice(0, cap)
          out.qb.truncated = tasks.length > cap
        } catch (err) {
          out.qb.error = err?.message || String(err)
        }
      }

      /* 迅雷 / 百度只给"配没配 + 有几条"，不展开 —— 它们既不能改名也不该被 agent 批量动 */
      if (out.xunlei.configured) {
        try {
          const tasks = await xunleiTasks({ limit: 20 })
          out.xunlei.total = Array.isArray(tasks) ? tasks.length : 0
          out.xunlei.sample = (Array.isArray(tasks) ? tasks : []).slice(0, 5).map((t) => ({ name: t.name, progress: t.progress, phaseText: t.phaseText }))
        } catch (err) {
          out.xunlei.error = err?.message || String(err)
        }
      }
      if (out.baidu.configured) {
        try {
          const offline = await baiduOfflineList()
          out.baidu.offline = Array.isArray(offline) ? offline.length : 0
        } catch (err) {
          out.baidu.error = err?.message || String(err)
        }
      }
      return out
    },
  },

  {
    name: 'list_library_downloads',
    title: '已下载总览（按番）',
    write: false,
    description: '按作品看下载情况：哪部番下了几集、多大体积、什么状态，以及磁盘上认不出的任务。用于"我下到哪了"。',
    inputSchema: {
      type: 'object',
      properties: { fresh: { type: 'boolean', description: '跳过 4 秒缓存，强制重新读 qB' } },
    },
    async handler({ fresh = false } = {}) {
      const data = await getDownloads({ fresh: Boolean(fresh) })
      return data
    },
  },

  {
    name: 'add_download',
    title: '加种下载',
    write: true,
    description:
      '给某部作品加下载任务。两种用法：① 传 animeId + items（来自 list_releases，每条含 title/magnet/torrentUrl/episode）；' +
      '② 直接传 magnet（磁力）或 torrentUrl（.torrent 地址）+ animeId（可选，用于归档到番名目录）。会按番名建归档目录并统一命名。',
    inputSchema: {
      type: 'object',
      properties: {
        animeId: { type: 'integer', description: '本库作品 id（决定归档目录名）' },
        subgroup: { type: 'string', description: '字幕组名字（会写进标签）' },
        season: { type: 'integer', description: '第几季，默认 1' },
        items: {
          type: 'array',
          description: '资源条目（list_releases 的 items 直接拷过来即可）',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              magnet: { type: 'string' },
              torrentUrl: { type: 'string' },
              episode: { type: 'integer' },
            },
          },
        },
        magnet: { type: 'string', description: '直接给一条磁力（不传 items 时可用）' },
      },
    },
    async handler(args = {}) {
      const { animeId, subgroup = '', season = 1, items = [], magnet } = args
      if (Array.isArray(items) && items.length) {
        return await addDownloads({ animeId, subgroup, season, items })
      }
      /* 裸磁力：没有作品也能加，落 qB 默认目录 + 本程序分类 */
      if (magnet) {
        const result = await qbAddTorrent({
          url: String(magnet),
          savePath: config.qb?.saveRoot || undefined,
          category: config.qb?.category || undefined,
          tags: 'soraika,mcp',
        })
        return { added: 1, results: [result] }
      }
      throw fail('BAD_REQUEST', '要么传 items（资源列表），要么传 magnet')
    },
  },

  {
    name: 'pause_download',
    title: '暂停下载',
    write: true,
    description: '暂停若干任务（传 list_downloads 里的 hash 数组）。',
    inputSchema: {
      type: 'object',
      properties: { hashes: { type: 'array', items: { type: 'string' }, description: '种子 info hash' } },
      required: ['hashes'],
    },
    async handler({ hashes } = {}) {
      const list = hashesOf(hashes)
      return await batchWrite(list, pauseTasks)
    },
  },

  {
    name: 'resume_download',
    title: '继续下载',
    write: true,
    description: '继续若干任务（传 list_downloads 里的 hash 数组）。',
    inputSchema: {
      type: 'object',
      properties: { hashes: { type: 'array', items: { type: 'string' }, description: '种子 info hash' } },
      required: ['hashes'],
    },
    async handler({ hashes } = {}) {
      const list = hashesOf(hashes)
      return await batchWrite(list, resumeTasks)
    },
  },

  {
    name: 'delete_download',
    title: '删除任务',
    write: true,
    description:
      '从 qBittorrent 删除任务。**默认只移除任务、保留磁盘文件**；要连文件一起删必须显式传 deleteFiles=true（不可恢复，调用前应当向用户确认）。',
    inputSchema: {
      type: 'object',
      properties: {
        hashes: { type: 'array', items: { type: 'string' }, description: '种子 info hash' },
        deleteFiles: { type: 'boolean', description: '是否同时删除磁盘文件（默认 false）' },
      },
      required: ['hashes'],
    },
    async handler({ hashes, deleteFiles = false } = {}) {
      const list = hashesOf(hashes)
      const result = await batchWrite(list, (batch) => deleteTasks({ hashes: batch, deleteFiles: Boolean(deleteFiles) }))
      return { ...result, deleteFiles: Boolean(deleteFiles) }
    },
  },

  {
    name: 'rename_download',
    title: '规范化下载名',
    write: true,
    description:
      '按本程序的命名规则（番名 S01E04）重命名任务名 / 种子内文件。**默认 dry-run**：只返回计划，不改任何东西；' +
      '确认后传 apply=true 才真的改。改的是 qBittorrent 里的任务名与文件名（迅雷没有改名接口）。',
    inputSchema: {
      type: 'object',
      properties: {
        hash: { type: 'string', description: '单个种子的 hash；不传则批量（用 limit 限条数）' },
        apply: { type: 'boolean', description: 'false=只看计划（默认），true=真的改' },
        limit: { type: 'integer', description: '批量时的条数上限，默认 10' },
      },
    },
    async handler({ hash, apply = false, limit } = {}) {
      if (hash) {
        /* 单个种子：先看当前名字与建议，再决定改不改 */
        const plan = await renameTorrentItem({ hash: String(hash), dryRun: !apply })
        return { mode: apply ? 'applied' : 'dry-run', ...plan }
      }
      const result = await renameAllDownloads({ limit: Math.max(1, Math.min(Number(limit) || 10, 50)), dryRun: !apply })
      return { mode: apply ? 'applied' : 'dry-run', ...result }
    },
  },

  {
    name: 'xunlei_add',
    title: '迅雷加任务',
    write: true,
    description: '把链接（磁力 / 直链）加到飞牛 NAS 上的迅雷。迅雷**没有改名接口**，任务名由它自己定。',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '磁力或直链' },
        name: { type: 'string', description: '任务名（可选）' },
      },
      required: ['url'],
    },
    async handler({ url, name } = {}) {
      if (!url) throw fail('BAD_REQUEST', '需要 url')
      return await xunleiAddTask({ url: String(url), name })
    },
  },

  {
    name: 'xunlei_delete',
    title: '迅雷删任务',
    write: true,
    description: '按任务 id 删除迅雷任务（id 从 list_downloads 的 xunlei.sample 或下载页取）。',
    inputSchema: {
      type: 'object',
      properties: { ids: { type: 'array', items: { type: 'string' }, description: '迅雷任务 id' } },
      required: ['ids'],
    },
    async handler({ ids } = {}) {
      if (!Array.isArray(ids) || !ids.length) throw fail('BAD_REQUEST', '需要任务 id 数组')
      return await xunleiDeleteTask(ids)
    },
  },

  {
    name: 'baidu_offline_add',
    title: '百度离线下载',
    write: true,
    description: '把磁力 / 电驴 / 直链丢给百度网盘做离线下载（需要百度网盘会员）。落盘目录取设置里的离线目录。',
    inputSchema: {
      type: 'object',
      properties: {
        urls: { type: 'array', items: { type: 'string' }, description: '链接列表' },
        path: { type: 'string', description: '网盘内保存目录（默认设置里的离线目录）' },
      },
      required: ['urls'],
    },
    async handler({ urls, path } = {}) {
      if (!Array.isArray(urls) || !urls.length) throw fail('BAD_REQUEST', '需要 urls 数组')
      return await baiduOfflineAdd({ urls, path })
    },
  },
]
