<template>
  <div class="downloads">
    <div class="downloads-main" ref="scrollRoot">
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

      <!-- 季度筛选标签 -->
      <div v-if="seasonOptions.length > 0" class="season-filter-bar">
        <button
          class="season-filter-chip"
          :class="{ active: seasonFilter === 'all' }"
          @click="seasonFilter = 'all'"
        >全部</button>
        <button
          v-for="opt in seasonOptions"
          :key="opt.value"
          class="season-filter-chip"
          :class="{ active: seasonFilter === opt.value }"
          @click="seasonFilter = opt.value"
        >{{ opt.label }}</button>
      </div>

      <!-- 番剧海报卡片网格（与首页/发现页一致） -->
      <div v-if="filteredAnime.length > 0" class="anime-grid">
        <AnimeCard
          v-for="group in filteredAnime"
          :key="group.key"
          :ref="el => setCardRef(group.key, el)"
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
    </div>

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
const scrollRoot = ref(null)
const cardRefs = ref({})
function setCardRef(key, el) {
  if (el) cardRefs.value[key] = el
  else delete cardRefs.value[key]
}

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
    const season = t.season || 1
    // 按番剧 + 季分组（每季一张卡；同番不同季是不同 Mikan ID，不合并）
    const key = `${t.mikanId || t.animeName || 'unknown'}_${season}`
    if (!groups[key]) {
      groups[key] = {
        key,
        mikanId: t.mikanId,
        animeName: t.animeName || '未命名',
        season,
        episodes: [],
        poster: posterCache.value[t.mikanId] || '',
      }
    }
    const state = t.state || ''
    const progress = t.progress ?? 0
    const isDone = progress >= 1 || ['uploading', 'forcedUP', 'stalledUP', 'pausedUP'].includes(state)
    // episode 可能是纯数字 "04" 或合集范围 "1-12" / "4-5"
    const epStr = t.episode
    const seasonPad = String(season).padStart(2, '0')
    const isRange = epStr != null && epStr !== 'null' && epStr.includes('-')
    const rangeStart = isRange ? parseInt(epStr.split('-')[0]) : null
    const epNum = !isRange && epStr != null && epStr !== 'null' ? parseInt(epStr) : null
    const epLabel = isRange
      ? `S${seasonPad}E${epStr}`
      : (epNum != null
        ? `S${seasonPad}E${String(epNum).padStart(2, '0')}`
        : (epStr && epStr !== 'null' ? `S${seasonPad}E${epStr}` : '--'))

    groups[key].episodes.push({
      hash: t.hash,
      label: epLabel,
      season,
      subgroupName: t.subgroupName || '',
      episode: isRange ? epStr : (epNum || 0),
      sortEp: rangeStart || epNum || 0,
      isRange,
      progress: isDone ? 1 : progress,
      qbState: state,
      isDone,
      size: t.size || 0,
      name: t.name || '',
      fileCount: t.fileCount || 1,
      files: t.files || [],
    })
  }

  const result = Object.values(groups).map(g => {
    g.episodes.sort((a, b) => a.sortEp - b.sortEp)
    // 聚合：实际下载的字幕组
    const subgroups = [...new Set(g.episodes.map(e => e.subgroupName).filter(Boolean))]
    g.subgroups = subgroups
    g.subgroupLabel = subgroups.join(' · ') || ''
    g.seasons = [g.season]
    g.seasonRange = `SE${String(g.season).padStart(2, '0')}`

    const nums = g.episodes.map(e => e.sortEp).filter(n => n > 0).sort((a, b) => a - b)
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

// 季度（SE）筛选
const seasonFilter = ref('all')
const seasonOptions = computed(() => {
  const s = new Set()
  for (const g of groupedAnime.value) for (const n of (g.seasons || [])) s.add(n)
  return [...s].sort((a, b) => a - b).map(n => ({ value: n, label: `SE${String(n).padStart(2, '0')}` }))
})
const filteredAnime = computed(() => {
  if (seasonFilter.value === 'all') return groupedAnime.value
  return groupedAnime.value.filter(g => (g.seasons || []).includes(seasonFilter.value))
})

const activeCount = computed(() => {
  return animeTorrents.value.filter(t => ['downloading', 'forcedDL', 'stalledDL'].includes(t.state)).length
})

// 当前选中的下载组（右侧详情侧边栏）
const selectedGroup = computed(() => groupedAnime.value.find(g => g.key === selectedKey.value) || null)

function openDetail(group) {
  selectedKey.value = group.key
  // 等侧边栏 320ms 宽度展开动画结束后：卡片未完全可见才滚动到可见（已完全可见则不滚）
  setTimeout(() => scrollCardIntoView(cardRefs.value?.[group.key]), 400)
}

function scrollCardIntoView(el) {
  const container = scrollRoot.value
  if (!el || !container) return
  const er = el.getBoundingClientRect()
  const cr = container.getBoundingClientRect()
  const fullyVisible = er.top >= cr.top && er.bottom <= cr.bottom
  if (!fullyVisible) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

function badgeOf(g) {
  return g.episodes.length > 0 && g.doneCount === g.episodes.length ? '已完成' : `${g.doneCount}/${g.episodes.length}`
}
function metaOf(g) {
  return `${g.seasonRange}${g.subgroupLabel ? ' · ' + g.subgroupLabel : ''}`
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

    // 拉取海报：去重 mikanId
    const seenMikanIds = new Set()
    for (const t of animeTorrents.value) {
      if (t.mikanId && !seenMikanIds.has(t.mikanId)) {
        seenMikanIds.add(t.mikanId)
        getSubDetail(t.mikanId).then(({ data }) => {
          if (data?.detail?.poster) {
            posterCache.value[t.mikanId] = data.detail.poster
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
/* flex 布局：左侧内容区 + 右侧详情侧边栏（推挤，不遮挡） */
.downloads { display: flex; height: 100vh; overflow: hidden; }
.downloads-main {
  flex: 1; min-width: 0; overflow-y: auto;
  padding: 32px 40px;
}
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

/* 季度筛选标签栏 */
.season-filter-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-bottom: 16px;
}
.season-filter-chip {
  padding: 4px 14px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--bg-input);
  color: var(--text-secondary);
  font-size: 0.78rem;
  cursor: pointer;
  transition: all 0.2s;
}
.season-filter-chip:hover { color: var(--text-primary); border-color: var(--accent); }
.season-filter-chip.active {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
  font-weight: 600;
}

/* 番剧海报网格（与首页/发现页一致） */
.anime-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(170px, 1fr));
  gap: 16px;
}
</style>