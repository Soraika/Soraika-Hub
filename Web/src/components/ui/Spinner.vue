<template>
  <span
    class="spinner-ring"
    :style="{ width: `${size}px`, height: `${size}px`, borderWidth: `${weight}px` }"
    role="status"
    :aria-label="label"
  />
</template>

<script setup>
/**
 * 加载环（纯展示）
 * 颜色固定：轨道 --border，转圈段 --accent（走令牌，深浅色自适应）
 */
defineProps({
  /** 直径（px） */
  size: { type: Number, default: 24 },
  /** 线宽（px） */
  weight: { type: Number, default: 3 },
  /** 无障碍朗读文案 */
  label: { type: String, default: '加载中' },
})
</script>

<style scoped>
.spinner-ring {
  display: inline-block;
  flex-shrink: 0;
  border-style: solid;
  border-color: var(--border);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(1turn);
  }
}
</style>
