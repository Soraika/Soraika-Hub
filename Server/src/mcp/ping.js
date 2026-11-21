/**
 * MCP 自检 —— 后端假装成一个客户端，按真实协议打一次自己
 * ---------------------------------------------------------------------------
 * 为什么不是简单的 `fetch('/mcp')`：连接失败的原因有十几种（没启用 / 令牌不匹配 /
 * 端口没通 / 反代丢了 POST body），只回一个 false 等于没说。
 * 这里按 **initialize → tools/list** 的顺序走一遍，把每一步的结论都带回来 ——
 * 设置页上一眼看得出卡在哪。
 *
 * 走的是**本机回环**（127.0.0.1:PORT），也就是绕开任何反代/域名问题：
 * 自检通说明服务本身没问题，客户端连不上就是网络/反代/令牌抄错了。
 */
import { config } from '../config.js'
import { ALL_TOOLS } from './server.js'

/** 一次 JSON-RPC 调用 */
async function rpc(method, params, token) {
  const url = `http://127.0.0.1:${config.port}/mcp`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(Math.max(3000, Number(config.mcp?.timeoutMs) || 15000)),
  })
  const text = await res.text()
  let body = null
  try {
    body = JSON.parse(text)
  } catch {
    body = null
  }
  return { status: res.status, body, text }
}

/**
 * 跑一次自检
 * @returns {Promise<{ok:boolean, tools?:number, ms:number, step?:string, error?:string}>}
 */
export async function parseJsonRpcPing() {
  const startedAt = Date.now()
  const ms = () => Date.now() - startedAt

  if (!config.mcp?.enabled) return { ok: false, ms: ms(), step: 'enabled', error: 'MCP 服务未启用（设置里打开「启用 MCP 服务」）' }
  if (!config.mcp?.token) return { ok: false, ms: ms(), step: 'token', error: '还没有访问令牌（点「重新生成」）' }

  try {
    const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'soraikas-hub-selfcheck', version: '1' } }, config.mcp.token)
    if (init.status === 401) return { ok: false, ms: ms(), step: 'auth', error: '令牌校验没通过（服务读到的令牌与配置不一致？重启一次服务试试）' }
    if (!init.body?.result) {
      return { ok: false, ms: ms(), step: 'initialize', error: `initialize 没有返回结果（HTTP ${init.status}）：${String(init.text).slice(0, 160)}` }
    }

    const list = await rpc('tools/list', {}, config.mcp.token)
    const tools = Array.isArray(list.body?.result?.tools) ? list.body.result.tools.length : 0
    if (!tools) {
      return { ok: false, ms: ms(), step: 'tools/list', error: `没能列出工具（HTTP ${list.status}）：${String(list.text).slice(0, 160)}` }
    }
    if (tools !== ALL_TOOLS.length) {
      return { ok: false, ms: ms(), step: 'tools/list', error: `工具数对不上（服务端 ${tools} / 代码里 ${ALL_TOOLS.length}）` }
    }
    return { ok: true, tools, protocol: init.body.result.protocolVersion, ms: ms() }
  } catch (err) {
    return { ok: false, ms: ms(), step: 'connect', error: `连不上自己（127.0.0.1:${config.port}）：${err?.message || err}` }
  }
}
