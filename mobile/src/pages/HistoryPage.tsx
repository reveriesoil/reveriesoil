import React, { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { listGames, deleteGame } from '../services/db'
import type { GameRecord } from '../types'

// ─── 颜色预设（无封面时使用）──────────────────────────────────────────────────
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
  let h = 0
  for (let i = 0; i < id.length; i++) h = id.charCodeAt(i) + ((h << 5) - h)
  return CARD_GRADIENTS[Math.abs(h) % CARD_GRADIENTS.length]
}

function statusBadge(s: string) {
  if (s === 'done') return <span className="uh-card-status" style={{ background: 'rgba(34,197,94,0.15)', color: '#4ade80' }}>已完成</span>
  if (s === 'generating') return <span className="uh-card-status" style={{ background: 'rgba(245,158,11,0.15)', color: '#fbbf24' }}>生成中</span>
  if (s === 'error') return <span className="uh-card-status" style={{ background: 'rgba(239,68,68,0.15)', color: '#f87171' }}>失败</span>
  return null
}

function fmtDate(str: string) {
  try { return new Date(str).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) }
  catch { return str }
}

const cardVariants = {
  hidden: { opacity: 0, y: 20, scale: 0.97 },
  show: { opacity: 1, y: 0, scale: 1, transition: { duration: 0.3, ease: 'easeOut' as const } },
}

// ─── 图标 ─────────────────────────────────────────────────────────────────────
const IconBack = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
    <path d="M10 12L6 8l4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
)
const IconTrash = () => (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
    <path d="M3 4.5h10M6 4.5V3h4v1.5M5.5 4.5l.5 8h4l.5-8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
)
const IconPlay = () => (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
    <path d="M5 3.5l8 4.5-8 4.5V3.5z" fill="currentColor"/>
  </svg>
)
const IconRetry = () => (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
    <path d="M3 8a5 5 0 1 0 1.5-3.5L3 3v3h3L4.7 4.7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
)

export default function HistoryPage() {
  const navigate = useNavigate()
  const [games, setGames] = useState<GameRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null)

  const showToast = (msg: string, ok = true) => {
    setToast({ msg, ok })
    setTimeout(() => setToast(null), 2800)
  }

  useEffect(() => {
    listGames()
      .then(setGames)
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  const handlePlay = (game: GameRecord) => {
    if (game.status === 'done') {
      navigate(`/play/${game.id}`)
    } else if (game.status === 'generating') {
      navigate(`/generating/${game.id}`)
    }
    // 失败状态点击进入重试（从 LandingPage 发起）
  }

  const handleDelete = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation()
    if (!confirm('确定删除这条故事记录？此操作不可撤销。')) return
    setDeletingId(id)
    try {
      await deleteGame(id)
      setGames(prev => prev.filter(g => g.id !== id))
      showToast('记录已删除')
    } catch {
      showToast('删除失败', false)
    } finally {
      setDeletingId(null)
    }
  }

  return (
    <div className="uh-root">
      {/* Toast */}
      <AnimatePresence>
        {toast && (
          <motion.div
            key="toast"
            className={`uh-toast uh-toast--${toast.ok ? 'ok' : 'fail'}`}
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.2 }}
          >
            {toast.msg}
          </motion.div>
        )}
      </AnimatePresence>

      {/* 顶部栏 */}
      <div className="uh-header">
        <button className="uh-back-btn" onClick={() => navigate('/')}>
          <IconBack /> 返回
        </button>
        <span className="uh-title">故事历史</span>
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>共 {games.length} 条</span>
      </div>

      {/* 内容区 */}
      <div className="uh-body">
        {loading && (
          <div style={{ textAlign: 'center', paddingTop: 60 }}>
            <div className="spinner" style={{ width: 28, height: 28, margin: '0 auto' }} />
          </div>
        )}

        {!loading && games.length === 0 && (
          <div className="uh-empty">
            <div className="uh-empty-icon">📖</div>
            <div className="uh-empty-title">还没有故事记录</div>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>回到首页开始创作第一个故事吧</div>
          </div>
        )}

        {!loading && games.length > 0 && (
          <motion.div
            className="uh-grid"
            initial="hidden"
            animate="show"
            variants={{ show: { transition: { staggerChildren: 0.05 } } }}
          >
            {games.map(game => {
              const coverBg = game.cover_url || game.cover_image_url
                ? `url(${game.cover_url || game.cover_image_url}) center/cover no-repeat`
                : getGradient(game.id)

              return (
                <motion.div
                  key={game.id}
                  className="uh-card"
                  variants={cardVariants}
                  onClick={() => handlePlay(game)}
                >
                  {/* 封面 */}
                  <div className="uh-card-cover" style={{ background: coverBg }}>
                    {statusBadge(game.status)}
                  </div>

                  {/* 卡片内容 */}
                  <div className="uh-card-body">
                    <div className="uh-card-title">{game.title || '无题故事'}</div>
                    <div className="uh-card-prompt">{game.prompt}</div>
                  </div>

                  {/* 底部操作 */}
                  <div className="uh-card-footer">
                    <span className="uh-card-date">{fmtDate(game.created_at)}</span>
                    <div className="uh-card-actions">
                      {game.status === 'done' && (
                        <button
                          className="uh-action-btn"
                          onClick={e => { e.stopPropagation(); navigate(`/play/${game.id}`) }}
                          title="开始游戏"
                        >
                          <IconPlay /> 游玩
                        </button>
                      )}
                      {game.status === 'generating' && (
                        <button
                          className="uh-action-btn"
                          onClick={e => { e.stopPropagation(); navigate(`/generating/${game.id}`) }}
                          title="查看生成进度"
                        >
                          <IconRetry /> 进度
                        </button>
                      )}
                      <button
                        className="uh-action-btn uh-action-btn--danger"
                        onClick={e => handleDelete(game.id, e)}
                        disabled={deletingId === game.id}
                        title="删除"
                      >
                        {deletingId === game.id ? <span className="spinner" style={{ width: 10, height: 10 }} /> : <IconTrash />}
                        删除
                      </button>
                    </div>
                  </div>
                </motion.div>
              )
            })}
          </motion.div>
        )}
      </div>
    </div>
  )
}
