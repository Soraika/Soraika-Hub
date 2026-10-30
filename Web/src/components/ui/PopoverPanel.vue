<template>
  <!-- **Teleport 到 body**：弹层一旦留在字段里，就会被祖先的 `container-type` / `overflow`
       影响 —— `container-type: inline-size` 会让 `position: fixed` 相对**容器**定位
       （等于把视口坐标算出来的位置整体偏移，弹层被甩到屏幕外，看着就是"箭头转了但没弹窗"）。
       挂到 body 后 fixed 永远是视口坐标，位置计算才成立。 -->
  <Teleport to="body">
    <div v-if="open" ref="root" class="popover" :style="style" role="dialog" :aria-label="label">
      <slot />
    </div>
  </Teleport>
</template>

<script setup>
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'

/**
 * 浮层（下拉 / 弹层）
 * ---------------------------------------------------------------------------
 * **Teleport 到 body + `position: fixed` + 按锚点算坐标**。
 * 早先版本是 absolute 挂在字段上：会被滚动容器的 overflow 裁掉（靠下的字段点开"被挡住"）；
 * 改成 fixed 后又踩到 `container-type` 的包含块（坐标整体偏移）——两件事一起由「挂 body + 锚点定位」解决。
 * 下方空间不够时会**自动向上翻**；滚动/缩放时跟着重锚点走。
 *
 * 关闭行为：点击「锚点或弹层之外」、Esc、组件卸载都关闭。
 * 锚点必须显式传进来（`anchor`）—— 弹层已经不在字段里了，靠 parentElement 找不回来。
 */
const props = defineProps({
  open: { type: Boolean, default: false },
  /** 锚点元素（通常是那一格的 `.control`）—— 位置与宽度都以它为准 */
  anchor: { type: Object, default: null },
  /** 对齐：left 贴锚点左沿；right 贴锚点右沿 */
  align: { type: String, default: 'left' },
  /** 宽度：auto = 按内容；anchor = 与锚点同宽 */
  width: { type: String, default: 'auto' },
  /** 无障碍标签 */
  label: { type: String, default: '选择' },
})
const emit = defineEmits(['close'])

const root = ref(null)
const style = ref({})
const GAP = 6
const MAX_HEIGHT = 320

/** 按锚点位置算坐标：下方够就往下开，不够就向上翻 */
function place() {
  const anchor = props.anchor
  if (!anchor) return
  const rect = anchor.getBoundingClientRect()
  const below = window.innerHeight - rect.bottom
  const above = rect.top
  const openUp = below < 200 && above > below
  const room = Math.max(160, Math.min(MAX_HEIGHT, (openUp ? above : below) - GAP - 10))
  style.value = {
    position: 'fixed',
    ...(props.width === 'anchor' ? { width: `${Math.round(rect.width)}px`, minWidth: '0' } : {}),
    ...(openUp
      ? { bottom: `${Math.round(window.innerHeight - rect.top + GAP)}px`, top: 'auto' }
      : { top: `${Math.round(rect.bottom + GAP)}px`, bottom: 'auto' }),
    ...(props.align === 'right'
      ? { right: `${Math.round(window.innerWidth - rect.right)}px`, left: 'auto' }
      : { left: `${Math.round(rect.left)}px`, right: 'auto' }),
    maxHeight: `${Math.round(room)}px`,
  }
}

function onPointerDown(event) {
  const inPanel = root.value?.contains(event.target)
  const inAnchor = props.anchor?.contains(event.target)
  if (inPanel || inAnchor) return
  emit('close')
}
function onKeydown(event) {
  if (event.key === 'Escape') emit('close')
}

function bind(on) {
  // SSR / 测试环境里没有真正的 window（Node 里 typeof window 可能不是 undefined）——
  // 用能力检测，别只看 typeof，否则 `window[method] is not a function` 会把整页 SSR 打断。
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return
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
  /* **兜底坐标**：即使 JS 没算出位置（锚点缺失 / 计算异常），弹层也会出现在
     视口左上偏下的位置 —— 宁可位置不对，也不能"什么都不显示"（那是没法排查的）。 */
  top: 64px;
  left: 16px;
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
