import { HashRouter, Routes, Route } from 'react-router-dom'
import { useEffect, useRef, useState } from 'react'
import LandingPage from './pages/LandingPage'
import GeneratingPage from './pages/GeneratingPage'
import PlayPage from './pages/PlayPage'
import HistoryPage from './pages/HistoryPage'
import './index.css'

// ─── 调试日志收集（全局，模块初始化时立即 patch）────────────────────────────
type LogEntry = { ts: string; level: 'LOG' | 'WARN' | 'ERR'; msg: string }
const _debugLogs: LogEntry[] = []
const MAX_DEBUG = 400

;(function patchConsole() {
  const origLog   = console.log.bind(console)
  const origWarn  = console.warn.bind(console)
  const origError = console.error.bind(console)
  const push = (level: LogEntry['level'], args: unknown[]) => {
    const msg = args.map(a => {
      if (typeof a === 'string') return a
      if (a instanceof Error) return `${a.name}: ${a.message}`
      try { return JSON.stringify(a) } catch { return String(a) }
    }).join(' ')
    _debugLogs.push({ ts: new Date().toTimeString().slice(0, 8), level, msg })
    if (_debugLogs.length > MAX_DEBUG) _debugLogs.shift()
  }
  console.log   = (...a: unknown[]) => { push('LOG',  a); origLog(...a) }
  console.warn  = (...a: unknown[]) => { push('WARN', a); origWarn(...a) }
  console.error = (...a: unknown[]) => { push('ERR',  a); origError(...a) }
})()

// Capacitor 下无法使用 BrowserRouter（本地文件路径问题），改用 HashRouter
export default function App() {
  const [showDebug, setShowDebug] = useState(false)
  const [logs, setLogs] = useState<LogEntry[]>([])
  const logsEndRef = useRef<HTMLDivElement>(null)
  const tapRef = useRef(0)
  const tapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 5-tap 左下角开启调试面板
  const handleDebugTap = () => {
    tapRef.current++
    if (tapTimerRef.current) clearTimeout(tapTimerRef.current)
    tapTimerRef.current = setTimeout(() => { tapRef.current = 0 }, 2000)
    if (tapRef.current >= 5) {
      tapRef.current = 0
      setLogs([..._debugLogs])
      setShowDebug(true)
    }
  }

  const refreshLogs = () => setLogs([..._debugLogs])

  const copyLogs = async () => {
    const text = logs.map(l => `[${l.ts}][${l.level}] ${l.msg}`).join('\n')
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      // Android WebView fallback
      const ta = document.createElement('textarea')
      ta.value = text
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      document.body.removeChild(ta)
    }
    // 简单反馈
    const original = logs
    setLogs([{ ts: new Date().toTimeString().slice(0, 8), level: 'LOG', msg: '✓ 已复制到剪贴板' }, ...original])
    setTimeout(() => setLogs([..._debugLogs]), 1500)
  }

  useEffect(() => {
    if (showDebug) logsEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [showDebug])

  // ─── 全局 WakeLock — 只要 App 在前台就保持屏幕常亮 ──────────────────────
  useEffect(() => {
    type WL = { release: () => Promise<void> }
    let wl: WL | null = null
    const acquire = async () => {
      try {
        if ('wakeLock' in navigator) {
          wl = await (navigator as unknown as { wakeLock: { request: (t: string) => Promise<WL> } }).wakeLock.request('screen')
        }
      } catch { /* 设备不支持 WakeLock，忽略 */ }
    }
    const onVis = () => { if (document.visibilityState === 'visible') acquire() }
    acquire()
    document.addEventListener('visibilitychange', onVis)
    return () => { document.removeEventListener('visibilitychange', onVis); wl?.release() }
  }, [])

  return (
    <HashRouter>
      {/* 5-tap 隐形区域 — 左下角，用于触发调试面板 */}
      <div
        style={{ position: 'fixed', bottom: 0, left: 0, width: 48, height: 48, zIndex: 9990, opacity: 0 }}
        onClick={handleDebugTap}
      />

      {/* 调试日志面板 */}
      {showDebug && (
        <div className="dbg-overlay" onClick={() => setShowDebug(false)}>
          <div className="dbg-panel" onClick={e => e.stopPropagation()}>
            <div className="dbg-header">
              <span className="dbg-title">📋 调试日志 ({logs.length})</span>
              <div style={{ display: 'flex', gap: 6 }}>
                <button className="dbg-btn" onClick={refreshLogs}>刷新</button>
                <button className="dbg-btn dbg-btn--accent" onClick={copyLogs}>复制全部</button>
                <button className="dbg-btn dbg-btn--close" onClick={() => setShowDebug(false)}>✕</button>
              </div>
            </div>
            <div className="dbg-body">
              {logs.length === 0
                ? <div className="dbg-empty">暂无日志输出</div>
                : logs.map((l, i) => (
                    <div key={i} className={`dbg-entry dbg-entry--${l.level.toLowerCase()}`}>
                      <span className="dbg-ts">{l.ts}</span>
                      <span className="dbg-level">{l.level}</span>
                      <span className="dbg-msg">{l.msg}</span>
                    </div>
                  ))
              }
              <div ref={logsEndRef} />
            </div>
          </div>
        </div>
      )}

      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route path="/generating/:gameId" element={<GeneratingPage />} />
        <Route path="/play/:gameId" element={<PlayPage />} />
        <Route path="/history" element={<HistoryPage />} />
      </Routes>
    </HashRouter>
  )
}
