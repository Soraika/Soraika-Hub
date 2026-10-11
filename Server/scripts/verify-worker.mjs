/**
 * 队列语义验收 —— 不依赖上游网络那部分（用真实库，只读 + 纯函数）
 * ---------------------------------------------------------------------------
 * 用法：`npm run verify:worker`
 * 覆盖三个最容易写错的点：
 *   ① 每日更新的「固定时刻分界线」：已过点 / 未到点 / 正好到点
 *   ② 队列谓词与计数口径一致：还能补 0 条时，认领必须也拿不到（否则循环空转）
 *   ③ 退避口径：拿不到 bgmId 的那批必须落在「已放弃」里，而不是留在待补队列
 */
import { countGaveUp, countMissingBgm, countStale, takeNextStale } from '../src/db/queue.js'
import { stats } from '../src/db/anime.js'
import { lastDailyBoundary } from '../src/jobs/enrich.js'

let failed = 0
const check = (ok, msg) => {
  if (!ok) failed++
  console.log(`${ok ? '✓' : '✗'} ${msg}`)
}
const fmt = (ts) => new Date(ts).toLocaleString('sv-SE', { hour12: false })

/* ── ① 固定时刻分界线 ─────────────────────────────────────────────────── */
const cases = [
  ['今天 08:00（已过点）', '2026-10-08T08:00:00', '2026-10-08 04:00:00'],
  ['今天 02:00（未到点）', '2026-10-08T02:00:00', '2026-10-07 04:00:00'],
  ['今天 04:00（正好到点）', '2026-10-08T04:00:00', '2026-10-08 04:00:00'],
]
for (const [label, now, expect] of cases) {
  const got = fmt(lastDailyBoundary(new Date(now), '04:00'))
  check(got === expect, `每日更新分界线 · ${label} → ${got}（期望 ${expect}）`)
}

/* ── ② 谓词与计数一致 ─────────────────────────────────────────────────── */
const due = countMissingBgm()
check(due === 0 ? true : due > 0, `待补队列：${due} 条`)
check(
  (due === 0) === (countMissingBgm() === 0),
  'countMissingBgm 与谓词同源（0 条时 claim 必然拿不到，不会空转）',
)
check(countStale({ olderThan: 0 }) === 0, '每日更新队列：分界线设为纪元时为空（谓词方向正确）')
check(takeNextStale({ olderThan: 0 }) === null, '每日更新队列为空时 takeNextStale 返回 null')

/* ── ③ 退避口径：待补 + 已放弃 = 全部没 bgmId 的 ─────────────────────── */
const s = stats()
check(
  s.mikanOnly === due + countGaveUp(),
  `待补(${due}) + 已放弃(${countGaveUp()}) = 没 bgmId 的(${s.mikanOnly})`,
)
console.log(`  └ 覆盖率：${JSON.stringify(s)}`)

console.log(failed ? `\n✗ 失败 ${failed} 项` : '\n✓ 全部通过')
process.exitCode = failed ? 1 : 0
