<template>
  <section class="releases">
    <!-- 头部：左边「信息」（计数 / 全选 / 已选），右边「操作」（下载）。
         宽就一行；窄了让操作组**整组**换行，不会一个个按钮掉下来。 -->
    <div class="head">
      <div class="head-info">
        <h3 class="block-title">资源</h3>
        <span v-if="state === 'ready'" class="count">
          {{
            filtered.length === items.length
              ? `${items.length} 个种子`
              : `筛选后 ${filtered.length} / 共 ${items.length}`
          }}
        </span>
        <!-- 全选 / 取消全选：一个按钮切换，范围 = 当前筛选结果（含还没渲染出来的那些） -->
        <button
          v-if="state === 'ready' && filtered.length"
          class="select-all"
          :class="{ on: allChecked }"
          type="button"
          :aria-pressed="allChecked"
          @click="toggleAll"
        >
          <IconCheckbox v-if="allChecked" :size="13" />
          <IconSquare v-else :size="13" />
          {{ allChecked ? '取消全选' : '全选' }}
        </button>
        <span v-if="checked.length" class="checked-count">已选 {{ checked.length }} / {{ filtered.length }}</span>
      </div>

      <div class="head-actions">
        <button
          v-if="checked.length"
          class="dl-btn"
          type="button"
          :aria-disabled="!downloadReady"
          :title="DOWNLOAD_HINT"
          @click="downloadChecked"
        >
          <IconDownload :size="13" /> 下载选中 ({{ checked.length }})
        </button>
        <!-- 只有这一个「下载」按钮：没筛就是全部、筛过就是筛选结果（文案跟着变） -->
        <button
          class="dl-btn primary"
          type="button"
          :aria-disabled="!downloadReady"
          :title="DOWNLOAD_HINT"
          @click="downloadFiltered"
        >
          <IconDownload :size="13" />
          {{ activeTags.length ? `下载筛选结果 (${filtered.length})` : `全部下载 (${filtered.length})` }}
        </button>
      </div>
    </div>

    <!-- 三态与列表都走淡入淡出：切换时内容不会「突然长出来」把下面的东西挤下去 -->
    <Transition name="rel-phase" mode="out-in">
      <StateBlock v-if="state === 'loading'" key="loading" state="loading" text="正在取资源列表…" />
      <StateBlock
        v-else-if="state === 'error'"
        key="error"
        state="error"
        :text="errorText || '资源列表取不到'"
        retry-text="重试"
        @retry="$emit('retry')"
      />
      <p v-else-if="state === 'empty'" key="empty" class="empty">这个字幕组暂时没有资源</p>
      <div v-else-if="!filtered.length" key="nomatch" class="empty">
        没有符合所选标签的资源
        <button class="clear-filter" type="button" @click="$emit('clear-filter')">清除筛选</button>
      </div>

      <div v-else key="list" class="list-wrap">
        <ul class="list">
          <li
            v-for="item in visibleItems"
            :key="item.magnetHash || item.title"
            class="item"
            :class="{ checked: isChecked(item) }"
            @click="toggleCheck(item)"
          >
            <!-- 集数区：照旧版一个独立的竖条（56px），数字用斜体衬线，一眼能扫到第几集 -->
            <span class="ep" :class="{ batch: item.batch, unknown: !item.episode }">
              {{ item.episode || '—' }}
            </span>

            <div class="body">
              <!-- 多选：点整行即可。选中态只用「蓝色外框 + 集数区变蓝」表达，
                   不再额外摆复选框和对勾 —— 同一个意思画两遍是噪音（旧版才有那个勾选框） -->
              <p class="title" :title="item.title">{{ item.title }}</p>

              <!-- 元信息一行（用 `·` 分隔）。修订版不再在每条上标 v2 —— 
                   那属于"筛选条件"层面的信息（已选区画了 PREFER 修订版），逐条重复标注是噪音 -->
              <p class="meta">
                <span v-if="item.sizeText" class="num">{{ item.sizeText }}</span>
                <span v-if="item.publishedText" class="num">{{ item.publishedText }}</span>
              </p>

              <!-- 操作条：**三等分铺满整行** —— 原来三个图标挤在右侧、左边空一片，
                   现在按钮带文字、等分排开，不用 hover 猜也不用找。 -->
              <div class="ops">
                <button
                  v-if="item.magnet"
                  class="op"
                  :class="{ copied: copiedKey === item.magnetHash }"
                  type="button"
                  :title="copiedKey === item.magnetHash ? '已复制磁力链接' : '复制磁力链接'"
                  :aria-label="copiedKey === item.magnetHash ? '已复制磁力链接' : '复制磁力链接'"
                  @click.stop="copyMagnet(item)"
                >
                  <component :is="copiedKey === item.magnetHash ? IconCheck : IconMagnet" :size="14" />
                  {{ copiedKey === item.magnetHash ? '已复制' : '磁力' }}
                </button>
                <a
                  v-if="item.torrentUrl"
                  class="op"
                  :href="item.torrentUrl"
                  target="_blank"
                  rel="noopener noreferrer"
                  title="下载 .torrent 文件"
                  @click.stop
                >
                  <IconFileDownload :size="14" /> 种子
                </a>
                <!-- 下载（预留）：功能接入后把 downloadReady 置 true 即可。
                     用 aria-disabled 而不是 disabled —— disabled 的元素浏览器不显示 title -->
                <button
                  class="op"
                  type="button"
                  :aria-disabled="!downloadReady"
                  :title="DOWNLOAD_HINT"
                  @click.stop
                >
                  <IconDownload :size="14" /> 下载
                </button>
              </div>
            </div>
          </li>
        </ul>

        <button
          v-if="filtered.length > visibleItems.length"
          class="more"
          type="button"
          @click="limit += PAGE_SIZE"
        >
          显示更多（还有 {{ filtered.length - visibleItems.length }} 条）
        </button>
      </div>
    </Transition>
  </section>
</template>

<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { IconCheck, IconCheckbox, IconDownload, IconFileDownload, IconMagnet, IconSquare } from '@tabler/icons-vue'
import StateBlock from '@/components/ui/StateBlock.vue'
import { dedupeLatestRevisions, episodeOf, isBatchEpisode } from '@/utils/episode'

/**
 * 资源列表（面板「资源」区第二级）
 * ---------------------------------------------------------------------------
 * 纯展示：条目、三态、筛选条件都由面板给，这里只做三件自己的事：
 *   1. 按 AI 标签筛 —— 后端保证 `match` 是从文件名逐字摘抄的，所以只做字符串包含；
 *      多个标签照旧版语义：**同类型之间 OR、跨类型之间 AND**（与 AiSlot 画出来的 AND/OR 一致）
 *   2. 集数徽标 —— 用 utils/episode.js 的规则从文件名取值（AI 集数解析是更准的版本，按需再用）
 *   3. 复制磁力 + 长列表分批渲染（首次 40 条）
 *   4. 多选 + 下载入口：下载本身还没接（要等 qBittorrent 那部分），
 *      先把按钮与「已选 N」的位置定下来，接上时把 downloadReady 置 true 就能用
 */
const props = defineProps({
  /** [{ title, magnet, magnetHash, torrentUrl, sizeText, publishedText }] */
  items: { type: Array, default: () => [] },
  /** title → 集号（AI 逐条解析的结果）；没有的条目回落到前端规则 */
  episodes: { type: Object, default: () => ({}) },
  /** loading | error | empty | ready */
  state: { type: String, default: 'loading' },
  /** 失败时的具体文案（ApiError.message） */
  errorText: { type: String, default: '' },
  /** AI 选中的标签（[{ name, type, match[] }]）；空数组 = 不筛 */
  activeTags: { type: Array, default: () => [] },
  /** 资源类型过滤：all | single | batch */
  batchFilter: { type: String, default: 'all' },
})
const emit = defineEmits(['retry', 'clear-filter', 'more'])

/**
 * 一屏 = 一批 = **120 条**（与 AI 解析批次对齐）。
 * 「显示更多」再加 120，并把新的一批交给面板去解析（面板收到 more 事件后解析增量并累加标签）。
 * 这个 120 必须与 `AnimeDetailPanel` 的 `AI_BATCH` 保持一致 —— 展示与解析同步，不提前花冤枉钱。
 */
const PAGE_SIZE = 120
const limit = ref(PAGE_SIZE)
const copiedKey = ref('')
let copyTimer = null

/**
 * 集号：**优先用 AI 解析的结果**（后端逐条解析，准确度高），
 * 没解析出来（AI 未配置 / 失败 / 这条为空）才回落到前端规则。
 * 所以即使没配 AI，界面也不会退化成"全是 —"。
 */
const epOf = (item) => String(props.episodes?.[item.title] ?? '').trim() || episodeOf(item.title)

/**
 * 筛选口径（与 AiSlot 画出来的 AND/OR 完全一致）：
 *   · 同类型的标签之间是 OR（分辨率的「1080P 或 720P」）
 *   · 不同类型之间是 AND（「分辨率合格」且「字幕符合」）
 *   · 资源类型（单集/合集）另算一维，用文件名里的集数规则判断
 */
const filtered = computed(() => {
  let list = props.items

  // 「修订版」不是字符串匹配，而是规则筛（见下方 dedupeLatest），单独拎出来
  const revisionFilter = props.activeTags.some((tag) => tag.kind === 'revision')
  const textTags = props.activeTags.filter((tag) => tag.kind !== 'revision')

  if (textTags.length) {
    const groups = new Map()
    for (const tag of textTags) {
      const key = tag.type || 'other'
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push((tag.match || []).map((m) => String(m).toLowerCase()))
    }
    list = list.filter((item) => {
      const title = item.title.toLowerCase()
      return [...groups.values()].every((group) =>
        group.some((needles) => needles.some((needle) => needle && title.includes(needle))),
      )
    })
  }

  // 修订版优先：同一集出现多个版本时，原版给修订版让位（某集只有原版则照旧保留）
  if (revisionFilter) {
    list = dedupeLatestRevisions(list)
  }

  if (props.batchFilter === 'single' || props.batchFilter === 'batch') {
    list = list.filter((item) => {
      const isBatch = isBatchEpisode(epOf(item))
      return props.batchFilter === 'batch' ? isBatch : !isBatch
    })
  }

  // 命中越多排越前（照旧版的 matchScore）：同时命中 1080P 与「简繁内封」的排最上面。
  // 分数先算一遍再排 —— 直接写在比较函数里，同一条标题的正则会跑 O(n log n) 次（几百条就明显卡）
  if (props.activeTags.length) {
    const scores = new Map()
    for (const item of list) scores.set(item, scoreOf(item))
    list = [...list].sort((a, b) => (scores.get(b) || 0) - (scores.get(a) || 0))
  }

  return list
})

/**
 * 同一集只留最高修订版 —— 算法在 `utils/episode.js` 的 `dedupeLatestRevisions`（可单测），
 * 这里不再重复一份实现。
 */

/** 方括号里的内容：[1080P][简繁内封] → ['1080P', '简繁内封']（旧版算命中数就是看这个） */
const bracketTagsOf = (title) => (String(title || '').match(/\[([^\]]+)\]/g) || []).map((m) => m.slice(1, -1))

/** 这条资源命中几个已选标签（用来排序，不参与筛选判定） */
function scoreOf(item) {
  const brackets = bracketTagsOf(item.title)
  return props.activeTags.reduce((n, tag) => n + (brackets.includes(tag.name) ? 1 : 0), 0)
}

/* ── 多选与下载（下载功能未接入，先把入口的位置与层级定下来）─────────────
   多选照旧版：点整行或点勾选框都能选，头部显示「已选 N」，选中行整行描边。 */
const checked = ref([])
const keyOf = (item) => item.magnetHash || item.title
const isChecked = (item) => checked.value.includes(keyOf(item))

function toggleCheck(item) {
  const key = keyOf(item)
  const next = new Set(checked.value)
  next.has(key) ? next.delete(key) : next.add(key)
  checked.value = [...next]
}

/* 全选 / 取消全选：**一个按钮切换**，范围是「当前筛选结果」全部（含还没渲染出来的那些）。
   O(n) 用 Set 判，别在模板里对几百条做 includes。 */
const checkedSet = computed(() => new Set(checked.value))
const allChecked = computed(() => {
  const list = filtered.value
  return list.length > 0 && list.every((item) => checkedSet.value.has(keyOf(item)))
})
function toggleAll() {
  checked.value = allChecked.value ? [] : filtered.value.map((item) => keyOf(item))
}

/** 接上下载后置 true，两个按钮自动变可点（结构不用改） */
const downloadReady = false
const DOWNLOAD_HINT = '下载功能还没接入（等 qBittorrent 那部分做完）'
function downloadChecked() {}
function downloadFiltered() {}

/** 渲染用：集号（AI 优先）+ 合集标记 */
const visibleItems = computed(() =>
  filtered.value.slice(0, limit.value).map((item) => {
    const episode = epOf(item)
    return {
      ...item,
      episode,
      batch: isBatchEpisode(episode),
    }
  }),
)

// 换字幕组或换筛选条件时，把「显示更多」收回初始值，避免新列表一进来就是几百条
watch(
  () => [props.items, props.activeTags, props.batchFilter],
  () => {
    limit.value = PAGE_SIZE
    // 换字幕组后之前勾的种子已经不在列表里了 —— 清掉，免得顶部显示「已选 3」却找不到是哪三条
    checked.value = []
  },
)

/**
 * 「显示更多」把新的一批暴露出来 → 通知面板去解析这一批（面板按 120 分批、累加结果）。
 * 只在 limit 变大时才需要解析，面板自己会按「已解析到第几条」判断要不要真发请求。
 */
watch(limit, (value) => emit('more', value))

async function copyMagnet(item) {
  try {
    await navigator.clipboard.writeText(item.magnet)
    copiedKey.value = item.magnetHash || item.magnet
    clearTimeout(copyTimer)
    copyTimer = setTimeout(() => {
      copiedKey.value = ''
    }, 1600)
  } catch {
    /* 非安全上下文 / 无权限：按钮的 title 已写明可以右键复制 */
  }
}

onBeforeUnmount(() => clearTimeout(copyTimer))
</script>

<style scoped>
.releases {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
/* 头部固定两行：上面「信息」（计数 / 全选 / 已选），下面「操作」（下载）。
   不做"宽就一行、窄就换行"那种自适应 —— 面板只有 340px，选中后多一个按钮 + 一个计数，
   自适应会立刻把内容挤成"计数在左、按钮在右、还跨两行"的乱样子。 */
.head {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
/* 信息行：内容多了在这一行里换，不会跟操作行混在一起 */
.head-info {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
/* 全选 / 取消全选：一个按钮，选中态实底 */
.select-all {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 9px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-pill);
  color: var(--text-secondary);
  font-size: 0.72rem;
  transition: color var(--dur-fast), border-color var(--dur-fast), background var(--dur-fast);
}
.select-all:hover {
  border-color: var(--accent);
  color: var(--accent);
}
.select-all.on {
  border-color: var(--tag-res);
  background: var(--tag-res);
  color: var(--text-invert);
}
/* 已选计数：与选中行的描边同色，形成「选了几条」的呼应 */
.checked-count {
  color: var(--tag-res);
  font-size: 0.72rem;
  font-weight: 600;
}
/* 操作行：左对齐、自己一行；按钮多了在这行里换行 */
.head-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-left: auto;
}
/* 下载按钮（预留）：禁用态半透明，接上 qBittorrent 后自动变可点 */
.dl-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 11px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-pill);
  background: var(--bg-card);
  color: var(--text-secondary);
  font-size: 0.72rem;
  transition: color var(--dur-fast), border-color var(--dur-fast);
}
.dl-btn.primary:not([aria-disabled='true']),
.dl-btn:not([aria-disabled='true']):hover {
  border-color: var(--accent);
  color: var(--accent);
}
/* 未接入的下载按钮：看着是禁用的，但 title 照样能看（disabled 属性会把提示也一起挡掉） */
.dl-btn[aria-disabled='true'] {
  opacity: 0.5;
  cursor: not-allowed;
}
/* .block-title 的字号/颜色来自全局（base.css），这里不再各写一份 */
/* .block-title 的字号/颜色来自全局（base.css），这里不再各写一份 */
.count {
  color: var(--text-tertiary);
  font-size: 0.72rem;
}
.empty {
  padding: 4px 0;
  color: var(--text-tertiary);
  font-size: 0.78rem;
}
.clear-filter {
  margin-left: 6px;
  color: var(--accent);
  font-size: 0.72rem;
}
.clear-filter:hover {
  color: var(--accent-strong);
}

/* ── 列表：每条 = 左侧集数竖条（56px）+ 右侧内容（照旧版的两段式）────────── */
.list-wrap,
.list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.item {
  display: grid;
  grid-template-columns: 56px minmax(0, 1fr);
  min-height: 58px;
  overflow: hidden; /* 集数区要贴到卡片边，圆角靠这一层裁 */
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-input);
  cursor: pointer;
  transition: border-color var(--dur-fast), box-shadow var(--dur-fast);
}
.item:hover {
  border-color: var(--border-strong);
}
.item.checked {
  border-color: var(--tag-res);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--tag-res) 18%, transparent);
}

/* ── 集数区：旧版的识别特征（暖金底 + 右侧分隔线 + 斜体衬线数字）──────────
   尺寸按旧版来：56px 宽竖条 + 1.55rem，扫一眼就能找到「第几集」。 */
.ep {
  display: flex;
  align-items: center;
  justify-content: center;
  background: color-mix(in srgb, var(--accent-gold) 14%, transparent);
  border-right: 1px solid color-mix(in srgb, var(--accent-gold) 26%, transparent);
  color: var(--accent-gold);
  font-family: Georgia, 'Times New Roman', 'Noto Serif SC', serif;
  font-size: 1.55rem;
  font-style: italic;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  line-height: 1;
  user-select: none;
  transition: color var(--dur-fast), background var(--dur-fast), border-color var(--dur-fast);
}
/* 合集是范围（01-12），1.55rem 会撑破 56px —— 单独降一档 */
.ep.batch {
  font-size: 0.95rem;
  font-style: normal;
}
/* 取不到集数：显示「—」并弱化，保留列宽（列表不左右跳） */
.ep.unknown {
  color: var(--text-tertiary);
  font-style: normal;
}
/* 选中：集数区跟着变蓝，和右边界描边呼应 */
.item.checked .ep {
  background: color-mix(in srgb, var(--tag-res) 12%, transparent);
  border-right-color: color-mix(in srgb, var(--tag-res) 26%, transparent);
  color: var(--tag-res);
}

/* 修订版标记已去掉：它属于筛选条件层面的信息（已选区画 PREFER），逐条标注是噪音 */

.body {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
  padding: 10px 14px;
}
.title {
  color: var(--text-primary);
  font-size: 0.76rem;
  line-height: 1.5;
  word-break: break-word;
}
/* 元信息一行：`·` 作分隔符（不用手写点，靠 CSS 加在相邻项之间） */
.meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0 8px;
  color: var(--text-tertiary);
  font-size: 0.7rem;
}
.meta > * + *::before {
  content: '·';
  margin-right: 8px;
  color: var(--border-strong);
}
/* 大小与时间用等宽数字：一列条目能对齐着读 */
.num {
  font-variant-numeric: tabular-nums;
}
/* 操作条：**三等分铺满整行**（按钮数不定：没磁力/没种子时自动两等分） */
.ops {
  display: grid;
  grid-auto-flow: column;
  grid-auto-columns: 1fr;
  gap: 6px;
}
.op {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  height: 26px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  background: var(--bg-card);
  color: var(--text-secondary);
  font-size: 0.7rem;
  transition: color var(--dur-fast), border-color var(--dur-fast);
}
.op:hover {
  border-color: var(--accent);
  color: var(--accent);
}
/* 复制成功：变绿 + 文案换成「已复制」 */
.op.copied {
  border-color: var(--tag-sub);
  color: var(--tag-sub);
}
/* 「下载」还没接入：看着禁用，但 hover 仍能看到 title 说明 */
.op[aria-disabled='true'] {
  opacity: 0.5;
  cursor: not-allowed;
}
.more {
  align-self: center;
  margin-top: 2px;
  padding: 5px 14px;
  border-radius: var(--radius-pill);
  background: var(--bg-input);
  color: var(--text-secondary);
  font-size: 0.74rem;
}
.more:hover {
  color: var(--accent);
}

/* ── 状态切换过渡：淡入 + 轻微上移 ──────────────────────────────────────
   没有它的话，加载完成的内容会「突然长出来」，把下面的元素直接挤下去。 */
.rel-phase-enter-active {
  transition: opacity var(--dur) var(--ease-out), transform var(--dur) var(--ease-out);
}
.rel-phase-leave-active {
  transition: opacity var(--dur-fast) var(--ease-out), transform var(--dur-fast) var(--ease-out);
}
.rel-phase-enter-from {
  opacity: 0;
  transform: translateY(6px);
}
.rel-phase-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}
</style>
