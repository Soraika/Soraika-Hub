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
      <p v-else-if="state === 'empty'" key="empty" class="empty">这个字幕组还没有已下载的资源</p>

      <ul v-else key="list" class="list">
        <li v-for="item in items" :key="item.hash" class="item">
          <!-- 集数区与资源列表同一套（56px 竖条 + 斜体数字）：两边切着看时位置不跳 -->
          <span class="ep" :class="{ batch: isBatchEpisode(item.episode), unknown: !item.episode }">
            {{ item.episode || '—' }}
          </span>

          <div class="body">
            <p class="title" :title="item.fileName || item.name">{{ item.fileName || item.name }}</p>

            <p class="meta">
              <span class="num">{{ item.sizeText }}</span>
              <span class="num" :class="stateTone(item.kind)">{{ item.stateText }}</span>
              <span v-if="item.kind === 'downloading'" class="num">{{ item.progress }}%</span>
              <span v-else-if="item.season" class="num">第 {{ item.season }} 季</span>
            </p>

            <!-- 下载中的给一条进度：已完成的不画空条（空条=噪音） -->
            <div v-if="item.kind === 'downloading'" class="progress" :title="`${item.progress}%`">
              <span class="bar" :style="{ width: `${item.progress}%` }" />
            </div>

            <!-- 路径默认不展开：这是排错信息，不是日常要读的内容 -->
            <p class="path" :title="item.contentPath || item.savePath">{{ item.savePath }}</p>
          </div>
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
 * 与 `ReleaseList` 刻意保持同样的骨架（集数竖条 + 标题 + 元信息行），因为这两块
 * 在同一个面板位置互相替代：结构一致，切换页面时眼睛不用重新找位置。
 *
 * 但它**不是** ReleaseList 的变体：那边是「还没下的资源」（可勾选、可复制磁力、可加种），
 * 这边是「盘上已有的文件」（只读：体积 / 状态 / 进度 / 路径）。硬塞进一个组件只会
 * 让两边都长出一堆 `v-if`。
 */
defineProps({
  /** [{ hash, name, fileName, episode, season, sizeText, stateText, kind, progress, savePath, contentPath }] */
  items: { type: Array, default: () => [] },
  /** loading | error | empty | ready */
  state: { type: String, default: 'loading' },
  /** 当前组的总体积（面板算好，显示在标题右边） */
  sizeText: { type: String, default: '' },
})
defineEmits(['retry'])

/** 状态配色：下载中=强调色，已完成=弱化，异常=警示 */
const stateTone = (kind) => (kind === 'downloading' ? 'on' : kind === 'done' ? 'ok' : 'bad')
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

.list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.item {
  display: flex;
  gap: 10px;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-card);
}

/* 集数竖条：与 ReleaseList 的 .ep 数值一致（56px / 斜体衬线），换了组件也不跳 */
.ep {
  flex: 0 0 56px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  align-self: flex-start;
  min-height: 30px;
  border-radius: var(--radius-sm);
  background: var(--bg-hover);
  color: var(--text-secondary);
  font-family: var(--font-mono);
  font-size: 0.86rem;
  font-style: italic;
  font-weight: 700;
  letter-spacing: 0.02em;
}
.ep.batch {
  font-size: 0.7rem;
  font-style: normal;
}
.ep.unknown {
  color: var(--text-tertiary);
}

.body {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
  flex: 1;
}
.title {
  margin: 0;
  color: var(--text-primary);
  font-size: 0.78rem;
  line-height: 1.4;
  /* 长文件名两行截断：这里是「知道是哪一集」就够，完整名字 hover 看 title */
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  overflow-wrap: anywhere;
}
.meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 0;
  font-size: 0.72rem;
  color: var(--text-tertiary);
}
.meta .ok {
  color: var(--text-secondary);
}
.meta .on {
  color: var(--accent);
}
.meta .bad {
  color: var(--danger);
}

.progress {
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

.path {
  margin: 0;
  color: var(--text-tertiary);
  font-size: 0.68rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  direction: rtl; /* 路径太长时**省略中间**，保住的尾部才是文件名 */
  text-align: left;
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
