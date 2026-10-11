<template>
  <div class="search-box" :class="{ compact, disabled }">
    <IconSearch class="search-icon" :size="iconSize" :stroke-width="2.2" />

    <input
      class="search-input"
      type="text"
      :value="modelValue"
      :placeholder="placeholder"
      :disabled="disabled"
      :aria-label="placeholder"
      @input="$emit('update:modelValue', $event.target.value)"
      @keyup.enter="$emit('submit', modelValue)"
    />

    <button
      v-if="showClear"
      class="icon-btn"
      type="button"
      title="清空"
      @click="$emit('update:modelValue', '')"
    >
      <IconX :size="16" :stroke-width="2.2" />
    </button>

    <button class="submit-btn" type="button" :disabled="disabled" :title="submitTitle" @click="$emit('submit', modelValue)">
      <IconArrowRight :size="18" :stroke-width="2.4" />
    </button>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { IconSearch, IconX, IconArrowRight } from '@tabler/icons-vue'

/**
 * 搜索框（受控输入，纯 UI）
 * 不做请求、不做防抖；回车与按钮都只上抛 submit 事件。
 */
const props = defineProps({
  /** 输入内容（v-model） */
  modelValue: { type: String, default: '' },
  placeholder: { type: String, default: '搜索番剧…' },
  /** 紧凑模式（用于顶栏） */
  compact: { type: Boolean, default: false },
  disabled: { type: Boolean, default: false },
  /** 有内容时显示清空按钮 */
  clearable: { type: Boolean, default: true },
  submitTitle: { type: String, default: '搜索' },
})
defineEmits(['update:modelValue', 'submit'])

const iconSize = computed(() => (props.compact ? 16 : 18))
const showClear = computed(() => props.clearable && !props.disabled && !!props.modelValue)
</script>

<style scoped>
.search-box {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 42px;
  padding: 0 6px 0 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius-pill);
  background: var(--bg-input);
  transition: border-color var(--dur), box-shadow var(--dur), background var(--dur);
}
.search-box.compact {
  height: 36px;
  padding-left: 12px;
}
.search-box:focus-within {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
}
.search-box.disabled {
  opacity: 0.6;
}

.search-icon {
  flex-shrink: 0;
  color: var(--text-tertiary);
}

.search-input {
  flex: 1;
  min-width: 0;
  height: 100%;
  border: none;
  background: transparent;
  color: var(--text-primary);
  font-size: 0.9rem;
}

.icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 50%;
  color: var(--text-tertiary);
  transition: background var(--dur-fast), color var(--dur-fast);
}
.icon-btn:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.submit-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  flex-shrink: 0;
  border-radius: 50%;
  background: var(--accent);
  color: var(--text-invert);
  transition: background var(--dur), transform var(--dur-fast);
}
.compact .submit-btn {
  width: 28px;
  height: 28px;
}
.submit-btn:hover:not(:disabled) {
  background: var(--accent-hover);
}
.submit-btn:active:not(:disabled) {
  transform: scale(0.94);
}
.submit-btn:disabled {
  opacity: 0.55;
}
</style>
