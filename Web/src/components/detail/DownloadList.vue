<template>
  <section class="dl-list">
    <div class="head">
      <h3 class="block-title">已下载</h3>
      <span v-if="state === 'ready'" class="count">{{ items.length }} 个文件</span>
      <span v-if="state === 'ready' && sizeText" class="count">{{ sizeText }}</span>
    </div>

    <Transition name="dl-phase" mode="out-in">
      <StateBlock v-if="state === 'loading'" key="loading" state="loading" text="正在读下载记录…" />
      <StateBlock
        v-else-if="state === 'error'"
        key="error"
        state="error"
        text="下载记录取不到"
        retry-text="重试"
        @retry="$emit('retry')"
      />
      <p v-else-if="state === 'empty'" key="empty" class="empty">还没有已下载的资源</p>

      <ul v-else key="list" class="list">
        <!-- 整行 title 挂着**完整文件名**：平时不占版面，排错时 hover 就能看到 -->
        <li v-for="item in items" :key="item.hash" class="item" :title="item.fileName || item.name">
          <!-- 集数区：与首页资源列表同一套（暖金底 + 斜体衬线 + 56px 竖条） -->
          <span class="ep" :class="{ batch: isBatchEpisode(item.episode), unknown: !item.episode }">
            {{ item.episode || '—' }}
          </span>

          <div class="body">
            <!-- 中间：这集是什么（画质 / 字幕 / 片源，加种时写进 qB 标签，改名也不丢）+ 体积 -->
            <p class="meta">
              <span v-for="tag in item.tags || []" :key="tag" class="tag">{{ tag }}</span>
              <span v-if="item.sizeText" class="num">{{ item.sizeText }}</span>
              <!-- 只有「不在正常态」才说状态：已下载是这一整块的默认状态 -->
              <span v-if="item.kind !== 'done'" class="num" :class="toneOf(item)">{{ item.stateText }}</span>
              <span v-if="item.kind === 'downloading' && item.progress < 100" class="num">{{ item.progress }}%</span>
            </p>

            <div v-if="item.kind === 'downloading'" class="progress-line">
              <span class="progress"><span class="bar" :style="{ width: `${item.progress}%` }" /></span>
              <span v-if="item.speedText" class="speed">{{ item.speedText }}</span>
              <span v-if="etaText(item)" class="eta">{{ etaText(item) }}</span>
            </div>
          </div>

          <!-- 右侧：字幕组（附注，不是分组维度）。名字长了两行截断，hover 看全名 -->
          <span class="subgroup" :title="item.subgroup || '未标注字幕组'">{{ item.subgroup || '未标注字幕组' }}</span>
        </li>
      </ul>
    </Transition>
  </section>
</template>

<script setup>
import StateBlock from '@/components/ui/StateBlock.vue'
import { isBatchEpisode } from '@/utils/episode'

/**
 * 已下载列表（面板「资源」区第二级 —— 下载页模式）
 * ---------------------------------------------------------------------------
 * 一条 = 左侧集数竖条（与 `ReleaseList` 完全同一套样式）+ 中间「这集是什么」+ 右侧字幕组。
 *
 * 为什么不按字幕组分成几段（之前那样）：
 *   一部番往往只有 1~2 个组在活动，分组后大半的组只有 1 条 —— 得点两下才看得到；
 *   用户要看的是「我下到第几集了」，组名是**附注**（右侧一行小字），不是分类维度。
 *   顶部那排 chip 仍然保留，但语义从「切换数据源」变成「筛选这份清单」。
 *
 * 一行只留三件事：① 第几集 ② 画质/字幕/体积 ③ 是谁压的（右侧）。
 * 完整文件名挂在整行的 `title` 上；**保存路径不显示**（排错信息，去 qB 或文件管理器看）。
 *
 * 画质/字幕/片源来自**后端**：加种时就写进 qB 标签（`res:` / `sub:` / `src:`），
 * 改名之后也还在；老种子没有这些标签，后端会用文件名兜底解析（认不出就是空）。
 */
defineProps({
  /** [{ hash, name, fileName, episode, subgroup, tags, sizeText, stateText, kind, progress, speedText, eta }] */
  items: { type: Array, default: () => [] },
  /** loading | error | empty | ready */
  state: { type: String, default: 'loading' },
  /** 当前视图的总体积（面板算好，显示在标题右边） */
  sizeText: { type: String, default: '' },
})
defineEmits(['retry'])

/** 状态配色：下载中=强调色，异常=警示 */
const toneOf = (item) => (item.kind === 'downloading' ? 'on' : 'bad')

/**
 * 剩余时间：qB 的 `eta` 是秒，`8640000` 表示「算不出来」（没有可用源 / 已暂停）。
 * 超过 24 小时也只写「>1 天」—— 精确到分钟在这里没有意义。
 */
function etaText(item) {
  const sec = Number(item.eta) || 0
  if (item.kind !== 'downloading' || sec <= 0 || sec >= 8640000) return ''
  if (sec >= 86400) return '剩 >1 天'
  if (sec >= 3600) return `剩 ${Math.round(sec / 3600)} 小时`
  return `剩 ${Math.max(1, Math.round(sec / 60))} 分`
}
</script>

<style scoped>
.dl-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.head {
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.count {
  color: var(--text-tertiary);
  font-size: 0.72rem;
}
.empty {
  padding: 4px 0;
  color: var(--text-tertiary);
  font-size: 0.78rem;
}

/* ── 列表：集数竖条（56px）｜这集是什么｜字幕组（右侧固定窄列）────────────── */
.list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.item {
  display: grid;
  grid-template-columns: 56px minmax(0, 1fr) auto;
  min-height: 52px;
  overflow: hidden; /* 集数区要贴到卡片边，圆角靠这一层裁 */
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-input);
}

/* ── 集数区：**照搬首页资源列表**（暖金底 + 右侧分隔线 + 斜体衬线 1.55rem）────
   两块在同一个位置互相替代，字号与底色必须一致，否则切页面会「抖一下」。 */
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

.body {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
  padding: 9px 10px;
  justify-content: center;
}

.meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 8px;
  margin: 0;
  color: var(--text-tertiary);
  font-size: 0.7rem;
}
.meta .tag {
  padding: 1px 6px;
  border-radius: var(--radius-pill);
  background: var(--bg-hover);
  color: var(--text-secondary);
  font-size: 0.68rem;
  line-height: 1.5;
}
.meta .num.on {
  color: var(--accent);
}
.meta .num.bad {
  color: var(--danger);
}

/* ── 右侧：字幕组 ───────────────────────────────────────────────────────
   定宽 + 两行截断：名字长短不一（「爱恋字幕社漫猫字幕组」），
   不封住宽度会把中间那列挤成一条缝。 */
.subgroup {
  align-self: center;
  max-width: 88px;
  padding: 0 10px 0 0;
  color: var(--text-tertiary);
  font-size: 0.68rem;
  line-height: 1.4;
  text-align: right;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  overflow-wrap: anywhere;
}

/* 下载中：进度条 + 速度 / 剩余（已完成不渲染这一行） */
.progress-line {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--text-tertiary);
  font-size: 0.68rem;
}
.progress {
  flex: 1;
  min-width: 0;
  height: 4px;
  border-radius: var(--radius-pill);
  background: var(--bg-hover);
  overflow: hidden;
}
.bar {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: var(--accent);
  transition: width var(--dur-fast);
}
.speed {
  flex-shrink: 0;
  color: var(--accent);
}
.eta {
  flex-shrink: 0;
}

.dl-phase-enter-active,
.dl-phase-leave-active {
  transition: opacity var(--dur-fast);
}
.dl-phase-enter-from,
.dl-phase-leave-to {
  opacity: 0;
}
</style>
