import { defineStore } from 'pinia'
import { ref, computed, watch } from 'vue'

export const useAppStore = defineStore('app', () => {
  // 主题：light / dark
  const theme = ref(localStorage.getItem('theme') || 'light')
  watch(theme, (v) => {
    document.documentElement.className = `theme-${v}`
    localStorage.setItem('theme', v)
  }, { immediate: true })

  // 当前选中的季度（优先 localStorage）
  const savedYear = localStorage.getItem('sjYear')
  const savedSeason = localStorage.getItem('sjSeason')
  const currentYear = ref(savedYear ? parseInt(savedYear) : new Date().getFullYear())
  const currentSeason = ref(savedSeason || getCurrentSeason())

  function getCurrentSeason() {
    const m = new Date().getMonth() + 1
    if (m <= 3) return '冬'
    if (m <= 6) return '春'
    if (m <= 9) return '夏'
    return '秋'
  }

  const SEASONS = ['冬', '春', '夏', '秋']

  const seasonLabel = computed(() => `${currentYear.value} ${currentSeason.value}`)

  function setSeason(year, season) {
    currentYear.value = year
    currentSeason.value = season
    localStorage.setItem('sjYear', year)
    localStorage.setItem('sjSeason', season)
  }

  function toggleTheme() {
    theme.value = theme.value === 'light' ? 'dark' : 'light'
  }

  return { theme, currentYear, currentSeason, seasonLabel, setSeason, toggleTheme, SEASONS }
})