<template>
  <nav v-if="items.length > 0" class="quick-nav" :style="{ top: navTop + 'px', right: navRight + 'px' }">
    <button
      v-for="item in items"
      :key="item.day"
      class="nav-dot"
      :class="{ active: item.day === activeDay }"
      :title="item.dayLabel"
      @click="scrollTo(item.day)"
    >
      <span class="dot" />
      <span class="nav-label">{{ shortLabel(item.dayLabel) }}</span>
    </button>
  </nav>
</template>

<script setup>
import { ref, watch, onMounted, onUnmounted, nextTick } from 'vue'

const props = defineProps({
  items: { type: Array, required: true },
  scrollContainer: { type: String, default: '.home-main' },
})

const activeDay = ref(null)
const navTop = ref(120)
const navRight = ref(6)

let observer = null
let resizeObserver = null
let positionHandler = null

function shortLabel(label) {
  const map = { '周日': '日', '周一': '一', '周二': '二', '周三': '三', '周四': '四', '周五': '五', '周六': '六' }
  return map[label] || label.slice(0, 2)
}

function scrollTo(day) {
  const target = document.getElementById(`day-${day}`)
  if (target) {
    target.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
}

function setupObserver(container) {
  if (!container) return
  observer?.disconnect()

  const ids = props.items.map(i => `day-${i.day}`)
  const elements = ids.map(id => document.getElementById(id)).filter(Boolean)

  if (elements.length === 0) return

  observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        const day = parseInt(entry.target.id.replace('day-', ''))
        activeDay.value = day
        break
      }
    }
  }, { root: container, threshold: 0.3 })

  for (const el of elements) observer.observe(el)
}

function updatePosition() {
  const container = document.querySelector(props.scrollContainer)
  if (container) {
    const rect = container.getBoundingClientRect()
    navTop.value = Math.max(rect.top + 80, 80)
    // navRight = viewport 右侧 - 容器右侧 = 面板宽度
    navRight.value = window.innerWidth - rect.right + 6
  }
}

onMounted(() => {
  const container = document.querySelector(props.scrollContainer)
  updatePosition()
  positionHandler = () => updatePosition()
  if (container) {
    container.addEventListener('scroll', positionHandler, { passive: true })
    resizeObserver = new ResizeObserver(updatePosition)
    resizeObserver.observe(container)
  }
  window.addEventListener('resize', positionHandler)
})

onUnmounted(() => {
  observer?.disconnect()
  resizeObserver?.disconnect()
  const container = document.querySelector(props.scrollContainer)
  if (container && positionHandler) container.removeEventListener('scroll', positionHandler)
  window.removeEventListener('resize', positionHandler)
})

watch(() => props.items.length, () => {
  nextTick(() => {
    const container = document.querySelector(props.scrollContainer)
    setupObserver(container)
  })
}, { immediate: true })
</script>

<style scoped>
.quick-nav {
  position: fixed;
  z-index: 100;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 6px 3px;
}

.nav-dot {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  background: none;
  border: none;
  cursor: pointer;
  padding: 4px 5px;
  border-radius: 6px;
  color: var(--text-secondary);
  transition: all 0.25s cubic-bezier(0.34, 1.56, 0.64, 1);
}

.nav-dot:hover {
  color: var(--text-primary);
  transform: scale(1.15);
}

.nav-dot.active {
  color: var(--accent);
  transform: scale(1.12);
}

.dot {
  display: block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: currentColor;
  transition: all 0.3s ease;
}

.nav-label {
  font-size: 0.7rem;
  font-weight: 600;
  letter-spacing: 0.05em;
  color: inherit;
}

.nav-dot.active .dot {
  width: 10px;
  height: 10px;
  box-shadow: 0 0 10px var(--accent);
}
</style>