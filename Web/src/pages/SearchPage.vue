<template>
  <div class="search scroll-area">
    <!-- 顶部：标题 + 搜索框（吸顶，滚动长结果时也够得着） -->
    <header class="search-head topbar-surface">
      <div class="search-head-inner">
        <h1 class="search-title">搜索</h1>
        <SearchBox
          :model-value="keyword"
          class="search-box"
          placeholder="番名片段，空格可分词（如：进击 巨人）"
          @update:model-value="$emit('input', $event)"
          @submit="$emit('submit', $event)"
        />
      </div>
    </header>

    <div class="search-body">
      <!-- 初始态：还没输入，给一句提示（不算"没有找到"） -->
      <StateBlock v-if="uiState === 'idle'" state="empty" text="输入番名开始搜索（中文名、原名都行，空格可分词）" />
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

defineProps({
  /** 当前关键词（受控） */
  keyword: { type: String, default: '' },
  /** 结果卡片（与首页同一 DTO） */
  items: { type: Array, default: () => [] },
  /** idle | loading | error | empty | ready */
  uiState: { type: String, default: 'idle' },
  errorText: { type: String, default: '' },
  /** 面板当前打开的作品（卡片高亮用） */
  activeAnimeId: { type: [Number, null], default: null },
})
defineEmits(['input', 'submit', 'retry', 'open-anime'])
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
