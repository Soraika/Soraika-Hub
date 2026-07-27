<template>
  <div class="anime-card" @click="$emit('click')">
    <div class="poster-wrapper">
      <img v-if="anime.poster" :src="anime.poster" :alt="anime.name" class="poster" loading="lazy" />
      <div v-else class="poster placeholder">
        <IconPhotoOff :size="32" />
      </div>
    </div>
    <div class="info">
      <span class="name" :title="anime.name">{{ anime.name }}</span>
    </div>
  </div>
</template>

<script setup>
import { IconPhotoOff } from '@tabler/icons-vue'
defineProps({ anime: { type: Object, required: true } })
defineEmits(['click'])
</script>

<style scoped>
.anime-card {
  background: var(--bg-card);
  border-radius: var(--radius);
  overflow: hidden;
  cursor: pointer;
  transition: transform 0.2s, box-shadow 0.2s;
  border: 1px solid var(--border-card);
}
.anime-card:hover {
  transform: translateY(-4px);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.15);
}
.poster-wrapper {
  width: 100%;
  aspect-ratio: 3 / 4;
  overflow: hidden;
  background: #e8e0d5;
}
.poster {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-secondary);
}
.info {
  padding: 12px;
}
.name {
  font-size: 0.85rem;
  font-weight: 500;
  color: var(--text-on-card);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  line-height: 1.4;
}
</style>