export interface StorySpec {
  duration_minutes: number
  branch_enabled: boolean
  scene_count?: number
  title?: string
  depth?: number
  interaction_level?: number
}

export interface AIModelConfig {
  provider: string
  model: string
  api_key?: string
  endpoint?: string
}

export interface AIConfig {
  config_name: string
  text_model: AIModelConfig
  image_model: AIModelConfig
  voice_model?: AIModelConfig
  is_default: boolean
  text_agent_overrides?: Record<string, AIModelConfig>
}

export interface AIConfigResponse extends AIConfig {
  id: string
  created_at: string
}

export interface GenerateRequest {
  prompt: string
  character_prompt?: string
  story_style?: string
  art_style?: string
  ai_config: Record<string, unknown>
  story_spec: StorySpec
}

export interface TaskStatus {
  id: string
  game_id: string
  status: 'pending' | 'running' | 'done' | 'failed' | 'cancelled'
  progress: number
  current_step?: string
  current_model?: string
  error_msg?: string
  script_ready?: boolean
  token_usage?: number
}

export interface GameSummary {
  id: string
  title?: string
  prompt: string
  synopsis?: string
  status: string
  estimated_duration?: number
  cover_url?: string
  cover_image_url?: string
  created_at: string
  updated_at?: string
}

export interface GameStats {
  total_images: number
  portrait_count: number
  background_count: number
  cg_count: number
  token_usage: number
  total_words: number
  scene_count: number
}

export interface GameDetail extends GameSummary {
  script_json: ScriptJson
  assets_manifest?: Record<string, unknown>
}

export interface ScriptJson {
  title?: string
  synopsis?: string
  characters?: Character[]
  scenes?: Scene[]
  cg_assets?: CgAsset[]
}

export interface CgAsset {
  scene_id?: string
  id?: string
  url?: string
  video_url?: string
  image_url?: string
}

export interface Character {
  id?: string
  name: string
  role?: string
  description?: string
  portrait_url?: string
  portrait_urls?: Record<string, string>
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
  text: string
  next_scene?: string
  next_scene_id?: string
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

export interface GameProgress {
  id?: string
  current_scene: string
  dialogue_index: number
  visited_scenes: string[]
  choices_made: unknown[]
  play_time: number
  updated_at?: string
}
