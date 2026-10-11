/**
 * 运行时配置 —— 全部从环境变量读，代码里不写死地址与密钥
 * ---------------------------------------------------------------------------
 * 启动方式：`node --env-file-if-exists=.env src/index.js`（Node 22+ 内置，无需 dotenv）
 * 数据源地址都做成可配置：换镜像 / 换回官方 / 挂反代都不用改代码，
 * 以后「设置页 → 数据源设置」直接写这两个值即可。
 *
 * 边界：**加载时即校验**（fail-fast）。写错了就在启动那一刻报「哪个变量、期望什么、实际什么」
 * 并退出，绝不用默认值把错误吞掉 —— 否则会因为一个拼错的时间格式静默跑错一整天。
 */
import { logger } from './lib/logger.js'

/** 环境变量转数字；非法或缺失时用默认值 */
function num(value, fallback) {
  const n = Number(value)
  return value === undefined || value === null || value === '' || Number.isNaN(n) ? fallback : n
}

/** 去掉结尾斜杠，避免拼出 `//path` */
const trimSlash = (url) => String(url || '').replace(/\/+$/, '')

export const config = {
  port: num(process.env.PORT, 3100),
  dbFile: process.env.DB_FILE || 'data/hub.db',
  /** 首页排期缓存有效期：脏数据容忍度（库里的数据比它新就直接用，不再打上游） */
  cacheTtlMs: num(process.env.CACHE_TTL_MS, 10 * 60 * 1000),
  /** 一季最多入库多少条（按 Mikan 返回顺序截断，防异常数据把首页拉爆） */
  seasonLimit: num(process.env.SEASON_LIMIT, 300),

  mikan: {
    /** 排期主源 */
    base: trimSlash(process.env.MIKAN_BASE_URL || 'https://mikanime.tv'),
    timeoutMs: num(process.env.MIKAN_TIMEOUT_MS, 20000),
  },

  bgm: {
    /** 评分 / 评分人数 / 标签 */
    base: trimSlash(process.env.BGM_API_BASE || 'https://bgmapi.anibt.net'),
    token: process.env.BGM_TOKEN || '',
    userAgent: process.env.BGM_USER_AGENT || 'SoraikaHub/0.1 (https://github.com/soraika)',
    timeoutMs: num(process.env.BGM_TIMEOUT_MS, 20000),
  },

  image: {
    /** 出图接口的落盘目录 + 返回给浏览器的缓存时长 */
    dir: process.env.IMAGE_CACHE_DIR || 'data/img',
    maxAgeSec: num(process.env.IMAGE_MAX_AGE_SEC, 30 * 24 * 60 * 60),
  },

  /**
   * 两个独立触发（都是逐条、节流、可重入）：
   *   ① 补齐队列：bgm_id IS NULL（不限季）—— 把没映射过的作品补上档案
   *   ② 每日更新：**每天固定时刻**（默认 04:00）开始把今年的番刷一遍整份档案，
   *      到点后按 gapMs 一条条慢慢跑，跑完就等第二天同一时刻
   */
  worker: {
    /** 是否跟随 API 服务进程一起跑（默认开，省得再开一个终端）；独立守护用 `npm run worker` 并把这里设 0 */
    inline: process.env.WORKER_INLINE !== '0',
    /** 每条之间的间隔（毫秒）—— 别把 Mikan / Bangumi 打爆 */
    gapMs: num(process.env.WORKER_GAP_MS, 350),
    /** 两个队列都没有任务时的休眠时长（毫秒） */
    idleMs: num(process.env.WORKER_IDLE_MS, 30000),
    /**
     * 每日更新的固定时刻（HH:MM，服务器本地时间）
     * 语义：到了这个点之后，「上次刷新早于该时刻」的今年番剧就全部算过期，
     * 由 worker 逐条刷到天亮；第二天同一时刻再算一次。中途重启也没关系 ——
     * 分界线就是「今天/昨天的这个时刻」，不依赖进程内状态。
     */
    dailyAt: process.env.WORKER_DAILY_AT || '04:00',
    /**
     * 连续几次拿不到 bgmId 就退出补齐队列。
     * 有些番 Mikan 详情页确实没挂 Bangumi 链接（bgm_id 永远是 NULL），
     * 反复重试只会白打上游、把队列卡住 —— 超限后改成下面这个周期再试。
     */
    missLimit: num(process.env.WORKER_MISS_LIMIT, 3),
    /** 超限之后隔多久再试一次（小时）：万一 Mikan 后来补上了链接，还能自动接上 */
    missRetryHours: num(process.env.WORKER_MISS_RETRY_HOURS, 168),
    /** 每日更新覆盖的年份（不填 = 当年。填 0 表示不限年份，谨慎：会遍历全库） */
    staleYear: process.env.WORKER_STALE_YEAR === undefined ? null : num(process.env.WORKER_STALE_YEAR, null),
  },
  qb: {
    base: trimSlash(process.env.QB_BASE_URL || ''),
    apiKey: process.env.QB_API_KEY || '',
  },

  /**
   * AI 能力（可选功能）—— OpenAI 兼容的 /chat/completions
   * ---------------------------------------------------------------------------
   * 默认按 DeepSeek 配（旧版就用它）：改 baseUrl + model 就能换成任何兼容网关
   * （OpenAI、Moonshot、本地 Ollama/vLLM 都遵循这套接口）。
   * `enabled` 只看有没有 key：没配 key 不算配置错误（AI 是可选功能），
   * 但相关接口会明确回 AI_DISABLED（501），前端据此显示「未配置」而不是「失败重试」。
   */
  ai: {
    baseUrl: trimSlash(process.env.AI_BASE_URL || 'https://api.deepseek.com/v1'),
    apiKey: process.env.AI_API_KEY || '',
    model: process.env.AI_MODEL || 'deepseek-chat',
    /** 单次调用超时：模型思考慢，比抓网页给得宽 */
    timeoutMs: num(process.env.AI_TIMEOUT_MS, 60000),
    /** 单次返回上限：标签解析要列一堆标签，集数解析要列每条资源的集数 */
    maxTokens: num(process.env.AI_MAX_TOKENS, 4096),
    /** 一次任务里最多分析多少条文件名（超出的截断，别把 prompt 撑爆） */
    maxTitles: num(process.env.AI_MAX_TITLES, 120),
    /** 标签解析结果缓存时长（毫秒）——同一批文件名不重复花钱 */
    tagCacheTtlMs: num(process.env.AI_TAG_CACHE_TTL_MS, 30 * 60 * 1000),
    /** 集数解析结果缓存时长（毫秒）：结果基本不变，缓存久一点 */
    episodeCacheTtlMs: num(process.env.AI_EPISODE_CACHE_TTL_MS, 24 * 60 * 60 * 1000),
  },
}

/** AI 是否可用（配了 key 才算可用） */
config.ai.enabled = Boolean(config.ai.apiKey)

/**
 * .env（+ 代码默认值）的原始快照 —— 设置页「重置为默认」要回落到它
 * 必须在任何设置覆盖（applyValues）之前拍下来，所以在模块求值时就固化一次。
 */
export const envConfig = structuredClone(config)

/* ── 启动校验（fail-fast） ──────────────────────────────────────────────────
 * 只看「用户真的设置了」的 env：没设置的用默认值，默认值本身是合法的。
 * 这样既不会把 `WORKER_GAP_MS=abc` 之类静默吞掉，也不会因为没配 .env 就报错。
 */
const isPosInt = (v) => /^\d+$/.test(v) && Number(v) > 0
const isNonNegNum = (v) => Number.isFinite(Number(v)) && Number(v) >= 0
const isHttpUrl = (v) => {
  try {
    const url = new URL(v)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

/** @returns {Array<{ key: string, value: string, expect: string }>} */
function findConfigProblems() {
  const problems = []
  const check = (key, ok, expect) => {
    const value = process.env[key]
    if (value === undefined || value === '') return
    if (!ok(value)) problems.push({ key, value, expect })
  }

  check('PORT', (v) => isPosInt(v) && Number(v) <= 65535, '1–65535 的整数')
  check('CACHE_TTL_MS', isPosInt, '正整数（毫秒）')
  check('SEASON_LIMIT', isPosInt, '正整数')
  check('MIKAN_BASE_URL', isHttpUrl, 'http(s):// 开头的完整地址')
  check('BGM_API_BASE', isHttpUrl, 'http(s):// 开头的完整地址')
  check('BGM_TIMEOUT_MS', isPosInt, '正整数（毫秒）')
  check('IMAGE_MAX_AGE_SEC', isNonNegNum, '≥0 的数（秒）')
  check('WORKER_INLINE', (v) => v === '0' || v === '1', '0 或 1')
  check('WORKER_GAP_MS', isPosInt, '正整数（毫秒）')
  check('WORKER_IDLE_MS', isPosInt, '正整数（毫秒）')
  check('WORKER_DAILY_AT', (v) => /^([01]?\d|2[0-3]):[0-5]\d$/.test(v), 'HH:MM（24 小时制），例如 04:00')
  check('WORKER_STALE_YEAR', (v) => v === '0' || /^\d{4}$/.test(v), '4 位年份，或 0 表示不限年份')
  check('WORKER_MISS_LIMIT', (v) => isPosInt(v) && Number(v) >= 1, '≥1 的整数')
  check('WORKER_MISS_RETRY_HOURS', isNonNegNum, '≥0 的数（小时）')
  check('AI_BASE_URL', isHttpUrl, 'http(s):// 开头的完整地址（OpenAI 兼容网关，要带 /v1）')
  check('AI_TIMEOUT_MS', isPosInt, '正整数（毫秒）')
  check('AI_MAX_TOKENS', isPosInt, '正整数')
  check('AI_MAX_TITLES', isPosInt, '正整数')
  check('AI_TAG_CACHE_TTL_MS', isPosInt, '正整数（毫秒）')
  check('AI_EPISODE_CACHE_TTL_MS', isPosInt, '正整数（毫秒）')

  return problems
}

const problems = findConfigProblems()
if (problems.length > 0) {
  logger.error({ problems }, 'config.invalid')
  process.exit(1)
}

