<template>
  <div class="downloads">
    <div class="topbar">
      <h2 class="page-title">下载管理</h2>
      <button class="refresh-btn" :disabled="isSpinning" @click="doRefresh">
        <IconRefresh :size="20" :class="{ spinning: isSpinning }" />
      </button>
    </div>

    <div v-if="loading && groupedAnime.length === 0" class="state">
      <div class="spinner"></div>
      <span>加载中...</span>
    </div>

    <template v-else>
      <!-- 状态栏 -->
      <div v-if="status.connected" class="status-bar">
        <span class="status-dot on"></span>
        <span class="status-text">已连接</span>
        <span class="divider">|</span>
        <span class="speed">↓ {{ status.dlSpeed }}</span>
        <span class="speed">↑ {{ status.upSpeed }}</span>
        <span class="divider">|</span>
        <span>{{ activeCount }} 下载中 · {{ groupedAnime.length }} 部番剧</span>
      </div>

      <!-- 番剧卡片 -->
      <div v-if="groupedAnime.length > 0" class="anime-grid">
        <div v-for="group in groupedAnime" :key="group.key" class="anime-card">
          <div class="anime-header">
            <div class="anime-poster-wrap">
              <img v-if="group.poster" :src="group.poster" class="anime-poster" />
              <div v-else class="anime-poster placeholder">
                <IconMovie :size="28" />
              </div>
            </div>
            <div class="anime-info">
              <div class="anime-name">{{ group.animeName }}</div>
              <div class="anime-meta">
                <span class="season-badge">SE{{ String(group.season).padStart(2, '0') }}</span>
                <span v-if="group.subgroupName" class="sg-badge">{{ group.subgroupName }}</span>
                <span>已下载: {{ group.episodeSummary }}</span>
              </div>
              <div class="anime-progress">
                <span class="count-done">{{ group.doneCount }} 完成</span>
                <span v-if="group.dlCount > 0" class="count-dl">{{ group.dlCount }} 下载中</span>
                <span v-if="group.waitCount > 0" class="count-wait">{{ group.waitCount }} 等待中</span>
              </div>
            </div>
          </div>
          <div class="episode-list">
            <div
              v-for="ep in group.episodes"
              :key="ep.hash"
              class="ep-row"
              :class="stateClass(ep.qbState)"
            >
              <div class="ep-label-wrap">
                <span class="ep-label">{{ ep.label }}</span>
                <button v-if="ep.fileCount > 1" class="ep-expand-btn" :class="{ open: ep.expanded }" @click="ep.expanded = !ep.expanded">
                  {{ ep.expanded ? '▼' : '▶' }} {{ ep.fileCount }} 文件
                </button>
              </div>
              <div class="ep-progress-wrap">
                <div class="ep-progress-bar">
                  <div class="ep-progress-fill" :style="{ width: `${(ep.progress * 100).toFixed(1)}%` }"></div>
                </div>
                <span class="ep-percent">{{ ep.isDone ? '✓' : `${(ep.progress * 100).toFixed(0)}%` }}</span>
              </div>
              <span class="ep-size">{{ formatSize(ep.size) }}</span>
              <button class="ep-cancel" title="删除" @click.stop="cancelTorrent(ep.hash)">×</button>
              <button class="ep-rename-btn" title="重命名" @click.stop="openRename(ep)">✎</button>
            </div>
          </div>
        </div>
      </div>
      <div v-else class="state">
        <IconMoodEmpty :size="48" />
        <p>暂无本平台下载任务</p>
      </div>
    </template>

    <!-- 重命名弹窗 -->
    <div v-if="renameTarget" class="modal-overlay" @click.self="renameTarget = null">
      <div class="modal-box">
        <h3>重命名</h3>
        <input v-model="renameValue" placeholder="输入新文件名" @keyup.enter="doRename" />
        <div class="modal-actions">
          <button class="cancel-btn" @click="renameTarget = null">取消</button>
          <button class="save-btn" :disabled="!renameValue" @click="doRename">确定</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed, watch, onMounted, onUnmounted } from 'vue'
import { IconRefresh, IconMoodEmpty, IconMovie } from '@tabler/icons-vue'
import { getQBStatus, getAnimeTorrents, qbDelete, qbRename, getSubDetail } from '@/api'

const loading = ref(true)
const isSpinning = ref(false)
const animeTorrents = ref([])
const posterCache = ref({})
const renameTarget = ref(null)
const renameValue = ref('')

const status = reactive({ connected: false, dlSpeed: '0 B/s', upSpeed: '0 B/s' })

let refreshTimer = null
let spinTimer = null

function doRefresh() {
  if (isSpinning.value) return
  fetchAll()
}

// ── 从 QB 任务名解析并分组 ──

const groupedAnime = computed(() => {
  const groups = {}
  for (const t of animeTorrents.value) {
    const key = `${t.bgmid || t.animeName || 'unknown'}_${t.season}`
    if (!groups[key]) {
      groups[key] = {
        key,
        bgmid: t.bgmid,
        animeName: t.animeName || '未命名',
        season: t.season || 1,
        episodes: [],
        poster: posterCache.value[t.bgmid] || '',
        subgroupName: groups[key]?.subgroupName || t.subgroupName || null,
      }
    }
    const state = t.state || ''
    const progress = t.progress ?? 0
    const isDone = progress >= 1 || ['uploading', 'forcedUP', 'stalledUP', 'pausedUP'].includes(state)
    // episode 可能是纯数字字符串 "04" 或范围 "4-5"
    const epStr = t.episode
    const seasonPad = String(t.season || 1).padStart(2, '0')
    const epNum = epStr != null && epStr !== 'null' && !epStr.includes('-') ? parseInt(epStr) : null
    const epLabel = epNum != null
      ? `S${seasonPad}E${String(epNum).padStart(2, '0')}`
      : (epStr && epStr !== 'null' ? `S${seasonPad}E${epStr}` : '--')

    groups[key].episodes.push({
      hash: t.hash,
      label: epLabel,
      episode: epNum || 0,
      progress: isDone ? 1 : progress,
      qbState: state,
      isDone,
      size: t.size || 0,
      name: t.name || '',
      fileCount: t.fileCount || 1,
      files: t.files || [],
      expanded: false,
    })
  }

  const result = Object.values(groups).map(g => {
    g.episodes.sort((a, b) => a.episode - b.episode)
    const nums = g.episodes.map(e => e.episode).filter(n => n > 0).sort((a, b) => a - b)
    const ranges = []
    if (nums.length > 0) {
      let start = nums[0], end = nums[0]
      for (let i = 1; i < nums.length; i++) {
        if (nums[i] === end + 1) { end = nums[i] }
        else { ranges.push(start === end ? `${start}` : `${start}-${end}`); start = nums[i]; end = nums[i] }
      }
      ranges.push(start === end ? `${start}` : `${start}-${end}`)
    }
    g.episodeSummary = ranges.join(', ') || '--'
    g.doneCount = g.episodes.filter(e => e.isDone).length
    g.dlCount = g.episodes.filter(e => ['downloading', 'forcedDL'].includes(e.qbState)).length
    g.waitCount = g.episodes.length - g.doneCount - g.dlCount
    return g
  })

  return result
})

const activeCount = computed(() => {
  return animeTorrents.value.filter(t => ['downloading', 'forcedDL', 'stalledDL'].includes(t.state)).length
})

// ── helpers ──

function stateClass(s) {
  const m = { downloading: 's-dl', forcedDL: 's-dl', stalledDL: 's-stall', pausedDL: 's-pause',
    uploading: 's-up', forcedUP: 's-up', stalledUP: 's-up',
    queuedDL: 's-queue', queuedUP: 's-queue', error: 's-err', missingFiles: 's-err' }
  return m[s] || ''
}
function formatSize(b) { return b > 1073741824 ? (b/1073741824).toFixed(1)+' GB' : b > 1048576 ? (b/1048576).toFixed(1)+' MB' : b > 1024 ? (b/1024).toFixed(0)+' KB' : b+' B' }

async function cancelTorrent(hash) {
  try { await qbDelete(hash); await fetchAll() } catch (e) { console.error('[DownloadsPage] cancelTorrent 失败:', e) }
}
function openRename(ep) { renameTarget.value = ep; renameValue.value = ep.name || '' }
async function doRename() {
  if (!renameTarget.value || !renameValue.value) return
  try { await qbRename(renameTarget.value.hash, renameValue.value); renameTarget.value.name = renameValue.value } catch (e) { console.error('[DownloadsPage] doRename 失败:', e) }
  renameTarget.value = null
}

async function fetchAll() {
  const startedAt = Date.now()
  loading.value = true
  isSpinning.value = true; clearTimeout(spinTimer)
  try {
    const [statusRes, tRes] = await Promise.all([
      getQBStatus().catch(() => ({ data: { ok: false } })),
      getAnimeTorrents().catch(() => ({ data: { torrents: [] } })),
    ])
    const s = statusRes.data
    if (s.ok) { status.connected = true; status.dlSpeed = s.dlSpeed || '0 B/s'; status.upSpeed = s.upSpeed || '0 B/s' }
    else { status.connected = false }
    animeTorrents.value = tRes.data.torrents || []

    // 拉取海报：去重 bgmid
    const seenBgmids = new Set()
    for (const t of animeTorrents.value) {
      if (t.bgmid && !seenBgmids.has(t.bgmid)) {
        seenBgmids.add(t.bgmid)
        getSubDetail(t.bgmid).then(({ data }) => {
          if (data?.detail?.poster) {
            posterCache.value[t.bgmid] = data.detail.poster
          }
        }).catch(() => {})
      }
    }
  } catch {
    status.connected = false
  } finally {
    loading.value = false
    const elapsed = Date.now() - startedAt
    const remaining = Math.max(0, 1200 - elapsed)
    spinTimer = setTimeout(() => { isSpinning.value = false }, remaining)
  }
}

function scheduleRefresh() {
  clearInterval(refreshTimer)
  const hasActive = animeTorrents.value.some(t => ['downloading', 'forcedDL', 'stalledDL'].includes(t.state))
  if (hasActive) refreshTimer = setInterval(fetchAll, 30000)
}
watch(animeTorrents, scheduleRefresh, { deep: true })

onMounted(fetchAll)
onUnmounted(() => clearInterval(refreshTimer))
</script>

<style scoped>
.downloads { padding: 32px 40px; max-width: 1100px; }
.topbar { display: flex; align-items: center; gap: 16px; margin-bottom: 24px; }
.page-title { font-size: 1.5rem; font-weight: 700; color: var(--text-primary); margin: 0; }
.refresh-btn { display: flex; align-items: center; justify-content: center; width: 36px; height: 36px; border-radius: 8px; background: var(--bg-input); border: 1px solid var(--border); color: var(--text-secondary); cursor: pointer; transition: 0.2s; }
.refresh-btn:hover { color: var(--accent); border-color: var(--accent); }
.spinning { animation: spin 1.2s ease-in-out infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.state { display: flex; flex-direction: column; align-items: center; gap: 16px; padding: 80px 0; color: var(--text-secondary); }
.spinner { width: 36px; height: 36px; border: 3px solid var(--border); border-top-color: var(--accent); border-radius: 50%; animation: spin 0.8s linear infinite; }

/* 状态栏 */
.status-bar { display: flex; align-items: center; gap: 10px; background: var(--bg-card); border: 1px solid var(--border); border-radius: 10px; padding: 12px 20px; margin-bottom: 24px; font-size: 0.9rem; color: var(--text-secondary); }
.status-dot { width: 8px; height: 8px; border-radius: 50%; background: #ef4444; }
.status-dot.on { background: #22c55e; }
.status-text { font-weight: 600; color: var(--text-primary); }
.divider { color: var(--border); }
.speed { color: var(--accent-gold); font-weight: 500; }

/* 番剧卡片 */
.anime-grid { display: flex; flex-direction: column; gap: 20px; margin-bottom: 32px; }
.anime-card { background: var(--bg-card); border: 1px solid var(--border); border-radius: 12px; overflow: hidden; }
.anime-header { display: flex; gap: 16px; padding: 16px 20px; border-bottom: 1px solid var(--border); align-items: center; }
.anime-poster-wrap { flex-shrink: 0; }
.anime-poster { width: 56px; height: 76px; border-radius: 6px; object-fit: cover; background: var(--bg-input); }
.anime-poster.placeholder { width: 56px; height: 76px; display: flex; align-items: center; justify-content: center; color: var(--text-tertiary); background: var(--bg-input); border-radius: 6px; }
.anime-info { flex: 1; min-width: 0; }
.anime-name { font-size: 1rem; font-weight: 600; color: var(--text-primary); margin-bottom: 4px; }
.anime-meta { display: flex; align-items: center; gap: 8px; font-size: 0.8rem; color: var(--text-secondary); margin-bottom: 4px; }
.season-badge { background: var(--accent); color: #fff; padding: 1px 8px; border-radius: 10px; font-size: 0.72rem; font-weight: 600; }
.sg-badge { background: var(--bg-input); color: var(--accent); padding: 1px 8px; border-radius: 10px; border: 1px solid var(--accent); font-size: 0.72rem; font-weight: 500; }
.anime-progress { display: flex; gap: 12px; font-size: 0.78rem; }
.count-done { color: #22c55e; }
.count-dl { color: #3b82f6; }
.count-wait { color: var(--text-tertiary); }

/* 剧集列表 */
.episode-list { display: flex; flex-direction: column; }
.ep-row { display: flex; align-items: center; gap: 12px; padding: 10px 20px; border-bottom: 1px solid var(--border-light, rgba(128,128,128,0.06)); font-size: 0.84rem; transition: background 0.15s; }
.ep-row:last-child { border-bottom: none; }
.ep-row:hover { background: var(--bg-hover); }
.ep-label { font-weight: 600; color: var(--accent); min-width: 72px; font-variant-numeric: tabular-nums; }
.ep-progress-wrap { flex: 1; display: flex; align-items: center; gap: 10px; }
.ep-progress-bar { flex: 1; height: 5px; background: var(--bg-input); border-radius: 3px; overflow: hidden; }
.ep-progress-fill { height: 100%; border-radius: 3px; background: var(--accent); transition: width 0.5s ease; }
.ep-row.s-dl .ep-progress-fill { background: #3b82f6; }
.ep-row.s-stall .ep-progress-fill { background: #f59e0b; }
.ep-row.s-up .ep-progress-fill { background: #22c55e; }
.ep-row.s-pause .ep-progress-fill { background: #9ca3af; }
.ep-row.s-err .ep-progress-fill { background: #ef4444; }
.ep-percent { font-size: 0.78rem; color: var(--text-secondary); min-width: 36px; text-align: right; }
.ep-size { font-size: 0.78rem; color: var(--text-tertiary); min-width: 64px; text-align: right; }
.ep-cancel, .ep-rename-btn { background: none; border: none; color: var(--text-tertiary); cursor: pointer; font-size: 1rem; padding: 2px 4px; border-radius: 4px; opacity: 0; transition: opacity 0.15s; }
.ep-row:hover .ep-cancel, .ep-row:hover .ep-rename-btn { opacity: 1; }
.ep-cancel:hover { color: #ef4444; }
.ep-rename-btn:hover { color: var(--accent); }

/* 弹窗 */
.modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,.4); z-index: 300; display: flex; align-items: center; justify-content: center; }
.modal-box { background: var(--bg-card); border-radius: 12px; padding: 28px; max-width: 420px; width: 90%; }
.modal-box h3 { margin: 0 0 4px; color: var(--text-primary); }
.modal-box input { width: 100%; background: var(--bg-input); border: 1px solid var(--border); border-radius: 8px; padding: 10px 14px; font-size: 0.9rem; color: var(--text-primary); margin-bottom: 16px; }
.modal-box input:focus { outline: none; border-color: var(--accent); }
.modal-actions { display: flex; justify-content: flex-end; gap: 10px; }
.cancel-btn { background: var(--bg-hover); color: var(--text-secondary); padding: 8px 20px; border-radius: 8px; font-size: 0.9rem; border: none; cursor: pointer; }
.save-btn { background: var(--accent); color: #fff; padding: 8px 20px; border-radius: 8px; font-size: 0.9rem; border: none; cursor: pointer; }
.save-btn:disabled { opacity: 0.45; cursor: not-allowed; }
</style>