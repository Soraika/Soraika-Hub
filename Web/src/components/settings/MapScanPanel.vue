<template>
  <section class="card-surface map-card">
    <header class="map-head">
      <h2 class="map-title"><IconLink :size="19" /> 作品身份映射</h2>
      <span class="pill" :class="pillClass">{{ pillText }}</span>
      <p class="map-hint">
        「哪部 Mikan 作品对应哪个 Bangumi 条目」是唯一不能重建的数据（只能逐页问上游攒）。
        缺了它，作品就没有评分、没有系列、也没有归档目录。这里的扫描会拿 mikan_id 去
        Mikan 详情页解析 bgm_id，顺便把评分档案补齐并写回映射表 —— 有离线数据时先用离线，缺了才联网。
      </p>
    </header>

    <div class="map-facts">
      <div>
        <dt>映射表</dt>
        <dd>{{ counts.map }} 条</dd>
      </div>
      <div>
        <dt>还缺 bgm</dt>
        <dd :class="{ bad: counts.missingBgm > 0 }">{{ counts.missingBgm }} 部</dd>
      </div>
    </div>

    <div v-if="job.running || job.phase === 'failed'" class="map-progress">
      <div class="bar-row">
        <div class="bar"><span class="bar-fill" :style="{ width: `${percent}%` }" /></div>
        <span class="bar-text">{{ progressText }}</span>
      </div>
      <p class="map-note">{{ phaseNote }}</p>
    </div>

    <p v-if="job.lastError" class="error-text">{{ job.lastError }}</p>
    <p v-else-if="lastSummary" class="map-note ok">{{ lastSummary }}</p>

    <div class="map-actions">
      <button class="map-btn primary" type="button" :disabled="job.running" @click="scan(0)">
        <IconRefresh :size="13" /> {{ job.running ? '扫描中…' : '扫描并补齐' }}
      </button>
      <button class="map-btn" type="button" :disabled="job.running" @click="scan(20)">
        <IconTestPipe :size="13" /> 先试 20 条
      </button>
      <button v-if="job.running" class="map-btn" type="button" @click="stop">
        <IconPlayerStop :size="13" /> 停
      </button>
      <span v-if="job.running" class="map-note">可以离开这个页面，任务在后台继续</span>
    </div>
  </section>
</template>

<script setup>
/**
 * 映射扫描（把缺 bgm_id 的作品在线补齐）
 * ---------------------------------------------------------------------------
 * 与「离线数据」那张卡的分工说清楚：
 *   · 离线数据（dump）解决「**档案内容**」——一次下载，全站评分/关系/索引
 *   · 这张卡解决「**身份**」——mikan_id ↔ bgm_id，只能逐条问上游，dump 里没有
 * 两者互补：先跑 dump 拿到全站档案，再扫映射把缺身份的补上，剩下的才需要联网。
 *
 * 「先试 20 条」是刻意的：一次扫几百条要几分钟，先看 20 条的结果再决定继续 ——
 * 上游限流或者地址配错时，不会白等十分钟。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { IconLink, IconPlayerStop, IconRefresh, IconTestPipe } from '@tabler/icons-vue'
import { fetchMapStatus, startMapScan, stopMapScan } from '@/api/settings'

const POLL_MS = 2000

const status = ref(null)
const error = ref('')
let timer = null

const job = computed(() => status.value?.job || { phase: 'idle', running: false, total: 0, done: 0 })
const counts = computed(() => status.value?.counts || { map: 0, missingBgm: 0 })

const pillText = computed(() => {
  if (job.value.running) return job.value.phase === 'importing' ? '导入已有映射' : '扫描中'
  if (job.value.phase === 'failed') return '上次失败'
  if (job.value.phase === 'done') return '完成'
  return '未运行'
})
const pillClass = computed(() => {
  if (job.value.phase === 'failed') return 'pill-danger'
  if (job.value.running || job.value.phase === 'done') return 'pill-accent'
  return 'pill-muted'
})
const percent = computed(() => {
  const total = Number(job.value.total) || 0
  if (!total) return job.value.phase === 'importing' ? 5 : 0
  return Math.max(0, Math.min(100, Math.round((Number(job.value.done) / total) * 100)))
})
const progressText = computed(() => {
  if (job.value.phase === 'importing') return '正在导入已生成的映射…'
  const total = Number(job.value.total) || 0
  if (!total) return ''
  return `${job.value.done} / ${total}（${percent.value}%）`
})
const phaseNote = computed(() => {
  if (job.value.phase === 'importing') return '先把你之前生成的那份映射导进来，能少打几千次上游'
  if (job.value.phase === 'scanning')
    return `已补 ${job.value.resolved} 部 · 上游没有链接 ${job.value.noLink} 部 · 失败 ${job.value.failed} 部`
  if (job.value.phase === 'failed') return job.value.lastError || '失败了，可以再点一次'
  return ''
})
const lastSummary = computed(() => {
  if (job.value.phase !== 'done') return ''
  const parts = [`补到 ${job.value.resolved} 部`]
  if (job.value.noLink) parts.push(`上游没挂 Bangumi 链接 ${job.value.noLink} 部（30 天后自动重试）`)
  if (job.value.failed) parts.push(`失败 ${job.value.failed} 部`)
  if (job.value.imported?.inserted) parts.push(`导入旧映射 ${job.value.imported.inserted} 条`)
  return parts.join(' · ')
})

async function load() {
  try {
    status.value = await fetchMapStatus()
    error.value = ''
  } catch (err) {
    error.value = err?.message || '读取失败'
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

async function scan(limit) {
  try {
    const res = await startMapScan({ limit })
    status.value = { job: res.job, counts: status.value?.counts || { map: 0, missingBgm: 0 } }
    startPoll()
  } catch (err) {
    error.value = err?.message || '触发失败'
  }
}

async function stop() {
  try {
    await stopMapScan()
    await load()
  } catch (err) {
    error.value = err?.message || '停止失败'
  }
}

onMounted(async () => {
  await load()
  if (status.value?.job?.running) startPoll()
})
onBeforeUnmount(stopPoll)
</script>

<style scoped>
.map-card {
  padding: 20px 24px 18px;
}
.map-head {
  display: grid;
  grid-template-columns: 1fr auto;
  align-items: center;
  gap: 4px 10px;
  margin-bottom: 14px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--border);
}
.map-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-family: var(--font-body);
  color: var(--text-primary);
  font-size: 0.98rem;
  font-weight: 700;
}
.map-title svg {
  color: var(--accent);
}
.map-hint {
  grid-column: 1 / -1;
  color: var(--text-tertiary);
  font-size: 0.75rem;
  line-height: 1.6;
}

.map-facts {
  display: flex;
  gap: 28px;
  margin-bottom: 12px;
}
.map-facts dt {
  color: var(--text-tertiary);
  font-size: 0.72rem;
}
.map-facts dd {
  margin: 2px 0 0;
  color: var(--text-secondary);
  font-size: 0.86rem;
  font-variant-numeric: tabular-nums;
}
.map-facts dd.bad {
  color: var(--status-warning);
}

.map-progress {
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
  transition: width 400ms linear;
}
.bar-text {
  flex: 0 0 auto;
  color: var(--text-secondary);
  font-size: 0.72rem;
  font-variant-numeric: tabular-nums;
}
.map-note {
  margin-top: 6px;
  color: var(--text-tertiary);
  font-size: 0.72rem;
  line-height: 1.6;
}
.map-note.ok {
  color: var(--accent-strong);
}

.map-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.map-btn {
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
.map-btn:hover:not(:disabled) {
  color: var(--accent);
  border-color: var(--accent);
}
.map-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.map-btn.primary {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--text-invert);
}
.map-btn.primary:hover:not(:disabled) {
  color: var(--text-invert);
  border-color: var(--accent-hover);
  background: var(--accent-hover);
}
</style>
