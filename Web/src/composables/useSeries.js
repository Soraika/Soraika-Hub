/**
 * 同系列的作品 —— 面板标题旁「系列」chip 的数据
 * ---------------------------------------------------------------------------
 * 与 useReleases / useEpisodes 最大的不同：**失败不报错**。
 * 系列只是附加信息（后端没算过系列时本来就返回 null），取不到就当没有，
 * 不能因为它把整个面板拖进错误态。
 */
import { ref } from 'vue'
import { fetchAnimeSeries } from '@/api/anime'

export function useSeries() {
  /** @type {import('vue').Ref<null | { rootTitle:string, namingStyle:string|null,
   *   currentIndex:number|null, items:Array<{animeId:number,title:string,index:number|null,
   *   relation:string|null,current:boolean}> }>} */
  const data = ref(null)
  const loading = ref(false)
  /** 令牌：面板是「换作品原地刷新」，只认最后一次请求的结果 */
  let token = 0

  async function load(animeId) {
    const my = ++token
    if (!animeId) {
      data.value = null
      return
    }
    loading.value = true
    try {
      const res = await fetchAnimeSeries(animeId)
      if (my === token) data.value = res || null
    } catch {
      if (my === token) data.value = null // 附加信息：取不到就当没有
    } finally {
      if (my === token) loading.value = false
    }
  }

  /** 换作品时清空，避免闪一下上一部的系列 */
  function reset() {
    token++
    data.value = null
    loading.value = false
  }

  return { data, loading, load, reset }
}
