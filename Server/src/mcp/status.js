/**
 * MCP 服务的「设置页视图」—— 状态 / 令牌 / 客户端配置片段
 * ---------------------------------------------------------------------------
 * 为什么拼配置片段交给后端生成：片段里的 URL 和令牌都得跟**当前部署**一致
 * （容器里的端口、NAS 的 IP、反代后的域名）。前端拼不出来，手抄必错。
 *
 * 三种客户端三种格式，覆盖了实际会用的全部：
 *   · Claude Code：`claude mcp add` 命令（HTTP 传输）
 *   · Cursor / Claude Desktop：JSON（`mcpServers` 块，HTTP 形态）
 *   · Hermes Agent：YAML（`mcp_servers` 块，Hermes 走的是同一套 HTTP 客户端）
 */
import { config } from '../config.js'
import { updateSettings } from '../api/pages/settings.js'
import { logger } from '../lib/logger.js'
import { generateToken, maskToken } from './tokens.js'
import { ALL_TOOLS, endpointOf, mcpEnabled, mcpStats, toolSummary } from './server.js'

/** 令牌为空时自动补一个（启用服务时调用；已有值绝不动） */
export function ensureToken({ log = logger } = {}) {
  if (String(config.mcp?.token || '')) return config.mcp.token
  const token = generateToken()
  updateSettings({ 'mcp.token': token }, { log })
  log.info({ preview: maskToken(token) }, 'mcp.token generated')
  return token
}

/** 重新生成令牌（旧令牌立刻失效） */
export function rotateToken({ log = logger } = {}) {
  const token = generateToken()
  updateSettings({ 'mcp.token': token }, { log })
  log.warn({ preview: maskToken(token) }, 'mcp.token rotated')
  return token
}

/** 客户端配置片段 */
function clientSnippets(endpoint, token) {
  const url = `${endpoint}?token=${encodeURIComponent(token)}`
  return [
    {
      name: 'Claude Code',
      kind: 'shell',
      snippet: `claude mcp add --transport http soraikas-hub "${endpoint}" \\\n  --header "Authorization: Bearer ${token}"`,
    },
    {
      name: 'Cursor / Claude Desktop',
      kind: 'json',
      snippet: JSON.stringify(
        {
          mcpServers: {
            'soraikas-hub': {
              type: 'http',
              url: endpoint,
              headers: { Authorization: `Bearer ${token}` },
            },
          },
        },
        null,
        2,
      ),
    },
    {
      name: 'Hermes Agent',
      kind: 'yaml',
      snippet: `mcp_servers:\n  soraikas-hub:\n    transport: http\n    url: "${endpoint}"\n    headers:\n      Authorization: "Bearer ${token}"`,
    },
    {
      name: '不支持 header 的客户端',
      kind: 'url',
      snippet: url,
    },
  ]
}

/**
 * 设置页那张卡片要的全部信息
 * @param {object} req 用来算端点地址（跟随 Host / 反代头）
 */
export function getMcpStatus(req) {
  const token = String(config.mcp?.token || '')
  const endpoint = endpointOf(req)
  return {
    enabled: mcpEnabled(),
    allowWrite: Boolean(config.mcp?.allowWrite),
    endpoint,
    token,
    tokenPreview: maskToken(token),
    maxResults: Number(config.mcp?.maxResults) || 20,
    toolCount: ALL_TOOLS.length,
    tools: toolSummary(),
    stats: { ...mcpStats },
    clients: clientSnippets(endpoint, token),
  }
}
