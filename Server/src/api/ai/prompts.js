/**
 * 提示词加载器 —— 提示词是数据，不是代码
 * ---------------------------------------------------------------------------
 * 两层，越靠前优先级越高：
 *   1. Server/data/prompts.json（用户覆盖，不进 git，改完不用重启：按 mtime 热加载）
 *   2. src/api/ai/prompts.json（出厂默认，进 git，改动可 review）
 * 都读不到就抛错：宁可启动就炸，也别拿空 prompt 去问模型把缓存污染了。
 *
 * 为什么不再把 prompt 写在 .js 里：
 *   · 调一句提示词就要改源码 + 重启，还要跟版本号手动对齐，每次都是「忘了升版本」的坑
 *   · 提示词是配置（不同番、不同模型都可能想换措辞），不是逻辑
 *   · 缓存 key 里带的是提示词内容 hash，所以改文件后新请求自然 miss 旧的
 *
 * 覆盖文件只写想改的那几段即可，例如只改标签提示词：
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

/** 五个能力各自的键（顺序 = 设置页/文档里的展示顺序） */
export const PROMPT_KEYS = ['bundle', 'series', 'format', 'groupTags', 'search']

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'))

const mtimeOf = (file) => {
  try {
    return statSync(file).mtimeMs
  } catch {
    return 0
  }
}

/**
 * 合并：只覆盖给了的段 / 字段，其余回退出厂默认
 * 段内是浅合并（system / custom 各管各的），所以只写 custom 时系统段不会被清空。
 */
function merge(defaults, override) {
  const out = { ...defaults }
  for (const [key, value] of Object.entries(override || {})) {
    if (key.startsWith('$') || !value || typeof value !== 'object') continue
    out[key] = { ...(defaults[key] || {}), ...value }
  }
  return out
}

/**
 * 拼出「实际发给模型」的正文：系统段 + 用户补充段
 * ---------------------------------------------------------------------------
 * 两段的职责不一样，所以分开放、拼一次用：
 *   system  我们的要求（输出 JSON 结构、字段名、禁止事项）。改坏它模型就回不出可用结构，
 *           所以保存时校验字段名，界面上也是只读的
 *   custom  使用者自己的补充（偏好、措辞、额外约束）。写什么都不影响结构，随便改
 * 顺序固定：系统在前、自定义在后 —— 模型对「后出现的指令」更敏感，这符合预期。
 */
export function composePrompt(section) {
  const system = String(section?.system || '').trim()
  const custom = String(section?.custom || '').trim()
  if (!custom) return system
  return `${system}\n\n【用户补充要求】（优先级低于上面的输出格式与字段要求）\n${custom}`
}

/** 用户自定义段的标题（界面上也按这个说法，避免歧义） */
export const CUSTOM_HEADER = '【用户补充要求】'

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

/**
 * 出厂默认的原样内容（不套覆盖）
 * 界面用它做两件事：显示「本段是否被改过」、以及「恢复默认」回到哪。
 * 单独缓存：默认文件在源码里，只有发布新版本才会变。
 */
let defaultCache = { at: -1, value: null }
export function defaultPrompts() {
  const at = mtimeOf(DEFAULT_FILE)
  if (defaultCache.value && defaultCache.at === at) return defaultCache.value
  const value = readJson(DEFAULT_FILE)
  defaultCache = { at, value }
  return value
}

/** 哪几段被覆盖了（系统段或自定义段任一和出厂默认不同）—— 界面据此标「已改」 */
export function customizedKeys() {
  const effective = promptSet()
  const defaults = defaultPrompts()
  return PROMPT_KEYS.filter(
    (key) =>
      composePrompt(effective[key]) !== composePrompt(defaults[key]) ||
      String(effective[key]?.system || '') !== String(defaults[key]?.system || ''),
  )
}

/** 当前提示词来自哪里（default / override / override-invalid: ...）—— 排错和看板用 */
export const promptSource = () => {
  promptSet()
  return cache.source
}

/** 某一段的完整对象（version / system / custom） */
export const promptOf = (key) => promptSet()[key] || {}

/** 某一段的**系统段**原文（不含用户补充；保存校验、界面只读展示用它） */
export const promptSystemOf = (key) => String(promptOf(key).system || '')

/** 某一段的**用户补充**原文（没写就是空串） */
export const promptCustomOf = (key) => String(promptOf(key).custom || '')

/** 实际发给模型的正文（系统段 + 用户补充），调用方只用这个 */
export const promptText = (key) => composePrompt(promptOf(key))

/** 出厂默认的系统段（回退时用：不带任何用户补充） */
export const defaultSystemOf = (key) => String(defaultPrompts()[key]?.system || '')

/** 某一段的版本标记（纯元信息；缓存失效靠内容 hash，不靠它） */
export const promptVersion = (key) => String(promptOf(key).version || '')

/**
 * 提示词内容 hash（12 位）—— 按**实际发给模型的正文**算
 * 缓存 key 里用它：改了系统段或自定义段，key 都变，旧结果自然 miss，
 * 不需要谁去记得「改 prompt 要升版本号」。
 */
export const promptHashOf = (key) =>
  createHash('sha1').update(promptText(key)).digest('hex').slice(0, 12)

/** 组标题提示词要往占位符里填字典（字典是运行时数据，不进 hash） */
export const fillNames = (template, names = []) =>
  String(template || '').replace('{{NAMES}}', names.map((n, i) => `${i + 1}. ${n}`).join('\n'))
