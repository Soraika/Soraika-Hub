<template>
  <aside class="panel" :class="{ open: visible }" aria-label="作品详情">
    <div class="panel-inner scroll-area">
      <button class="close-btn" type="button" title="关闭（Esc）" @click="$emit('close')">
        <IconX :size="18" />
      </button>

      <!-- ── 三态：loading 用**骨架屏**（结构占位），error 用状态块 ─────────────
           点新海报时 `useAnimeDetail` 会立刻清空 data、置 loading —— 这时
           **不整块转圈、也不残留上一部的内容**，而是就地铺骨架：
           动的只有「海报 / 标题 / 标签 / 简介 / 资源」这些位置，版面不跳。
           详情也不做整块淡入淡出 —— 要的是"局部在动"，不是整块进场。 -->
      <DetailSkeleton v-if="uiState === 'loading'" />

      <div v-else class="detail-stage">
        <!-- 交接：骨架先留在上层、淡出 180ms；下面的内容同时淡入 -->
        <div v-if="skeletonLeaving" class="skeleton-layer" aria-hidden="true">
          <DetailSkeleton />
        </div>

      <StateBlock
        v-if="uiState === 'error'"
        state="error"
        :text="errorText || '读取失败，请稍后重试'"
        retry-text="重试"
        @retry="$emit('retry')"
      />

      <!-- ── 详情：key 带上作品主键（换一部就重新挂载，组件内的局部状态跟着归零） -->
      <div v-else-if="data" :key="'detail-' + data.id" class="detail">
          <header ref="headerEl" class="detail-header">
            <PosterImage
              class="detail-poster"
              :src="data.poster"
              :alt="data.title"
              ratio="3 / 4"
              :placeholder-text="data.weekdayText"
            />
            <div class="detail-head-text">
              <h2 class="detail-title">{{ data.title }}</h2>
              <p v-if="data.titleOriginal" class="detail-title-alt">{{ data.titleOriginal }}</p>
              <div class="detail-chips">
                <!-- 系列放**最前**：它是导航（点它换作品），比星期/集数更该挨着标题。
                     弹层不挂在这颗 chip 上（原因见 header 里 PopoverPanel 上的注释）。 -->
                <span v-if="series && series.items.length > 1" class="chip-series">
                  <button
                    class="chip chip-series-btn"
                    type="button"
                    data-popover-anchor
                    :aria-expanded="seriesOpen"
                    :title="seriesTooltip"
                    @click="seriesOpen = !seriesOpen"
                  >
                    {{ seriesChipText }}
                    <IconChevronDown class="chip-caret" :size="11" :class="{ open: seriesOpen }" />
                  </button>
                </span>

                <span v-if="data.weekdayText" class="chip chip-week">{{ data.weekdayText }}</span>
                <span v-if="data.epsText" class="chip">{{ data.epsText }}</span>
              </div>
            </div>

            <!-- 系列弹层：挂在 **header** 上（不是那颗 chip 上）。
                 面板只有 340px 宽、内层又是 `overflow-x: hidden` 的滚动区（styles/base.css
                 的 .scroll-area）——弹层挂在 chip 上时会从 chip 左沿往右顶出面板，右侧被裁掉
                 （用户反馈的"被挡住"）。挂 header 后用 left/right 撑满面板内容宽度：
                 chip 换不换行、在第一行还是第二行都不会被切。 -->
            <PopoverPanel
              v-if="series && series.items.length > 1"
              class="series-popover"
              :open="seriesOpen"
              :anchor="headerEl"
              width="anchor"
              label="同系列作品"
              @close="seriesOpen = false"
            >
              <p class="series-head">{{ series.rootTitle || '同系列' }} · {{ series.items.length }} 部</p>
              <!-- 一行两个动作：点名字换作品；点右侧季度回首页看那一季的排期 -->
              <div
                v-for="item in series.items"
                :key="item.animeId"
                class="series-item"
                :class="{ on: item.current }"
              >
                <button
                  class="series-main"
                  type="button"
                  :disabled="item.current"
                  @click="pickSeries(item)"
                >
                  <span class="series-tag">{{ seriesTagOf(item) }}</span>
                  <span class="series-name">{{ item.title }}</span>
                </button>
                <button
                  v-if="item.seasonText"
                  class="series-season"
                  type="button"
                  :title="`前往 ${item.seasonText} 的排期`"
                  @click="goSeason(item)"
                >
                  {{ item.seasonText }}
                </button>
              </div>
            </PopoverPanel>
          </header>

          <section class="card">
            <div class="score-row">
              <span class="score-value" :class="{ weak: !scoreStrong }">
                <IconStarFilled :size="15" />{{ data.scoreText || data.score || '—' }}
              </span>
              <span v-if="data.ratingText" class="score-muted">{{ data.ratingText }}</span>
              <span v-if="data.watchingText" class="score-muted score-watching">
                {{ data.watchingText }}
              </span>
            </div>

            <dl class="info-rows">
              <div v-if="data.seasonText" class="info-row">
                <dt>放送</dt>
                <dd>{{ data.seasonText }}</dd>
              </div>
              <div v-if="data.airDate" class="info-row">
                <dt>首播</dt>
                <dd>{{ data.airDate }}</dd>
              </div>
            </dl>

            <div v-if="data.tags.length" class="tag-row">
              <span v-for="tag in data.tags" :key="tag" class="tag-chip">{{ tag }}</span>
            </div>
          </section>

          <section v-if="data.summary" class="card">
            <h3 class="block-title">简介</h3>
            <p class="summary" :class="{ expanded }">{{ data.summary }}</p>
            <button v-if="summaryLong" class="summary-toggle" type="button" @click="expanded = !expanded">
              {{ expanded ? '收起' : '展开全部' }}
            </button>
          </section>

          <section v-if="data.bgmUrl || data.mikanUrl" class="card">
            <div class="link-row">
              <a v-if="data.bgmUrl" class="link-btn" :href="data.bgmUrl" target="_blank" rel="noopener noreferrer">
                <IconExternalLink :size="14" /> Bangumi 条目
              </a>
              <a v-if="data.mikanUrl" class="link-btn" :href="data.mikanUrl" target="_blank" rel="noopener noreferrer">
                <IconExternalLink :size="14" /> Mikan 页面
              </a>
            </div>
          </section>

          <!-- ── 资源区：字幕组（一级）→ AI 标签位 → 资源列表（二级） ──────
               层级顺序与旧版一致：AI 解析的结果是「当前字幕组资源」的标签，
               所以它必须夹在两级中间，不能挪到字幕组上面去。
               三块各用一个卡片包住（与上面的评分卡/简介同款），
               这样所有内容的左右边界都由「卡片内边距」统一决定，不会参差。 -->
          <section v-if="showSubgroupBar" class="card">
            <SubgroupBar
              :subgroups="subgroups"
              :active-id="activeSubgroupId"
              :state="subgroupState"
              @select="selectSubgroup"
              @retry="retryReleases"
            />
          </section>

          <!-- AI 标签位：只有当前字幕组**真的取到资源**时才出现。
               0 条资源时既没东西可筛、也没有可解析的名字 —— 摆一排标签（外加「共 0 条资源」）
               只会让人以为坏了。下载页模式不解析标签（文件已经在盘上了）。 -->
          <section v-if="releaseItems.length && !isDownloads" class="card">
            <AiSlot
              :state="aiState"
              :tags="aiTags"
              :info="releaseInfo"
              :active-names="aiActiveNames"
              :batch-filter="aiBatchFilter"
              :has-batch="hasBatchReleases"
              :model="aiModel"
              :message="aiError?.message || ''"
              @toggle="toggleAiTag"
              @clear="clearAiTags"
              @retry="retryAi"
              @set-batch="setAiBatchFilter"
            />
          </section>

          <section class="card">
            <ReleaseList
              v-if="!isDownloads"
              :items="releaseItems"
              :episodes="aiEpisodes"
              :state="releaseState"
              :error-text="releasesError?.message || ''"
              :active-tags="aiActiveTags"
              :batch-filter="aiBatchFilter"
              :download-ready="downloadReady"
              :downloading="downloading"
              :downloaded-hashes="downloadedHashes"
              @retry="retryReleases"
              @clear-filter="clearAiTags"
              @more="ensureParsed"
              @download="onDownload"
            />
            <!-- 下载页模式：同一个位置换成「已下载的文件」，按字幕组分组 -->
            <DownloadList
              v-else
              :items="releaseItems"
              :state="releaseState"
              :size-text="downloadSizeText"
              :renaming="renaming"
              :rename-message="renameMsg"
              :draft="renameDraft"
              :rename-busy="renameBusy"
              :rename-error="renameError"
              @retry="retryReleases"
              @rename="onRename"
              @rename-open="onRenameOpen"
              @rename-cancel="onRenameCancel"
              @rename-apply="onRenameApply"
            />
          </section>

          <!-- 加种结果：成功几条、失败几条 + 落到哪个目录（用户最关心的两件事） -->
          <section v-if="downloadMsg" class="card">
            <p class="dl-msg" :class="{ bad: downloadFailed }">{{ downloadMsg }}</p>
          </section>
        </div>
      </div>
    </div>
  </aside>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { IconChevronDown, IconExternalLink, IconStarFilled, IconX } from '@tabler/icons-vue'
import PosterImage from '@/components/common/PosterImage.vue'
import StateBlock from '@/components/ui/StateBlock.vue'
import DetailSkeleton from './DetailSkeleton.vue'
import SubgroupBar from './SubgroupBar.vue'
import ReleaseList from './ReleaseList.vue'
import DownloadList from './DownloadList.vue'
import AiSlot from './AiSlot.vue'
import PopoverPanel from '@/components/ui/PopoverPanel.vue'
import { useReleases } from '@/composables/useReleases'
import { useDownloadActions } from '@/composables/useDownloadActions'
import { useDownloadedReleases } from '@/composables/useDownloadedReleases'
import { useAiTags } from '@/composables/useAiTags'
import { useEpisodes } from '@/composables/useEpisodes'
import { useSeries } from '@/composables/useSeries'
import { episodeOf, isBatchEpisode, releaseHighlights } from '@/utils/episode'

/**
 * 作品详情面板（右侧滑出）
 * ---------------------------------------------------------------------------
 * 纯展示：数据、三态、重试全由容器给（useAnimeDetail），这里只负责「怎么摆」。
 *
 * 展开方式照旧版设计：面板本身是 flex 里的一条**可伸缩槽位**（width 0 → 340px），
 * 展开时把主区挤窄而不是盖住它 —— 这样依旧能一边看排期一边看档案；
 * 内部内容固定宽度放在 .panel-inner 里，所以宽度动画期间文字不会跟着回流。
 */
const props = defineProps({
  /** 是否展开（容器算好） */
  visible: { type: Boolean, default: false },
  /** 后端详情 DTO；null = 还没有内容 */
  data: { type: Object, default: null },
  /** loading | error | ready | empty（容器算好） */
  uiState: { type: String, default: 'loading' },
  /** 失败时的具体文案（ApiError.message） */
  errorText: { type: String, default: '' },
  /**
   * 「资源」区读哪个数据源：
   *   · `mikan`     → Mikan 的资源列表（首页 / 发现 / 搜索点开的都是这个）
   *   · `downloads` → qB 里**已经下载**的文件（下载页点开的作品）
   * 详情部分（海报 / 评分 / 简介 / 系列）两边完全一样 —— 只有最下面那一块换来源。
   */
  source: { type: String, default: 'mikan' },
  /** qB 通道是否可用（容器查一次 `/api/qb/status` 后传下来；false 时下载按钮只给说明） */
  downloadReady: { type: Boolean, default: false },
})
const emit = defineEmits(['close', 'retry', 'open', 'downloaded', 'go-season'])

const isDownloads = computed(() => props.source === 'downloads')

/**
 * 资源区（字幕组 → 资源列表）由面板自己取数
 * ---------------------------------------------------------------------------
 * 这份状态只属于「面板里这一部作品」，关掉面板就没意义 —— 所以不进 App.vue 的全局状态，
 * 也不用 props 传进来（那会逼着容器处理「什么时候清、什么时候重取」的一堆边界）。
 * 容器约定（页面只摆、容器取数）针对的是**页面**；面板这种高内聚交互单元，
 * 取数收在 composable 里，组件本身仍然只负责摆。
 *
 * 两种数据源各一个 composable，**接口名保持一致**（subgroups / activeId / releases / state），
 * 所以模板不用写两套：
 *   · useReleases            —— Mikan 资源（两级各有自己的 loading / 缓存）
 *   · useDownloadedReleases  —— 已下载文件（一次请求全拿到，切组是内存操作）
 * 具体取哪个由 `source` 决定，下面这组 computed 就是对外的统一门面。
 */
const mikan = useReleases()
const downloaded = useDownloadedReleases()

const subgroups = computed(() => (isDownloads.value ? downloaded.subgroups.value : mikan.subgroups.value))
const subgroupState = computed(() => (isDownloads.value ? downloaded.subgroupState.value : mikan.subgroupState.value))
const activeSubgroupId = computed(() => (isDownloads.value ? downloaded.activeId.value : mikan.activeId.value))
const releaseItems = computed(() => (isDownloads.value ? downloaded.releases.value : mikan.releases.value))
const releaseState = computed(() => (isDownloads.value ? downloaded.releaseState.value : mikan.releaseState.value))
const releasesError = computed(() => (isDownloads.value ? downloaded.error.value : mikan.releasesError.value))
/** 当前组的手写体积（下载页模式才有值） */
const downloadSizeText = computed(() => downloaded.sizeText.value)

/**
 * 顶部那排 chip 要不要出现
 * · Mikan 模式：它是**第一级数据源**（选组才取资源），必须有
 * · 下载页模式：它只是**筛选**。只有一个组时（「全部」+ 1）筛了等于没筛，
 *   藏起来更干净 —— 组名已经在每行右侧标着了
 */
const showSubgroupBar = computed(() => {
  if (!isDownloads.value) return true
  return subgroups.value.length > 2
})

function selectSubgroup(id) {
  return isDownloads.value ? downloaded.select(id) : mikan.select(id)
}
function retryReleases() {
  return isDownloads.value ? downloaded.retry() : mikan.retry()
}

/**
 * 集数 / 季解析（**AI 逐条**）
 * 资源到手就丢给 AI 解析每条资源的集号；没配 AI 时静默退回前端规则兜底。
 */
const { episodes: aiEpisodes, load: loadEpisodes } = useEpisodes()

/**
 * 同系列的作品（标题旁那个「系列」chip）
 * 数据来自后端 `GET /api/anime/:id/series` —— 只列**库里有的**成员（不在库的点不进去）。
 * 没算过系列时后端返回 null → 这里 series 为 null → 模板不渲染 chip。
 */
const { data: series, load: loadSeries, reset: resetSeries } = useSeries()
const seriesOpen = ref(false)
const seriesChipText = computed(() => {
  const s = series.value
  if (!s) return ''
  // 正传显示季位（S02）；番外自己没有季位 → 退回「N 部」
  return s.currentIndex ? `系列 S${String(s.currentIndex).padStart(2, '0')}` : `系列 ${s.items.length} 部`
})
const seriesTooltip = computed(() => {
  const s = series.value
  return s ? `${s.rootTitle || '同系列'} · 库里共 ${s.items.length} 部` : ''
})
/** 番外没有季位 → 用归类当角标（OVA / 剧场版 / 总集篇…） */
const seriesTagOf = (item) => (item.index ? `S${String(item.index).padStart(2, '0')}` : item.relation || '番外')
/** 点系列里的某一部：换面板显示的作品（复用容器的 openAnime） */
function pickSeries(item) {
  seriesOpen.value = false
  if (!item.current) emit('open', item.animeId)
}

/**
 * 点系列里的季度胶囊：回首页看那一季的排期
 * 只上抛（页面不碰导航/请求）；容器负责收起面板、切页面、请求那一季。
 */
function goSeason(item) {
  seriesOpen.value = false
  if (item?.year && item?.season) emit('go-season', { year: item.year, season: item.season })
}

/**
 * 这批资源的整体特征（简报）—— 规则算的基础项 + 只在"有差别"时才列的分类维度
 * ---------------------------------------------------------------------------
 * 分类维度（分辨率/字幕）取自 AI 标签：**多于 1 种才列**，因为只有一种就是
 * "整批格式一致"（那正是没有可筛维度的情况，列出来是废话）。
 * 也刻意不写 ×N 计数 —— 这是简报，不是报表。
 */
const releaseInfo = computed(() => {
  const out = releaseHighlights(releaseItems.value, aiEpisodes.value)
  const namesOf = (type) => aiTags.value.filter((tag) => tag.type === type).map((tag) => tag.name)
  for (const type of ['res', 'sub']) {
    const names = namesOf(type)
    if (names.length > 1) out.push(names.join(' · '))
  }
  return out
})

/**
 * 这批资源里有没有合集？——决定「单集 / 合集」切换要不要出现。
 * 没有合集却摆着「合集」按钮，点下去必然是空的，那是假控件（旧版就是这个条件）。
 * 判断用文件名规则（utils/episode.js），不额外花一次 AI 调用。
 */
/** 系列弹层的锚点（弹层 Teleport 到 body 了，得显式告诉它"贴着谁"） */
const headerEl = ref(null)

/**
 * 骨架 → 内容 的交接（真正的交叉淡入）
 * ---------------------------------------------------------------------------
 * 用户的反馈很准：只做「最小 loading 时长」只是**延迟**了硬切，数据一到还是"啪"地换掉。
 * 所以在 loading 结束后，把骨架**留在上层再淡出 180ms**，下面的内容同时淡入 ——
 * 两层重叠一小会儿，视觉上是从占位块"化开"成内容，而不是"骨架消失、内容出现"。
 * 180ms 与 `.detail` 的 detail-in 对齐；再长会显得拖沓（本地接口本来就快）。
 */
const skeletonLeaving = ref(false)
let skeletonTimer = 0
watch(
  () => props.uiState,
  (next, prev) => {
    if (next === 'loading') {
      skeletonLeaving.value = false
      clearTimeout(skeletonTimer)
      return
    }
    if (prev !== 'loading') return
    skeletonLeaving.value = true
    clearTimeout(skeletonTimer)
    skeletonTimer = setTimeout(() => {
      skeletonLeaving.value = false
    }, 180)
  },
)
onBeforeUnmount(() => clearTimeout(skeletonTimer))

const hasBatchReleases = computed(() => releaseItems.value.some((item) => isBatchEpisode(episodeOf(item.title))))

/**
 * AI 标签（面板「AI 位」的数据）
 * 它依赖资源列表：解析对象就是**当前字幕组的资源文件名**，所以资源一到就解析，
 * 换字幕组就重新解析（结果按字幕组在 composable 里缓存，来回点不重复花钱）。
 */
const {
  state: aiState,
  tags: aiTags,
  activeTags: aiActiveTags,
  activeNames: aiActiveNames,
  batchFilter: aiBatchFilter,
  setBatchFilter: setAiBatchFilter,
  model: aiModel,
  error: aiError,
  load: loadAiTags,
  retry: retryAiTags,
  toggle: toggleAiTag,
  clear: clearAiTags,
} = useAiTags()

/** AI 位上的「重试」：只重解析**已经解锁的那部分**（后面还没看到的批次不用现在就花钱） */
function retryAi() {
  if (activeSubgroupId.value == null) return undefined
  return retryAiTags(
    activeSubgroupId.value,
    releaseItems.value.slice(0, Math.max(parsedCount.value, AI_BATCH)).map((item) => item.title),
    props.data?.title || '',
    { merge: false },
  )
}

/** 简介折叠：只在超长时给按钮（阈值与旧版一致） */
const SUMMARY_LIMIT = 120
const expanded = ref(false)
const summaryLong = computed(() => (props.data?.summary?.length ?? 0) > SUMMARY_LIMIT)

/**
 * 所有「会写 qB」的动作（加种 / 批量改名 / 单条改名）都在这个 composable 里。
 * 面板只负责摆界面 —— 这一段原来是 200 多行的状态机，挤在一个 1100 行的组件里没人愿意读。
 * 依赖全部用 thunk 传进去（`() => ...`），所以调用时才取值，不受声明顺序影响。
 */
const {
  downloading,
  downloadMsg,
  downloadFailed,
  onDownload,
  downloadedHashes,
  loadDownloadedHashes,
  renaming,
  renameMsg,
  onRename,
  renameDraft,
  renameBusy,
  renameError,
  onRenameOpen,
  onRenameCancel,
  onRenameApply,
  resetMessages,
} = useDownloadActions({
  animeId: () => props.data?.id || null,
  subgroupName: () => mikan.activeSubgroup.value?.name || '',
  /** 季号：系列算过就用季位（S02 → 2），没算过就当第一季（目录落 `Season 01`） */
  season: () => Number(series.value?.currentIndex) || 1,
  isDownloads: () => isDownloads.value,
  onListChanged: (id) => downloaded.open(id),
  onRefreshed: (res) => emit('downloaded', res),
})



// 作品一换（或详情刚到位）：收起简介 + 重取资源区。
// immediate 是必须的：面板打开时 data 是后到的，不设它没人触发第一次加载。
// `source` 也在依赖里 —— 同一部作品从首页切到下载页（或反过来）时，
// 面板内容不变，但底下那块资源要换成另一个来源的数据。
watch(
  [() => props.data?.id, () => props.source],
  ([id]) => {
    expanded.value = false
    seriesOpen.value = false
    resetMessages()
    resetSeries()
    if (!id) {
      mikan.reset()
      downloaded.reset()
      return
    }
    loadSeries(id)
    if (isDownloads.value) {
      mikan.reset() // 换来源时把另一份数据清掉，避免切回来看到旧的
      downloaded.open(id)
    } else {
      downloaded.reset()
      mikan.open(id)
      void loadDownloadedHashes(id) // 「已下载」按 hash 标绿（取不到就当没有）
    }
  },
  { immediate: true },
)


/**
 * AI 解析的**批大小** —— 必须与 `ReleaseList` 的 `PAGE_SIZE` 一致。
 * 展示多少条就解析多少条：首屏 120 条，用户点「显示更多」看到 121~240 时，才解析那一批。
 */
const AI_BATCH = 120
/** 已经交给 AI 解析过的条数（按资源列表顺序累计） */
const parsedCount = ref(0)

/**
 * 季提示（给 AI 消歧用）
 * ---------------------------------------------------------------------------
 * 详情 DTO 里没有单独的「季」字段，但有成品文案 `seasonText`（`2026 夏` / `2004 秋`）——
 * 取最后一段就是季。**不要再写 `data.value?.season?.season`**：那个字段根本不存在，
 * 脚本里也没有 `data` 这个变量，运行到「显示更多」时会抛 `data is not defined`。
 */
const seasonHintOf = () => String(props.data?.seasonText || '').trim().split(/\s+/).pop() || ''

/**
 * 保证「展示到第 limit 条」所需的批次都解析过（标签、集数各一批）
 * ---------------------------------------------------------------------------
 * · **增量**：只把还没解析过的那一段（120 条一批）发出去，结果是**累加**不是重来
 * · 首批（`parsedCount` 还是 0）用非累加模式：换字幕组/换作品得先丢掉旧结果
 * · 没配 AI 或解析失败都不该影响列表展示（前端规则兜底），所以 allSettled 不往外抛
 */
async function ensureParsed(limit = AI_BATCH) {
  const items = releaseItems.value
  if (!items.length || activeSubgroupId.value == null) return

  const target = Math.min(items.length, Math.ceil(Math.max(limit, AI_BATCH) / AI_BATCH) * AI_BATCH)
  if (target <= parsedCount.value) return

  const first = parsedCount.value === 0
  const batch = items.slice(parsedCount.value, target).map((item) => item.title)
  parsedCount.value = target

  const animeTitle = props.data?.title || ''
  await Promise.allSettled([
    loadAiTags(activeSubgroupId.value, batch, animeTitle, { merge: !first }),
    // 季一起给（与标签解析同一份上下文 → 服务端能命中同一份合并结果，省一次模型调用）
    // 季提示取「2026 夏」的最后一段：DTO 里没有单独的季字段，但 seasonText 够用来消歧
    loadEpisodes(animeTitle, batch, { merge: !first, season: seasonHintOf() }),
  ])
}

// 资源列表一就绪就先解析**第一批**；换字幕组后 releaseItems 被替换 → 从头再来。
// 下载页模式直接跳过：那边是「盘上已有的文件」，没有可筛的标签，也不该拿文件名去花 AI 的钱。
watch([releaseState, releaseItems], ([state]) => {
  if (isDownloads.value) return
  if (state !== 'ready' || activeSubgroupId.value == null) return
  parsedCount.value = 0
  ensureParsed(AI_BATCH)
})

// 仅视觉分级（≥7 分加重），不参与任何业务判断
const scoreStrong = computed(() => Number(props.data?.score) >= 7)

// Esc 关闭：面板是全站浮层，键盘用户不该被迫去点右上角
function onKeydown(event) {
  if (event.key === 'Escape' && props.visible) emit('close')
}
onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))
</script>

<style scoped>
/* ── 槽位：宽度 0 ↔ --panel-w，展开时挤窄主区（不遮盖内容） ───────────── */
.panel {
  flex-shrink: 0;
  width: 0;
  min-width: 0;
  height: 100vh;
  overflow: hidden;
  background: var(--bg-card);
  transition: width var(--dur) var(--ease-out), min-width var(--dur) var(--ease-out),
    box-shadow var(--dur) var(--ease-out);
}
.panel.open {
  width: var(--panel-w);
  min-width: var(--panel-w);
  border-left: 1px solid var(--border);
}

/* 内容固定宽度：宽度动画期间不回流（否则文字会被逐帧重排，看着发抖） */
.panel-inner {
  position: relative;
  width: var(--panel-w);
  padding: 20px 18px 40px;
  /* 展开时内容跟着「推」进来一点：宽度动画期间内容固定宽度不回流，位移只补观感 */
  opacity: 0;
  transform: translateX(10px);
  transition: opacity var(--dur) var(--ease-out) 0.08s, transform var(--dur) var(--ease-out) 0.08s;
}
.panel.open .panel-inner {
  opacity: 1;
  transform: none;
}

.close-btn {
  position: absolute;
  top: 14px;
  right: 14px;
  z-index: 2;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-input);
  color: var(--text-secondary);
  transition: color var(--dur-fast), border-color var(--dur-fast);
}
.close-btn:hover {
  color: var(--accent);
  border-color: var(--accent);
}

.detail {
  display: flex;
  flex-direction: column;
  gap: 16px;
  /*
   * 换作品时**轻微淡入 + 上浮** 8px：骨架屏就地替换成内容，如果直接硬切，
   * 观感是「闪一下就变了」。这条动画只在挂载时跑一次（详情带 :key=detail-id，
   * 换作品 = 重新挂载），所以来回切也不会累计。
   * 幅度刻意很小：动画是补观感，不是让人等它。
   */
  animation: detail-in 200ms var(--ease-out) both;
}
@keyframes detail-in {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
}
/* 用户要求减少动效（系统级设置）时不跑：内容直接出现，别跟无障碍设置对着干 */
@media (prefers-reduced-motion: reduce) {
  .detail {
    animation: none;
  }
}

/* ── 骨架 → 内容的交叉淡入 ───────────────────────────────────────────────
   骨架从 loading 切走后仍留在上层 180ms（`.skeleton-layer`），边淡出边上移 4px；
   下面的 `.detail` 同时跑 detail-in 淡入。两层短暂重叠 = 从占位"化开"成内容。 */
.detail-stage {
  position: relative;
}
.skeleton-layer {
  position: absolute;
  inset: 0;
  z-index: 1;
  pointer-events: none;
  animation: sk-layer-out 180ms var(--ease-out) forwards;
}
@keyframes sk-layer-out {
  to {
    opacity: 0;
    transform: translateY(-4px);
  }
}
@media (prefers-reduced-motion: reduce) {
  .skeleton-layer {
    animation: none;
    opacity: 0;
  }
}

/* ── 面板内的「换作品」不再有整块过渡 ─────────────────────────────────────
   旧版是把三态（loading → 详情 → 错误）全包在 <Transition mode="out-in"> 里做淡入淡出，
   换作品时先整块淡出、再整块淡入 —— 用户看到的是"整页在进"。
   现在改成**骨架屏就地替换**（DetailSkeleton）：结构位置不动，只有占位块在扫光，
   数据到了原处换成内容。所以 .phase-* 这套过渡类已经删掉了。 */

/* ── 头部：海报 + 标题 ────────────────────────────────────────────────── */
.detail-header {
  position: relative; /* 系列弹层的定位锚点（见下面 .series-popover） */
  display: flex;
  gap: 14px;
  align-items: flex-start;
  padding-right: 34px; /* 给右上角关闭按钮让位 */
}
.detail-poster {
  width: 96px;
  flex-shrink: 0;
  border-radius: var(--radius-sm);
  overflow: hidden;
}
.detail-head-text {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
  padding-top: 2px;
}
.detail-title {
  color: var(--text-primary);
  font-size: 1.02rem;
  line-height: 1.4;
  word-break: break-word;
}
.detail-title-alt {
  color: var(--text-tertiary);
  font-size: 0.75rem;
  line-height: 1.4;
  word-break: break-word;
}
.detail-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 2px;
}
.chip {
  padding: 2px 9px;
  border-radius: var(--radius-pill);
  background: var(--bg-input);
  color: var(--text-secondary);
  font-size: 0.72rem;
}
.chip-week {
  background: var(--accent-soft);
  color: var(--accent-strong);
  font-weight: 600;
}

/* ── 系列 chip（标题区第一颗）：点开列同系列作品 ─────────────────────────
   弹层**不挂在这里**（挂在 .detail-header 上）—— 面板内层是 `overflow-x: hidden`
   的滚动区（styles/base.css 的 .scroll-area），绝对定位挂在 chip 上会被右侧裁掉。
   这里只管这颗 chip 自己的样子。 */
.chip-series {
  display: inline-flex;
}
.chip-series-btn {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  cursor: pointer;
  /* 它是**导航**不是状态标签：给边框 + 透明底，让人一眼看出"能点" */
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text-secondary);
  transition: color var(--dur-fast), border-color var(--dur-fast), background var(--dur-fast);
}
.chip-series-btn:hover {
  border-color: var(--accent);
  background: var(--bg-hover);
  color: var(--accent);
}
.chip-caret {
  flex-shrink: 0;
  opacity: 0.75;
  transition: transform var(--dur-fast) var(--ease-out);
}
.chip-caret.open {
  transform: rotate(180deg);
}

/* 系列弹层（挂在 .detail-header 上）：**撑满面板内容宽度**，怎么放都在面板里。
   选择器比 PopoverPanel 自己的 `.popover` 多一层，所以能稳定覆盖它的 left/right/top。 */
.detail-header .series-popover {
  left: 0;
  right: 0;
  width: auto;
  min-width: 0;
  max-height: 46vh;
}
.series-head {
  margin: 0 0 6px;
  padding: 0 4px;
  color: var(--text-tertiary);
  font-size: 0.68rem;
  line-height: 1.4;
}
/* 一行两个动作：左边「换作品」，右边「去那一季」 */
.series-item {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
  transition: background var(--dur-fast), color var(--dur-fast);
}
.series-item:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}
.series-main {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  min-width: 0;
  padding: 5px 6px;
  color: inherit;
  font-size: 0.76rem;
  text-align: left;
}
/* 当前这一部：只强调、不可点（点它等于什么都不做） */
.series-item.on {
  color: var(--accent-strong);
  font-weight: 600;
}
.series-main:disabled {
  opacity: 1;
  cursor: default;
}
/* 季度胶囊：一排右侧的小按钮，点了回首页看那一季 */
.series-season {
  flex-shrink: 0;
  margin-right: 4px;
  padding: 1px 7px;
  border: 1px solid var(--border);
  border-radius: var(--radius-pill);
  color: var(--text-tertiary);
  font-size: 0.64rem;
  line-height: 1.6;
  white-space: nowrap;
  transition: border-color var(--dur-fast), color var(--dur-fast), background var(--dur-fast);
}
.series-season:hover {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent-strong);
}
.series-tag {
  flex-shrink: 0;
  min-width: 28px;
  color: var(--text-tertiary);
  font-family: var(--font-mono);
  font-size: 0.68rem;
}
.series-item.on .series-tag {
  color: var(--accent);
}
.series-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ── 信息卡：评分 / 放送 / 标签 ───────────────────────────────────────── */
.card {
  padding: 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-input);
}
.score-row {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 8px;
}
.score-value {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--text-primary);
  font-family: var(--font-mono);
  font-size: 1.06rem;
  font-weight: 700;
  line-height: 1;
}
.score-value svg {
  color: var(--mod-hot-strong);
}
.score-value.weak {
  color: var(--text-secondary);
}
.score-muted {
  color: var(--text-secondary);
  font-size: 0.75rem;
}
.score-watching {
  margin-left: auto;
}
.info-rows {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 10px;
}
.info-row {
  display: flex;
  gap: 10px;
  font-size: 0.78rem;
}
.info-row dt {
  flex-shrink: 0;
  width: 32px;
  color: var(--text-tertiary);
}
.info-row dd {
  color: var(--text-secondary);
}
.tag-row {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  margin-top: 10px;
}
.tag-chip {
  padding: 2px 8px;
  border-radius: var(--radius-pill);
  background: var(--accent-mist);
  color: var(--accent-strong);
  font-size: 0.7rem;
}

/* ── 简介：默认钳住 4 行；展开后**在框内滚动**（面板高度是固定的 100vh，
      简介放开会把下面的字幕组/资源列表一路顶出屏幕） ──────────────────── */
/* 简介标题：字号/颜色来自全局 .block-title，这里只给与内容的间距 */
.block-title {
  display: block;
  margin-bottom: 8px;
}
.summary {
  display: -webkit-box;
  -webkit-line-clamp: 4;
  -webkit-box-orient: vertical;
  overflow: hidden;
  color: var(--text-secondary);
  font-size: 0.78rem;
  line-height: 1.65;
  white-space: pre-line; /* 简介里本来就带换行，如实呈现 */
}
.summary.expanded {
  display: block;
  -webkit-line-clamp: unset;
  max-height: 32vh;      /* ≈ 面板可视高度的三分之一，剩下的留给资源区 */
  overflow-y: auto;
  padding-right: 6px;    /* 给滚动条留位，不然贴着文字 */
}
.summary-toggle {
  margin-top: 6px;
  color: var(--accent);
  font-size: 0.75rem;
}
.summary-toggle:hover {
  color: var(--accent-strong);
}

/* ── 外链：两个按钮等分撑满卡片宽度（原来宽度自适应内容，右侧空一片） ──── */
.link-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.link-btn {
  flex: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  padding: 7px 12px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-pill);
  color: var(--text-secondary);
  font-size: 0.76rem;
  transition: color var(--dur-fast), border-color var(--dur-fast);
}
.link-btn:hover {
  border-color: var(--accent);
  color: var(--accent);
}

/* ── 加种结果：一句话交代（成功 → 正常色，有失败 → 警示色）──────────── */
.dl-msg {
  margin: 0;
  color: var(--text-secondary);
  font-size: 0.76rem;
  line-height: 1.6;
  overflow-wrap: anywhere;
}
.dl-msg.bad {
  color: var(--danger);
}

/* ── 窄屏：挤不动了改成浮层（仍从右侧滑入），免得主区被压成一条 ────────── */
@media (max-width: 1100px) {
  .panel {
    position: fixed;
    top: 0;
    right: 0;
    z-index: 60;
  }
  .panel.open {
    box-shadow: var(--shadow-lg);
  }
}
</style>
