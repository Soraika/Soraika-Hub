import { pino } from 'pino'

// 浏览器端 pino：开发环境全量输出，生产环境只保留 warn/error（避免刷控制台）
const level = import.meta.env.DEV ? 'debug' : 'warn'
const browserLogger = pino({ level, browser: { asObject: false } })

/**
 * 带模块标签的前端日志器
 * @param {string} tag 模块名，如 'AnimeDetailPanel'
 */
export function createLogger(tag) {
  return {
    debug: (...args) => browserLogger.debug({ tag }, ...args),
    info: (...args) => browserLogger.info({ tag }, ...args),
    warn: (...args) => browserLogger.warn({ tag }, ...args),
    error: (...args) => browserLogger.error({ tag }, ...args),
  }
}

export default createLogger
