<template>
  <div class="anime-card" @click="$emit('click')">
    <!-- 顶部信息条：左 badge(可选) / 右 评分+人数(可选)，两者都无则整条隐藏 -->
    <div v-if="hasTopbar" class="card-topbar">
      <span v-if="badgeLabel" class="module-tag" :class="'mod-' + badgeMod">
        <component :is="moduleIcon" :size="13" :stroke-width="2.2" />
        <span class="tag-text">{{ badgeLabel }}</span>
      </span>

      <div v-if="showRating && anime.score != null" class="rating-badge">
        <span class="rating-score" :class="scoreClass">
          <IconStarFilled :size="13" />
          {{ anime.score }}
        </span>
        <span class="rating-total" v-if="anime.ratingTotal">{{ ratingText }}</span>
      </div>
    </div>

    <!-- 海报区域完全干净露出 -->
    <div class="poster-wrapper">
      <img
        v-if="anime.poster"
        :src="anime.poster"
        :alt="anime.title || anime.name"
        class="poster"
        :class="{ loaded: imgLoaded }"
        loading="lazy"
        decoding="async"
        @load="imgLoaded = true"
      />
      <div v-else class="poster placeholder">
        <IconPhotoOff :size="32" />
      </div>
      <div v-if="anime.poster" class="poster-shade"></div>
    </div>

    <div class="info">
      <span class="name" :title="anime.title || anime.name">{{ anime.title || anime.name }}</span>
      <div v-if="metaText" class="meta">
        <span class="meta-text">{{ metaTextOverride || metaText }}</span>
        <a
          v-if="anime.bgmId"
          class="bgm-link"
          :href="`https://bgm.tv/subject/${anime.bgmId}`"
          target="_blank"
          rel="noopener"
          title="打开 Bangumi 条目"
          @click.stop
        >
          <IconExternalLink :size="14" />
        </a>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch } from 'vue'
import {
  IconPhotoOff,
  IconExternalLink,
  IconStarFilled,
  IconTrophy,
  IconFlame,
  IconSparkles,
  IconUsers,
  IconCalendar,
} from '@tabler/icons-vue'

const props = defineProps({
  anime: { type: Object, required: true },
  // 左侧徽标：首页传"星期"，发现页不传（避免显示不全）
  badgeLabel: { type: String, default: null },
  // 是否显示评分+人数；首页接口未就绪时传 false
  showRating: { type: Boolean, default: true },
  // 底部元信息覆盖（下载页传 "SE01 · 字幕组" 等自定义文本）
  metaTextOverride: { type: String, default: null },
})
defineEmits(['click'])

const ICON_MAP = {
  praise: IconTrophy,
  hot: IconFlame,
  try: IconSparkles,
  popular: IconUsers,
  today: IconCalendar,
}

const moduleIcon = computed(() => ICON_MAP[props.anime.module] || IconCalendar)

const badgeMod = computed(() => {
  if (props.anime.module) return props.anime.module
  return 'week'
})

const hasTopbar = computed(() => !!props.badgeLabel || (props.showRating && props.anime.score != null))

// 图片渐显
const imgLoaded = ref(false)
watch(
  () => props.anime.poster,
  (val) => {
    imgLoaded.value = !val
  },
  { immediate: true }
)

const scoreClass = computed(() => {
  const s = props.anime.score
  if (s >= 8.0) return 'sc-excellent'
  if (s >= 7.0) return 'sc-good'
  if (s >= 6.0) return 'sc-ok'
  return 'sc-low'
})

const ratingText = computed(() => {
  const total = props.anime.ratingTotal || 0
  if (total >= 10000) return `${(total / 10000).toFixed(1)}万人评分`
  if (total >= 1000) return `${Math.round(total / 1000 * 10) / 10}千人评分`
  return `${total}人评分`
})

// 底部元信息：年份 · 题材 / 今日更新话数
const metaText = computed(() => {
  const a = props.anime
  if (a.module === 'today' && a.weekday) {
    const eps = a.eps || a.totalEpisodes
    return `${a.weekday}${eps ? ` · 更至${a.totalEpisodes ? `${eps}/${a.totalEpisodes}` : `${eps}`}话` : ''}`
  }
  const parts = []
  if (a.year) parts.push(a.year)
  if (a.tags?.length) parts.push(a.tags[0])
  return parts.join(' · ')
})
</script>

<style scoped>
.anime-card {
  position: relative;
  display: flex;
  flex-direction: column;
  background: var(--bg-card);
  border-radius: var(--radius);
  overflow: hidden;
  cursor: pointer;
  transition: transform 0.2s var(--ease-out), box-shadow 0.2s var(--ease-out);
  border: 1px solid var(--border-card);
}
.anime-card:hover {
  transform: translateY(-5px);
  box-shadow: var(--card-shadow);
}
.anime-card:hover .poster {
  transform: scale(1.06);
}

/* 顶部信息条（不遮挡海报） */
.card-topbar {
  display: flex;
  align-items: center;
  justify-content: flex-start;
  gap: 8px;
  padding: 8px 10px;
  min-height: 34px;
}

.module-tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  font-size: 0.64rem;
  font-weight: 600;
  letter-spacing: 0.02em;
  padding: 3px 9px;
  border-radius: 999px;
  background: var(--bg-input);
  white-space: nowrap;
}
.tag-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mod-praise { color: var(--mod-praise-strong); border: 1px solid rgba(221, 178, 94, 0.45); }
.mod-hot { color: var(--mod-hot-strong); border: 1px solid rgba(224, 145, 63, 0.45); }
.mod-try { color: var(--mod-try-strong); border: 1px solid rgba(224, 115, 63, 0.45); }
.mod-popular { color: var(--mod-popular-strong); border: 1px solid rgba(217, 95, 74, 0.45); }
.mod-week { color: var(--mod-praise-strong); border: 1px solid rgba(221, 178, 94, 0.45); }

.rating-badge {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  flex-shrink: 1;
}
.rating-score {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 1.05rem;
  font-weight: 800;
  line-height: 1;
  color: var(--mod-hot-strong);
  flex-shrink: 0;
}
.rating-score :deep(svg) {
  fill: currentColor;
  stroke: none;
}
.rating-total {
  font-size: 0.66rem;
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 90px;
  padding-left: 8px;
  border-left: 1px solid var(--border);
}
.sc-excellent { color: var(--mod-hot-strong); }
.sc-good { color: var(--mod-hot-strong); }
.sc-ok { color: var(--mod-hot-strong); }
.sc-low { color: var(--text-secondary); }

/* 海报 */
.poster-wrapper {
  position: relative;
  width: 100%;
  aspect-ratio: 3 / 4;
  overflow: hidden;
  background: var(--bg-input);
}
.poster {
  width: 100%;
  height: 100%;
  object-fit: cover;
  opacity: 0;
  transition: transform 0.5s var(--ease-out), opacity 0.5s ease;
}
.poster.loaded {
  opacity: 1;
}
.poster-shade {
  position: absolute;
  inset: 0;
  background: linear-gradient(to top, rgba(0, 0, 0, 0.3), transparent 42%);
  pointer-events: none;
}
.placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-secondary);
}

.info {
  padding: 10px 12px 12px;
}
.name {
  display: block;
  font-family: var(--font-ui);
  font-size: 0.92rem;
  font-weight: 500;
  letter-spacing: 0.02em;
  color: var(--text-on-card);
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  line-height: 1.45;
  min-height: 2.6em;
}
.meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  margin-top: 6px;
  min-height: 20px;
}
.meta-text {
  font-size: 0.72rem;
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}
.bgm-link {
  font-size: 0.8rem;
  color: var(--accent);
  text-decoration: none;
  padding: 2px 5px;
  border-radius: 4px;
  flex-shrink: 0;
  transition: background 0.15s;
}
.bgm-link:hover { background: var(--bg-hover); }
</style>