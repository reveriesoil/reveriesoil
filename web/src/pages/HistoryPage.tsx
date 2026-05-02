import React, { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { getHistory, deleteGame, getActiveTask } from '../api'
import type { GameSummary } from '../types'

const STATUS_LABEL: Record<string, string> = {
  pending: '排队中',
  generating: '生成中',
  ready: '已完成',
  failed: '生成失败',
}
const STATUS_COLOR: Record<string, string> = {
  pending: '#f59e0b',
  generating: '#3b82f6',
  ready: '#22c55e',
  failed: '#ef4444',
}

export default function HistoryPage() {
  const navigate = useNavigate()
  const [games, setGames] = useState<GameSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [enteringId, setEnteringId] = useState<string | null>(null)

  useEffect(() => {
    getHistory()
      .then(r => setGames(r.data))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  const handleEnter = async (game: GameSummary) => {
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
          navigate(`/play/${game.id}`)
        }
      } catch {
        navigate(`/play/${game.id}`)
      } finally {
        setEnteringId(null)
      }
    }
  }

  const handleDelete = async (id: string, e: React.MouseEvent) => {
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

  return (
    <div className="history-root">
      <div className="history-header">
        <button className="history-back-btn" onClick={() => navigate('/')} aria-label="返回">
          <svg viewBox="0 0 8 14" width="8" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M7 1 L1 7 L7 13" />
          </svg>
          返回
        </button>
        <h1 className="history-title">历史故事</h1>
        <div style={{ width: 64 }} />
      </div>

      <div className="history-body">
        {loading ? (
          <div className="empty-state" style={{ marginTop: 80 }}>
            <div className="spinner" style={{ width: 32, height: 32 }} />
          </div>
        ) : games.length === 0 ? (
          <div className="empty-state" style={{ marginTop: 80 }}>
            <div style={{ fontSize: 48, marginBottom: 12 }}>📖</div>
            <p className="text-muted">还没有故事记录</p>
            <button className="btn btn-primary" style={{ marginTop: 20 }} onClick={() => navigate('/')}>去创作第一个故事</button>
          </div>
        ) : (
          <motion.div className="history-list"
            initial="hidden" animate="show"
            variants={{ hidden: {}, show: { transition: { staggerChildren: 0.06 } } }}
          >
            <AnimatePresence>
              {games.map(game => (
                <motion.div
                  key={game.id}
                  className="history-card"
                  layout
                  variants={{ hidden: { opacity: 0, y: 16 }, show: { opacity: 1, y: 0 } }}
                  exit={{ opacity: 0, scale: 0.96, transition: { duration: 0.2 } }}
                  onClick={() => handleEnter(game)}
                  style={{ cursor: enteringId === game.id ? 'wait' : 'pointer' }}
                  whileHover={{ scale: 1.015 }}
                  whileTap={{ scale: 0.99 }}
                >
                  {game.cover_image_url ? (
                    <img className="history-card-cover" src={game.cover_image_url} alt="" draggable={false} />
                  ) : (
                    <div className="history-card-cover history-card-cover--placeholder">
                      <span>🌙</span>
                    </div>
                  )}
                  <div className="history-card-info">
                    <div className="history-card-title">{game.title || '未命名故事'}</div>
                    <div className="history-card-meta">
                      <span className="history-card-status" style={{ color: STATUS_COLOR[game.status] ?? '#888' }}>
                        ● {STATUS_LABEL[game.status] ?? game.status}
                      </span>
                      <span className="history-card-date">{new Date(game.created_at).toLocaleDateString('zh-CN')}</span>
                    </div>
                    {game.status === 'failed' && (
                      <div className="history-card-failed">生成失败，可点击重试</div>
                    )}
                  </div>
                  <div className="history-card-actions" onClick={e => e.stopPropagation()}>
                    {(game.status === 'ready' || game.status === 'failed') && (
                      <button
                        className="history-delete-btn"
                        onClick={e => handleDelete(game.id, e)}
                        disabled={deletingId === game.id}
                        aria-label="删除"
                        title="删除"
                      >
                        {deletingId === game.id ? (
                          <div className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }} />
                        ) : (
                          <svg viewBox="0 0 14 16" width="13" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M1 4h12M5 4V2h4v2M2 4l1 10h8l1-10M6 7v5M8 7v5" />
                          </svg>
                        )}
                      </button>
                    )}
                  </div>
                </motion.div>
              ))}
            </AnimatePresence>
          </motion.div>
        )}
      </div>
    </div>
  )
}
