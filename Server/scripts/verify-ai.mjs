/**
 * AI 能力验收 —— 清单 / 调用入口 / 降级路径（有没有 key 都能跑）
 * ---------------------------------------------------------------------------
 * 用法：由 `npm run verify` 串联执行，也可单独 `node --env-file-if-exists=.env scripts/verify-ai.mjs`
 * 隔离：独立端口（默认 3303，可用 VERIFY_AI_PORT 覆盖）
 * 两种模式（**以服务端 /api/ai/tools 的 enabled 为准** —— key 可能在 .env，
 * 也可能是在设置页里填、存进库的，所以不能只看 process.env）：
 *   · 未启用：验「清单可用 + 调用明确回 AI_DISABLED + 入参校验」
 *   · 已启用：额外真跑一次标签解析（会消耗一次 AI 调用），验结果形状与缓存命中
 */
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'

const PORT = Number(process.env.VERIFY_AI_PORT || 3303)
const base = `http://127.0.0.1:${PORT}`

let failed = 0
const check = (ok, msg) => {
  if (!ok) failed++
  console.log(`${ok ? '✓' : '✗'} ${msg}`)
}

const logs = []
const child = spawn(process.execPath, ['--env-file-if-exists=.env', 'src/index.js'], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
})
child.stdout.on('data', (d) => logs.push(String(d)))
child.stderr.on('data', (d) => logs.push(String(d)))

const call = async (method, path, body) => {
  const res = await fetch(base + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  let json = null
  try {
    json = await res.json()
  } catch {
    /* 非 JSON */
  }
  return { res, body: json }
}

const waitReady = async () => {
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) return
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error('服务没起来')
}

try {
  await waitReady()

  /* ── 看板里能看到 AI 状态（不带 key）────────────────────────────────── */
  const health = (await call('GET', '/api/health')).body?.data
  check(typeof health?.ai?.enabled === 'boolean', `health 暴露 AI 状态 → enabled=${health?.ai?.enabled}`)
  check(!JSON.stringify(health?.ai).includes('apiKey'), 'health 里没有泄漏 key')

  /* ── 工具清单（MCP tools/list 形状）─────────────────────────────────── */
  const tools = (await call('GET', '/api/ai/tools')).body?.data
  const aiEnabled = tools?.enabled === true
  check(typeof tools?.enabled === 'boolean', `清单回报 enabled → ${tools?.enabled}`)
  check(
    health?.ai?.enabled === aiEnabled,
    `health 与 /api/ai/tools 的 AI 状态口径一致（都在看同一份配置）→ ${aiEnabled}`,
  )
  check(Array.isArray(tools?.tools) && tools.tools.length >= 2, `工具清单有 ${tools?.tools?.length} 个工具`)
  check(
    tools.tools.every(
      (t) =>
        typeof t.name === 'string' &&
        typeof t.description === 'string' &&
        t.description.length > 10 &&
        t.inputSchema?.type === 'object' &&
        Array.isArray(t.inputSchema.required),
    ),
    '每个工具都有 name / description / inputSchema（MCP 必需字段）',
  )
  check(tools.tools.some((t) => t.name === 'anime_release_tags'), '清单里有 anime_release_tags')
  check(tools.tools.some((t) => t.name === 'anime_episode_meta'), '清单里有 anime_episode_meta')

  /* ── 入参校验（与有没有 key 无关，先失败先说清）──────────────────────── */
  const noTitles = await call('POST', '/api/ai/classify/tags', {})
  check(noTitles.res.status === 400 && noTitles.body?.error?.code === 'BAD_REQUEST', '缺 titles → 400 / BAD_REQUEST')
  const badTitles = await call('POST', '/api/ai/classify/tags', { titles: 'not-an-array' })
  check(badTitles.res.status === 400, 'titles 不是数组 → 400')
  const emptyTitles = await call('POST', '/api/ai/classify/tags', { titles: ['  '] })
  check(emptyTitles.res.status === 400, 'titles 全是空白 → 400')

  const unknownTool = await call('POST', '/api/ai/call', { name: 'not_a_tool', arguments: {} })
  check(unknownTool.res.status === 404 && unknownTool.body?.error?.code === 'NOT_FOUND', '未知工具 → 404 / NOT_FOUND')

  /* ── 模型列表（设置页「模型」下拉的数据源）─────────────────────────── */
  const modelsRes = await call('GET', '/api/ai/models')
  if (!aiEnabled) {
    check(
      modelsRes.res.status === 501 && modelsRes.body?.error?.code === 'AI_DISABLED',
      '未启用时取模型列表 → 501 / AI_DISABLED（不是 500）',
    )
  } else if ([502, 504].includes(modelsRes.res.status)) {
    // 上游抖动不该让验收变红：模型列表只是便利功能，前端取不到会回落成手动输入
    console.log(`· 模型列表暂时取不到（HTTP ${modelsRes.res.status}）→ 跳过这一条`)
  } else {
    check(
      modelsRes.res.ok && Array.isArray(modelsRes.body?.data?.models),
      `模型列表可用 → ${modelsRes.body?.data?.models?.length ?? 0} 个`,
    )
  }
  check(Array.isArray(unknownTool.body?.error?.detail?.available), '未知工具的错误里列出可用工具名')
  const missingName = await call('POST', '/api/ai/call', {})
  check(missingName.res.status === 400, '缺少 name → 400')

  /* ── 能力层静态检查：改了 prompt 却不升版本，会被缓存挡住（看起来「提示词没生效」）── */
  const aiPageSource = readFileSync(new URL('../src/api/pages/ai.js', import.meta.url), 'utf8')
  check(/TAG_PROMPT_VERSION = 'v6'/.test(aiPageSource), '提示词版本是 v6（禁掉修版信息，避免与本地规则出的重复）')
  check(
    /function dropCovered\(tags\)/.test(aiPageSource) && /const tags = dropCovered\(/.test(aiPageSource),
    '标签去重：去掉「被别的标签覆盖」的冗余项（HEVC-10bit 之于 HEVC、简繁内封字幕 之于 简繁内封）',
  )
  check(
    /const batches = chunk\(list, batchSize\)/.test(aiPageSource) &&
      /mapLimit\(batches, limit/.test(aiPageSource) &&
      /config\.ai\.concurrency/.test(aiPageSource) &&
      !/list\.slice\(0, config\.ai\.maxTitles\)/.test(aiPageSource),
    '标签解析**全量分批**，批间并发按「并发上限」配置 —— 不再截断成"只分析前 N 条"',
  )
  check(
    /const batches = chunk\(list, EPISODE_BATCH\)/.test(aiPageSource) &&
      !/pickTitles/.test(aiPageSource) &&
      /mapLimit\(batches, limit/.test(aiPageSource),
    '集数解析同样**全量分批**，批间并发按「并发上限」配置（旧版 pickTitles 会截断成前 120 条）',
  )
  /* 缓存 TTL 要跟着配置走：传**函数**而不是死值 ——
     缓存实例是模块加载时建的，传死值的话设置页改完不生效（要重启进程）。 */
  const memSource = readFileSync(new URL('../src/cache/mem.js', import.meta.url), 'utf8')
  check(
    /typeof ttlMs === 'function' \? ttlMs\(\) : ttlMs/.test(memSource) &&
      /ttlMs: \(\) => config\.ai\.tagCacheTtlMs/.test(aiPageSource) &&
      /ttlMs: \(\) => config\.ai\.episodeCacheTtlMs/.test(aiPageSource),
    '缓存时长**热生效**（ttlMs 传函数，每次写入按当下配置取值）—— 改完不用重启',
  )
  check(
    /animeTitle/.test(aiPageSource) && /const context = \[animeTitle/.test(aiPageSource),
    '解析标签时带上作品上下文（番剧名 / 季）——模型得知道在分析什么',
  )
  check(
    /eps:\$\{EPISODE_PROMPT_VERSION\}/.test(aiPageSource),
    '集数缓存 key 也带提示词版本（同一个坑不踩第二次）',
  )

  /* ── 降级：没启用时调用要明确说「未配置」───────────────────────────── */
  const sample = ['[LoliHouse] 番名 - 01 [1080P][简繁][HEVC]', '[LoliHouse] 番名 - 02 [1080P][简繁][HEVC]']
  if (!aiEnabled) {
    const tagRes = await call('POST', '/api/ai/classify/tags', { titles: sample })
    check(
      tagRes.res.status === 501 && tagRes.body?.error?.code === 'AI_DISABLED',
      `没启用 AI → 501 / AI_DISABLED（不是 500，也不是假装成功）`,
    )
    check(/AI_API_KEY/.test(tagRes.body?.error?.message || ''), '错误信息里点明了去哪填 key')
    const callRes = await call('POST', '/api/ai/call', { name: 'anime_release_tags', arguments: { titles: sample } })
    check(callRes.res.status === 501 && callRes.body?.error?.code === 'AI_DISABLED', '/ai/call 同样回 AI_DISABLED')
  } else {
    /* ── 已启用：真跑一次，验结果与缓存（上游抖动时只提示，不算失败）────── */
    console.log('· 服务端已配置 AI（.env 或设置页）→ 真跑一次标签解析（会消耗一次调用）')
    const first = await call('POST', '/api/ai/classify/tags', { titles: sample })

    if ([502, 504].includes(first.res.status)) {
      console.log(`· 上游暂时不可用（HTTP ${first.res.status}）→ 跳过真跑断言：${first.body?.error?.message ?? ''}`)
    } else {
      const data = first.body?.data
      check(first.res.ok && Array.isArray(data?.tags), `标签解析返回 ${data?.tags?.length} 个标签（model=${data?.model}）`)
      check(data?.cached === false, '第一次不是缓存命中')
      check(
        data.tags.every((t) => typeof t.name === 'string' && t.name && Array.isArray(t.match) && t.match.length > 0),
        '每个标签都有 name 与 match[]',
      )
      check(
        data.tags.every((t) => ['batch', 'res', 'codec', 'sub', 'source', 'other'].includes(t.type)),
        '标签 type 都在约定取值里',
      )
      check(!data || !('info' in data), '返回里没有 info（整批概括那部分不再由 AI 负责）')
      const second = await call('POST', '/api/ai/classify/tags', { titles: sample })
      check(second.body?.data?.cached === true, '同一批文件名第二次命中缓存（不重复烧钱）')

      const viaCall = await call('POST', '/api/ai/call', { name: 'anime_release_tags', arguments: { titles: sample } })
      check(
        viaCall.body?.data?.isError === false && typeof viaCall.body?.data?.content?.[0]?.text === 'string',
        '/ai/call 返回 MCP 形状（content[] + structured）',
      )
    }
  }

  console.log(failed ? `\n✗ 失败 ${failed} 项` : '\n✓ 全部通过')
  process.exitCode = failed ? 1 : 0
} catch (err) {
  console.error('\n✗ 验收中断：', err.message)
  console.error(logs.join('').slice(-1500))
  process.exitCode = 1
} finally {
  child.kill()
}
