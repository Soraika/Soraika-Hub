<template>
  <aside class="sidenav">
    <div class="logo">
      <span class="logo-icon">🍊</span>
      <span class="logo-text">Soraika's Hub</span>
    </div>
    <nav class="nav-links">
      <router-link v-for="item in navItems" :key="item.path" :to="item.path" class="nav-item">
        <component :is="item.icon" :size="22" />
        <span>{{ item.label }}</span>
      </router-link>
    </nav>
  </aside>
</template>

<script setup>
import { IconHome, IconSearch, IconDownload, IconSettings } from '@tabler/icons-vue'

const navItems = [
  { path: '/', label: '首页', icon: IconHome },
  { path: '/search', label: '搜索', icon: IconSearch },
  { path: '/downloads', label: '下载', icon: IconDownload },
  { path: '/settings', label: '设置', icon: IconSettings },
]
</script>

<style scoped>
.sidenav {
  width: 200px;
  height: 100vh;
  background: var(--bg-sidebar);
  padding: 24px 16px;
  display: flex;
  flex-direction: column;
  gap: 40px;
  position: sticky;
  top: 0;
  left: 0;
  border-right: 1px solid var(--border);
}
.logo { display: flex; align-items: center; gap: 10px; font-family: var(--font-ui); }
.logo-icon { font-size: 28px; }
.logo-text { font-size: 1.1rem; font-weight: 700; color: var(--accent-gold); }
.nav-links { display: flex; flex-direction: column; gap: 4px; }
.nav-item {
  display: flex; align-items: center; gap: 12px;
  padding: 12px 16px; border-radius: 10px;
  color: var(--text-secondary); text-decoration: none;
  font-size: 0.95rem; transition: all 0.2s ease;
}
.nav-item:hover { background: var(--bg-hover); color: var(--text-primary); }
.nav-item.router-link-active { background: var(--accent); color: #fff; }
</style>