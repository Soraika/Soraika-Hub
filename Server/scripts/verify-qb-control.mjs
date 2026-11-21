/**
 * qBittorrent 任务控制层验收（api/sources/qb-control.js）
 * ---------------------------------------------------------------------------
 * 用法：`node scripts/verify-qb-control.mjs`（不进 `npm run verify`：那串命令别人在改）
 *
 * 隔离：自己起一个 `node:http` 假 qB（随机端口），把 `config.qb.base` 指过去 ——
 *       **不碰真 NAS**，也不会因为家里 qB 没开就让验收挂掉。
 *       假服务把收到的 path / query / body 全记下来，断言「我们发了什么」，
 *       这比断言「函数没抛错」有意义得多（qB 写接口的参数写错了照样回 200）。
 *
 * 覆盖：
 *   · 没配 → qbControlReady() false 且调用抛 BAD_REQUEST（中文）
 *   · 归一：progress 夹到 0..1 / size 字节 / addedOn 秒→毫秒 / eta 哨兵值收成 null
 *   · filter 透传到 query
 *   · hashes 用 `|` 连接（pause / resume / delete / setCategory / setLocation 都要）
 *   · deleteFiles=true 显式进请求体；不传时显式发 false（不能靠 qB 默认值）
 *   · 空 hashes → BAD_REQUEST「没有指定任务」
 *   · pause / resume 返回 404 → 自动改用 stop / start（qB 5.x 的改名）
 *   · 删除返回 404 → NOT_FOUND（列表是旧的，别让人反复点）
 *   · STATE_TEXT 覆盖 v5 的 `downloading+stalled` 组合键
 */
import { createServer } from 'node:http'

import { config } from '../src/config.js'
import {
  clearQbCache,
  deleteTasks,
  listTasks,
  normTask,
  pauseTasks,
  qbControlReady,
  resumeTasks,
  setCategory,
  setLocation,
  STATE_TEXT,
} from '../src/api/sources/qb-control.js'

let failed = 0
const check = (ok, msg, detail = '') => {
  if (!ok) failed++
  console.log(`${ok ? '✓' : '✗'} ${msg}${detail ? ` → ${detail}` : ''}`)
}

/* ── 假 qB 服务 ──────────────────────────────────────────────────────────── */
const requests = []
/** 可拨的开关：模拟 qB 5.x 已经没有 /pause、以及「任务已经不在列表里」 */
const flags = { pause404: false, resume404: false, delete404: false }

const TORRENTS = [
  {
    hash: 'AAAA1111BBBB2222CCCC3333DDDD4444EEEE5555',
    name: '[Soraika] 测试番 - 01 [1080p]',
    state: 'downloading',
    progress: 0.42,
    size: 1048576000,          // ≈ 1 GiB
    total_size: 1048576000,
    downloaded: 440401920,
    dlspeed: 2097152,
    upspeed: 1024,
    eta: 3600,
    ratio: 0.07,
    category: 'soraika-hub',
    save_path: '/downloads/anime/测试番/Season 01',
    added_on: 1700000000,
  },
  {
    hash: 'FFFF6666AAAA7777BBBB8888CCCC9999DDDD0000',
    name: '[Soraika] 测试番 - 02 [1080p]',
    state: 'uploading',
    progress: 1,
    size: 524288000,
    total_size: 524288000,
    downloaded: 524288000,
    dlspeed: 0,
    upspeed: 524288,
    eta: 8640000,              // qB 的「无限远」
    ratio: 1.35,
    category: '',
    save_path: '/downloads/anime/测试番/Season 01',
    added_on: 1700003600,
  },
]

const server = createServer((req, res) => {
  let body = ''
  req.on('data', (chunk) => { body += chunk })
  req.on('end', () => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const params = Object.fromEntries(new URLSearchParams(body))
    const query = Object.fromEntries(url.searchParams)
    requests.push({ method: req.method, path: url.pathname, query, params })

    const send = (status, payload) => {
      const text = typeof payload === 'string' ? payload : JSON.stringify(payload)
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(text)
    }

    const path = url.pathname
    if (path === '/api/v2/torrents/info') return send(200, TORRENTS)
    if (path === '/api/v2/torrents/pause' && flags.pause404) return send(404, 'Not Found')
    if (path === '/api/v2/torrents/resume' && flags.resume404) return send(404, 'Not Found')
    if (path === '/api/v2/torrents/delete' && flags.delete404) return send(404, 'Not Found')
    // 其余写接口（pause/resume/stop/start/delete/setCategory/setLocation）都回 Ok.
    return send(200, 'Ok.')
  })
})

/** 最近一次打向某路径的请求（找不到返回 undefined） */
const lastTo = (path) => [...requests].reverse().find((r) => r.path === path)
const hitsOf = (path) => requests.filter((r) => r.path === path).length

const SAMPLE_HASH_A = TORRENTS[0].hash
const SAMPLE_HASH_B = TORRENTS[1].hash

const originalBase = config.qb.base
const originalKey = config.qb.apiKey

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const { port } = server.address()

try {
  /* ── 1. 没配 ─────────────────────────────────────────────────────────── */
  config.qb.base = ''
  config.qb.apiKey = ''
  check(qbControlReady() === false, '没配 base / apiKey → qbControlReady() false')

  let notConfigured = ''
  try {
    await listTasks()
  } catch (err) {
    notConfigured = `${err.code}|${err.message}`
  }
  check(
    notConfigured.startsWith('BAD_REQUEST') && /[\u4e00-\u9fa5]/.test(notConfigured),
    '没配时调用 → BAD_REQUEST 且说明是中文',
    notConfigured,
  )

  /* ── 2. 配好了（指向假服务）────────────────────────────────────────── */
  config.qb.base = `http://127.0.0.1:${port}`
  config.qb.apiKey = 'test'
  check(qbControlReady() === true, '配了 base + apiKey → qbControlReady() true')

  /* ── 3. 列表归一 ───────────────────────────────────────────────────── */
  const tasks = await listTasks()
  check(Array.isArray(tasks) && tasks.length === 2, 'listTasks 返回 2 条', `len=${tasks?.length}`)

  const first = tasks[0]
  check(first.progress === 0.42, 'progress 归一成 0..1 的小数', String(first.progress))
  check(first.size === 1048576000, 'size 是字节数（不被换成 MB/GiB）', String(first.size))
  check(first.downloaded === 440401920, 'downloaded 是字节数', String(first.downloaded))
  check(first.addedOn === 1700000000 * 1000, 'addedOn 秒级时间戳 → 毫秒', String(first.addedOn))
  check(first.eta === 3600 && first.etaText === '1 小时 00 分', 'eta 秒数 + 中文文案', `${first.eta} / ${first.etaText}`)
  check(first.stateText === '下载中', 'state=downloading → 「下载中」', first.stateText)
  check(first.savePath === '/downloads/anime/测试番/Season 01', 'save_path → savePath（原样，不改写）', first.savePath)

  check(tasks[1].eta === null && tasks[1].etaText === '—', 'eta=8640000（无限远）→ null + 占位', `${tasks[1].eta} / ${tasks[1].etaText}`)
  check(tasks[1].stateText === '做种中', 'state=uploading → 「做种中」', tasks[1].stateText)

  /* 进度越界要夹住：qB 实测会给 1.0000000001 */
  const clamped = normTask({ hash: 'x', progress: 1.0000000001, size: 1, added_on: 1 })
  check(clamped.progress === 1, 'progress > 1 时夹到 1（进度条不溢出）', String(clamped.progress))

  /* ── 4. filter 透传 ────────────────────────────────────────────────── */
  await listTasks({ filter: 'seeding' })
  check(lastTo('/api/v2/torrents/info')?.query.filter === 'seeding', 'filter 透传到 query', JSON.stringify(lastTo('/api/v2/torrents/info')?.query))

  /* ── 5. pause：hashes 用 | 连接 ────────────────────────────────────── */
  const paused = await pauseTasks([SAMPLE_HASH_A, SAMPLE_HASH_B])
  const pauseReq = lastTo('/api/v2/torrents/pause')
  check(
    pauseReq?.params.hashes === `${SAMPLE_HASH_A}|${SAMPLE_HASH_B}`,
    'pause 的 hashes 是 | 连接（不是数组 / 逗号）',
    String(pauseReq?.params.hashes),
  )
  check(paused.count === 2, 'pause 返回处理条数', String(paused.count))

  /* ── 6. resume：同样 | 连接 ────────────────────────────────────────── */
  await resumeTasks([SAMPLE_HASH_A])
  const resumeReq = lastTo('/api/v2/torrents/resume')
  check(resumeReq?.params.hashes === SAMPLE_HASH_A, 'resume 的 hashes 是 | 连接', String(resumeReq?.params.hashes))

  /* ── 7. delete：deleteFiles 显式发送 ───────────────────────────────── */
  await deleteTasks({ hashes: [SAMPLE_HASH_A], deleteFiles: true })
  check(lastTo('/api/v2/torrents/delete')?.params.deleteFiles === 'true', 'deleteFiles=true 时请求体带 deleteFiles=true', JSON.stringify(lastTo('/api/v2/torrents/delete')?.params))

  await deleteTasks({ hashes: [SAMPLE_HASH_B] })
  check(lastTo('/api/v2/torrents/delete')?.params.deleteFiles === 'false', '默认不删文件 → 显式发 deleteFiles=false', JSON.stringify(lastTo('/api/v2/torrents/delete')?.params))

  /* ── 8. 空 hashes ──────────────────────────────────────────────────── */
  const emptyCases = []
  for (const [label, fn] of [
    ['pauseTasks', () => pauseTasks([])],
    ['resumeTasks', () => resumeTasks([])],
    ['deleteTasks', () => deleteTasks({ hashes: [] })],
    ['setCategory', () => setCategory([], 'x')],
  ]) {
    try {
      await fn()
      emptyCases.push(`${label}: 没抛`)
    } catch (err) {
      const ok = err.code === 'BAD_REQUEST' && /[\u4e00-\u9fa5]/.test(err.message)
      emptyCases.push(`${label}: ${ok ? 'ok' : `${err.code}|${err.message}`}`)
    }
  }
  check(emptyCases.every((line) => line.endsWith('ok')), '空 hashes → BAD_REQUEST + 中文说明', emptyCases.join(' / '))

  /* 空数组不该产生任何请求 */
  const beforeEmpty = requests.length
  try { await pauseTasks([]) } catch { /* 预期 */ }
  check(requests.length === beforeEmpty, '空 hashes 时根本不发请求（不空打 qB）', `${requests.length - beforeEmpty} 次`)

  /* ── 9. pause 404 → 自动改用 stop（qB 5.x）─────────────────────────── */
  flags.pause404 = true
  const beforeStop = hitsOf('/api/v2/torrents/stop')
  let fallbackOk = false
  try {
    await pauseTasks([SAMPLE_HASH_A])
    fallbackOk = true
  } catch (err) {
    fallbackOk = false
    console.log(`    (fallback 抛了：${err.code}|${err.message})`)
  }
  check(fallbackOk, 'pause 回 404 → 自动改用 stop 且成功')
  check(hitsOf('/api/v2/torrents/stop') === beforeStop + 1, 'stop 被真的调用了一次', `${hitsOf('/api/v2/torrents/stop')}`)
  check(
    lastTo('/api/v2/torrents/stop')?.params.hashes === SAMPLE_HASH_A,
    'stop 带上了同一批 hashes',
    String(lastTo('/api/v2/torrents/stop')?.params.hashes),
  )

  /* resume 侧同理：/resume 回 404 时要能改用 /start */
  flags.pause404 = false
  flags.resume404 = true
  const beforeStart = hitsOf('/api/v2/torrents/start')
  let resumeFallback = false
  try {
    await resumeTasks([SAMPLE_HASH_B])
    resumeFallback = hitsOf('/api/v2/torrents/start') === beforeStart + 1
  } catch (err) {
    console.log(`    (resume fallback 抛了：${err.code}|${err.message})`)
  } finally {
    flags.resume404 = false
  }
  check(resumeFallback, 'resume 回 404 → 自动改用 start 且成功')

  /* ── 10. 删除 404 → NOT_FOUND ──────────────────────────────────────── */
  flags.delete404 = true
  let deleteCode = ''
  try {
    await deleteTasks({ hashes: [SAMPLE_HASH_A] })
  } catch (err) {
    deleteCode = `${err.code}|${err.message}`
  }
  flags.delete404 = false
  check(deleteCode.startsWith('NOT_FOUND'), '删除回 404 → NOT_FOUND（列表是旧的）', deleteCode)

  /* ── 11. setCategory / setLocation ─────────────────────────────────── */
  await setCategory([SAMPLE_HASH_A, SAMPLE_HASH_B], 'soraika-hub')
  const catReq = lastTo('/api/v2/torrents/setCategory')
  check(
    catReq?.params.hashes === `${SAMPLE_HASH_A}|${SAMPLE_HASH_B}` && catReq?.params.category === 'soraika-hub',
    'setCategory 带 hashes + category',
    JSON.stringify(catReq?.params),
  )

  await setLocation([SAMPLE_HASH_A], '/downloads/anime/新番/Season 01')
  const locReq = lastTo('/api/v2/torrents/setLocation')
  check(
    locReq?.params.hashes === SAMPLE_HASH_A && locReq?.params.location === '/downloads/anime/新番/Season 01',
    'setLocation 带 hashes + location',
    JSON.stringify(locReq?.params),
  )

  let locErr = ''
  try { await setLocation([SAMPLE_HASH_A], '  ') } catch (err) { locErr = `${err.code}|${err.message}` }
  check(locErr.startsWith('BAD_REQUEST'), '空目标路径 → BAD_REQUEST', locErr)

  /* ── 12. STATE_TEXT 覆盖 v5 的组合键 ───────────────────────────────── */
  check('downloading+stalled' in STATE_TEXT, 'STATE_TEXT 覆盖 downloading+stalled')
  check(STATE_TEXT['downloading+stalled'] === '下载中（无活动）', '组合键的中文写明「无活动」', STATE_TEXT['downloading+stalled'])

  const stalled = normTask({ hash: 'z', state: 'downloading+stalled', progress: 0.1 })
  check(stalled.stateText === '下载中（无活动）', 'normTask 能翻 downloading+stalled', stalled.stateText)

  for (const key of ['error', 'missingFiles', 'uploading', 'uploading+stalled', 'queuedUP', 'pausedUP',
    'stoppedUP', 'checkingUP', 'allocating', 'forciblyPausedUp', 'downloading', 'queuedDL', 'pausedDL',
    'stoppedDL', 'checkingDL', 'allocatingDL', 'metaDL', 'forcedMetaDL', 'forciblyPausedDL', 'moving',
    'unknown', 'stalledUP', 'stalledDL']) {
    if (!(key in STATE_TEXT)) check(false, `STATE_TEXT 缺 ${key}`)
  }
  check(
    ['error', 'missingFiles', 'uploading', 'uploading+stalled', 'queuedUP', 'pausedUP', 'stoppedUP',
      'checkingUP', 'allocating', 'forciblyPausedUp', 'downloading', 'queuedDL', 'pausedDL', 'stoppedDL',
      'checkingDL', 'allocatingDL', 'metaDL', 'forcedMetaDL', 'forciblyPausedDL', 'moving', 'unknown',
      'stalledUP', 'stalledDL'].every((k) => typeof STATE_TEXT[k] === 'string' && /[\u4e00-\u9fa5]/.test(STATE_TEXT[k])),
    'STATE_TEXT 全表都是中文（不留英文键名）',
  )
  check(normTask({ hash: 'y', state: '不存在的状态' }).stateText === '未知状态', '认不出的状态 → 「未知状态」')

  /* ── 13. 钩子存在（不做实现，但不能炸）──────────────────────────────── */
  check(typeof clearQbCache === 'function' && clearQbCache() === 0, 'clearQbCache 可调用且无副作用')
} finally {
  config.qb.base = originalBase
  config.qb.apiKey = originalKey
  await new Promise((resolve) => server.close(resolve))
}

console.log(failed ? `\n✗ 失败 ${failed} 项` : '\n✓ 全部通过')
process.exit(failed ? 1 : 0)
