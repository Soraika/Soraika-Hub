<template>
  <nav class="metro-nav" :class="[`size-${size}`, { 'has-color': !!fillColor }]" :style="rootStyle" :aria-label="ariaLabel">
    <div class="metro">
      <span class="track" />
      <span class="fill" />
      <div class="stops">
        <button
          v-for="(stop, i) in stops"
          :key="stop.key ?? i"
          class="stop"
          type="button"
          :class="{
            reached: i <= activeIndex,
            current: i === activeIndex,
            'is-today': !!stop.today,
          }"
          :title="stop.title || stop.label"
          :style="stop.color ? { '--stop-color': stop.color } : null"
          @click="$emit('select', stop.key ?? i)"
        >
          <span class="dot" />
          <span v-if="showLabels" class="label">{{ stop.label }}</span>
        </button>
      </div>
    </div>
  </nav>
</template>

<script setup>
import { computed } from 'vue'

/**
 * 地铁图导航（通用）
 * 首页 = 星期（7 站，渐变色轨道）；发现页 = 四个推荐模块（4 站，模块同色）。
 * 填充长度由 --progress(0~1) 与站数在 CSS 里算，组件内不做任何业务计算。
 */
const props = defineProps({
  /** [{ key, label, title?, color?, today? }]
   *  title 可选（悬停提示，不传用 label）；color 可选（单站着色，发现页 = 各模块色）；
   *  today 可选（标记「今天」这一站，未到达也能一眼认出） */
  stops: { type: Array, required: true },
  /** 当前站点索引（已完成的站点其左侧填充变色） */
  activeIndex: { type: Number, default: 0 },
  /** 填充进度 0~1（0=未开始，1=走完最后一站） */
  progress: { type: Number, default: 0 },
  /** 是否显示站点文字 */
  showLabels: { type: Boolean, default: true },
  /** 填充色（不传则用令牌里的 --metro-grad 渐变） */
  fillColor: { type: String, default: '' },
  /** 尺寸：sm | md */
  size: { type: String, default: 'md' },
  /** 无障碍名称 */
  ariaLabel: { type: String, default: '位置导航' },
})
defineEmits(['select'])

const rootStyle = computed(() => ({
  '--stop-count': props.stops.length || 1,
  '--progress': Math.min(1, Math.max(0, props.progress)),
  ...(props.fillColor ? { '--metro-fill': props.fillColor } : {}),
}))
</script>

<style scoped>
.metro-nav {
  --dot: 10px;
  min-width: 0;
}
.metro-nav.size-sm {
  --dot: 8px;
}

.metro {
  position: relative;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 4px;
}

/* 轨道：两端各留半站间距，使填充恰好落在首尾站点中心之间 */
.track,
.fill {
  position: absolute;
  top: calc(var(--dot) / 2 - 1px);
  height: 2px;
  border-radius: 2px;
}
.track {
  left: calc(50% / var(--stop-count));
  right: calc(50% / var(--stop-count));
  background: var(--border);
}
.fill {
  left: calc(50% / var(--stop-count));
  width: calc(var(--progress) * (100% - 100% / var(--stop-count)));
  background: var(--metro-grad);
  transition: width var(--dur-slow) var(--ease-out), background var(--dur) var(--ease-out);
}
.metro-nav.has-color .fill {
  background: var(--metro-fill);
}

/* 站点 */
.stops {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 4px;
  width: 100%;
}
.stop {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 5px;
  flex: 1;
  min-width: 0;
  padding: 0;
}
/* --stop-color 由 stop.color 提供（可选）：未到达时描边取站点自身颜色 */
.dot {
  width: var(--dot);
  height: var(--dot);
  border-radius: 50%;
  background: var(--bg-input);
  box-shadow: 0 0 0 2px var(--stop-color, var(--border-strong));
  transition: background var(--dur) var(--ease-out), box-shadow var(--dur) var(--ease-out),
    transform var(--dur) var(--ease-out);
}
.stop.is-today .dot {
  background: var(--accent-soft);
  box-shadow: 0 0 0 2px var(--accent);
}
.stop.reached .dot {
  background: var(--metro-fill, var(--stop-color, var(--accent)));
  box-shadow: 0 0 0 2px var(--metro-fill, var(--stop-color, var(--accent)));
}
.stop.current .dot {
  transform: scale(1.25);
  box-shadow: 0 0 0 4px var(--accent-soft), 0 0 0 2px var(--metro-fill, var(--stop-color, var(--accent)));
}
.stop:hover .dot {
  box-shadow: 0 0 0 4px var(--bg-hover), 0 0 0 2px var(--metro-fill, var(--stop-color, var(--accent)));
}

.label {
  max-width: 100%;
  font-size: 0.78rem;
  color: var(--text-secondary);
  white-space: nowrap;
  transition: color var(--dur) var(--ease-out);
}
.metro-nav.size-sm .label {
  font-size: 0.72rem;
}
.stop.reached .label {
  color: var(--text-primary);
}
/* 「今天」这站即使还没滚到也保持可辨（current 规则在下方，优先级更高） */
.stop.is-today .label {
  color: var(--accent-strong);
}
.stop.current .label {
  font-weight: 600;
  color: var(--accent);
}
</style>
