/**
 * types.ts — 移动端类型定义
 * 与 web 版保持兼容，同时适配 IndexedDB 的 GameRecord（status: 'done' 而非 'ready'）
 */

import type { GameRecord, AssetsManifest, AIConfigRecord } from './services/db'

// 重新导出 db 类型以方便页面使用
export type { GameRecord, AssetsManifest, AIConfigRecord }

// ─── 脚本格式 ──────────────────────────────────────────────────────────────────

export interface ScriptJson {
  title?: string
  synopsis?: string
  characters?: Character[]
  scenes?: Scene[]
  cg_assets?: CgAsset[]
}

export interface Character {
  id?: string
  name: string
  role?: string
  description?: string
  portrait_url?: string
  portrait_urls?: Record<string, string>   // expr -> base64 dataURL
}

export interface Dialogue {
  id?: string
  character?: string
  character_id?: string
  expression?: string
  text: string
  voice_url?: string
  cg_trigger_id?: string
}

export interface Choice {
  text?: string
  option_text?: string
  next_scene?: string
  next_scene_id?: string
}

export interface CgAsset {
  scene_id?: string
  id?: string
  url?: string          // base64 dataURL
  image_url?: string
  video_url?: string
}

export interface Scene {
  id: string
  title?: string
  background_url?: string
  background_description?: string
  background_desc?: string
  bgm_url?: string
  bgm_mood?: string
  cg_url?: string
  cg_video_url?: string
  cg_trigger?: string
  characters_present?: string[]
  dialogues: Dialogue[]
  choices?: Choice[]
  next_scene?: string
  next_scene_id?: string
}

// ─── 游戏进度（本地存储格式） ───────────────────────────────────────────────

export interface GameProgress {
  current_scene: string
  dialogue_index: number
  visited_scenes: string[]
  choices_made: unknown[]
  play_time: number
}

// ─── 历史列表用摘要（适配 IndexedDB GameRecord） ────────────────────────────

export type GameSummary = {
  id: string
  title?: string
  prompt: string
  synopsis?: string
  status: 'generating' | 'done' | 'error'
  estimated_duration?: number
  cover_url?: string
  cover_image_url?: string
  created_at: string
  updated_at?: string
}
