<template>
  <aside class="panel" :class="{ open: visible }">
    <div class="panel-inner">
      <button class="close-btn" @click="close"><IconX :size="22" /></button>

      <Transition name="phase" mode="out-in">
        <div v-if="loading" key="loading" class="load-state" style="padding: 80px 0">
          <div class="spinner-ring"></div>
          <span class="load-text">加载中...</span>
        </div>

        <div v-else-if="error" key="error" class="panel-state">
          <IconAlertCircle :size="40" />
          <p>{{ errorText }}</p>
        </div>

        <div v-else-if="detail" key="detail" class="detail-root">
          <div class="panel-header">
            <img v-if="detail.poster" :src="detail.poster" class="panel-poster" />
            <div v-else class="panel-poster placeholder"><IconPhotoOff :size="40" /></div>
            <div class="panel-title">{{ detail.title }}</div>
          </div>

          <div v-if="bgmInfo" class="bgm-card">
            <div class="bgm-rating">
              <span class="bgm-score">★ {{ bgmInfo.rating?.score || '—' }}</span>
              <span class="bgm-total" v-if="bgmInfo.rating?.total">{{ bgmInfo.rating.total }} 人评分</span>
              <span class="bgm-rank" v-if="bgmInfo.rank">#{{ bgmInfo.rank }}</span>
            </div>
            <div class="bgm-meta" v-if="bgmInfo.eps || bgmInfo.platform || studio">
              <span v-if="bgmInfo.eps">{{ bgmInfo.eps }} 话</span>
              <span v-if="bgmInfo.platform">{{ bgmInfo.platform }}</span>
              <span v-if="studio" class="bgm-studio"><IconMovie :size="14" /> {{ studio }}</span>
            </div>
            <div class="bgm-tags" v-if="bgmInfo.tags?.length">
              <span v-for="t in bgmInfo.tags.slice(0, 5)" :key="t.name" class="bgm-tag-chip">{{ t.name }}</span>
            </div>
            <div class="bgm-summary" v-if="bgmInfo.summary" :class="{ expanded: summaryExpanded }">
              <p v-html="sanitizeSummary(bgmInfo.summary)"></p>
            </div>
            <button v-if="bgmInfo.summary && bgmInfo.summary.length > 120" class="bgm-expand-btn" @click="summaryExpanded = !summaryExpanded">
              {{ summaryExpanded ? '收起' : '展开简介' }}
            </button>
          </div>

          <SubgroupPicker
            :subgroups="filteredSubgroups"
            :activeSg="activeSg"
            @select="selectSubgroup"
          />

          <template v-if="activeSg">
            <div class="torrent-section">
              <div class="torrent-header">
                <Transition name="fade-text" mode="out-in">
                  <span class="sg-label" :key="activeSgName">{{ activeSgName }}</span>
                </Transition>
                <div class="torrent-actions">
                  <button v-if="checkedItems.size > 0" class="download-checked-btn" :disabled="downloading" @click="downloadChecked">
                    <IconDownload :size="14" /> 下载选中 ({{ checkedItems.size }})
                  </button>
                  <button class="download-all-btn" :disabled="downloading" @click="downloadAll">
                    <IconDownload :size="16" />
                    {{ selectedTags.size > 0 ? `下载筛选结果 (${rankedTorrents.length})` : '全部下载' }}
                  </button>
                </div>
              </div>

              <Transition name="fade-text" mode="out-in">
                <div v-if="phase === 'loading'" key="loading" class="load-state">
                  <div class="spinner-ring"></div>
                </div>
                <div v-else key="content">
                  <div class="tag-filter-row">
                    <TagFilterBar
                      :allTags="allTags"
                      :selectedTags="selectedTags"
                      :hasBatchTags="hasBatchTags"
                      :batchFilter="batchFilter"
                      @toggleTag="toggleTag"
                      @clearTags="clearTags"
                      @batchChange="batchFilter = $event"
                    />
                    <span v-if="tagsLoading" class="tags-loading"><div class="mini-spinner" style="width:12px;height:12px;border-width:2px;margin-right:4px" /><IconTags :size="14" /> 解析标签中...</span>
                  </div>

                  <TorrentList
                    :rankedItems="rankedTorrents"
                    :episodes="titleMetaMap"
                    :totalCount="torrents.length"
                    :checkedItems="checkedItems"
                    :addedHashes="addedHashes"
                    :torrentLoading="phase === 'loading'"
                    :downloading="downloading"
                    :aiReady="aiReady"
                    @check="toggleCheck"
                    @downloadOne="downloadOne"
                  />
                </div>
              </Transition>
            </div>
          </template>

          <div v-else class="panel-state" style="padding: 48px 0"><p>选择一个字幕组查看资源</p></div>
        </div>
      </Transition>
    </div>
  </aside>
</template>

<script setup>
import { ref, computed, watch, onBeforeUnmount } from 'vue'
import { IconX, IconPhotoOff, IconAlertCircle, IconDownload, IconTags, IconMovie } from '@tabler/icons-vue'
import { getSubDetail, getBangumiRSS, qbAdd, searchBgm, getBgmSubject, classifyTags, classifyDownload, getDownloadHashes } from '@/api'
import SubgroupPicker from './SubgroupPicker.vue'
import TagFilterBar from './TagFilterBar.vue'
import TorrentList from './TorrentList.vue'
import { createLogger } from '@/utils/logger'

const log = createLogger('AnimeDetailPanel')

const props = defineProps({
  bgmid: { type: [Number, String], default: null },
})
const emit = defineEmits(['close'])

const visible = ref(false)
const loading = ref(false)
const error = ref(false)
const errorText = ref('加载失败')
const currentBgmid = ref(null)
const detail = ref(null)
const activeSg = ref(null)
const activeSgName = ref('')
const torrents = ref([])
const downloading = ref(false)
const addedHashes = ref(new Set())
const allTags = ref([])
const selectedTags = ref(new Set())
const checkedItems = ref(new Set())
const batchFilter = ref('all')
const bgmInfo = ref(null)
const titleMetaMap = ref({})
const downloadMeta = ref({ rawName: null, season: 1 })
const tagTypeCache = ref({})
const tagsLoading = ref(false)
const aiReady = ref(false)
const summaryExpanded = ref(false)

const studio = computed(() => {
  const infobox = bgmInfo.value?.infobox || []
  const item = infobox.find(i => i.key === '动画制作')
  return item?.value || null
})

const phase = ref('content')
let loadTimer = null
let spinnerShownAt = 0

onBeforeUnmount(() => clearTimeout(loadTimer))

const filteredSubgroups = computed(() => detail.value?.subgroups || [])

const hasBatchTags = computed(() => {
  // 从集数解析结果判断：有范围字符串（如 "1-12"）就是合集
  const episodes = titleMetaMap.value || {}
  return Object.values(episodes).some(v => typeof v === 'string' && v.includes('-'))
})

const rankedTorrents = computed(() => {
  let items = torrents.value
  if (selectedTags.value.size > 0) {
    const groups = {}
    for (const t of selectedTags.value) {
      const info = allTags.value.find(a => a.value === t)
      const type = info?.type || 'other'
      ;(groups[type] ??= []).push(t)
    }
    items = items.filter(item => {
      const lowerTitle = item.title.toLowerCase()
      return Object.values(groups).every(g =>
        g.some(tag => {
          const info = allTags.value.find(a => a.value === tag)
          const matches = info?.match || [tag]
          return matches.some(m => lowerTitle.includes(m.toLowerCase()))
        })
      )
    })
  }
  if (batchFilter.value === 'single' || batchFilter.value === 'batch') {
    items = items.filter(item => {
      const ep = titleMetaMap.value?.[item.title]
      const isBatch = typeof ep === 'string' && ep.includes('-')
      return batchFilter.value === 'batch' ? isBatch : !isBatch
    })
  }
  if (selectedTags.value.size > 0) {
    items = [...items].sort((a, b) => matchScore(b.title) - matchScore(a.title))
  }
  return items
})

const TYPE_ORDER = { batch: 0, res: 1, codec: 2, sub: 3, source: 4, other: 5 }

function extractBracketTags(title) {
  const matches = title.match(/\[([^\]]+)\]/g) || []
  return matches.map(m => m.slice(1, -1))
}

function matchScore(itemTitle) {
  if (selectedTags.value.size === 0) return 0
  const itemTags = extractBracketTags(itemTitle)
  let score = 0
  for (const t of selectedTags.value) if (itemTags.includes(t)) score++
  return score
}
function toggleTag(tag) {
  const next = new Set(selectedTags.value)
  next.has(tag) ? next.delete(tag) : next.add(tag)
  selectedTags.value = next
}

function clearTags() { selectedTags.value = new Set() }

function toggleCheck(item) {
  const next = new Set(checkedItems.value)
  if (!item.magnetHash) return
  next.has(item.magnetHash) ? next.delete(item.magnetHash) : next.add(item.magnetHash)
  checkedItems.value = next
}

function sanitizeSummary(html) {
  return html.replace(/\n/g, '<br>').replace(/<script[\s\S]*?<\/script>/gi, '')
}

watch(() => props.bgmid, async (id) => {
  if (!id) { visible.value = false; return }
  visible.value = true; loading.value = true; error.value = false; errorText.value = '加载失败'
  detail.value = null; activeSg.value = null; torrents.value = []
  allTags.value = []; selectedTags.value = new Set(); checkedItems.value = new Set()
  batchFilter.value = 'all'; phase.value = 'content'; bgmInfo.value = null

  try {
    const { data } = await getSubDetail(id)
    detail.value = data.detail || null
    // 服务端已把 BGM 条目 ID 经转换表反查为 Mikan 番剧 ID（detail.bgmid），后续字幕组 RSS 需用它
    currentBgmid.value = data.detail?.bgmid || id
    if (detail.value?.title) {
      const bgmPromise = searchBgm(detail.value.title).then(({ data: d }) => {
        const subjectId = d.items?.[0]?.id
        if (subjectId) return getBgmSubject(subjectId)
      }).then((res) => {
        if (res?.data?.detail) bgmInfo.value = res.data.detail
      }).catch(e => { log.error('BGM 搜索失败:', e) })
      await Promise.race([bgmPromise, new Promise(r => setTimeout(r, 3000))])
    }
  } catch (e) { log.error('watch bgmid 失败:', e); error.value = true }
  finally { loading.value = false }
})

async function selectSubgroup(sg) {
  if (activeSg.value === sg.id) return
  activeSg.value = sg.id
  clearTimeout(loadTimer)

  const requestPromise = getBangumiRSS(currentBgmid.value, sg.id)
    .then(resp => resp.data?.items || [])
    .catch(e => { log.error('getBangumiRSS 失败:', e); return [] })

  let timedOut = false
  loadTimer = setTimeout(() => {
    timedOut = true
    phase.value = 'loading'
    spinnerShownAt = Date.now()
  }, 600)

  let items = []
  try { items = await requestPromise }
  catch { items = [] }
  clearTimeout(loadTimer)

  activeSgName.value = sg.name
  torrents.value = items

  if (items.length > 0) {
    const fileNames = items.map(i => i.title)

    // 标签交给 AI 从文件名提取 + 分类
    tagsLoading.value = true
    allTags.value = []
    classifyTags(fileNames).then(({ data: r }) => {
      if (r?.ok && r.results) {
        const tagList = []
        for (const [tag, info] of Object.entries(r.results)) {
          // 新格式: { type, match[] }
          const type = info?.type || info
          const match = info?.match || [tag]
          if (type === null || type === 'null') continue
          tagList.push({ value: tag, type, match })
        }
        tagList.sort((a, b) => {
          const oa = TYPE_ORDER[a.type] ?? 9
          const ob = TYPE_ORDER[b.type] ?? 9
          if (oa !== ob) return oa - ob
          return a.value.localeCompare(b.value)
        })
        allTags.value = tagList
      }
      tagsLoading.value = false
    }).catch(e => { log.error('classifyTags 失败:', e); tagsLoading.value = false })

    downloadMeta.value = { rawName: null, season: 1 }
    titleMetaMap.value = {}
    aiReady.value = false
    classifyDownload(detail.value.title, fileNames).then(({ data: r }) => {
      if (r?.ok) {
        downloadMeta.value = { rawName: r.rawName || null, season: r.season || 1 }
        if (r.episodes) {
          const map = {}
          for (const [title, ep] of Object.entries(r.episodes)) {
            map[title] = ep
          }
          titleMetaMap.value = map
        }
      }
      aiReady.value = true
    }).catch(e => { log.error('classifyDownload 失败:', e); aiReady.value = true })
  }

  getDownloadHashes().then(({ data }) => {
    if (data?.ok && data.hashes) {
      addedHashes.value = new Set(data.hashes.map(h => h.toLowerCase()))
    }
  }).catch(e => { log.error('getDownloadHashes 失败:', e) })

  selectedTags.value = new Set()
  checkedItems.value = new Set()
  batchFilter.value = 'all'

  if (timedOut) {
    const elapsed = Date.now() - spinnerShownAt
    if (elapsed < 1000) {
      await new Promise(r => setTimeout(r, 1000 - elapsed))
    }
  }

  phase.value = 'content'
}

function buildDownloadMeta(item) {
  const meta = downloadMeta.value || {}
  const rawTitle = detail.value.title || ''
  const animeName = meta.rawName || rawTitle.replace(/^【[^】]+】\s*/, '') || '未命名'
  const seasonNum = meta.season || 1

  let episodeNum = titleMetaMap.value?.[item.title]
  if (episodeNum == null) {
    const m = item.title.match(/\[(\d{1,3}(?:-\d{1,3})?)\]/)
    if (m) {
      const val = m[1]
      episodeNum = val.includes('-') ? val : parseInt(val)
    }
  }
  const episode = episodeNum != null
    ? (typeof episodeNum === 'number' ? String(episodeNum).padStart(2, '0') : String(episodeNum))
    : null

  const seasonPadded = String(seasonNum).padStart(2, '0')
  const seasonDir = `SE${seasonPadded}`
  const savePath = `${animeName}/${seasonDir}`
  const rename = episode ? `${animeName} S${seasonPadded}E${episode}` : `${animeName} S${seasonPadded}`
  const taskName = `[${props.bgmid || 'null'}][${animeName}][${seasonNum}][${episode || 'null'}][${activeSg.value || 'null'}][${activeSgName.value || 'null'}]`

  const bgm = bgmInfo.value || {}
  const ratingValue = bgm.rating?.score != null ? bgm.rating.score : null
  const tagsValue = bgm.tags?.length ? JSON.stringify(bgm.tags.map(t => t.name)) : null
  const posterValue = detail.value?.poster || null
  const studioValue = studio.value || null

  return {
    savePath,
    rename,
    taskName,
    tags: `${activeSgName.value},${animeName}`,
    poster: posterValue,
    rating: ratingValue,
    animeTags: tagsValue,
    studio: studioValue,
  }
}

async function downloadOne(item) {
  if (downloading.value) return
  downloading.value = true
  try {
    // 如果 AI 还没解析这个文件，单独调一次秒返
    if (titleMetaMap.value?.[item.title] == null && detail.value?.title) {
      try {
        const { data: r } = await classifyDownload(detail.value.title, [item.title])
        if (r?.ok && r.episodes) {
          const map = { ...titleMetaMap.value }
          for (const [title, ep] of Object.entries(r.episodes)) {
            map[title] = ep
          }
          titleMetaMap.value = map
          if (r.rawName) downloadMeta.value.rawName = r.rawName
          if (r.season) downloadMeta.value.season = r.season
        }
      } catch (e) { log.error('单条AI解析失败:', e) }
    }
    const meta = buildDownloadMeta(item)
    await qbAdd({ magnet: item.magnet, ...meta })
    addedHashes.value = new Set([...addedHashes.value, item.magnetHash])
  } catch (e) { log.error('downloadOne 失败:', e) } finally { downloading.value = false }
}

async function downloadAll() {
  if (downloading.value) return
  downloading.value = true
  try {
    const items = rankedTorrents.value
    for (const t of items) {
      const meta = buildDownloadMeta(t)
      try { await qbAdd({ magnet: t.magnet, ...meta }) } catch (e) { log.error('downloadAll 单条失败:', e) }
    }
    const allHashes = new Set(items.map(t => t.magnetHash).filter(Boolean))
    addedHashes.value = new Set([...addedHashes.value, ...allHashes])
  } catch {} finally { downloading.value = false }
}

async function downloadChecked() {
  if (downloading.value) return
  downloading.value = true
  try {
    const selected = rankedTorrents.value.filter(t => checkedItems.value.has(t.magnetHash))
    for (const t of selected) {
      const meta = buildDownloadMeta(t)
      try { await qbAdd({ magnet: t.magnet, ...meta }) } catch (e) { log.error('downloadChecked 单条失败:', e) }
    }
    const allHashes = new Set(selected.map(t => t.magnetHash).filter(Boolean))
    addedHashes.value = new Set([...addedHashes.value, ...allHashes])
  } catch (e) { log.error('downloadAll 失败:', e) } finally { downloading.value = false }
}

function close() { emit('close') }
</script>

<style scoped>
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
}
.panel-inner {
  width: 320px; height: 100vh;
  overflow-y: scroll; padding: 28px 24px;
  opacity: 0;
  transition: opacity 0.25s ease 0.08s;
}
.panel.open .panel-inner {
  opacity: 1;
}
.close-btn {
  position: absolute; top: 16px; right: 16px; z-index: 5;
  display: flex; align-items: center; justify-content: center;
  width: 32px; height: 32px; border-radius: 8px;
  background: var(--bg-input); border: 1px solid var(--border);
  color: var(--text-secondary); cursor: pointer; transition: 0.2s;
}
.close-btn:hover { color: var(--accent); border-color: var(--accent); }

.panel-state { display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 24px 0 40px; color: var(--text-secondary); }

.bgm-card {
  padding: 14px; border-radius: 10px;
  background: var(--bg-input); border: 1px solid var(--border);
  margin-bottom: 20px; font-size: 0.8rem;
}
.bgm-rating { display: flex; align-items: baseline; gap: 8px; margin-bottom: 4px; }
.bgm-score { font-size: 1.1rem; font-weight: 700; color: var(--accent-gold); }
.bgm-total { font-size: 0.75rem; color: var(--text-secondary); }
.bgm-rank { font-size: 0.75rem; color: var(--accent); font-weight: 600; }
.bgm-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; color: var(--text-secondary); font-size: 0.75rem; margin-bottom: 6px; }
.bgm-studio { display: inline-flex; align-items: center; gap: 3px; }
.bgm-tags { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 6px; }
.bgm-tag-chip {
  padding: 2px 8px; border-radius: 10px;
  background: rgba(196, 147, 90, 0.12); color: var(--accent-gold);
  font-size: 0.7rem; font-weight: 500;
}
.bgm-summary { font-size: 0.78rem; color: var(--text-secondary); line-height: 1.6; max-height: 3.2em; overflow: hidden; transition: max-height 0.3s ease; }
.bgm-summary.expanded { max-height: 20em; }
.bgm-summary p { margin: 0; }
.bgm-expand-btn {
  background: none; border: none; color: var(--accent); font-size: 0.75rem;
  cursor: pointer; padding: 4px 0 0; transition: opacity 0.15s;
}
.bgm-expand-btn:hover { opacity: 0.75; }

.load-state {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 14px; padding: 48px 0;
}
.load-text { font-size: 0.82rem; color: var(--text-secondary); }
.spinner-ring {
  width: 36px; height: 36px;
  border: 3px solid var(--border);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin 1.2s ease-in-out infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }

.panel-header { display: flex; gap: 16px; margin-bottom: 24px; align-items: flex-start; }
.panel-poster {
  width: 100px; height: 140px; border-radius: 8px; object-fit: cover;
  flex-shrink: 0; background: var(--bg-input);
}
.panel-poster.placeholder { display: flex; align-items: center; justify-content: center; color: var(--text-tertiary); }
.panel-title {
  font-size: 1.05rem; font-weight: 600; color: var(--text-primary);
  line-height: 1.5; padding-top: 4px;
  flex: 1; min-width: 0; word-break: break-word;
}

.tag-filter-row { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-bottom: 4px; }
.tags-loading { display: flex; align-items: center; font-size: 0.75rem; color: var(--text-secondary); }
.mini-spinner {
  display: inline-block; width: 12px; height: 12px;
  border: 2px solid var(--border);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin 1.2s ease-in-out infinite;
}

.torrent-section { border-top: 1px solid var(--border); padding-top: 16px; }
.torrent-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; flex-wrap: wrap; gap: 6px; }
.sg-label { font-size: 0.85rem; font-weight: 600; color: var(--accent); }
.torrent-actions { display: flex; align-items: center; gap: 6px; }

.download-checked-btn {
  display: flex; align-items: center; gap: 4px;
  background: #3b82f6; color: #fff; border: none;
  padding: 5px 10px; border-radius: 8px; font-size: 0.76rem; cursor: pointer;
  transition: opacity 0.2s, transform 0.15s;
}
.download-checked-btn:hover:not(:disabled) { opacity: 0.88; transform: scale(1.03); }
.download-checked-btn:disabled { opacity: 0.5; cursor: not-allowed; }

.download-all-btn {
  display: flex; align-items: center; gap: 5px;
  background: var(--accent); color: #fff; border: none;
  padding: 6px 14px; border-radius: 8px; font-size: 0.8rem; cursor: pointer;
  transition: opacity 0.2s, transform 0.15s; min-width: 70px; justify-content: center;
}
.download-all-btn:hover:not(:disabled) { opacity: 0.88; transform: scale(1.03); }
.download-all-btn:disabled { opacity: 0.5; cursor: not-allowed; }

.slide-enter-active { transition: transform 0.35s cubic-bezier(0.33, 1, 0.68, 1), opacity 0.35s ease-out; }
.slide-leave-active { transition: transform 0.25s ease-in, opacity 0.25s ease-in; }
.slide-enter-from, .slide-leave-to { transform: translateX(100%); opacity: 0; }

.phase-enter-active { transition: opacity 0.4s cubic-bezier(0.33, 1, 0.68, 1); }
.phase-leave-active { transition: opacity 0.25s ease-in; }
.phase-enter-from, .phase-leave-to { opacity: 0; }

.fade-text-enter-active { transition: opacity 0.5s cubic-bezier(0.33, 1, 0.68, 1); }
.fade-text-leave-active { transition: opacity 0.3s ease-in; }
.fade-text-enter-from, .fade-text-leave-to { opacity: 0; }
</style>