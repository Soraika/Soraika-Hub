<template>
  <div class="search scroll-area">
    <!-- 顶部：标题 + 搜索框（吸顶，滚动长结果时也够得着） -->
    <header class="search-head topbar-surface">
      <div class="search-head-inner">
        <h1 class="search-title">搜索</h1>
        <SearchBox
          :model-value="keyword"
          class="search-box"
          :placeholder="aiMode ? '直接说想找什么（可打错字 / 让我推荐）' : '番名片段，空格可分词（如：进击 巨人）'"
          @update:model-value="$emit('input', $event)"
          @submit="$emit('submit', $event)"
        />

        <!-- AI 开关：开着才花 token；关掉就是纯关键词搜索 -->
        <button
          class="ai-toggle"
          :class="{ on: aiMode }"
          type="button"
          :aria-pressed="aiMode"
          :title="aiMode ? 'AI 搜索已开：会先把你的话翻译成关键词/筛选条件' : '开启 AI 搜索（自然语言、容错、可推荐）'"
          @click="$emit('toggle-ai', !aiMode)"
        >
          <IconSparkles :size="14" :stroke-width="2" />
          AI
        </button>
      </div>
    </header>

    <div class="search-body">
      <!-- AI 的理解（或「没接上、已退回关键词」的说明）—— 结果永远可解释 -->
      <p v-if="aiNote" class="ai-note">{{ aiNote }}</p>
      <div v-else-if="intent" class="ai-note">
        <span>AI 理解为「{{ intent.keyword || '（无关键词）' }}」</span>
        <span v-if="intent.reason" class="ai-reason">· {{ intent.reason }}</span>
        <span v-for="chip in intentChips" :key="chip" class="ai-chip">{{ chip }}</span>
      </div>

      <!-- 初始态：还没输入，给一句提示（不算"没有找到"） -->
      <StateBlock v-if="uiState === 'idle'" state="empty" :text="idleText" />
      <StateBlock v-else-if="uiState === 'loading'" state="loading" text="正在搜索…" />
      <StateBlock
        v-else-if="uiState === 'error'"
        state="error"
        :text="errorText || '搜索失败，请检查网络连接'"
        retry-text="重试"
        @retry="$emit('retry')"
      />
      <StateBlock v-else-if="uiState === 'empty'" state="empty" :text="`没有找到「${keyword.trim()}」`" />

      <template v-else>
        <p class="result-count">{{ items.length }} 部作品</p>
        <!-- 结果卡片：与首页同一个组件、同一个 DTO，点开走全站共用的详情面板 -->
        <CardGrid :items="items">
          <template #default="{ item }">
            <PosterCard
              :title="item.title"
              :poster="item.poster"
              :score="item.score"
              :score-text="item.scoreText"
              :rating-text="item.ratingText"
              :meta-text="item.metaText"
              :selected="item.id === activeAnimeId"
              @click="$emit('open-anime', item)"
            />
          </template>
        </CardGrid>
      </template>
    </div>
  </div>
</template>

<script setup>
/**
 * 搜索页（纯展示）
 * 关键词、结果、三态都在容器（useSearch）里；这里只负责摆：顶栏搜索框 + 卡片墙。
 * 点海报上抛 open-anime，由容器决定读哪份数据源并打开全站共用的详情面板。
 */
import SearchBox from '@/components/common/SearchBox.vue'
import CardGrid from '@/components/common/CardGrid.vue'
import PosterCard from '@/components/common/PosterCard.vue'
import StateBlock from '@/components/ui/StateBlock.vue'
import { IconSparkles } from '@tabler/icons-vue'
import { computed } from 'vue'

const props = defineProps({
  /** 当前关键词（受控） */
  keyword: { type: String, default: '' },
  /** 结果卡片（与首页同一 DTO） */
  items: { type: Array, default: () => [] },
  /** idle | loading | error | empty | ready */
  uiState: { type: String, default: 'idle' },
  errorText: { type: String, default: '' },
  /** 面板当前打开的作品（卡片高亮用） */
  activeAnimeId: { type: [Number, null], default: null },
  /** AI 搜索开关 + AI 的理解 + 「已退回关键词」的说明 */
  aiMode: { type: Boolean, default: false },
  intent: { type: Object, default: null },
  aiNote: { type: String, default: '' },
})
defineEmits(['input', 'submit', 'retry', 'open-anime', 'toggle-ai'])

/** 初始态文案随模式变：AI 模式下鼓励「说人话」，普通模式提醒可以空格分词 */
const idleText = computed(() =>
  props.aiMode
    ? 'AI 搜索：直接说想找什么（打错字也行，也能让我推荐）'
    : '输入番名开始搜索（中文名、原名都行，空格可分词）',
)

/** AI 理解出来的筛选条件（年 / 季 / 评分下限 / 题材），平铺成胶囊 */
const intentChips = computed(() => {
  const it = props.intent
  if (!it) return []
  const chips = []
  if (it.year) chips.push(String(it.year))
  if (it.season) chips.push(it.season)
  if (it.minScore) chips.push(`≥${it.minScore}`)
  for (const tag of it.tags || []) chips.push(tag)
  return chips
})
</script>

<style scoped>
.search {
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow-y: auto;
}

/* ── 顶栏（吸顶）─────────────────────────────────────────────────────── */
.search-head {
  position: sticky;
  top: 0;
  z-index: 10;
  padding: 18px 28px 14px;
  border-bottom: 1px solid var(--border);
}

.search-head-inner {
  display: flex;
  align-items: center;
  gap: 18px;
}

.search-title {
  font-size: 1.05rem;
  font-weight: 600;
  letter-spacing: 0.02em;
  white-space: nowrap;
}

.search-box {
  width: min(420px, 100%);
}

/* AI 开关：默认低调，开着才用强调色（token，不写死颜色） */
.ai-toggle {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 34px;
  padding: 0 12px;
  flex-shrink: 0;
  border: 1px solid var(--border);
  border-radius: var(--radius-pill);
  background: var(--bg-input);
  color: var(--text-tertiary);
  font-size: 0.76rem;
  font-weight: 600;
  letter-spacing: 0.02em;
  transition: border-color var(--dur-fast), background var(--dur-fast), color var(--dur-fast);
}
.ai-toggle:hover {
  border-color: var(--accent);
  color: var(--accent-strong);
}
.ai-toggle.on {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent-strong);
}

/* AI 的理解：一行说明 + 筛选胶囊（可解释，不是黑盒） */
.ai-note {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin: 0 0 12px;
  color: var(--text-secondary);
  font-size: 0.78rem;
  line-height: 1.6;
}
.ai-reason {
  color: var(--text-tertiary);
}
.ai-chip {
  padding: 1px 8px;
  border-radius: var(--radius-pill);
  background: var(--bg-hover);
  color: var(--text-secondary);
  font-size: 0.68rem;
}

/* ── 结果区 ──────────────────────────────────────────────────────────── */
.search-body {
  flex: 1;
  padding: 20px 28px 48px;
}

.result-count {
  margin-bottom: 12px;
  color: var(--text-tertiary);
  font-size: 0.85rem;
}
</style>
