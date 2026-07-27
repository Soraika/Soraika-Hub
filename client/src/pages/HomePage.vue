<template>
  <div class="home">
    <header class="topbar">
      <SeasonPicker />
      <div class="search-box">
        <IconSearch :size="18" class="search-icon" />
        <input v-model="keyword" placeholder="搜索番剧..." @keyup.enter="search" />
        <button class="search-btn" @click="search"><IconArrowRight :size="18" /></button>
      </div>
    </header>

    <div v-if="loading" class="state">
      <div class="spinner"></div>
      <span>加载中...</span>
    </div>

    <div v-else-if="error" class="state">
      <IconAlertCircle :size="48" />
      <p>加载失败，请检查网络连接</p>
      <button @click="fetchData" class="retry-btn">重试</button>
    </div>

    <div v-else class="schedule">
      <section v-for="group in schedule" :key="group.day" class="day-section">
        <h2 class="day-label">{{ group.dayLabel }}</h2>
        <div class="anime-grid">
          <AnimeCard
            v-for="anime in group.animes"
            :key="anime.bgmid"
            :anime="anime"
            @click="goToAnime(anime.bgmid)"
          />
        </div>
      </section>
    </div>
  </div>
</template>

<script setup>
import { ref, watch, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { IconSearch, IconArrowRight, IconAlertCircle } from '@tabler/icons-vue'
import { useAppStore } from '@/stores/app'
import { getSchedule } from '@/api'
import SeasonPicker from '@/components/SeasonPicker.vue'
import AnimeCard from '@/components/AnimeCard.vue'

const store = useAppStore()
const router = useRouter()
const schedule = ref([])
const loading = ref(false)
const error = ref(false)
const keyword = ref('')

async function fetchData() {
  loading.value = true
  error.value = false
  try {
    const { data } = await getSchedule(store.currentYear, store.currentSeason)
    schedule.value = data.items || []
  } catch { error.value = true }
  finally { loading.value = false }
}

function search() {
  if (keyword.value.trim()) router.push({ name: 'Search', query: { q: keyword.value.trim() } })
}

function goToAnime(bgmid) { console.log('选中番剧:', bgmid) }

watch(() => [store.currentYear, store.currentSeason], fetchData)
onMounted(fetchData)
</script>

<style scoped>
.home { padding: 32px 40px; max-width: 1400px; }
.topbar { display: flex; align-items: center; gap: 24px; margin-bottom: 40px; }
.search-box {
  flex: 1; max-width: 400px; display: flex; align-items: center;
  background: var(--bg-input); border: 1px solid var(--border);
  border-radius: var(--radius); padding: 0 16px; transition: border-color 0.2s;
}
.search-box:focus-within { border-color: var(--accent); }
.search-icon { color: var(--text-secondary); flex-shrink: 0; }
.search-box input {
  flex: 1; background: none; border: none; color: var(--text-primary);
  font-size: 0.9rem; padding: 10px 0; margin: 0 12px;
}
.search-btn { background: none; color: var(--text-secondary); padding: 4px; border-radius: 6px; }
.search-btn:hover { color: var(--accent); background: var(--bg-hover); }
.state { display: flex; flex-direction: column; align-items: center; gap: 16px; padding: 80px 0; color: var(--text-secondary); }
.spinner {
  width: 36px; height: 36px; border: 3px solid var(--border);
  border-top-color: var(--accent); border-radius: 50%; animation: spin 0.8s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
.retry-btn { background: var(--accent); color: #fff; padding: 10px 24px; border-radius: var(--radius); font-size: 0.9rem; }
.day-section { margin-bottom: 40px; }
.day-label {
  font-family: var(--font-ui); font-size: 1.4rem; font-weight: 600;
  color: var(--accent-gold); margin-bottom: 16px; padding-bottom: 8px; border-bottom: 1px solid var(--border);
}
.anime-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 20px; }
</style>