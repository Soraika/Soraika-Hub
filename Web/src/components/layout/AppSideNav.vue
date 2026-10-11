<template>
  <aside class="side-nav">
    <!-- 品牌 -->
    <div class="brand">
      <img class="brand-logo" :src="logoUrl" alt="Soraika's Hub" />
      <span class="brand-name">Soraika's Hub</span>
    </div>

    <!-- 主导航（点击仅上抛 navigate，路由接入后由父级切换） -->
    <nav class="nav-list" aria-label="主导航">
      <button
        v-for="item in navItems"
        :key="item.key"
        class="nav-item"
        :class="{ active: item.key === active }"
        type="button"
        @click="$emit('navigate', item.key)"
      >
        <component :is="item.icon" :size="22" weight="bold" />
        <span class="nav-label">{{ item.label }}</span>
      </button>
    </nav>

    <!-- 底部：主题切换 —— 「浅色 / 深色」是一个开关，「跟随系统」是旁边的独立按钮。
         开关显示的是「当前真正生效」的主题（选了跟随系统时它随系统偏好自己动）：
         点开关 = 接管主题（变成显式的浅 / 深），点跟随系统 = 交还给系统。
         状态、持久化、跟随系统、跨标签页同步都在 useTheme 里，这里只负责显示与转发。 -->
    <div class="side-bottom">
      <div class="theme-row">
        <!-- 浅色 / 深色 开关：两段式，生效的一侧高亮 -->
        <button
          class="theme-switch"
          type="button"
          role="switch"
          :aria-checked="isDark"
          aria-label="深色模式"
          :title="isDark ? '当前深色，点击切到浅色' : '当前浅色，点击切到深色'"
          @click="toggleLightDark"
        >
          <span class="switch-side" :class="{ on: !isDark }">
            <PhSun :size="13" weight="bold" />
            <span class="switch-label">{{ THEME_LABELS.light }}</span>
          </span>
          <span class="switch-side" :class="{ on: isDark }">
            <PhMoon :size="13" weight="bold" />
            <span class="switch-label">{{ THEME_LABELS.dark }}</span>
          </span>
        </button>

        <!-- 跟随系统：独立按钮 -->
        <button
          class="theme-system"
          :class="{ active: mode === 'system' }"
          type="button"
          :aria-pressed="mode === 'system'"
          :aria-label="`${THEME_LABELS.system}主题`"
          :title="`${THEME_LABELS.system}主题`"
          @click="setMode('system')"
        >
          <PhCircleHalf :size="18" weight="bold" />
        </button>
      </div>
    </div>
  </aside>
</template>

<script setup>
import {
  PhHouse,
  PhFire,
  PhMagnifyingGlass,
  PhRss,
  PhDownloadSimple,
  PhGearSix,
  PhSun,
  PhMoon,
  PhCircleHalf,
} from '@phosphor-icons/vue'
import logoUrl from '@/assets/LOGO.jpg'
import { useTheme, THEME_LABELS } from '@/composables/useTheme'

defineProps({
  /** 当前选中导航项 key（home / discover / search / subscriptions / downloads / settings） */
  active: { type: String, default: 'home' },
})
defineEmits(['navigate'])

// 侧边栏图标统一用 @phosphor-icons/vue（weight="bold"），业务图标才用 @tabler/icons-vue
const navItems = [
  { key: 'home', label: '首页', icon: PhHouse },
  { key: 'discover', label: '发现', icon: PhFire },
  { key: 'search', label: '搜索', icon: PhMagnifyingGlass },
  { key: 'subscriptions', label: '订阅', icon: PhRss },
  { key: 'downloads', label: '下载', icon: PhDownloadSimple },
  { key: 'settings', label: '设置', icon: PhGearSix },
]

// 主题：当前模式、跟随系统、点亮开关的行为、持久化与跨标签页同步都在 useTheme()（唯一真相），
// 这里只负责「显示当前生效的主题 + 把点击转发给 useTheme」；颜色全由 tokens.css 决定。
const { mode, isDark, setMode, toggleLightDark } = useTheme()
</script>

<style scoped>
.side-nav {
  width: var(--sidebar-w);
  height: 100vh;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 28px;
  padding: 20px 14px;
  background: var(--bg-sidebar);
  border-right: 1px solid var(--border);
}

/* ── 品牌 ─────────────────────────────────────────────────────────────── */
.brand {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 4px 0 8px;
}
.brand-logo {
  height: 44px;
  width: auto;
  max-width: 100%;
  object-fit: contain;
  border-radius: var(--radius-sm);
}
.brand-name {
  font-family: var(--font-ui);
  font-size: 0.95rem;
  font-weight: 700;
  letter-spacing: 0.02em;
  color: var(--text-primary);
  white-space: nowrap;
}

/* ── 导航 ─────────────────────────────────────────────────────────────── */
.nav-list {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.nav-item {
  position: relative;
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  padding: 12px 16px;
  border-radius: var(--radius);
  color: var(--nav-muted);
  font-size: 0.95rem;
  font-weight: 500;
  text-align: left;
  transition: background var(--dur) var(--ease-out), color var(--dur) var(--ease-out);
}
.nav-item:hover {
  background: var(--nav-muted-bg);
  color: var(--nav-muted-hover);
}
.nav-item.active {
  background: var(--accent);
  color: var(--text-invert);
}
/* 左侧竖条：hover 半高、选中七成高 */
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
  transition: height var(--dur) var(--ease-out);
}
.nav-item:hover::before {
  height: 60%;
}
.nav-item.active::before {
  height: 72%;
}
.nav-label {
  white-space: nowrap;
}

/* ── 底部 ─────────────────────────────────────────────────────────────── */
.side-bottom {
  margin-top: auto;
}
.theme-row {
  display: flex;
  align-items: stretch;
  gap: 6px;
}

/* 浅色 / 深色 开关：两段式胶囊，生效的一侧抬底 + 图标转强调色 */
.theme-switch {
  flex: 1;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 2px;
  padding: 3px;
  border: 1px solid var(--border);
  border-radius: var(--radius-pill);
  transition: border-color var(--dur) var(--ease-out);
}
.theme-switch:hover {
  border-color: var(--border-strong);
}
.switch-side {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 3px;
  height: 26px;
  border-radius: var(--radius-pill);
  color: var(--nav-muted);
  font-size: 0.66rem;
  line-height: 1;
  transition: background var(--dur) var(--ease-out), color var(--dur) var(--ease-out);
}
/* 生效的一侧：底抬成卡片色（浅色下比侧栏亮、深色下比侧栏亮，观感一致） */
.switch-side.on {
  background: var(--bg-card);
  color: var(--text-primary);
}
.switch-side.on svg {
  color: var(--accent-strong);
}
.switch-label {
  white-space: nowrap;
}

/* 跟随系统：独立按钮，只放图标，说明走 title / aria-label */
.theme-system {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  flex-shrink: 0;
  border: 1px solid var(--border);
  border-radius: var(--radius-pill);
  color: var(--nav-muted);
  transition: background var(--dur) var(--ease-out), color var(--dur) var(--ease-out),
    border-color var(--dur) var(--ease-out);
}
.theme-system:hover {
  background: var(--nav-muted-bg);
  color: var(--nav-muted-hover);
}
/* 选中态只用「描边 + 图标色」表达，文字色不动，避免浅底上的强调色对比不足 */
.theme-system.active {
  background: var(--bg-card);
  border-color: var(--accent);
  color: var(--accent-strong);
}
</style>
