<template>
  <div class="discover">
    <div class="discover-main" ref="scrollRoot">
      <!-- 单条固定引导栏：当前模块标识 ｜ 地铁图 ｜ 换一批 -->
      <nav class="module-nav">
        <div class="nav-current" :class="`icon-${activeModuleId}`">
          <span class="module-icon" :class="`icon-${activeModuleId}`">
            <component :is="activeModule.icon" :size="19" :stroke-width="1.8" />
          </span>
          <Transition name="nav-label" mode="out-in">
            <span class="module-label" :key="activeModuleId">{{ activeModule.label }}</span>
          </Transition>
          <span class="module-badge" v-if="hasCounters[activeModuleId]">{{ hasCounters[activeModuleId] }}</span>
        </div>

        <div class="metro">
          <div class="metro-track"></div>
          <div
            class="metro-fill"
            :style="{ width: (75 * progress) + '%', background: activeColor }"
          ></div>
          <div class="metro-stops">
            <button
              v-for="(mod, idx) in moduleOrder"
              :key="`nav-${mod.id}`"
              class="nav-stop"
              :class="{ active: idx <= activeIndex }"
              @click="scrollToModule(mod.id)"
            >
              <span class="nav-dot" :class="`dot-${mod.id}`"></span>
              <span class="nav-stop-label">{{ mod.label }}</span>
            </button>
          </div>
        </div>

        <button class="shuffle-btn" :disabled="moduleLoading === activeModuleId" @click="refreshModule(activeModuleId)">
          <IconArrowsShuffle :size="15" :stroke-width="2" :class="{ spinning: moduleLoading === activeModuleId }" />
          换一批
        </button>
      </nav>

      <div v-if="loading && !hasData" class="state">
        <div class="spinner"></div>
        <span>加载中...</span>
      </div>

      <div v-else-if="error && !hasData" class="state">
        <IconAlertCircle :size="48" />
        <p>加载失败，请检查网络连接</p>
        <button @click="fetchAll" class="retry-btn">重试</button>
      </div>

      <div v-else-if="!ready && !hasData" class="state">
        <div class="spinner"></div>
        <span>推荐引擎准备中（候选池后台采集中）...</span>
      </div>

      <template v-else>
        <section
          v-for="(mod, modIdx) in moduleOrder"
          :key="mod.id"
          :id="`mod-${mod.id}`"
          class="module-section"
          :class="{ 'is-first': modIdx === 0 }"
        >
          <div v-if="modIdx > 0" class="module-header">
            <h2 class="module-title">
              <span class="module-icon" :class="`icon-${mod.id}`">
                <component :is="mod.icon" :size="19" :stroke-width="1.8" />
              </span>
              <span class="module-label">{{ mod.label }}</span>
              <span class="module-badge" v-if="hasCounters[mod.id]">{{ hasCounters[mod.id] }}</span>
            </h2>
          </div>

          <TransitionGroup name="cards" tag="div" class="anime-grid" appear>
            <AnimeCard
              v-for="(item, idx) in modules[mod.id]"
              :key="`${mod.id}-${item.bgmId}-${item.module}`"
              :anime="item"
              :style="{ transitionDelay: `${Math.min(idx * 25, 400)}ms` }"
              @click="goToAnime(item)"
            />
          </TransitionGroup>
          <div v-if="!modules[mod.id]?.length" class="module-empty">该模块暂无数据，稍后再试</div>
        </section>
      </template>

      <BackToTop target=".discover-main" />
    </div>

    <AnimeDetailPanel :keyword="selectedKeyword" @close="selectedKeyword = null" />
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted, onBeforeUnmount, nextTick } from 'vue'
import {
  IconAlertCircle,
  IconTrophy,
  IconFlame,
  IconSparkles,
  IconUsers,
  IconArrowsShuffle,
} from '@tabler/icons-vue'
import { getDiscoverModules, getDiscoverModule } from '@/api'
import AnimeCard from '@/components/AnimeCard.vue'
import AnimeDetailPanel from '@/components/AnimeDetailPanel.vue'
import BackToTop from '@/components/BackToTop.vue'

const moduleOrder = [
  { id: 'praise', icon: IconTrophy, label: '口碑神作榜' },
  { id: 'hot', icon: IconFlame, label: '热门佳作榜' },
  { id: 'try', icon: IconSparkles, label: '值得一试榜' },
  { id: 'popular', icon: IconUsers, label: '人气之作' },
]

const MOD_COLORS = {
  praise: 'var(--mod-praise)',
  hot: 'var(--mod-hot)',
  try: 'var(--mod-try)',
  popular: 'var(--mod-popular)',
}

const modules = reactive({})
const counts = reactive({})
const loading = ref(false)
const moduleLoading = ref(null)
const error = ref(false)
const ready = ref(false)
const updatedAt = ref(null)
const selectedKeyword = ref(null)
const scrollRoot = ref(null)

const activeIndex = ref(0)
const progress = ref(0)

const activeModuleId = computed(() => moduleOrder[activeIndex.value]?.id || 'praise')
const activeModule = computed(() => moduleOrder[activeIndex.value] || moduleOrder[0])
const activeColor = computed(() => MOD_COLORS[activeModuleId.value] || 'var(--mod-praise)')

const hasData = computed(() => moduleOrder.some(m => (modules[m.id] || []).length > 0))

const hasCounters = computed(() => {
  const c = {}
  for (const m of moduleOrder) if (counts[m.id] > 0) c[m.id] = counts[m.id]
  return c
})

async function fetchAll() {
  loading.value = true
  error.value = false
  try {
    const { data } = await getDiscoverModules()
    ready.value = data.ready
    updatedAt.value = data.updatedAt
    for (const [id, items] of Object.entries(data.modules || {})) {
      modules[id] = items
      counts[id] = items.length
    }
    await nextTick()
    setupObserver()
  } catch (e) {
    console.error('[DiscoverPage] modules 加载失败:', e)
    error.value = true
  } finally {
    loading.value = false
  }
}

async function refreshModule(modId) {
  if (moduleLoading.value) return
  moduleLoading.value = modId
  try {
    const { data } = await getDiscoverModule(modId, true)
    if (Array.isArray(data.items)) {
      modules[data.module] = data.items
      counts[data.module] = data.items.length
      if (data.updatedAt) updatedAt.value = data.updatedAt
    }
  } catch (e) {
    console.error(`[DiscoverPage] ${modId} 换一批失败:`, e)
  } finally {
    moduleLoading.value = null
  }
}

async function goToAnime(item) {
  selectedKeyword.value = item.nameCn || item.name
}

function scrollToModule(id) {
  const el = document.getElementById(`mod-${id}`)
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

// ── 地铁图进度 ──
let observer = null

function computeProgress() {
  const container = scrollRoot.value
  if (!container) return
  const line = container.getBoundingClientRect().top + 120
  const sections = moduleOrder.map(m => document.getElementById(`mod-${m.id}`)).filter(Boolean)
  if (sections.length === 0) return

  let idx = 0
  for (let i = 0; i < sections.length; i++) {
    if (sections[i].getBoundingClientRect().top <= line) idx = i
  }
  const cur = sections[idx]
  const next = sections[idx + 1]
  let frac = 0
  if (next) {
    const r = cur.getBoundingClientRect()
    const nr = next.getBoundingClientRect()
    const span = nr.top - r.top
    if (span > 0) frac = Math.min(1, Math.max(0, (line - r.top) / span))
  } else {
    frac = 1
  }
  activeIndex.value = idx
  progress.value = Math.min(1, (idx + frac) / Math.max(1, sections.length - 1))
}

function setupObserver() {
  observer?.disconnect()
  const container = scrollRoot.value
  if (!container) return
  const sections = moduleOrder.map(m => document.getElementById(`mod-${m.id}`)).filter(Boolean)
  if (sections.length === 0) return

  // 仅用 scroll + computeProgress 统一计算激活站；此处不再重复赋值 activeIndex，避免状态抖动
  observer = new IntersectionObserver(() => {
    computeProgress()
  }, { root: container, rootMargin: '0px 0px -70% 0px', threshold: 0 })

  sections.forEach(el => observer.observe(el))
  computeProgress()
}

onMounted(() => {
  fetchAll()
  if (scrollRoot.value) {
    scrollRoot.value.addEventListener('scroll', computeProgress, { passive: true })
  }
})

onBeforeUnmount(() => {
  observer?.disconnect()
  if (scrollRoot.value) scrollRoot.value.removeEventListener('scroll', computeProgress)
})
</script>

<style scoped>
.discover {
  display: flex;
  height: 100vh;
  overflow: hidden;
}
.discover-main {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 0 40px 32px;
  max-width: 1400px;
  position: relative;
}

/* 单条固定引导栏：当前模块标识 ｜ 地铁图 ｜ 换一批 */
.module-nav {
  position: sticky;
  top: 0;
  z-index: 20;
  display: flex;
  align-items: center;
  gap: 16px;
  margin: 0 -40px 8px;
  padding: 12px 40px;
  background: var(--bg-main);
  border-bottom: 1px solid var(--border);
}
.nav-current {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
  min-width: 0;
}
.nav-current .module-label {
  font-family: var(--font-ui);
  font-size: 1rem;
  font-weight: 600;
  color: var(--text-primary);
  white-space: nowrap;
  /* 固定宽度，避免切换时因文字长度不同导致地铁图/按钮整体缩进跳动 */
  min-width: 6.5em;
  text-align: center;
}
.nav-label-enter-active { transition: opacity 0.25s ease, transform 0.25s cubic-bezier(0.22, 1, 0.36, 1); }
.nav-label-leave-active { transition: opacity 0.15s ease, transform 0.15s ease; }
.nav-label-enter-from { opacity: 0; transform: translateY(4px); }
.nav-label-leave-to { opacity: 0; transform: translateY(-4px); }

.metro {
  position: relative;
  flex: 1;
  min-width: 0;
}
.metro-track,
.metro-fill {
  position: absolute;
  top: 8px;
  height: 2px;
  border-radius: 1px;
}
.metro-track {
  left: 12.5%;
  right: 12.5%;
  background: var(--border);
}
.metro-fill {
  left: 12.5%;
  width: 0;
  background: var(--mod-praise);
  transition: width 0.5s cubic-bezier(0.22, 1, 0.36, 1), background-color 0.4s ease;
}
.metro-stops {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: center;
}
.nav-stop {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  background: none;
  border: none;
  cursor: pointer;
  padding: 0;
}
.nav-dot {
  position: relative;
  z-index: 1;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--bg-card);
  border: 2px solid var(--border);
  transition: all 0.25s cubic-bezier(0.22, 1, 0.36, 1);
}
.nav-stop-label {
  font-size: 0.82rem;
  color: var(--text-secondary);
  font-weight: 500;
  transition: color 0.25s;
  white-space: nowrap;
}

.nav-stop.dot-praise .nav-dot { border-color: var(--mod-praise); }
.nav-stop.dot-hot .nav-dot { border-color: var(--mod-hot); }
.nav-stop.dot-try .nav-dot { border-color: var(--mod-try); }
.nav-stop.dot-popular .nav-dot { border-color: var(--mod-popular); }

.nav-stop.active .nav-dot {
  transform: scale(1.35);
}
.nav-stop.dot-praise.active .nav-dot { background: var(--mod-praise); border-color: var(--mod-praise); box-shadow: 0 2px 8px rgba(217, 169, 124, 0.5); }
.nav-stop.dot-hot.active .nav-dot { background: var(--mod-hot); border-color: var(--mod-hot); box-shadow: 0 2px 8px rgba(224, 135, 122, 0.5); }
.nav-stop.dot-try.active .nav-dot { background: var(--mod-try); border-color: var(--mod-try); box-shadow: 0 2px 8px rgba(224, 115, 63, 0.5); }
.nav-stop.dot-popular.active .nav-dot { background: var(--mod-popular); border-color: var(--mod-popular); box-shadow: 0 2px 8px rgba(224, 138, 94, 0.5); }
.nav-stop.active .nav-stop-label { color: var(--text-primary); font-weight: 600; }
.nav-stop:hover .nav-dot { transform: scale(1.2); }
.nav-stop:hover .nav-stop-label { color: var(--text-primary); }

.shuffle-btn {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  background: transparent;
  border: 1px solid var(--border);
  color: var(--text-secondary);
  padding: 6px 14px;
  border-radius: 999px;
  font-size: 0.78rem;
  font-weight: 500;
  transition: all 0.22s cubic-bezier(0.22, 1, 0.36, 1);
}
.shuffle-btn:hover:not(:disabled) {
  color: #fff;
  background: var(--accent);
  border-color: var(--accent);
  box-shadow: 0 4px 12px rgba(184, 53, 42, 0.22);
}
.shuffle-btn:disabled { opacity: 0.5; cursor: wait; }

/* 模块区块 */
.module-section {
  margin-bottom: 40px;
  scroll-margin-top: 120px;
}
.module-section.is-first {
  margin-top: 0;
  scroll-margin-top: 80px;
}
.module-header {
  display: flex;
  align-items: center;
  margin-bottom: 16px;
  padding: 8px 0;
  border-bottom: 1px solid var(--border);
}
.module-title {
  display: flex;
  align-items: center;
  gap: 10px;
  font-family: var(--font-ui);
  font-size: 1.15rem;
  font-weight: 600;
  letter-spacing: 0.03em;
  color: var(--text-primary);
  margin: 0;
}
.module-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border-radius: 10px;
  flex-shrink: 0;
}
.module-label {
  line-height: 1;
}
.module-icon.icon-praise { color: var(--mod-praise-strong); background: rgba(221, 178, 94, 0.16); border: 1px solid rgba(221, 178, 94, 0.30); }
.module-icon.icon-hot { color: var(--mod-hot-strong); background: rgba(224, 145, 63, 0.16); border: 1px solid rgba(224, 145, 63, 0.30); }
.module-icon.icon-try { color: var(--mod-try-strong); background: rgba(224, 115, 63, 0.16); border: 1px solid rgba(224, 115, 63, 0.30); }
.module-icon.icon-popular { color: var(--mod-popular-strong); background: rgba(217, 95, 74, 0.16); border: 1px solid rgba(217, 95, 74, 0.30); }
.module-badge {
  font-size: 0.7rem;
  font-weight: 500;
  color: var(--text-secondary);
  background: var(--bg-input);
  padding: 2px 8px;
  border-radius: 10px;
}

.spinning { animation: spin 0.8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

/* 卡片入场/离场动画 */
.cards-enter-active { transition: opacity 0.45s cubic-bezier(0.22, 1, 0.36, 1), transform 0.45s cubic-bezier(0.22, 1, 0.36, 1); }
.cards-leave-active { transition: opacity 0.2s ease, transform 0.2s ease; }
.cards-enter-from { opacity: 0; transform: translateY(18px) scale(0.96); }
.cards-leave-to { opacity: 0; transform: scale(0.96); }
.cards-move { transition: transform 0.4s ease; }

/* 卡片网格（统一 auto-fill） */
.anime-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(170px, 1fr));
  gap: 16px;
}
@media (max-width: 900px) {
  .anime-grid { grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); }
  .discover-main { padding: 0 20px 32px; }
}
@media (max-width: 600px) {
  .anime-grid { grid-template-columns: repeat(2, 1fr); }
  .discover-main { padding: 0 16px 32px; }
}

.module-empty {
  font-size: 0.85rem;
  color: var(--text-secondary);
  padding: 40px 0;
  text-align: center;
}

/* 状态 */
.state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
  padding: 80px 0;
  color: var(--text-secondary);
}
.spinner {
  width: 36px;
  height: 36px;
  border: 3px solid var(--border);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}
.retry-btn {
  background: var(--accent);
  color: #fff;
  padding: 10px 24px;
  border-radius: var(--radius);
  font-size: 0.9rem;
}
</style>