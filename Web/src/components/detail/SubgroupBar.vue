<template>
  <section class="subgroups">
    <div class="head">
      <h3 class="block-title">字幕组</h3>
      <span v-if="state === 'ready'" class="count">{{ subgroups.length }} 个</span>
    </div>

    <StateBlock v-if="state === 'loading'" state="loading" text="正在取字幕组…" />
    <StateBlock
      v-else-if="state === 'error'"
      state="error"
      text="字幕组没取到"
      retry-text="重试"
      @retry="$emit('retry')"
    />
    <p v-else-if="state === 'empty'" class="empty">这部剧还没有字幕组资源</p>

    <!-- 全部字幕组直接铺开（换行），不做横向滚动：
         横滑会把「一共多少组」藏起来，而选组本来就是先看全量再挑 -->
    <div v-else class="chips">
      <button
        v-for="sg in subgroups"
        :key="sg.id"
        class="chip"
        :class="{ active: sg.id === activeId }"
        type="button"
        :aria-pressed="sg.id === activeId"
        @click="$emit('select', sg.id)"
      >
        {{ sg.name }}
      </button>
    </div>
  </section>
</template>

<script setup>
import StateBlock from '@/components/ui/StateBlock.vue'

/**
 * 字幕组选择条（面板「资源」区第一级）
 * 纯展示：列表、选中项、三态都由面板给，这里只上抛「选了哪个」与「重试」。
 */
defineProps({
  /** [{ id, name, mikanId, rssId }] */
  subgroups: { type: Array, default: () => [] },
  /**
   * 当前选中的字幕组 id。
   * 数字 = Mikan 详情页给的 **该作品下的 rss id**；字符串 = 详情页 404 时由组标记得出的**组名**
   * （两种都要能选中，所以类型是 Number | String）
   */
  activeId: { type: [Number, String], default: null },
  /** loading | error | empty | ready */
  state: { type: String, default: 'loading' },
})
defineEmits(['select', 'retry'])
</script>

<style scoped>
.subgroups {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.head {
  display: flex;
  align-items: baseline;
  gap: 8px;
}
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

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
/* 每个字幕组是一个明确的「框」：卡片底 + 较深的描边（浅底上的 --border 几乎看不见） */
.chip {
  display: inline-flex;
  align-items: center;
  min-height: 30px;
  max-width: 100%;
  padding: 0 12px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-pill);
  background: var(--bg-card);
  color: var(--text-secondary);
  font-size: 0.75rem;
  line-height: 1;
  /* 名字完整显示：长名字（如「爱恋字幕社漫猫字幕组」）换行，不截断 ——
     截断后两组看起来一样，选错还得回来找 */
  white-space: normal;
  overflow-wrap: anywhere;
  text-align: left;
  transition: color var(--dur-fast), border-color var(--dur-fast), background var(--dur-fast);
}
.chip:hover {
  border-color: var(--accent);
  color: var(--accent);
}
/* 选中只用一个主信号：实底 + 反白（与标签 chip 选中同一套语言）。
   原来描边 + 浅底 + 强调字色 + 字重四样一起上，同一个意思画了四遍。 */
.chip.active {
  border-color: var(--accent);
  background: var(--accent);
  color: var(--text-invert);
  font-weight: 600;
}
</style>
