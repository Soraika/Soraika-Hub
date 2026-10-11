/**
 * 请求封装 —— 前端所有接口调用都走这里
 * ---------------------------------------------------------------------------
 * 与后端 lib/errors.js 的约定一一对应：
 *   成功：{ ok: true,  data }
 *   失败：{ ok: false, error: { code, message, detail? } }
 * 这里把「HTTP 失败 / 业务失败 / 超时 / 非 JSON」统一成一个 ApiError，
 * 调用方只判断 err.code 就能决定文案与是否给重试按钮。
 */

/** 与后端 ERROR_CODES 同名，便于跨端排查 */
export class ApiError extends Error {
  constructor(code, message, detail, status) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.detail = detail
    this.status = status
  }

  /** 这类错误重试有意义（网络抖动 / 上游挂了） */
  get retryable() {
    return this.code === 'NETWORK' || this.code === 'UPSTREAM'
  }
}

const DEFAULT_TIMEOUT = 15000

/**
 * 通用请求：GET / POST 共用一套错误归一
 * @param {'GET'|'POST'} method
 * @param {string} path 以 / 开头的相对路径（走 vite proxy，同源）
 * @param {{ params?: object, json?: object, timeout?: number }} [options]
 */
async function apiFetch(method, path, { params, json, timeout = DEFAULT_TIMEOUT } = {}) {
  const url = new URL(path, window.location.origin)
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, value)
  }

  const init = { method, signal: AbortSignal.timeout(timeout) }
  if (json !== undefined) {
    init.headers = { 'Content-Type': 'application/json' }
    init.body = JSON.stringify(json)
  }

  let res
  try {
    res = await fetch(url, init)
  } catch (err) {
    // 超时（TimeoutError）与断网都归 NETWORK —— 都是「再试一次可能就好」
    throw new ApiError(
      'NETWORK',
      err?.name === 'TimeoutError' ? '请求超时，请稍后重试' : '网络连接失败，请检查后端是否已启动',
      { url: url.href },
    )
  }

  let body = null
  try {
    body = await res.json()
  } catch {
    throw new ApiError('PARSE', `返回内容不是 JSON（HTTP ${res.status}）`, { url: url.href }, res.status)
  }

  if (!res.ok || !body?.ok) {
    const err = body?.error
    throw new ApiError(
      err?.code || 'UPSTREAM',
      err?.message || `请求失败（HTTP ${res.status}）`,
      err?.detail,
      res.status,
    )
  }

  return body.data
}

/**
 * @param {string} path 以 / 开头的相对路径（走 vite proxy，同源）
 * @param {{ params?: object, timeout?: number }} [options]
 */
export const apiGet = (path, options) => apiFetch('GET', path, options)

/**
 * @param {string} path
 * @param {object} [json] 请求体（自动序列化 + Content-Type）
 * @param {{ timeout?: number }} [options]
 */
export const apiPost = (path, json, options) => apiFetch('POST', path, { ...options, json })

/**
 * @param {string} path
 * @param {object} [json] 请求体
 * @param {{ timeout?: number }} [options]
 */
export const apiPut = (path, json, options) => apiFetch('PUT', path, { ...options, json })
