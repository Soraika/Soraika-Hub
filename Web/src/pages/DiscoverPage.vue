<template>
  <div class="discover">
    <div ref="scrollHost" class="discover-main scroll-area">
      <!-- ── 吸顶引导栏：当前模块标识 ｜ 模块地铁图 ｜ 换一批 ─────────────── -->
      <header class="topbar topbar-surface">
        <div class="topbar-inner">
          <!-- 当前模块：图标 + 名称（切换时纵向淡换）+ 数量 -->
          <div class="current">
            <span class="icon-chip sm" :class="`tone-${activeModule.id}`">
              <component :is="activeModule.icon" :size="18" :stroke-width="1.9" />
            </span>
            <Transition name="module-label" mode="out-in">
              <span :key="activeModule.id" class="current-label">{{ activeModule.label }}</span>
            </Transition>
            <span v-if="countOf(activeModule.id)" class="current-count">{{ countOf(activeModule.id) }} 部</span>
          </div>

          <!-- 模块地铁图：4 站各取自身模块色，填充色跟随当前模块 -->
          <MetroNav
            class="topbar-metro"
            :stops="MODULE_STOPS"
            :active-index="activeIndex"
            :progress="progress"
            :fill-color="activeColor"
            aria-label="推荐模块导航"
            @select="onSelectModule"
          />

          <button class="shuffle-btn" type="button" :disabled="!!refreshing" @click="onRefresh">
            <IconArrowsShuffle :size="15" :stroke-width="2" :class="{ spinning: !!refreshing }" />
            换一批
          </button>
        </div>
      </header>

      <!-- ── 三态：由 uiState 预览切换（接接口后由请求状态驱动） ──────────── -->
      <StateBlock v-if="uiState === 'loading'" state="loading" text="正在生成今日推荐…" />
      <StateBlock
        v-else-if="uiState === 'error'"
        state="error"
        text="加载失败，请检查网络连接"
        retry-text="重试"
        @retry="$emit('reload')"
      />
      <StateBlock v-else-if="uiState === 'empty'" state="empty" text="暂无可推荐的番剧，稍后再来" />

      <!-- ── 四个推荐模块：顺序固定（= 站点顺序），不随内容多少变化 ───────── -->
      <div v-else class="modules">
        <section
          v-for="(mod, modIdx) in MODULES"
          :id="`mod-${mod.id}`"
          :key="mod.id"
          class="module-section"
        >
          <!-- 首个模块不重复标题：吸顶栏已标出当前模块，只在模块之间做分隔 -->
          <header v-if="modIdx > 0" class="module-header">
            <span class="icon-chip" :class="`tone-${mod.id}`">
              <component :is="mod.icon" :size="19" :stroke-width="1.9" />
            </span>
            <h2 class="module-title">{{ mod.label }}</h2>
            <span v-if="countOf(mod.id)" class="module-count">{{ countOf(mod.id) }} 部</span>
          </header>

          <!-- 卡片不挂模块徽标：区块标题已表明模块，避免同一信息刷两遍
               （沿用旧版决定；如需单卡带色，给 PosterCard 传 badge / badge-tone 即可） -->
          <TransitionGroup
            v-if="itemsOf(mod.id).length"
            name="cards"
            tag="div"
            class="anime-grid"
            appear
          >
            <PosterCard
              v-for="(item, idx) in itemsOf(mod.id)"
              :key="item.id"
              :title="item.title"
              :poster="item.poster"
            :poster-fallbacks="item.posterFallbacks || []"
              poster-placeholder="海报待生成"
              :score="item.score"
              :score-text="item.scoreText"
              :rating-text="item.ratingText"
              :meta-text="item.metaText"
              :link-url="item.bgmId ? `https://bgm.tv/subject/${item.bgmId}` : ''"
              link-title="打开 Bangumi 条目"
              :style="{ transitionDelay: `${Math.min(idx * 25, 400)}ms` }"
              @click="$emit('open-anime', item.id)"
            />
          </TransitionGroup>

          <p v-else class="module-empty">该模块暂无数据，稍后重试</p>
        </section>
      </div>

      <BackToTop target=".discover-main" />
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onBeforeUnmount } from 'vue'
import {
  IconTrophy,
  IconFlame,
  IconSparkles,
  IconUsers,
  IconArrowsShuffle,
} from '@tabler/icons-vue'
import MetroNav from '@/components/common/MetroNav.vue'
import PosterCard from '@/components/common/PosterCard.vue'
import StateBlock from '@/components/ui/StateBlock.vue'
import BackToTop from '@/components/ui/BackToTop.vue'
import { useScrollSpy } from '@/composables/useScrollSpy'

/**
 * 发现页：四个推荐模块（口碑神作 / 热门佳作 / 值得一试 / 人气之作）
 * 只负责「怎么摆」：吸顶引导栏（当前模块 | 模块地铁图 | 换一批）+ 按模块分组的卡片网格。
 * 交互只上抛事件（select-module / refresh / open-anime / reload），不请求、不跳转、不改全局状态。
 */
const emit = defineEmits(['select-module', 'refresh', 'open-anime', 'reload'])

// ── 模块定义：顺序 = 地铁图站点顺序（同色系渐进，不是阵营色） ──────────────
const MODULES = [
  { id: 'praise', icon: IconTrophy, label: '口碑神作榜' },
  { id: 'hot', icon: IconFlame, label: '热门佳作榜' },
  { id: 'try', icon: IconSparkles, label: '值得一试榜' },
  { id: 'popular', icon: IconUsers, label: '人气之作' },
]

// 站点：每站带自身模块色（未到达时描边带色，到达后由填充色统一覆盖）
const MODULE_STOPS = MODULES.map((mod) => ({
  key: mod.id,
  label: mod.label,
  color: `var(--mod-${mod.id})`,
}))

// ── 地铁图：位置与填充全部由滚动位置算出（与首页共用同一 composable） ──────
const scrollHost = ref(null)
const { activeIndex, progress, scrollToIndex } = useScrollSpy({
  root: scrollHost,
  ids: () => MODULES.map((mod) => `mod-${mod.id}`),
  offset: 96, // 判定线：吸顶栏底部附近（与 .module-section 的 scroll-margin-top 对齐）
})

const activeModule = computed(() => MODULES[activeIndex.value] || MODULES[0])
const activeColor = computed(() => `var(--mod-${activeModule.value.id})`)

// 三态预览开关：接接口后删掉，改由请求状态驱动
// 'ready' | 'loading' | 'error' | 'empty'
const uiState = ref('ready')

// 换一批的旋转态：当前为预览用；接接口后由请求 Promise 的 pending 驱动
const refreshing = ref(null)
let refreshTimer = 0

function countOf(moduleId) {
  return (SAMPLE_MODULES[moduleId] || []).length
}

function itemsOf(moduleId) {
  return SAMPLE_MODULES[moduleId] || []
}

function onSelectModule(key) {
  const idx = MODULES.findIndex((mod) => mod.id === key)
  if (idx < 0) return
  activeIndex.value = idx // 立即反馈，避免平滑滚动期间的滞后感
  scrollToIndex(idx)
  emit('select-module', key)
}

function onRefresh() {
  if (refreshing.value) return
  refreshing.value = activeModule.value.id
  emit('refresh', activeModule.value.id)
  // 【预览用】接接口后删掉：改由请求结束关闭旋转
  refreshTimer = setTimeout(() => {
    refreshing.value = null
  }, 900)
}

onBeforeUnmount(() => clearTimeout(refreshTimer))

// ══════════════════════════════════════════════════════════════════════════
// 【占位示例数据 —— 仅用于 UI 审核，接接口时整段删除】
// 字段是「UI 需要什么就传什么」的示例：评分人数、年份题材都由后端成品字符串给出，
// 组件内不做格式化；bgmId 为占位数字，仅用于展示外链按钮的位置。
// ── 人气之作：故意留空，用于审核「模块空态」的呈现 ──────────────────────
// ══════════════════════════════════════════════════════════════════════════
const SAMPLE_MODULES = {
  praise: [
    { id: 'praise-1', title: '千夜物语', poster: '', score: 9.1, scoreText: '9.1', ratingText: '5.2万人评分', metaText: '2025 · 奇幻 史诗', bgmId: 300001 },
    { id: 'praise-2', title: '月下奏鸣曲', poster: '', score: 8.9, scoreText: '8.9', ratingText: '4.7万人评分', metaText: '2026 · 音乐 剧情', bgmId: 300002 },
    { id: 'praise-3', title: '夏日回声', poster: '', score: 8.5, scoreText: '8.5', ratingText: '2.9万人评分', metaText: '2026 · 青春 剧情', bgmId: 300003 },
    { id: 'praise-4', title: '薄暮食堂', poster: '', score: 8.4, scoreText: '8.4', ratingText: '2.2万人评分', metaText: '2025 · 治愈 日常', bgmId: 300004 },
    { id: 'praise-5', title: '剑与盾的黄昏', poster: '', score: 8.2, scoreText: '8.2', ratingText: '1.9万人评分', metaText: '2025 · 战斗 史诗', bgmId: 300005 },
    { id: 'praise-6', title: '星轨夜航', poster: '', score: 8.1, scoreText: '8.1', ratingText: '3.1万人评分', metaText: '2026 · 科幻 冒险', bgmId: 300006 },
  ],
  hot: [
    { id: 'hot-1', title: '逆风三步上篮', poster: '', score: 8.3, scoreText: '8.3', ratingText: '4.4万人评分', metaText: '2026 · 运动 热血', bgmId: 300011 },
    { id: 'hot-2', title: '银河便当屋', poster: '', score: 7.9, scoreText: '7.9', ratingText: '2.6万人评分', metaText: '2026 · 美食 科幻', bgmId: 300012 },
    { id: 'hot-3', title: '狼少女与猎人', poster: '', score: 7.8, scoreText: '7.8', ratingText: '1.7万人评分', metaText: '2026 · 奇幻 冒险', bgmId: 300013 },
    { id: 'hot-4', title: '咖啡与第七个夏天', poster: '', score: 7.7, scoreText: '7.7', ratingText: '1.5万人评分', metaText: '2026 · 日常 治愈', bgmId: 300014 },
    { id: 'hot-5', title: '深海的来信', poster: '', score: 7.5, scoreText: '7.5', ratingText: '1.2万人评分', metaText: '2026 · 奇幻 恋爱', bgmId: 300015 },
  ],
  try: [
    { id: 'try-1', title: '晴天的方程式', poster: '', score: 7.6, scoreText: '7.6', ratingText: '8900人评分', metaText: '2026 · 校园 日常', bgmId: 300021 },
    { id: 'try-2', title: '昨日重现', poster: '', score: 7.4, scoreText: '7.4', ratingText: '6300人评分', metaText: '2026 · 恋爱 科幻', bgmId: 300022 },
    { id: 'try-3', title: '猫与旧书店', poster: '', score: 7.3, scoreText: '7.3', ratingText: '5100人评分', metaText: '2026 · 日常', bgmId: 300023 },
    { id: 'try-4', title: '机械之心', poster: '', score: 7.1, scoreText: '7.1', ratingText: '4200人评分', metaText: '2026 · 科幻 战斗', bgmId: 300024 },
    { id: 'try-5', title: '银沙之城', poster: '', score: 7.0, scoreText: '7.0', ratingText: '3800人评分', metaText: '2025 · 奇幻', bgmId: 300025 },
  ],
  popular: [],
}

</script>

<style scoped>
/* ── 页面骨架：自身持有滚动容器，吸顶栏与回到顶部都锚定在它上面 ───────── */
.discover {
  display: flex;
  height: 100vh;
  overflow: hidden;
}
.discover-main {
  position: relative;
  flex: 1;
}

/* ── 吸顶引导栏（实色吸顶，允许被 BackToTop 覆盖） ───────────────────── */
.topbar {
  position: sticky;
  top: 0;
  z-index: 30;
  padding: 12px var(--page-pad-x);
}
.topbar-inner {
  display: flex;
  align-items: center;
  gap: 16px;
}
.topbar-metro {
  flex: 1;
  min-width: 240px;
}

/* ── 当前模块标识 ─────────────────────────────────────────────────────── */
.current {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
  min-width: 0;
}
.current-label {
  font-family: var(--font-ui);
  font-size: 1rem;
  font-weight: 600;
  color: var(--text-primary);
  white-space: nowrap;
  /* 固定宽度：模块名长短不同，避免切换时地铁图 / 按钮左右跳动 */
  min-width: 6.5em;
  text-align: center;
}
.current-count,
.module-count {
  padding: 2px 8px;
  border-radius: var(--radius-pill);
  background: var(--bg-input);
  color: var(--text-secondary);
  font-size: 0.72rem;
  white-space: nowrap;
}

/* 模块名切换过渡（左右不动，只做小幅纵向淡换） */
.module-label-enter-active {
  transition: opacity var(--dur) var(--ease-out), transform var(--dur) var(--ease-out);
}
.module-label-leave-active {
  transition: opacity var(--dur-fast) var(--ease-out), transform var(--dur-fast) var(--ease-out);
}
.module-label-enter-from {
  opacity: 0;
  transform: translateY(5px);
}
.module-label-leave-to {
  opacity: 0;
  transform: translateY(-5px);
}

/* ── 模块色图标片（吸顶栏小号 / 区块标题大号） ─────────────────────────── */
.icon-chip {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border-radius: 10px;
  flex-shrink: 0;
  background: var(--accent-mist);
  color: var(--text-secondary);
}
.icon-chip.sm {
  width: 30px;
  height: 30px;
  border-radius: 9px;
}
/* 底色 / 描边由模块色混合得出（不硬编码颜色，深浅主题自动适配） */
.icon-chip.tone-praise {
  color: var(--mod-praise-strong);
  background: color-mix(in srgb, var(--mod-praise) 16%, transparent);
  border: 1px solid color-mix(in srgb, var(--mod-praise) 30%, transparent);
}
.icon-chip.tone-hot {
  color: var(--mod-hot-strong);
  background: color-mix(in srgb, var(--mod-hot) 16%, transparent);
  border: 1px solid color-mix(in srgb, var(--mod-hot) 30%, transparent);
}
.icon-chip.tone-try {
  color: var(--mod-try-strong);
  background: color-mix(in srgb, var(--mod-try) 16%, transparent);
  border: 1px solid color-mix(in srgb, var(--mod-try) 30%, transparent);
}
.icon-chip.tone-popular {
  color: var(--mod-popular-strong);
  background: color-mix(in srgb, var(--mod-popular) 16%, transparent);
  border: 1px solid color-mix(in srgb, var(--mod-popular) 30%, transparent);
}

/* ── 换一批 ───────────────────────────────────────────────────────────── */
.shuffle-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
  padding: 7px 15px;
  border: 1px solid var(--border);
  border-radius: var(--radius-pill);
  color: var(--text-secondary);
  font-size: 0.78rem;
  font-weight: 500;
  transition: color var(--dur) var(--ease-out), background var(--dur) var(--ease-out),
    border-color var(--dur) var(--ease-out), box-shadow var(--dur) var(--ease-out);
}
.shuffle-btn:hover:not(:disabled) {
  color: var(--text-invert);
  background: var(--accent);
  border-color: var(--accent);
  box-shadow: var(--shadow-accent);
}
.shuffle-btn:disabled {
  opacity: 0.55;
  cursor: wait;
}

/* ── 模块区块 ─────────────────────────────────────────────────────────── */
.modules {
  display: flex;
  flex-direction: column;
  gap: 34px;
  padding: 10px var(--page-pad-x) 72px;
}

.module-section {
  display: flex;
  flex-direction: column;
  gap: 12px;
  /* 供 scrollToIndex 定位时避让吸顶栏（值需与 useScrollSpy 的 offset 对齐） */
  scroll-margin-top: 96px;
}

.module-header {
  display: flex;
  align-items: center;
  gap: 10px;
}
/* 标题右侧延伸细线，弱化分割、拉开节奏（与首页日标题一致） */
.module-header::after {
  content: '';
  flex: 1;
  height: 1px;
  margin-left: 4px;
  background: var(--border);
}
.module-title {
  font-family: var(--font-ui);
  font-size: 1.05rem;
  font-weight: 700;
  color: var(--text-primary);
}

.module-empty {
  padding: 34px 0;
  color: var(--text-tertiary);
  font-size: 0.85rem;
  text-align: center;
}

/* ── 窄屏：地铁图换到第二行，避免与模块标识 / 换一批抢宽度 ─────────────── */
@media (max-width: 1080px) {
  .topbar-inner {
    flex-wrap: wrap;
  }
  .topbar-metro {
    order: 3;
    flex-basis: 100%;
    min-width: 0;
  }
}
@media (max-width: 900px) {
  .anime-grid {
    --grid-min: 150px;
  }
}
@media (max-width: 720px) {
  .topbar {
    padding: 10px 16px;
  }
  .topbar-metro {
    min-width: 0;
  }
  .modules {
    padding: 8px 16px 64px;
  }
  .anime-grid {
    --grid-min: 132px;
    --grid-gap: 12px;
  }
  .current-label {
    min-width: 5.5em;
    font-size: 0.95rem;
  }
}


</style>
