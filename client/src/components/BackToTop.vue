<template>
  <Transition name="fade">
    <button v-show="visible" class="back-top" @click="scrollTop" title="回到顶部">
      <IconArrowUp :size="22" :stroke-width="2.5" class="arrow" />
    </button>
  </Transition>
</template>

<script setup>
import { ref, onMounted, onUnmounted } from 'vue'
import { IconArrowUp } from '@tabler/icons-vue'

const props = defineProps({
  target: { type: String, default: '' },
  threshold: { type: Number, default: 300 },
})

const visible = ref(false)

function onScroll() {
  const el = props.target ? document.querySelector(props.target) : null
  const top = el ? el.scrollTop : window.scrollY
  visible.value = top > props.threshold
}

function scrollTop() {
  const el = props.target ? document.querySelector(props.target) : null
  if (el) {
    el.scrollTo({ top: 0, behavior: 'smooth' })
  } else {
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }
}

onMounted(() => {
  const el = props.target ? document.querySelector(props.target) : window
  if (el) el.addEventListener('scroll', onScroll, { passive: true })
})
onUnmounted(() => {
  const el = props.target ? document.querySelector(props.target) : window
  if (el) el.removeEventListener('scroll', onScroll)
})
</script>

<style scoped>
.back-top {
  position: fixed; bottom: 40px; right: 40px; z-index: 200;
  width: 44px; height: 44px; border-radius: 50%;
  background: var(--accent); color: #fff;
  display: flex; align-items: center; justify-content: center;
  border: none; cursor: pointer;
  box-shadow: 0 4px 16px rgba(139, 92, 246, 0.35);
  animation: float 2.4s ease-in-out infinite;
  transition: transform 0.4s cubic-bezier(0.34, 1.56, 0.64, 1), box-shadow 0.35s;
}
.back-top:hover {
  animation: none;
  transform: scale(1.12);
  box-shadow: 0 6px 24px rgba(139, 92, 246, 0.5);
}
.back-top:active {
  transform: scale(0.95);
  transition: transform 0.15s ease;
}

/* 常态：缓慢上下浮动，幅度大但不突兀 */
@keyframes float {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(-8px); }
}

/* 箭头在 hover 时的弹跳 */
.arrow {
  transition: transform 0.35s cubic-bezier(0.34, 1.56, 0.64, 1);
}
.back-top:hover .arrow {
  animation: bounce-arrow 0.8s ease-in-out infinite;
}

@keyframes bounce-arrow {
  0%, 100% { transform: translateY(0); }
  40% { transform: translateY(-5px); }
  60% { transform: translateY(-1px); }
}

/* 淡入淡出 */
.fade-enter-active, .fade-leave-active {
  transition: opacity 0.35s ease, transform 0.35s ease;
}
.fade-enter-from, .fade-leave-to {
  opacity: 0;
  transform: translateY(12px) scale(0.8);
}
</style>