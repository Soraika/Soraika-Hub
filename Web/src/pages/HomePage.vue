<template>
  <div class="home">
    <div ref="scrollHost" class="home-main scroll-area">
      <!-- ── 顶部引导栏（吸顶，顺序固定：季选 → 搜索 → 星期地铁图） ──────── -->
      <header class="topbar topbar-surface">
        <div class="topbar-inner">
          <SeasonPicker
            :label="season.label"
            :years="years"
            :active-year="season.year"
            :active-season="season.season"
            @select="onSelectSeason"
          />

          <SearchBox v-model="keyword" class="topbar-search" @submit="$emit('search', $event)" />

          <MetroNav
            class="topbar-metro"
            :stops="WEEK_STOPS"
            :active-index="activeIndex"
            :progress="progress"
            aria-label="星期导航"
            @select="onSelectDay"
          />
        </div>
      </header>

      <!-- ── 三态：由 uiState 预览切换（接接口后由请求状态驱动） ────────── -->
      <StateBlock v-if="uiState === 'loading'" state="loading" text="正在加载本周排期…" />
      <StateBlock
        v-else-if="uiState === 'error'"
        state="error"
        text="加载失败，请检查网络连接"
        retry-text="重试"
        @retry="$emit('reload')"
      />
      <StateBlock v-else-if="uiState === 'empty'" state="empty" text="本季度暂无排期数据" />

      <!-- ── 排期：顺序由 DAY_ORDER 决定（默认以今天为首），剧场版 / OVA 固定最后 ── -->
      <div v-else class="schedule">
        <section
          v-for="group in SCHEDULE_SECTIONS"
          :id="`day-${group.day}`"
          :key="group.day"
          class="day-section"
          :class="{ 'is-today': group.day === TODAY }"
        >
          <h2 class="day-label">
            {{ group.dayLabel }}
            <span v-if="group.day === TODAY" class="today-chip">{{ TODAY_LABEL }}</span>
          </h2>

          <!-- 卡片网格：items 传「当前要显示的那一批」，搜索 / 筛选 / 排序都在页面层算好 -->
          <CardGrid :items="group.items">
            <template #default="{ item }">
              <PosterCard
                :title="item.title"
                :poster="item.poster"
                :badge="group.badge"
                badge-tone="week"
                :score="item.score"
                :score-text="item.scoreText"
                :rating-text="item.ratingText"
                :meta-text="item.metaText"
                :selected="item.id === activeAnimeId"
                @click="$emit('open-anime', item)"
              />
            </template>
          </CardGrid>

          <p v-if="!group.items.length" class="day-empty">本日无更新</p>
        </section>
      </div>

      <BackToTop target=".home-main" />
    </div>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'
import SeasonPicker from '@/components/common/SeasonPicker.vue'
import SearchBox from '@/components/common/SearchBox.vue'
import MetroNav from '@/components/common/MetroNav.vue'
import PosterCard from '@/components/common/PosterCard.vue'
import CardGrid from '@/components/common/CardGrid.vue'
import StateBlock from '@/components/ui/StateBlock.vue'
import BackToTop from '@/components/ui/BackToTop.vue'
import { useScrollSpy } from '@/composables/useScrollSpy'
import {
  WEEK_ORDER_MODES,
  WEEKDAY_LABELS,
  WEEKDAY_SHORTS,
  TODAY_LABEL,
  buildWeekOrder,
} from '@/utils/weekOrder'
/**
 * 首页：本周更新排期
 * 只负责「怎么摆」：顶部引导栏（季选 / 搜索 / 星期地铁图）+ 按星期分组的卡片网格。
 * 数据全部来自 props（容器 App.vue 调 useSchedule 取的），交互全部上抛事件
 * （select-season / search / select-day / open-anime / reload）——
 * 本组件不请求、不跳转、不改全局状态。
 */
const props = defineProps({
  /** 后端分好组的排期：[{ day, dayLabel, badge, items:[{id,title,poster,score,ratingText,metaText}] }] */
  days: { type: Array, default: () => [] },
  /** 季选年份列表：[{ year, disabled: ['秋', ...] }]（后端下发） */
  years: { type: Array, default: () => [] },
  /** 当前季：{ year, season, label }，label 是成品字符串（如「2026 秋」） */
  season: { type: Object, default: () => ({ year: 0, season: '', label: '' }) },
  /** 三态：ready | loading | error | empty（由请求状态驱动） */
  uiState: { type: String, default: 'loading' },
  /** 当前详情面板里那部作品的主键（卡片选中态用；null = 面板关着） */
  activeAnimeId: { type: Number, default: null },
})

const emit = defineEmits(['select-season', 'search', 'select-day', 'open-anime', 'reload'])

// ── 页面自身的本地展示状态（非业务状态） ────────────────────────────────
const keyword = ref('')

// ══════════════════════════════════════════════════════════════════════════
// 星期顺序 —— 全页唯一的顺序来源
// 地铁 7 站、排期区块顺序、滚动联动目标，全部由下面的 DAY_ORDER 推导出来。
// 以后要改成「以今天为首 / 周一为首 / 周日为首 / 任意自定义」，只动这三行；
// 若要支持运行时切换（设置页改完立即生效），把 DAY_ORDER 换成 computed 即可。
// ══════════════════════════════════════════════════════════════════════════
const DAY_ORDER_MODE = WEEK_ORDER_MODES.TODAY_FIRST // 默认：以今天为首
const TODAY = new Date().getDay() // 【临时】取本地日期；接接口后改为服务端下发的「今天」
const DAY_ORDER = buildWeekOrder(DAY_ORDER_MODE, TODAY) // 例：今天周三 → [3,4,5,6,0,1,2]

// 地铁 7 站：顺序 = DAY_ORDER；今天那站带 today 标记（悬停显示「周三 · 今天」）
const WEEK_STOPS = DAY_ORDER.map((day) => ({
  key: day,
  label: WEEKDAY_SHORTS[day],
  title: day === TODAY ? `${WEEKDAY_LABELS[day]} · ${TODAY_LABEL}` : WEEKDAY_LABELS[day],
  today: day === TODAY,
}))

// ── 地铁图：位置与填充全部由滚动位置算出（通用 composable，发现页共用） ──
const scrollHost = ref(null)
const { activeIndex, progress, scrollToIndex } = useScrollSpy({
  root: scrollHost,
  // 只与 7 个星期区块联动；剧场版 / OVA 排在星期之后，走到时线路视为已走满
  ids: () => DAY_ORDER.map((day) => `day-${day}`),
  offset: 108, // 判定线：吸顶栏底部附近（与 .day-section 的 scroll-margin-top 对齐）
})

function onSelectSeason(year, season) {
  // 只上抛，由容器去请求新季 —— 页面不再持有选中季（选中季以服务端返回的为准）
  emit('select-season', year, season)
}

function onSelectDay(key) {
  // 点站 → 平滑滚到对应星期区块；滚动过程中由 scroll spy 反向更新选中站
  const idx = WEEK_STOPS.findIndex((s) => s.key === key)
  if (idx >= 0) {
    activeIndex.value = idx // 立即反馈，避免平滑滚动期间的滞后感
    scrollToIndex(idx)
  }
  emit('select-day', key)
}

// ══════════════════════════════════════════════════════════════════════════
// 排期数据由容器注入（App.vue → useSchedule → /api/home/schedule），
// 页面只负责按 DAY_ORDER 摆位置。字段契约见 Server/src/api/pages/home.js。
// ══════════════════════════════════════════════════════════════════════════




/**
 * 排期区块：顺序完全由 DAY_ORDER 决定
 * —— 与后端返回顺序无关（按 day 建索引）。
 * - 星期缺失该天数据时补一个空区块，保证地铁 7 站始终有落点
 * - 非星期内容（day > 6，剧场版 / OVA）固定排在星期之后，按 day 升序
 */
const SCHEDULE_SECTIONS = computed(() => {
  const byDay = new Map(props.days.map((g) => [g.day, g]))
  const weekdays = DAY_ORDER.map(
    (day) =>
      byDay.get(day) || {
        day,
        dayLabel: WEEKDAY_LABELS[day],
        badge: WEEKDAY_SHORTS[day],
        items: [],
      },
  )
  const extras = props.days.filter((g) => g.day > 6).sort((a, b) => a.day - b.day)
  return [...weekdays, ...extras]
})

</script>

<style scoped>
/* ── 页面骨架：自身持有滚动容器，吸顶栏与回到顶部都锚定在它上面 ───────── */
.home {
  display: flex;
  height: 100vh;
  overflow: hidden;
}
.home-main {
  position: relative;
  flex: 1;
}

/* ── 顶部引导栏（实色吸顶，允许被 BackToTop 与下拉面板覆盖） ─────────── */
.topbar {
  position: sticky;
  top: 0;
  z-index: 30;
  padding: 14px var(--page-pad-x);
}
.topbar-inner {
  display: flex;
  align-items: center;
  gap: 16px;
}
.topbar-search {
  width: 300px;
  flex-shrink: 0;
}
.topbar-metro {
  flex: 1;
  min-width: 300px;
}

/* ── 排期 ─────────────────────────────────────────────────────────────── */
.schedule {
  display: flex;
  flex-direction: column;
  gap: 30px;
  padding: 18px var(--page-pad-x) 72px;
}

.day-section {
  display: flex;
  flex-direction: column;
  gap: 12px;
  /* 供 scrollToIndex 定位时避让吸顶栏（值需与 useScrollSpy 的 offset 对齐） */
  scroll-margin-top: 108px;
}

.day-label {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 1.05rem;
  font-weight: 700;
  color: var(--text-primary);
}
/* 标题右侧延伸细线，弱化分割、拉开节奏 */
.day-label::after {
  content: '';
  flex: 1;
  height: 1px;
  background: var(--border);
}

/* ── 「今天」：标题着色 + 徽标（TODAY_FIRST 模式下它天然是第一个区块） ─── */
.day-section.is-today .day-label {
  color: var(--accent-strong);
}
.today-chip {
  padding: 1px 8px;
  border-radius: var(--radius-pill);
  background: var(--accent-soft);
  color: var(--accent-strong);
  font-size: 0.68rem;
  font-weight: 600;
  letter-spacing: 0.02em;
}

.day-empty {
  padding: 6px 2px;
  color: var(--text-tertiary);
  font-size: 0.85rem;
}

/* ── 窄屏：地铁图换到第二行，避免与季选/搜索抢宽度 ───────────────────── */
@media (max-width: 1180px) {
  .topbar-inner {
    flex-wrap: wrap;
  }
  .topbar-search {
    flex: 1;
    width: auto;
  }
  .topbar-metro {
    order: 3;
    width: 100%;
    min-width: 0;
    flex-basis: 100%;
  }
}
@media (max-width: 720px) {
  .topbar {
    padding: 12px 16px;
  }
  .schedule {
    padding: 14px 16px 64px;
    gap: 24px;
  }
}
</style>
