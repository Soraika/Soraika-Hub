/**
 * MCP 访问令牌 —— 生成 / 比较 / 掩码
 * ---------------------------------------------------------------------------
 * 三条决定：
 *   ① **自动生成**：用户不需要理解令牌是什么，点「启用」就有一个。
 *      要抄走的时候在设置页 MCP 卡片里复制（那里显示完整值）。
 *   ② **constant-time 比较**：令牌是唯一的口令，`===` 会在第一个不同字节返回，
 *      理论上可以按时间差逐位爆破。这里用 timingSafeEqual（长度不等也算过一遍）。
 *   ③ **不写日志**：任何地方都不要把令牌打进日志（pino 会把对象整个序列化）。
 */
import { randomBytes, timingSafeEqual } from 'node:crypto'

/** 令牌前缀：一眼能看出这是本程序发的（扫日志/贴配置时不至于和别的 key 混） */
const PREFIX = 'sk-hub-'

/** 新令牌（约 40 个字符，足够抗猜） */
export function generateToken() {
  return `${PREFIX}${randomBytes(18).toString('base64url')}`
}

/** 打码预览：`sk-hub-abc…1234`（界面上默认显示这个） */
export function maskToken(token) {
  const text = String(token || '')
  if (!text) return ''
  if (text.length <= 12) return `${text.slice(0, 2)}…`
  return `${text.slice(0, 10)}…${text.slice(-4)}`
}

/**
 * 校验请求带来的令牌
 * @param {string} provided 来自 header / query
 * @param {string} expected 配置里的令牌
 */
export function tokenMatches(provided, expected) {
  const a = String(provided || '')
  const b = String(expected || '')
  if (!a || !b) return false
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) {
    // 长度不同也要走一次比较，别在长度上泄露信息
    timingSafeEqual(bufB, bufB)
    return false
  }
  return timingSafeEqual(bufA, bufB)
}

/** 从请求里取令牌：优先 Authorization: Bearer，其次 ?token= */
export function tokenFromRequest(req) {
  const auth = String(req.get?.('authorization') || req.headers?.authorization || '')
  const bearer = /^Bearer\s+(.+)$/i.exec(auth.trim())
  if (bearer) return bearer[1].trim()
  const query = req.query?.token
  return typeof query === 'string' ? query.trim() : ''
}
