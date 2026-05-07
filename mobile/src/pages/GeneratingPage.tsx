/**
 * GeneratingPage (mobile) — 本地生成进度监控页
 * 不轮询 HTTP，订阅 generationStore 获取实时进度
 */
import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { motion } from 'framer-motion'
import { subscribe, getCurrentProgress, getCurrentGameId, isRunning } from '../services/generationStore'
import type { ProgressUpdate } from '../services/orchestrator'
import { getGame } from '../services/db'

// ── Icons ──────────────────────────────────────────────────────────────────────
const IconBook    = () => <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M2 3h5a1 1 0 0 1 1 1v9a1 1 0 0 0-1-1H2V3z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/><path d="M14 3H9a1 1 0 0 0-1 1v9a1 1 0 0 1 1-1h5V3z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/></svg>
const IconSearch  = () => <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="7" cy="7" r="4" stroke="currentColor" strokeWidth="1.3"/><path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg>
const IconBrush   = () => <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M11 2l3 3-6 6H5v-3l6-6z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/><path d="M3 14c1-1 2-2 2-3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/></svg>
const IconPen     = () => <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M10.5 2.5l3 3-8 8H2v-3l8-8z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/></svg>
const IconBubble  = () => <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M2 3a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H6l-3 3V3z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/></svg>
const IconPerson  = () => <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="4.5" r="2.5" stroke="currentColor" strokeWidth="1.3"/><path d="M3 14C3 11.24 5.24 9 8 9S13 11.24 13 14" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg>
const IconMountain= () => <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M1.5 13.5L6 5.5L9.5 10L11.5 7.5L14.5 13.5H1.5Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/><circle cx="12.5" cy="4" r="1.5" stroke="currentColor" strokeWidth="1.1"/></svg>
const IconGem     = () => <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 2L12.5 6L8 14L3.5 6L8 2Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/><path d="M3.5 6H12.5M6 6L8 2M10 6L8 2" stroke="currentColor" strokeWidth="1" strokeOpacity="0.5"/></svg>
const IconBox     = () => <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M14 5.5L12 2.5H4L2 5.5H14Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/><path d="M2 5.5V13H14V5.5" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/><path d="M6.5 5.5V9H9.5V5.5" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round"/></svg>

const STEPS = [
  { key: 'outline',        label: '故事大纲',   desc: 'AI 构思故事框架与角色关系',   icon: <IconBook />,      threshold: 5  },
  { key: 'reviewing',      label: '剧情校验',   desc: '检验逻辑连贯性与前后一致性',  icon: <IconSearch />,    threshold: 12 },
  { key: 'directing',      label: '艺术风格',   desc: '定制整体画风与美术基调',      icon: <IconBrush />,     threshold: 18 },
  { key: 'exec_directing', label: '绘图提示词', desc: '为每一幕生成精准绘图指令',    icon: <IconPen />,       threshold: 25 },
  { key: 'storyboard',     label: '完整台词',   desc: '创作所有场景对话与旁白',      icon: <IconBubble />,    threshold: 30 },
  { key: 'portraits',      label: '角色立绘',   desc: 'AI 绘制每位角色的多状态立绘', icon: <IconPerson />,    threshold: 50 },
  { key: 'backgrounds',    label: '场景背景',   desc: '渲染故事中的所有场景图',      icon: <IconMountain />,  threshold: 65 },
  { key: 'cg_images',      label: 'CG 图',      desc: '生成关键剧情的精美 CG',       icon: <IconGem />,       threshold: 78 },
  { key: 'done',           label: '打包完成',   desc: '整合资源，生成可游玩游戏',    icon: <IconBox />,       threshold: 100 },
]

function formatElapsed(s: number) {
  const m = Math.floor(s / 60)
  const sec = s % 60
  return m > 0 ? `${m}分${sec.toString().padStart(2, '0')}秒` : `${sec}秒`
}

export default function GeneratingPage() {
  const { gameId } = useParams<{ gameId: string }>()
  const navigate = useNavigate()

  const [progress, setProgress] = useState<ProgressUpdate>(() => getCurrentProgress())
  const [elapsed, setElapsed] = useState(0)
  const [bgToast, setBgToast] = useState('')
  const startRef = useRef(Date.now())
  const resolvedGameId = useRef<string | null>(null)

  // 后台切换提示
  useEffect(() => {
    let wasHidden = false
    const onVisibility = () => {
      if (document.hidden) { wasHidden = true }
      else if (wasHidden) {
        wasHidden = false
        setBgToast('⚡ 已返回 — 生成仍在进行中')
        setTimeout(() => setBgToast(''), 3000)
      }
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [])

  // 跟踪实际 gameId（pending 时等 store 更新）
  useEffect(() => {
    const gid = getCurrentGameId()
    if (gid && gid !== 'pending' && gid !== '__pending__') {
      resolvedGameId.current = gid
    }
  })

  // 订阅进度
  useEffect(() => {
    const unsub = subscribe(update => {
      setProgress(update)

      // 更新 resolvedGameId
      const gid = getCurrentGameId()
      if (gid && gid !== 'pending' && gid !== '__pending__') {
        resolvedGameId.current = gid
      }

      if (update.step === 'done') {
        const finalId = resolvedGameId.current ?? gid ?? gameId
        if (finalId && finalId !== '__pending__') {
          setTimeout(() => navigate(`/play/${finalId}`, { replace: true }), 800)
        }
      }
      if (update.step === 'error') {
        // 错误时停留在页面，显示错误信息
      }
    })
    return unsub
  }, [navigate, gameId])

  // 如果直接访问此页面但没有运行中的生成（例如刷新），检查 DB
  useEffect(() => {
    if (!isRunning()) {
      const gid = gameId && gameId !== '__pending__' ? gameId : getCurrentGameId()
      if (gid && gid !== '__pending__') {
        getGame(gid).then(g => {
          if (g?.status === 'done') navigate(`/play/${gid}`, { replace: true })
          else if (!isRunning()) navigate('/', { replace: true })
        }).catch(() => navigate('/', { replace: true }))
      } else if (!isRunning()) {
        navigate('/', { replace: true })
      }
    }
  }, [gameId, navigate])

  // 计时器
  useEffect(() => {
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - startRef.current) / 1000)), 1000)
    return () => clearInterval(id)
  }, [])

  const pct = Math.min(100, Math.max(0, progress.progress))
  const isError = progress.step === 'error'

  // 当前激活步骤
  const activeStep = (() => {
    if (isError) return null
    for (let i = STEPS.length - 1; i >= 0; i--) {
      if (pct >= STEPS[i].threshold) return STEPS[i]
    }
    return STEPS[0]
  })()

  return (
    <div className="gen-root">
      <div className="gen-bg" />

      {/* 后台返回提示 */}
      {bgToast && <div className="vn-bg-toast">{bgToast}</div>}

      <div className="gen-content">
        <motion.div className="gen-title-area"
          initial={{ opacity: 0, y: -12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5 }}
        >
          <div className="gen-title">✨ 正在创作你的故事…</div>
          <div className="gen-elapsed">{formatElapsed(elapsed)}</div>
        </motion.div>

        {/* 进度条 */}
        <div className="gen-bar-wrap">
          <div className="gen-bar-track">
            <motion.div
              className="gen-bar-fill"
              style={{ width: `${pct}%` }}
              animate={{ width: `${pct}%` }}
              transition={{ duration: 0.6, ease: 'easeOut' }}
            />
          </div>
          <div className="gen-bar-pct">{pct}%</div>
        </div>

        {/* 当前步骤提示 */}
        {isError ? (
          <div className="gen-error-box">
            <div className="gen-error-title">生成失败</div>
            <div className="gen-error-msg">{progress.error ?? '发生未知错误，请返回重试'}</div>
            <button className="gen-back-btn" onClick={() => navigate('/')}>← 返回首页</button>
          </div>
        ) : (
          <div className="gen-step-info">
            <div className="gen-step-icon">{activeStep?.icon}</div>
            <div>
              <div className="gen-step-label">{activeStep?.label ?? '初始化…'}</div>
              <div className="gen-step-desc">{activeStep?.desc ?? ''}</div>
              {progress.model && (
                <div className="gen-step-model">模型：{progress.model}</div>
              )}
            </div>
          </div>
        )}

        {/* 步骤列表 */}
        <div className="gen-steps-list">
          {STEPS.map(step => {
            const done = pct >= step.threshold
            const active = step === activeStep && !isError
            return (
              <div key={step.key} className={`gen-step-row${done ? ' gen-step-row--done' : ''}${active ? ' gen-step-row--active' : ''}`}>
                <div className="gen-step-row-icon">{step.icon}</div>
                <div className="gen-step-row-text">
                  <span className="gen-step-row-label">{step.label}</span>
                  {active && <span className="gen-step-row-badge">进行中</span>}
                  {done && !active && <span className="gen-step-row-check">✓</span>}
                </div>
              </div>
            )
          })}
        </div>

        <div className="gen-hint">请勿关闭应用，生成过程在本地运行中</div>
      </div>
    </div>
  )
}
