<template>
  <aside class="sidenav">
    <div class="logo">
      <img :src="logoUrl" class="logo-img" alt="Soraika's Hub" />
      <span class="brand-name">Soraika's Hub</span>
    </div>

    <nav class="nav-links">
      <router-link v-for="item in navItems" :key="item.path" :to="item.path" class="nav-item">
        <component :is="item.icon" :size="22" weight="bold" />
        <span>{{ item.label }}</span>
      </router-link>
    </nav>

    <div class="bottom">
      <button class="theme-btn" @click="store.toggleTheme">
        <PhSun v-if="store.theme === 'light'" :size="20" weight="bold" />
        <PhMoon v-else :size="20" weight="bold" />
        <span>{{ store.theme === 'light' ? '深色' : '浅色' }}</span>
      </button>
    </div>
  </aside>
</template>

<script setup>
import {
  PhHouse,
  PhFire,
  PhMagnifyingGlass,
  PhDownloadSimple,
  PhGearSix,
  PhSun,
  PhMoon,
} from '@phosphor-icons/vue'
import { useAppStore } from '@/stores/app'
import logoUrl from '@/assets/LOGO.jpg'
const store = useAppStore()

const navItems = [
  { path: '/', label: '首页', icon: PhHouse },
  { path: '/discover', label: '发现', icon: PhFire },
  { path: '/search', label: '搜索', icon: PhMagnifyingGlass },
  { path: '/downloads', label: '下载', icon: PhDownloadSimple },
  { path: '/settings', label: '设置', icon: PhGearSix },
]
</script>

<style scoped>
.sidenav {
  width: 200px;
  height: 100vh;
  background: var(--bg-sidebar);
  padding: 20px 14px;
  display: flex;
  flex-direction: column;
  gap: 28px;
  border-right: 1px solid var(--border);
  flex-shrink: 0;
}
.logo {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 4px 0 8px;
}
.brand-name {
  font-family: var(--font-ui);
  font-size: 0.95rem;
  font-weight: 700;
  letter-spacing: 0.02em;
  color: var(--text-primary);
  white-space: nowrap;
}
.logo-img {
  height: 44px;
  width: auto;
  max-width: 100%;
  object-fit: contain;
  border-radius: 8px;
}

.nav-links {
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex: 1;
}
.nav-item {
  position: relative;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  border-radius: 10px;
  color: var(--nav-muted);
  text-decoration: none;
  font-size: 0.95rem;
  font-weight: 500;
  transition: all 0.25s cubic-bezier(0.22, 1, 0.36, 1);
}
.nav-item:hover {
  background: var(--nav-muted-bg);
  color: var(--nav-muted-hover);
}
.nav-item.router-link-active {
  background: var(--accent);
  color: #fff;
  opacity: 1;
}
.nav-item::before {
  content: '';
  position: absolute;
  left: -14px;
  top: 50%;
  width: 4px;
  height: 0;
  border-radius: 0 4px 4px 0;
  background: linear-gradient(180deg, var(--accent), var(--accent-gold));
  transform: translateY(-50%);
  transition: height 0.25s cubic-bezier(0.22, 1, 0.36, 1);
}
.nav-item:hover::before { height: 60%; }
.nav-item.router-link-active::before { height: 72%; }

.bottom { margin-top: auto; }
.theme-btn {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  border-radius: 10px;
  background: none;
  color: var(--text-secondary);
  font-size: 0.9rem;
  width: 100%;
  transition: all 0.2s;
}
.theme-btn:hover { background: var(--bg-hover); color: var(--text-primary); }
</style>