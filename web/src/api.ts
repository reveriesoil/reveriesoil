import axios from 'axios'
import type { AIConfig, AIConfigResponse, GenerateRequest, TaskStatus, GameSummary, GameDetail, GameProgress, GameStats } from './types'

const BASE = '/api'

const http = axios.create({ baseURL: BASE })

// ── Games ─────────────────────────────────────────────────────────
export const generateGame = (body: GenerateRequest) =>
  http.post<{ task_id: string; game_id: string }>('/games/generate', body)

export const getHistory = () =>
  http.get<GameSummary[]>('/games/history')

export const getGame = (gameId: string) =>
  http.get<GameDetail>(`/games/${gameId}`)

export const deleteGame = (gameId: string) =>
  http.delete(`/games/${gameId}`)

export const retryGame = (gameId: string) =>
  http.post<{ task_id: string; game_id: string }>(`/games/${gameId}/retry`)

export const getActiveTask = (gameId: string) =>
  http.get<{ task: TaskStatus | null }>(`/games/${gameId}/active-task`)

export const getGameStats = (gameId: string) =>
  http.get<GameStats>(`/games/${gameId}/stats`)

// ── Import / Export ───────────────────────────────────────────────
export const exportGame = (gameId: string) =>
  http.get(`/games/${gameId}/export`, { responseType: 'blob' })

export const importGame = (file: File) => {
  const form = new FormData()
  form.append('file', file)
  return http.post<GameSummary>('/games/import', form, {
    headers: { 'Content-Type': 'multipart/form-data' },
  })
}

// ── Progress ─────────────────────────────────────────────────────
export const getProgress = (gameId: string) =>
  http.get<GameProgress | null>(`/games/${gameId}/progress`)

export const saveTimeline = (gameId: string, body: Partial<GameProgress>) =>
  http.post(`/games/${gameId}/progress`, body)

// ── Tasks ─────────────────────────────────────────────────────────
export const getTaskStatus = (taskId: string) =>
  http.get<TaskStatus>(`/tasks/${taskId}`)

export const cancelTask = (taskId: string) =>
  http.post(`/tasks/${taskId}/cancel`)

// ── Config ────────────────────────────────────────────────────────
export const getModels = () =>
  http.get('/config/models')

export const getAgents = () =>
  http.get<{ agents: { key: string; name: string; desc: string }[] }>('/config/agents')

export const getAIConfig = () =>
  http.get<AIConfigResponse[]>('/config/load')

export const saveAIConfig = (config: AIConfig) =>
  http.post<AIConfigResponse>('/config/save', config)

export const testModel = (params: {
  model_type: 'text' | 'image' | 'voice'
  endpoint: string
  api_key: string
  model: string
}) =>
  http.post<{ success: boolean; message: string; latency_ms: number }>('/config/test-model', params)
