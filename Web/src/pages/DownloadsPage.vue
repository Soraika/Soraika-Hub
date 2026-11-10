<template>
  <div class="downloads">
    <div ref="scrollHost" class="downloads-main scroll-area">
      <!-- ── 顶部栏：标题 + 一句汇总 + 刷新（与首页同一套吸顶栏样式）────── -->
      <header class="topbar topbar-surface">
        <div class="topbar-inner">
          <h1 class="page-title">下载</h1>

          <p v-if="configured" class="summary">
            <span class="stat">{{ counts.anime || 0 }} 部 · {{ counts.total || 0 }} 个种子</span>
            <span v-if="counts.sizeText" class="dot">·</span>
            <span v-if="counts.sizeText" class="stat">{{ counts.sizeText }}</span>
            <span v-if="transfer" class="dot">·</span>
            <span v-if="transfer" class="stat speed" :class="{ busy: transfer.dlSpeed > 0 }">
              ↓ {{ speedText(transfer.dlSpeed) }} / ↑ {{ speedText(transfer.upSpeed) }}
            </span>
            <!-- 版本是「连到的是哪个 qB」的凭据：应用版本 + WebAPI 版本都要 -->
            <span v-if="versions" class="stat ver">qB {{ versions.app }} · WebAPI {{ versions.api }}</span>
            <!-- 有任务在跑时页面自己每 5 秒刷新一次，这里说一声，免得以为数据不动 -->
            <span v-if="polling" class="stat auto" title="有下载中的任务，页面每 5 秒刷新一次">
              <span class="dot-live" /> 自动刷新中
            </span>
          </p>

          <button class="refresh" type="button" :disabled="refreshing" @click="$emit('reload')">
            <IconRefresh :size="14" :class="{ spin: refreshing }" />
            {{ refreshing ? '刷新中…' : '刷新' }}
          </button>
        </div>
      </header>

      <StateBlock v-if="uiState === 'loading'" state="loading" text="正在读下载记录…" />
      <StateBlock
        v-else-if="uiState === 'error'"
        state="error"
        text="下载记录取不到"
        retry-text="重试"
        @retry="$emit('reload')"
      />

      <!-- 没配 qB：这里给的是「下一步做什么」，不是错误 -->
      <section v-else-if="!configured" class="notice">
        <p class="notice-title">还没有连上 qBittorrent</p>
        <p class="notice-text">
          在「设置 → 下载」里填好地址与 API Key，这个页面就会列出已经在下的和已经下完的番。
        </p>
      </section>

      <StateBlock v-else-if="uiState === 'empty'" state="empty" text="还没有下载记录" />

      <div v-else class="sections">
        <section v-for="group in sections" :key="group.key" class="group">
          <h2 class="group-label">
            {{ group.label }}
            <span class="group-count">{{ group.items.length }}</span>
            <span v-if="group.hint" class="group-hint">{{ group.hint }}</span>
          </h2>

          <CardGrid :items="group.items">
            <template #default="{ item }">
              <PosterCard
                :title="item.title"
                :poster="item.poster"
                :badge="badgeOf(item)"
                :badge-tone="badgeToneOf(item)"
                :show-rating="false"
                :meta-text="metaOf(item)"
                :selected="item.id === activeAnimeId"
                @click="$emit('open-anime', item)"
              >
                <!-- 缺哪集：库里有总集数才给（剧场版 / 没登记的不瞎猜） -->
                <template v-if="item.progressText" #footer>
                  <div class="ep-progress" :class="{ complete: !item.missingCount }">
                    <span class="ep-count">{{ item.progressText }}</span>
                    <span class="ep-missing" :title="missingTitle(item)">{{ item.missingText }}</span>
                  </div>
                </template>
              </PosterCard>
            </template>
          </CardGrid>
        </section>

        <!-- 认不出作品的那一堆：不藏起来，但要说明「为什么在这里」 -->
        <section v-if="unmatched.length" class="group">
          <h2 class="group-label">
            未识别
            <span class="group-count">{{ unmatched.length }}</span>
            <span class="group-hint">目录在盘上，但对不上库里的作品</span>
          </h2>
          <ul class="unmatched">
            <li v-for="u in unmatched" :key="u.name" class="u-row">
              <span class="u-name" :title="u.name">{{ u.name }}</span>
              <span class="u-meta">{{ u.count }} 个 · {{ u.sizeText }}</span>
            </li>
          </ul>
        </section>
      </div>

      <BackToTop target=".downloads-main" />
    </div>
  </div>
</template>


<script setup>
import { computed } from 'vue'
import { IconRefresh } from '@tabler/icons-vue'
import PosterCard from '@/components/common/PosterCard.vue'
import CardGrid from '@/components/common/CardGrid.vue'
import StateBlock from '@/components/ui/StateBlock.vue'
import BackToTop from '@/components/ui/BackToTop.vue'

/**
 * 下载页 —— 与首页同构：顶部栏 + 卡片墙，点海报在右侧面板看详情
 * ---------------------------------------------------------------------------
 * 与首页唯一的差别是「点开后面板显示什么」：那边是 Mikan 的资源列表，
 * 这边是已下载的文件（按字幕组分组）。所以本页只上抛 `open-anime`，
 * 由容器决定面板用哪个数据源（见 App.vue 的 panelSource）。
 *
 * 数据全部来自 props（容器调 useDownloads 取），页面只负责分组与文案。
 */
const props = defineProps({
  /** `/api/downloads` 的整份返回（字段见 api/downloads.js） */
  data: { type: Object, default: null },
  /** loading | error | empty | ready */
  uiState: { type: String, default: 'loading' },
  /** 刷新中（已有数据，只是后台再取） */
  refreshing: { type: Boolean, default: false },
  /** 是否在自动刷新（有下载中的任务时每 5 秒一次） */
  polling: { type: Boolean, default: false },
  /** 当前打开的作品主键（卡片选中态） */
  activeAnimeId: { type: Number, default: null },
})
defineEmits(['open-anime', 'reload'])

const configured = computed(() => Boolean(props.data?.configured))
const items = computed(() => props.data?.items ?? [])
const unmatched = computed(() => props.data?.unmatched ?? [])
const counts = computed(() => props.data?.counts ?? {})
const versions = computed(() => props.data?.versions ?? null)
const transfer = computed(() => props.data?.transfer ?? null)

/**
 * 三个分区（顺序固定：正在发生的事在最上面）
 * 空分区不渲染 —— 过滤掉而不是摆个空标题。
 */
const sections = computed(() =>
  [
    { key: 'downloading', label: '下载中', hint: '', items: items.value.filter((it) => it.state === 'downloading') },
    { key: 'done', label: '已完成', hint: '', items: items.value.filter((it) => it.state === 'done') },
    {
      key: 'missing',
      label: '异常',
      hint: '文件丢失 / 出错，需要看一眼',
      items: items.value.filter((it) => it.state === 'missing' || it.state === 'error'),
    },
  ].filter((group) => group.items.length),
)

/** 徽标：下载中给百分比（一眼知道还差多少），其余给集数 */
function badgeOf(item) {
  if (item.state === 'downloading') return `${item.progress}%`
  if (item.state === 'missing') return '丢失'
  return item.count ? `${item.count} 集` : '已下'
}
/** 配色只用三种（下载中=热、已完成=中性、异常=提示），别一张卡一个颜色 */
const badgeToneOf = (item) => (item.state === 'downloading' ? 'hot' : item.state === 'missing' ? 'try' : 'neutral')

/** 卡片底下那行：最新第几集 · 体积（总集数/缺集在 footer 那一行，信息行不塞太多） */
function metaOf(item) {
  const parts = []
  if (item.latestEpisode) parts.push(`最新 ${item.latestEpisode}`)
  if (item.sizeText) parts.push(item.sizeText)
  if (item.totalEpisodes && !item.progressText) parts.push(`共 ${item.totalEpisodes} 话`)
  return parts.join(' · ')
}

/** 缺集那一行的悬停说明：列出前几个集号（后端只带 12 个，够看） */
function missingTitle(item) {
  if (!item.missingCount) return ''
  const list = (item.missingEpisodes || []).map((n) => String(n).padStart(2, '0')).join(' ')
  return item.missingCount > (item.missingEpisodes || []).length ? `缺 ${item.missingCount} 集：${list} …` : `缺：${list}`
}

/** 速度：qB 给的是字节/秒 → `1.2 MB/s`；0 就写「0」 */
function speedText(bytes) {
  const n = Number(bytes) || 0
  if (n <= 0) return '0'
  const units = ['B', 'KB', 'MB', 'GB']
  let v = n
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}/s`
}
</script>

<style scoped>
.downloads {
  display: flex;
  height: 100vh;
  overflow: hidden;
}
.downloads-main {
  position: relative;
  flex: 1;
}

/* ── 顶部栏 ───────────────────────────────────────────────────────────── */
.topbar {
  position: sticky;
  top: 0;
  z-index: 30;
  padding: 14px var(--page-pad-x);
}
.topbar-inner {
  display: flex;
  align-items: center;
  gap: 14px;
}
.page-title {
  margin: 0;
  font-size: 1.1rem;
  font-weight: 700;
  color: var(--text-primary);
  white-space: nowrap;
}
.summary {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  margin: 0;
  flex: 1;
  min-width: 0;
  font-size: 0.78rem;
  color: var(--text-tertiary);
}
.summary .dot {
  color: var(--border-strong);
}
.summary .speed.busy {
  color: var(--accent);
}
.summary .ver {
  margin-left: auto;
  font-family: var(--font-mono);
  font-size: 0.72rem;
}
/* 「自动刷新中」：一个小呼吸点，比转圈安静（数据自己在动，不需要让人盯着） */
.summary .auto {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--accent);
}
.dot-live {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent);
  animation: live-pulse 1.4s ease-in-out infinite;
}
@keyframes live-pulse {
  0%,
  100% {
    opacity: 1;
    transform: scale(1);
  }
  50% {
    opacity: 0.35;
    transform: scale(0.8);
  }
}
.refresh {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex-shrink: 0;
  padding: 6px 12px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-pill);
  background: var(--bg-card);
  color: var(--text-secondary);
  font-size: 0.76rem;
  cursor: pointer;
  transition: color var(--dur-fast), border-color var(--dur-fast);
}
.refresh:hover:not(:disabled) {
  border-color: var(--accent);
  color: var(--accent);
}
.refresh:disabled {
  opacity: 0.6;
  cursor: default;
}
.spin {
  animation: spin 1s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

/* ── 未配置的引导 ─────────────────────────────────────────────────────── */
.notice {
  margin: 24px var(--page-pad-x);
  padding: 18px 20px;
  border: 1px dashed var(--border-strong);
  border-radius: var(--radius);
  background: var(--bg-card);
}
.notice-title {
  margin: 0 0 6px;
  color: var(--text-primary);
  font-size: 0.9rem;
  font-weight: 600;
}
.notice-text {
  margin: 0;
  color: var(--text-secondary);
  font-size: 0.82rem;
  line-height: 1.6;
}

/* ── 分区 ─────────────────────────────────────────────────────────────── */
.sections {
  display: flex;
  flex-direction: column;
  gap: 30px;
  padding: 18px var(--page-pad-x) 72px;
}
.group {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.group-label {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 0;
  font-size: 1.05rem;
  font-weight: 700;
  color: var(--text-primary);
}
.group-label::after {
  content: '';
  flex: 1;
  height: 1px;
  background: var(--border);
}
.group-count {
  padding: 1px 8px;
  border-radius: var(--radius-pill);
  background: var(--bg-hover);
  color: var(--text-secondary);
  font-size: 0.7rem;
  font-weight: 600;
}
.group-hint {
  color: var(--text-tertiary);
  font-size: 0.72rem;
  font-weight: 400;
}

/* 缺哪集：卡片底部一行 —— 左边「已下 x / 共 y」，右边缺的集号（已齐时变中性色） */
.ep-progress {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 0.72rem;
  line-height: 1.2;
}
.ep-count {
  flex-shrink: 0;
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
}
.ep-missing {
  min-width: 0;
  color: var(--accent-strong);
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ep-progress.complete .ep-missing {
  color: var(--text-tertiary);
  font-weight: 400;
}


/* 未识别：一行一个目录，长名字省略（完整名看 title） */
.unmatched {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.u-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-card);
  font-size: 0.76rem;
}
.u-name {
  flex: 1;
  min-width: 0;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.u-meta {
  flex-shrink: 0;
  color: var(--text-tertiary);
  font-size: 0.72rem;
}

@media (max-width: 900px) {
  .topbar-inner {
    flex-wrap: wrap;
  }
  .summary .ver {
    margin-left: 0;
  }
}
</style>
