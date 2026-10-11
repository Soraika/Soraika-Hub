/**
 * 统一错误码 —— 覆盖「每个事件的整个生命周期」
 * ---------------------------------------------------------------------------
 * 前端只认 `code`：决定文案、决定要不要给「重试」按钮。
 *   NETWORK  —— 连不上 / 超时（可重试）
 *   UPSTREAM —— 上游返回了非 2xx（可重试）
 *   PARSE    —— 上游返回了内容但解析不出来（页面改版，一般重试也没用 → 要报警）
 *   NOT_FOUND—— 数据不存在（别重试）
 *   BAD_REQUEST —— 入参不合法（别重试）
 *   AI_DISABLED —— 功能没配好（AI 未配置），重试也不会好，要人去填 key
 *   INTERNAL —— 我们自己的 bug
 * HTTP 状态码由 code 映射，路由层不用各自决定。
 */

export const ERROR_CODES = {
  BAD_REQUEST: 400,
  NOT_FOUND: 404,
  INTERNAL: 500,
  AI_DISABLED: 501,
  UPSTREAM: 502,
  PARSE: 502,
  NETWORK: 504,
}

export class ApiError extends Error {
  /**
   * @param {keyof ERROR_CODES} code
   * @param {string} message  给人看的说明（会进响应）
   * @param {object} [detail] 排错用上下文（上游地址、选择器、原始片段等）
   */
  constructor(code, message, detail) {
    super(message)
    this.name = 'ApiError'
    this.code = ERROR_CODES[code] ? code : 'INTERNAL'
    this.detail = detail
  }

  get status() {
    return ERROR_CODES[this.code] ?? 500
  }
}

/** 快捷构造：fail('UPSTREAM', '…') */
export const fail = (code, message, detail) => new ApiError(code, message, detail)

/** 把任意异常归一成 ApiError（路由统一错误处理用） */
export function toApiError(err) {
  if (err instanceof ApiError) return err
  return new ApiError('INTERNAL', err?.message || '服务器内部错误', { stack: err?.stack })
}
