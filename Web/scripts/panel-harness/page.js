import { createApp, h, onMounted, ref } from 'vue'
import DownloadsPage from '@/pages/DownloadsPage.vue'
import { useDownloads } from '@/composables/useDownloads'

/**
 * 下载页 harness —— 用真 composable 取数（与 App.vue 的接线一致），
 * 只为了在 DOM 里跑一次渲染路径：卡片墙、分区、版本行。
 */
const app = createApp({
  setup() {
    const d = useDownloads()
    onMounted(() => d.load())
    const activeId = ref(null)
    return () =>
      h(DownloadsPage, {
        data: d.data.value,
        uiState: d.uiState.value,
        refreshing: d.refreshing.value,
        activeAnimeId: activeId.value,
        onOpenAnime: () => {},
        onReload: () => d.load({ fresh: true }),
      })
  },
})
app.mount('#app')
