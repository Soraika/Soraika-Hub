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

export function getSubDetail(bgmid) {
  return api.get(`/mikan/subdetail/${bgmid}`)
}

export function getBangumiRSS(bangumiId, subgroupId) {
  return api.get(`/mikan/rss/${bangumiId}/${subgroupId}`)
}

export function searchMikan(keyword) {
  return api.get('/mikan/search', { params: { q: keyword } })
}

// ── BGM ──

export function getBgmSubject(id) {
  return api.get(`/bgm/subject/${id}`)
}

// ── AI ──

export function classifyTitles(titles, apiKey) {
  const body = { titles }
  if (apiKey) body.apiKey = apiKey
  return api.post('/classify', body)
}

// ── QB ──

export function getQBStatus() {
  return api.get('/qb/status')
}

export function getQBTorrents() {
  return api.get('/qb/torrents')
}

export function qbAdd(item) {
  return api.post('/qb/add', item)
}

export function qbAnime(torrents) {
  return api.post('/qb/anime', { torrents })
}

export function qbRename(hash, name) {
  return api.post('/qb/rename', { hash, name })
}

export default api