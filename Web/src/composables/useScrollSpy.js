import { ref, nextTick, onMounted, onBeforeUnmount } from 'vue'

/**
 * 滚动联动（scroll spy，通用）
 * ---------------------------------------------------------------------------
 * 用途：页面给一组「区块元素 id」，得到当前激活索引 + 线路进度，直接喂给 MetroNav。
 *   首页 = 7 个星期区块；发现页 = 4 个推荐模块区块。
 *
 * 约定：
 *   1. 只监听「指定滚动容器」（每页自带滚动容器），不依赖 window 滚动
 *   2. progress =（激活索引 + 区块内比例）/（区块数 - 1），与 MetroNav 的 --progress 一一对应
 *   3. 滚动回调里只读几何、不写布局；用 rAF 节流，一帧最多算一次
 *   4. 纯 UI 逻辑：不认业务语义（id 由使用方给），不请求、不跳转
 *
 * 用法：
 *   const scrollHost = ref(null)
 *   const { activeIndex, progress, scrollToIndex } = useScrollSpy({
 *     root: scrollHost,
 *     ids: () => list.map((it) => `day-${it.key}`),
 *     offset: 108,   // 判定线：距容器顶部多少像素算「已到达」（对齐吸顶栏高度）
 *   })
 */
export function useScrollSpy({ root, ids, offset = 120 }) {
  /** 当前激活区块索引（可直接赋值，用于点击站点时的即时反馈） */
  const activeIndex = ref(0)
  /** 线路进度 0~1 */
  const progress = ref(0)

  let raf = 0
  let container = null

  const clamp01 = (n) => Math.min(1, Math.max(0, n))

  /** 按 id 取区块元素（取不到的自动忽略，方便加载态下重算） */
  function getSections() {
    const list = typeof ids === 'function' ? ids() : ids
    return (list || []).map((id) => document.getElementById(id)).filter(Boolean)
  }

  /** 关键帧计算：判定线落在哪个区块 + 区块内的比例 */
  function measure() {
    const container = root?.value || null
    const sections = getSections()
    if (!container || !sections.length) return

    const line = container.getBoundingClientRect().top + offset

    let idx = 0
    for (let i = 0; i < sections.length; i++) {
      if (sections[i].getBoundingClientRect().top <= line) idx = i
    }

    const current = sections[idx]
    const next = sections[idx + 1]
    let frac = 1 // 已是最后一段：走到即视为线路走满
    if (next) {
      const span = next.getBoundingClientRect().top - current.getBoundingClientRect().top
      if (span > 0) frac = clamp01((line - current.getBoundingClientRect().top) / span)
    }

    activeIndex.value = idx
    progress.value = sections.length > 1 ? clamp01((idx + frac) / (sections.length - 1)) : 1
  }

  /** 滚动期间每帧最多算一次 */
  function schedule() {
    if (raf) return
    raf = requestAnimationFrame(() => {
      raf = 0
      measure()
    })
  }

  /** 滚到第 index 个区块（区块自带 scroll-margin-top，会避让吸顶栏） */
  function scrollToIndex(index, behavior = 'smooth') {
    const sections = getSections()
    if (!sections.length) return
    sections[Math.min(Math.max(index, 0), sections.length - 1)]?.scrollIntoView({
      behavior,
      block: 'start',
    })
  }

  onMounted(() => {
    container = root?.value || null
    container?.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('resize', schedule)
    nextTick(measure) // 等首屏布局稳定后先算一次
  })

  onBeforeUnmount(() => {
    container?.removeEventListener('scroll', schedule)
    window.removeEventListener('resize', schedule)
    if (raf) cancelAnimationFrame(raf)
  })

  return { activeIndex, progress, measure, scrollToIndex }
}
