<template>
  <aside class="panel" :class="{ open: !!group }">
    <div v-if="group" class="panel-inner" @click="closeMenu">
      <button class="close-btn" @click="$emit('close')"><IconX :size="22" /></button>

      <!-- 上半部分：番剧信息 -->
      <div class="panel-header">
        <img v-if="group.poster" :src="group.poster" class="panel-poster" />
        <div v-else class="panel-poster placeholder"><IconPhotoOff :size="40" /></div>
        <div class="panel-head-info">
          <div class="panel-title">{{ group.animeName }}</div>
          <div class="panel-meta">
            <span class="season-badge">{{ group.seasonRange }}</span>
            <span v-if="group.subgroupLabel" class="sg-badge">{{ group.subgroupLabel }}</span>
          </div>
        </div>
      </div>

      <!-- BGM 评分 / 简介 -->
      <div v-if="bgmLoading" class="load-state"><div class="spinner-ring"></div></div>
      <div v-else-if="bgmInfo" class="bgm-card">
        <div class="bgm-rating">
          <span class="bgm-score">★ {{ bgmInfo.rating?.score || '—' }}</span>
          <span v-if="bgmInfo.rating?.total" class="bgm-total">{{ bgmInfo.rating.total }} 人评分</span>
          <span v-if="bgmInfo.rank" class="bgm-rank">#{{ bgmInfo.rank }}</span>
        </div>
        <div v-if="bgmInfo.tags?.length" class="bgm-tags">
          <span v-for="t in bgmInfo.tags.slice(0, 5)" :key="t.name" class="bgm-tag-chip">{{ t.name }}</span>
        </div>
        <div v-if="bgmInfo.summary" class="bgm-summary" :class="{ expanded: summaryExpanded }">
          <p v-html="sanitizeSummary(bgmInfo.summary)"></p>
        </div>
        <button
          v-if="bgmInfo.summary && bgmInfo.summary.length > 120"
          class="bgm-expand-btn"
          @click="summaryExpanded = !summaryExpanded"
        >{{ summaryExpanded ? '收起' : '展开简介' }}</button>
      </div>

      <!-- 已下载字幕组 -->
      <div v-if="group.subgroups?.length" class="subgroup-row">
        <span class="subgroup-label">已下载字幕组</span>
        <span v-for="sg in group.subgroups" :key="sg" class="sg-chip">{{ sg }}</span>
      </div>

      <!-- 下半部分：已下载集管理 -->
      <div class="episode-section">
        <div class="ep-head">
          <span>已下载 {{ group.episodes.length }} 集</span>
          <span class="ep-done">{{ group.doneCount }} 完成</span>
        </div>

        <!-- 筛选：字幕组 + 季度 -->
        <div v-if="subgroupOptions.length > 1 || seasonOptions.length > 1" class="filter-bar">
          <div v-if="subgroupOptions.length > 1" class="filter-group">
            <span class="filter-label">字幕组</span>
            <button class="filter-chip" :class="{ active: subgroupFilter === 'all' }" @click="subgroupFilter = 'all'">全部</button>
            <button
              v-for="sg in subgroupOptions"
              :key="sg"
              class="filter-chip"
              :class="{ active: subgroupFilter === sg }"
              @click="subgroupFilter = sg"
            >{{ sg }}</button>
          </div>
          <div v-if="seasonOptions.length > 1" class="filter-group">
            <span class="filter-label">季度</span>
            <button class="filter-chip" :class="{ active: seasonFilter === 'all' }" @click="seasonFilter = 'all'">全部</button>
            <button
              v-for="s in seasonOptions"
              :key="s"
              class="filter-chip"
              :class="{ active: seasonFilter === s }"
              @click="seasonFilter = s"
            >SE{{ pad(s) }}</button>
          </div>
        </div>

        <!-- 资源卡片（集数 | 主信息+辅助信息 | 右侧完成/进度，hover 变编辑图标弹菜单） -->
        <div class="res-list">
          <div
            v-for="ep in filteredEpisodes"
            :key="ep.hash"
            class="res-card"
            :class="stateClass(ep.qbState)"
          >
            <div class="res-num">
              <span class="res-digit">{{ ep.episode || '—' }}</span>
            </div>
            <div class="res-info">
              <div class="res-label" :title="ep.label">{{ ep.label }}</div>
              <div class="res-meta">
                <span class="res-size">{{ formatSize(ep.size) }}</span>
                <span v-if="ep.subgroupName" class="res-sg" :title="ep.subgroupName">{{ ep.subgroupName }}</span>
              </div>
            </div>
            <div class="res-action" @click.stop="toggleMenu(ep, $event)">
              <template v-if="!ep.isDone">
                <svg class="ring" viewBox="0 0 36 36">
                  <circle class="ring-bg" cx="18" cy="18" r="15.5"></circle>
                  <circle
                    class="ring-fill"
                    cx="18" cy="18" r="15.5"
                    :style="{ strokeDasharray: `${(RING_CIRC * (ep.progress || 0)).toFixed(1)} ${RING_CIRC}` }"
                  ></circle>
                </svg>
                <span class="ring-pct">{{ Math.round((ep.progress || 0) * 100) }}%</span>
              </template>
              <template v-else>
                <IconCircleCheck :size="20" class="res-icon res-icon-check" />
                <IconEdit :size="17" class="res-icon res-icon-edit" />
              </template>

              <!-- 海报区域旁浮出的任务配置弹窗（fixed 定位，不被卡片遮挡） -->
              <div v-if="menuFor === ep.hash" class="res-config" :style="configStyle" @click.stop>
                <div class="cfg-title">任务配置</div>
                <input
                  v-model="cfgName"
                  class="cfg-input"
                  placeholder="输入新任务名"
                  @keyup.enter="saveConfig(ep)"
                  @keyup.esc="closeMenu"
                />
                <div class="cfg-actions">
                  <button class="cfg-save" @click="saveConfig(ep)"><IconCheck :size="14" /> 保存</button>
                  <button class="cfg-delete" :class="{ danger: deletingHash === ep.hash }" @click="confirmDelete(ep)">
                    {{ deletingHash === ep.hash ? '确认删除？' : '删除' }}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 任务配置弹窗已在卡片旁的 res-config 中 -->
  </aside>
</template>

<script setup>
import { ref, computed, watch } from 'vue'
import { IconX, IconPhotoOff, IconCircleCheck, IconEdit, IconCheck } from '@tabler/icons-vue'
import { getSubDetail, searchBgm, getBgmSubject, qbDelete, qbRename } from '@/api'
import { createLogger } from '@/utils/logger'

const log = createLogger('DownloadDetailPanel')

const props = defineProps({
  group: { type: Object, default: null },
})
const emit = defineEmits(['close', 'changed'])

const detail = ref(null)
const bgmInfo = ref(null)
const bgmLoading = ref(false)
const summaryExpanded = ref(false)
const renameTarget = ref(null)
const renameValue = ref('')
// 当前打开配置弹窗的资源 hash + 表单状态
const menuFor = ref(null)
const cfgName = ref('')
const deletingHash = ref(null)
// 弹窗 fixed 定位（相对视口，避免被卡片 overflow 裁剪）
const configPos = ref({ left: 0, top: 0 })
const configStyle = computed(() => ({ left: `${configPos.value.left}px`, top: `${configPos.value.top}px` }))
const CONFIG_W = 200
const CONFIG_H = 116

function toggleMenu(ep, e) {
  menuFor.value = menuFor.value === ep.hash ? null : ep.hash
  if (menuFor.value === ep.hash) {
    cfgName.value = ep.name || ep.label || ''
    deletingHash.value = null
    const rect = e?.currentTarget?.getBoundingClientRect?.()
    if (rect) {
      let top = rect.top - CONFIG_H
      if (top < 8) top = rect.bottom + 4
      configPos.value = { left: Math.max(8, rect.right - CONFIG_W), top }
    }
  }
}
function closeMenu() {
  menuFor.value = null
  deletingHash.value = null
}

// 圆形进度环周长（r=15.5）
const RING_CIRC = 2 * Math.PI * 15.5

function sanitizeSummary(html) {
  return String(html || '').replace(/\n/g, '<br>').replace(/<script[\s\S]*?<\/script>/gi, '')
}

// 筛选：字幕组 + 季度
const subgroupFilter = ref('all')
const seasonFilter = ref('all')
const subgroupOptions = computed(() => [...new Set((props.group?.episodes || []).map(e => e.subgroupName).filter(Boolean))])
const seasonOptions = computed(() => [...new Set((props.group?.episodes || []).map(e => e.season).filter(Boolean))].sort((a, b) => a - b))
const filteredEpisodes = computed(() => {
  let list = props.group?.episodes || []
  if (subgroupFilter.value !== 'all') list = list.filter(e => e.subgroupName === subgroupFilter.value)
  if (seasonFilter.value !== 'all') list = list.filter(e => e.season === seasonFilter.value)
  return list
})

// 番剧信息：详情（海报/字幕组）→ BGM 评分/简介
watch(() => props.group, async (g) => {
  subgroupFilter.value = 'all'
  seasonFilter.value = 'all'
  summaryExpanded.value = false
  detail.value = null
  bgmInfo.value = null
  if (!g?.mikanId) return
  bgmLoading.value = true
  try {
    const { data } = await getSubDetail(g.mikanId)
    detail.value = data.detail || null
    const title = data.detail?.title
    if (title) {
      const { data: d } = await searchBgm(title)
      const subjectId = d.items?.[0]?.id
      if (subjectId) {
        const { data: b } = await getBgmSubject(subjectId)
        if (b?.detail) bgmInfo.value = b.detail
      }
    }
  } catch (e) { log.error('加载番剧信息失败:', e) }
  finally { bgmLoading.value = false }
})

function pad(n) { return String(n).padStart(2, '0') }

function stateClass(s) {
  const m = { downloading: 's-dl', forcedDL: 's-dl', stalledDL: 's-stall', pausedDL: 's-pause',
    uploading: 's-up', forcedUP: 's-up', stalledUP: 's-up',
    queuedDL: 's-queue', queuedUP: 's-queue', error: 's-err', missingFiles: 's-err' }
  return m[s] || ''
}
function formatSize(b) {
  return b > 1073741824 ? (b / 1073741824).toFixed(1) + ' GB'
    : b > 1048576 ? (b / 1048576).toFixed(1) + ' MB'
    : b > 1024 ? (b / 1024).toFixed(0) + ' KB'
    : b + ' B'
}

async function cancel(ep) {
  try { await qbDelete(ep.hash); emit('changed') } catch (e) { log.error('删除任务失败:', e) }
}

// 配置弹窗：保存（重命名）
async function saveConfig(ep) {
  const name = (cfgName.value || '').trim()
  if (!name) return
  try {
    await qbRename(ep.hash, name)
    ep.name = name
    closeMenu()
  } catch (e) { log.error('重命名失败:', e) }
}

// 配置弹窗：删除（二次确认，避免误触）
function confirmDelete(ep) {
  if (deletingHash.value === ep.hash) {
    cancel(ep)
    closeMenu()
  } else {
    deletingHash.value = ep.hash
  }
}
</script>

<style scoped>
/* 右侧滑出面板（flex 推挤，复用 AnimeDetailPanel 布局，不遮挡主内容） */
.panel {
  position: relative; flex-shrink: 0;
  width: 0; min-width: 0; height: 100vh;
  background: var(--bg-card);
  overflow: hidden;
  transition: width 0.32s cubic-bezier(0.33, 1, 0.68, 1), min-width 0.32s cubic-bezier(0.33, 1, 0.68, 1);
}
.panel.open {
  width: 320px; min-width: 300px;
  border-left: 1px solid var(--border);
  box-shadow: -8px 0 24px rgba(0, 0, 0, 0.12);
}
.panel-inner {
  width: 320px; height: 100vh;
  overflow-y: auto; padding: 28px 24px 40px;
  position: relative;
}
.close-btn {
  position: absolute; top: 16px; right: 16px; z-index: 5;
  display: flex; align-items: center; justify-content: center;
  width: 32px; height: 32px; border-radius: 8px;
  background: var(--bg-input); border: 1px solid var(--border);
  color: var(--text-secondary); cursor: pointer; transition: 0.2s;
}
.close-btn:hover { color: var(--accent); border-color: var(--accent); }

/* 头部 */
.panel-header { display: flex; gap: 14px; margin-bottom: 20px; align-items: flex-start; }
.panel-poster {
  width: 96px; height: 134px; border-radius: 8px; object-fit: cover;
  flex-shrink: 0; background: var(--bg-input);
}
.panel-poster.placeholder { display: flex; align-items: center; justify-content: center; color: var(--text-tertiary); }
.panel-head-info { flex: 1; min-width: 0; }
.panel-title { font-size: 1.05rem; font-weight: 600; color: var(--text-primary); line-height: 1.5; padding-top: 2px; word-break: break-word; }
.panel-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 8px; }
.season-badge { background: var(--accent); color: #fff; padding: 1px 8px; border-radius: 10px; font-size: 0.72rem; font-weight: 600; }
.sg-badge { background: var(--bg-input); color: var(--accent); padding: 1px 8px; border-radius: 10px; border: 1px solid var(--accent); font-size: 0.72rem; font-weight: 500; }

/* BGM 卡片 */
.load-state { display: flex; align-items: center; justify-content: center; padding: 20px 0; }
.spinner-ring {
  width: 28px; height: 28px; border: 3px solid var(--border);
  border-top-color: var(--accent); border-radius: 50%; animation: spin 1.2s ease-in-out infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
.bgm-card {
  padding: 14px; border-radius: 10px;
  background: var(--bg-input); border: 1px solid var(--border);
  margin-bottom: 16px; font-size: 0.8rem;
}
.bgm-rating { display: flex; align-items: baseline; gap: 8px; margin-bottom: 4px; }
.bgm-score { font-size: 1.1rem; font-weight: 700; color: var(--accent-gold); }
.bgm-total { font-size: 0.75rem; color: var(--text-secondary); }
.bgm-rank { font-size: 0.75rem; color: var(--accent); font-weight: 600; }
.bgm-tags { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 6px; }
.bgm-tag-chip {
  padding: 2px 8px; border-radius: 10px;
  background: rgba(196, 147, 90, 0.12); color: var(--accent-gold);
  font-size: 0.7rem; font-weight: 500;
}
.bgm-summary { font-size: 0.78rem; color: var(--text-secondary); line-height: 1.6; max-height: 4.8em; overflow: hidden; transition: max-height 0.3s ease; }
.bgm-summary.expanded { max-height: 240px; overflow-y: auto; }
.bgm-summary p { margin: 0; }
.bgm-expand-btn {
  background: none; border: none; color: var(--accent); font-size: 0.75rem;
  cursor: pointer; padding: 4px 0 0; transition: opacity 0.15s;
}
.bgm-expand-btn:hover { opacity: 0.75; }

/* 字幕组 */
.subgroup-row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-bottom: 16px; }
.subgroup-label { font-size: 0.78rem; color: var(--text-secondary); }
.sg-chip { padding: 2px 8px; border-radius: 10px; background: var(--bg-input); border: 1px solid var(--border); color: var(--accent); font-size: 0.72rem; font-weight: 500; }

/* 已下载集 */
.episode-section { border-top: 1px solid var(--border); padding-top: 14px; }
.ep-head { display: flex; align-items: center; justify-content: space-between; font-size: 0.85rem; font-weight: 600; color: var(--text-primary); margin-bottom: 8px; }
.ep-done { font-size: 0.75rem; color: #22c55e; font-weight: 500; }
/* 筛选栏（字幕组 + 季度） */
.filter-bar { display: flex; flex-direction: column; gap: 8px; margin-bottom: 12px; }
.filter-group { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.filter-label { font-size: 0.72rem; color: var(--text-secondary); margin-right: 2px; }
.filter-chip {
  padding: 2px 10px; border-radius: 999px;
  border: 1px solid var(--border); background: var(--bg-input);
  color: var(--text-secondary); font-size: 0.72rem; cursor: pointer; transition: all 0.15s;
}
.filter-chip:hover { color: var(--text-primary); border-color: var(--accent); }
.filter-chip.active { background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 600; }

/* 资源卡片（div 分层：集数徽标 | 头部/字幕组/底部 | 进度环） */
.res-list { display: flex; flex-direction: column; gap: 8px; }
.res-card {
  position: relative;
  display: flex; align-items: stretch;
  border: 1px solid var(--border-card); border-radius: 10px;
  overflow: hidden;
  transition: border-color 0.2s, box-shadow 0.2s;
}
.res-card:hover { border-color: var(--border); box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08); }
.res-num {
  flex-shrink: 0; width: 52px;
  display: flex; align-items: center; justify-content: center;
  background: rgba(196, 147, 90, 0.14); border-right: 1px solid rgba(196, 147, 90, 0.22);
}
.res-digit {
  font-family: 'Georgia', 'Times New Roman', 'Noto Serif SC', serif;
  font-style: italic; font-size: 1.35rem; font-weight: 700; color: #c4935a;
  line-height: 1; font-variant-numeric: tabular-nums; user-select: none;
  word-break: break-all; text-align: center; padding: 0 2px;
}
.res-info { flex: 1; display: flex; flex-direction: column; justify-content: center; gap: 4px; padding: 9px 10px; min-width: 0; }
.res-label { font-weight: 600; color: var(--accent); font-variant-numeric: tabular-nums; white-space: nowrap; }

/* 辅助信息：大小 + 字幕组（灰色小字，弱化） */
.res-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; font-size: 0.72rem; color: var(--text-secondary); }
.res-size { font-variant-numeric: tabular-nums; white-space: nowrap; }
.res-sg { word-break: break-all; }

/* 右侧：完成 ✓ / 进度环；hover 变编辑图标，点击弹操作菜单 */
.res-action {
  position: relative; flex-shrink: 0; width: 48px;
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px;
  padding-right: 8px; cursor: pointer;
}
.res-icon { transition: color 0.2s; }
.res-icon-check { color: #22c55e; }
.res-icon-edit { display: none; color: var(--accent); }
.res-action:hover .res-icon-check { display: none; }
.res-action:hover .res-icon-edit { display: block; }

.ring { width: 30px; height: 30px; transform: rotate(-90deg); }
.ring-bg { fill: none; stroke: var(--bg-input); stroke-width: 3.5; }
.ring-fill {
  fill: none; stroke: var(--accent); stroke-width: 3.5; stroke-linecap: round;
  transition: stroke-dasharray 0.4s ease, stroke 0.3s ease;
}
.res-card.s-dl .ring-fill { stroke: #3b82f6; }
.res-card.s-stall .ring-fill { stroke: #f59e0b; }
.res-card.s-pause .ring-fill { stroke: #9ca3af; }
.res-card.s-err .ring-fill { stroke: #ef4444; }
.ring-pct { font-size: 0.58rem; color: var(--text-secondary); font-variant-numeric: tabular-nums; }

/* 任务配置弹窗（海报区域旁浮出，fixed 定位不被卡片裁剪） */
.res-config {
  position: fixed; z-index: 300;
  width: 200px;
  background: var(--bg-dropdown); border: 1px solid var(--border); border-radius: 10px;
  padding: 10px 12px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.16);
}
.cfg-title { font-size: 0.75rem; font-weight: 600; color: var(--text-primary); margin-bottom: 8px; }
.cfg-input {
  width: 100%; box-sizing: border-box;
  background: var(--bg-input); border: 1px solid var(--border); border-radius: 7px;
  padding: 7px 10px; font-size: 0.8rem; color: var(--text-primary);
  margin-bottom: 10px;
}
.cfg-input:focus { outline: none; border-color: var(--accent); }
.cfg-actions { display: flex; gap: 8px; }
.cfg-save {
  flex: 1; display: flex; align-items: center; justify-content: center; gap: 4px;
  background: var(--accent); color: #fff; border: none; border-radius: 7px;
  padding: 7px 0; font-size: 0.8rem; font-weight: 600; cursor: pointer;
  transition: filter 0.15s;
}
.cfg-save:hover { filter: brightness(1.08); }
.cfg-delete {
  flex: 1; display: flex; align-items: center; justify-content: center; gap: 4px;
  background: var(--bg-input); color: var(--text-secondary); border: 1px solid var(--border);
  border-radius: 7px; padding: 7px 0; font-size: 0.8rem; cursor: pointer;
  transition: all 0.15s;
}
.cfg-delete:hover { color: #ef4444; border-color: #ef4444; }
.cfg-delete.danger { color: #fff; background: #ef4444; border-color: #ef4444; }
</style>

