import React, { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { getHistory, deleteGame, getActiveTask, retryGame, exportGame, importGame, getGameStats } from '../api'
import type { GameSummary, GameStats } from '../types'

// 暖色渐变预设，为无封面的游戏卡片随机选取（与闭源版保持一致）
const CARD_GRADIENTS = [
  'linear-gradient(160deg, #1e1000 0%, #3d2200 100%)',
  'linear-gradient(160deg, #0a1a10 0%, #1a3d20 100%)',
  'linear-gradient(160deg, #1a0808 0%, #3d1212 100%)',
  'linear-gradient(160deg, #0f0f1a 0%, #1f1530 100%)',
  'linear-gradient(160deg, #1a1500 0%, #3a2e00 100%)',
  'linear-gradient(160deg, #120810 0%, #2d1838 100%)',
  'linear-gradient(160deg, #0a1618 0%, #1a3038 100%)',
  'linear-gradient(160deg, #180c00 0%, #3a1c00 100%)',
]

function getGradient(id: string) {
  let hash = 0
  for (let i = 0; i < id.length; i++) hash = id.charCodeAt(i) + ((hash << 5) - hash)
  return CARD_GRADIENTS[Math.abs(hash) % CARD_GRADIENTS.length]
}

function statusBadge(s: string) {
  if (s === 'generating' || s === 'pending') return (
    <span className="uh-card-status" style={{ background: 'rgba(245,158,11,0.15)', color: '#fbbf24' }}>生成中</span>
  )
  if (s === 'failed' || s === 'error') return (
    <span className="uh-card-status" style={{ background: 'rgba(239,68,68,0.15)', color: '#f87171' }}>失败</span>
  )
  if (s === 'cancelled') return (
    <span className="uh-card-status" style={{ background: 'rgba(148,163,184,0.15)', color: '#cbd5e1' }}>已取消</span>
  )
  return null
}

function isFailedStatus(status: string) {
  return status === 'error' || status === 'failed'
}

const cardVariants = {
  hidden: { opacity: 0, y: 24, scale: 0.97 },
  show: { opacity: 1, y: 0, scale: 1, transition: { duration: 0.35, ease: 'easeOut' as const } },
}

// ── 图标 ──────────────────────────────────────────────────────────────────────
const IconExport = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden>
    <path d="M8 11V3M5 6l3-3 3 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
    <path d="M3 11v1.5A1.5 1.5 0 0 0 4.5 14h7a1.5 1.5 0 0 0 1.5-1.5V11" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
  </svg>
)

const IconInfo = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden>
    <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.4"/>
    <line x1="8" y1="7" x2="8" y2="11.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
    <circle cx="8" cy="4.8" r="0.8" fill="currentColor"/>
  </svg>
)

const IconImport = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
    <path d="M8 3v8M5 8l3 3 3-3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
    <path d="M3 11v1.5A1.5 1.5 0 0 0 4.5 14h7a1.5 1.5 0 0 0 1.5-1.5V11" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
  </svg>
)

export default function HistoryPage() {
  const navigate = useNavigate()
  const [games, setGames] = useState<GameSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [enteringId, setEnteringId] = useState<string | null>(null)
  const [exportingId, setExportingId] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null)
  const importInputRef = useRef<HTMLInputElement>(null)
  // 统计弹窗
  const [statsGameId, setStatsGameId] = useState<string | null>(null)
  const [statsData, setStatsData] = useState<GameStats | null>(null)
  const [statsLoading, setStatsLoading] = useState(false)

  const showToast = (msg: string, ok = true) => {
    setToast({ msg, ok })
    setTimeout(() => setToast(null), 3000)
  }

  useEffect(() => {
    getHistory()
      .then(r => setGames(r.data))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  const handlePlay = async (game: GameSummary) => {
    if (enteringId) return
    if (game.status === 'ready') {
      navigate(`/play/${game.id}`)
      return
    }
    if (game.status === 'generating' || game.status === 'pending') {
      setEnteringId(game.id)
      try {
        const res = await getActiveTask(game.id)
        const task = res.data?.task
        if (task?.id) {
          navigate(`/generating/${game.id}?task_id=${task.id}`)
        } else {
          navigate(`/generating/${game.id}`)
        }
      } catch {
        navigate(`/generating/${game.id}`)
      } finally {
        setEnteringId(null)
      }
      return
    }
    if (isFailedStatus(game.status)) {
      setEnteringId(game.id)
      try {
        const res = await retryGame(game.id)
        navigate(`/generating/${game.id}?task_id=${res.data.task_id}`)
      } catch {
        navigate(`/generating/${game.id}`)
      } finally {
        setEnteringId(null)
      }
    }
  }

  const handleDeleteClick = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation()
    if (!confirm('确定删除这条故事记录？此操作不可撤销。')) return
    setDeletingId(id)
    try {
      await deleteGame(id)
      setGames(prev => prev.filter(g => g.id !== id))
    } catch {
      alert('删除失败，请稍后重试')
    } finally {
      setDeletingId(null)
    }
  }

  const handleInfo = async (g: GameSummary, e: React.MouseEvent) => {
    e.stopPropagation()
    setStatsGameId(g.id)
    setStatsData(null)
    setStatsLoading(true)
    try {
      const res = await getGameStats(g.id)
      setStatsData(res.data)
    } catch {
      showToast('获取统计信息失败', false)
      setStatsGameId(null)
    } finally {
      setStatsLoading(false)
    }
  }

  const handleExport = async (g: GameSummary, e: React.MouseEvent) => {
    e.stopPropagation()
    if (exportingId) return
    setExportingId(g.id)
    try {
      const res = await exportGame(g.id)
      const blob = new Blob([res.data as BlobPart], { type: 'application/zip' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      const title = (g.title || 'story').replace(/[^\w\-\. ]/g, '').trim() || 'story'
      a.href = url
      a.download = `ReverieSoil_${title}.rsz`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
      showToast('故事已导出')
    } catch {
      showToast('导出失败，请稍后重试', false)
    } finally {
      setExportingId(null)
    }
  }

  const handleImportClick = () => {
    importInputRef.current?.click()
  }

  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = ''
    setImporting(true)
    try {
      const res = await importGame(file)
      const imported = res.data
      setGames(prev => [imported, ...prev])
      showToast(`「${imported.title || '故事'}」导入成功`)
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail
      showToast(msg || '导入失败，请检查文件格式', false)
    } finally {
      setImporting(false)
    }
  }

  return (
    <div className="uh-root">
      {/* Toast 提示 */}
      <AnimatePresence>
        {toast && (
          <motion.div
            key="toast"
            initial={{ opacity: 0, y: -16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -16 }}
            transition={{ duration: 0.25 }}
            style={{
              position: 'fixed', top: 16, left: '50%', transform: 'translateX(-50%)',
              zIndex: 9999, pointerEvents: 'none',
              background: toast.ok ? 'rgba(34,197,94,0.92)' : 'rgba(239,68,68,0.92)',
              color: '#fff', borderRadius: 8, padding: '8px 20px',
              fontSize: 13, fontWeight: 500, boxShadow: '0 4px 16px rgba(0,0,0,0.3)',
            }}
          >
            {toast.msg}
          </motion.div>
        )}
      </AnimatePresence>

      {/* 隐藏文件输入 */}
      <input
        ref={importInputRef}
        type="file"
        accept=".rsz,.zip"
        style={{ display: 'none' }}
        onChange={handleImportFile}
      />

      {/* 顶部导航栏 */}
      <header className="uh-topbar">
        <div className="uh-topbar-left">
          <button className="uh-back-btn" onClick={() => navigate('/')} title="返回主界面">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M19 12H5M12 5l-7 7 7 7"/></svg>
            返回
          </button>
          <span className="uh-logo">ReverieSoil</span>
        </div>
      </header>

      {/* 主内容 */}
      <main className="uh-content">
        {loading ? (
          <div className="uh-empty">
            <div className="spinner" style={{ width: 36, height: 36 }} />
          </div>
        ) : games.length === 0 ? (
          <motion.div
            className="uh-empty"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
          >
            <div className="uh-empty-icon">📖</div>
            <div className="uh-empty-title">还没有故事</div>
            <div className="uh-empty-desc">创作你的第一个视觉小说，让 AI 把想象变成现实</div>
            <button className="uh-start-btn" onClick={() => navigate('/')}>
              开始创作
            </button>
          </motion.div>
        ) : (
          <>
            <div className="uh-section-title">你的故事 · {games.length}</div>
            <motion.div
              className="uh-grid"
              variants={{ show: { transition: { staggerChildren: 0.06 } } }}
              initial="hidden"
              animate="show"
            >
              <AnimatePresence>
                {games.map(g => {
                  const cover = g.cover_url ?? g.cover_image_url
                  return (
                    <motion.div
                      key={g.id}
                      className="uh-card"
                      variants={cardVariants}
                      onClick={() => handlePlay(g)}
                      style={{ cursor: enteringId === g.id ? 'wait' : 'pointer' }}
                      exit={{ opacity: 0, scale: 0.96, transition: { duration: 0.2 } }}
                      layout
                    >
                      <div
                        className="uh-card-bg"
                        style={cover
                          ? { backgroundImage: `url(${cover})`, backgroundSize: 'cover', backgroundPosition: 'center' }
                          : { background: getGradient(g.id) }
                        }
                      />
                      <div className="uh-card-overlay" />
                      {/* 统计按钮 + 导出按钮 - 右上角 hover 显示 */}
                      {g.status === 'ready' && (
                        <>
                          <button
                            className="uh-info-btn"
                            title="故事统计"
                            onClick={e => handleInfo(g, e)}
                          >
                            <IconInfo />
                          </button>
                          <button
                            className="uh-export-btn"
                            title="导出故事文件"
                            onClick={e => handleExport(g, e)}
                            disabled={exportingId === g.id}
                          >
                            {exportingId === g.id ? (
                              <div className="spinner" style={{ width: 12, height: 12, borderWidth: 2 }} />
                            ) : (
                              <IconExport />
                            )}
                          </button>
                        </>
                      )}
                      <div className="uh-card-body">
                        <div className="uh-card-title">{g.title || '未命名故事'}</div>
                        <div className="uh-card-desc">{g.synopsis || g.prompt || '点击查看故事'}</div>
                        <div className="uh-card-footer">
                          <button
                            className="uh-play-btn"
                            onClick={e => { e.stopPropagation(); handlePlay(g) }}
                          >
                            {g.status === 'ready' ? '▶ 继续' : g.status === 'generating' || g.status === 'pending' ? '⏳ 生成中' : isFailedStatus(g.status) ? '↻ 重试' : '查看'}
                          </button>
                          {statusBadge(g.status)}
                          <button
                            className="uh-del-btn"
                            title="删除故事"
                            onClick={e => handleDeleteClick(g.id, e)}
                            disabled={deletingId === g.id}
                          >
                            {deletingId === g.id ? (
                              <div className="spinner" style={{ width: 12, height: 12, borderWidth: 2 }} />
                            ) : (
                              <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                                <path d="M2.5 4.5h11M6 4.5V3a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
                                <rect x="3.5" y="4.5" width="9" height="8.5" rx="1.25" stroke="currentColor" strokeWidth="1.3"/>
                                <line x1="6.5" y1="7" x2="6.5" y2="10.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
                                <line x1="9.5" y1="7" x2="9.5" y2="10.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
                              </svg>
                            )}
                          </button>
                        </div>
                      </div>
                    </motion.div>
                  )
                })}
              </AnimatePresence>

              {/* 导入故事卡片 */}
              <motion.div
                className="uh-card-new uh-card-import"
                variants={cardVariants}
                onClick={handleImportClick}
                style={{ opacity: importing ? 0.6 : 1 }}
              >
                {importing ? (
                  <div className="spinner" style={{ width: 28, height: 28, borderWidth: 2 }} />
                ) : (
                  <>
                    <div className="uh-card-new-icon" style={{ fontSize: 28 }}>
                      <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
                          <path d="M16 10v12M10 17l6 5 6-5" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/>
                        <path d="M6 22v3a3 3 0 0 0 3 3h14a3 3 0 0 0 3-3v-3" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"/>
                      </svg>
                    </div>
                    <div className="uh-card-new-label">导入故事</div>
                  </>
                )}
              </motion.div>
            </motion.div>
          </>
        )}
      </main>

      {/* ── 故事统计弹窗 ── */}
      <AnimatePresence>
        {statsGameId && (
          <>
            <motion.div
              style={{
                position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 9000,
              }}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
              onClick={() => setStatsGameId(null)}
            />
            <motion.div
              style={{
                position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)',
                zIndex: 9001, background: '#1a1a2e', border: '1px solid rgba(255,255,255,0.1)',
                borderRadius: 16, padding: '20px 24px', width: '90%', maxWidth: 380,
                boxShadow: '0 24px 60px rgba(0,0,0,0.5)',
              }}
              initial={{ opacity: 0, scale: 0.94 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.94 }}
              transition={{ duration: 0.18, ease: 'easeOut' }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                <span style={{ fontWeight: 600, fontSize: 16, color: 'rgba(255,255,255,0.9)' }}>故事统计</span>
                <button
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'rgba(255,255,255,0.5)', fontSize: 18, lineHeight: 1, padding: '0 2px' }}
                  onClick={() => setStatsGameId(null)}
                >×</button>
              </div>
              {statsLoading ? (
                <div style={{ display: 'flex', justifyContent: 'center', padding: '32px 0' }}>
                  <div className="spinner" style={{ width: 28, height: 28, borderWidth: 2 }} />
                </div>
              ) : statsData ? (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px 16px' }}>
                  {[
                    { label: '总图片数量', value: statsData.total_images, unit: '张' },
                    { label: '人物立绘数量', value: statsData.portrait_count, unit: '张' },
                    { label: '背景图数量', value: statsData.background_count, unit: '张' },
                    { label: 'CG 图数量', value: statsData.cg_count, unit: '张' },
                    { label: '消耗 Token', value: statsData.token_usage.toLocaleString(), unit: '' },
                    { label: '故事总字数', value: statsData.total_words.toLocaleString(), unit: '字' },
                    { label: '总幕数', value: statsData.scene_count, unit: '幕' },
                  ].map(item => (
                    <div key={item.label} style={{
                      background: 'rgba(255,255,255,0.04)', borderRadius: 8,
                      padding: '10px 14px', border: '1px solid rgba(255,255,255,0.07)',
                    }}>
                      <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.45)', marginBottom: 4 }}>{item.label}</div>
                      <div style={{ fontSize: 20, fontWeight: 600, color: 'rgba(255,255,255,0.9)' }}>
                        {item.value}<span style={{ fontSize: 12, fontWeight: 400, marginLeft: 2, color: 'rgba(255,255,255,0.5)' }}>{item.unit}</span>
                      </div>
                    </div>
                  ))}
                </div>
              ) : null}
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  )
}


