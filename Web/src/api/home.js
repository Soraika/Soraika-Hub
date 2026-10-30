/**
 * 首页接口
 * ---------------------------------------------------------------------------
 * 只声明「页面要什么」，不关心后端怎么抓：排期/评分/分组/文案都是后端给成品。
 * 接口形状见 Server/src/api/pages/home.js。
 */
import { apiGet } from './http'

/**
 * 本周（某季）排期
 * @param {{ year?: number|string, season?: string, force?: boolean }} [params]
 *        year / season 不传 = 由后端按当前季给（顺带解决时区问题）
 *        force = true 跳过后端缓存，强制回源刷新
 * @returns {Promise<{ season: {year:number, season:string, label:string},
 *                     years: Array<{year:number, disabled:string[]}>,
 *                     days: Array<{day:number, dayLabel:string, badge:string, items:Array<object>}>,
 *                     meta: object }>}
 */
export function fetchHomeSchedule({ year, season, force } = {}) {
  return apiGet('/api/home/schedule', {
    params: { year, season, force: force ? 1 : undefined },
    // 首屏 / 冷门季可能触发一次上游抓取（Mikan + Bangumi）—— 给宽一点，
    // 别让"切季"因为上游慢而被前端判超时（那看着就是"点了没反应"）
    timeout: 40000,
  })
}
