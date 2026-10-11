/**
 * HTTP 客户端 —— 抓外部源统一走这里
 * ---------------------------------------------------------------------------
 * 解决三件每次抓取都要重复写的事：
 *   1. 超时（AbortSignal.timeout，不会因为上游挂起把请求栈占死）
 *   2. 重试 + 指数退避（网络抖动 / 5xx / 429 可重试；4xx 属于参数错误，不重试）
 *   3. 带 UA（Bangumi 官方接口不带 UA 会被拒）
 * 失败一律抛 ApiError，错误码由调用方语义决定：
 *   连不上/超时 → NETWORK；上游非 2xx → UPSTREAM。
 */
import { ApiError, fail } from './errors.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 该不该重试：参数错误、找不到 这类不重试；其余（网络、5xx）重试 */
function isRetryable(err) {
  if (err instanceof ApiError) return err.code === 'NETWORK' || err.code === 'UPSTREAM'
  return true
}

/**
 * @param {string} url
 * @param {object} [options]
 * @param {'GET'|'POST'} [options.method]
 * @param {object} [options.headers]
 * @param {object} [options.json]    POST body（自动序列化 + Content-Type）
 * @param {number} [options.timeoutMs]
 * @param {number} [options.retries] 额外重试次数（默认 2）
 * @param {'text'|'json'|'buffer'} [options.expect]
 * @param {string} [options.tip]     日志/错误信息里的名字
 */
export async function request(url, options = {}) {
  const {
    method = 'GET',
    headers = {},
    json,
    timeoutMs = 20000,
    retries = 2,
    expect = 'text',
    tip = url,
  } = options

  const finalHeaders = { ...headers }
  let body
  if (json !== undefined) {
    finalHeaders['Content-Type'] = 'application/json'
    body = JSON.stringify(json)
  }

  let lastError
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { method, headers: finalHeaders, body, signal: AbortSignal.timeout(timeoutMs) })

      if (!res.ok) {
        // 4xx 是参数/权限问题，重试没意义
        const retryable = res.status >= 500 || res.status === 429
        const err = fail('UPSTREAM', `${tip} 返回 HTTP ${res.status}`, { url, status: res.status })
        err.__retryable = retryable
        throw err
      }

      if (expect === 'json') return await res.json()
      if (expect === 'buffer') return Buffer.from(await res.arrayBuffer())
      return await res.text()
    } catch (err) {
      lastError = err
      const retryable = err.__retryable ?? isRetryable(err)
      if (retryable && attempt < retries) {
        await sleep(400 * 2 ** attempt) // 0.4s → 0.8s
        continue
      }
      break
    }
  }

  if (lastError instanceof ApiError) throw lastError
  throw fail('NETWORK', `${tip} 请求失败：${lastError?.message || '未知错误'}`, { url })
}
