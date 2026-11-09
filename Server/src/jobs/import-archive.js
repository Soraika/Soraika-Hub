/**
 * 用 Bangumi 离线 dump 批量补齐档案（评分 / 评分人数 / 标签 / 简介 / 放送日 / 总集数）
 * ---------------------------------------------------------------------------
 * 数据来自 github.com/bangumi/Archive（每周三 05:00 GMT+8 导一次全站）。
 * 它跟 `jobs/enrich.js` 干的是同一件事，但**一条上游请求都不发**：
 *   · enrich：逐条打 Bangumi（按 id 单查）→ 慢、会被限流，适合每天补几条新番
 *   · 这里：本地流式扫 1.3GB jsonlines → 几千条老番几十秒补齐
 * 两者互补：新番靠 enrich（当天就要准确），老番靠 dump 一次性刷干净。
 *
 * 只补**库里已有 bgm_id** 的行：dump 是全站（漫画 / 游戏 / 三次元都有），
 * 没理由把整站搬进库里 —— 主表的入口仍然是 Mikan 排期（铁律：主表只由排期落）。
 *
 * 用法（先把 zip 解压，随便解到哪；目录里应当有 subject.jsonlines / episode.jsonlines）：
 *   npm run archive -- --dir="C:/Users/xxx/Downloads/dump-2026-11-03.210402Z"
 *   npm run archive -- --dir=... --dry-run        # 只统计，不写库
 *   npm run archive -- --dir=... --only-missing   # 只补空字段（不动已有值）
 *   npm run archive -- --dir=... --no-checked     # 不改 bgm_checked_at（下次仍会被 enrich 扫到）
 *
 * 只给 zip 路径也行：Windows「全部解压缩」默认解到同名文件夹，脚本会自己找过去。
 */
import { existsSync, statSync } from 'node:fs'
import { createReadStream } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { applyArchiveBatch, listBgmTargets, stats } from '../db/anime.js'
import { upsertSubjects } from '../db/subject.js'
import { DUMP_FILES, archivePatch, leadingId, readJsonLinesFrom } from '../lib/bgm-archive.js'
import { logger } from '../lib/logger.js'
import { listZipEntries, openZipEntry } from '../lib/unzip.js'

/** 一个事务写多少行（几百条足够摊平事务开销，也不会长时间占着写锁） */
const BATCH_SIZE = 500

const hasDumpFiles = (dir) => Object.values(DUMP_FILES).every((file) => existsSync(join(dir, file)))

/**
 * 把 `--dir` / `--zip` 归一成「一个能取到两个 jsonlines 的来源」
 * ---------------------------------------------------------------------------
 * 三种写法都认：
 *   · 解压后的目录（里面直接就是 subject.jsonlines / episode.jsonlines）
 *   · 目录名再套一层（解压工具有时会造一层同名文件夹）
 *   · zip 本身 —— **不用解压**，直接从中央目录取两个条目流式读（省 1.3GB 磁盘）
 * @param {string} input
 * @returns {{ kind: 'dir', dir: string } | { kind: 'zip', file: string, entries: Array<object> } | null}
 */
export function resolveDumpSource(input) {
  if (!input) return null
  const path = resolve(input)
  if (!existsSync(path)) return null

  if (statSync(path).isDirectory()) return hasDumpFiles(path) ? { kind: 'dir', dir: path } : null

  // zip：先看条目齐不齐（3ms），齐就直接用，不要求旁边有解压目录
  try {
    const entries = listZipEntries(path)
    const names = entries.map((entry) => entry.name)
    const ok = Object.values(DUMP_FILES).every((file) => names.some((name) => name === file || name.endsWith(`/${file}`)))
    return ok ? { kind: 'zip', file: path, entries } : null
  } catch {
    return null
  }
}

/** 取一个条目的可读流（目录 → 文件流；zip → inflate 流） */
const openEntry = (source, name) =>
  source.kind === 'zip'
    ? openZipEntry(source.file, name, source.entries)
    : createReadStream(join(source.dir, name), { encoding: 'utf8' })

const emptyResult = (before) => ({
  before,
  after: before,
  matched: 0,
  patched: 0,
  skipped: 0,
  episodes: 0,
  badLines: 0,
  missingInDump: 0,
  ms: 0,
})

/**
 * 跑一次导入
 * @param {object} options
 * @param {string} options.dir dump 目录（或 zip 路径）
 * @param {boolean} [options.onlyMissing] 只补空字段（已有 score/tags/summary 的不动）
 * @param {boolean} [options.dryRun] 只统计不写库
 * @param {boolean} [options.markChecked] 是否把 `bgm_checked_at` 刷成现在（默认 true）
 * @param {object} [options.log]
 */
export async function runArchiveImport({
  dir,
  onlyMissing = false,
  dryRun = false,
  markChecked = true,
  log = logger,
} = {}) {
  const startedAt = Date.now()
  const source = resolveDumpSource(dir)
  if (!source) {
    const err = new Error(
      `没找到 dump：${dir || '(未给 --dir / --zip)'}\n` +
        '  可以给：解压后的目录（含 subject.jsonlines + episode.jsonlines），\n' +
        '  或者直接给 .zip（脚本自己流式解压，不需要先解压出来）。',
    )
    err.code = 'BAD_DUMP'
    throw err
  }

  const before = stats()
  const targets = new Map(listBgmTargets().map((row) => [String(row.bgm_id), row]))
  /** 章节按数字 id 查 —— 字符串比较会踩前导零/类型不一致的坑 */
  const wantedIds = new Set()
  for (const row of targets.values()) {
    const id = Number(row.bgm_id)
    if (Number.isFinite(id)) wantedIds.add(id)
  }

  log.info({ source: source.kind === 'zip' ? source.file : source.dir, targets: targets.size, onlyMissing, dryRun }, 'archive.start')
  if (!targets.size) return { ...emptyResult(before), dir: dir, ms: Date.now() - startedAt }

  /* ① 章节数：type 0 = 正篇（特别篇 / OP / ED 不算），数出来就是总集数 */
  const episodeCounts = new Map()
  const epStats = await readJsonLinesFrom(
    openEntry(source, DUMP_FILES.episode),
    (line) => {
      const match = /"subject_id":(\d+)/.exec(line)
      if (!match) return
      const subjectId = Number(match[1])
      if (!wantedIds.has(subjectId)) return
      // `"type":0` 后面紧跟 `,` 或 `}`，避免把 10 / 0.5 之类误当正篇
      if (!/"type":0[,}]/.test(line)) return
      episodeCounts.set(subjectId, (episodeCounts.get(subjectId) || 0) + 1)
    },
    { raw: true },
  )

  /* ② 档案字段：先按行首 id 筛，命中的才 JSON.parse（60 万行里只有几千行要解析） */
  const result = { ...emptyResult(before), dir }
  let batch = []
  /** 同一批也写进 `bgm_subject`（档案表）：anime 留给排期/展示，档案可整表重灌 */
  let subjectBatch = []
  const flush = () => {
    if (!batch.length) return
    if (!dryRun) {
      applyArchiveBatch(batch, { checkedAt: markChecked ? Date.now() : null })
      upsertSubjects(subjectBatch)
    }
    result.patched += batch.length
    result.subjects = (result.subjects || 0) + subjectBatch.length
    batch = []
    subjectBatch = []
  }

  const subStats = await readJsonLinesFrom(
    openEntry(source, DUMP_FILES.subject),
    (line) => {
      let id = leadingId(line)
      let subject = null
      if (id == null) {
        // 行首不是 id（dump 换了字段顺序）→ 兜底整行解析，宁可慢也别静默漏数据
        try {
          subject = JSON.parse(line)
        } catch {
          result.badLines++
          return
        }
        id = Number(subject?.id)
      }
      if (!Number.isFinite(id)) return
      const target = targets.get(String(id))
      if (!target) return
      result.matched++

      if (onlyMissing && target.score != null && target.tags != null && target.summary != null) {
        result.skipped++
        return
      }
      if (!subject) subject = JSON.parse(line)
      const patch = archivePatch(subject, { episodes: episodeCounts.get(id) ?? null })
      batch.push({ id: target.id, ...patch })
      subjectBatch.push({
        bgm_id: target.bgm_id,
        title_bgm: patch.title_cn,
        title_bgm_origin: patch.title_bgm_origin,
        summary: patch.summary,
        score: patch.score,
        rating_total: patch.rating_total,
        tags: patch.tags,
        watching: patch.watching,
        platform: patch.platform,
        first_air_date: patch.air_date,
        total_episodes: patch.total_episodes,
        source: 'dump',
      })
      if (batch.length >= BATCH_SIZE) flush()
    },
    { raw: true },
  )
  flush()

  result.episodes = episodeCounts.size
  result.missingInDump = targets.size - result.matched
  result.badLines += epStats.bad + subStats.bad
  result.after = stats()
  result.ms = Date.now() - startedAt

  log.info(
    {
      source: source.kind === 'zip' ? source.file : source.dir,
      matched: result.matched,
      patched: result.patched,
      skipped: result.skipped,
      missingInDump: result.missingInDump,
      withEpisodes: result.episodes,
      needArchive: `${before.needArchive} → ${result.after.needArchive}`,
      withScore: `${before.withScore} → ${result.after.withScore}`,
      ms: result.ms,
    },
    dryRun ? 'archive.dry-run' : 'archive.done',
  )
  if (result.episodes === 0) {
    log.warn({ source: source.kind === 'zip' ? source.file : source.dir }, 'archive.no-episodes 没数到任何正篇 —— 检查 dump 版本/文件名')
  }
  return result
}

// ── 直接执行时作为 CLI 运行（npm run archive）────────────────────────────────
const isCli = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url
if (isCli) {
  const arg = (name) =>
    process.argv
      .find((a) => a.startsWith(`--${name}=`))
      ?.split('=')
      .slice(1)
      .join('=')
      // cmd.exe 有时会把引号原样递进来（`--dir="C:/x"`）—— 去一层，省得用户困惑
      .replace(/^"+|"+$/g, '')
  const flag = (name) => process.argv.includes(`--${name}`)
  try {
    if (flag('latest')) {
      // 自动模式：查索引 → 有新版才下载 → 流式解压导入（见 jobs/dump-update.js）
      const { updateDump } = await import('./dump-update.js')
      await updateDump({ force: flag('force'), keepZip: flag('keep-zip'), dryRun: flag('dry-run') })
    } else {
      await runArchiveImport({
        dir: arg('dir') || arg('zip'),
        onlyMissing: flag('only-missing'),
        dryRun: flag('dry-run'),
        markChecked: !flag('no-checked'),
      })
    }
  } catch (err) {
    logger.error({ err: err.message }, 'archive.fail')
    process.exitCode = 1
  }
}
