# 把 AI 能力接给 MCP / 其他 Agent 框架

服务端已经把 AI 能力做成两个端点，**刻意照 MCP 的形状设计**，
所以包一个 MCP server 不需要再抄一遍工具定义与参数校验。

| MCP | 对应 HTTP |
|---|---|
| `tools/list` | `GET /api/ai/tools` → `{ enabled, model, concurrency, tools: [{ name, description, inputSchema }] }` |
| `tools/call` | `POST /api/ai/call`，body `{ name, arguments }` → `{ content: [{ type: 'text', text }], structured, isError }` |

前端的便利直连（不是给 MCP 用的，但同一套实现）：

- `POST /api/ai/classify/tags`，body `{ titles: string[] }`
- `POST /api/ai/classify/episodes`，body `{ title?: string, titles: string[] }`

## 现有工具

| name | 作用 | 入参 |
|---|---|---|
| `anime_release_tags` | 资源文件名 → 筛选标签（分辨率 / 编码 / 字幕 / 片源），每个标签带 `match[]` 供按字符串匹配 | `{ titles: string[] }` |
| `anime_episode_meta` | 资源文件名 → 每条资源的集数（合集给 `"1-12"`，认不出给 null）。番名与季不出：番名由调用方传入，季由系列季位决定 | `{ title?: string, titles: string[] }` |
| `anime_search` | 自然语言 → 搜索/推荐（可容错、可推荐）。AI 只解析意图，结果由确定性搜索给出；返回卡片列表 + `intent`（含 `reason`） | `{ query: string }` |

## 最小 MCP server 骨架（示意，stdio 传输）

```js
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const HUB = process.env.HUB_BASE ?? 'http://127.0.0.1:3100'
const server = new Server({ name: 'soraikahub-ai', version: '0.1.0' }, { capabilities: { tools: {} } })

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const { data } = await (await fetch(`${HUB}/api/ai/tools`)).json()
  return { tools: data.tools }            // 清单直出，无需手写
})

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const res = await fetch(`${HUB}/api/ai/call`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: req.params.name, arguments: req.params.arguments }),
  })
  const body = await res.json()
  if (!res.ok || !body.ok) {
    return { isError: true, content: [{ type: 'text', text: `${body.error?.code}: ${body.error?.message}` }] }
  }
  return { content: body.data.content, structuredContent: body.data.structured }
})

await server.connect(new StdioServerTransport())
```

## 约定（照服务端 CONVENTIONS 来）

- **未配置 AI**（设置页没填 AI key）：清单照常返回（`enabled: false`），
  调用得到 `AI_DISABLED`（HTTP 501）。MCP 层应转成 `isError: true` 并把 message 原样透出，
  别吞成「未知错误」——这句话会告诉使用者去填 key
- **参数错误**（`titles` 不是非空字符串数组）：`BAD_REQUEST`（400），`detail.available` 会列出正确工具名
- 工具内部失败用 `isError`，协议/参数错误用 HTTP 状态码 —— 不要用 200 假装成功
- **结果缓存**：同一批文件名 30 分钟内命中缓存（`GET /api/ai/tools` 的 `caches` 能看到条目数），
  集数解析缓存 24 小时；所以 Agent 反复调用同一批文件不会重复烧钱
- 新增能力：往 `src/api/ai-tools.js` 的 `AI_TOOLS` 加一条 + 在 `callAiTool` 的 switch 接上实现，
  HTTP 与 MCP 两侧**自动都有**
