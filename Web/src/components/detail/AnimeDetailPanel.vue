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
      <StateBlock
        v-else-if="uiState === 'error'"
        state="error"
        :text="errorText || '读取失败，请稍后重试'"
        retry-text="重试"
        @retry="$emit('retry')"
      />

      <!-- ── 详情：key 带上作品主键（换一部就重新挂载，组件内的局部状态跟着归零） -->
      <div v-else-if="data" :key="'detail-' + data.id" class="detail">
          <header class="detail-header">
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
              label="同系列作品"
              @close="seriesOpen = false"
            >
              <p class="series-head">{{ series.rootTitle || '同系列' }} · {{ series.items.length }} 部</p>
              <button
                v-for="item in series.items"
                :key="item.animeId"
                class="series-item"
                :class="{ on: item.current }"
                type="button"
                :disabled="item.current"
                @click="pickSeries(item)"
              >
                <span class="series-tag">{{ seriesTagOf(item) }}</span>
                <span class="series-name">{{ item.title }}</span>
              </button>
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
          <section class="card">
            <SubgroupBar
              :subgroups="subgroups"
              :active-id="activeSubgroupId"
              :state="subgroupState"
              @select="selectSubgroup"
              @retry="retryReleases"
            />
          </section>

          <section class="card">
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
              :items="releaseItems"
              :episodes="aiEpisodes"
              :state="releaseState"
              :error-text="releasesError?.message || ''"
              :active-tags="aiActiveTags"
              :batch-filter="aiBatchFilter"
              @retry="retryReleases"
              @clear-filter="clearAiTags"
              @more="ensureParsed"
            />
          </section>
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
import AiSlot from './AiSlot.vue'
import PopoverPanel from '@/components/ui/PopoverPanel.vue'
import { useReleases } from '@/composables/useReleases'
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
})
const emit = defineEmits(['close', 'retry', 'open'])

/**
 * 资源区（字幕组 → 资源列表）由面板自己取数
 * ---------------------------------------------------------------------------
 * 这份状态只属于「面板里这一部作品」，关掉面板就没意义 —— 所以不进 App.vue 的全局状态，
 * 也不用 props 传进来（那会逼着容器处理「什么时候清、什么时候重取」的一堆边界）。
 * 容器约定（页面只摆、容器取数）针对的是**页面**；面板这种高内聚交互单元，
 * 取数收在 useReleases 里，组件本身仍然只负责摆。
 */
const {
  subgroups,
  activeId: activeSubgroupId,
  subgroupState,
  releases: releaseItems,
  releaseState,
  releasesError,
  select: selectSubgroup,
  retry: retryReleases,
  open: openReleases,
  reset: resetReleases,
} = useReleases()

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



// 作品一换（或详情刚到位）：收起简介 + 重取资源区。
// immediate 是必须的：面板打开时 data 是后到的，不设它没人触发第一次加载。
watch(
  () => props.data?.id,
  (id) => {
    expanded.value = false
    seriesOpen.value = false
    resetSeries()
    if (id) {
      openReleases(id)
      loadSeries(id)
    } else {
      resetReleases()
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
    loadEpisodes(animeTitle, batch, { merge: !first }),
  ])
}

// 资源列表一就绪就先解析**第一批**；换字幕组后 releaseItems 被替换 → 从头再来
watch([releaseState, releaseItems], ([state]) => {
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
.series-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 5px 6px;
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
  font-size: 0.76rem;
  text-align: left;
  transition: background var(--dur-fast), color var(--dur-fast);
}
.series-item:hover:not(:disabled) {
  background: var(--bg-hover);
  color: var(--text-primary);
}
/* 当前这一部：只强调、不可点（点它等于什么都不做） */
.series-item.on {
  color: var(--accent-strong);
  font-weight: 600;
}
.series-item.on:disabled {
  opacity: 1;
  cursor: default;
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
