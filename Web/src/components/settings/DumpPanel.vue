<template>
  <section class="card-surface dump-card">
    <header class="dump-head">
      <h2 class="dump-title"><IconCloudDownload :size="19" /> 离线数据 · 手动更新</h2>
      <span class="pill" :class="pillClass">{{ pillText }}</span>
      <p class="dump-hint">
        Bangumi 每周三更新一版全站数据（约 450MB）。导一次就能把档案、系列关系、全站动画索引全部对齐 ——
        之后下载页连库里没有的老番也能认出来。填好地址后可在这里手动触发。
      </p>
    </header>

    <StateBlock v-if="loading && !status" state="loading" text="读取状态…" />
    <StateBlock v-else-if="error && !status" state="error" :text="error" retry-text="重试" @retry="load" />

    <template v-else-if="status">
      <!-- 进度：只有真在跑才占位置，跑完不留空白 -->
      <div v-if="job.running || job.phase === 'failed'" class="dump-progress">
        <div class="bar-row">
          <div class="bar"><span class="bar-fill" :style="{ width: `${barPercent}%` }" /></div>
          <span class="bar-text">{{ barText }}</span>
        </div>
        <p class="dump-note">{{ phaseNote }}</p>
      </div>

      <!-- 上次导入的结果：这是「点了按钮到底有没有用」的唯一凭据 -->
      <dl v-if="stored.name || job.result" class="dump-facts">
        <div>
          <dt>已导入版本</dt>
          <dd>{{ stored.name || job.result?.name || '—' }}</dd>
        </div>
        <div>
          <dt>导入时间</dt>
          <dd>{{ storedText }}</dd>
        </div>
        <div v-if="job.result">
          <dt>本次结果</dt>
          <dd>
            补档案 {{ job.result.patched }} 部 · 关系 {{ job.result.relations }} 条 ·
            动画索引 {{ job.result.index }} 部 · 重算系列 {{ job.result.seriesReset }} 部
          </dd>
        </div>
      </dl>

      <p v-if="job.lastError" class="error-text">上次失败：{{ job.lastError }}</p>
      <p v-else-if="job.skipped" class="dump-note ok">
        已经是这一版了，没重复下载。想强制重灌就点「强制重灌」。
      </p>

      <div class="dump-actions">
        <button class="dump-btn primary" type="button" :disabled="busy" @click="start(false)">
          <IconRefresh :size="13" /> {{ busy ? '进行中…' : '检查并更新' }}
        </button>
        <button
          class="dump-btn"
          type="button"
          :disabled="busy"
          title="忽略「这版已导过」，重新下载并导入一遍（改了导入逻辑之后用）"
          @click="start(true)"
        >
          <IconRestore :size="13" /> 强制重灌
        </button>
        <span v-if="busy" class="dump-note">可以离开这个页面，任务在后台继续跑</span>
      </div>

      <!-- 配套动作：dump 换了一版之后，系列链可能算出新的成员/顺序。
           系列是「算过就不重算」的，所以旧的（甚至裂开的）结果不会自己更新 ——
           这里给一个显式重算入口，并在旁边说清它解决的是什么。 -->
      <div class="dump-sub">
        <div class="dump-sub-head">
          <h3 class="dump-sub-title">重算系列</h3>
          <span v-if="pendingSeries != null" class="dump-sub-meta">待算 {{ pendingSeries }} 部</span>
        </div>
        <p class="dump-note">
          按上传关系重新走一遍链并重排季位。用在你发现「系列里少了一季」或「S01 是第二季」时 ——
          那是旧结果留下来的裂片，重算会把它们合并。根名不会被覆盖。
        </p>
        <div class="dump-actions">
          <button class="dump-btn" type="button" :disabled="rebuilding" @click="rebuild">
            <IconRecycle :size="13" /> {{ rebuilding ? '已排队…' : '重算系列' }}
          </button>
          <span v-if="rebuildNote" class="dump-note ok">{{ rebuildNote }}</span>
        </div>
      </div>
    </template>
  </section>
</template>

<script setup>
/**
 * 离线 dump 手动更新
 * ---------------------------------------------------------------------------
 * 这个任务可能是几分钟（下载 450MB），所以：
 *   · 触发后**立刻返回**，界面轮询 `/api/dump/status`（2 秒一次，只在跑的时候轮询）
 *   · 离开设置页不取消任务（它在服务端跑），回来还能看到进度
 *   · 「已经是这一版」不是错误：`skipped` 单独说一句，别用红色错误吓人
 * 轮询在组件卸载时清掉 —— 否则切页之后还在后台打接口。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { IconCloudDownload, IconRecycle, IconRefresh, IconRestore } from '@tabler/icons-vue'
import StateBlock from '@/components/ui/StateBlock.vue'
import { fetchDumpStatus, rebuildSeries, startDumpUpdate } from '@/api/settings'

const POLL_MS = 2000

const status = ref(null)
const loading = ref(true)
const error = ref('')
const rebuilding = ref(false)
const rebuildNote = ref('')
/** 系列队列还剩多少（/api/health 里 worker.series.pending，重算后看它掉下去就是进度） */
const pendingSeries = ref(null)
let timer = null

const job = computed(() => status.value?.job || { phase: 'idle', progress: {}, running: false })
const stored = computed(() => status.value?.stored || {})
const busy = computed(() => Boolean(job.value.running))

const PHASE_TEXT = {
  idle: '空闲',
  checking: '检查索引',
  downloading: '下载中',
  importing: '导入中',
  done: '完成',
  failed: '失败',
}
const pillText = computed(() => {
  if (busy.value) return PHASE_TEXT[job.value.phase] || '进行中'
  if (job.value.phase === 'failed') return '上次失败'
  if (job.value.phase === 'done') return job.value.skipped ? '已是最新' : '完成'
  return '未运行'
})
const pillClass = computed(() => {
  if (job.value.phase === 'failed') return 'pill-danger'
  if (busy.value || job.value.phase === 'done') return 'pill-accent'
  return 'pill-muted'
})

const barPercent = computed(() => {
  const p = job.value.progress || {}
  if (job.value.phase === 'importing') return 99
  return Math.max(0, Math.min(100, Number(p.percent) || 0))
})
const barText = computed(() => {
  const p = job.value.progress || {}
  if (job.value.phase === 'importing') return '下载完成，正在导入…'
  if (!p.total) return job.value.phase === 'checking' ? '查询最新版本…' : ''
  const mb = (n) => `${(Number(n) / 1e6).toFixed(0)} MB`
  return `${mb(p.bytes)} / ${mb(p.total)}（${p.percent}%）`
})
const phaseNote = computed(() => {
  if (job.value.phase === 'checking') return '索引只有几百字节，通常一两秒就有结果'
  if (job.value.phase === 'downloading')
    return '断点续传：中途断了再点一次会接着下，不会从头来；镜像失败会自己换下一个'
  if (job.value.phase === 'importing') return '流式导入，不需要先解压；几百 MB 通常十几秒'
  if (job.value.phase === 'failed') return job.value.lastError || '失败了，可以再点一次重试'
  return ''
})

const storedText = computed(() => {
  const t = Number(stored.value.importedAt) || 0
  if (!t) return '—'
  const d = new Date(t)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
})

async function load() {
  try {
    status.value = await fetchDumpStatus()
    error.value = ''
  } catch (err) {
    error.value = err?.message || '读取失败'
  } finally {
    loading.value = false
  }
  // 系列队列进度：单独取（health 是公共接口，失败不影响上面这块）
  try {
    const res = await fetch('/api/health').then((r) => r.json())
    pendingSeries.value = res?.data?.worker?.series?.pending ?? null
  } catch {
    pendingSeries.value = null
  }
}

async function rebuild() {
  rebuilding.value = true
  rebuildNote.value = ''
  try {
    const out = await rebuildSeries()
    rebuildNote.value = `已排队 ${out.reset} 部，后台会自己跑完`
    pendingSeries.value = out.pending ?? pendingSeries.value
  } catch (err) {
    error.value = err?.message || '重算失败'
  } finally {
    rebuilding.value = false
  }
}

function stopPoll() {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}

function startPoll() {
  stopPoll()
  timer = setInterval(async () => {
    await load()
    if (!status.value?.job?.running) stopPoll()
  }, POLL_MS)
}

async function start(force) {
  error.value = ''
  try {
    const res = await startDumpUpdate(force)
    status.value = { job: res.job, stored: status.value?.stored || {} }
    startPoll()
  } catch (err) {
    error.value = err?.message || '触发失败'
  }
}

onMounted(async () => {
  await load()
  if (status.value?.job?.running) startPoll()
})
onBeforeUnmount(stopPoll)
</script>

<style scoped>
/* 与 PromptEditor 同一套做法：分组卡片之后的**独立卡片**（不参与上面那套分组保存）。
   这里不是分组内小节 —— 手动更新是一个动作，塞进设置卡里会让人以为它跟「保存」有关。 */
.dump-card {
  padding: 20px 24px 18px;
}
/* 组内小节：标题比卡片标题小一号，与 .section-title 同一观感 */
.dump-head {
  display: grid;
  grid-template-columns: 1fr auto;
  align-items: center;
  gap: 4px 10px;
  margin-bottom: 14px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--border);
}
.dump-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-family: var(--font-body);
  color: var(--text-primary);
  font-size: 0.98rem;
  font-weight: 700;
}
.dump-title svg {
  color: var(--accent);
}
.dump-hint {
  grid-column: 1 / -1;
  color: var(--text-tertiary);
  font-size: 0.75rem;
  line-height: 1.6;
}

.dump-progress {
  margin-bottom: 12px;
}
.bar-row {
  display: flex;
  align-items: center;
  gap: 10px;
}
.bar {
  flex: 1;
  height: 6px;
  border-radius: var(--radius-pill);
  background: var(--border);
  overflow: hidden;
}
.bar-fill {
  display: block;
  height: 100%;
  border-radius: var(--radius-pill);
  background: var(--accent);
  /* 慢速过渡：进度是按字节算的，跳一下就够，别做成流动动画（会晃眼） */
  transition: width 400ms linear;
}
.bar-text {
  flex: 0 0 auto;
  color: var(--text-secondary);
  font-size: 0.72rem;
  font-variant-numeric: tabular-nums;
}
.dump-note {
  margin-top: 6px;
  color: var(--text-tertiary);
  font-size: 0.72rem;
  line-height: 1.6;
}
.dump-note.ok {
  color: var(--accent-strong);
}

.dump-facts {
  display: grid;
  gap: 6px;
  margin: 4px 0 12px;
}
.dump-facts > div {
  display: grid;
  grid-template-columns: 84px 1fr;
  gap: 10px;
  align-items: baseline;
}
.dump-facts dt {
  color: var(--text-tertiary);
  font-size: 0.72rem;
}
.dump-facts dd {
  margin: 0;
  color: var(--text-secondary);
  font-size: 0.75rem;
  word-break: break-all;
}

.dump-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
/* 按钮样式写在这里：SettingsPage 的 .mini-btn 是 scoped，组件里拿不到 */
.dump-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 6px 13px;
  border: 1px solid var(--border);
  border-radius: var(--radius-pill);
  background: var(--bg-input);
  color: var(--text-secondary);
  font-size: 0.75rem;
  cursor: pointer;
  transition: color var(--dur-fast), border-color var(--dur-fast);
}
.dump-btn:hover:not(:disabled) {
  color: var(--accent);
  border-color: var(--accent);
}
.dump-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.dump-btn.primary {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--text-invert);
}
.dump-btn.primary:hover:not(:disabled) {
  color: var(--text-invert);
  border-color: var(--accent-hover);
  background: var(--accent-hover);
}

/* 配套动作小节（与上面的「更新」分开：一个是拉数据，一个是修已有数据） */
.dump-sub {
  margin-top: 16px;
  padding-top: 14px;
  border-top: 1px dashed var(--border);
}
.dump-sub-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin-bottom: 6px;
}
.dump-sub-title {
  font-family: var(--font-body);
  color: var(--text-primary);
  font-size: 0.8rem;
  font-weight: 600;
}
.dump-sub-meta {
  color: var(--text-tertiary);
  font-size: 0.72rem;
  font-variant-numeric: tabular-nums;
}
</style>
