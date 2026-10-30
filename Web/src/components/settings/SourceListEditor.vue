<template>
  <div class="src-list">
    <p v-if="!items.length" class="src-empty">还没有地址 —— 点下面的「添加一行」</p>

    <TransitionGroup v-else name="row" tag="div" class="src-rows">
      <div
        v-for="(url, index) in items"
        :key="`${index}-${url}`"
        class="src-row"
        :class="{ dragging: dragIndex === index, over: overIndex === index && dragIndex !== index }"
        draggable="true"
        @dragstart="onDragStart(index, $event)"
        @dragover="onDragOver(index, $event)"
        @drop.prevent="onDrop(index)"
        @dragend="reset"
      >
        <button
          class="src-handle"
          type="button"
          :title="`拖动排序（第 ${index + 1} 个）`"
          :aria-label="`拖动排序，第 ${index + 1} 个`"
          @click.prevent
        >
          <IconGripVertical :size="14" />
        </button>

        <input
          class="src-input"
          type="text"
          spellcheck="false"
          :value="url"
          :placeholder="index === 0 ? 'https://…（第一个优先用）' : 'https://…（备用）'"
          @input="edit(index, $event.target.value)"
        />

        <!-- 单独测这一条：坏掉的地址能立刻定位到 -->
        <button
          class="src-btn"
          :class="stateOf(url)"
          type="button"
          :title="detailOf(url) || '测试这一条'"
          :disabled="!url || stateOf(url) === 'testing'"
          @click="$emit('test-row', url)"
        >
          <span v-if="stateOf(url) === 'testing'" class="mini-spinner" />
          <IconCircleCheck v-else-if="stateOf(url) === 'success'" :size="15" />
          <IconCircleX v-else-if="stateOf(url) === 'error'" :size="15" />
          <IconPlugConnected v-else :size="15" />
        </button>

        <button class="src-btn" type="button" :disabled="index === 0" title="上移" @click="move(index, -1)">
          <IconArrowUp :size="14" />
        </button>
        <button
          class="src-btn"
          type="button"
          :disabled="index === items.length - 1"
          title="下移"
          @click="move(index, 1)"
        >
          <IconArrowDown :size="14" />
        </button>
        <button class="src-btn danger" type="button" title="删除这一行" @click="remove(index)">
          <IconX :size="14" />
        </button>
      </div>
    </TransitionGroup>

    <div class="src-foot">
      <button class="src-add" type="button" @click="add">
        <IconPlus :size="14" />
        添加一行
      </button>
      <button class="src-test-all" type="button" :disabled="!items.length" @click="$emit('test-all')">
        测试全部
      </button>
      <span class="src-hint">拖动手柄可调整顺序，排在前面的优先使用</span>
    </div>
  </div>
</template>

<script setup>
/**
 * 多源地址编辑器（Mikan / Bangumi 的多个入口）
 * ---------------------------------------------------------------------------
 * 为什么不是一个多行文本框：
 *   · 这些地址是**有序候选**（排在前面的先用），顺序本身是配置内容 → 必须能拖、能上下移；
 *   · 每一条都可能独自坏掉 → 要能**单独测**，也要能一键全测（否则只能猜是谁的问题）；
 *   · 增删要像列表，而不是"在一段文本里多敲一个换行"。
 * 对外只暴露一个东西：`update(array)` —— 由 FieldControl 拼成 `\n` 文本交给后端。
 */
import { ref } from 'vue'
import {
  IconArrowDown,
  IconArrowUp,
  IconCircleCheck,
  IconCircleX,
  IconGripVertical,
  IconPlugConnected,
  IconPlus,
  IconX,
} from '@tabler/icons-vue'

const props = defineProps({
  /** 地址数组（空串表示刚添加、还没填） */
  items: { type: Array, default: () => [] },
  /** url → { state: 'idle'|'testing'|'success'|'error', detail: string } */
  tests: { type: Object, default: () => ({}) },
})
const emit = defineEmits(['update', 'test-row', 'test-all'])

const dragIndex = ref(-1)
const overIndex = ref(-1)

const stateOf = (url) => props.tests?.[url]?.state || 'idle'
const detailOf = (url) => props.tests?.[url]?.detail || ''

function edit(index, value) {
  const next = [...props.items]
  next[index] = value
  emit('update', next)
}
const add = () => emit('update', [...props.items, ''])
const remove = (index) => emit('update', props.items.filter((_, i) => i !== index))

function move(index, delta) {
  const to = index + delta
  if (to < 0 || to >= props.items.length) return
  const next = [...props.items]
  const [moved] = next.splice(index, 1)
  next.splice(to, 0, moved)
  emit('update', next)
}

function onDragStart(index, event) {
  dragIndex.value = index
  event.dataTransfer.effectAllowed = 'move'
  try {
    event.dataTransfer.setData('text/plain', String(index))
  } catch {
    /* 某些浏览器禁止写剪贴板：拖拽本身仍可用（我们用 index） */
  }
}
function onDragOver(index, event) {
  event.preventDefault()
  event.dataTransfer.dropEffect = 'move'
  overIndex.value = index
}
function onDrop(index) {
  const from = dragIndex.value
  reset()
  if (from < 0 || from === index) return
  const next = [...props.items]
  const [moved] = next.splice(from, 1)
  next.splice(index, 0, moved)
  emit('update', next)
}
function reset() {
  dragIndex.value = -1
  overIndex.value = -1
}
</script>

<style scoped>
.src-list {
  width: 100%;
  padding: 6px 0 2px;
}
.src-empty {
  padding: 6px 9px 10px;
  color: var(--text-tertiary);
  font-size: 0.76rem;
}
.src-rows {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.src-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap; /* 窄格子里按钮换行，而不是把输入框挤没 */
  gap: 4px;
  padding: 3px 4px;
  border-radius: var(--radius-sm);
  background: var(--bg-hover);
  transition: background var(--dur-fast), opacity var(--dur-fast);
}
.src-row.dragging {
  opacity: 0.45;
}
.src-row.over {
  outline: 1px dashed var(--accent);
  outline-offset: -1px;
}
.src-handle {
  display: flex;
  align-items: center;
  padding: 2px;
  color: var(--text-tertiary);
  cursor: grab;
}
.src-handle:active {
  cursor: grabbing;
}
.src-input {
  flex: 1 1 140px;
  min-width: 0;
  padding: 5px 6px;
  border: 0;
  background: transparent;
  color: var(--text-primary);
  font-family: var(--font-mono);
  font-size: 0.76rem;
}
.src-input:focus-visible {
  outline: none;
}
.src-input::placeholder {
  color: var(--text-tertiary);
}
.src-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 24px;
  border-radius: var(--radius-sm);
  color: var(--text-tertiary);
  transition: color var(--dur-fast), background var(--dur-fast);
}
.src-btn:hover:not(:disabled) {
  background: var(--bg-dropdown);
  color: var(--accent);
}
.src-btn:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}
.src-btn.success {
  color: var(--success, #3fb950);
}
.src-btn.error {
  color: var(--danger, #f85149);
}
.src-btn.danger:hover:not(:disabled) {
  color: var(--danger, #f85149);
}
.src-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 4px 2px;
}
.src-add,
.src-test-all {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 9px;
  border-radius: var(--radius-sm);
  background: var(--bg-dropdown);
  color: var(--text-secondary);
  font-size: 0.74rem;
}
.src-add:hover,
.src-test-all:hover:not(:disabled) {
  color: var(--accent);
}
.src-test-all:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.src-hint {
  color: var(--text-tertiary);
  font-size: 0.7rem;
}
/* 增删 / 换位时的过渡：列表不会"闪一下" */
.row-enter-active,
.row-leave-active,
.row-move {
  transition: transform var(--dur-fast), opacity var(--dur-fast);
}
.row-enter-from,
.row-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}
</style>
