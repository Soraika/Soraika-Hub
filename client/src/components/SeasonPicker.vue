<template>
  <div class="season-picker" ref="pickerRef">
    <button class="trigger" @click="open = !open">
      <IconCalendar :size="18" />
      <span>{{ store.seasonLabel }}</span>
      <IconChevronDown :size="16" class="chevron" :class="{ rotated: open }" />
    </button>

    <div v-if="open" class="dropdown">
      <div v-for="year in years" :key="year" class="year-group">
        <button class="year-btn" :class="{ expanded: expandedYear === year }" @click="toggleYear(year)">
          <IconChevronRight :size="14" class="arrow" :class="{ rotated: expandedYear === year }" />
          {{ year }}
        </button>
        <div v-if="expandedYear === year" class="seasons">
          <button v-for="s in seasons" :key="s" class="season-btn" :class="{ active: year === store.currentYear && s === store.currentSeason }" @click="select(year, s)">
            {{ seasonIcon(s) }} {{ s }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { IconCalendar, IconChevronDown, IconChevronRight } from '@tabler/icons-vue'
import { useAppStore } from '@/stores/app'

const store = useAppStore()
const open = ref(false)
const expandedYear = ref(new Date().getFullYear())
const pickerRef = ref(null)
const seasons = ['春', '夏', '秋', '冬']

const years = computed(() => {
  const currentYear = new Date().getFullYear()
  const list = []
  for (let y = currentYear + 2; y >= currentYear - 3; y--) list.push(y)
  return list
})

function toggleYear(year) {
  expandedYear.value = expandedYear.value === year ? null : year
}

function select(year, season) {
  store.setSeason(year, season)
  open.value = false
}

function seasonIcon(s) {
  return { '春': '🌸', '夏': '🍉', '秋': '🍂', '冬': '⛄' }[s] || ''
}

function handleClickOutside(e) {
  if (pickerRef.value && !pickerRef.value.contains(e.target)) {
    open.value = false
  }
}

onMounted(() => document.addEventListener('click', handleClickOutside))
onUnmounted(() => document.removeEventListener('click', handleClickOutside))
</script>

<style scoped>
.season-picker { position: relative; }
.trigger {
  display: flex; align-items: center; gap: 8px;
  background: var(--bg-input); color: var(--text-primary);
  padding: 8px 16px; border-radius: var(--radius);
  font-size: 0.95rem; font-weight: 500;
  border: 1px solid var(--border); transition: border-color 0.2s;
}
.trigger:hover { border-color: var(--accent); }
.chevron { transition: transform 0.2s; }
.chevron.rotated { transform: rotate(180deg); }
.dropdown {
  position: absolute; top: calc(100% + 8px); left: 0;
  background: var(--bg-dropdown); border: 1px solid var(--border);
  border-radius: var(--radius); padding: 8px;
  min-width: 160px; z-index: 100; box-shadow: var(--shadow);
}
.year-group { display: flex; flex-direction: column; }
.year-btn {
  display: flex; align-items: center; gap: 6px;
  background: none; color: var(--text-secondary);
  padding: 8px 12px; border-radius: 8px;
  font-size: 0.9rem; text-align: left; width: 100%; transition: 0.2s;
}
.year-btn:hover, .year-btn.expanded { background: var(--bg-hover); color: var(--text-primary); }
.arrow { transition: transform 0.2s; }
.arrow.rotated { transform: rotate(90deg); }
.seasons { display: flex; flex-direction: column; padding-left: 28px; }
.season-btn {
  background: none; color: var(--text-secondary);
  padding: 6px 12px; border-radius: 6px;
  font-size: 0.85rem; text-align: left; width: 100%; transition: 0.2s;
}
.season-btn:hover { background: var(--bg-hover); color: var(--text-primary); }
.season-btn.active { background: var(--accent); color: #fff; }
</style>