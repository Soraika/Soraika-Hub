import { createApp } from 'vue'
import App from './App.vue'
import './styles/index.css'

// 说明：本阶段只搭 UI 骨架，不接路由 / 状态管理。
// TODO: 底层逻辑确定后，在此挂载 vue-router 与 pinia（顺序：pinia → router）。
createApp(App).mount('#app')
