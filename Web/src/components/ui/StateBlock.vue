<template>
  <div class="state" role="status">
    <!-- 加载中 -->
    <template v-if="state === 'loading'">
      <Spinner :size="34" :weight="3" />
      <p>{{ text || '加载中…' }}</p>
    </template>

    <!-- 失败 -->
    <template v-else-if="state === 'error'">
      <IconAlertCircle :size="48" :stroke-width="1.6" class="state-icon" />
      <p>{{ text || '加载失败，请检查网络连接' }}</p>
    </template>

    <!-- 空（默认图标可被 icon 覆盖） -->
    <template v-else>
      <component :is="icon || IconMoodEmpty" :size="48" :stroke-width="1.6" class="state-icon" />
      <p>{{ text || '暂无内容' }}</p>
    </template>

    <!-- 动作区：传 retryText 即渲染重试按钮；也可用 action 插槽完全自定义 -->
    <slot name="action">
      <button v-if="retryText" class="retry-btn" type="button" @click="$emit('retry')">
        {{ retryText }}
      </button>
    </slot>
  </div>
</template>

<script setup>
import { IconAlertCircle, IconMoodEmpty } from '@tabler/icons-vue'
import Spinner from './Spinner.vue'

/**
 * 三态占位块（纯展示）：加载 / 失败 / 空
 * 文案与图标都可覆盖，重试按钮只上抛事件，不关心业务
 */
defineProps({
  /** loading | error | empty */
  state: { type: String, default: 'loading' },
  /** 文案（留空则用默认文案） */
  text: { type: String, default: '' },
  /** 空态自定义图标（默认 IconMoodEmpty） */
  icon: { type: [Object, Function], default: null },
  /** 传了就显示重试按钮 */
  retryText: { type: String, default: '' },
})
defineEmits(['retry'])
</script>

<style scoped>
/* 基础布局来自 base.css 的 .state，此处只补充图标与按钮外观 */
.state-icon {
  color: var(--text-tertiary);
}

.retry-btn {
  margin-top: 4px;
  padding: 8px 20px;
  border-radius: var(--radius-pill);
  background: var(--accent);
  color: var(--text-invert);
  font-size: 0.88rem;
  font-weight: 500;
  transition: background var(--dur), transform var(--dur-fast);
}
.retry-btn:hover {
  background: var(--accent-hover);
}
.retry-btn:active {
  transform: scale(0.97);
}
</style>
