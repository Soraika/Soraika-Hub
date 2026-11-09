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
  const aiPromptSource = readFileSync(new URL('../src/api/ai/prompts.js', import.meta.url), 'utf8')
  const aiSharedSource = readFileSync(new URL('../src/api/ai/shared.js', import.meta.url), 'utf8')
  const aiRoutSource = readFileSync(new URL('../src/rout/ai.js', import.meta.url), 'utf8')
  const aiPromptData = JSON.parse(readFileSync(new URL('../src/api/ai/prompts.json', import.meta.url), 'utf8'))
  const aiAllSource = [aiPageSource, aiPromptSource, aiSharedSource].join('\n')

  /* 提示词是**数据**：四个能力各一段，都在 prompts.json 里，代码里不许再硬编码 */
  const promptKeys = ['bundle', 'series', 'format', 'groupTags']
  check(
    promptKeys.every((k) => aiPromptData[k]?.system && aiPromptData[k].system.length > 100),
    `四个能力的提示词都在 prompts.json 里（${promptKeys.join(' / ')}）`,
  )
  check(
    aiPromptData.bundle.version === 'v7',
    `合并调用版本 v7（数据里带版本，改 prompt 不必改代码）→ ${aiPromptData.bundle?.version}`,
  )
  const bundlePrompt = String(aiPromptData.bundle.system || '')
  check(
    ['"tags"', '"rawName"', '"episodes"'].every((k) => bundlePrompt.includes(k)) &&
      !/你是动漫资源文件名解析专家/.test(aiPageSource),
    '一次 prompt 同时产 tags / rawName / season / episodes；**代码里没有硬编码提示词**',
  )
  check(
    /mtimeOf\(/.test(aiPromptSource) && /data[\\/]prompts\.json|\.\.\/\.\.\/\.\.\/data/.test(aiPromptSource),
    '提示词可被 data/prompts.json 覆盖，按 mtime 热加载（改完不用重启）',
  )
  check(
    /aiRouter\.get\('\/ai\/prompts'/.test(aiRoutSource) && /aiRouter\.put\('\/ai\/prompts'/.test(aiRoutSource),
    '提示词有读写接口（/api/ai/prompts）—— 后面设置页/画板直接改，不用动源码',
  )
  /* 改提示词 → hash 变 → 缓存自然失效（不需要谁记得升版本号） */
  check(
    /promptHashOf\('bundle'\)/.test(aiPageSource) &&
      /promptHashOf\('format'\)/.test(aiPageSource) &&
      /promptHashOf\('groupTags'\)/.test(aiPageSource) &&
      /config\.ai\.model/.test(aiPageSource),
    '缓存 key 带「模型 + 提示词内容 hash + 内容」—— 换模型/改提示词都不会命中旧结果',
  )
  /* 修订版标签的 type 必须是 version（早先 TYPE_ORDER 里写成 revision，排序会 NaN） */
  check(
    /TYPE_ORDER = \{ version: 0/.test(aiSharedSource),
    'TYPE_ORDER 用 `version`（与生成的标签 type 一致，排序不会失效）',
  )
  check(
    /function dropCovered\(tags\)/.test(aiSharedSource) && /const tags = dropCovered\(/.test(aiPageSource),
    '标签去重：去掉「被别的标签覆盖」的冗余项（HEVC-10bit 之于 HEVC、简繁内封字幕 之于 简繁内封）',
  )
  check(
    /const batches = chunk\(list, batchSize\)/.test(aiPageSource) &&
      /mapLimit\(batches, limit/.test(aiPageSource) &&
      /config\.ai\.concurrency/.test(aiPageSource) &&
      !/list\.slice\(0, config\.ai\.maxTitles\)/.test(aiPageSource),
    '全量分批（标签与集数共用），批间并发按「并发上限」配置 —— 不再截断成"只分析前 N 条"',
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
    '解析时带上作品上下文（番剧名 / 季）——模型得知道在分析什么',
  )
  check(
    /tagCache\.set\(key, result\)/.test(aiPageSource) && /episodeCache\.set\(key, result\)/.test(aiPageSource),
    '同一份结果写进两个缓存（标签 30m / 集数 24h），各自按自己的 TTL 命中',
  )
  /* 并发合流：面板会同时发 tags + episodes 两个请求，算的是同一个 bundle ——
     不合流就是**两次模型调用**（实测日志成对出现：5466ms + 5546ms，同一批 36 条）。 */
  check(
    /const inflight = new Map\(\)/.test(aiPageSource) &&
      /const running = inflight\.get\(key\)/.test(aiPageSource) &&
      /inflight\.set\(key, task\)/.test(aiPageSource) &&
      /inflight\.delete\(key\)/.test(aiPageSource),
    '同 key 的在途请求**合流**（一个去问模型，其它搭车）—— 不会并发打两次模型',
  )

  /* 单批条数直接决定等待时间：模型是逐 token 吐的，一批 120 条实测 18.7s；
     切成 40 条一批、批间并发后同样的量 ~7s（实测）。这个值被改大就等于把速度改慢。 */
  const configSource = readFileSync(new URL('../src/config.js', import.meta.url), 'utf8')
  check(
    /maxTitles: 40[,]?/.test(configSource) && /concurrency: 3/.test(configSource),
    '单批 40 条 × 并发 3（批小一点并发才用得上；120 条一批实测 18.7s → 40 条一批约 7s）',
  )

  /* ── 提示词接口：提示词是**数据**，读得到、写得进、能恢复 ──────────────── */
  const prompts0 = (await call('GET', '/api/ai/prompts')).body?.data
  check(
    prompts0?.keys?.length === 4 && Boolean(prompts0.prompts?.bundle?.hash),
    `GET /api/ai/prompts → 4 段 + 每段内容 hash（source=${prompts0?.source}）`,
  )
  check(
    Object.values(prompts0?.prompts || {}).every((p) => typeof p.system === 'string' && p.system.length > 100),
    '接口能读到完整提示词正文（不用翻源码）',
  )
  if (prompts0?.source === 'default') {
    // 只在没有用户覆盖时才做写测试（不能把人家自己的覆盖文件删了）
    try {
      const before = prompts0.prompts.series.hash
      const put = await call('PUT', '/api/ai/prompts', {
        prompts: { series: { system: `${prompts0.prompts.series.system}\n（验收临时改动：${Date.now()}）` } },
      })
      check(put.body?.data?.source === 'override', `PUT 写入覆盖 → source=${put.body?.data?.source}`)
      const after = (await call('GET', '/api/ai/prompts')).body?.data
      check(
        after?.source === 'override' && after.prompts.series.hash !== before,
        '热加载生效：来源变 override、内容 hash 变了（缓存随之失效，不用重启）',
      )
      const bad = await call('PUT', '/api/ai/prompts', { prompts: { bundle: { system: '' } } })
      check(bad.res.status === 400, '空提示词被拒绝（400）—— 不拿空 prompt 污染缓存')
    } finally {
      const reset = await call('PUT', '/api/ai/prompts', { prompts: null })
      check(reset.body?.data?.source === 'default', 'PUT prompts:null → 回退出厂默认（验收不留文件）')
    }
  } else {
    console.log(`· 已有提示词覆盖文件（source=${prompts0?.source}）→ 跳过写入测试，不动你的文件`)
  }

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

      /* 并发合流：面板就是**同时**发 tags + episodes（同一番名 + 同一批文件名）。
         不合流 = 两次模型调用；合流 = 日志里只多一条 `ai.bundle ok`。 */
      const stamp = Date.now()
      const freshName = `并发测试${stamp}`
      const fresh = [`[LoliHouse] ${freshName} - 01 [1080P][简繁]`, `[LoliHouse] ${freshName} - 02 [1080P][简繁]`]
      const countBundle = () => logs.join('').split('ai.bundle ok').length - 1
      const before = countBundle()
      const [tagP, epP] = await Promise.all([
        call('POST', '/api/ai/classify/tags', { titles: fresh, animeTitle: freshName }),
        call('POST', '/api/ai/classify/episodes', { title: freshName, titles: fresh }),
      ])
      // 子进程 stdout 是异步写的：等它把日志吐出来再数（最多 3 秒）
      for (let i = 0; i < 30 && countBundle() - before < 1; i++) await new Promise((r) => setTimeout(r, 100))
      // 再多等一会儿：如果真打了两次，第二条也会在这段时间里出现
      await new Promise((r) => setTimeout(r, 600))
      const calls = countBundle() - before
      check(
        tagP.body?.data?.analyzed === 2 && epP.body?.data?.analyzed === 2,
        `并行两个入口都拿到结果（tags ${tagP.body?.data?.analyzed} / episodes ${epP.body?.data?.analyzed}）`,
      )
      check(calls === 1, `同 key 的并行请求只问模型 **1** 次（实测 ${calls} 次）`)
      check(
        [tagP, epP].filter((r) => r.body?.data?.cached === true).length === 1,
        '搭车的那一个回报 cached=true（不是重新算的）',
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
