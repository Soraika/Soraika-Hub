/**
 * 迅雷（fnOS 版）数据源 —— 只读任务列表 + 加任务
 * ---------------------------------------------------------------------------
 * 逆向结果见 `docs/XUNLEI-API.md`。三条硬事实，决定了这里的写法：
 *
 *  ① **不是一个独立服务、也没有独立端口**。它在 fnOS 网关下面按应用转发：
 *     `{fnos基址}/cgi/ThirdParty/xunlei/index.cgi/...`
 *     所以在 5666 上直接打 /tasks 只会拿到 fnOS 的 SPA（这就是之前一直"对不上"的原因）。
 *
 *  ② **鉴权是两件东西一起**：查询参数 `pan_auth`（JWT，3 天有效）
 *     **加上** fnOS 的登录 cookie（`fnos-token`）。只有 pan_auth 会回 `invalid token`，
 *     只有 cookie 网关直接 502。
 *
 *  ③ **没有改名接口**。任务名、文件名都改不了（`/method/delete/` 是唯一存在的 method 路由）。
 *     所以「改名」这件事只能落在 qB 或直接改 NAS 上的文件 —— 这个适配器不碰。
 *
 * 迅雷自己的目录体系：任务参数里 `parent_folder_path` 是 NAS 上真实路径
 * （`/var/apps/xunlei/shares/downloads/`），对外显示成 `/应用文件/xunlei/downloads`。
 * 它和 qB 的 `/downloads/anime/...` 是两棵不同的树，不能混用。
 */
import { config } from '../../config.js'
import { fail } from '../../lib/errors.js'
import { logger } from '../../lib/logger.js'

const NOT_CONFIGURED = '还没配置迅雷（设置 → 下载 → 迅雷）'

export const xunleiConfigured = () =>
  Boolean(config.xunlei?.base && config.xunlei?.cookie && config.xunlei?.panAuth && config.xunlei?.space)

/** phase → 人话（迅雷返回的是 PHASE_TYPE_* 常量） */
const PHASE_TEXT = {
  PHASE_TYPE_PENDING: '等待中',
  PHASE_TYPE_RUNNING: '下载中',
  PHASE_TYPE_PAUSED: '已暂停',
  PHASE_TYPE_ERROR: '出错',
  PHASE_TYPE_DONE: '已完成',
  PHASE_TYPE_WAITING: '排队中',
}
export const phaseTextOf = (phase) => PHASE_TEXT[phase] || String(phase || '未知')

/** 迅雷把状态塞在 params.spec / params.status 两个 JSON 字符串里，能读就读，读不出就算了 */
function statusOf(task) {
  const raw = task?.params?.status || task?.params?.spec || ''
  try {
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

/**
 * 一个迅雷任务 → 界面条目
 * 字段名与 qB 那套对齐（name / fileName / sizeBytes / phase / progress），页面才能共用一套渲染。
 */
function normalize(task) {
  const st = statusOf(task)
  const size = Number(task.file_size || task.params?.file_size || 0) || 0
  const done = Number(st.downloaded || task.downloaded || 0) || 0
  const progress = Number(st.progress ?? task.progress ?? 0)
  return {
    source: 'xunlei',
    id: task.id,
    /** 任务名（迅雷列表里那一行）—— 迅雷改不了，这里只是展示 */
    name: task.name || '',
    fileName: task.file_name || task.name || '',
    sizeBytes: size,
    /** 真实落盘路径（NAS 上的绝对路径） */
    realPath: task.params?.real_path || '',
    parentPath: task.params?.parent_folder_path || '',
    phase: task.phase || '',
    phaseText: phaseTextOf(task.phase),
    progress: Number.isFinite(progress) ? Math.max(0, Math.min(100, Math.round(progress))) : 0,
    /** 百分比算不出来但有字节数时，用字节算 */
    percent: size > 0 && done > 0 ? Math.round((done / size) * 100) : null,
    message: task.message || '',
    error: task.params?.error || '',
    createdAt: task.created_time || '',
    updatedAt: task.updated_time || '',
    kind: task.phase === 'PHASE_TYPE_ERROR' ? 'error' : task.phase === 'PHASE_TYPE_DONE' ? 'done' : 'downloading',
  }
}

/**
 * 打一个迅雷接口（所有接口都挂在这个前缀下）
 * @param {string} path   例如 '/drive/v1/tasks'
 * @param {Object} params 查询参数（pan_auth 会自动补，不用每次传）
 */
async function api(path, params = {}, { method = 'GET', body = null } = {}) {
  if (!xunleiConfigured()) throw fail('BAD_REQUEST', NOT_CONFIGURED)
  const base = String(config.xunlei.base).replace(/\/+$/, '')
  const url = new URL(base + path)
  for (const [k, v] of Object.entries({ ...params, pan_auth: config.xunlei.panAuth })) {
    if (v === undefined || v === null) continue
    url.searchParams.set(k, String(v))
  }
  const res = await fetch(url.href, {
    method,
    body: body === null ? undefined : JSON.stringify(body),
    headers: {
      /* cookie 是 fnOS 的登录态（fnos-token）。**不能只给 pan_auth**，网关会 502 */
      Cookie: config.xunlei.cookie,
      'content-type': 'application/json',
    },
    signal: AbortSignal.timeout(20000),
  })
  const text = await res.text()
  if (!res.ok) {
    if (res.status === 502) throw fail('UPSTREAM', '迅雷拒绝访问：fnOS 登录态（cookie）缺失或过期')
    throw fail('UPSTREAM', `迅雷接口 ${path} 失败：HTTP ${res.status} ${text.slice(0, 80)}`)
  }
  if (text === 'invalid token') throw fail('UPSTREAM', '迅雷 pan_auth 无效或已过期（3 天有效期，去迅雷界面刷新一次）')
  try {
    return JSON.parse(text)
  } catch {
    throw fail('PARSE', `迅雷接口 ${path} 返回的不是 JSON：${text.slice(0, 80)}`)
  }
}

const ALL_PHASES = 'PHASE_TYPE_PENDING,PHASE_TYPE_RUNNING,PHASE_TYPE_PAUSED,PHASE_TYPE_ERROR,PHASE_TYPE_DONE'

/**
 * 任务列表
 * 注意 `{"HttpStatus":0,"expires_in":3}` 是**空列表的长轮询应答**，不是错误 ——
 * 迅雷用 3 秒的短轮询替代推送，客户端看到它就等于"暂时没有任务"。
 */
export async function xunleiTasks({ phases = ALL_PHASES, limit = 100 } = {}) {
  const data = await api('/drive/v1/tasks', {
    space: config.xunlei.space,
    filters: JSON.stringify({ phase: { in: phases } }),
    limit,
  })
  if (!Array.isArray(data?.tasks)) {
    // 空列表：HttpStatus 0 + expires_in
    if (data && data.HttpStatus === 0) return []
    throw fail('UPSTREAM', `迅雷任务列表格式不认识：${JSON.stringify(data).slice(0, 100)}`)
  }
  return data.tasks.map(normalize)
}

/** 账号与容量（设置页显示"连上了/盘还剩多少"用） */
export async function xunleiAbout() {
  return api('/drive/v1/about', { with_quotas: 'CREATE_USER_DOWNLOAD_TASK_LIMIT_INTERNAL' })
}

/** 设备信息（下载目录、剩余空间、VIP 状态）—— 用来验证 cookie 是否有效 */
export async function xunleiDevice() {
  /* 这是个 **POST**（客户端把自己的状态推上去，服务端返回 diff）—— 用 GET 会被 404/空回 */
  const data = await api('/device/info/watch', { space: config.xunlei.space, device_space: '' }, {
    method: 'POST',
    body: { device_space: '', path_separator: '/' },
  })
  return {
    downloads: data?.downloads || [],
    user: data?.user ? { name: data.user.name, vip: data.user.vip?.is_vip } : null,
    runner: data?.runner_status || null,
  }
}

/**
 * 加下载任务
 * ---------------------------------------------------------------------------
 * `name` 是**任务名**（迅雷列表里显示的那一行），`file_name` 是落盘文件名。
 * 两者都传同一个值 = 名字统一；这也正好是我们想要的（番名 S01E01.ext）。
 * @param {{ url: string, name: string, fileName?: string, fileSize?: number|string,
 *           parentPath?: string, totalFileCount?: number }} params
 */
export async function xunleiAddTask({ url, name, fileName, fileSize = '', parentPath = '', totalFileCount = 1 } = {}) {
  if (!url) throw fail('BAD_REQUEST', '缺少下载地址')
  if (!name) throw fail('BAD_REQUEST', '缺少任务名')
  const dir = parentPath || config.xunlei?.downloadDir || ''
  const fileName_ = fileName || name
  const target = config.xunlei.space

  const body = {
    /* user#download-url = 走磁力/直链；种子文件上传是另一套（这里不用，
       因为服务端已经把 .torrent 解析过了，磁力足够让迅雷自己取元数据） */
    type: 'user#download-url',
    name,
    file_name: fileName_,
    file_size: String(fileSize || ''),
    space: target,
    params: {
      target,
      url,
      total_file_count: String(totalFileCount || 1),
      /* parent_folder_path 是 NAS 上的**绝对路径**（/var/apps/xunlei/shares/downloads/…），
         不是对外显示的 /应用文件/…；迅雷按真实路径落盘 */
      parent_folder_path: dir,
      sub_file_index: '--1,',
    },
  }
  const data = await api('/drive/v1/task', {}, { method: 'POST', body })
  if (data && data.HttpStatus && data.HttpStatus !== 0) {
    throw fail('UPSTREAM', `迅雷拒绝了这次加任务：${data.error || data.message || JSON.stringify(data).slice(0, 100)}`)
  }
  logger.info({ name, dir, ok: Boolean(data?.task) }, 'xunlei.add done')
  return { ok: true, taskId: data?.task?.id || '', raw: data }
}

/** 删除任务（迅雷只暴露了这一个写操作） */
export async function xunleiDeleteTask(taskIds) {
  const ids = Array.isArray(taskIds) ? taskIds.join(',') : String(taskIds || '')
  if (!ids) throw fail('BAD_REQUEST', '缺少任务 id')
  return api('/method/delete/drive/v1/tasks', { space: config.xunlei.space, task_ids: ids })
}
