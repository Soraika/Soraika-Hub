<template>
  <section class="card-surface prompt-card">
    <header class="prompt-head">
      <h2 class="prompt-title">
        <IconMessageChatbot :size="19" />
        提示词
      </h2>
      <span class="pill" :class="source === 'override' ? 'pill-accent' : 'pill-muted'">{{ sourceText }}</span>
      <p class="prompt-hint">
        这里只读。要改就编辑 Server/data/prompts.json（保存即生效，不用重启）或 PUT /api/ai/prompts；
        网页里不提供编辑框，因为改坏一段输出结构，表现是「标签突然全没了」，很难查。
      </p>
    </header>

    <StateBlock v-if="loading" state="loading" text="正在读提示词…" />
    <StateBlock v-else-if="error && !data" state="error" :text="error.message" retry-text="重试" @retry="load" />

    <template v-else-if="data">
      <div class="prompt-tabs" role="tablist">
        <button
          v-for="tab in TABS"
          :key="tab.key"
          class="prompt-tab"
          :class="{ on: tab.key === activeKey }"
          type="button"
          role="tab"
          :aria-selected="tab.key === activeKey"
          @click="activeKey = tab.key"
        >
          {{ tab.label }}
          <span v-if="isCustomized(tab.key)" class="tab-flag" title="这一段已经改过（和出厂默认不同）">改</span>
        </button>
      </div>

      <p class="prompt-meta">
        <span>{{ activeTab.hint }}</span>
        <span class="prompt-num">{{ textOf(activeKey).length }} 字 · hash {{ hashOf(activeKey) }}</span>
      </p>

      <pre class="prompt-view">{{ textOf(activeKey) }}</pre>

      <div class="prompt-actions">
        <button
          class="prompt-link"
          type="button"
          :disabled="saving"
          title="把当前这一段复制到剪贴板，粘到 data/prompts.json 里改"
          @click="copyActive"
        >
          <IconCopy :size="13" /> {{ copied ? '已复制' : '复制这一段' }}
        </button>
        <button
          class="prompt-link"
          type="button"
          :disabled="saving || !isCustomized(activeKey)"
          title="把这一段改回出厂默认（会真的写入，删除这段的覆盖）"
          @click="askRestore(activeKey)"
        >
          <IconRestore :size="13" /> 恢复这一段默认
        </button>
        <button
          v-if="customizedKeys.length"
          class="prompt-link"
          type="button"
          :disabled="saving"
          title="四段全部改回出厂默认（删除 data/prompts.json）"
          @click="askRestore('*')"
        >
          <IconRestore :size="13" /> 全部恢复默认
        </button>

        <span class="prompt-msg" :class="{ bad: /失败/.test(message) }">{{ message }}</span>
      </div>
    </template>
  </section>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import { IconCopy, IconMessageChatbot, IconRestore } from '@tabler/icons-vue'
import StateBlock from '@/components/ui/StateBlock.vue'
import { usePrompts } from '@/composables/usePrompts'

/*
 * 提示词（只读）
 * ---------------------------------------------------------------------------
 * 为什么不做输入框：提示词等于输出契约（JSON 里必须有 tags / episodes 这些字段）。
 * 在网页里随手改坏，模型就开始返回对不上的内容，现象是「资源区标签突然没了」，
 * 排查要翻日志才知道是提示词。所以这里只负责「看得见」和「能回到默认」。
 */
const TABS = [
  { key: 'bundle', label: '标签 + 集数', hint: '一次调用同时产出筛选标签与每条资源的集数，最常被改的就是这段。' },
  { key: 'series', label: '系列归一', hint: '判断命名风格、系列总名、番外归类。链序由代码给出，这里只负责归类与命名。' },
  { key: 'format', label: '格式特征', hint: '从某个字幕组的样本里抽共有格式，用于在全量 feed 里认出该组资源。' },
  { key: 'groupTags', label: '组标记 → 组名', hint: '把文件名开头的组标记对应到库里的组名；{{NAMES}} 是字典占位符，不能删。' },
]

const { data, loading, saving, error, message, keys, source, textOf, defaultOf, hashOf, isCustomized, customizedKeys, load, restoreOne, restoreAll } =
  usePrompts()

const activeKey = ref('bundle')
const activeTab = computed(() => TABS.find((tab) => tab.key === activeKey.value) || TABS[0])
const sourceText = computed(() => (source.value === 'override' ? '有改动（用着你的版本）' : source.value ? '出厂默认' : ''))
const copied = ref(false)

/** 复制当前段：粘到 data/prompts.json 里当起点最方便 */
async function copyActive() {
  try {
    await navigator.clipboard.writeText(textOf(activeKey.value))
    copied.value = true
    setTimeout(() => {
      copied.value = false
    }, 1600)
  } catch {
    /* 非安全上下文 / 无权限：不弹错，用户可以自己选中复制 */
  }
}

/**
 * 恢复默认要确认：它会真的写盘。用原生 confirm，不另做弹层（设置页只此一处需要确认）
 */
function askRestore(which) {
  const label = which === '*' ? '四段提示词' : `「${TABS.find((t) => t.key === which)?.label}」这段提示词`
  if (!window.confirm(`把${label}恢复成出厂默认？\n如果你改过它，改动会被删除。`)) return
  if (which === '*') restoreAll()
  else restoreOne(which)
}

onMounted(load)
</script>

<style scoped>
.prompt-card {
  padding: 20px 24px 18px;
}
.prompt-head {
  display: grid;
  grid-template-columns: 1fr auto;
  align-items: center;
  gap: 4px 10px;
  margin-bottom: 14px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--border);
}
.prompt-title {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--text-primary);
  font-size: 0.98rem;
  font-weight: 700;
}
.prompt-title svg {
  color: var(--accent);
}
.prompt-hint {
  grid-column: 1 / -1;
  color: var(--text-tertiary);
  font-size: 0.75rem;
  line-height: 1.6;
}

/* 页签：与设置页的 pill 同一套观感，选中实底 */
.prompt-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 10px;
}
.prompt-tab {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 12px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-pill);
  background: var(--bg-card);
  color: var(--text-secondary);
  font-size: 0.75rem;
  cursor: pointer;
  transition: color var(--dur-fast), border-color var(--dur-fast), background var(--dur-fast);
}
.prompt-tab:hover {
  border-color: var(--accent);
  color: var(--accent);
}
.prompt-tab.on {
  border-color: var(--accent);
  background: var(--accent);
  color: var(--text-invert);
  font-weight: 600;
}
/* 「改」标记：这段被覆盖过。用弱胶囊色，不抢选中态 */
.tab-flag {
  padding: 0 5px;
  border-radius: var(--radius-pill);
  background: var(--accent-soft);
  color: var(--accent-strong);
  font-size: 0.62rem;
  font-weight: 700;
  line-height: 1.6;
}
.prompt-tab.on .tab-flag {
  background: var(--text-invert);
  color: var(--accent);
}

.prompt-meta {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 6px;
  color: var(--text-tertiary);
  font-size: 0.72rem;
}
.prompt-num {
  flex-shrink: 0;
  font-family: var(--font-mono);
  font-size: 0.7rem;
}

/* 只读正文：等宽、可选中、限高滚动（提示词本身就有几十行） */
.prompt-view {
  max-height: 340px;
  margin: 0;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-input);
  color: var(--text-secondary);
  font-family: var(--font-mono);
  font-size: 0.74rem;
  line-height: 1.65;
  white-space: pre-wrap;
  overflow: auto;
}

.prompt-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  margin-top: 10px;
}
.prompt-link {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--accent);
  font-size: 0.74rem;
  cursor: pointer;
}
.prompt-link:disabled {
  color: var(--text-tertiary);
  cursor: default;
}
.prompt-link:hover:not(:disabled) {
  color: var(--accent-strong);
}
.prompt-msg {
  margin-left: auto;
  color: var(--text-secondary);
  font-size: 0.74rem;
}
.prompt-msg.bad {
  color: var(--danger);
}
</style>
