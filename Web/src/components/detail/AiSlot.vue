<template>
  <section class="ai-slot" :class="`is-${state}`" aria-label="AI 标签解析">
    <div class="ai-head">
      <span class="ai-title block-title">{{ title }}</span>
      <span v-if="badge" class="ai-badge">{{ badge }}</span>
    </div>

    <!-- 未配置：在卡片内用一个虚线块说明状态（整卡虚线会与外层卡片叠成双层框） -->
    <template v-if="state === 'disabled'">
      <div class="ai-placeholder">
        <div class="ai-skeleton" aria-hidden="true">
          <span v-for="(w, i) in BARS" :key="i" class="ai-bar" :style="{ width: `${w}%` }" />
        </div>
        <p class="ai-hint">未配置 AI 服务：在设置页填写密钥后，这里会自动列出这批资源的标签（资源列表不受影响）</p>
      </div>
    </template>

    <!-- 解析中 -->
    <template v-else-if="state === 'loading'">
      <div class="ai-skeleton" aria-hidden="true">
        <span v-for="(w, i) in BARS" :key="i" class="ai-bar" :style="{ width: `${w}%` }" />
      </div>
      <p class="ai-hint">正在解析这批资源的标签…</p>
    </template>

    <!-- 失败：可重试 -->
    <template v-else-if="state === 'error'">
      <p class="ai-hint">{{ message || 'AI 解析失败' }}</p>
      <button class="ai-retry" type="button" @click="$emit('retry')">重试</button>
    </template>

    <!-- 有标签：点一下就筛资源（再点取消） -->
    <template v-else-if="state === 'ready'">
      <!-- 标签：按类型着色（分辨率 / 编码 / 字幕 / 片源 / 修订版 / 其它），选中即实底。
           只渲染「能区分资源」的那些（all: false）—— 整批一致的当只读特征放在下面 -->
      <div class="ai-chips">
        <button
          v-for="tag in filterableTags"
          :key="tag.name"
          class="ai-chip"
          :class="[`t-${tag.type || 'other'}`, { active: activeNames.includes(tag.name) }]"
          type="button"
          :aria-pressed="activeNames.includes(tag.name)"
          :title="tagTitle(tag)"
          @click="$emit('toggle', tag.name)"
        >
          {{ tag.name }}<span v-if="tag.count" class="chip-count">{{ tag.count }}</span>
        </button>
      </div>

      <!-- 已选条件：同类型 OR、跨类型 AND —— 把筛选逻辑画出来，不用让用户切模式 -->
      <div v-if="activeNames.length" class="sel-bar">
        <span class="sel-inner">
          <template v-for="(group, gi) in selectedGroups" :key="gi">
            <!-- 修订版那组用 PREFER：它是「优选」（同集有修订就用修订，没有的照旧保留），
                 不是「都要满足」——所以不能写成 AND -->
            <span v-if="gi > 0" class="logic" :class="isRevisionGroup(group) ? 'prefer' : 'and'">
              {{ isRevisionGroup(group) ? 'PREFER' : 'AND' }}
            </span>
            <template v-for="(tag, ti) in group" :key="tag.name">
              <span v-if="ti > 0" class="logic or">OR</span>
              <span class="sel-chip" :class="`t-${tag.type || 'other'}`">{{ tag.name }}</span>
            </template>
          </template>
        </span>
        <button class="clear-btn" type="button" @click="$emit('clear')">清除</button>
      </div>

      <!-- 资源类型：单集 / 合集 / 全部 —— **只有这批资源里真有合集时才出现**
           （旧版就是这个条件：没有合集却给「合集」按钮，点下去必然是空的） -->
      <div v-if="hasBatch" class="batch-toggle" role="group" aria-label="资源类型">
        <button
          v-for="opt in BATCH_OPTIONS"
          :key="opt.value"
          class="batch-side"
          :class="{ on: batchFilter === opt.value }"
          type="button"
          :aria-pressed="batchFilter === opt.value"
          @click="$emit('set-batch', opt.value)"
        >
          {{ opt.label }}
        </button>
      </div>
    </template>

    <!-- 已配置，但这批资源解析不出可用标签（整批格式一致 = 没有可筛的差别） -->
    <p v-else class="ai-hint">这批资源格式一致，没有可筛的维度</p>

    <!-- 整体特征：**与 AI 状态无关** —— 规则算的（更新至第 N 话 / 共 N 条）+ AI 标的"整批一致"维度。
         这些都不参与筛选（点了也没得筛），所以只读展示。 -->
    <ul v-if="featureTexts.length" class="ai-info">
      <li v-for="text in featureTexts" :key="text" class="ai-info-item">{{ text }}</li>
    </ul>
  </section>
</template>

<script setup>
import { computed } from 'vue'

/**
 * AI 标签位（位置在字幕组与资源列表之间）
 * ---------------------------------------------------------------------------
 * 为什么在这两级中间：解析对象是**当前字幕组的资源文件名**，产出的标签就是它们的筛选条件
 * （旧版面板也是把标签筛选条放在这个位置）。
 * 纯展示：状态、标签、已选项都由面板通过 useAiTags 给，这里只上抛三个动作。
 *
 * 四种状态刻意分开（别把「未配置」混进「失败」）：
 *   disabled —— 没配 key：告诉人去哪配，并强调资源列表不受影响
 *   loading  —— 解析中（骨架条）
 *   error    —— 真失败（网络/上游/解析不出来）：给重试
 *   ready/idle —— 有标签 / 这批资源没有可用标签
 */
// 接住 props：下面两个 computed 要读它（模板里可直接用 prop 名）
const props = defineProps({
  /** disabled | loading | error | ready | idle */
  state: { type: String, default: 'idle' },
  /** [{ name, type, match[] }] */
  tags: { type: Array, default: () => [] },
  /**
   * 这批资源的整体特征（如「更新至第 07 话」「含 2 个合集包」）。
   * **由规则算出来**（面板调 utils/episode.js 的 releaseHighlights），不是 AI 生成的；
   * 因此它的显示**与 state 无关** —— AI 没配、解析失败、没有可用标签时都要照常显示。
   */
  info: { type: Array, default: () => [] },
  /** 已选标签名 */
  activeNames: { type: Array, default: () => [] },
  /** 资源类型过滤：all | single | batch（与标签维度无关的另一维） */
  batchFilter: { type: String, default: 'all' },
  /**
   * 这批资源里是否存在合集。只有存在时才显示「单集 / 合集」切换 ——
   * 没有合集却摆一个点下去必然为空的按钮，那是假控件（旧版就是按这个条件显示的）。
   */
  hasBatch: { type: Boolean, default: false },
  /** 模型名（ready 时显示在标题旁，方便确认用的是哪个模型） */
  model: { type: String, default: '' },
  /** 失败/特殊提示文案（留空用默认） */
  message: { type: String, default: '' },
})
defineEmits(['toggle', 'clear', 'retry', 'set-batch'])

const BARS = [58, 38, 46]
const BATCH_OPTIONS = [
  { value: 'all', label: '全部' },
  { value: 'single', label: '单集' },
  { value: 'batch', label: '合集' },
]

/** 已选标签按类型分组：组内 OR、组间 AND —— 与真实过滤口径一致（ReleaseList 用同一套语义） */
const selectedGroups = computed(() => {
  const groups = new Map()
  for (const tag of props.tags) {
    if (!props.activeNames.includes(tag.name)) continue
    const key = tag.type || 'other'
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(tag)
  }
  return [...groups.values()]
})

/** 能筛的标签（排除了 AI 标的"整批一致"那些） */
const filterableTags = computed(() => props.tags.filter((tag) => !tag.all))

/**
 * 整块只读特征 = 规则算的（更新至第 N 话 / 共 N 条）+ AI 标的"整批一致"维度
 * 后者是 v5 的产物：像「整批都是 WEB-DL 1080p」这种信息，以前模型按指令直接不返回，
 * 界面上就成了"什么都没识别出来"。现在它照样显示，只是不做成可点筛选项。
 */
const featureTexts = computed(() => [
  ...props.info,
  ...props.tags.filter((tag) => tag.all).map((tag) => tag.name),
])

/**
 * 这一组是不是「修订版」
 * 修订版走的是**优选**语义（同集有修订就用修订、没有的照旧保留），
 * 所以它在已选区里画成 `PREFER`，而不是组间的 `AND` —— 别让人以为"没修订的集会被筛掉"。
 */
const isRevisionGroup = (group) => group.some((tag) => tag.kind === 'revision')

const title = computed(() => (props.state === 'ready' || props.state === 'idle' ? 'AI 标签' : 'AI 解析'))

/**
 * 标签的悬浮说明
 * 修订版那条不是"按文件名匹配"，而是走「修订版优先」规则（同一集保留最高版本），
 * 所以不能拿它去拼 match 写法给人看。
 */
function tagTitle(tag) {
  if (tag.kind === 'revision') return '同一集有修正版时，把原版从列表里去掉（只有原版的集照旧保留）'
  return `按这些写法匹配资源：${(tag.match || []).join(' / ')}`
}

const badge = computed(() => {
  if (props.state === 'disabled') return '未配置'
  if (props.state === 'loading') return '解析中'
  if (props.state === 'ready') return props.model || ''
  return ''
})
</script>

<style scoped>
/* 卡片外壳由外层提供（面板里每个区块统一包卡片），这里只管内部布局 */
.ai-slot {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
/* 未配置：卡内一条虚线块交代状态，不再叠第二层边框 */
.ai-placeholder {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  border: 1px dashed var(--border-strong);
  border-radius: var(--radius-sm);
  background: var(--accent-mist);
}

.ai-head {
  display: flex;
  align-items: center;
  gap: 6px;
}
/* 标题的字号/颜色来自全局 .block-title（与简介 / 字幕组 / 资源列表同一个来源） */
.ai-title {
  min-width: 0;
}
.ai-badge {
  padding: 1px 7px;
  border-radius: var(--radius-pill);
  background: var(--bg-hover);
  color: var(--text-tertiary);
  font-size: 0.66rem;
}
.ai-skeleton {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.ai-bar {
  height: 18px;
  border-radius: var(--radius-pill);
  background: var(--bg-hover);
}

.ai-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.ai-chip {
  padding: 3px 10px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-pill);
  background: var(--bg-card);
  color: var(--tag-color, var(--text-secondary));
  font-size: 0.72rem;
  transition: color var(--dur-fast), border-color var(--dur-fast), background var(--dur-fast);
}
.ai-chip:hover {
  border-color: var(--tag-color, var(--accent));
}
/* 选中态照旧版：**实底该类型色 + 反白字**（一眼看出选没选，不靠浅底硬凑对比） */
.ai-chip.active {
  background: var(--tag-color, var(--accent));
  border-color: var(--tag-color, var(--accent));
  color: var(--text-invert);
  font-weight: 600;
}
/* 标签上的计数（如「修订版 3」）：跟在名字后面，字号小一档不抢戏 */
.chip-count {
  margin-left: 4px;
  font-size: 0.62rem;
  opacity: 0.75;
}
/* 类型色：分辨率蓝 / 编码紫 / 字幕绿 / 片源橙 / 合集青 / 其它灰（令牌在 tokens.css） */
.t-res {
  --tag-color: var(--tag-res);
}
.t-codec {
  --tag-color: var(--tag-codec);
}
.t-sub {
  --tag-color: var(--tag-sub);
}
.t-source {
  --tag-color: var(--tag-source);
}
.t-batch {
  --tag-color: var(--tag-batch);
}
.t-version {
  --tag-color: var(--tag-version);
}
.t-other {
  --tag-color: var(--tag-other);
}

.ai-hint {
  color: var(--text-tertiary);
  font-size: 0.7rem;
  line-height: 1.5;
}

/* ── 信息性特征：只读，样式刻意比标签弱（灰点 + 灰字，不能点也看不出能点） ── */
.ai-info {
  display: flex;
  flex-wrap: wrap;
  gap: 2px 14px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.ai-info-item {
  position: relative;
  padding-left: 11px;
  color: var(--text-tertiary);
  font-size: 0.68rem;
  line-height: 1.6;
}
.ai-info-item::before {
  content: '';
  position: absolute;
  top: 0.62em;
  left: 2px;
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: var(--border-strong);
}

/* ── 已选条件栏：用 AND / OR 连接词把筛选逻辑画出来 ───────────────────────
   语义固定：同类型的标签之间 OR、不同类型之间 AND（与 ReleaseList 的过滤完全一致）。 */
.sel-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--accent-mist);
}
.sel-inner {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  min-width: 0;
}
.logic {
  padding: 1px 5px;
  border-radius: 4px;
  font-size: 0.62rem;
  font-weight: 700;
  letter-spacing: 0.04em;
}
.logic.and {
  background: var(--accent-soft);
  color: var(--accent-strong);
}
/* PREFER：优选（修订版专用），和 AND/OR 区分开色 */
.logic.prefer {
  background: color-mix(in srgb, var(--tag-version) 18%, transparent);
  color: var(--tag-version);
}
.logic.or {
  background: var(--bg-hover);
  color: var(--text-secondary);
}
.sel-chip {
  padding: 1px 8px;
  border-radius: var(--radius-pill);
  background: var(--tag-color, var(--accent));
  color: var(--text-invert);
  font-size: 0.68rem;
  font-weight: 600;
}
.clear-btn {
  flex-shrink: 0;
  margin-left: auto;
  padding: 2px 9px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-pill);
  background: var(--bg-card);
  color: var(--text-secondary);
  font-size: 0.68rem;
}
.clear-btn:hover {
  border-color: var(--accent);
  color: var(--accent);
}

/* ── 资源类型切换：单集 / 合集 / 全部（三段式，与侧栏主题开关同款）───────── */
.batch-toggle {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 2px;
  padding: 2px;
  border: 1px solid var(--border);
  border-radius: var(--radius-pill);
  background: var(--bg-input);
}
.batch-side {
  padding: 3px 8px;
  border-radius: var(--radius-pill);
  color: var(--text-tertiary);
  font-size: 0.7rem;
  line-height: 1.4;
  transition: background var(--dur-fast), color var(--dur-fast);
}
.batch-side:hover {
  color: var(--text-secondary);
}
.batch-side.on {
  background: var(--bg-card);
  color: var(--accent-strong);
  font-weight: 600;
}
.ai-retry {
  align-self: flex-start;
  padding: 4px 12px;
  border-radius: var(--radius-pill);
  background: var(--accent);
  color: var(--text-invert);
  font-size: 0.72rem;
}
.ai-retry:hover {
  background: var(--accent-hover);
}
</style>
