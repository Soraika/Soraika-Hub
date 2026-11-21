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
      :source="panelSource"
      :download-ready="qbReady"
      @close="closeAnime"
      @retry="retryAnime"
      @open="onOpenAnime"
      @downloaded="onDownloaded"
      @go-season="onGoSeason"
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
import SearchPage from '@/pages/SearchPage.vue'
import DownloadsPage from '@/pages/DownloadsPage.vue'
import SettingsPage from '@/pages/SettingsPage.vue'
import StateBlock from '@/components/ui/StateBlock.vue'
import { useSchedule } from '@/composables/useSchedule'
import { useSearch } from '@/composables/useSearch'
import { useAnimeDetail } from '@/composables/useAnimeDetail'
import { useDownloads } from '@/composables/useDownloads'
import { fetchQbStatus } from '@/api/downloads'
import { currentSeason } from '@/utils/season'

// 导航选中项：当前由本地状态驱动（纯 UI），接 vue-router 后改由路由驱动
const activeNav = ref('home')

// 【临时】页面直连预览：接 vue-router 前，用「侧栏 key → 页面组件」的映射切换页面。
// 未重写的页面先给占位提示，避免点过去白屏；接路由时整段删除。
const PAGES = {
  home: { component: HomePage },
  discover: { component: DiscoverPage },
  search: { component: SearchPage },
  downloads: { component: DownloadsPage },
  settings: { component: SettingsPage },
}

const page = computed(() => PAGES[activeNav.value] || null)

// ── 搜索页数据（词 → 卡片；防抖与乱序保护都在 useSearch 里）──────────────
// 放在容器而不是页面里：首页顶栏搜完跳过来时，词和结果都已经在，页面一挂载就是"已有结果"
const search = useSearch()

// ── 首页排期数据（库里优先，后端负责抓取与落库） ──────────────────────────
const schedule = useSchedule()

// ── 下载页数据（qB 里有什么：卡片墙 + 逐部明细） ──────────────────────────
// 放在上面的 watch 之前：那个 watch 的首次触发在挂载后，但提前声明读起来更顺
const downloads = useDownloads()

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
 *
 * 顺手做一件事：进下载页才拉下载数据（不在启动时就打一次 qB）。
 */
watch(activeNav, (nav) => {
  closeAnime()
  // 设置页刚改完 qB 地址就切回来：这里补查一次，否则按钮还是旧的「没连上」
  refreshQbReady()
  // 只有待在下载页才轮询（切走立刻停，别让后台一直打 qB）
  if (nav === 'downloads') {
    if (!downloads.data.value) downloads.load()
    downloads.startAutoRefresh()
  } else {
    downloads.stopAutoRefresh()
  }
})

/**
 * qB 通道是否可用 —— 决定面板里的「下载」按钮能不能点。
 * ---------------------------------------------------------------------------
 * 只在挂载时查一次是不够的：设置页刚填好地址，回到首页点海报，SPA 并不会重新加载，
 * qbReady 还停在 false，按钮就一直灰着写「还没连上 qBittorrent」——可它明明连得上。
 * 所以在这三个时机重新确认（都只花十几毫秒，比一直显示错的状态便宜）：
 *   ① 挂载 ② 每次切页 ③ 每次打开详情面板（就是按「下载」前那一刻）
 * 接口自己挂了（后端没起 / 网络断）时**保持上一次的判断**，不要把「连不上后端」
 * 误报成「没配 qB」——那是完全不同的事。
 */
const qbReady = ref(false)

async function refreshQbReady() {
  try {
    const status = await fetchQbStatus()
    // 配了但连不上（后端 200 + connected:false）同样算「不可以点」，但要记住原因
    qbReady.value = Boolean(status?.configured && status?.connected !== false)
  } catch {
    /* 保持上一次的判断 */
  }
}

onMounted(refreshQbReady)

/**
 * 首页渐进填充：排期数据一到就开始补评分/评论数（分批，慢慢填）
 * ---------------------------------------------------------------------------
 * 为什么放在容器里而不是 HomePage：填充会改 `schedule.data`，页面只读 props。
 * 切季时用 `signal.cancelled` 中止上一轮的后续批次，免得旧季的响应糊到新季上。
 */
/** 每轮填充一个票号：票号变了说明已经切季，上一轮就地停手（不用 AbortController，够用） */
let fillToken = 0
watch(
  () => schedule.data.value?.season?.label,
  async (label) => {
    if (!label) return
    const token = ++fillToken
    await schedule.fillMissing({
      signal: {
        get cancelled() {
          return token !== fillToken
        },
      },
    })
  },
)

/** 打开面板 = 马上要用「下载」按钮，这时确认一次最有用 */
function onOpenAnime(payload) {
  refreshQbReady()
  openAnime(payload)
}

/**
 * 面板「资源」区的来源：`mikan` = 未下载的资源列表，`downloads` = 已经下载的文件
 * 由「从哪个页面点的海报」决定 —— 同一个面板、同一部作品，两种页面看到的东西不同。
 */
const panelSource = ref('mikan')

/**
 * 刚加过种子 → 下载页的数据已经过期了
 * ---------------------------------------------------------------------------
 * 加种走的是面板（任意页面都能点），下载页的数据却在容器里缓存着。
 * 不刷新的话：点完「下载」切到下载页，会看不到刚加的那条（or 还显示旧的进度），
 * 那是「说好加了却看不见」的典型错觉。这里直接重取一次（跳过后端 4 秒缓存）。
 */
function onDownloaded(payload) {
  if (!payload?.added?.length) return
  downloads.load({ fresh: true })
}

/**
 * 系列弹层里点「2026 秋」→ 收起面板、回首页、请求那一季
 * ---------------------------------------------------------------------------
 * 顺序是先关面板再切页：面板是首页卡片的延伸，跳季就该看排期而不是还挂着上一部作品；
 * 请求交给 useSchedule（它自己会记住这次选择，刷新后回到同一季）。
 */
function onGoSeason({ year, season } = {}) {
  if (!year || !season) return
  closeAnime()
  activeNav.value = 'home'
  schedule.selectSeason(year, season)
}

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
      // 首页点海报 → 面板读没下载的资源（Mikan 现取）
      onOpenAnime: (item) => {
        panelSource.value = 'mikan'
        onOpenAnime(item.id)
      },
      // 顶栏搜索：跳到搜索页并把词带过去（页面一挂载就是结果，不用再敲一次）
      onSearch: (value) => {
        activeNav.value = 'search'
        search.apply(value)
      },
    }
  }

  if (activeNav.value === 'search') {
    return {
      keyword: search.keyword.value,
      items: search.items.value,
      uiState: search.uiState.value,
      errorText: search.error.value?.message || '',
      activeAnimeId: activeAnimeId.value,
      onInput: (value) => search.onInput(value),
      // 回车 / 点按钮：立刻搜（不等防抖）
      onSubmit: (value) => search.submit(value),
      onRetry: () => search.retry(),
      // AI 开关：切换后如果已经有词，立刻用新模式重搜一次（否则要再按一次回车）
      aiMode: search.aiMode.value,
      intent: search.intent.value,
      aiNote: search.aiNote.value,
      onToggleAi: (value) => {
        search.setAiMode(value)
        if (search.keyword.value.trim()) search.submit()
      },
      // 结果点海报：和首页一致，读没下载的资源
      onOpenAnime: (item) => {
        panelSource.value = 'mikan'
        onOpenAnime(item.id)
      },
    }
  }

  if (activeNav.value === 'downloads') {
    return {
      data: downloads.data.value,
      uiState: downloads.uiState.value,
      refreshing: downloads.refreshing.value,
      polling: downloads.polling.value,
      activeAnimeId: activeAnimeId.value,
      // 下载页点海报 → 面板读已经下载的文件（同一个面板，换数据源）
      onOpenAnime: (item) => {
        panelSource.value = 'downloads'
        onOpenAnime(item.id)
      },
      // 刷新要跳过后端 4 秒缓存（用户点它就是要看最新状态）
      onReload: () => downloads.load({ fresh: true }),
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

/* ── 移动端：主区让出底部 tab 栏 ──────────────────────────────────────── */
@media (max-width: 820px) {
  .app-layout {
    flex-direction: column;
  }
  .main-content {
    /* 底部条是 fixed 的，这里靠 padding 让出位置（不用减高度，滚动容器的 100vh 更稳） */
    height: calc(100vh - var(--bottom-nav-h) - env(safe-area-inset-bottom, 0px));
    padding-bottom: 0;
  }
}
</style>

