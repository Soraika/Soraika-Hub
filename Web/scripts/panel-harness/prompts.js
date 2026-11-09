import { createApp, h } from 'vue'
import PromptEditor from '@/components/settings/PromptEditor.vue'

/*
 * 提示词卡片的 harness：只挂这一个组件。
 * 它自己会去 GET /api/ai/prompts，接口由验收脚本打桩（不依赖后端）。
 */
const app = createApp({ render: () => h(PromptEditor) })
app.mount('#app')
