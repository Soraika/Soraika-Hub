<template>
  <div v-if="open" ref="root" class="popover" :style="style" role="dialog" :aria-label="label">
    <slot />
  </div>
</template>

<script setup>
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'

/**
 * 浮层（下拉 / 弹层）
 * ---------------------------------------------------------------------------
 * **用 `position: fixed` + 按锚点算坐标**，而不是 absolute 挂在字段上。
 * 为什么：设置页在 `.main{overflow:hidden}` 的滚动容器里，absolute 的浮层一旦超出容器
 * 就会被裁掉 —— 靠下方的字段（多源地址、提供商列表）点开就"被挡住"。
 * fixed 相对视口定位，不受任何祖先的 overflow 影响；下方空间不够时还会**自动向上翻**。
 *
 * 关闭行为：点击外部、Esc、组件卸载都关闭。
 * 「外部」= 不在本字段的 `.control` 容器里 —— 早先"跳过所有 `[data-popover-anchor]`"的写法
 * 会让"点另一个字段"时上一个弹层不关（两个同时开着）。
 */
const props = defineProps({
  open: { type: Boolean, default: false },
  /** 对齐：left 贴锚点左沿；right 贴锚点右沿 */
  align: { type: String, default: 'left' },
  /** 宽度：auto = 按内容；anchor = 与触发它的那个框同宽 */
  width: { type: String, default: 'auto' },
  /** 无障碍标签 */
  label: { type: String, default: '选择' },
})
const emit = defineEmits(['close'])

const root = ref(null)
const style = ref({})
const GAP = 6
const MAX_HEIGHT = 320

/** 本浮层所属的那一格（`.control`） */
const anchorOf = () => root.value?.parentElement || null

/** 按锚点位置算坐标：下方够就往下开，不够就向上翻 */
function place() {
  const anchor = anchorOf()
  if (!anchor) return
  const rect = anchor.getBoundingClientRect()
  const below = window.innerHeight - rect.bottom
  const above = rect.top
  const openUp = below < 200 && above > below
  const room = Math.max(160, Math.min(MAX_HEIGHT, (openUp ? above : below) - GAP - 10))
  style.value = {
    ...(props.width === 'anchor' ? { width: `${Math.round(rect.width)}px`, minWidth: '0' } : {}),
    ...(openUp
      ? { bottom: `${Math.round(window.innerHeight - rect.top + GAP)}px` }
      : { top: `${Math.round(rect.bottom + GAP)}px` }),
    ...(props.align === 'right'
      ? { right: `${Math.round(window.innerWidth - rect.right)}px` }
      : { left: `${Math.round(rect.left)}px` }),
    maxHeight: `${Math.round(room)}px`,
  }
}

function onPointerDown(event) {
  const box = anchorOf()
  if (box && box.contains(event.target)) return
  emit('close')
}
function onKeydown(event) {
  if (event.key === 'Escape') emit('close')
}

function bind(on) {
  if (typeof window === 'undefined') return
  const method = on ? 'addEventListener' : 'removeEventListener'
  // capture=true：内层滚动容器滚动时也要跟着挪
  window[method]('pointerdown', onPointerDown)
  window[method]('keydown', onKeydown)
  window[method]('scroll', place, true)
  window[method]('resize', place)
}

watch(
  () => props.open,
  async (open) => {
    bind(open)
    if (open) {
      await nextTick()
      place()
    }
  },
  { immediate: true },
)

onBeforeUnmount(() => bind(false))
</script>

<style scoped>
.popover {
  position: fixed;
  z-index: 60;
  min-width: 180px;
  /* 内容再宽也不许超出视口（不然靠右的字段一展开，左边就被顶出屏幕） */
  max-width: min(92vw, 440px);
  overflow-y: auto;
  padding: 8px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-dropdown);
  box-shadow: var(--shadow-lg);
  animation: popover-in var(--dur) var(--ease-out);
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
