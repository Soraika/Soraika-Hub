/**
 * 服务入口 —— Express + 统一错误信封
 * ---------------------------------------------------------------------------
 * 启动：`npm run dev`（= node --env-file-if-exists=.env --watch src/index.js）
 * 约定：
 *   · 成功：{ ok: true, data }
 *   · 失败：{ ok: false, error: { code, message, detail? } }，HTTP 状态码由错误码映射
 *   · 日志/业务都在 lib 与 api 层，这里只做「装配 + 兜底」
 */
import { existsSync } from 'node:fs'
import path from 'node:path'
import express from 'express'
import pinoHttp from 'pino-http'
import { startWorker, stopWorker } from './jobs/worker.js'
import { loadStoredSettings } from './api/pages/settings.js'
import { config } from './config.js'
import { db } from './db/index.js'
import { toApiError } from './lib/errors.js'
import { logger } from './lib/logger.js'
import { createMcpRouter } from './mcp/server.js'
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

/* MCP 服务（JSON-RPC over HTTP）—— 挂在 /api 之外：客户端配置里就是 http://host/mcp。
   未启用时路由照样存在，但一律回 404（不告诉未授权者这里有个 MCP 服务）。 */
app.use(createMcpRouter())

/* ── 前端静态文件（同一个进程同时当 web 服务器）────────────────────────────
 * 开发时用 vite dev server（带 HMR、proxy），这里什么都不做；
 * 生产/Docker 里把 Web/dist 一起塞进镜像，由这个进程托管 —— 同源，没有跨域、
 * 不用再拉一个 nginx。目录可用 WEB_DIR 覆盖（默认取 ../Web/dist）。
 * 找不到就静默跳过：只跑 API 也能正常工作（旧行为保持不变）。
 */
const WEB_DIR = path.resolve(process.env.WEB_DIR || path.join(process.cwd(), '..', 'Web', 'dist'))
const hasWeb = existsSync(path.join(WEB_DIR, 'index.html'))
if (hasWeb) {
  app.use(express.static(WEB_DIR, { index: false, maxAge: '7d', setHeaders: (res, file) => {
    /* index.html 不能被长缓存：否则更新后浏览器一直拿旧壳，白屏排查半天 */
    if (file.endsWith('index.html')) res.setHeader('Cache-Control', 'no-cache')
  } }))
  logger.info({ webDir: WEB_DIR }, 'api.static ok')
}

/* 设置页存过的覆盖项要在**第一个请求进来之前**应用到 config ——
 * 之后路由/任务读到的就都是生效值（import db 时表已建好，所以这里能安全读库） */
const overriddenCount = loadStoredSettings()

/* 没有匹配到任何路由
 * · GET 的页面请求 → 回 index.html（前端没有 router，但保留这条以防以后加）
 * · 其它（尤其 /api/*）→ 照旧回 JSON 404，不要用 HTML 骗调用方
 */
app.use((req, res) => {
  /* 只给「像页面」的请求回 index.html：带扩展名的（丢了的 js/css/图片）必须是 404，
     否则浏览器会拿到一段 HTML 当 JS 执行，报错信息完全对不上真实原因。 */
  const looksLikeFile = /\.[a-z0-9]{2,6}$/i.test(req.path)
  if (hasWeb && req.method === 'GET' && !looksLikeFile && !req.path.startsWith('/api')) {
    return res.sendFile(path.join(WEB_DIR, 'index.html'))
  }
  res.status(404).json({
    ok: false,
    error: { code: 'NOT_FOUND', message: `没有这个接口：${req.method} ${req.originalUrl}` },
  })
})

// 统一错误处理：ApiError 按错误码映射状态码，其余归 INTERNAL
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  /* body 不是合法 JSON：这是**调用方的错**，别报成 500。
     express.json() 抛的是 SyntaxError + type='entity.parse.failed'，
     不特判就会落进 INTERNAL（客户端拿 500 时会去查服务端日志，白忙） */
  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({
      ok: false,
      error: { code: 'BAD_REQUEST', message: `请求体不是合法 JSON：${String(err.message || '').slice(0, 120)}` },
    })
  }
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

/**
 * 进程级兜底：这类错误 try/catch 是拦不住的
 * ---------------------------------------------------------------------------
 * 实测踩过：undici 在 socket 事件回调里同步 `assert(!this.paused)` 失败 ——
 * 那是**事件回调里的同步抛错**，任何 await/try 都包不住，Node 直接退出。
 * 这类问题不该让「服务整个消失、日志只剩一行 assert」：
 *   · uncaughtException：记 error 日志（带 stack）后**继续跑**。单次请求/单次下载的
 *     内部状态坏掉，不等于整个进程该停；停机与否交给健康检查与运维判断。
 *   · unhandledRejection：只记日志（Node 默认在 22 上会退出，先兜住）。
 * 注意：继续跑的前提是「状态没坏」。真正的内存耗尽之类还是会死，那种停就停。
 * 下载本身已经改用 node:http 实现（见 api/sources/bgm-dump.js 的注释），
 * 这条兜底是为了「以后别再遇到同类问题时只剩一行 assert」。
 */
process.on('uncaughtException', (err) => {
  logger.error({ err: err?.stack || String(err), kind: 'uncaughtException' }, 'process.uncaught 已被兜底，进程继续')
})
process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason?.stack || String(reason), kind: 'unhandledRejection' }, 'process.unhandledRejection')
})

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
