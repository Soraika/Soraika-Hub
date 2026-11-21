<template>
  <article
    class="poster-card"
    :class="{ clickable, selected }"
    :tabindex="clickable ? 0 : undefined"
    :role="clickable ? 'button' : undefined"
    @click="onClick"
    @keydown.enter.prevent="onClick"
    @keydown.space.prevent="onClick"
  >
    <!-- ── 顶部信息条：左徽标 / 右评分 ──────────────────────────────────
         信息条在海报之上独立成行，任何标签都不覆盖海报本体 -->
    <div v-if="hasTopbar" class="card-topbar">
      <slot name="badge">
        <span v-if="badge" class="badge" :class="`tone-${badgeTone}`">
          <component v-if="badgeIcon" :is="badgeIcon" :size="12" :stroke-width="2.4" />
          {{ badge }}
        </span>
      </slot>

      <slot name="rating">
        <div v-if="showRating && (scoreText || (score !== null && score !== ''))" class="rating">
          <span class="rating-score" :class="{ weak: !scoreStrong }">
            <IconStarFilled :size="13" />
            {{ scoreText || score }}
          </span>
          <span v-if="ratingText" class="rating-total">{{ ratingText }}</span>
        </div>

        <!-- 评分还没有（后台正在补档 / 上游确实没评分）→ **不空着**：
             占住评分位给一个脉冲占位，分数一到原位替换。
             高度与 .rating-score 一致 + .card-topbar 的 min-height 兜底，卡片不会抖一下。 -->
        <span v-else-if="showRating" class="rating rating-pending" title="评分待补（后台正在补档，补到就显示）">
          <span class="pending-bar" />
        </span>
      </slot>
    </div>

    <!-- ── 海报 ─────────────────────────────────────────────────────── -->
    <PosterImage
      class="card-poster"
      :src="poster"
      :fallbacks="posterFallbacks"
      :alt="title"
      :ratio="posterRatio"
      :placeholder-text="posterPlaceholder"
    />

    <!-- ── 文字信息 ─────────────────────────────────────────────────── -->
    <div class="card-info">
      <span class="card-name ellipsis" :title="title">{{ title }}</span>

      <div v-if="metaText || linkUrl" class="card-meta">
        <span class="card-meta-text ellipsis">{{ metaText }}</span>
        <a
          v-if="linkUrl"
          class="card-link"
          :href="linkUrl"
          target="_blank"
          rel="noopener noreferrer"
          :title="linkTitle"
          @click.stop
        >
          <IconExternalLink :size="14" :stroke-width="2" />
        </a>
      </div>

      <!-- 卡片内操作区（订阅/播放/下载等由使用方塞入，不写死逻辑） -->
      <div v-if="$slots.actions" class="card-actions" @click.stop>
        <slot name="actions" />
      </div>
    </div>

    <!-- 卡片底部扩展区（如进度条、标签行），默认不渲染 -->
    <div v-if="$slots.footer" class="card-footer">
      <slot name="footer" />
    </div>
  </article>
</template>

<script setup>
import { computed, useSlots } from 'vue'
import { IconStarFilled, IconExternalLink } from '@tabler/icons-vue'
import PosterImage from './PosterImage.vue'

/**
 * 番剧海报卡（全站复用主卡）
 * 结构：顶部信息条（徽标 | 评分人数）→ 干净海报 → 标题 + 年份·题材
 * 纯展示：不请求数据、不做格式化；文案由使用方以「成品字符串」传入。
 */
const props = defineProps({
  /** 番名 */
  title: { type: String, required: true },
  /** 海报图地址（占位阶段可为空，空则显示占位底纹） */
  poster: { type: String, default: '' },
  /** 主图挂了时按顺序试的备选地址（后端給的降级链：镜像域名 → 代理） */
  posterFallbacks: { type: Array, default: () => [] },
  /** 海报宽高比 */
  posterRatio: { type: String, default: '3 / 4' },
  /** 海报占位提示文字 */
  posterPlaceholder: { type: String, default: '' },
  /** 左上徽标文案（首页=星期，发现=模块名，订阅/下载可留空） */
  badge: { type: String, default: '' },
  /** 徽标配色：week | praise | hot | try | popular | neutral */
  badgeTone: { type: String, default: 'week' },
  /** 徽标内的小图标（可选，如日历/火焰） */
  badgeIcon: { type: [Object, Function], default: null },
  /** 评分（数字或已格式化字符串；传 null / '' 则不显示） */
  score: { type: [Number, String], default: null },
  /** 评分成品字符串（后端给，固定一位小数，如「8.0」）；有它就优先用它显示 */
  scoreText: { type: String, default: '' },
  /** 评分人数等说明（成品字符串，如「1.2万人评分」） */
  ratingText: { type: String, default: '' },
  /** 是否显示评分区（首页可按需关闭） */
  showRating: { type: Boolean, default: true },
  /** 底部信息行（成品字符串，如「2026 · 奇幻 日常」） */
  metaText: { type: String, default: '' },
  /** 外链地址（如 BGM 条目） */
  linkUrl: { type: String, default: '' },
  /** 外链悬浮说明 */
  linkTitle: { type: String, default: '查看外部条目' },
  /** 可点击（默认 true；纯展示列表可关闭） */
  clickable: { type: Boolean, default: true },
  /** 选中态描边（发现页模块切换 / 详情联动） */
  selected: { type: Boolean, default: false },
})

const emit = defineEmits(['click'])
const slots = useSlots()

function onClick() {
  if (props.clickable) emit('click')
}

// 顶部信息条：左徽标、右评分有任一内容就渲染，都没有则整条不占位。
// **「评分待补」也算有内容** —— 否则分数一到位整条信息条才出现，卡片会跳一下。
const hasTopbar = computed(
  () => Boolean(props.badge || slots.badge) || Boolean(slots.rating) || props.showRating,
)

// 仅视觉分级（≥7 分加重），不参与任何业务判断
const scoreStrong = computed(() => Number(props.score) >= 7)
</script>

<style scoped>
.poster-card {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 8px;
  border: 1px solid var(--border-on-card);
  border-radius: var(--radius);
  background: var(--bg-card);
  box-shadow: var(--shadow-sm);
  transition: transform var(--dur) var(--ease-out), box-shadow var(--dur) var(--ease-out),
    border-color var(--dur) var(--ease-out);
}
.poster-card.clickable {
  cursor: pointer;
}
.poster-card.clickable:hover {
  transform: translateY(-4px);
  box-shadow: var(--shadow);
}
.poster-card.clickable:hover .card-poster :deep(.poster-img) {
  transform: scale(1.05);
}
.poster-card.selected {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-soft), var(--shadow-sm);
}

/* ── 顶部信息条 ───────────────────────────────────────────────────────── */
.card-topbar {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 22px;
}

.badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 9px;
  border-radius: var(--radius-pill);
  background: var(--mod-praise);
  color: var(--badge-ink);
  font-size: 0.72rem;
  font-weight: 600;
  letter-spacing: 0.02em;
  white-space: nowrap;
}
.tone-week {
  background: var(--mod-praise);
}
.tone-praise {
  background: var(--mod-praise);
}
.tone-hot {
  background: var(--mod-hot);
}
.tone-try {
  background: var(--mod-try);
}
.tone-popular {
  background: var(--mod-popular);
}
.tone-neutral {
  background: var(--badge-neutral-bg);
  color: var(--badge-neutral-ink);   /* 中性徽标是薄底，浅/深两套各配一次（见 tokens.css） */
}

/* 评分块：撑满「剩余宽度」，内部再两端分开 ——
   不带徽标时它就是行内唯一子元素，于是「分数贴左边框 / 人数贴右边框」；
   带徽标时徽标占左，分数紧贴徽标右缘、人数仍贴右边框。一套规则覆盖两种形态。 */
.rating {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;              /* 星星与文字同一中轴（原来 baseline 配内部 center，是歪的） */
  justify-content: space-between;
  gap: 8px;
}
.rating-score {
  display: inline-flex;
  align-items: center;
  flex-shrink: 0;                   /* 分数永不被压缩（要压缩宁可压人数） */
  gap: 4px;
  color: var(--text-on-card);
  font-family: var(--font-mono);    /* 等宽数字：网格里各张卡的分数上下对齐 */
  font-size: 0.76rem;               /* 与人数同字号，层次只交给字重 */
  font-weight: 700;
  line-height: 1;
}
.rating-score svg {
  color: var(--mod-hot-strong);     /* 浅 3.85:1 / 深 6.37:1（--mod-hot 分别只有 2.26 / 5.09） */
}
.rating-score.weak {
  color: var(--text-on-card-muted);
}

/* ── 评分待补（库里还没有分数：后台正在补档 / 上游确实没评分）────────────────
   占住评分位（左对齐，和 .rating-score 同位同高），分数一到原位替换 —— 卡片不会抖。 */
.rating-pending {
  justify-content: flex-start;
}
.pending-bar {
  width: 34px;
  height: 10px;
  border-radius: var(--radius-pill);
  /* 骨架条的经典做法：底色 + 一条更亮的高光在 400% 宽的背景上平移 */
  background: linear-gradient(90deg, var(--bg-hover) 25%, var(--border) 37%, var(--bg-hover) 63%);
  background-size: 400% 100%;
  animation: pending-shimmer 1.4s ease-in-out infinite;
}
@keyframes pending-shimmer {
  from {
    background-position: 100% 50%;
  }
  to {
    background-position: 0 50%;
  }
}
.rating-total {
  min-width: 0;
  color: var(--text-on-card-muted);
  font-size: 0.76rem;
  line-height: 1;
  white-space: nowrap;              /* 关键：宽度不够时它原本会折成两行，看着就「上下不对齐」 */
  overflow: hidden;
  text-overflow: ellipsis;          /* 极限窄时才省略号兜底 */
}

/* ── 海报 ─────────────────────────────────────────────────────────────── */
.card-poster {
  border-radius: var(--radius-sm);
  overflow: hidden;
}

/* ── 文字信息 ─────────────────────────────────────────────────────────── */
.card-info {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  padding: 0 2px;
}
.card-name {
  color: var(--text-on-card);
  font-size: 0.86rem;
  font-weight: 600;
  line-height: 1.35;
}
.card-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 16px;
}
.card-meta-text {
  min-width: 0;
  color: var(--text-on-card-muted);
  font-size: 0.74rem;
}
.card-link {
  display: inline-flex;
  margin-left: auto;
  color: var(--text-on-card-muted);
  transition: color var(--dur-fast);
}
.card-link:hover {
  color: var(--mod-popular);
}
.card-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  padding-top: 2px;
}
.card-footer {
  padding: 6px 2px 2px;
  border-top: 1px solid var(--border-on-card);
}
</style>
