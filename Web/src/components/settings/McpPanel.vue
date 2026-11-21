<template>
  <section class="card-surface mcp-card">
    <header class="mcp-head">
      <h2 class="mcp-title"><IconPlugConnected :size="19" /> MCP 服务</h2>
      <span class="pill" :class="enabled ? 'pill-accent' : 'pill-muted'">{{ enabled ? '已启用' : '未启用' }}</span>
      <p class="mcp-hint">端点与令牌抄进客户端就能用；工具清单在下面，写入类会真的改动下载任务</p>
    </header>

    <StateBlock v-if="loading && !status" state="loading" text="读取状态…" />
    <StateBlock v-else-if="error && !status" state="error" :text="error" retry-text="重试" @retry="load" />

    <template v-else-if="status">
      <!-- ── 未启用：其余内容全部收起，只交代「去哪儿打开」────────────── -->
      <template v-if="!enabled">
        <p class="mcp-off">
          <IconLock :size="14" />
          现在是关着的。去上面「MCP」这张卡里打开开关，回来这里就能拿地址和令牌。
        </p>
        <dl class="mcp-facts is-dim">
          <div>
            <dt>端点</dt>
            <dd><span class="mono">{{ status.endpoint || '—' }}</span></dd>
          </div>
          <div>
            <dt>调用次数</dt>
            <dd>{{ stats.calls }} 次</dd>
          </div>
        </dl>
      </template>

      <template v-else>
        <!-- ── 状态行 ────────────────────────────────────────────── -->
        <dl class="mcp-facts">
          <div>
            <dt>状态</dt>
            <dd>{{ status.enabled ? '已启用' : '未启用' }}{{ status.allowWrite ? ' · 允许写入' : ' · 只读' }}</dd>
          </div>
          <div>
            <dt>端点</dt>
            <dd>
              <button class="mcp-copy-line" type="button" :title="`点击复制 ${status.endpoint}`" @click="copy(status.endpoint, 'endpoint')">
                <span class="mono">{{ status.endpoint || '—' }}</span>
                <span class="mcp-copy-hint">{{ copiedKey === 'endpoint' ? '已复制' : '复制' }}</span>
              </button>
            </dd>
          </div>
          <div>
            <dt>调用次数</dt>
            <dd>
              {{ stats.calls }} 次<template v-if="stats.toolCalls"> · 工具调用 {{ stats.toolCalls }}</template>
              <template v-if="lastCallText"> · 最近 {{ lastCallText }}</template>
            </dd>
          </div>
        </dl>

        <!-- ── 令牌 ──────────────────────────────────────────────── -->
        <div class="mcp-block">
          <div class="mcp-block-head">
            <h3 class="mcp-block-title">访问令牌</h3>
            <span class="mcp-block-meta">{{ status.token ? '客户端把这个填进请求头' : '未生成' }}</span>
          </div>
          <div class="mcp-token-row">
            <code class="mcp-token mono">{{ tokenText }}</code>
            <div class="mcp-actions">
              <button v-if="status.token" class="mcp-btn" type="button" @click="revealed = !revealed">
                <component :is="revealed ? IconEyeOff : IconEye" :size="13" /> {{ revealed ? '隐藏' : '显示' }}
              </button>
              <button class="mcp-btn" type="button" :disabled="!status.token" @click="copy(status.token, 'token')">
                <component :is="copiedKey === 'token' ? IconCheck : IconCopy" :size="13" />
                {{ copiedKey === 'token' ? '已复制' : '复制' }}
              </button>
              <button class="mcp-btn" type="button" :disabled="regenerating" @click="regenerate">
                <IconRefresh :size="13" /> {{ regenerating ? '生成中…' : '重新生成' }}
              </button>
            </div>
          </div>
          <p class="mcp-note">
            令牌等同于密码：拿到它的人可以读写你的库。重新生成会立刻顶掉旧的，已经接好的客户端要换一遍。
          </p>
        </div>

        <!-- ── 工具清单 ──────────────────────────────────────────── -->
        <div class="mcp-block">
          <div class="mcp-block-head">
            <h3 class="mcp-block-title">能做什么</h3>
            <span class="mcp-block-meta">{{ tools.length }} 个工具</span>
          </div>

          <template v-for="group in toolGroups" :key="group.key">
            <p v-if="group.items.length" class="mcp-group-title" :class="{ warn: group.key === 'write' }">
              <IconAlertTriangle v-if="group.key === 'write'" :size="13" />
              {{ group.label }}
              <span class="mcp-group-count">{{ group.items.length }}</span>
            </p>
            <p v-if="group.key === 'write' && group.items.length" class="mcp-group-warn">会真的改动下载任务</p>
            <ul v-if="group.items.length" class="mcp-tools">
              <li v-for="tool in group.items" :key="tool.name" class="mcp-tool">
                <div class="mcp-tool-head">
                  <span class="mcp-tool-title">{{ tool.title || tool.name }}</span>
                  <span class="mcp-tool-name mono">{{ tool.name }}</span>
                </div>
                <p v-if="tool.description" class="mcp-tool-desc">{{ plain(tool.description) }}</p>
              </li>
            </ul>
          </template>
          <p v-if="!tools.length" class="mcp-note">后端没有报告任何工具。</p>
        </div>

        <!-- ── 客户端接法 ────────────────────────────────────────── -->
        <div class="mcp-block">
          <div class="mcp-block-head">
            <h3 class="mcp-block-title">接进来</h3>
            <span class="mcp-block-meta">选你的客户端，整段贴过去</span>
          </div>
          <div class="mcp-tabs" role="tablist">
            <button
              v-for="client in clients"
              :key="client.name"
              class="mcp-tab"
              :class="{ on: client.name === activeClient }"
              type="button"
              role="tab"
              :aria-selected="client.name === activeClient"
              @click="activeClient = client.name"
            >
              {{ client.name }}
            </button>
          </div>
          <div v-if="currentClient" class="mcp-code-wrap">
            <button
              class="mcp-btn mcp-code-copy"
              type="button"
              @click="copy(currentClient.snippet, `client:${currentClient.name}`)"
            >
              <component :is="copiedKey === `client:${currentClient.name}` ? IconCheck : IconCopy" :size="13" />
              {{ copiedKey === `client:${currentClient.name}` ? '已复制' : '复制' }}
            </button>
            <pre class="mcp-code"><code>{{ currentClient.snippet }}</code></pre>
          </div>
        </div>

        <!-- ── 自检 ──────────────────────────────────────────────── -->
        <div class="mcp-foot">
          <button class="mcp-btn primary" type="button" :disabled="pinging" @click="runPing">
            <IconHeartbeat :size="13" /> {{ pinging ? '自检中…' : '自检' }}
          </button>
          <span v-if="pingResult" class="mcp-ping" :class="pingResult.ok ? 'ok' : 'bad'">
            <component :is="pingResult.ok ? IconCheck : IconX" :size="13" />
            <template v-if="pingResult.ok">
              {{ pingResult.ms }}ms 内通，返回 {{ pingResult.tools }} 个工具
            </template>
            <template v-else>{{ pingResult.error || '连不上自己' }}</template>
          </span>
          <span v-else class="mcp-note">后端用自己的 HTTP 打一次 /mcp，确认这条链路是通的</span>
        </div>
      </template>

      <p v-if="error" class="mcp-error">{{ error }}</p>
    </template>
  </section>
</template>

<script setup>
/**
 * MCP 服务（把库交给 agent）
 * ---------------------------------------------------------------------------
 * 这张卡不存任何配置：开关在设置组的字段里（保存后重启生效），这里只负责
 * 「拿到手就能用」—— 端点、令牌、工具清单、三份客户端配置、一个自检按钮。
 *
 * 几处取舍：
 *   · 令牌默认掩码：设置页经常被截屏 / 分享屏幕，明文常驻等于泄露
 *   · 重新生成要二次确认：换令牌是**破坏性**的，旧令牌立刻失效
 *   · 自检走后端（POST /api/mcp/ping）：浏览器直连会被 CORS 挡掉，测不出真结果
 *   · 未启用时只留一句「去哪儿打开」+ 灰掉的端点：把工具清单关掉，避免人以为已经在跑
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import {
  IconAlertTriangle,
  IconCheck,
  IconCopy,
  IconEye,
  IconEyeOff,
  IconHeartbeat,
  IconLock,
  IconPlugConnected,
  IconRefresh,
  IconX,
} from '@tabler/icons-vue'
import StateBlock from '@/components/ui/StateBlock.vue'
import { fetchMcpStatus, pingMcp, regenerateMcpToken } from '@/api/settings'

const status = ref(null)
const loading = ref(true)
const error = ref('')
const revealed = ref(false)
const regenerating = ref(false)
const pinging = ref(false)
const pingResult = ref(null)
/** 哪个按钮刚复制成功（短暂显示「已复制」） */
const copiedKey = ref('')
let copiedTimer = null

const enabled = computed(() => Boolean(status.value?.enabled))
const stats = computed(() => status.value?.stats || { calls: 0, toolCalls: 0, lastCallAt: null })
const tools = computed(() => status.value?.tools || [])
const clients = computed(() => status.value?.clients || [])

const toolGroups = computed(() => [
  { key: 'read', label: '只读工具', items: tools.value.filter((t) => !t.write) },
  { key: 'write', label: '写入工具', items: tools.value.filter((t) => t.write) },
])

const activeClient = ref('')
/** 客户端列表来自后端，默认选第一个；刷新后保持用户当前选择 */
const currentClient = computed(
  () => clients.value.find((c) => c.name === activeClient.value) || clients.value[0] || null,
)

/**
 * 工具说明里的 `**强调**` 是写给模型看的（模型读 markdown 没问题），
 * 但界面上会原样显示星号 —— 这里只做「去标记」，不改后端文案（那份还要给 agent 读）。
 */
const plain = (text) => String(text || '').replace(/\*\*/g, '')

const tokenText = computed(() => {
  const token = status.value?.token || ''
  if (!token) return '—'
  if (revealed.value) return token
  /* 掩码用后端给的 tokenPreview（`sk-hub-abc…1234`）：前端自己切会让「前缀几位」这种
     细节跟着实现变，抄令牌的人会以为前缀很重要 —— 其实只有后四位用于核对 */
  return status.value?.tokenPreview || `••••${token.slice(-4)}`
})

const lastCallText = computed(() => {
  const t = Number(stats.value.lastCallAt) || 0
  if (!t) return ''
  const d = new Date(t)
  const pad = (n) => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
})

/** 复制：优先剪贴板 API（http 下不可用），失败降级到 execCommand */
async function copy(text, key) {
  if (!text) return
  let ok = false
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text)
      ok = true
    }
  } catch {
    ok = false
  }
  if (!ok) {
    try {
      const area = document.createElement('textarea')
      area.value = text
      area.setAttribute('readonly', '')
      area.style.position = 'fixed'
      area.style.top = '-1000px'
      area.style.opacity = '0'
      document.body.appendChild(area)
      area.select()
      ok = document.execCommand('copy')
      document.body.removeChild(area)
    } catch {
      ok = false
    }
  }
  if (!ok) return
  copiedKey.value = key
  if (copiedTimer) clearTimeout(copiedTimer)
  copiedTimer = setTimeout(() => {
    copiedKey.value = ''
  }, 1600)
}

async function regenerate() {
  const agree = window.confirm('重新生成后旧令牌立刻失效，已经接好的客户端都要换一遍。继续？')
  if (!agree) return
  regenerating.value = true
  error.value = ''
  try {
    const out = await regenerateMcpToken()
    if (status.value) status.value = { ...status.value, token: out?.token || '' }
    revealed.value = true // 新令牌只出现这一次，直接摊开让人抄走
    pingResult.value = null
  } catch (err) {
    error.value = err?.message || '生成失败'
  } finally {
    regenerating.value = false
  }
}

async function runPing() {
  pinging.value = true
  pingResult.value = null
  try {
    const out = await pingMcp()
    pingResult.value = { ok: Boolean(out?.ok), tools: out?.tools ?? 0, ms: out?.ms ?? 0, error: out?.error || '' }
  } catch (err) {
    pingResult.value = { ok: false, tools: 0, ms: 0, error: err?.message || '自检失败' }
  } finally {
    pinging.value = false
  }
}

async function load() {
  try {
    status.value = await fetchMcpStatus()
    // 客户端页签默认选第一个；重读时保持已选的那个（后端换了名字才回落）
    if (!clients.value.some((c) => c.name === activeClient.value)) {
      activeClient.value = clients.value[0]?.name || ''
    }
    error.value = ''
  } catch (err) {
    error.value = err?.message || '读取失败'
  } finally {
    loading.value = false
  }
}

onMounted(load)
onBeforeUnmount(() => {
  if (copiedTimer) clearTimeout(copiedTimer)
})
</script>

<style scoped>
/* 与 DumpPanel / MapScanPanel 同一套做法：分组卡片之后的**独立卡片**，
   不参与上面那套「改完点保存」的流程 —— 这里没有可保存的东西，只有可执行的动作。 */
.mcp-card {
  padding: 20px 24px 18px;
}
.mcp-head {
  display: grid;
  grid-template-columns: 1fr auto;
  align-items: center;
  gap: 4px 10px;
  margin-bottom: 14px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--border);
}
.mcp-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-family: var(--font-body);
  color: var(--text-primary);
  font-size: 0.98rem;
  font-weight: 700;
}
.mcp-title svg {
  color: var(--accent);
}
.mcp-hint {
  grid-column: 1 / -1;
  color: var(--text-tertiary);
  font-size: 0.75rem;
  line-height: 1.6;
}
.mono {
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
}

/* ── 未启用 ────────────────────────────────────────────────────── */
.mcp-off {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  margin-bottom: 10px;
  padding: 10px 12px;
  border: 1px dashed var(--border-strong);
  border-radius: var(--radius-sm);
  background: var(--bg-input);
  color: var(--text-secondary);
  font-size: 0.76rem;
  line-height: 1.6;
}
.mcp-off svg {
  flex: 0 0 auto;
  margin-top: 2px;
  color: var(--text-tertiary);
}
.is-dim {
  opacity: 0.45;
  filter: saturate(0.6);
}

/* ── 状态行 ────────────────────────────────────────────────────── */
.mcp-facts {
  display: grid;
  gap: 6px;
  margin: 0 0 14px;
}
.mcp-facts > div {
  display: grid;
  grid-template-columns: 64px 1fr;
  gap: 10px;
  align-items: baseline;
}
.mcp-facts dt {
  color: var(--text-tertiary);
  font-size: 0.72rem;
}
.mcp-facts dd {
  margin: 0;
  min-width: 0;
  color: var(--text-secondary);
  font-size: 0.75rem;
  word-break: break-all;
}
.mcp-copy-line {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  max-width: 100%;
  padding: 3px 8px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-input);
  color: var(--text-secondary);
  font-size: 0.72rem;
  cursor: pointer;
  transition: color var(--dur-fast), border-color var(--dur-fast);
}
.mcp-copy-line:hover {
  color: var(--accent);
  border-color: var(--accent);
}
.mcp-copy-line .mono {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mcp-copy-hint {
  flex: 0 0 auto;
  color: var(--text-tertiary);
  font-size: 0.68rem;
}

/* ── 小节 ──────────────────────────────────────────────────────── */
.mcp-block {
  margin-top: 16px;
  padding-top: 14px;
  border-top: 1px dashed var(--border);
}
.mcp-block-head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 8px;
}
.mcp-block-title {
  font-family: var(--font-body);
  color: var(--text-primary);
  font-size: 0.8rem;
  font-weight: 600;
}
.mcp-block-meta {
  color: var(--text-tertiary);
  font-size: 0.72rem;
}

/* ── 令牌 ──────────────────────────────────────────────────────── */
.mcp-token-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.mcp-token {
  flex: 1 1 220px;
  min-width: 0;
  padding: 7px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-input);
  color: var(--text-primary);
  font-size: 0.76rem;
  letter-spacing: 0.02em;
  overflow-x: auto;
  white-space: nowrap;
}

/* ── 按钮：SettingsPage 的 .mini-btn 是 scoped，组件里拿不到 ─────── */
.mcp-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.mcp-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 6px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-pill);
  background: var(--bg-input);
  color: var(--text-secondary);
  font-size: 0.74rem;
  white-space: nowrap;
  cursor: pointer;
  transition: color var(--dur-fast), border-color var(--dur-fast);
}
.mcp-btn:hover:not(:disabled) {
  color: var(--accent);
  border-color: var(--accent);
}
.mcp-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.mcp-btn.primary {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--text-invert);
}
.mcp-btn.primary:hover:not(:disabled) {
  background: var(--accent-hover);
  border-color: var(--accent-hover);
  color: var(--text-invert);
}
.mcp-note {
  margin-top: 6px;
  color: var(--text-tertiary);
  font-size: 0.72rem;
  line-height: 1.6;
}

/* ── 工具清单 ──────────────────────────────────────────────────── */
.mcp-group-title {
  display: flex;
  align-items: center;
  gap: 5px;
  margin: 12px 0 4px;
  color: var(--text-secondary);
  font-size: 0.74rem;
  font-weight: 600;
}
.mcp-group-title:first-of-type {
  margin-top: 0;
}
.mcp-group-title.warn {
  color: var(--status-warning);
}
.mcp-group-count {
  padding: 0 6px;
  border-radius: var(--radius-pill);
  background: var(--bg-input);
  color: var(--text-tertiary);
  font-size: 0.68rem;
  font-weight: 500;
}
.mcp-group-warn {
  margin-bottom: 6px;
  padding: 4px 9px;
  border-radius: var(--radius-sm);
  background: var(--accent-mist);
  color: var(--status-warning);
  font-size: 0.72rem;
}
.mcp-tools {
  display: grid;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.mcp-tool {
  padding: 8px 10px;
  border: 1px solid var(--border-card);
  border-radius: var(--radius-sm);
  background: var(--bg-input);
}
.mcp-tool-head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 6px;
}
.mcp-tool-title {
  color: var(--text-primary);
  font-size: 0.76rem;
  font-weight: 600;
}
.mcp-tool-name {
  color: var(--text-tertiary);
  font-size: 0.68rem;
  word-break: break-all;
}
.mcp-tool-desc {
  margin-top: 3px;
  color: var(--text-secondary);
  font-size: 0.72rem;
  line-height: 1.55;
}

/* ── 客户端配置 ────────────────────────────────────────────────── */
.mcp-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 8px;
}
.mcp-tab {
  padding: 5px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-pill);
  background: transparent;
  color: var(--text-tertiary);
  font-size: 0.72rem;
  cursor: pointer;
  transition: color var(--dur-fast), border-color var(--dur-fast), background var(--dur-fast);
}
.mcp-tab:hover {
  color: var(--text-secondary);
  border-color: var(--border-strong);
}
.mcp-tab.on {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent-strong);
}
.mcp-code-wrap {
  position: relative;
}
.mcp-code-copy {
  position: absolute;
  top: 8px;
  right: 8px;
  padding: 4px 10px;
  background: var(--bg-card);
  z-index: 1;
}
.mcp-code {
  margin: 0;
  padding: 12px 14px;
  padding-right: 84px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-input);
  color: var(--text-secondary);
  font-family: var(--font-mono);
  font-size: 0.72rem;
  line-height: 1.65;
  /* 移动端不横向溢出：片段里常有长 URL，块内自己滚 */
  overflow-x: auto;
  white-space: pre;
  -webkit-overflow-scrolling: touch;
}

/* ── 自检 ──────────────────────────────────────────────────────── */
.mcp-foot {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-top: 16px;
  padding-top: 14px;
  border-top: 1px dashed var(--border);
}
.mcp-ping {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 0.74rem;
  line-height: 1.5;
}
.mcp-ping.ok {
  color: var(--accent-strong);
}
.mcp-ping.bad {
  color: var(--status-danger);
}
.mcp-error {
  margin-top: 10px;
  color: var(--status-danger);
  font-size: 0.74rem;
}

@media (max-width: 820px) {
  .mcp-card {
    padding: 16px 16px 14px;
  }
  .mcp-facts > div {
    grid-template-columns: 56px 1fr;
  }
  .mcp-code {
    padding-right: 14px;
    padding-top: 36px; /* 复制按钮换到上面一行，避免压住代码 */
  }
  .mcp-code-copy {
    position: static;
    margin-bottom: 6px;
  }
  .mcp-code-wrap {
    display: flex;
    flex-direction: column;
    align-items: stretch;
  }
  .mcp-code-copy {
    align-self: flex-start;
  }
}
</style>
