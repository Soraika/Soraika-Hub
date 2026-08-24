import axios from 'axios'

const api = axios.create({
  baseURL: '/api',
  timeout: 15000,
})

// ── 配置 ──

export function getConfig() {
  return api.get('/config')
}

export function updateConfig(data) {
  return api.put('/config', data)
}

// ── Mikan ──

export function getSchedule(year, season) {
  const params = {}
  if (year) params.year = year
  if (season) params.season = season
  return api.get('/mikan/schedule', { params })
}

export function getSubDetail(id) {
  return api.get(`/mikan/subdetail/${id}`)
}

export function getBangumiRSS(bangumiId, subgroupId) {
  return api.get(`/mikan/rss/${bangumiId}/${subgroupId}`)
}

export function searchMikan(keyword) {
  return api.get('/mikan/search', { params: { q: keyword } })
}

export function getMikanMapping() {
  return api.get('/mikan/mapping')
}

export function syncMikanMapping() {
  return api.post('/mikan/mapping/sync')
}

export function testMikanMapping(url) {
  return api.get('/mikan/mapping/test', { params: { url } })
}

// ── BGM ──

export function getBgmSubject(id) {
  return api.get(`/bgm/subject/${id}`)
}

export function searchBgm(keyword) {
  return api.get('/bgm/search', { params: { q: keyword, limit: 1 } })
}

// ── AI ──

export function classifyTitles(titles, apiKey) {
  const body = { titles }
  if (apiKey) body.apiKey = apiKey
  return api.post('/classify', body)
}

export function classifyTags(fileNames, apiKey) {
  const body = { fileNames: fileNames || [] }
  if (apiKey) body.apiKey = apiKey
  return api.post('/classify/tags', body, { timeout: 120000 })
}

export function classifyDownload(cardTitle, fileNames, apiKey) {
  const body = { cardTitle, fileNames }
  if (apiKey) body.apiKey = apiKey
  return api.post('/classify/download', body, { timeout: 120000 })
}

// ── QB ──

export function getQBStatus() {
  return api.get('/qb/status')
}

export function getQBTorrents(category) {
  return api.get('/qb/torrents', { params: category ? { category } : {} })
}

export function qbAdd(item) {
  return api.post('/qb/add', item)
}

export function qbAnime(torrents) {
  return api.post('/qb/anime', { torrents })
}

export function qbDelete(hash) {
  return api.delete(`/qb/torrents/${hash}`)
}

export function qbRename(hash, name) {
  return api.post('/qb/rename', { hash, name })
}

export function getAnimeTorrents() {
  return api.get('/qb/anime-torrents')
}

export function getDownloadHashes() {
  return api.get('/qb/download-hashes')
}

// ── 发现页（番剧推荐） ──

export function getDiscoverModules() {
  return api.get('/discover/modules')
}

export function getDiscoverModule(module, refresh) {
  return api.get('/discover', { params: { module, refresh } })
}

export default api
