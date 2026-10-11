/**
 * 首页 DTO 映射 —— 把数据库行整成「前端可以直接摆」的卡片与分组
 * ---------------------------------------------------------------------------
 * 为什么单独一层：编排（api/pages/home.js 决定取哪季、走库还是回源）与展示整形
 * （拼成品字符串、按星期分组）是两件事 —— 前端字段要改时只动这里，不碰取数逻辑。
 * 约定：前端不做格式化，所以 ratingText / metaText 都在这层拼好。
 */
import { DAY_META, metaText, parseTags, ratingText, scoreText } from '../../lib/format.js'

/**
 * 一行 anime 记录 → 首页卡片
 * poster 给的是**统一出图入口**（/api/img/anime/{id}）：缓存 / 防盗链 / 换源都在后端，
 * 前端只认这个地址。
 */
export function toCardItem(row) {
  const total = Number(row.rating_total) || 0
  const hasScore = row.score != null && total > 0
  return {
    id: row.id,
    title: row.title_cn || row.title,
    poster: row.poster_src ? `/api/img/anime/${row.id}` : '',
    score: hasScore ? row.score : null,
    scoreText: hasScore ? scoreText(row.score) : '',
    ratingText: hasScore ? ratingText(total) : '',
    metaText: metaText({ year: row.year, tags: parseTags(row.tags), watching: row.watching }),
    bgmId: row.bgm_id,
    mikanId: row.mikan_id,
  }
}

/**
 * 按 weekday 分组：0=周日…6=周六，7=剧场版，8=OVA（与 Mikan、前端 weekOrder.js 一致）
 * 空档不补 —— 前端自己会补空区块，保证地铁 7 站都有落点。
 */
export function groupByDay(rows) {
  const buckets = new Map()
  for (const row of rows) {
    const day = Number.isInteger(row.weekday) ? row.weekday : 0
    if (!buckets.has(day)) buckets.set(day, [])
    buckets.get(day).push(toCardItem(row))
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([day, items]) => ({ day, ...(DAY_META[day] || { dayLabel: `第 ${day} 组`, badge: '' }), items }))
}
