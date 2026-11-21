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
import { applyArchiveBatch, clearSeriesChecked, listBgmTargets, stats } from './../db/anime.js'
import { clearRelationEdges, clearRelations, insertRelations, insertStubs, markStubRelationsChecked } from './../db/relation.js'
import { clearTags, setCatalogEpisodes, upsertFullSubjects, upsertSubjects } from './../db/subject.js'
import {
  DUMP_FILES,
  RELATION_FILE,
  RELATION_TYPES_KEPT,
  archivePatch,
  fullSubjectRow,
  leadingId,
  readJsonLinesFrom,
  tagRowsOf,
} from './../domain/bgm-archive.js'
import { logger } from './../lib/logger.js'
import { listZipEntries, openZipEntry } from './../lib/unzip.js'

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
  /** 写进 bgm_relation 的关系行数（只留系列链用得着的类型） */
  relations: 0,
  /** 写进 bgm_stub 的「链上条目」数（名字 / 类型 / 日期） */
  stubs: 0,
  /** 写进 bgm_subject 的**完整档案**行数（全站动画，供 MCP / 推荐用） */
  archiveRows: 0,
  /** 写进 bgm_tag 的标签倒排行数 */
  tagRows: 0,
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
  resetSeries = true,
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

  /**
   * 全站动画 id（type=2）。关系表要用它做「两端都是动画」的过滤 ——
   * 这是系列链能完整的关键：以前只留「有一端在库」的边，链中间那几跳被整段丢掉。
   */
  const animeIds = new Set()

  log.info({ source: source.kind === 'zip' ? source.file : source.dir, targets: targets.size, onlyMissing, dryRun }, 'archive.start')
  /* 库里一条 bgm_id 都没有也要继续：索引与关系表是**全站**的，与库里有几条无关 */
  if (!targets.size) log.warn({}, 'archive.no-targets 库里没有 bgm_id，只导索引与关系表')

  /** 统计收口（关系 / 章节 / 档案三趟都写它） */
  const result = { ...emptyResult(before), dir }

  /* 关系表在不在，决定这一趟是不是「整表重灌」 */
  const relationFileAvailable =
    source.kind === 'zip'
      ? source.entries.some((entry) => entry.name === RELATION_FILE || entry.name.endsWith(`/${RELATION_FILE}`))
      : existsSync(join(source.dir, RELATION_FILE))

  /* 整表重灌：关系边 + 名字索引都清掉重来。
     **必须在第一趟之前**做 —— 档案段会重新填满 `bgm_stub`（全站动画名字索引），
     关系段如果那时才清就会把索引一起清空（曾经踩过：stub 的 type/name 全成 NULL）。
     只在 dump **带着关系表**时才清：老 dump 没有这张表时不该把已有关系抹掉。 */
  if (!dryRun && relationFileAvailable) clearRelations()

  /* ① 档案 + 全站动画库（一趟扫完）
     -----------------------------------------------------------------
     这一趟做五件事：
       a. 全站 type=2 一律算「动画」，收进 `animeIds`（关系表过滤要用）
       b. **每部动画都写一条完整档案进 `bgm_subject`**（简介 / 标签全量 / 评分分布 /
          收藏数 / 排名 / staff / 别名 / infobox 原文）
       c. 标签倒排进 `bgm_tag`（只留出现次数够的，噪音标签对推荐没意义）
       d. 名字索引进 `bgm_stub`（关系链与下载页认作品用）
       e. 库里已有的行记进 `pendingLibrary` —— 章节数要等下一趟才有，不能立刻写

     为什么 b 从「只补库里那几千条」改成「全站都写」
     -----------------------------------------------------------------
     用户要的是「agent 能更高效地推荐番剧」，而推荐的本质是**在全集里筛**：
     只知道库里有什么，就只能推荐已有的；全站 31312 部动画在手，
     才能回答「评分 8 分以上的机战原创」「跟这部同一个动画公司的」这类问题。
     代价实测很小（文本约 40MB、导入多几秒），换来的是推荐 / 搜索 / 相似度全部离线。
     注意：这**不影响** `anime` 表「主表只由排期落」的铁律 —— 档案表多几万行不打扰排期。 */
  let fullBatch = []
  let tagBatch = []
  let stubBatch = []
  /** 库里已有 bgm_id 的行：dump 记录先留着，等章节数出来再一起写 */
  const pendingLibrary = []

  const flushFull = () => {
    if (!fullBatch.length) return
    if (!dryRun) upsertFullSubjects(fullBatch, tagBatch, { onlyMissing })
    result.archiveRows += fullBatch.length
    result.tagRows += tagBatch.length
    fullBatch = []
    tagBatch = []
  }
  const flushStubs = () => {
    if (!stubBatch.length) return
    if (!dryRun) {
      insertStubs(stubBatch)
      // 这批 id 的关系已经由「全站关系表」给出答案（哪怕一行都没有）→ 以后不再打上游
      markStubRelationsChecked(stubBatch.map((row) => row.bgmId))
    }
    result.stubs += stubBatch.length
    stubBatch = []
  }

  /* 标签倒排整表重灌：每部动画都会把标签写回来，先清掉旧行才不会留下「已下架番的标签」 */
  if (!dryRun) clearTags()

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

      /* 全站动画（type=2）一律收 —— 不看它在不在库里。
         行首那一段就带着 type，先用正则判，只有命中的才 JSON.parse（1002MB 里绝大多数不是动画）。
         允许冒号/逗号两侧有空格：真实 dump 是紧凑写法（`"type":2,`），但
         `JSON.stringify` 造出来的测试数据是 `"type": 2,` —— 两条都得认，
         否则「自己造的 dump 能过、别处的 dump 导不进索引」这种坑只会在线上发现。 */
      const isAnime = /"type"\s*:\s*2\s*[,}]/.test(line.slice(0, 48))
      if (isAnime) {
        animeIds.add(id)
        if (!subject) {
          try {
            subject = JSON.parse(line)
          } catch {
            result.badLines++
            subject = null
          }
        }
        if (subject) {
          const full = fullSubjectRow(subject)
          if (full) {
            fullBatch.push(full)
            tagBatch.push(...tagRowsOf(full))
            if (fullBatch.length >= BATCH_SIZE) flushFull()
          }
          stubBatch.push({
            bgmId: String(id),
            type: 2,
            name: subject.name || null,
            nameCn: subject.name_cn || null,
            date: subject.date || null,
          })
          if (stubBatch.length >= BATCH_SIZE) flushStubs()
        }
      }
      if (!target) return
      result.matched++

      if (onlyMissing && target.score != null && target.tags != null && target.summary != null) {
        result.skipped++
        return
      }
      if (!subject) subject = JSON.parse(line)
      pendingLibrary.push({ target, subject, isAnime })
    },
    { raw: true },
  )
  flushFull()
  flushStubs()

  /* ② 章节数：**全站动画**都数（`summary` 里的「话数」是计划数，实际播出以章节表为准）
     -------------------------------------------------------------------------
     这一趟以前只数库里那几千条（`wantedIds`），全量入库之后要数到 `animeIds` 全部：
     话数是推荐能不能用的关键字段（「找一部 12 集以内的」），少了它只能靠 infobox 的
     计划话数（长篇常见「话数=∞」或空着）。 */
  const episodeCounts = new Map()
  const epStats = await readJsonLinesFrom(
    openEntry(source, DUMP_FILES.episode),
    (line) => {
      const match = /"subject_id":(\d+)/.exec(line)
      if (!match) return
      const subjectId = Number(match[1])
      if (!animeIds.has(subjectId) && !wantedIds.has(subjectId)) return
      // `"type":0` 后面紧跟 `,` 或 `}`（允许空格），避免把 10 / 0.5 之类误当正篇
      if (!/"type"\s*:\s*0\s*[,}]/.test(line)) return
      episodeCounts.set(subjectId, (episodeCounts.get(subjectId) || 0) + 1)
    },
    { raw: true },
  )

  /* 话数回填（只增不减：周更快照可能落后于上游登记，改小会让「缺哪集」失真） */
  if (!dryRun && episodeCounts.size) setCatalogEpisodes(episodeCounts)

  /* 库里那几行：档案字段 + 集数一起写（`anime` 表是给排期/展示看的，字段少） */
  let batch = []
  let subjectBatch = []
  const flush = () => {
    if (!batch.length) return
    if (!dryRun) {
      applyArchiveBatch(batch, { checkedAt: markChecked ? Date.now() : null })
      // 非动画条目（dump 里 type≠2 但库里挂着它）：完整行不在①里写过，这里补一次
      if (subjectBatch.length) upsertSubjects(subjectBatch)
    }
    result.patched += batch.length
    result.subjects = (result.subjects || 0) + subjectBatch.length
    batch = []
    subjectBatch = []
  }
  for (const item of pendingLibrary) {
    const episodes = episodeCounts.get(Number(item.subject?.id)) ?? null
    const patch = archivePatch(item.subject, { episodes })
    batch.push({ id: item.target.id, ...patch })
    if (!item.isAnime) {
      subjectBatch.push({
        bgm_id: item.target.bgm_id,
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
    }
    if (batch.length >= BATCH_SIZE) flush()
  }
  flush()

  /* ③ 关系表（可选文件）—— **整表按「两端都是动画」落库，不再按库内成员裁剪**
     -------------------------------------------------------------------------
     以前这里写的是 `if (!wantedIds.has(sid) && !wantedIds.has(rid)) return`，只留
     「至少一端在库」的边。系列链是 A—B—C 这种链，中间那段 A—B **两端都不在库**就被丢了 →
     从库里那部向外走链走不动 → 系列只剩下半截（实测《无职转生》第二季第2部分被当成第 1 部，
     后面的季位整体错一位）。
     现在：动画 id 全集在 ② 里已经收集好，两端都在集合里的边就是**这个项目的完整关系图**，
     照单全收（全站关系 76MB，其中两端都是动画的只是一小部分）。
     这样 `relatedOf()` 对任何一部动画都有答案，走链**一次上游都不用打**。 */
  if (relationFileAvailable) {
    if (!dryRun) clearRelationEdges()
    const keptTypes = new Set(RELATION_TYPES_KEPT)
    let relBatch = []
    const flushRel = () => {
      if (!relBatch.length) return
      if (!dryRun) insertRelations(relBatch)
      result.relations += relBatch.length
      relBatch = []
    }
    const relStats = await readJsonLinesFrom(
      openEntry(source, RELATION_FILE),
      (line) => {
        const type = Number(/"relation_type"\s*:\s*(\d+)/.exec(line)?.[1])
        if (!keptTypes.has(type)) return
        const sid = Number(/"subject_id"\s*:\s*(\d+)/.exec(line)?.[1])
        const rid = Number(/"related_subject_id"\s*:\s*(\d+)/.exec(line)?.[1])
        if (!Number.isFinite(sid) || !Number.isFinite(rid)) return
        if (!animeIds.has(sid) || !animeIds.has(rid)) return
        const ord = Number(/"order"\s*:\s*(\d+)/.exec(line)?.[1]) || 0
        relBatch.push([sid, type, rid, ord])
        if (relBatch.length >= BATCH_SIZE) flushRel()
      },
      { raw: true },
    )
    flushRel()
    result.badLines += relStats.bad

    /* 全站关系表 = 每一部动画的 1 跳关系都有答案（哪怕一行都没有）→ 以后一律不打上游。
       不标的话，没关系的那几部会每轮白打一次 BGM。 */
    if (!dryRun) markStubRelationsChecked([...animeIds])
    log.info(
      { anime: animeIds.size, relations: result.relations, stubs: result.stubs },
      'archive.relations',
    )
  } else {
    log.warn({ file: RELATION_FILE }, 'archive.relations skip（dump 里没有这张表，走链仍打上游）')
  }

  /*
   * ④ 关系图重灌了 → 已经算过系列的番必须重算，否则库里躺的还是旧季位。
   * 以前这一步缺了，所以「导完 dump 系列还是不对」—— 队列谓词是 `series_checked_at IS NULL`，
   * 算过一次就再也不会被捞起来。清空之后 worker 下一轮会把它们重走一遍（走链现在全离线，很快）。
   * 根名/命名风格不会被覆盖（setSeriesMeta 只补空），AI 也只会在缺根名时才被调用。
   */
  if (!dryRun && resetSeries) {
    result.seriesReset = clearSeriesChecked()
    log.info({ rows: result.seriesReset }, 'archive.series reset')
  }

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
      relations: result.relations,
      stubs: result.stubs,
      needArchive: `${before.needArchive} → ${result.after.needArchive}`,
      withScore: `${before.withScore} → ${result.after.withScore}`,
      ms: result.ms,
    },
    dryRun ? 'archive.dry-run' : 'archive.done',
  )
  if (result.episodes === 0 && targets.size) {
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
        resetSeries: !flag('no-reset-series'),
      })
    }
  } catch (err) {
    logger.error({ err: err.message }, 'archive.fail')
    process.exitCode = 1
  }
}
