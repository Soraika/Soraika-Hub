<template>
  <div class="search-page">
    <header class="topbar">
      <button class="back-btn" @click="$router.push('/')">
        <IconArrowLeft :size="20" />
      </button>
      <div class="search-box">
        <IconSearch :size="18" class="search-icon" />
        <input
          ref="inputRef"
          v-model="keyword"
          placeholder="搜索番剧..."
          @keyup.enter="doSearch"
        />
        <button class="search-btn" @click="doSearch"><IconArrowRight :size="18" /></button>
      </div>
    </header>

    <div v-if="!searched" class="state empty-state">
      <div class="empty-icon-wrap">
        <IconSearch :size="56" class="empty-icon" />
        <IconSparkles :size="22" class="sparkle s1" />
        <IconSparkles :size="16" class="sparkle s2" />
        <IconSparkles :size="14" class="sparkle s3" />
      </div>
      <p class="empty-title">发现你想看的番剧</p>
      <p class="empty-desc">输入关键词，开始搜索吧～</p>
    </div>

    <div v-else-if="loading" class="state">
      <div class="spinner"></div>
      <span>搜索中...</span>
    </div>

    <div v-else-if="error" class="state">
      <IconAlertCircle :size="48" />
      <p>搜索失败，请检查网络连接</p>
      <button @click="doSearch" class="retry-btn">重试</button>
    </div>

    <div v-else-if="searched && results.length === 0" class="state">
      <IconMoodEmpty :size="48" />
      <p>没有找到相关番剧</p>
    </div>

    <div v-else class="results">
      <p v-if="searched" class="result-count">找到 {{ results.length }} 个番剧</p>
      <div class="anime-grid">
        <AnimeCard
          v-for="anime in results"
          :key="anime.bgmid"
          :anime="anime"
          @click="goToAnime(anime.bgmid)"
        />
      </div>
    </div>

    <BackToTop />
  </div>
</template>

<script setup>
import { ref, watch, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { IconSearch, IconArrowRight, IconArrowLeft, IconAlertCircle, IconMoodEmpty, IconSparkles } from '@tabler/icons-vue'
import { searchMikan } from '@/api'
import AnimeCard from '@/components/AnimeCard.vue'
import BackToTop from '@/components/BackToTop.vue'

const route = useRoute()
const router = useRouter()
const inputRef = ref(null)
const keyword = ref('')
const results = ref([])
const loading = ref(false)
const error = ref(false)
const searched = ref(false)

async function doSearch() {
  const q = keyword.value.trim()
  if (!q) return
  router.push({ name: 'Search', query: { q } })
}

async function fetchResults(q) {
  loading.value = true
  error.value = false
  searched.value = true
  try {
    const { data } = await searchMikan(q)
    results.value = data.items || []
  } catch { error.value = true }
  finally { loading.value = false }
}

function goToAnime(bgmid) {
  console.log('选中番剧:', bgmid)
  // 后续做详情页再跳转
}

watch(() => route.query.q, (q) => {
  if (q) {
    keyword.value = q
    fetchResults(q)
  }
})

onMounted(() => {
  const q = route.query.q
  if (q) {
    keyword.value = q
    fetchResults(q)
  } else {
    inputRef.value?.focus()
  }
})
</script>

<style scoped>
.search-page { padding: 32px 40px; max-width: 1400px; }
.topbar { display: flex; align-items: center; gap: 16px; margin-bottom: 40px; }
.back-btn {
  display: flex; align-items: center; justify-content: center;
  width: 36px; height: 36px; border-radius: 8px;
  background: none; color: var(--text-secondary); border: 1px solid var(--border);
  cursor: pointer; transition: 0.2s;
}
.back-btn:hover { color: var(--accent); border-color: var(--accent); background: var(--bg-hover); }
.search-box {
  flex: 1; max-width: 500px; display: flex; align-items: center;
  background: var(--bg-input); border: 1px solid var(--border);
  border-radius: var(--radius); padding: 0 16px; transition: border-color 0.2s;
}
.search-box:focus-within { border-color: var(--accent); }
.search-icon { color: var(--text-secondary); flex-shrink: 0; }
.search-box input {
  flex: 1; background: none; border: none; color: var(--text-primary);
  font-size: 0.95rem; padding: 10px 0; margin: 0 12px;
}
.search-btn { background: none; color: var(--text-secondary); padding: 4px; border-radius: 6px; }
.search-btn:hover { color: var(--accent); background: var(--bg-hover); }
.result-count { color: var(--text-secondary); font-size: 0.85rem; margin-bottom: 24px; }
.state { display: flex; flex-direction: column; align-items: center; gap: 16px; padding: 80px 0; color: var(--text-secondary); }
.spinner {
  width: 36px; height: 36px; border: 3px solid var(--border);
  border-top-color: var(--accent); border-radius: 50%; animation: spin 0.8s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
.retry-btn { background: var(--accent); color: #fff; padding: 10px 24px; border-radius: var(--radius); font-size: 0.9rem; }
.anime-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 20px; }

/* 空白引导 */
.empty-state { padding: 100px 0; }
.empty-icon-wrap { position: relative; margin-bottom: 8px; }
.empty-icon { color: var(--text-tertiary); opacity: 0.5; }
.sparkle { position: absolute; color: var(--accent-gold); }
.s1 { top: -4px; right: -10px; animation: sparkle-pop 2s ease-in-out infinite; }
.s2 { bottom: 4px; left: -14px; animation: sparkle-pop 2s ease-in-out 0.5s infinite; }
.s3 { top: 16px; left: -22px; animation: sparkle-pop 2s ease-in-out 1s infinite; }
@keyframes sparkle-pop {
  0%, 100% { transform: scale(1); opacity: 0.4; }
  50% { transform: scale(1.3); opacity: 1; }
}
.empty-title { color: var(--text-primary); font-size: 1.1rem; font-weight: 600; margin-top: 8px; }
.empty-desc { color: var(--text-tertiary); font-size: 0.9rem; }
</style>