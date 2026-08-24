<template>
  <div class="home">
    <div class="home-main" ref="scrollRoot">
      <!-- 固定顶部引导栏：季选 → 搜索 → 星期地铁图 -->
      <header class="topbar">
        <SeasonPicker />
        <div class="search-box">
          <IconSearch :size="18" class="search-icon" />
          <input v-model="keyword" placeholder="搜索番剧..." @keyup.enter="search" />
          <button class="search-btn" @click="search"><IconArrowRight :size="18" /></button>
        </div>
        <nav class="week-nav" aria-label="星期导航">
          <div class="metro">
            <div class="metro-track"></div>
            <div
              class="metro-fill"
              :style="{ width: (85.72 * progress) + '%' }"
            ></div>
            <div class="metro-stops">
              <button
                v-for="(stop, idx) in weekStops"
                :key="`week-${stop.day}`"
                class="nav-stop"
                :class="{ active: idx <= activeIndex }"
                @click="scrollToDay(stop.day)"
              >
                <span class="nav-dot"></span>
                <span class="nav-stop-label">{{ stop.short }}</span>
              </button>
            </div>
          </div>
        </nav>
      </header>

      <div v-if="loading" class="state">
        <div class="spinner"></div>
        <span>加载中...</span>
      </div>

      <div v-else-if="error" class="state">
        <IconAlertCircle :size="48" />
        <p>加载失败，请检查网络连接</p>
        <button @click="fetchData" class="retry-btn">重试</button>
      </div>

      <div v-else class="schedule">
        <section
          v-for="group in orderedSchedule"
          :key="group.day"
          :id="`day-${group.day}`"
          class="day-section"
        >
          <h2 class="day-label">{{ group.dayLabel }}</h2>
          <TransitionGroup name="cards" tag="div" class="anime-grid" appear>
            <AnimeCard
              v-for="(anime, idx) in group.animes"
              :key="anime.mikanId"
              :ref="el => setCardRef(anime.mikanId, el)"
              :anime="anime"
              :badge-label="shortLabel(group.dayLabel)"
              :show-rating="false"
              :style="{ transitionDelay: `${Math.min(idx * 25, 400)}ms` }"
              @click="goToAnime(anime.mikanId)"
            />
          </TransitionGroup>
        </section>
      </div>

      <BackToTop target=".home-main" />
    </div>

    <AnimeDetailPanel :subjectId="selectedSubjectId" @close="selectedSubjectId = null" />
  </div>
</template>

<script setup>
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import { useRouter } from 'vue-router'
import { IconSearch, IconArrowRight, IconAlertCircle } from '@tabler/icons-vue'
import { useAppStore } from '@/stores/app'
import { getSchedule } from '@/api'
import SeasonPicker from '@/components/SeasonPicker.vue'
import AnimeCard from '@/components/AnimeCard.vue'
import BackToTop from '@/components/BackToTop.vue'
import AnimeDetailPanel from '@/components/AnimeDetailPanel.vue'

const store = useAppStore()
const router = useRouter()
const schedule = ref([])
const loading = ref(false)
const error = ref(false)
const keyword = ref('')
const selectedSubjectId = ref(null)
const cardRefs = ref({})
function setCardRef(key, el) {
  if (el) cardRefs.value[key] = el
  else delete cardRefs.value[key]
}
const scrollRoot = ref(null)

const activeIndex = ref(0)
const progress = ref(0)

// 固定 7 站：周日 → 周六，顺序固定，不再"今天环绕"
const WEEK_STOPS = [
  { day: 0, short: '日' },
  { day: 1, short: '一' },
  { day: 2, short: '二' },
  { day: 3, short: '三' },
  { day: 4, short: '四' },
  { day: 5, short: '五' },
  { day: 6, short: '六' },
]
const weekStops = WEEK_STOPS

const DAY_SHORT = { '周日': '日', '周一': '一', '周二': '二', '周三': '三', '周四': '四', '周五': '五', '周六': '六', '剧场版': '剧场', 'OVA': 'OVA' }
const DAY_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
function shortLabel(label) { return DAY_SHORT[label] || label.slice(0, 2) }

// 内容顺序固定：周日→周六（缺失的天补空 section，保证地铁图 7 站始终有对应区块），剧场版/OVA 排最后
const orderedSchedule = computed(() => {
  const items = schedule.value || []
  const byDay = new Map()
  for (const g of items) byDay.set(g.day, g)

  const weekdays = []
  for (let d = 0; d <= 6; d++) {
    const g = byDay.get(d)
    weekdays.push(g || { day: d, dayLabel: DAY_LABELS[d], animes: [] })
  }

  const extras = items.filter(g => g.day > 6).sort((a, b) => a.day - b.day)
  return [...weekdays, ...extras]
})

async function fetchData() {
  loading.value = true
  error.value = false
  try {
    const { data } = await getSchedule(store.currentYear, store.currentSeason)
    schedule.value = data.items || []
    await nextTick()
    computeProgress()
  } catch {
    error.value = true
  } finally {
    loading.value = false
  }
}

function search() {
  if (keyword.value.trim()) router.push({ name: 'Search', query: { q: keyword.value.trim() } })
}

function goToAnime(mikanId) {
  selectedSubjectId.value = mikanId
  // 面板展开后：卡片未完全可见才滚动到可见（已完全可见则不滚）
  setTimeout(() => scrollCardIntoView(cardRefs.value?.[mikanId]), 400)
}

function scrollCardIntoView(el) {
  const container = scrollRoot.value
  if (!el || !container) return
  const er = el.getBoundingClientRect()
  const cr = container.getBoundingClientRect()
  const fullyVisible = er.top >= cr.top && er.bottom <= cr.bottom
  if (!fullyVisible) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

function scrollToDay(day) {
  const el = document.getElementById(`day-${day}`)
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

// ── 星期地铁图进度：固定 7 站，走满到周六 ──
function computeProgress() {
  const container = scrollRoot.value
  if (!container) return
  const line = container.getBoundingClientRect().top + 100
  const sections = weekStops.map(g => document.getElementById(`day-${g.day}`)).filter(Boolean)
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
  progress.value = Math.min(1, (idx + frac) / 6)
}

watch(() => [store.currentYear, store.currentSeason], fetchData)
onMounted(() => {
  fetchData()
  if (scrollRoot.value) {
    scrollRoot.value.addEventListener('scroll', computeProgress, { passive: true })
  }
})
onBeforeUnmount(() => {
  if (scrollRoot.value) scrollRoot.value.removeEventListener('scroll', computeProgress)
})
</script>

<style scoped>
.home {
  display: flex; height: 100vh; overflow: hidden;
}
.home-main {
  flex: 1; overflow-y: auto; overflow-x: hidden;
  padding: 0 40px 32px;
  position: relative;
}

/* 固定引导栏：实色不透明，紧贴顶部 */
.topbar {
  position: sticky;
  top: 0;
  z-index: 20;
  display: flex;
  align-items: center;
  gap: 20px;
  margin: 0 -40px 24px;
  padding: 14px 40px;
  background: var(--bg-main);
  border-bottom: 1px solid var(--border);
}

/* 星期地铁图（发现页同款：轨道 + 渐变填充线 + 圆点站点） */
.week-nav {
  flex: 1;
  min-width: 0;
  display: flex;
  justify-content: flex-end;
}
.metro {
  position: relative;
  width: 100%;
  max-width: 420px;
}
.metro-track,
.metro-fill {
  position: absolute;
  top: 7px;
  height: 2px;
  border-radius: 1px;
}
.metro-track {
  left: 7.14%;
  right: 7.14%;
  background: var(--border);
}
.metro-fill {
  left: 7.14%;
  width: 0;
  background: var(--metro-grad);
  transition: width 0.5s cubic-bezier(0.22, 1, 0.36, 1);
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
  width: 15px;
  height: 15px;
  border-radius: 50%;
  background: var(--bg-card);
  border: 2px solid var(--border);
  transition: all 0.25s cubic-bezier(0.22, 1, 0.36, 1);
}
.nav-stop-label {
  font-size: 0.8rem;
  color: var(--text-secondary);
  font-weight: 600;
  transition: color 0.25s;
  white-space: nowrap;
}
.nav-stop.active .nav-dot {
  background: var(--mod-hot);
  border-color: var(--mod-hot);
  box-shadow: 0 0 0 4px rgba(224, 145, 63, 0.16), 0 3px 10px rgba(224, 145, 63, 0.4);
  transform: scale(1.15);
}
.nav-stop.active .nav-stop-label { color: var(--text-primary); font-weight: 700; }
.nav-stop:hover .nav-dot {
  border-color: var(--mod-hot);
  box-shadow: 0 0 0 3px rgba(224, 145, 63, 0.12);
  transform: scale(1.15);
}
.nav-stop:hover .nav-stop-label { color: var(--text-primary); }

.search-box {
  flex-shrink: 0;
  width: 240px;
  display: flex;
  align-items: center;
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 0 14px;
  transition: border-color 0.2s;
}
.search-box:focus-within { border-color: var(--accent); }
.search-icon { color: var(--text-secondary); flex-shrink: 0; }
.search-box input {
  flex: 1; background: none; border: none; color: var(--text-primary);
  font-size: 0.9rem; padding: 9px 0; margin: 0 10px; min-width: 0;
}
.search-btn { background: none; color: var(--text-secondary); padding: 4px; border-radius: 6px; }
.search-btn:hover { color: var(--accent); background: var(--bg-hover); }

.state { display: flex; flex-direction: column; align-items: center; gap: 16px; padding: 80px 0; color: var(--text-secondary); }
.spinner {
  width: 36px; height: 36px; border: 3px solid var(--border);
  border-top-color: var(--accent); border-radius: 50%; animation: spin 0.8s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
.retry-btn { background: var(--accent); color: #fff; padding: 10px 24px; border-radius: var(--radius); font-size: 0.9rem; }

.day-section { margin-bottom: 40px; scroll-margin-top: 96px; }
.day-label {
  font-family: var(--font-ui); font-size: 1.4rem; font-weight: 600;
  color: var(--accent-gold); margin-bottom: 16px; padding-bottom: 8px; border-bottom: 1px solid var(--border);
}
.anime-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 20px; }

/* 卡片错峰淡入 */
.cards-enter-active { transition: opacity 0.45s cubic-bezier(0.22, 1, 0.36, 1), transform 0.45s cubic-bezier(0.22, 1, 0.36, 1); }
.cards-leave-active { transition: opacity 0.2s ease, transform 0.2s ease; }
.cards-enter-from { opacity: 0; transform: translateY(18px) scale(0.96); }
.cards-leave-to { opacity: 0; transform: scale(0.96); }
.cards-move { transition: transform 0.4s ease; }
</style>