/**
 * 设置接口验收 —— 读写 / 校验 / 重置 / 导出 / 导入 + 密钥不外泄
 * ---------------------------------------------------------------------------
 * 用法：由 `npm run verify` 串联执行，也可单独 `node --env-file-if-exists=.env scripts/verify-settings.mjs`
 * 隔离：独立端口（默认 3304）+ **独立库文件**（data/tmp-verify-settings.db，跑完删除）——
 *       这个脚本会真的写设置，绝不能拿 data/hub.db 试。
 * 覆盖：
 *   · 清单形状 / 密钥只回「配没配 + 打码」，绝不回明文
 *   · 保存后立即生效（同一进程内读 config 就是新值）+ health 里的派生项跟着变
 *   · 非法值整批拒绝（带着「哪一项错了」的 detail）
 *   · 单项重置 / 全部重置（回落 .env 默认值）
 *   · 导出默认脱敏、显式要才带密钥；导入 merge / 非法整包拒绝 / 未知项忽略
 */
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { rmSync } from 'node:fs'
import { once } from 'node:events'

const PORT = Number(process.env.VERIFY_SETTINGS_PORT || 3304)
const base = `http://127.0.0.1:${PORT}`
const DB_FILE = 'data/tmp-verify-settings.db'

let failed = 0
const check = (ok, msg) => {
  if (!ok) failed++
  console.log(`${ok ? '✓' : '✗'} ${msg}`)
}

const logs = []
const child = spawn(process.execPath, ['--env-file-if-exists=.env', 'src/index.js'], {
  env: { ...process.env, PORT: String(PORT), DB_FILE },
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
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    /* 导出接口返回的是 JSON 文本，也能 parse；其它非 JSON 就留空 */
  }
  return { res, body: json, text }
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

const fieldOf = (settings, path) => settings.fields.find((f) => f.path === path)

try {
  await waitReady()

  /* ── 清单 ──────────────────────────────────────────────────────────── */
  const settings = (await call('GET', '/api/settings')).body?.data
  check(Array.isArray(settings?.groups) && settings.groups.length >= 4, `分组 ${settings?.groups?.length} 个`)
  check(settings.fields.length >= 25, `可配置项 ${settings.fields.length} 个`)
  check(
    settings.fields.every((f) => f.path && f.label && f.type && f.group),
    '每项都有 path / label / type / group',
  )
  check(
    settings.readonly.some((f) => f.path === 'port') && settings.readonly.some((f) => f.path === 'dbFile'),
    '端口与库文件是只读展示（不让人在界面改）',
  )

  const secretField = settings.fields.find((f) => f.type === 'secret')
  check(secretField.value === null && 'hasValue' in secretField, `密钥项不回明文 → ${secretField.path}`)

  /* ── 「必要项」的判定：不填就用不了 / 必须按环境改的才常显，其余一律折叠 ──
     这条断言是防膨胀用的：以后谁往常显里塞"调参项"，这里会直接红。 */
  const corePaths = settings.fields.filter((f) => !f.advanced).map((f) => f.path)
  check(
    corePaths.length <= 8 &&
      corePaths.every((p) => /^(mikan\.base|ai\.(baseUrl|apiKey|model)|worker\.dailyAt|qb\.(base|apiKey))$/.test(p)),
    `基础层就是必要配置那几项 → ${corePaths.join(' / ')}`,
  )
  check(
    settings.fields
      .filter((f) => ['bgm.base', 'bgm.token', 'image.dir'].includes(f.path))
      .every((f) => f.advanced),
    '有默认值、不填也能跑的项（Bangumi 接口/Token、落盘目录）都收进微调参数',
  )
  const leaked = JSON.stringify(settings).match(/sk-|Bearer/)
  check(!leaked, '整包里没有密钥痕迹')

  /* ── 静默补齐：覆盖模型（只存改过的）+ 启动时补全 —— 库里应是整份配置，而不是零星几条 ──
     为什么要有这条：只存改过的项时，刚装好打开库往往只有 AI 那几条，看着像「设置没存进去」。
     现在启动时会把「库里还没有的项」用当前生效值静默写一遍（密钥除外）。 */
  const fillable = settings.fields.filter((f) => f.type !== 'secret' && f.value !== null && f.value !== '')
  check(
    settings.overridden.length >= fillable.length,
    `启动后库里已是整份配置 → ${settings.overridden.length} 项覆盖 / ${fillable.length} 项有值（其余是空值，不写）`,
  )
  check(
    !settings.overridden.includes(secretField.path),
    '密钥不参与静默补齐（不回显的东西不该由系统替人写一份）',
  )

  /* ── 文案契约：不写死厂商、说明只留「不知道就会配错」的语义 ──────────── */
  check(
    settings.fields.every((f) => !/deepseek|openai/i.test(f.hint || '')),
    '清单的说明里不写死厂商（换供应商不用改文案）',
  )
  check(
    settings.fields.every((f) => (f.hint || '').length <= 20),
    `说明都很短（≤20 字）→ 最长 ${Math.max(...settings.fields.map((f) => (f.hint || '').length))} 字`,
  )
  check(
    settings.fields.every((f) => f.type !== 'number' || Boolean(f.unit)),
    '每个数值项都带单位（单位是字段语义的一部分）',
  )
  check(
    settings.fields.every((f) => f.default !== undefined),
    '每项都下发默认值（输入框空着时用它当示例）',
  )
  check(
    settings.fields.some((f) => f.advanced) && settings.fields.some((f) => !f.advanced),
    `清单区分基础/高级项 → 高级 ${settings.fields.filter((f) => f.advanced).length} 项 / 基础 ${settings.fields.filter((f) => !f.advanced).length} 项`,
  )
  check(
    settings.fields.filter((f) => f.format === 'duration').length > 0,
    `时长类字段带 format=duration → ${settings.fields.filter((f) => f.format === 'duration').length} 项（前端换算成「30 分钟」）`,
  )
  /* 单位语义：`format: 'duration'` 的含义是「**值是毫秒**」，只能挂在 `*Ms` 这类项上。
     挂到「值是小时/秒」的项上会出真问题：界面按毫秒显示（24 小时 → 显示成 `24ms`），
     单位下拉也会被推成 ms，用户一改单位就把值放大成天文数字（3 小时 → 10800000 小时）。
     这条断言就是为了钉住这个坑：**以后新增时长项，值是毫秒才挂 duration**。 */
  const durationPaths = settings.fields.filter((f) => f.format === 'duration').map((f) => f.path)
  check(
    durationPaths.every((p) => /Ms$/.test(p)),
    `duration 只给「值是毫秒」的项（*Ms）→ ${durationPaths.join(' / ')}`,
  )
  check(
    !durationPaths.includes('worker.missRetryHours') && !durationPaths.includes('image.maxAgeSec'),
    '「放弃后重试间隔（小时）」「浏览器缓存（秒）」不挂 duration（否则被当毫秒换算）',
  )
  /* 缓存时长必须**改完立即生效**：缓存实例是模块加载时创建的长生命周期对象，
     传死 ttl 就变成"保存成功、实际一直用旧值"（必须重启进程才生效）。 */
  const ttlFields = settings.fields.filter((f) => /TtlMs$/.test(f.path))
  check(
    ttlFields.length >= 2 && ttlFields.every((f) => !f.restart),
    `缓存时长项不要求重启（${ttlFields.map((f) => f.path).join(' / ')}）—— 保存即生效`,
  )

  /* 测试连接的判定**按服务定**，不是「状态码 200 就算通」：
     AI 要真调一次模型、下载要真拿到版本号 —— 源码级钉住，避免以后被改回「看状态码」。 */
  const settingsPageSource = readFileSync(new URL('../src/api/pages/settings.js', import.meta.url), 'utf8')
  check(
    /async function testAi\(/.test(settingsPageSource) &&
      /chat\/completions/.test(settingsPageSource) &&
      /max_tokens: 1/.test(settingsPageSource),
    'AI 测试连接**真调一次模型**（最小 chat + max_tokens:1），不是只看 /models 的 200',
  )
  check(
    /async function testQb\(/.test(settingsPageSource) &&
      /app\/version/.test(settingsPageSource) &&
      /\^v\?\\d\+\\\.\\d\+/.test(settingsPageSource),
    '下载测试连接按 **version 的返回**判断（要真拿到 `v5.1.2`，未认证的 403 不算通）',
  )
  check(
    Array.isArray(settings.aiProviders) && settings.aiProviders.length >= 5,
    `下发供应商预设 ${settings.aiProviders?.length} 条（选中即填接口地址）`,
  )
  check(
    settings.aiProviders.every((p) => typeof p.name === 'string' && /^https?:\/\//.test(p.baseUrl)),
    '供应商预设都有名称与可用地址',
  )

  /* ── 保存 → 立即生效 ───────────────────────────────────────────────── */
  const saved = await call('PUT', '/api/settings', { values: { 'worker.gapMs': 777 } })
  check(saved.res.ok && saved.body?.data?.applied?.includes('worker.gapMs'), '保存成功并回报 applied')
  const after1 = saved.body.data.settings
  check(fieldOf(after1, 'worker.gapMs').value === 777, '保存后返回的就是新值')
  check(after1.overridden.includes('worker.gapMs'), '被覆盖的项出现在 overridden 里')
  const reread = (await call('GET', '/api/settings')).body?.data
  check(fieldOf(reread, 'worker.gapMs').value === 777, '再读一遍仍是新值（已落库 + 已应用）')

  /* ── 校验：整批拒绝，并指出是哪一项 ────────────────────────────────── */
  const badUrl = await call('PUT', '/api/settings', { values: { 'mikan.base': 'not-a-url' } })
  check(badUrl.res.status === 400 && badUrl.body?.error?.code === 'BAD_REQUEST', '非法 URL → 400')
  check(badUrl.body?.error?.detail?.errors?.[0]?.path === 'mikan.base', '错误里点明是哪一项')
  const badTime = await call('PUT', '/api/settings', { values: { 'worker.dailyAt': '25:00' } })
  check(badTime.res.status === 400, '非法时刻 → 400')
  const unknown = await call('PUT', '/api/settings', { values: { 'nope.field': 1 } })
  check(unknown.res.status === 400, '未知配置项 → 400')
  const empty = await call('PUT', '/api/settings', { values: {} })
  check(empty.res.status === 400, '空 values → 400')
  const badBody = await call('PUT', '/api/settings', { values: [] })
  check(badBody.res.status === 400, 'values 不是对象 → 400')
  // 校验失败不该动到已保存的值
  check(
    fieldOf((await call('GET', '/api/settings')).body.data, 'worker.gapMs').value === 777,
    '校验失败不影响已保存的值',
  )

  /* ── 密钥：写进去 → 不回明文 → 派生项生效 ───────────────────────────── */
  await call('PUT', '/api/settings', { values: { 'ai.apiKey': 'sk-verify-1234567890' } })
  const withKey = (await call('GET', '/api/settings')).body?.data
  const keyField = fieldOf(withKey, 'ai.apiKey')
  check(keyField.value === null && keyField.hasValue === true, '密钥写入后只回「已配置」')
  check(keyField.preview.includes('…') && !keyField.preview.includes('1234567890'), `打码预览 → ${keyField.preview}`)
  const health = (await call('GET', '/api/health')).body?.data
  check(health?.ai?.enabled === true, '填了 key 后 health 里 ai.enabled 立刻变 true（派生项）')
  check(!JSON.stringify(health).includes('sk-verify'), 'health 里也没有密钥')

  /* ── 重置：单项 → 回落默认；全部 → overridden 清空 ─────────────────── */
  const reset1 = await call('POST', '/api/settings/reset', { paths: ['worker.gapMs'] })
  check(reset1.res.ok && !reset1.body.data.settings.overridden.includes('worker.gapMs'), '单项重置后不再是被覆盖状态')
  check(fieldOf(reset1.body.data.settings, 'worker.gapMs').value === 350, '单项重置回落默认值（350）')

  const resetAll = await call('POST', '/api/settings/reset', { paths: [] })
  check(resetAll.body?.data?.settings?.overridden?.length === 0, '全部重置后 overridden 为空')
  check((await call('GET', '/api/health')).body?.data?.ai?.enabled === false, '重置掉 key 后 ai.enabled 回 false')

  /* ── 测试连接（设置页每行右边的插头按钮）───────────────────────────── */
  // 拿「自己的健康检查」当被测目标：不需要外网，状态码也确定是 200
  await call('PUT', '/api/settings', { values: { 'mikan.base': `${base}/api/health` } })
  const testOk = await call('POST', '/api/settings/test', { path: 'mikan.base' })
  check(
    testOk.res.ok && testOk.body?.data?.ok === true && testOk.body.data.status === 200,
    `连通时回报 ok → ${testOk.body?.data?.status} / ${testOk.body?.data?.ms}ms`,
  )
  check(typeof testOk.body?.data?.target === 'string', `回报里带上实际请求的地址 → ${testOk.body?.data?.target}`)

  const testDead = await call('POST', '/api/settings/test', {
    path: 'mikan.base',
    value: 'http://127.0.0.1:1', // 没人监听的端口
  })
  check(
    testDead.res.ok && testDead.body?.data?.ok === false,
    `连不上时 ok=false（不抛错）→ ${testDead.body?.data?.reason?.slice(0, 60)}`,
  )
  check(testDead.body?.data?.ms >= 0, '连不上也回报耗时')

  const testBadType = await call('POST', '/api/settings/test', { path: 'ai.maxTokens' })
  check(
    testBadType.res.status === 400 && testBadType.body?.error?.code === 'BAD_REQUEST',
    `非地址类配置项不能测连接 → ${testBadType.res.status} / ${testBadType.body?.error?.message}`,
  )
  const testUnknown = await call('POST', '/api/settings/test', { path: 'nope.path' })
  check(
    testUnknown.res.status === 404 && testUnknown.body?.error?.code === 'NOT_FOUND',
    `未知配置项 → ${testUnknown.res.status} / ${testUnknown.body?.error?.message}`,
  )
  const testBadValue = await call('POST', '/api/settings/test', { path: 'mikan.base', value: '不是地址' })
  check(
    testBadValue.res.status === 400,
    `地址非法 → ${testBadValue.res.status}（先校验再发请求：${testBadValue.body?.error?.message}）`,
  )
  const testNoPath = await call('POST', '/api/settings/test', {})
  check(testNoPath.res.status === 400, '缺 path → 400')

  /* ── 导出：默认脱敏，显式要才带密钥 ────────────────────────────────── */
  await call('PUT', '/api/settings', { values: { 'ai.apiKey': 'sk-verify-abcdefgh', 'cacheTtlMs': 123456 } })
  const exported = await call('GET', '/api/settings/export')
  check(/attachment/.test(exported.res.headers.get('content-disposition') || ''), '导出走附件下载（带文件名）')
  check(exported.body?.kind === 'soraikahub-settings' && exported.body?.version === 1, '导出文件带 kind / version')
  check(exported.body.includesSecrets === false, '默认脱敏')
  check(!('ai.apiKey' in exported.body.values) && !exported.text.includes('sk-verify'), '脱敏导出里没有密钥')
  check(exported.body.values['cacheTtlMs'] === 123456, '非密钥项照常导出')

  const exportedWithSecrets = await call('GET', '/api/settings/export?secrets=1')
  check(exportedWithSecrets.body.values['ai.apiKey'] === 'sk-verify-abcdefgh', '?secrets=1 才带上密钥')
  check(/with-secrets/.test(exportedWithSecrets.res.headers.get('content-disposition') || ''), '带密钥的文件名有标记（免得发错）')

  /* ── 导入 ──────────────────────────────────────────────────────────── */
  await call('POST', '/api/settings/reset', { paths: [] })
  const importRes = await call('POST', '/api/settings/import', {
    payload: { kind: 'soraikahub-settings', version: 1, values: { 'worker.idleMs': 12345, 'gone.field': 'x' } },
  })
  const importData = importRes.body?.data
  check(importRes.res.ok && importData.applied.includes('worker.idleMs'), '导入 merge：新值生效')
  check(importData.ignored.includes('gone.field'), '未知项被忽略并回报（跨版本不卡住）')
  check(fieldOf(importData.settings, 'worker.idleMs').value === 12345, '导入后立刻生效')

  const importBad = await call('POST', '/api/settings/import', {
    payload: { kind: 'soraikahub-settings', version: 1, values: { 'worker.dailyAt': '99:99' } },
  })
  check(importBad.res.status === 400, '导入里有非法值 → 整包拒绝')
  const importWrongKind = await call('POST', '/api/settings/import', { payload: { kind: 'other', values: {} } })
  check(importWrongKind.res.status === 400, '不是本程序的设置文件 → 400')
  const importFuture = await call('POST', '/api/settings/import', {
    payload: { kind: 'soraikahub-settings', version: 99, values: {} },
  })
  check(importFuture.res.status === 400, '版本比程序新 → 400（提示先升级）')
  const importReplace = await call('POST', '/api/settings/import', {
    payload: { kind: 'soraikahub-settings', version: 1, values: { 'worker.gapMs': 420 } },
    mode: 'replace',
  })
  check(
    importReplace.body?.data?.mode === 'replace' && importReplace.body.data.settings.overridden.length === 1,
    'replace 模式会先清空已有覆盖（只剩这一项）',
  )

  console.log(failed ? `\n✗ 失败 ${failed} 项` : '\n✓ 全部通过')
  process.exitCode = failed ? 1 : 0
} catch (err) {
  console.error('\n✗ 验收中断：', err.message)
  console.error(logs.join('').slice(-1500))
  process.exitCode = 1
} finally {
  child.kill()
  // 等进程真正退出再删临时库，否则 Windows 上文件被占用删不掉
  await Promise.race([once(child, 'exit'), new Promise((r) => setTimeout(r, 3000))])
  for (const suffix of ['', '-wal', '-shm']) {
    rmSync(`${DB_FILE}${suffix}`, { force: true })
  }
}