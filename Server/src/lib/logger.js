/**
 * 日志出口 —— 全站唯一的 pino 实例（pino-http 也复用它）
 * ---------------------------------------------------------------------------
 * 约定见 CONVENTIONS.md §4：消息用「模块.动作 结果」+ 结构化字段，禁止 console.*。
 * 开发用 pino-pretty（单行彩色、好读）；NODE_ENV=production 输出 JSON 供采集。
 * 级别由 LOG_LEVEL 控制（默认 info；要单条上游请求细节设 debug）。
 *
 * 分层说明：本模块**刻意不 import config** —— 它是最底层，config 反而要 import 它
 * 来报「配置非法」。所以日志级别直接从 env 读，不经过 config。
 *
 * 谁用哪个 logger：
 *   · 请求路径：pino-http 注入的 req.log（带 requestId，一次请求的日志能串起来）
 *   · 后台任务 / 启动装配 / CLI：这里的默认 logger
 */
import pino from 'pino'

const level = process.env.LOG_LEVEL || 'info'
const pretty = process.env.NODE_ENV !== 'production'

export const logger = pino({
  level,
  // 只留 pid：本机跑时 hostname 没意义，但 pid 能区分「跟随服务的内嵌 worker」与「独立 worker」
  base: { pid: process.pid },
  ...(pretty
    ? {
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:HH:MM:ss',
            ignore: 'hostname',
          },
        },
      }
    : {}),
})

export default logger
