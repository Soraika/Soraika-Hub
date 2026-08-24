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

      <!-- 番剧海报卡片网格（与首页/发现页一致） -->
      <div v-if="groupedAnime.length > 0" class="anime-grid">
        <AnimeCard
          v-for="group in groupedAnime"
          :key="group.key"
          :anime="{ poster: group.poster, title: group.animeName, name: group.animeName }"
          :badge-label="badgeOf(group)"
          :show-rating="false"
          :meta-text-override="metaOf(group)"
          @click="openDetail(group)"
        />
      </div>
      <div v-else class="state">
        <IconMoodEmpty :size="48" />
        <p>暂无本平台下载任务</p>
      </div>
    </template>

    <!-- 下载详情侧边栏 -->
    <DownloadDetailPanel :group="selectedGroup" @close="selectedKey = null" @changed="fetchAll" />
  </div>
</template>


<script setup>
import { ref, reactive, computed, watch, onMounted, onUnmounted } from 'vue'
import { IconRefresh, IconMoodEmpty } from '@tabler/icons-vue'
import { getQBStatus, getAnimeTorrents, getSubDetail } from '@/api'
import { createLogger } from '@/utils/logger'
import AnimeCard from '@/components/AnimeCard.vue'
import DownloadDetailPanel from '@/components/DownloadDetailPanel.vue'

const log = createLogger('DownloadsPage')

const loading = ref(true)
const isSpinning = ref(false)
const animeTorrents = ref([])
const posterCache = ref({})
const selectedKey = ref(null)

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

// 当前选中的下载组（右侧详情侧边栏）
const selectedGroup = computed(() => groupedAnime.value.find(g => g.key === selectedKey.value) || null)

function openDetail(group) { selectedKey.value = group.key }

function badgeOf(g) {
  return g.episodes.length > 0 && g.doneCount === g.episodes.length ? '已完成' : `${g.doneCount}/${g.episodes.length}`
}
function metaOf(g) {
  return `SE${String(g.season).padStart(2, '0')}${g.subgroupName ? ' · ' + g.subgroupName : ''}`
}

// ── helpers ──

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
.downloads { padding: 32px 40px; max-width: 1400px; }
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

/* 番剧海报网格（与首页/发现页一致） */
.anime-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(170px, 1fr));
  gap: 16px;
}
</style>