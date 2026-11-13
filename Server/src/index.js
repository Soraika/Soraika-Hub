/**
 * 服务入口 —— Express + 统一错误信封
 * ---------------------------------------------------------------------------
 * 启动：`npm run dev`（= node --env-file-if-exists=.env --watch src/index.js）
 * 约定：
 *   · 成功：{ ok: true, data }
 *   · 失败：{ ok: false, error: { code, message, detail? } }，HTTP 状态码由错误码映射
 *   · 日志/业务都在 lib 与 api 层，这里只做「装配 + 兜底」
 */
import express from 'express'
import pinoHttp from 'pino-http'
import { startWorker, stopWorker } from './jobs/worker.js'
import { loadStoredSettings } from './api/pages/settings.js'
import { config } from './config.js'
import { db } from './db/index.js'
import { toApiError } from './lib/errors.js'
import { logger } from './lib/logger.js'
import { apiRouter } from './routes/index.js'

const app = express()
app.disable('x-powered-by')
app.use(express.json({ limit: '1mb' }))

// 请求日志用官方中间件（自带 requestId / 耗时 / 状态码），并把 req.log 注入给下游
// 序列化裁短：默认会把 req/res 整对象打出来，一屏就糊了
app.use(
  pinoHttp({
    logger,
    serializers: {
      req: (req) => `${req.method} ${req.url}`,
      res: (res) => `${res.statusCode}`,
    },
    // 消息文案按状态码分级：ok / client-error / server-error
    customSuccessMessage: (req, res) =>
      res.statusCode >= 500 ? 'api.req server-error' : res.statusCode >= 400 ? 'api.req client-error' : 'api.req ok',
    customErrorMessage: () => 'api.req fail',
    customLogLevel: (req, res, err) =>
      err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
    // 健康检查会被前端/监控频繁打，别刷屏
    autoLogging: { ignore: (req) => req.url.startsWith('/api/health') },
  }),
)

// 开发时直接用浏览器/Postman 调接口方便；生产同源部署（vite proxy）其实用不到
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  if (req.method === 'OPTIONS') return res.sendStatus(204)
  next()
})

app.use('/api', apiRouter)

/* 设置页存过的覆盖项要在**第一个请求进来之前**应用到 config ——
 * 之后路由/任务读到的就都是生效值（import db 时表已建好，所以这里能安全读库） */
const overriddenCount = loadStoredSettings()

// 没有匹配到任何路由
app.use((req, res) => {
  res.status(404).json({
    ok: false,
    error: { code: 'NOT_FOUND', message: `没有这个接口：${req.method} ${req.originalUrl}` },
  })
})

// 统一错误处理：ApiError 按错误码映射状态码，其余归 INTERNAL
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const apiError = toApiError(err)
  if (apiError.status >= 500) {
    // 用请求级 logger：同一次请求的日志靠 requestId 串起来
    ;(req.log ?? logger).error(
      { code: apiError.code, status: apiError.status, detail: apiError.detail },
      'api.handler fail',
    )
  }
  res.status(apiError.status).json({
    ok: false,
    error: { code: apiError.code, message: apiError.message, detail: apiError.detail },
  })
})

const server = app.listen(config.port, () => {
  logger.info(
    {
      port: config.port,
      mikan: config.mikan.bases,
      bgm: config.bgm.bases,
      workerInline: config.worker.inline,
      dailyAt: config.worker.dailyAt,
      /** 设置页覆盖过的配置项数量（0 = 全用 .env / 默认值） */
      settingsOverridden: overriddenCount,
    },
    'api.listen ok',
  )

  // 后台守护进程：逐条补齐「作品档案」（bgmId + 字幕组 + 评分/标签/简介）并每日更新
  // 不想让它跟着服务跑就设 WORKER_INLINE=0，然后单独 `npm run worker`
  if (config.worker.inline) startWorker()
})

/* ── 优雅停机 ──────────────────────────────────────────────────────────────
 * 顺序很重要：先停后台队列（等手上这一条落库）→ 停止收新请求 → 关 SQLite → 退出。
 * 反过来（先关连接）会让正在写的那条直接抛错，留下半条数据。
 */
let shuttingDown = false

async function shutdown(signal) {
  if (shuttingDown) return
  shuttingDown = true
  logger.info({ signal }, 'api.shutdown start')

  // 最多等 5 秒：别让一个卡住的上游请求把停机拖死
  await Promise.race([stopWorker(), new Promise((resolve) => setTimeout(resolve, 5000))])
  await new Promise((resolve) => server.close(resolve))
  db.close()

  logger.info('api.shutdown ok')
  process.exit(0)
}

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
