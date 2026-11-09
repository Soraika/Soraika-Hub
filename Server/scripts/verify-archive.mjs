/**
 * 离线 dump 导入验收（bangumi/Archive）
 * ---------------------------------------------------------------------------
 * 用法：由 `npm run verify` 串联执行，也可单独 `node scripts/verify-archive.mjs`
 * 隔离：独立库文件（data/tmp-verify-archive-*.db，跑完删除）+ 临时目录里的**迷你 dump**
 *       —— 真 dump 有 1.3GB，验收不能依赖它，字段口径用 fixture 钉死。
 * 覆盖：
 *   · 字段映射口径（meta_tags 优先 / rating_total 求和 / type=0 才计数 / 空值不覆盖）
 *   · 只补库里已有的 bgm_id（dump 里多出来的条目不建行）
 *   · --only-missing 不动已有值；默认模式覆盖
 *   · bgm_checked_at 的两种行为（默认刷新 / --no-checked 不动）
 *   · 目录不存在 → 明确报错（BAD_DUMP）；给 zip 路径 → 自动找同名解压目录
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

let failed = 0
const check = (ok, msg, detail = '') => {
  if (!ok) failed++
  console.log(`${ok ? '✓' : '✗'} ${msg}${detail ? ` → ${detail}` : ''}`)
}

/* 独立库：必须在 import db 之前设定（config.js 在模块求值时读 DB_FILE） */
const DB_FILE = `data/tmp-verify-archive-${process.pid}.db`
process.env.DB_FILE = DB_FILE

const { db } = await import('../src/db/index.js')
const { runArchiveImport, resolveDumpDir } = await import('../src/jobs/import-archive.js')
const { archivePatch, archiveTags, leadingId, ratingTotalOf } = await import('../src/lib/bgm-archive.js')

const silent = { info() {}, warn() {}, error() {} }

/* ── 迷你 dump：3 个条目（库里只有 1 / 2，3 只存在于 dump 里）────────────── */
const dumpDir = mkdtempSync(join(tmpdir(), 'bgm-dump-'))
const subjectLines = [
  {
    id: 1,
    type: 2,
    name: 'Test Anime',
    name_cn: '测试番甲',
    summary: '简介甲',
    tags: [{ name: '机器人', count: 9 }, { name: '机战', count: 8 }],
    meta_tags: ['机战', 'TV'],
    score: 8.4,
    score_details: { 1: 0, 6: 3, 7: 4, 8: 5, 9: 6, 10: 7 },
    favorite: { wish: 1, done: 2, doing: 33, on_hold: 0, dropped: 0 },
    date: '2015-10-04',
  },
  {
    id: 2,
    type: 2,
    name: 'Test Anime 2',
    name_cn: '',
    summary: '简介乙',
    tags: [{ name: '恋爱', count: 5 }, { name: '校园', count: 4 }],
    meta_tags: [],
    score: 8,
    score_details: { 8: 2 },
    favorite: { doing: 0 },
    date: '2020-01-05',
  },
  // 库里没有 → 导入不能凭空建行
  { id: 3, type: 2, name: '不在库里', name_cn: '不该出现', summary: '', tags: [], meta_tags: [], score: 9.9, favorite: { doing: 5 }, date: '2021-04-01' },
  // 还没人评分（score 0）→ 写库时必须是 null，不能把已有的评分擦掉
  { id: 4, type: 2, name: '无人评分', name_cn: '无人评分', summary: '简介丁', tags: [], meta_tags: [], score: 0, favorite: { doing: 0 }, date: '' },
  // 库里记着 5 集、dump 里有 8 集 → 总集数应当跟到 8（只增不减的另一半）
  { id: 5, type: 2, name: '长了三集', name_cn: '长了三集', summary: '简介戊', tags: [{ name: '奇幻', count: 2 }], meta_tags: [], score: 7, favorite: { doing: 3 }, date: '2024-01-07' },
]
writeFileSync(join(dumpDir, 'subject.jsonlines'), subjectLines.map((row) => JSON.stringify(row)).join('\n') + '\n')

const episode = (id, subjectId, type) => ({
  id,
  name: `第${id}话`,
  name_cn: '',
  description: '',
  airdate: '',
  disc: 0,
  duration: '',
  subject_id: subjectId,
  sort: id,
  type,
})
const episodeLines = [
  episode(101, 1, 0),
  episode(102, 1, 0),
  episode(103, 1, 0),
  episode(104, 1, 1), // 特别篇：不算进总集数
  episode(201, 2, 0),
  episode(202, 2, 0),
  episode(301, 3, 0), // 无关条目：不该被计数
  ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => episode(500 + n, 5, 0)),
]
writeFileSync(join(dumpDir, 'episode.jsonlines'), episodeLines.map((row) => JSON.stringify(row)).join('\n') + '\n')

/* ── 纯函数：字段口径 ──────────────────────────────────────────────────── */
console.log('\n— 字段映射口径')
check(ratingTotalOf({ 1: 0, 6: 3, 7: 4, 8: 5, 9: 6, 10: 7 }) === 25, 'rating_total = 各档人数之和')
check(ratingTotalOf(undefined) === null, '没有评分分布 → null（不覆盖已有值）')
check(
  JSON.stringify(archiveTags(subjectLines[0])) === '["机战","TV"]',
  'meta_tags 优先（与 bgmToRow 同口径）',
  JSON.stringify(archiveTags(subjectLines[0])),
)
check(
  JSON.stringify(archiveTags(subjectLines[1])) === '["恋爱","校园"]',
  '没有 meta_tags 时退回 tags 的 name',
  JSON.stringify(archiveTags(subjectLines[1])),
)
check(archiveTags({ tags: Array.from({ length: 12 }, (_, i) => ({ name: `t${i}` })) }).length === 8, '标签最多 8 个')
check(leadingId('{"id":12,"type":2}') === 12, '行首 id 能直接取（省掉 60 万次 JSON.parse）')
check(leadingId('{"type":2,"id":12}') === null, '字段顺序变了 → 返回 null，由调用方兜底整行解析')
check(archivePatch(subjectLines[3]).score === null, 'score=0（没人评分）→ null')
check(archivePatch(subjectLines[3]).watching === null, 'doing=0 → null')
check(archivePatch(subjectLines[0], { episodes: 3 }).total_episodes === 3, '总集数取 dump 里 type=0 的条数')

/* ── 建库：4 行（1 空、2 已有旧值、5 集数偏小、999 不在 dump 里）──────────── */
const now = Date.now()
db.prepare('INSERT INTO anime (bgm_id, title, created_at, updated_at) VALUES (?, ?, ?, ?)').run('1', '番甲', now, now)
db.prepare(
  'INSERT INTO anime (bgm_id, title, score, tags, summary, total_episodes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
).run('2', '番乙', 9.9, JSON.stringify(['旧标签']), '旧简介', 12, now, now)
db.prepare('INSERT INTO anime (bgm_id, title, created_at, updated_at) VALUES (?, ?, ?, ?)').run('999', '番丙', now, now)
db.prepare(
  'INSERT INTO anime (bgm_id, title, total_episodes, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
).run('5', '番戊', 5, now, now)

const rowOf = (bgmId) => db.prepare('SELECT * FROM anime WHERE bgm_id = ?').get(bgmId)
const countRows = () => db.prepare('SELECT COUNT(*) AS n FROM anime').get().n
const needArchive = () => db.prepare(`
  SELECT COUNT(*) AS n FROM anime
  WHERE bgm_id IS NOT NULL AND (score IS NULL OR tags IS NULL OR summary IS NULL)
`).get().n

console.log('\n— 只补空字段（--only-missing）')
const first = await runArchiveImport({ dir: dumpDir, onlyMissing: true, log: silent })
check(first.matched === 3, '只认库里已有 bgm_id 的条目', `matched=${first.matched}`)
check(first.patched === 2 && first.skipped === 1, '字段齐的那条跳过，缺的两条补上', `patched=${first.patched} skipped=${first.skipped}`)
check(countRows() === 4, 'dump 里多出来的条目（id=3）不会建行', `rows=${countRows()}`)

const a = rowOf('1')
check(a.title_cn === '测试番甲' && a.score === 8.4, '新建档案：中文名 + 评分', `${a.title_cn} / ${a.score}`)
check(a.rating_total === 25, '评分人数落库', String(a.rating_total))
check(a.tags === '["机战","TV"]', '标签落库（JSON 数组）', a.tags)
check(a.watching === 33 && a.summary === '简介甲' && a.air_date === '2015-10-04', '在看 / 简介 / 放送日')
check(a.total_episodes === 3, '总集数只数正篇（特别篇不算）', String(a.total_episodes))
check(Boolean(a.bgm_checked_at), 'bgm_checked_at 被刷新（不再被档案队列打上游）', String(a.bgm_checked_at))

const b = rowOf('2')
check(b.score === 9.9 && b.tags === JSON.stringify(['旧标签']), '--only-missing 不动已有值', `${b.score} / ${b.tags}`)
check(rowOf('999').bgm_checked_at == null, 'dump 里没有的条目一行都没动')
check(rowOf('5').total_episodes === 8, '总集数变多就跟上（5 → 8）', String(rowOf('5').total_episodes))
check(needArchive() === 1, '补完之后只差 dump 里没有的那条', String(needArchive()))

console.log('\n— 默认模式（覆盖已有值）')
const second = await runArchiveImport({ dir: dumpDir, log: silent })
check(second.patched === 3, '三条都写', `patched=${second.patched}`)
const b2 = rowOf('2')
check(b2.score === 8, '评分被 dump 的值覆盖', String(b2.score))
check(b2.tags === '["恋爱","校园"]', '标签换成 dump 的（无 meta_tags → 用户标签）', b2.tags)
check(b2.summary === '简介乙', '简介跟着更新', String(b2.summary))
check(b2.total_episodes === 12, '总集数只增不减（dump 只有 2 集，不能把 12 改小）', String(b2.total_episodes))
check(b2.air_date === '2020-01-05', '放送日落库（不改 year/season/weekday）', String(b2.air_date))
check(rowOf('2').year == null && rowOf('2').season == null, '排期字段仍然为空（只有 Mikan 能写）')

console.log('\n— --no-checked / 异常路径')
db.prepare('UPDATE anime SET bgm_checked_at = NULL WHERE bgm_id = ?').run('2')
await runArchiveImport({ dir: dumpDir, markChecked: false, log: silent })
check(rowOf('2').bgm_checked_at == null, '--no-checked 不动 bgm_checked_at')

const zipPath = join(dumpDir, '..', `bgm-dump-${process.pid}.zip`)
mkdirSync(join(zipPath.replace(/\.zip$/, '')), { recursive: true })
copyFileSync(join(dumpDir, 'subject.jsonlines'), join(zipPath.replace(/\.zip$/, ''), 'subject.jsonlines'))
copyFileSync(join(dumpDir, 'episode.jsonlines'), join(zipPath.replace(/\.zip$/, ''), 'episode.jsonlines'))
writeFileSync(zipPath, '')
check(
  resolveDumpDir(zipPath) === resolve(zipPath.replace(/\.zip$/, '')),
  '给 zip 路径 → 自动找到同名的解压目录',
)

let badCode = ''
try {
  await runArchiveImport({ dir: join(dumpDir, 'nope'), log: silent })
} catch (err) {
  badCode = err.code || err.message
}
check(badCode === 'BAD_DUMP', '目录里没有那两个文件 → BAD_DUMP（不会静默 0 条）', String(badCode))

/* ── 清理 ────────────────────────────────────────────────────────────── */
rmSync(dumpDir, { recursive: true, force: true })
rmSync(zipPath.replace(/\.zip$/, ''), { recursive: true, force: true })
rmSync(zipPath, { force: true })
db.close()
for (const suffix of ['', '-wal', '-shm']) {
  const file = resolve(DB_FILE + suffix)
  if (existsSync(file)) rmSync(file, { force: true })
}

console.log(failed ? `\n✗ 失败 ${failed} 项` : '\n✓ 全部通过')
process.exit(failed ? 1 : 0)
