<template>
  <div class="app-layout">
    <!-- 侧边栏（固定，不随主区滚动） -->
    <AppSideNav :active="activeNav" @navigate="activeNav = $event" />

    <!-- 主区：不滚动，滚动交给各页面自己的 .scroll-area（便于 sticky 吸顶） -->
    <main class="main-content">
      <!-- TODO: 接入 vue-router 后替换为：
           <router-view v-slot="{ Component }">
             <Transition name="page" mode="out-in"><component :is="Component" /></Transition>
           </router-view>
           当前先按「侧栏 key → 页面组件」直连，用于逐页 UI 审核 -->
      <Transition name="page" mode="out-in">
        <component :is="page.component" v-if="page" :key="activeNav" v-bind="pageProps" />
        <div v-else key="pending" class="pending-page">
          <StateBlock state="empty" text="该页面正在重写中（下一批交付）" />
        </div>
      </Transition>
    </main>

    <!-- 详情面板：全站共用一个（首页 / 发现 / 搜索点海报都走这里），
         展开时把主区挤窄而不是盖住它 -->
    <AnimeDetailPanel
      :visible="panelVisible"
      :data="animeDetail"
      :ui-state="panelState"
      :error-text="animeError?.message || ''"
      @close="closeAnime"
      @retry="retryAnime"
      @open="openAnime"
    />
  </div>
</template>

<script setup>
/**
 * 应用容器 —— 全站的「数据持有者」
 * ---------------------------------------------------------------------------
 * 分工（见 README 里的架构约定）：
 *   · 页面组件只负责「怎么摆」：收 props、上抛事件，不请求、不改全局状态
 *   · 容器负责「要什么数据、怎么取、事件怎么接」：这里调 composable，把结果当 props 传下去
 * 首页的排期数据（useSchedule）与详情面板（useAnimeDetail）都装在这里 ——
 * 所以切页面、开面板都不会重新请求，也就是「全站一个面板」的落点。
 */
import { computed, onMounted, ref, watch } from 'vue'
import AppSideNav from '@/components/layout/AppSideNav.vue'
import AnimeDetailPanel from '@/components/detail/AnimeDetailPanel.vue'
import HomePage from '@/pages/HomePage.vue'
import DiscoverPage from '@/pages/DiscoverPage.vue'
import SettingsPage from '@/pages/SettingsPage.vue'
import StateBlock from '@/components/ui/StateBlock.vue'
import { useSchedule } from '@/composables/useSchedule'
import { useAnimeDetail } from '@/composables/useAnimeDetail'
import { currentSeason } from '@/utils/season'

// 导航选中项：当前由本地状态驱动（纯 UI），接 vue-router 后改由路由驱动
const activeNav = ref('home')

// 【临时】页面直连预览：接 vue-router 前，用「侧栏 key → 页面组件」的映射切换页面。
// 未重写的页面先给占位提示，避免点过去白屏；接路由时整段删除。
const PAGES = {
  home: { component: HomePage },
  discover: { component: DiscoverPage },
  settings: { component: SettingsPage },
}

const page = computed(() => PAGES[activeNav.value] || null)

// ── 首页排期数据（库里优先，后端负责抓取与落库） ──────────────────────────
const schedule = useSchedule()

// ── 详情面板（全站共用一份状态）──────────────────────────────────────────
// 解构出来是为了模板里能直接写 panelVisible / animeDetail（顶层 ref 自动解包）
const {
  animeId: activeAnimeId,
  data: animeDetail,
  visible: panelVisible,
  uiState: panelState,
  error: animeError,
  open: openAnime,
  close: closeAnime,
  retry: retryAnime,
} = useAnimeDetail()

/**
 * 切页时把面板收起来
 * ---------------------------------------------------------------------------
 * 面板是「首页排期卡片」的延伸：跳到发现页/设置页还挂着上一部作品的档案，
 * 既没有来源（那页的卡片点不亮它）又白占右侧空间 —— 换页就收。
 * 与「关掉不清数据」不冲突：数据留着，切回首页再点开是立刻摆回，不会重新请求。
 */
watch(activeNav, () => closeAnime())

// 数据还没到时，季选先显示：① 上次选过的季（localStorage）② 本机算的当前季
// —— 服务端返回后会以它算的当前季为准
const fallbackSeason = computed(() => {
  const { year, season } = schedule.storedSeason ?? currentSeason()
  return { year, season, label: `${year} ${season}` }
})

/** 按当前页面组装 props（Vue 的 onXxx 约定可以这样传事件处理器） */
const pageProps = computed(() => {
  if (activeNav.value === 'home') {
    return {
      days: schedule.data.value?.days ?? [],
      years: schedule.data.value?.years ?? [],
      season: schedule.data.value?.season ?? fallbackSeason.value,
      /** 刚点下去、还没回来的那一季（标签要立刻跟着变，否则看着像"点了没反应"） */
      pendingSeasonLabel: schedule.pending.value?.label ?? '',
      uiState: schedule.uiState.value,
      // 详情面板：卡片把整条 item 抛上来，容器只取主键（面板自己去要详情）
      activeAnimeId: activeAnimeId.value,
      onSelectSeason: (year, season) => schedule.selectSeason(year, season),
      onReload: () => schedule.reload(),
      onOpenAnime: (item) => openAnime(item.id),
      // TODO(搜索页)：落地后在这里接上跳转（不在前端打 console）
    }
  }
  return {}
})

onMounted(() => schedule.load())
</script>

<style scoped>
.app-layout {
  display: flex;
  height: 100vh;
  overflow: hidden;
}

.main-content {
  flex: 1;
  min-width: 0;
  height: 100vh;
  overflow: hidden;
}

/* 未重写页面的占位（仅过渡期使用） */
.pending-page {
  display: grid;
  place-items: center;
  height: 100%;
}
</style>

