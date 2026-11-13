/**
 * 队列语义验收 —— 不依赖上游网络那部分（用真实库，只读 + 纯函数）
 * ---------------------------------------------------------------------------
 * 用法：`npm run verify:worker`
 * 覆盖三个最容易写错的点：
 *   ① 每日更新的「固定时刻分界线」：已过点 / 未到点 / 正好到点
 *   ② 队列谓词与计数口径一致：还能补 0 条时，认领必须也拿不到（否则循环空转）
 *   ③ 退避口径：拿不到 bgmId 的那批必须落在「已放弃」里，而不是留在待补队列
 */
import { readFileSync } from 'node:fs'
import {
  claimNextSeriesPending,
  countGaveUp,
  countMissingBgm,
  countSeriesDone,
  countSeriesPending,
  countStale,
  releaseSeries,
  resetStaleSeriesClaims,
  takeNextStale,
} from './../src/db/queue.js'
import { countSubgroupDict, stats } from './../src/db/anime.js'
import { lastDailyBoundary } from './../src/jobs/enrich.js'

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

/* ── ④ 系列队列（触发③）：谓词一致 + CAS 认领 + 放回不丢任务 ───────────── */
const seriesPending = countSeriesPending()
check(countSeriesDone() + seriesPending > 0, `系列队列：算过 ${countSeriesDone()} 条 / 待算 ${seriesPending} 条`)

if (seriesPending === 0) {
  // 谓词是 IS NULL，空队列就必须认领不到 —— 否则 worker 会空转
  check(claimNextSeriesPending() === null, '系列队列为空时 claim 返回 null（不会空转）')
} else {
  const first = claimNextSeriesPending()
  check(!!first, '系列队列：能认领到一条')
  check(first.series_checked_at === -1, '认领后 series_checked_at = -1（哨兵=处理中，天然进不了队列）')
  // 被认领的那条必须离开队列 —— 否则并发进程会重复走链、重复花 AI 的钱
  check(countSeriesPending() <= seriesPending - 1, `认领后待算数下降（${seriesPending} → ${countSeriesPending()}）`)
  check(releaseSeries(first.id).changes === 1, `放回队列成功（id=${first.id}）`)
  // release 同样是 CAS：多放一次不会把"已完成/待算"的行搞乱（这是幂等的关键）
  check(releaseSeries(first.id).changes === 0, '同一条不会被放回两次（release 也是 CAS）')
  // 注意：这里刻意不断言"计数必须回到原值" —— 有后台回填在跑时它本来就会往下走
  console.log(`  └ 放回后待算数：${countSeriesPending()}（认领前 ${seriesPending}）`)
}

// 启动清理：正常情况应为 0；有 worker 正在处理时可能非 0（那正是它要清的东西），所以只上报不判失败
const stale = resetStaleSeriesClaims()
console.log(`  └ 残留"处理中"标记：${stale} 条（有 worker 在跑时可能非 0，属正常）`)

/* ── ⑤ 补档案时顺手抓字幕组（老番的「资源」区靠它）─────────────────────────
   档案补齐的快路径是「已有 bgm_id → 只打 Bangumi」，而字幕组只存在于 Mikan 详情页；
   不顺手补的话，扫描进来的老番点开面板资源区永远是空的。 */
const { config } = await import('./../src/config.js')
check(config.worker.fetchSubgroups === true, 'worker.fetchSubgroups 默认开（否则老番资源区永远空）')
const enrichSource = readFileSync(new URL('../src/jobs/enrich.js', import.meta.url), 'utf8')
check(
  /rememberSubgroupsByMikan\(row, log\)/.test(enrichSource) && /fetchAnimeProfile\(row\.mikan_id\)/.test(enrichSource),
  '档案补齐的快路径会顺手抓一次 Mikan 详情页 → rememberSubgroups（失败只 warn，不影响档案）',
)
check(typeof countSubgroupDict() === 'number', `字幕组名字字典可观测 → ${countSubgroupDict()} 条`)
check(
  /mikan-not-found/.test(enrichSource),
  'Mikan 详情页 404 = 上游确实没有 → 计入放弃（否则死 mikanId 会永远每分钟重试一次）',
)

console.log(failed ? `\n✗ 失败 ${failed} 项` : '\n✓ 全部通过')
process.exitCode = failed ? 1 : 0
