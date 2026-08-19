<template>
  <div v-if="allTags.length > 0" class="tag-filter-bar">
    <!-- 标签 chips -->
    <div class="tag-chips">
      <button
        v-for="t in allTags"
        :key="t.value"
        class="tag-chip"
        :class="{ active: selectedTags.has(t.value), ['c-' + t.type]: true }"
        @click="$emit('toggleTag', t.value)"
      >{{ t.value }}</button>
    </div>

    <!-- 选中反馈栏 -->
    <Transition name="fade">
      <div v-if="selectedTags.size > 0" class="selected-bar">
        <span class="selected-label">
          <TransitionGroup name="chip-pop" tag="span" class="sel-inner">
            <template v-for="(g, gi) in groupedSelected" :key="'g' + gi">
              <span v-if="gi > 0" class="logic-and">AND</span>
              <span class="group-wrap">
                <template v-for="(tag, ti) in g" :key="tag.value">
                  <span v-if="ti > 0" class="logic-or">OR</span>
                  <span class="sel-chip" :class="'c-' + tag.type">{{ tag.value }}</span>
                </template>
              </span>
            </template>
          </TransitionGroup>
        </span>
        <button class="clear-btn" @click="$emit('clearTags')">清除筛选</button>
      </div>
    </Transition>

    <!-- 单集/合集切换 -->
    <div v-if="hasBatchTags" class="batch-toggle">
      <button
        v-for="opt in batchOptions"
        :key="opt.value"
        :class="{ active: batchFilter === opt.value }"
        @click="$emit('batchChange', opt.value)"
      >{{ opt.label }}</button>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  allTags: { type: Array, default: () => [] },
  selectedTags: { type: Set, default: () => new Set() },
  hasBatchTags: { type: Boolean, default: false },
  batchFilter: { type: String, default: 'all' },
})

defineEmits(['toggleTag', 'clearTags', 'batchChange'])

const batchOptions = [
  { value: 'all', label: '全部' },
  { value: 'single', label: '单集' },
  { value: 'batch', label: '合集' },
]

// 按类型分组显示 AND/OR
const groupedSelected = computed(() => {
  if (props.selectedTags.size === 0) return []
  const map = {}
  for (const t of props.selectedTags) {
    const info = props.allTags.find(a => a.value === t)
    const type = info?.type || 'other'
    ;(map[type] ??= []).push({ value: t, type })
  }
  return Object.values(map)
})
</script>

<style scoped>
.tag-filter-bar { margin-bottom: 14px; width: 100%; }

.tag-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.tag-chip {
  padding: 3px 9px; border-radius: 10px; border: 1px solid var(--border);
  background: var(--bg-input); font-size: 0.74rem; cursor: pointer;
  transition: all 0.15s; color: var(--text-secondary); user-select: none;
}
.tag-chip:active { transform: scale(0.92); }
.tag-chip.active.c-res { background: #3b82f6; color: #fff; border-color: #3b82f6; }
.tag-chip.active.c-codec { background: #8b5cf6; color: #fff; border-color: #8b5cf6; }
.tag-chip.active.c-sub { background: #22c55e; color: #fff; border-color: #22c55e; }
.tag-chip.active.c-source { background: #f97316; color: #fff; border-color: #f97316; }
.tag-chip.active.c-batch { background: #14b8a6; color: #fff; border-color: #14b8a6; }
.tag-chip.active.c-other { background: #6b7280; color: #fff; border-color: #6b7280; }

.tag-chip.c-res { color: #3b82f6; }
.tag-chip.c-codec { color: #8b5cf6; }
.tag-chip.c-sub { color: #22c55e; }
.tag-chip.c-source { color: #f97316; }
.tag-chip.c-batch { color: #14b8a6; }
.tag-chip.c-other { color: #9ca3af; }

/* 选中状态栏 */
.selected-bar {
  display: flex; align-items: center; justify-content: space-between;
  margin-top: 10px; padding: 6px 10px;
  border-radius: 8px; background: var(--bg-input-added, rgba(34,197,94,0.08));
  border: 1px solid rgba(34,197,94,0.2);
}
.selected-label { font-size: 0.74rem; color: var(--text-secondary); flex: 1; overflow: hidden; min-width: 0; }
.sel-inner { display: inline-flex; align-items: center; gap: 4px; flex-wrap: wrap; }
.logic-and, .logic-or {
  font-size: 0.73rem; font-weight: 600; padding: 1px 5px; border-radius: 4px;
  letter-spacing: 0.3px; flex-shrink: 0;
}
.logic-and { background: rgba(59,130,246,0.15); color: #3b82f6; }
.logic-or { background: rgba(34,197,94,0.15); color: #22c55e; }
.group-wrap { display: flex; align-items: center; gap: 2px; }
.sel-chip {
  font-size: 0.73rem; padding: 2px 7px; border-radius: 6px; white-space: nowrap;
  border: 1px solid transparent; font-weight: 500;
}
.sel-chip.c-res { background: #3b82f6; color: #fff; }
.sel-chip.c-codec { background: #8b5cf6; color: #fff; }
.sel-chip.c-sub { background: #22c55e; color: #fff; }
.sel-chip.c-source { background: #f97316; color: #fff; }
.sel-chip.c-batch { background: #14b8a6; color: #fff; }
.sel-chip.c-other { background: #6b7280; color: #fff; }

.clear-btn {
  flex-shrink: 0; margin-left: 8px; padding: 2px 8px; border-radius: 6px;
  border: 1px solid var(--border); background: var(--bg-card);
  color: var(--text-secondary); font-size: 0.72rem; cursor: pointer; transition: 0.15s;
}
.clear-btn:hover { border-color: var(--accent); color: var(--accent); }

/* 单集/合集切换 */
.batch-toggle {
  display: flex; gap: 2px; margin-top: 10px;
  background: var(--bg-input); border-radius: 8px; padding: 2px; border: 1px solid var(--border);
  width: 100%;
}
.batch-toggle button {
  flex: 1; padding: 4px 8px; border-radius: 6px; border: none;
  background: transparent; color: var(--text-tertiary); font-size: 0.72rem;
  cursor: pointer; transition: all 0.15s;
}
.batch-toggle button.active { background: var(--bg-card); color: var(--accent); font-weight: 600; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
.batch-toggle button:hover:not(.active) { color: var(--text-secondary); }

/* 动画 */
.chip-pop-enter-active { transition: all 0.25s cubic-bezier(0.34,1.56,0.64,1); }
.chip-pop-leave-active { transition: all 0.15s ease-in; }
.chip-pop-enter-from { opacity: 0; transform: scale(0.6); }
.chip-pop-leave-to { opacity: 0; transform: scale(0.6); }

.fade-enter-active, .fade-leave-active { transition: opacity 0.2s ease; }
.fade-enter-from, .fade-leave-to { opacity: 0; }
</style>