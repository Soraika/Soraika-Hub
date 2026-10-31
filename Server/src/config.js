/**
 * 运行时配置 —— **默认值在这里，实际值以设置页（settings 表）为准**
 * ---------------------------------------------------------------------------
 * 配置只有两层（CONVENTIONS.md §6）：
 *   ① 代码默认值（本文件）—— 新装、没改过的项就用它
 *   ② 设置页（存 DB 的 settings 表）—— 用户在界面上改过的项，启动时覆盖第 ① 层
 *
 * **不读 .env**：AI key / 数据源地址 / worker 参数 / 缓存时长这些全在设置页里改
 * （改完重启对应进程生效）。唯一还看环境变量的是三个**启动参数**（进程起来之前就得知道）：
 *   PORT / DB_FILE / LOG_LEVEL
 * 为什么这样：配置集中在一处，不再出现"到底以 env 为准还是界面为准"的困惑；
 * 而且"导出/导入设置"能把整份配置带走（env 是带不走的）。
 */
import { logger } from './lib/logger.js'

/** 去掉结尾斜杠，避免拼出 `//path` */
const trimSlash = (url) => String(url || '').replace(/\/+$/, '')

export const config = {
  /* ── 启动参数（只有这三个来自环境变量；界面上改不了）── */
  port: Number(process.env.PORT) || 3100,
  dbFile: process.env.DB_FILE || 'data/hub.db',

  /** 首页排期缓存有效期：脏数据容忍度（库里的数据比它新就直接用，不再打上游） */
  cacheTtlMs: 10 * 60 * 1000,
  /** 一季最多入库多少条（按 Mikan 返回顺序截断，防异常数据把首页拉爆） */
  seasonLimit: 300,

  mikan: {
    /**
     * 排期主源（**可配多个**，按顺序故障切换）
     * ---------------------------------------------------------------------------
     * 默认只放**一个**：实测 `mikanani.me` 域名还在但完全不响应（8 秒超时），
     * 把它当"备用"的代价是——主站每抖一次，就要多等 20 秒才报错，
     * 表现就是"首页切季一直转圈 / 打不开"。
     * 想加备用请在设置页自己填（并确认它真的能开）。
     * 外链固定用**第一个**地址 —— 链接要稳定，不能随健康检查漂移。
     */
    bases: ['https://mikanime.tv'],
    timeoutMs: 20000,
  },

  bgm: {
    /** 评分 / 评分人数 / 标签（走镜像，不需要梯子）；同样支持多个地址故障切换 */
    bases: ['https://bgmapi.anibt.net', 'https://api.bgm.tv'],
    token: '',
    userAgent: 'SoraikaHub/0.1 (https://github.com/soraika)',
    timeoutMs: 20000,
  },

  image: {
    /** 出图接口的落盘目录 + 返回给浏览器的缓存时长（**毫秒**，统一口径） */
    dir: 'data/img',
    maxAgeMs: 30 * 24 * 60 * 60 * 1000,
  },

  /**
   * 后台三件事（逐条、节流、可重入）：
   *   ① 补齐：没 bgmId 的 + 有 bgmId 但缺档案的
   *   ② 每日更新：每天固定时刻把当年的番刷一遍
   *   ③ 系列补齐：新作品入库时走一次关系链
   */
  worker: {
    /** 是否跟随 API 服务进程一起跑（默认开，省得再开一个终端）；独立守护用 `npm run worker` 并关掉它 */
    inline: true,
    /** 每条之间的间隔（毫秒）—— 别把 Mikan / Bangumi 打爆 */
    gapMs: 350,
    /** 三个队列都没有任务时的休眠时长（毫秒） */
    idleMs: 30000,
    /** 每日更新的固定时刻（HH:MM，服务器本地时间） */
    dailyAt: '04:00',
    /** 连续几次拿不到 bgmId 就退出补齐队列（Mikan 详情页确实没挂链接的那些） */
    missLimit: 3,
    /** 超限之后隔多久再试一次：万一 Mikan 后来补上了链接，还能自动接上（毫秒，默认 7 天） */
    missRetryMs: 7 * 24 * 60 * 60 * 1000,
    /** 每日更新覆盖的年份（内部固定为当年；保留字段是为了回填任务能复用同一套查询） */
    staleYear: null,
    /**
     * 补档案时**顺手抓一次字幕组**（Mikan 详情页）
     * ---------------------------------------------------------------------------
     * 为什么需要：档案补齐走的是「已有 bgm_id → 只打 Bangumi」的快路径（省一次请求），
     * 而**字幕组只存在于 Mikan 详情页**。不补的话，扫描进来的老番点开面板「资源」区永远空着。
     * 代价：每条多一次 Mikan 请求（当前 ~860 条待补 ≈ 多十几分钟）。
     * 可在设置页关掉（关掉后老番就只能靠打开面板时现取字幕组）。
     */
    fetchSubgroups: true,
  },

  qb: {
    base: '',
    apiKey: '',
    /**
     * 归档根目录与分类
     * ---------------------------------------------------------------------------
     * 新下载一律落到 `{saveRoot}/{番名}/Season 01`（命名规范见 ARCHITECTURE 决策 38）。
     * 这两个是可调项（不是必要项）：不同人 NAS 上的挂载路径不一样，分类名也可能沿用旧的。
     * 老种子在 `/downloads/anime/{番名}/SE01` —— `splitSavePath` 对季目录新旧两种写法都认。
     */
    saveRoot: '/downloads/anime',
    category: 'soraika-hub',
  },

  /**
   * AI 能力（可选功能）—— OpenAI 兼容的 /chat/completions
   * ---------------------------------------------------------------------------
   * 默认按 DeepSeek 配：改 baseUrl + model 就能换成任何兼容网关
   * （OpenAI、Moonshot、本地 Ollama/vLLM 都遵循这套接口）。
   * `enabled` 只看有没有 key：没配 key 不算配置错误（AI 是可选功能），
   * 但相关接口会明确回 AI_DISABLED（501），前端据此显示「未配置」而不是「失败重试」。
   */
  ai: {
    baseUrl: trimSlash('https://api.deepseek.com/v1'),
    apiKey: '',
    /** 只用于界面显示"用的是哪家"（真正生效的是 baseUrl）；目录里的名字或「自定义」 */
    provider: '',
    model: 'deepseek-chat',
    /** 单次调用超时：模型思考慢，比抓网页给得宽 */
    timeoutMs: 60000,
    /** 单次返回上限：标签解析要列一堆标签，集数解析要列每条资源的集数 */
    maxTokens: 4096,
    /** 标签解析的**单批**上限（内部常数：一次 prompt 别太大，超了自动切批） */
    maxTitles: 120,
    /**
     * **并发上限**：同时最多几个模型请求
     * ---------------------------------------------------------------------------
     * 串行在几百条资源时要等几十个来回（太慢），无脑并发又会被上游限流 ——
     * 这是唯一该由使用者调的"速度/限流"旋钮。
     */
    concurrency: 3,
    /** 标签解析结果缓存时长（毫秒）——同一批文件名不重复花钱 */
    tagCacheTtlMs: 30 * 60 * 1000,
    /** 集数解析结果缓存时长（毫秒）：结果基本不变，缓存久一点 */
    episodeCacheTtlMs: 24 * 60 * 60 * 1000,
  },
}

/** AI 是否可用（配了 key 才算可用） */
config.ai.enabled = Boolean(config.ai.apiKey)

/**
 * 代码默认值的快照 —— 设置页「重置为默认」要回落到它，表单里也拿它当 placeholder。
 * 必须在任何设置覆盖（applyValues）之前拍下来，所以在模块求值时就固化一次。
 */
export const defaultConfig = structuredClone(config)

/* ── 启动参数校验（fail-fast）──────────────────────────────────────────────
 * 只有 PORT / DB_FILE 还来自环境变量，所以只校验这两个 —— 其余配置项由设置页负责
 * （保存时按 `lib/settings.js` 的 SETTINGS_FIELDS 校验，非法值整批拒绝）。
 */
if (process.env.PORT !== undefined) {
  const p = Number(process.env.PORT)
  if (!Number.isInteger(p) || p <= 0 || p > 65535) {
    logger.error({ PORT: process.env.PORT, expect: '1–65535 的整数' }, 'config.invalid')
    process.exit(1)
  }
}
if (!config.dbFile) {
  logger.error({ expect: '非空的路径，例如 data/hub.db' }, 'config.invalid DB_FILE')
  process.exit(1)
}

