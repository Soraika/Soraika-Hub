/**
 * AI 能力的对外协议清单 —— HTTP 与 MCP 共用同一份定义
 * ---------------------------------------------------------------------------
 * 为什么单独一个文件：以后把 AI 能力挂到 MCP server（或别的 Agent 框架）时，
 * 只需读这份清单生成 tools/list，再按 name 调 callAiTool —— 不用把路由与参数校验抄一遍。
 * 清单形状刻意按 MCP 的 `tools/list` 写（name / description / inputSchema），转换基本为零。
 *
 * 加新能力只需两步：AI_TOOLS 里加一条 + callAiTool 的 switch 接上实现 ——
 * HTTP（POST /api/ai/call）与未来的 MCP 两侧自动都有。
 */
import { fail } from '../lib/errors.js'
import { logger } from '../lib/logger.js'
import { classifyEpisodes, classifyReleaseTags } from './pages/ai.js'

/** 统一的入参收敛：titles 必须是非空字符串数组（对外入口校验一次，能力层就不必重复判断） */
function normalizeTitles(value) {
  if (!Array.isArray(value)) throw fail('BAD_REQUEST', 'titles 需要是字符串数组')
  const list = value.map((t) => String(t || '').trim()).filter(Boolean)
  if (!list.length) throw fail('BAD_REQUEST', 'titles 不能为空')
  return list
}

export const AI_TOOLS = [
  {
    name: 'anime_release_tags',
    description:
      '解析番剧资源文件名，产出可点的筛选标签（分辨率 / 编码 / 字幕 / 片源）。每个标签带 match 写法，前端按「标题包含 match」过滤资源',
    inputSchema: {
      type: 'object',
      properties: {
        titles: {
          type: 'array',
          items: { type: 'string' },
          description: '资源文件名列表，例如 ["[LoliHouse] 番名 - 01 [1080P][简繁]"]',
        },
        animeTitle: { type: 'string', description: '作品标题（帮助模型分清字幕组名 / 片源 / 番名）' },
        season: { type: 'string', description: '季（如「秋」或 2），同样用于消歧' },
      },
      required: ['titles'],
      additionalProperties: false,
    },
  },
  {
    name: 'anime_episode_meta',
    description: '解析番剧资源文件名，产出纯番名 / 季数 / 每条资源的集数（合集给范围串），供下载重命名使用',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '作品标题（面板上的番名，帮助判断季数）' },
        season: { type: 'string', description: '季（如「秋」或 2）' },
        titles: { type: 'array', items: { type: 'string' }, description: '资源文件名列表' },
      },
      required: ['titles'],
      additionalProperties: false,
    },
  },
]

/**
 * 按工具名执行（HTTP 与 MCP 的唯一分发点）
 * @param {string} name 工具名（AI_TOOLS 里的 name）
 * @param {object} args 入参（形状见对应 inputSchema）
 * @param {{ log?: object }} [options]
 */
export async function callAiTool(name, args = {}, { log = logger } = {}) {
  const tool = AI_TOOLS.find((t) => t.name === name)
  if (!tool) {
    throw fail('NOT_FOUND', `没有名为 ${name} 的 AI 工具`, { available: AI_TOOLS.map((t) => t.name) })
  }

  switch (name) {
    case 'anime_release_tags':
      return classifyReleaseTags(normalizeTitles(args.titles), {
        log,
        animeTitle: String(args.animeTitle || ''),
        season: args.season ?? '',
      })
    case 'anime_episode_meta':
      return classifyEpisodes(args.title, normalizeTitles(args.titles), {
        log,
        season: args.season ?? '',
      })
    default:
      // 清单加了但忘了接实现时，错误要指出来是哪一条
      throw fail('INTERNAL', `工具 ${name} 还没有接上实现`)
  }
}
