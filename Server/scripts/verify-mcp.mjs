/**
 * MCP 服务验收 —— 协议 / 鉴权 / 工具 / 写权限闸门
 * ---------------------------------------------------------------------------
 * 用法：由 `npm run verify` 串联执行，也可单独 `node scripts/verify-mcp.mjs`
 * 隔离：独立端口（默认 3307）+ 独立库文件（data/tmp-verify-mcp.db，跑完删除）
 *       + **本脚本自己起的假 qB**（写工具要有东西可打，且不能碰真 NAS）。
 *
 * 覆盖：
 *   · 未启用 → 404；启用但没令牌 → 启用时自动生成
 *   · 无令牌 / 错令牌 → 401；对的令牌 → 200
 *   · initialize 回声客户端协议版本；未知版本回落最新
 *   · tools/list 数量与代码一致；每个工具都有 name/title/inputSchema
 *   · notifications/* → 202（通知没有响应体）
 *   · 批量请求 / 非 2.0 / 没用方法 → 对应的 JSON-RPC 错误码
 *   · 只读工具真的能查到东西（search / get_anime / list_season / list_tags）
 *   · 写工具在 allowWrite=false 时被拦（isError + 中文说明），打开后才打到 qB
 *   · 删除默认 deleteFiles=false（不许"顺手删文件"）
 */
import { spawn } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'

const PORT = Number(process.env.VERIFY_MCP_PORT || 3307)
const base = `http://127.0.0.1:${PORT}`
const DB_FILE = 'data/tmp-verify-mcp.db'

let failed = 0
const check = (ok, msg, detail = '') => {
  if (!ok) failed++
  console.log(`${ok ? '✓' : '✗'} ${msg}${detail ? ` → ${detail}` : ''}`)
}

const cleanDb = () => {
  for (const suffix of ['', '-wal', '-shm']) {
    const file = `${DB_FILE}${suffix}`
    if (existsSync(file)) rmSync(file, { force: true })
  }
}
cleanDb()

/* ── 假 qB：记录收到的请求，写操作一律 200 ─────────────────────────────── */
const qbCalls = []
const qb = createServer((req, res) => {
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    qbCalls.push({ path: req.url.split('?')[0], body: Buffer.concat(chunks).toString() })
    res.setHeader('Content-Type', 'application/json')
    if (req.url.startsWith('/api/v2/torrents/info')) return res.end(JSON.stringify([
      { hash: 'aaa111', name: '测试番 S01E01', state: 'downloading', progress: 0.5, size: 1000, downloaded: 500,
        dlspeed: 100, upspeed: 0, eta: 60, ratio: 0, category: 'soraika-hub', save_path: '/downloads/anime', added_on: 1700000000 },
      { hash: 'bbb222', name: '测试番 S01E02', state: 'pausedDL', progress: 0.2, size: 2000, downloaded: 400,
        dlspeed: 0, upspeed: 0, eta: 0, ratio: 0, category: 'soraika-hub', save_path: '/downloads/anime', added_on: 1700000001 },
    ]))
    if (req.url.startsWith('/api/v2/app/version')) return res.end('v5.2.1')
    res.end('Ok.')
  })
})
await new Promise((r) => qb.listen(0, '127.0.0.1', r))
const qbBase = `http://127.0.0.1:${qb.address().port}`

/* ── 起服务 ─────────────────────────────────────────────────────────────── */
const logs = []
const startServer = () => {
  const child = spawn(process.execPath, ['--env-file-if-exists=.env', 'src/index.js'], {
    env: { ...process.env, PORT: String(PORT), DB_FILE, LOG_LEVEL: 'warn' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (d) => logs.push(String(d)))
  child.stderr.on('data', (d) => logs.push(String(d)))
  return child
}
let child = startServer()

const waitReady = async () => {
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) return
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error('服务没起来')
}
const stopServer = async () => {
  child.kill()
  await new Promise((r) => child.once('exit', r))
}

const api = async (method, path, body) => {
  const res = await fetch(base + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* 非 JSON */ }
  return { status: res.status, body: json, text }
}

/** 打一次 /mcp（默认带正确令牌，可覆盖） */
const rpc = async (message, { token, raw } = {}) => {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }
  if (token !== null) headers.Authorization = `Bearer ${token ?? currentToken}`
  const res = await fetch(`${base}/mcp`, { method: 'POST', headers, body: raw ?? JSON.stringify(message) })
  const text = await res.text()
  let body = null
  try { body = text ? JSON.parse(text) : null } catch { /* 非 JSON */ }
  return { status: res.status, body, text }
}

/** 调一个工具，返回 { isError, data } */
const tool = async (name, args = {}) => {
  const r = await rpc({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name, arguments: args } })
  const content = r.body?.result?.content?.[0]?.text
  let data = null
  try { data = content ? JSON.parse(content) : null } catch { data = content }
  return { isError: Boolean(r.body?.result?.isError), data, raw: r }
}

let currentToken = ''

try {
  await waitReady()

  /* ── 1. 未启用 → 404（连"这里有 MCP"都不说）────────────────────────── */
  const off = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, { token: 'whatever' })
  check(off.status === 404, '未启用时 /mcp 一律 404', `HTTP ${off.status}`)

  /* ── 2. 启用即自动生成令牌 ──────────────────────────────────────────── */
  const enabled = await api('PUT', '/api/settings', { values: { 'mcp.enabled': true } })
  check(enabled.status === 200, '启用 MCP 保存成功')
  const status = (await api('GET', '/api/mcp/status')).body?.data
  currentToken = status?.token || ''
  check(/^sk-hub-/.test(currentToken), `启用时自动生成了令牌 → ${status?.tokenPreview}`)
  check(status?.endpoint?.endsWith('/mcp'), `端点地址 → ${status?.endpoint}`)
  check(Array.isArray(status?.tools) && status.tools.length >= 15, `设置页能拿到工具清单 ${status?.tools?.length} 个`)
  check(
    status?.clients?.length >= 3 && status.clients.every((c) => c.snippet?.includes('/mcp')),
    '客户端配置片段里都带端点地址',
  )

  /* ── 3. 鉴权 ───────────────────────────────────────────────────────── */
  const noToken = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, { token: null })
  check(noToken.status === 401, '不带令牌 → 401')
  const badToken = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, { token: 'sk-hub-wrong' })
  check(badToken.status === 401, '错令牌 → 401')
  const queryToken = await (async () => {
    const res = await fetch(`${base}/mcp?token=${encodeURIComponent(currentToken)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    })
    return { status: res.status, text: await res.text() }
  })()
  check(queryToken.status === 200, '?token= 也能过（给不会设 header 的客户端兜底）')

  /* ── 4. initialize ────────────────────────────────────────────────── */
  const init = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } } })
  check(init.status === 200 && init.body?.result?.protocolVersion === '2025-03-26', 'initialize 回声客户端报的协议版本')
  check(Boolean(init.body?.result?.capabilities?.tools), 'capabilities 里声明了 tools')
  check(/Soraika/.test(JSON.stringify(init.body?.result?.serverInfo)), 'serverInfo 里带程序名')
  const oddVersion = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '1999-01-01', capabilities: {} } })
  check(oddVersion.body?.result?.protocolVersion === '2025-06-18', '不认识的协议版本回落到最新版')

  /* ── 5. 通知 / 错误码 ─────────────────────────────────────────────── */
  const note = await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' })
  check(note.status === 202 && !note.text, 'notifications/* → 202 且没有响应体')
  const unknown = await rpc({ jsonrpc: '2.0', id: 2, method: 'nope/nope' })
  check(unknown.body?.error?.code === -32601, '未知方法 → -32601')
  const batch = await rpc(null, { raw: JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'ping' }]) })
  check(batch.body?.error?.code === -32600, '批量请求 → -32600（一次一条）')
  const badJson = await rpc(null, { raw: '{"jsonrpc":"1.0",' })
  check(badJson.status === 400, '坏 JSON → 400')
  const notRpc = await rpc({ id: 3, method: 'ping' })
  check(notRpc.body?.error?.code === -32600, '缺 jsonrpc:2.0 → -32600')

  /* ── 6. tools/list ────────────────────────────────────────────────── */
  const list = await rpc({ jsonrpc: '2.0', id: 4, method: 'tools/list' })
  const tools = list.body?.result?.tools ?? []
  check(tools.length === status.tools.length, `tools/list 与设置页一致（${tools.length} 个）`)
  check(tools.every((t) => t.name && t.title && t.inputSchema?.type === 'object'), '每个工具都有 name / title / inputSchema')
  const writeTools = tools.filter((t) => t.annotations?.destructiveHint)
  check(writeTools.length >= 6 && tools.some((t) => t.annotations?.readOnlyHint === true), `写工具 ${writeTools.length} 个、只读工具 ${tools.length - writeTools.length} 个`)

  /* ── 7. 写权限闸门（qB 还没配，但拦截要在"打上游"之前发生）────────── */
  const blocked = await tool('pause_download', { hashes: ['aaa111'] })
  check(blocked.isError && /允许写入/.test(JSON.stringify(blocked.data)), 'allowWrite=false 时写工具被拦，并说明去哪打开')
  check(qbCalls.length === 0, '被拦的写工具没有打到任何上游')

  /* ── 8. 播种数据（停服务 → 直接写库 → 再起）──────────────────────── */
  await stopServer()
  {
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(DB_FILE)
    /* `anime` 只存排期（标题/评分/标签在 `bgm_subject`，读取走 v_anime）——
       往这里塞 title_bgm 会报 no such column，这是表结构故意的分工 */
    db.prepare(
      `INSERT INTO anime (id, mikan_id, bgm_id, title_mikan, year, season, weekday,
                          series_id, series_index, series_root_title, series_checked_at, series_named_at, updated_at)
       VALUES (9001, '5001', '101', '测试番甲', 2020, '夏', 2, 9900, 1, '测试系列', 1, 1, 1)`,
    ).run()
    db.prepare(
      `INSERT INTO anime (id, mikan_id, bgm_id, title_mikan, year, season, weekday,
                          series_id, series_index, series_root_title, series_checked_at, updated_at)
       VALUES (9002, '5002', '102', '测试番乙', 2021, '冬', 4, 9900, 2, '测试系列', 1, 1)`,
    ).run()
    for (const [id, cn, name, score, date, eps] of [
      [101, '测试番甲', 'テスト甲', 8.4, '2020-07-05', 12],
      [102, '测试番乙', 'テスト乙', 8.9, '2021-01-10', 12],
      [103, '治愈番丙', 'イヤシ', 8.6, '2019-04-02', 13],
      [104, '低分番丁', 'ヒク', 5.1, '2022-10-01', 12],
    ]) {
      db.prepare(
        `INSERT INTO bgm_subject (bgm_id, title_bgm, title_bgm_origin, summary, score, rating_total, tags, type,
                                  first_air_date, total_episodes, name_fold, staff, nsfw, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, 2, ?, ?, ?, ?, 0, 'dump')`,
      ).run(String(id), cn, name, `${cn}的简介`, score, 500, JSON.stringify(['机战']), date, eps,
        String(cn).normalize('NFKC').toLowerCase(), JSON.stringify({ 导演: '某导演', 动画制作: '某公司' }))
    }
    for (const [id, tags] of [[101, ['机战', '原创']], [102, ['机战', '原创']], [103, ['治愈']], [104, ['机战']]]) {
      for (const name of tags) db.prepare('INSERT INTO bgm_tag (bgm_id, name, count) VALUES (?, ?, 50)').run(String(id), name)
    }
    db.close()
  }
  child = startServer()
  await waitReady()

  /* ── 9. 只读工具真能查到东西 ──────────────────────────────────────── */
  const stats = await tool('catalog_stats')
  check(!stats.isError && stats.data?.anime === 4, `catalog_stats 数到 4 部动画 → ${stats.data?.anime}`)

  const search = await tool('search_anime', { tags: ['机战'], minScore: 8 })
  check(!search.isError && search.data?.total >= 2, `search_anime 按标签+评分筛到 ${search.data?.total} 部`)
  check(search.data?.items?.[0]?.bgmId === '102', '按评分倒序（8.9 在最前）')

  const detail = await tool('get_anime', { bgmId: '101' })
  check(!detail.isError && detail.data?.title === '测试番甲' && detail.data?.staff?.导演 === '某导演', 'get_anime 返回档案与 staff')
  check(detail.data?.library?.id === 9001, 'get_anime 带上本库的排期（library.id=9001）')

  const byAnimeId = await tool('get_anime', { animeId: 9002 })
  check(!byAnimeId.isError && byAnimeId.data?.bgmId === '102', '按 animeId 也能取到详情（自动换成 bgmId）')

  const season = await tool('list_season', { year: 2020, season: '夏' })
  check(!season.isError && season.data?.total === 1 && season.data.items[0].weekdayText === '周二', 'list_season 带星期几')

  const tags = await tool('list_tags', { minScore: 8 })
  check(!tags.isError && tags.data?.items?.some((t) => t.name === '机战'), 'list_tags 能列出标签')

  const rec = await tool('recommend_anime', { tags: ['治愈'], minScore: 8 })
  check(!rec.isError && rec.data?.items?.[0]?.bgmId === '103', 'recommend_anime 按标签命中')

  const series = await tool('get_series', { animeId: 9001 })
  check(!series.isError && JSON.stringify(series.data).includes('测试'), 'get_series 读到了系列成员')

  const missing = await tool('get_anime', { bgmId: '999999' })
  check(missing.isError && /没有/.test(JSON.stringify(missing.data)), '查不存在的条目 → isError 带中文原因（不崩服务）')

  const noArgs = await tool('get_anime', {})
  check(noArgs.isError, '不传 id → isError 提示怎么传')

  /* ── 10. 打开写权限，真打到假 qB ──────────────────────────────────── */
  await api('PUT', '/api/settings', { values: { 'qb.base': qbBase, 'qb.apiKey': 'test-key', 'mcp.allowWrite': true } })

  const tasks = await tool('list_downloads', {})
  check(!tasks.isError && tasks.data?.qb?.connected === true && tasks.data.qb.items.length === 2, `list_downloads 读到 ${tasks.data?.qb?.items?.length} 个任务`)
  check(/做种|下载中|暂停/.test(String(tasks.data?.qb?.items?.[0]?.stateText)), `状态翻成中文 → ${tasks.data?.qb?.items?.[0]?.stateText}`)

  const pause = await tool('pause_download', { hashes: ['aaa111'] })
  check(!pause.isError && pause.data?.ok === true && pause.data?.succeeded === 1, `pause_download 成功 → ${JSON.stringify(pause.data)}`)
  check(qbCalls.some((c) => /torrents\/(pause|stop)/.test(c.path)), '暂停请求打到了 qB', qbCalls.map((c) => c.path).filter((p) => p.includes('torrents/')).slice(-3).join(','))
  check(qbCalls.some((c) => c.body.includes('aaa111')), 'hashes 参数带上了')

  const del = await tool('delete_download', { hashes: ['aaa111'] })
  check(!del.isError && del.data?.deleteFiles === false, '删除默认不动磁盘文件（deleteFiles=false）')
  check(qbCalls.some((c) => c.path.includes('/torrents/delete') && c.body.includes('deleteFiles=false')), '请求体里明确写了 deleteFiles=false')

  const paused = await tool('resume_download', { hashes: [] })
  check(paused.isError, '空 hash → isError 说清需要什么')

  /* ── 11. 关掉写权限 → 又拦上 ─────────────────────────────────────── */
  await api('PUT', '/api/settings', { values: { 'mcp.allowWrite': false } })
  const blockedAgain = await tool('delete_download', { hashes: ['aaa111'] })
  check(blockedAgain.isError && /允许写入/.test(JSON.stringify(blockedAgain.data)), '关掉开关后写工具立刻又被拦')

  /* ── 12. 自检接口 ─────────────────────────────────────────────────── */
  const ping = (await api('POST', '/api/mcp/ping')).body?.data
  check(ping?.ok === true && ping.tools === tools.length, `自检通过（${ping?.tools} 个工具 / ${ping?.ms}ms）`)

  /* ── 13. 轮换令牌：旧的立刻失效 ───────────────────────────────────── */
  const oldToken = currentToken
  currentToken = (await api('POST', '/api/mcp/token')).body?.data?.token
  check(currentToken && currentToken !== oldToken, '令牌已重新生成')
  const oldRejected = await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, { token: oldToken })
  check(oldRejected.status === 401, '旧令牌立刻失效')
  const newOk = await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' })
  check(newOk.status === 200 && newOk.body?.result, '新令牌可用')
} catch (err) {
  failed++
  console.log(`✗ 验收中断：${err?.message || err}`)
  console.log(logs.join('').slice(-3000))
} finally {
  try { await stopServer() } catch { /* 已经退了 */ }
  await new Promise((r) => qb.close(r))
  cleanDb()
}

console.log(failed ? `\n✗ 失败 ${failed} 项` : '\n✓ 全部通过')
process.exit(failed ? 1 : 0)
