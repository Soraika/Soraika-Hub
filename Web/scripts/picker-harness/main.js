/**
 * 季选冒烟用的最小挂载点（只挂 SeasonPicker，不连后端）
 * 由 `scripts/verify-picker.mjs` 构建并在 happy-dom 里跑。
 */
import { createApp, h } from 'vue'
import SeasonPicker from '@/components/common/SeasonPicker.vue'

createApp({
  render: () =>
    h(SeasonPicker, {
      label: '2026 秋',
      years: [
        { year: 2026, disabled: [] },
        { year: 2023, disabled: [] },
      ],
      activeYear: 2026,
      activeSeason: '秋',
    }),
}).mount('#app')
