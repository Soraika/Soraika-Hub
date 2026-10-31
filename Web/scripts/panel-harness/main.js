import { createApp, h, onMounted, ref } from 'vue'
import AnimeDetailPanel from '@/components/detail/AnimeDetailPanel.vue'

/**
 * 详情面板 harness —— 真挂一次 DOM（SSR 渲染不到「面板打开后」这一层）
 * 数据源由挂载时的 URL 决定：`?source=mikan` 看 Mikan 资源，默认 `downloads` 看已下载文件。
 */
const API = 'http://127.0.0.1:3100'
const data = ref(null)
const source = new URLSearchParams(window.location.search).get('source') || 'downloads'

const app = createApp({
  setup() {
    onMounted(async () => {
      const res = await fetch(`${API}/api/anime/417`)
      data.value = (await res.json()).data
    })
    return () =>
      h(AnimeDetailPanel, {
        visible: true,
        data: data.value,
        uiState: data.value ? 'ready' : 'loading',
        source,
        downloadReady: true,
      })
  },
})
app.mount('#app')
