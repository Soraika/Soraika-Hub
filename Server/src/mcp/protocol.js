/**
 * JSON-RPC 2.0 + MCP 协议常量与信封
 * ---------------------------------------------------------------------------
 * MCP 就是 JSON-RPC 2.0，只是把方法名、错误码、三种「原语」（tools / resources / prompts）
 * 定了下来。我们只实现 **tools**：agent 需要的都是「问一句答一句」的动作，
 * resources（可读的 URI 目录）和 prompts（预置模板）对本地资料库没有额外价值，
 * 多实现一套只是多一处能出错的地方。
 *
 * 支持的协议版本：客户端在 `initialize` 里报自己的版本，我们**回声**它报的版本
 * （只要在已知列表里）—— 回错版本会让严格实现的客户端直接断开。
 */
export const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']
export const DEFAULT_PROTOCOL_VERSION = PROTOCOL_VERSIONS[0]

export const SERVER_INFO = {
  name: 'soraikas-hub',
  title: "Soraika's Hub",
  version: '1.2.0',
}

/** JSON-RPC 错误码（协议规定的那几个 + MCP 约定的服务器错误范围） */
export const RPC_ERROR = {
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
}

export const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result })
export const rpcError = (id, code, message, data) => ({
  jsonrpc: '2.0',
  id: id ?? null,
  error: { code, message, ...(data === undefined ? {} : { data }) },
})

/**
 * 工具执行结果 → MCP 的 content 数组
 * ---------------------------------------------------------------------------
 * 两种内容都给：
 *   · `text`：JSON 字符串 —— 所有客户端都支持，模型直接读
 *   · `structuredContent`：同一份对象的结构化副本 —— 新版客户端可以按 schema 取字段
 * 工具报错**不走 JSON-RPC error**，而是 `isError: true`：协议里那层错误是
 * 「协议本身出问题了」，业务失败（比如没配令牌）应该让模型看见并自己决定下一步。
 */
export function toolContent(payload, { isError = false } = {}) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2)
  return {
    content: [{ type: 'text', text }],
    ...(isError ? { isError: true } : {}),
  }
}
