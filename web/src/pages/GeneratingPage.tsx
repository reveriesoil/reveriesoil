import React, { useEffect, useRef, useState, useCallback } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { getTaskStatus, retryGame, cancelTask, getActiveTask } from '../api'
import type { TaskStatus } from '../types'

// ── SVG Icons ──────────────────────────────────────────────────────────────

const IconBack = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
    <path d="M10 3L5 8L10 13" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
)

const IconLogoDream = () => (
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
    <path d="M9 2L10.5 7H16L11.5 10.5L13.5 16L9 12.5L4.5 16L6.5 10.5L2 7H7.5L9 2Z" fill="currentColor" fillOpacity="0.9"/>
  </svg>
)

const IconOrbRunning = () => (
  <svg width="46" height="46" viewBox="0 0 46 46" fill="none">
    <path d="M9 37L29 9" stroke="rgba(245,233,182,0.9)" strokeWidth="3.5" strokeLinecap="round"/>
    <path d="M29 9L30.5 15.5M29 9L23 12.5M29 9L35.5 10.5M29 9L25.5 3.5"
      stroke="rgba(245,233,182,0.8)" strokeWidth="2" strokeLinecap="round"/>
    <circle cx="16" cy="16" r="2.5" fill="rgba(245,233,182,0.5)"/>
    <circle cx="36" cy="32" r="1.8" fill="rgba(245,233,182,0.35)"/>
    <circle cx="22" cy="37" r="1.2" fill="rgba(245,233,182,0.4)"/>
  </svg>
)

const IconOrbDone = () => (
  <svg width="46" height="46" viewBox="0 0 46 46" fill="none">
    <path d="M10 23L19 34L36 12" stroke="rgba(245,233,182,0.95)" strokeWidth="4.5" strokeLinecap="round" strokeLinejoin="round"/>
    <circle cx="8" cy="10" r="2" fill="rgba(245,233,182,0.4)"/>
    <circle cx="39" cy="37" r="1.5" fill="rgba(245,233,182,0.3)"/>
  </svg>
)

const IconOrbFailed = () => (
  <svg width="46" height="46" viewBox="0 0 46 46" fill="none">
    <path d="M13 13L33 33M33 13L13 33" stroke="rgba(245,233,182,0.9)" strokeWidth="4" strokeLinecap="round"/>
  </svg>
)

const IconBook = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
    <rect x="3" y="2" width="8.5" height="11" rx="1" stroke="currentColor" strokeWidth="1.3"/>
    <path d="M11.5 3L13.5 4.5V13L11.5 14" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/>
    <path d="M5.5 5.5H9M5.5 7.5H9M5.5 9.5H7.5" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round"/>
  </svg>
)

const IconSearch = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
    <circle cx="6.5" cy="6.5" r="4" stroke="currentColor" strokeWidth="1.3"/>
    <path d="M9.5 9.5L13 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
  </svg>
)

const IconBrush = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
    <path d="M13.5 2L14.5 3L5.5 12H3V9.5L13.5 2Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/>
    <path d="M3 9.5C3 10.6 3.5 11.5 4.5 12C3.5 12.5 2.5 11.5 3 9.5Z" stroke="currentColor" strokeWidth="1" strokeLinejoin="round"/>
  </svg>
)

const IconPen = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
    <path d="M11.5 2L14 4.5L5.5 13H3V10.5L11.5 2Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/>
    <path d="M9.5 4L12 6.5" stroke="currentColor" strokeWidth="1" strokeOpacity="0.5" strokeLinecap="round"/>
  </svg>
)

const IconBubble = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
    <path d="M2.5 3.5A1 1 0 013.5 2.5H10A1 1 0 0111 3.5V7A1 1 0 0110 8H6.5L4 10.5V8H3.5A1 1 0 012.5 7V3.5Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/>
    <path d="M11 6H12.5A1 1 0 0113.5 7V10A1 1 0 0112.5 11H10.5L12.5 13V11" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round"/>
  </svg>
)

const IconPerson = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
    <circle cx="8" cy="4.5" r="2.5" stroke="currentColor" strokeWidth="1.3"/>
    <path d="M3 14C3 11.24 5.24 9 8 9S13 11.24 13 14" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
  </svg>
)

const IconMountain = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
    <path d="M1.5 13.5L6 5.5L9.5 10L11.5 7.5L14.5 13.5H1.5Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/>
    <circle cx="12.5" cy="4" r="1.5" stroke="currentColor" strokeWidth="1.1"/>
  </svg>
)

const IconGem = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
    <path d="M8 2L12.5 6L8 14L3.5 6L8 2Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/>
    <path d="M3.5 6H12.5M6 6L8 2M10 6L8 2" stroke="currentColor" strokeWidth="1" strokeOpacity="0.5"/>
  </svg>
)

const IconBox = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
    <path d="M14 5.5L12 2.5H4L2 5.5H14Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/>
    <path d="M2 5.5V13H14V5.5" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/>
    <path d="M6.5 5.5V9H9.5V5.5" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round"/>
  </svg>
)

const IconCheckSmall = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
    <path d="M3 7L5.5 10L11 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
)

const IconXSmall = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
    <path d="M4 4L10 10M10 4L4 10" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
  </svg>
)

// 步骤定义：key / 标签 / 描述 / 图标 / 完成进度阈值
const STEPS: Array<{ key: string; label: string; desc: string; icon: React.ReactNode; threshold: number }> = [
  { key: 'outline',        label: '故事大纲',   desc: 'AI 构思故事框架与角色关系',   icon: <IconBook />,      threshold: 5  },
  { key: 'reviewing',      label: '剧情校验',   desc: '检验逻辑连贯性与前后一致性',  icon: <IconSearch />,    threshold: 12 },
  { key: 'directing',      label: '艺术风格',   desc: '定制整体画风与美术基调',      icon: <IconBrush />,     threshold: 18 },
  { key: 'exec_directing', label: '绘图提示词', desc: '为每一幕生成精准绘图指令',    icon: <IconPen />,       threshold: 25 },
  { key: 'storyboard',     label: '完整台词',   desc: '创作所有场景对话与旁白',      icon: <IconBubble />,    threshold: 30 },
  { key: 'portraits',      label: '角色立绘',   desc: 'AI 绘制每位角色的多状态立绘', icon: <IconPerson />,    threshold: 50 },
  { key: 'backgrounds',    label: '场景背景',   desc: '渲染故事中的所有场景图',      icon: <IconMountain />,  threshold: 65 },
  { key: 'cg_images',      label: 'CG 图',      desc: '生成关键剧情的精美 CG',       icon: <IconGem />,       threshold: 72 },
  { key: 'packaging',      label: '打包完成',   desc: '整合资源，生成可游玩游戏',    icon: <IconBox />,       threshold: 100 },
]

type StepRecord = { step: string; startedAt: number; completedAt?: number; model?: string }

// ── 跨页面持久化（防止离开生成页再回来时计时归零） ─────────────────────────
type PersistedSession = { startTime: number; history: StepRecord[]; prevStep: string | null }
const PERSIST_KEY = (taskId: string) => `dreamit:gen:${taskId}`

function loadPersisted(taskId: string): PersistedSession | null {
  if (!taskId) return null
  try {
    const raw = localStorage.getItem(PERSIST_KEY(taskId))
    if (!raw) return null
    const parsed = JSON.parse(raw) as PersistedSession
    if (typeof parsed.startTime !== 'number' || !Array.isArray(parsed.history)) return null
    return parsed
  } catch { return null }
}

function savePersisted(taskId: string, session: PersistedSession) {
  if (!taskId) return
  try { localStorage.setItem(PERSIST_KEY(taskId), JSON.stringify(session)) } catch { /* quota */ }
}

function clearPersisted(taskId: string) {
  if (!taskId) return
  try { localStorage.removeItem(PERSIST_KEY(taskId)) } catch { /* ignore */ }
}

function formatDuration(ms: number) {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m ${s % 60}s`
}

function formatElapsed(seconds: number) {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return m > 0 ? `${m}分${s.toString().padStart(2, '0')}秒` : `${s}秒`
}

export default function GeneratingPage() {
  const { gameId } = useParams()
  const [searchParams, setSearchParams] = useSearchParams()
  const taskIdParam = searchParams.get('task_id') ?? ''
  const [taskId, setTaskId] = useState(taskIdParam)
  const navigate = useNavigate()

  // 惰性初始化：在首次渲染前同步从 localStorage 恢复，避免 save effect 抢在 load 之前覆盖
  const initialPersistedRef = useRef<PersistedSession | null>(taskIdParam ? loadPersisted(taskIdParam) : null)
  const initialPersisted = initialPersistedRef.current

  const [task, setTask] = useState<TaskStatus | null>(null)
  const [error, setError] = useState('')
  const [stepHistory, setStepHistory] = useState<StepRecord[]>(initialPersisted?.history ?? [])
  const [elapsed, setElapsed] = useState(
    initialPersisted ? Math.floor((Date.now() - initialPersisted.startTime) / 1000) : 0
  )
  const [retrying, setRetrying] = useState(false)
  const [cancelling, setCancelling] = useState(false)

  const pollRef = useRef<number | null>(null)
  const elapsedRef = useRef<number | null>(null)
  const startTimeRef = useRef<number>(initialPersisted?.startTime ?? Date.now())
  const prevStepRef = useRef<string | null>(initialPersisted?.prevStep ?? null)
  const taskIdRef = useRef<string>(taskId)
  // 闸门：未首次加载完就禁止 save，避免 setTaskId 触发的 save 用空数据覆盖已有持久化
  const loadedRef = useRef<boolean>(!!initialPersisted || !taskIdParam)

  // 任一变化时把当前进度持久化（按 taskId 索引），离开/刷新后回来即可恢复
  useEffect(() => { taskIdRef.current = taskId }, [taskId])
  useEffect(() => {
    if (!taskId) return
    if (!loadedRef.current) return
    savePersisted(taskId, {
      startTime: startTimeRef.current,
      history: stepHistory,
      prevStep: prevStepRef.current,
    })
  }, [taskId, stepHistory])

  // 更新步骤历史
  const updateStepHistory = useCallback((currentStep: string, currentModel?: string) => {
    if (currentStep === prevStepRef.current) {
      // 同一步骤内只补充 model（首次 polling 可能不带）
      if (currentModel) {
        setStepHistory(prev => prev.map(s =>
          s.step === currentStep && !s.model ? { ...s, model: currentModel } : s
        ))
      }
      return
    }
    prevStepRef.current = currentStep
    setStepHistory(prev => {
      // 如果已存在，不重复添加
      if (prev.some(s => s.step === currentStep)) return prev
      // 标记上一个步骤完成
      const updated = prev.map((s, i, arr) =>
        i === arr.length - 1 && !s.completedAt
          ? { ...s, completedAt: Date.now() }
          : s
      )
      return [...updated, { step: currentStep, startedAt: Date.now(), model: currentModel }]
    })
  }, [])

  const poll = useCallback(async () => {
    if (!taskId) {
      // 无 task_id 时尝试通过 game 查询活跃任务（直接进入 /generating/:gameId 时的兜底）
      if (!gameId) return
      try {
        const r = await getActiveTask(gameId)
        if (r.data.task) {
          setTaskId(r.data.task.id)
          setSearchParams({ task_id: r.data.task.id }, { replace: true })
        }
      } catch { /* ignore */ }
      return
    }
    try {
      const res = await getTaskStatus(taskId)
      const data = res.data
      setTask(data)

      if (data.current_step) updateStepHistory(data.current_step, data.current_model)

      if (data.status === 'done') {
        clearInterval(pollRef.current!)
        clearInterval(elapsedRef.current!)
        // 标记最后一步完成
        setStepHistory(prev =>
          prev.map((s, i, arr) =>
            i === arr.length - 1 && !s.completedAt ? { ...s, completedAt: Date.now() } : s
          )
        )
        clearPersisted(taskId)
        setTimeout(() => navigate(`/play/${gameId}`), 2000)
      } else if (data.status === 'failed' || data.status === 'cancelled') {
        clearInterval(pollRef.current!)
        clearInterval(elapsedRef.current!)
        clearPersisted(taskId)
        setError(data.error_msg ?? (data.status === 'cancelled' ? '已取消生成' : '生成失败，请重试'))
      } else if (data.script_ready) {
        navigate(`/play/${gameId}`)
      }
    } catch {
      setError('获取任务状态失败，请刷新页面重试')
    }
  }, [taskId, gameId, navigate, updateStepHistory])

  useEffect(() => {
    // 首次渲染已通过惰性初始化恢复；当 taskId 后来才出现（从 /generating/:gameId 兜底拿到）时，再次尝试恢复
    if (taskId && !loadedRef.current) {
      const persisted = loadPersisted(taskId)
      if (persisted) {
        startTimeRef.current = persisted.startTime
        prevStepRef.current = persisted.prevStep
        setStepHistory(persisted.history)
        setElapsed(Math.floor((Date.now() - persisted.startTime) / 1000))
      } else {
        startTimeRef.current = Date.now()
      }
      loadedRef.current = true
    }
    poll()
    pollRef.current = setInterval(poll, 3000) as unknown as number
    elapsedRef.current = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startTimeRef.current) / 1000))
    }, 1000) as unknown as number
    return () => {
      clearInterval(pollRef.current!)
      clearInterval(elapsedRef.current!)
    }
  }, [poll])

  const progress = task?.progress ?? 0
  const currentStep = task?.current_step ?? ''
  const isDone = task?.status === 'done'
  const isFailed = task?.status === 'failed' || task?.status === 'cancelled'

  // 判断每个步骤状态
  // 续传场景下后端返回的 current_step 已是 portraits/backgrounds 等图像阶段，
  // 前面的文本步骤都已在前一次任务完成，应自动标记为 done（即便本次任务的 stepHistory 中没有记录）
  const currentStepIdx = STEPS.findIndex(s => s.key === currentStep)
  const getStepStatus = (step: typeof STEPS[0]) => {
    if (isDone) return 'done'
    if (isFailed && step.key === currentStep) return 'failed'
    if (step.key === currentStep) return 'active'
    // 该步骤在本次任务的历史记录中
    if (stepHistory.some(s => s.step === step.key)) return 'done'
    // 当前 step 之前的步骤（按 STEPS 顺序）：续传时已在前一任务完成
    const thisIdx = STEPS.findIndex(s => s.key === step.key)
    if (currentStepIdx > 0 && thisIdx >= 0 && thisIdx < currentStepIdx) return 'done'
    return 'pending'
  }

  const currentStepDef = STEPS.find(s => s.key === currentStep)

  // 在当前 game 基础上重新触发生成
  const handleRetry = useCallback(async () => {
    if (!gameId || retrying) return
    setRetrying(true)
    setError('')
    try {
      const res = await retryGame(gameId)
      const { task_id, game_id } = res.data
      // 在原页面重置状态并切换 task_id（无需整页刷新）
      setTask(null)
      setStepHistory([])
      prevStepRef.current = null
      startTimeRef.current = Date.now()
      setElapsed(0)
      // 清掉旧 task 的持久化（防止串扰）
      if (taskIdRef.current) clearPersisted(taskIdRef.current)
      loadedRef.current = true  // retry 是全新计时，无需再尝试 load
      setTaskId(task_id)
      setSearchParams({ task_id }, { replace: true })
      if (game_id !== gameId) navigate(`/generating/${game_id}?task_id=${task_id}`, { replace: true })
    } catch (err: any) {
      const msg = err?.response?.data?.detail ?? '重试失败，请稍后再试'
      setError(msg)
    } finally {
      setRetrying(false)
    }
  }, [gameId, retrying, navigate, setSearchParams])

  const handleCancel = useCallback(async () => {
    if (!taskId || cancelling) return
    setCancelling(true)
    try {
      await cancelTask(taskId)
      clearInterval(pollRef.current!)
      clearInterval(elapsedRef.current!)
      setError('已取消生成')
      setTask(prev => prev ? { ...prev, status: 'cancelled' } : prev)
    } catch (err: any) {
      const msg = err?.response?.data?.detail ?? '取消失败，请重试'
      setError(msg)
    } finally {
      setCancelling(false)
    }
  }, [taskId, cancelling])

  return (
    <div className="generating-page">
      {/* 顶部 Header */}
      <div className="gen-header">
        <div className="gen-logo"><IconLogoDream /> ReverieSoil 梦壤</div>
        <button className="gen-back-btn" onClick={() => navigate('/')}><IconBack /> 返回</button>
      </div>

      <div className="gen-body">
        {/* 左侧：整体进度概览 */}
        <div className="gen-overview">
          <div className={`gen-orb ${isDone ? 'done' : isFailed ? 'failed' : 'pulsing'}`}>
            {isDone ? <IconOrbDone /> : isFailed ? <IconOrbFailed /> : <IconOrbRunning />}
          </div>

          <h2 className="gen-title">
            {isDone ? '游戏生成完成！' : isFailed ? '生成失败' : '正在生成你的游戏'}
          </h2>
          <p className="gen-subtitle">
            {isDone
              ? '即将进入游戏...'
              : isFailed
              ? error
              : currentStepDef
              ? <><span className="gen-subtitle-icon">{currentStepDef.icon}</span>{currentStepDef.label} — {currentStepDef.desc}</>
              : 'AI 正在为你创作专属视觉小说'}
          </p>

          {/* 总进度条 */}
          <div className="gen-progress-wrap">
            <div className="gen-progress-header">
              <span>总进度</span>
              <span className="gen-progress-pct">{progress}%</span>
            </div>
            <div className="gen-progress-track">
              <div
                className={`gen-progress-fill ${isDone ? 'done' : ''}`}
                style={{ width: `${progress}%` }}
              />
            </div>
          </div>

          {/* 计时器 */}
          <div className="gen-timer-row">
            <div className="gen-timer-item">
              <span className="gen-timer-label">已用时</span>
              <span className="gen-timer-value">{formatElapsed(elapsed)}</span>
            </div>
            <div className="gen-timer-sep" />
            <div className="gen-timer-item">
              <span className="gen-timer-label">已消耗</span>
              <span className="gen-timer-value">
                {task?.token_usage ? task.token_usage.toLocaleString() + ' tokens' : '—'}
              </span>
            </div>
            <div className="gen-timer-sep" />
            <div className="gen-timer-item">
              <span className="gen-timer-label">状态</span>
              <span className={`gen-timer-value ${isDone ? 'status-done' : isFailed ? 'status-failed' : 'status-running'}`}>
                {isDone ? '已完成' : isFailed ? '失败' : task?.status === 'pending' ? '等待中' : '运行中'}
              </span>
            </div>
          </div>

          {isFailed && (
            <div className="gen-retry-panel">
              <p className="gen-retry-hint">请选择重试方式：</p>
              <div className="gen-retry-buttons">
                <button
                  className="gen-retry-btn-primary"
                  disabled={retrying}
                  onClick={handleRetry}
                >
                  {retrying ? '正在继续…' : '继续生成'}
                </button>
                <button
                  className="gen-retry-btn-secondary"
                  disabled={retrying}
                  onClick={() => navigate('/')}
                >
                  从头开始
                </button>
              </div>
            </div>
          )}

          {/* 等待超时提示：pending 超过 60 秒可能 AI Key 未配置或服务异常 */}
          {!isDone && !isFailed && task?.status === 'pending' && elapsed >= 60 && (
            <div className="gen-retry-panel" style={{ marginTop: 12 }}>
              <p className="gen-retry-hint" style={{ color: 'rgba(245,233,182,0.75)', fontSize: 13 }}>
                ⚠️ 已等待超过 60 秒，AI 服务可能未响应<br />
                请检查「设置」中的 API Key 是否正确，或点击停止后重试
              </p>
            </div>
          )}

          {/* 取消生成按钮（仅在运行中显示） */}
          {!isDone && !isFailed && (
            <button
              className="gen-cancel-btn"
              disabled={cancelling}
              onClick={handleCancel}
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" style={{ marginRight: 5 }}>
                <rect x="4" y="4" width="6" height="6" rx="1" stroke="currentColor" strokeWidth="1.4"/>
              </svg>
              {cancelling ? '正在取消…' : '停止生成'}
            </button>
          )}
        </div>

        {/* 右侧：步骤时间轴 */}
        <div className="gen-timeline">
          <div className="gen-timeline-title">生成步骤</div>
          {STEPS.map((step, idx) => {
            const status = getStepStatus(step)
            const record = stepHistory.find(s => s.step === step.key)
            const duration = record?.completedAt
              ? formatDuration(record.completedAt - record.startedAt)
              : null

            return (
              <div key={step.key} className={`gen-step gen-step-${status}`}>
                {/* 连线 */}
                {idx < STEPS.length - 1 && (
                  <div className={`gen-step-line gen-step-line-${status === 'done' ? 'done' : 'pending'}`} />
                )}

                {/* 状态圆点 */}
                <div className={`gen-step-dot gen-step-dot-${status}`}>
                  {status === 'done' && <span className="gen-step-check"><IconCheckSmall /></span>}
                  {status === 'active' && <span className="gen-step-spinner" />}
                  {status === 'failed' && <span className="gen-step-check"><IconXSmall /></span>}
                  {status === 'pending' && <span className="gen-step-idx">{idx + 1}</span>}
                </div>

                {/* 内容 */}
                <div className="gen-step-content">
                  <div className="gen-step-label">
                    <span className="gen-step-icon">{step.icon}</span>
                    {step.label}
                    {duration && <span className="gen-step-duration">{duration}</span>}
                    {record?.model && <span className="gen-step-model" title={`调用模型：${record.model}`}>{record.model}</span>}
                    {status === 'active' && <span className="gen-step-badge-active">进行中</span>}
                  </div>
                  <div className="gen-step-desc">{step.desc}</div>
                  {record && (
                    <div className="gen-step-time">
                      开始于 {new Date(record.startedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                      {record.completedAt && ` · 用时 ${duration}`}
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
