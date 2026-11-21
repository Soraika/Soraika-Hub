/**
 * MCP 服务端 —— JSON-RPC 2.0 over HTTP（Streamable HTTP 传输，单次 POST 回 JSON）
 * ---------------------------------------------------------------------------
 * 只做 MCP 的 **tools** 原语：agent 对本地资料库的需求都是「问一句 / 做一件」，
 * resources 与 prompts 加进来只多一层要维护的东西。
 *
 * 请求流程：
 *   POST /mcp  { jsonrpc, id, method, params }
 *     ├ initialize            → 协议版本（回声客户端报的）+ 能力 + 服务器信息
 *     ├ notifications/*       → 202（通知没有响应体，这是协议要求）
 *     ├ tools/list            → 工具清单（含 JSON Schema）
 *     ├ tools/call            → 执行一个工具
 *     └ ping                  → {}
 *
 * 三条不能省的实现细节：
 *   ① **鉴权在方法分发之前**：未带令牌的 `initialize` 也要 401 ——
 *      否则任何人都能列举出你有哪些工具（信息泄露，虽然不致命）。
 *   ② **一次请求只处理一个 JSON-RPC 消息**（不做 batch）：MCP 客户端实际很少发 batch，
 *      而 batch 会让「哪个错误属于哪条」变得难说清。客户端发了 batch 会收到 -32600。
 *   ③ **工具抛错不崩进程**：所有 handler 的错误都收成 `isError: true` 的 content，
 *      模型能看到原因（比如「qB 没配」），服务器继续活。
 */
import { Router } from 'express'
import { config } from '../config.js'
import { logger } from '../lib/logger.js'
import { DEFAULT_PROTOCOL_VERSION, PROTOCOL_VERSIONS, RPC_ERROR, SERVER_INFO, rpcError, rpcResult, toolContent } from './protocol.js'
import { tokenFromRequest, tokenMatches } from './tokens.js'
import { catalogTools } from './tools-catalog.js'
import { downloadTools } from './tools-downloads.js'

/** 全部工具（只读在前，写入在后 —— tools/list 的顺序就是模型看到的分组顺序） */
export const ALL_TOOLS = [...catalogTools, ...downloadTools]

const TOOL_BY_NAME = new Map(ALL_TOOLS.map((tool) => [tool.name, tool]))

/** 调用统计（只在内存：重启归零。用来在设置页显示「agent 真的在用」） */
export const mcpStats = { calls: 0, toolCalls: 0, lastCallAt: null, lastTool: null, errors: 0 }

/** 工具清单的 MCP 形状（内部字段 write / title / handler 不外泄） */
const publicTool = (tool) => ({
  name: tool.name,
  title: tool.title,
  description: tool.description,
  inputSchema: tool.inputSchema || { type: 'object', properties: {} },
  annotations: {
    /* MCP 标准注解：让客户端提前知道"这个工具会改东西"，可以在 UI 上要二次确认 */
    readOnlyHint: !tool.write,
    destructiveHint: Boolean(tool.write),
  },
})

/** 设置页那张卡片用的摘要（不带 handler） */
export const toolSummary = () => ALL_TOOLS.map(({ name, title, description, write }) => ({ name, title, description, write: Boolean(write) }))

/** 服务是否启用 */
export const mcpEnabled = () => Boolean(config.mcp?.enabled)

/** 端点地址（给客户端配置片段用）：跟随请求的 Host，容器/NAS/反代都对 */
export function endpointOf(req) {
  const proto = String(req?.get?.('x-forwarded-proto') || req?.protocol || 'http').split(',')[0].trim()
  const host = req?.get?.('x-forwarded-host') || req?.get?.('host') || `127.0.0.1:${config.port}`
  return `${proto}://${host}/mcp`
}

/**
 * 执行一个工具
 * @param {string} name
 * @param {object} args
 * @param {{ log?: object }} [ctx]
 */
export async function callTool(name, args = {}, { log = logger } = {}) {
  const tool = TOOL_BY_NAME.get(String(name))
  if (!tool) return toolContent({ error: `没有这个工具：${name}`, available: ALL_TOOLS.map((t) => t.name) }, { isError: true })
  if (tool.write && !config.mcp?.allowWrite) {
    return toolContent(
      {
        error: '写入被禁用',
        detail: `${tool.name} 会真的改动下载任务，需要在「设置 → MCP」里打开「允许写入」`,
      },
      { isError: true },
    )
  }
  mcpStats.toolCalls++
  mcpStats.lastTool = tool.name
  try {
    const result = await tool.handler(args || {}, { log })
    return toolContent(result ?? { ok: true })
  } catch (err) {
    mcpStats.errors++
    log.warn({ tool: tool.name, err: err?.message, code: err?.code }, 'mcp.tool fail')
    return toolContent({ error: err?.message || String(err), code: err?.code || 'INTERNAL' }, { isError: true })
  }
}

/** 处理一条 JSON-RPC 消息（不含鉴权与 HTTP） */
async function handleMessage(message, { log }) {
  const { id = null, method, params } = message || {}

  switch (method) {
    case 'initialize': {
      const asked = params?.protocolVersion
      return rpcResult(id, {
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : DEFAULT_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions:
          'Soraika\'s Hub：本地动画库（全站约 3 万部档案 + 季度排期 + 系列链）与下载控制。' +
          '搜索与推荐全部离线、秒回；字幕组与资源列表要联网问 Mikan；下载工具需要用户开启「允许写入」。',
      })
    }

    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null // 通知没有响应

    case 'ping':
      return rpcResult(id, {})

    case 'tools/list':
      return rpcResult(id, { tools: ALL_TOOLS.map(publicTool) })

    case 'tools/call': {
      const name = params?.name
      if (!name) return rpcError(id, RPC_ERROR.INVALID_PARAMS, 'params.name 缺失')
      const content = await callTool(name, params?.arguments || {}, { log })
      return rpcResult(id, content)
    }

    default:
      return rpcError(id, RPC_ERROR.METHOD_NOT_FOUND, `不支持的方法：${method}`)
  }
}

/**
 * Express 路由：POST /mcp
 * 注意挂在 /api 之外：客户端配置里就是 `http://host/mcp`，短、好记、不与 API 路由混在一起
 */
export function createMcpRouter() {
  const router = Router()

  router.post('/mcp', async (req, res) => {
    /* ① 开关：没启用一律 404，连"这里有个 MCP 服务"都不告诉未授权者 */
    if (!mcpEnabled()) {
      return res.status(404).json(rpcError(null, RPC_ERROR.METHOD_NOT_FOUND, 'MCP 服务未启用（设置 → MCP）'))
    }

    /* ② 鉴权 */
    const token = String(config.mcp?.token || '')
    if (!token) {
      return res.status(401).json(rpcError(null, RPC_ERROR.INVALID_REQUEST, '没有配置访问令牌（设置 → MCP 里重新生成）'))
    }
    if (!tokenMatches(tokenFromRequest(req), token)) {
      req.log?.warn?.({ ip: req.ip }, 'mcp.auth reject')
      return res.status(401).json(rpcError(null, RPC_ERROR.INVALID_REQUEST, '令牌不对（Authorization: Bearer <token>）'))
    }

    /* ③ 协议 */
    const body = req.body
    if (Array.isArray(body)) {
      return res.status(400).json(rpcError(null, RPC_ERROR.INVALID_REQUEST, '不支持批量请求（一次一条 JSON-RPC 消息）'))
    }
    if (!body || typeof body !== 'object') {
      return res.status(400).json(rpcError(null, RPC_ERROR.PARSE, 'body 需要是 JSON 对象'))
    }
    if (body.jsonrpc !== '2.0') {
      return res.status(400).json(rpcError(body?.id ?? null, RPC_ERROR.INVALID_REQUEST, '缺少 "jsonrpc": "2.0"'))
    }

    mcpStats.calls++
    mcpStats.lastCallAt = Date.now()
    req.log?.debug?.({ method: body.method }, 'mcp.req')

    try {
      const response = await handleMessage(body, { log: req.log ?? logger })
      if (!response) return res.status(202).end() // 通知
      return res.json(response)
    } catch (err) {
      req.log?.error?.({ err: err?.message, method: body.method }, 'mcp.fail')
      return res.status(500).json(rpcError(body?.id ?? null, RPC_ERROR.INTERNAL, '服务器内部错误', String(err?.message || err)))
    }
  })

  /* GET /mcp：部分客户端会先探一下（协议允许 405，别让它们以为服务不存在） */
  router.get('/mcp', (req, res) => {
    res.setHeader('Allow', 'POST')
    res.status(405).json({ ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'MCP 只接受 POST（JSON-RPC）' } })
  })

  return router
}
