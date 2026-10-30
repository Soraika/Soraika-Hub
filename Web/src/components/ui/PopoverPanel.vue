<template>
  <div
    v-if="open"
    ref="root"
    class="popover"
    :class="[`align-${align}`, { 'width-anchor': width === 'anchor' }]"
    role="dialog"
    :aria-label="label"
  >
    <slot />
  </div>
</template>

<script setup>
import { onBeforeUnmount, ref, watch } from 'vue'

/**
 * 浮层（下拉 / 弹层）
 * ---------------------------------------------------------------------------
 * 设置页里「可点开选择」的交互统一由它承载（模型下拉、供应商下拉、时长/时刻的可视化选择）。
 * 为什么不引组件库：项目已有自己的颜色/圆角/缓动令牌，引库会带进一整套平行样式与覆盖成本；
 * 这里只依赖 `--bg-dropdown` / `--shadow-lg` / `--radius` / `--dur`，视觉自然与全站一致。
 *
 * 关闭行为：点击外部、按 Esc、切换路由（组件卸载）都关闭。
 * **「外部」= 不在本字段的 `.control` 容器里** —— 早先的实现是"跳过所有 `[data-popover-anchor]`"，
 * 于是点另一个字段的输入框时，**上一个弹层不会关**（两个同时开着）。
 * 现在只跳过"自己这一格"里的点击，点别处一律关闭。
 */
const props = defineProps({
  open: { type: Boolean, default: false },
  /** 对齐方式：left 贴左、right 贴右（靠右的字段用 right，避免溢出屏幕） */
  align: { type: String, default: 'left' },
  /** 宽度：auto = 按内容；anchor = 与触发它的那个框同宽（数值/时刻这类要求对齐的用） */
  width: { type: String, default: 'auto' },
  /** 无障碍标签 */
  label: { type: String, default: '选择' },
})
const emit = defineEmits(['close'])

const root = ref(null)

/** 本浮层所属的那一格（`.control`）—— 用「是不是同一格」判断内外，而不是看属性 */
function containerOf() {
  return root.value?.parentElement || null
}

function onPointerDown(event) {
  const box = containerOf()
  if (box && box.contains(event.target)) return
  emit('close')
}

function onKeydown(event) {
  if (event.key === 'Escape') emit('close')
}

function bind(on) {
  if (typeof window === 'undefined') return
  const method = on ? 'addEventListener' : 'removeEventListener'
  window[method]('pointerdown', onPointerDown)
  window[method]('keydown', onKeydown)
}

watch(
  () => props.open,
  (open) => bind(open),
  { immediate: true },
)

onBeforeUnmount(() => bind(false))
</script>

<style scoped>
.popover {
  position: absolute;
  top: calc(100% + 6px);
  z-index: 40;
  min-width: 180px;
  max-height: 320px;
  overflow-y: auto;
  padding: 8px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-dropdown);
  box-shadow: var(--shadow-lg);
  animation: popover-in var(--dur) var(--ease-out);
}
.popover.align-left {
  left: 0;
}
.popover.align-right {
  right: 0;
}
/* 与触发它的那个框同宽：父元素（.control）就是框的宽度，left+right 撑满即可 */
.popover.width-anchor {
  left: 0;
  right: 0;
  width: auto;
  min-width: 0;
}
@keyframes popover-in {
  from {
    opacity: 0;
    transform: translateY(-4px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
</style>
