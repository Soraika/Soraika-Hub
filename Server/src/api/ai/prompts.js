/**
 * 提示词加载器 —— 提示词是**数据**，不是代码
 * ---------------------------------------------------------------------------
 * 三层，越靠前优先级越高：
 *   ① `Server/data/prompts.json`（用户覆盖，**不进 git**，改完**不用重启**：按 mtime 热加载）
 *   ② `src/api/ai/prompts.json`（出厂默认，进 git，改动可 review）
 *   ③ 都读不到 → 抛错（宁可启动就炸，也别拿空 prompt 去问模型把缓存污染了）
 *
 * 为什么不再把 prompt 写在 .js 里：
 *   · 调一句提示词就要改源码 + 重启，还要跟版本号手动对齐 —— 每次都是"忘了升版本"的坑
 *   · 提示词是**配置**（不同番、不同模型都可能想换措辞），不是逻辑
 *   · 缓存 key 里带的是**提示词内容 hash**，所以改文件后新请求自然 miss 旧的、不需要谁去记得升版本
 *
 * 覆盖文件只写你想改的那几段即可，例如只改标签提示词：
 *   { "bundle": { "system": "……新的提示词……" } }
 * 没写的段继续用出厂默认（逐段浅合并）。
 */
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** 出厂默认（进 git） */
export const DEFAULT_FILE = fileURLToPath(new URL('./prompts.json', import.meta.url))
/** 用户覆盖（不进 git；存在即生效） */
export const OVERRIDE_FILE = fileURLToPath(new URL('../../../data/prompts.json', import.meta.url))

/** 四个能力各自的键（顺序 = 设置页/文档里的展示顺序） */
export const PROMPT_KEYS = ['bundle', 'series', 'format', 'groupTags']

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'))

const mtimeOf = (file) => {
  try {
    return statSync(file).mtimeMs
  } catch {
    return 0
  }
}

/** 合并：只覆盖给了的段 / 字段，其余回退出厂默认 */
function merge(defaults, override) {
  const out = { ...defaults }
  for (const [key, value] of Object.entries(override || {})) {
    if (key.startsWith('$') || !value || typeof value !== 'object') continue
    out[key] = { ...(defaults[key] || {}), ...value }
  }
  return out
}

let cache = { at: -1, value: null, source: 'default' }

/**
 * 当前生效的整份提示词（按覆盖文件的 mtime 缓存：没改就不重复读盘）
 * @returns {{ [key: string]: { version: string, system: string } }}
 */
export function promptSet() {
  const at = mtimeOf(OVERRIDE_FILE)
  if (cache.value && cache.at === at) return cache.value

  const defaults = readJson(DEFAULT_FILE)
  let value = defaults
  let source = 'default'
  if (at) {
    try {
      value = merge(defaults, readJson(OVERRIDE_FILE))
      source = 'override'
    } catch (err) {
      // 覆盖文件写坏了不该让整个 AI 挂掉：回退默认，并让调用方在日志里看见
      source = `override-invalid: ${err.message}`
    }
  }
  cache = { at, value, source }
  return value
}

/** 当前提示词来自哪里（`default` / `override` / `override-invalid: ...`）—— 排错/看板用 */
export const promptSource = () => {
  promptSet()
  return cache.source
}

/** 某一段的完整对象 `{ version, system }` */
export const promptOf = (key) => promptSet()[key] || {}

/** 某一段的提示词正文（没配就是空串，调用方自己判断） */
export const promptText = (key) => String(promptOf(key).system || '')

/** 某一段的版本标记（纯元信息；缓存失效靠下面的内容 hash，不靠它） */
export const promptVersion = (key) => String(promptOf(key).version || '')

/**
 * 提示词内容 hash（12 位）
 * 缓存 key 里用它：**改了提示词 → key 变了 → 自然 miss 旧结果**，
 * 不需要谁去记得"改 prompt 要升版本号"。
 */
export const promptHashOf = (key) =>
  createHash('sha1').update(promptText(key)).digest('hex').slice(0, 12)

/** 组标题提示词要往占位符里填字典（字典是运行时数据，不进 hash） */
export const fillNames = (template, names = []) =>
  String(template || '').replace('{{NAMES}}', names.map((n, i) => `${i + 1}. ${n}`).join('\n'))
