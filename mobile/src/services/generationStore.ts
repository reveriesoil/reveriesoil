/**
 * generationStore.ts — 模块级单例，跨页面共享生成进度
 * LandingPage 启动生成并 emit 进度，GeneratingPage 订阅显示进度
 */
import type { ProgressUpdate } from './orchestrator'

type Listener = (update: ProgressUpdate) => void

let _listeners: Listener[] = []
let _currentProgress: ProgressUpdate = { step: '', progress: 0 }
let _currentGameId: string | null = null
let _running = false

export function subscribe(fn: Listener): () => void {
  _listeners = [..._listeners, fn]
  // 立即发送当前状态
  fn(_currentProgress)
  return () => { _listeners = _listeners.filter(l => l !== fn) }
}

export function emitProgress(update: ProgressUpdate): void {
  _currentProgress = update
  for (const fn of _listeners) {
    try { fn(update) } catch { /* ignore */ }
  }
}

export function getCurrentProgress(): ProgressUpdate {
  return _currentProgress
}

export function setCurrentGameId(id: string): void {
  _currentGameId = id
}

export function getCurrentGameId(): string | null {
  return _currentGameId
}

export function setRunning(v: boolean): void {
  _running = v
}

export function isRunning(): boolean {
  return _running
}

export function reset(): void {
  _currentProgress = { step: '', progress: 0 }
  _currentGameId = null
  _running = false
}
