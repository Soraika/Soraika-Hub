/**
 * Bangumi 数据源 —— 只做一件事：**按 bgmId 取条目的评分 / 评分人数 / 标签 / 简介**
 * ---------------------------------------------------------------------------
 * 谁给 bgmId？**Mikan 详情页**（clients/Mikan.js 的 getAnimeBangumiId）—— 唯一权威来源。
 * 所以首页的链路就是定好的那条：
 *
 *   Mikan 季度列表 → 逐条取 bgmId（权威映射）→ 按 bgmId 取评分 → 落库 → 展示
 *
 * 这里刻意**不做**「按季度检索 + 标题匹配」那种猜测式匹配（已删除）：长寿番（柯南 /
 * 面包超人）本期没有 air_date 落在当季、译名又常不一致，猜错比暂时没分更糟。
 */
import { upstreamCache } from '../../cache/mem.js'
import { config } from '../../config.js'
import { fail } from '../../lib/errors.js'
import { request } from '../../lib/http-client.js'
import { logger } from '../../lib/logger.js'

/** 条目详情缓存时长：评分/标签变化很慢，6 小时足够 */
const SUBJECT_TTL_MS = 6 * 60 * 60 * 1000

/** 系列关系（1 跳关联）缓存时长：系列关系几乎不变，7 天足够 */
const RELATED_TTL_MS = 7 * 24 * 60 * 60 * 1000

const headers = () => ({
  'User-Agent': config.bgm.userAgent,
  ...(config.bgm.token ? { Authorization: `Bearer ${config.bgm.token}` } : {}),
})

/**
 * 条目详情（带缓存）—— 评分 / 评分人数 / 标签（tags 与 meta_tags）/ 简介 / 话数 / 放送日期
 * @param {string|number} bgmId
 * @returns {Promise<object>}
 */
export async function fetchSubject(bgmId) {
  if (!bgmId) throw fail('BAD_REQUEST', '缺少 bgmId')
  return upstreamCache.wrap(
    `bgm:subject:${bgmId}`,
    () =>
      request(`${config.bgm.base}/v0/subjects/${encodeURIComponent(bgmId)}`, {
        headers: headers(),
        expect: 'json',
        timeoutMs: config.bgm.timeoutMs,
        tip: `Bangumi 条目 ${bgmId}`,
      }),
    SUBJECT_TTL_MS,
  )
}

/**
 * 条目的 1 跳关联 —— 系列链就是靠它一层层走出来的（见 CONVENTIONS.md §10.1）
 * ---------------------------------------------------------------------------
 * 只做「取数 + 归一化字段」，**不做业务判断**（谁算正传、谁算番外由 lib/series.js 决定）。
 * 注意两件事：
 *   · 返回里**没有 year**（镜像 API 的 1 跳只有 id / name / name_cn / relation / type）
 *     → 链序不能靠年份，只能靠关系方向（续集 / 前传）走出来
 *   · 列表顺序**不保证**（实测有的条目升序、有的不是）→ 同样不能依赖顺序
 * @param {string|number} bgmId
 * @returns {Promise<Array<{ id:string, name:string, nameCn:string, relation:string, type:number }>>}
 */
export async function fetchRelatedSubjects(bgmId) {
  if (!bgmId) throw fail('BAD_REQUEST', '缺少 bgmId')
  let list
  try {
    list = await upstreamCache.wrap(
      `bgm:related:${bgmId}`,
      () =>
        request(`${config.bgm.base}/v0/subjects/${encodeURIComponent(bgmId)}/subjects`, {
          headers: headers(),
          expect: 'json',
          timeoutMs: config.bgm.timeoutMs,
          tip: `Bangumi 关联条目 ${bgmId}`,
        }),
      RELATED_TTL_MS,
    )
  } catch (err) {
    // 404 = 这个条目在镜像上根本不存在（实测 `GET /v0/subjects/{id}` 也 404，
    // 因为它只出现在别人的关联列表里）→ 语义上等价于「没有关联」，**不是**故障：
    // 走链时跳过它就行，不该让它把整条链甚至整个守护进程带崩（冒烟测踩到过）。
    // 刻意**不缓存**空结果：万一是镜像侧临时抽风，冻 7 天会把链悄悄走断。
    if (err?.detail?.status === 404) {
      logger.warn({ bgmId }, 'bgm.related not-found')
      return []
    }
    throw err // 超时 / 5xx 仍然抛出 —— 调用方据此放弃这次，别把半条链写进库
  }
  return (Array.isArray(list) ? list : []).map((item) => ({
    id: String(item?.id ?? ''),
    name: item?.name || '',
    nameCn: item?.name_cn || '',
    relation: item?.relation || '',
    type: Number(item?.type) || 0,
  }))
}
