/**
 * Mikan → BGM 映射扫描（全量 / 增量）—— mikanId 解析成 bgmId 后写进 anime 表
 * ---------------------------------------------------------------------------
 * 为什么必须预建：BGM 是**单向**的 —— 只能从 Mikan 详情页解析出 bgmId，没有反方向接口；
 * 而系列成员与下载队列需要的正是 `bgmId → mikanId`。项目明确拒绝「按标题猜」（见 api/sources/bgm.js）。
 *
 * 写入规则（CONVENTIONS.md §10.3，改之前先改那份文档）：
 *   · 非 200（404 之类）        → **不写**：页面不存在，纯垃圾行
 *   · 页面在但没挂 Bangumi 链接 → 写 `mikan_id` + `title`，并把 `bgm_miss_count` 顶到上限
 *                                + `bgm_checked_at = now` → 借现有退避机制：不立刻重抓，
 *                                `missRetryHours`（默认 7 天）后自动重试一次
 *   · 解析出 bgmId              → 写 `mikan_id` + `bgm_id` + `title`
 *   · `year` / `season` / `weekday` → **一律留空**：首页 `listBySeason` 与每日刷新靠它们过滤，
 *                                留空才不会把「只有映射的作品」混进排期
 *   · 库里已存在的 mikan_id      → **一个字段都不动**（否则 `bgm_checked_at` 会被重置、推迟它的刷新）
 *   · 新行按 `id % 3` 把 `bgm_checked_at` 往前错开 0/1/2 天 → 避免第 3 天集中到期
 *
 * 增量：扫过的都会进库，所以「库里已有的 mikan_id」天然就是「已扫过」的集合 —— 不需要额外的进度文件。
 *
 * 用法：
 *   npm run sweep                                # 全量跑（已有记录跳过 → 实际只扫新增）
 *   npm run sweep -- --dry-run                   # 只统计不写库
 *   npm run sweep -- --from=4000 --to=4200 --conc=2
 *   npm run sweep -- --limit=100                 # 只跑前 100 个待扫 id
 */
import { pathToFileURL } from 'node:url'
import { getAnimeBangumiId, getAnimeTitle } from '../clients/Mikan.js'
import { config } from '../config.js'
import { db, val } from '../db/index.js'
import { logger } from '../lib/logger.js'

/** 命令行参数：`--key=value` / `--flag`（不引依赖，够用就好） */
const arg = (name, fallback) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? fallback
const flag = (name) => process.argv.includes(`--${name}`)

const stmt = {
  /** 已扫过的（扫到的都进库了，含"没挂链接"的占位行） */
  scannedIds: db.prepare('SELECT mikan_id FROM anime WHERE mikan_id IS NOT NULL'),
  insert: db.prepare(`
    INSERT INTO anime (mikan_id, bgm_id, title, source, bgm_checked_at, bgm_miss_count, created_at, updated_at)
    VALUES (?, ?, ?, 'mikan', ?, ?, ?, ?)
  `),
}

/** 单次请求超时：比客户端的 30s 短 —— 这里要的是「快速失败、接着扫下一个」 */
const DEFAULT_TIMEOUT_MS = 12000

/**
 * 跑一次扫描
 * @param {{ from?:number, to?:number, conc?:number, limit?:number, dryRun?:boolean,
 *           timeoutMs?:number, log?:object }} [options]
 */
export async function runSweep(options = {}) {
  const from = Number(options.from ?? 1)
  const to = Number(options.to ?? 5400)
  const conc = Math.max(1, Number(options.conc ?? 4))
  const limit = Number(options.limit ?? 0)
  const dryRun = Boolean(options.dryRun)
  /** 单次请求超时：比客户端的 30s 短 —— 这里要的是「快速失败、接着扫下一个」 */
  const timeoutMs = Number(options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  /** 连续多少个空页就提前收工（**只在"已经找到过有效条目"之后生效**，否则低 id 段会一上来就停） */
  const stopAfterEmpty = Math.max(10, Number(options.stopAfterEmpty ?? 300))
  const log = options.log ?? logger

  const scanned = new Set(stmt.scannedIds.all().map((r) => String(r.mikan_id)))
  const all = []
  for (let id = from; id <= to; id++) if (!scanned.has(String(id))) all.push(id)
  const targets = limit > 0 ? all.slice(0, limit) : all

  const stat = { from, to, conc, dryRun, stopAfterEmpty, rangeIds: to - from + 1, skipped: to - from + 1 - all.length, targets: targets.length, ok: 0, noLink: 0, notFound: 0, failed: 0, inserted: 0, consecutiveEmpty: 0, stoppedEarly: false }
  log.info(stat, 'sweep.start')
  if (!targets.length) return { ...stat, samples: [] }

  const now = Date.now()
  const samples = []
  let cursor = 0
  let done = 0
  const startedAt = Date.now()

  /** 空页计数：连着太多个就认为到了有效区间的尾巴（见 stopAfterEmpty 的说明） */
  const noteEmpty = () => {
    stat.consecutiveEmpty++
    if (stat.ok > 0 && stat.consecutiveEmpty >= stopAfterEmpty) stat.stoppedEarly = true
  }

  async function one(id) {
    let res
    try {
      res = await fetch(`${config.mikan.base}/Home/Bangumi/${id}`, { signal: AbortSignal.timeout(timeoutMs) })
    } catch (err) {
      // 网络/超时：这次不写库（否则会把"暂时拿不到"记成"没有链接"），下次重跑会再试
      stat.failed++
      log.warn({ mikanId: id, err: err.message }, 'sweep.fetch fail')
      return
    }
    if (res.status !== 200) {
      stat.notFound++
      noteEmpty()
      return // 页面不存在：不写库
    }

    const html = await res.text()
    // quiet：批量扫描时「没挂 bgm 链接」是预期结果，不要为它刷 warn（老番很多都没挂）
    const bgmId = getAnimeBangumiId(html, { quiet: true })?.bangumiId ?? null
    const title = getAnimeTitle(html)
    // 连标题都取不到 → 这不是番剧详情页（多半是跳回首页/空页）→ 和 404 一样**不写库**
    // （否则库里会出现一堆 title = mikan:470 这种假行，既没名字也没链接）
    if (!title && !bgmId) {
      stat.notFound++
      noteEmpty()
      return
    }
    stat.consecutiveEmpty = 0 // 这是个真实条目（有没有挂 BGM 链接另说）

    if (bgmId) {
      stat.ok++
      if (samples.length < 5) samples.push({ mikanId: id, bgmId, title })
    } else {
      stat.noLink++
    }
    if (dryRun) return

    // 写库：多进程环境下（用户开着 npm run dev → 内联 worker 也在写）可能出现 SQLITE_BUSY。
    // busy_timeout（db/index.js）已经会等 5s，这里再兜一层重试，避免一条失败就把整轮打断。
    for (let attempt = 0; ; attempt++) {
      try {
        stmt.insert.run(
          val(String(id)),
          val(bgmId),
          val(title || `mikan:${id}`), // 有 bgmId 却没标题的极少数情况：用 mikan:<id> 兜底，别丢数据
          now - (id % 3) * 86400000, // 错开 0/1/2 天，避免集中到期
          bgmId ? 0 : config.worker.missLimit, // 没链接的顶到上限 → 交给退避机制，7 天后才重试
          now,
          now,
        )
        stat.inserted++
        break
      } catch (err) {
        if (attempt >= 4) {
          stat.failed++
          log.error({ mikanId: id, attempts: attempt + 1, err: err.message }, 'sweep.insert fail')
          break
        }
        await new Promise((r) => setTimeout(r, 300 * (attempt + 1)))
      }
    }
  }

  async function worker() {
    while (cursor < targets.length && !stat.stoppedEarly) {
      const id = targets[cursor++]
      await one(id)
      done++
      if (done % 200 === 0) {
        const per = (Date.now() - startedAt) / done
        log.info(
          { done, total: targets.length, ok: stat.ok, noLink: stat.noLink, inserted: stat.inserted, msPerItem: Math.round(per), etaSec: Math.round(((targets.length - done) * per) / 1000) },
          'sweep.progress',
        )
      }
    }
  }

  await Promise.all(Array.from({ length: conc }, worker))
  const seconds = Math.round((Date.now() - startedAt) / 1000)
  const result = { ...stat, seconds, samples }
  log.info(result, 'sweep.done')
  return result
}

/* ── CLI（npm run sweep）─────────────────────────────────────────────────── */
const isCli = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url
if (isCli) {
  await runSweep({
    from: arg('from', 1),
    to: arg('to', 5400),
    conc: arg('conc', 4),
    limit: arg('limit', 0),
    timeoutMs: arg('timeout', DEFAULT_TIMEOUT_MS),
    stopAfterEmpty: arg('stop-after-empty', 300),
    dryRun: flag('dry-run'),
  })
}
