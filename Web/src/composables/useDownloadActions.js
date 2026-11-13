/**
 * 加种与改名 —— 面板里所有「会写 qB」的动作都收在这里
 * ---------------------------------------------------------------------------
 * 从 AnimeDetailPanel.vue 抽出来的：那个组件已经 1100 行，其中一半是
 * 「点下载 / 点改名 / 处理错误文案」这类和界面无关的状态机。
 *
 * 三条约定（界面上也靠它们说话）：
 *   · **任务名与文件名是两件事**：批量改名走 `renameDownloads`，单条改走 `renameTorrent`，
 *     两个名字各自独立提交，改一个不会碰到另一个。
 *   · 所有结果都变成**一句人话**放在 `*Msg` 里，不弹窗、不 toast —— 面板本来就窄。
 *   · 写完之后让外层重取一次列表（`onListChanged`），下载页不用手动刷新。
 *
 * @param {Object} options
 * @param {() => number|null} options.animeId       当前作品主键
 * @param {() => string} [options.subgroupName]     当前字幕组（加种时写进标签）
 * @param {() => number} [options.season]           季号（决定归档目录 Season NN）
 * @param {() => boolean} [options.isDownloads]     面板处在下载页模式？
 * @param {(id:number)=>void} [options.onListChanged] 改完之后重取清单（面板自己决定怎么取）
 * @param {(res:object)=>void} [options.onRefreshed]  把结果抛给页容器（下载页据此刷新）
 */
import { ref } from 'vue'
import { addDownloads, fetchAnimeDownloads, fetchTorrentNaming, renameDownloads, renameTorrent } from '@/api/downloads'

export function useDownloadActions({
  animeId,
  subgroupName = () => '',
  season = () => 1,
  isDownloads = () => false,
  onListChanged = () => {},
  onRefreshed = () => {},
} = {}) {
  /* ── 加种 ─────────────────────────────────────────────────────────────── */
  const downloading = ref(false)
  const downloadMsg = ref('')
  const downloadFailed = ref(false)

  /** 资源列表的「已下载」标记：按 **torrent hash** 判（同一集不同字幕组是不同种子） */
  const downloadedHashes = ref(new Set())

  async function loadDownloadedHashes(id) {
    downloadedHashes.value = new Set()
    if (!id) return
    try {
      const res = await fetchAnimeDownloads(id)
      const set = new Set()
      for (const item of res.items || []) if (item.hash) set.add(String(item.hash).toLowerCase())
      downloadedHashes.value = set
    } catch {
      /* 标记失败不影响列表 */
    }
  }

  function markAdded(list) {
    if (!list?.length) return
    const next = new Set(downloadedHashes.value)
    for (const item of list) if (item.hash) next.add(String(item.hash).toLowerCase())
    downloadedHashes.value = next
  }

  async function onDownload(items) {
    const list = Array.isArray(items) ? items : []
    const id = animeId()
    if (!list.length || downloading.value || !id) return

    downloading.value = true
    downloadMsg.value = ''
    downloadFailed.value = false
    try {
      const res = await addDownloads({
        animeId: id,
        subgroup: subgroupName(),
        season: season(),
        items: list.map((it) => ({
          title: it.title,
          magnet: it.magnet,
          torrentUrl: it.torrentUrl,
          episode: it.episode || '',
        })),
      })
      downloadFailed.value = res.failed.length > 0
      // 「已在列表里」不算失败（qB 5.x 对重复种子回 409）：分开说，免得以为没加上
      const existed = res.added.filter((it) => it.existed).length
      const fresh = res.added.length - existed
      const head = fresh
        ? `已加入 ${fresh} 个下载 → ${res.savePath}`
        : existed
          ? `已在下载列表中 ${existed} 个（没有重复添加）`
          : '没有加进任何下载'
      const notes = []
      if (existed && fresh) notes.push(`其中 ${existed} 个已存在`)
      if (res.failed.length) notes.push(`${res.failed.length} 条失败（${res.failed[0].title}：${res.failed[0].reason}）`)
      downloadMsg.value = head + (notes.length ? `；${notes.join('；')}` : '')
      markAdded(res.added)
      onRefreshed(res)
    } catch (err) {
      downloadFailed.value = true
      downloadMsg.value = `加种失败：${err.message}`
    } finally {
      downloading.value = false
    }
  }

  /* ── 批量改名（一部作品的全部种子）────────────────────────────────────── */
  const renaming = ref(false)
  const renameMsg = ref('')

  function refreshList() {
    const id = animeId()
    if (isDownloads() && id) onListChanged(id)
  }

  async function onRename() {
    const id = animeId()
    if (!id || renaming.value) return
    renaming.value = true
    renameMsg.value = ''
    try {
      const plan = await renameDownloads(id, { dryRun: true })
      if (!plan.plan.length) {
        renameMsg.value = plan.skipped.length ? `没有需要改名的（${plan.skipped[0].reason}）` : '没有需要改名的'
        return
      }
      const sample = plan.plan.slice(0, 3).map((it) => `· ${it.summary}｜${it.newName.slice(0, 28)}`).join('\n')
      const more = plan.plan.length > 3 ? `\n…共 ${plan.plan.length} 条` : ''
      const skip = plan.skipped.length ? `\n\n跳过 ${plan.skipped.length} 条（${plan.skipped[0].reason}）` : ''
      const ok = window.confirm(
        `将重命名 ${plan.plan.length} 条：\n${sample}${more}${skip}\n\n任务名保持旧格式，文件名为「番名 S01E01」。继续？`,
      )
      if (!ok) return
      const res = await renameDownloads(id, { dryRun: false })
      const failed = res.failed?.length || 0
      renameMsg.value = failed
        ? `已改 ${res.done.length} 条，失败 ${failed} 条（${res.failed[0].reason}）`
        : `已改 ${res.done.length} 条`
      refreshList()
      onRefreshed(res)
    } catch (err) {
      renameMsg.value = `重命名失败：${err.message}`
    } finally {
      renaming.value = false
    }
  }

  /* ── 单条改名（任务名 / 文件名分开）──────────────────────────────────── */
  const renameDraft = ref(null)
  const renameBusy = ref(false)
  const renameError = ref('')

  async function onRenameOpen(item) {
    if (!item?.hash || renameBusy.value) return
    renameError.value = ''
    if (renameDraft.value?.hash === item.hash) {
      renameDraft.value = null // 再点一次收起
      return
    }
    renameBusy.value = true
    try {
      renameDraft.value = await fetchTorrentNaming(item.hash)
    } catch (err) {
      renameError.value = `读不到这一条的详情：${err.message}`
    } finally {
      renameBusy.value = false
    }
  }

  function onRenameCancel() {
    renameDraft.value = null
    renameError.value = ''
  }

  async function onRenameApply({ hash, torrentName, files }) {
    if (!hash || renameBusy.value) return
    renameBusy.value = true
    renameError.value = ''
    try {
      const res = await renameTorrent(hash, { torrentName, files })
      if (res.failed?.length) {
        renameError.value = res.failed.map((f) => `${f.what}：${f.reason}`).join('；')
        return
      }
      const filesCount = res.done.filter((d) => d.what === '文件').length
      renameMsg.value = `已改：${[res.done.some((d) => d.what === '任务名') ? '任务名' : '', filesCount ? `${filesCount} 个文件` : '']
        .filter(Boolean)
        .join(' + ')}`
      renameDraft.value = null
      refreshList()
      onRefreshed(res)
    } catch (err) {
      renameError.value = `改名失败：${err.message}`
    } finally {
      renameBusy.value = false
    }
  }

  function resetMessages() {
    downloadMsg.value = ''
    downloadFailed.value = false
    renameMsg.value = ''
    renameError.value = ''
    downloadedHashes.value = new Set()
  }

  return {
    // 加种
    downloading,
    downloadMsg,
    downloadFailed,
    onDownload,
    downloadedHashes,
    loadDownloadedHashes,
    // 改名
    renaming,
    renameMsg,
    onRename,
    renameDraft,
    renameBusy,
    renameError,
    onRenameOpen,
    onRenameCancel,
    onRenameApply,
    resetMessages,
  }
}
