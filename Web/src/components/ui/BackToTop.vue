<template>
  <Transition name="back-to-top">
    <button
      v-show="visible"
      class="back-to-top"
      type="button"
      :title="label"
      :aria-label="label"
      @click="toTop"
    >
      <IconArrowUp class="back-to-top-icon" :size="20" :stroke-width="2.4" />
    </button>
  </Transition>
</template>

<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { IconArrowUp } from '@tabler/icons-vue'

/**
 * 回到顶部（纯交互，不读任何数据）
 * 可指定滚动容器（页面各自持有滚动容器），不传则监听 window。
 */
const props = defineProps({
  /** 滚动容器的 CSS 选择器，如 '.home-main'；留空监听 window */
  target: { type: String, default: '' },
  /** 滚动超过多少 px 才显示 */
  threshold: { type: Number, default: 320 },
  /** 无障碍文案 */
  label: { type: String, default: '回到顶部' },
})

const visible = ref(false)
let scroller = null

function sync() {
  const top = scroller ? scroller.scrollTop : window.scrollY
  visible.value = top > props.threshold
}

function toTop() {
  const host = scroller || window
  host.scrollTo({ top: 0, behavior: 'smooth' })
}

onMounted(() => {
  scroller = props.target ? document.querySelector(props.target) : null
  ;(scroller || window).addEventListener('scroll', sync, { passive: true })
  sync()
})

onBeforeUnmount(() => {
  ;(scroller || window).removeEventListener('scroll', sync)
})
</script>

<style scoped>
.back-to-top {
  position: fixed;
  right: 34px;
  bottom: 34px;
  z-index: 200;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  border-radius: 50%;
  background: var(--bg-card);
  color: var(--text-on-card);
  box-shadow: var(--shadow);
  border: 1px solid var(--border-card);
  transition: background var(--dur), color var(--dur), box-shadow var(--dur), transform var(--dur-fast);
}
.back-to-top:hover {
  background: var(--accent);
  color: var(--text-invert);
  border-color: transparent;
  box-shadow: var(--shadow-accent);
}
.back-to-top:active {
  transform: scale(0.94);
}

/* 箭头在 hover 时轻弹，提示“往上走” */
.back-to-top-icon {
  transition: transform var(--dur) var(--ease-out);
}
.back-to-top:hover .back-to-top-icon {
  animation: bounce-arrow 0.8s var(--ease-out) infinite;
}
@keyframes bounce-arrow {
  0%,
  100% {
    transform: translateY(0);
  }
  40% {
    transform: translateY(-4px);
  }
  60% {
    transform: translateY(-1px);
  }
}

.back-to-top-enter-active,
.back-to-top-leave-active {
  transition: opacity var(--dur) var(--ease-out), transform var(--dur) var(--ease-out);
}
.back-to-top-enter-from,
.back-to-top-leave-to {
  opacity: 0;
  transform: translateY(12px) scale(0.9);
}
</style>
