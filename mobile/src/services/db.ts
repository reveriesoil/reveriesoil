/**
 * db.ts — IndexedDB 存储层（替代桌面版 SQLite）
 * 使用 idb 库封装，存储游戏数据、AI 配置、游戏进度
 */
import { openDB, type DBSchema, type IDBPDatabase } from 'idb'

// ── Schema 定义 ──────────────────────────────────────────────────────────────

interface ReverieDB extends DBSchema {
  games: {
    key: string
    value: GameRecord
    indexes: { 'by-created': string }
  }
  ai_configs: {
    key: string
    value: AIConfigRecord
  }
  game_progress: {
    key: string
    value: GameProgressRecord
  }
  assets: {
    // key = "gameId/type/name" (e.g. "abc123/portraits/char_a_normal.png")
    key: string
    value: AssetRecord
    indexes: { 'by-game': string }
  }
}

export interface GameRecord {
  id: string
  prompt: string
  character_prompt?: string
  title?: string
  synopsis?: string
  status: 'generating' | 'done' | 'error'
  error_msg?: string
  script_json?: unknown
  assets_manifest?: AssetsManifest
  cover_url?: string          // base64 data URL
  cover_image_url?: string
  estimated_duration?: number
  created_at: string
  updated_at: string
}

export interface AssetsManifest {
  portraits:   Record<string, Record<string, string>>  // charId -> expr -> dataURL
  backgrounds: Record<string, string>                  // sceneId -> dataURL
  cg:          Record<string, string>                  // cgId -> dataURL
  voices:      Record<string, string>                  // dlgId -> dataURL (base64 audio)
  cover?:      string
}

export interface AIConfigRecord {
  id: string
  config_name: string
  text_model: ModelCfg
  image_model: ModelCfg
  voice_model?: ModelCfg
  text_agent_overrides?: Record<string, ModelCfg>
  is_default: boolean
  created_at: string
}

export interface ModelCfg {
  provider: string
  model: string
  api_key?: string
  endpoint?: string
  enabled?: boolean
}

export interface GameProgressRecord {
  game_id: string
  current_scene_index: number
  timeline: unknown[]
  updated_at: string
}

export interface AssetRecord {
  key: string
  game_id: string
  data_url: string   // "data:image/png;base64,..."
  updated_at: string
}

// ── 数据库初始化 ──────────────────────────────────────────────────────────────

let _db: IDBPDatabase<ReverieDB> | null = null

export async function getDB(): Promise<IDBPDatabase<ReverieDB>> {
  if (_db) return _db
  _db = await openDB<ReverieDB>('reveriesoil', 1, {
    upgrade(db) {
      // games
      const gameStore = db.createObjectStore('games', { keyPath: 'id' })
      gameStore.createIndex('by-created', 'created_at')
      // ai_configs
      db.createObjectStore('ai_configs', { keyPath: 'id' })
      // game_progress
      db.createObjectStore('game_progress', { keyPath: 'game_id' })
      // assets
      const assetStore = db.createObjectStore('assets', { keyPath: 'key' })
      assetStore.createIndex('by-game', 'game_id')
    },
  })
  return _db
}

// ── Games ────────────────────────────────────────────────────────────────────

export async function createGame(record: GameRecord): Promise<void> {
  const db = await getDB()
  await db.put('games', record)
}

export async function updateGame(id: string, patch: Partial<GameRecord>): Promise<void> {
  const db = await getDB()
  const existing = await db.get('games', id)
  if (!existing) throw new Error(`Game ${id} not found`)
  await db.put('games', { ...existing, ...patch, updated_at: new Date().toISOString() })
}

export async function getGame(id: string): Promise<GameRecord | undefined> {
  const db = await getDB()
  return db.get('games', id)
}

export async function listGames(): Promise<GameRecord[]> {
  const db = await getDB()
  const all = await db.getAllFromIndex('games', 'by-created')
  return all.reverse()
}

export async function deleteGame(id: string): Promise<void> {
  const db = await getDB()
  await db.delete('games', id)
  // 同时删除关联资产
  const assetKeys = await db.getAllKeysFromIndex('assets', 'by-game', id)
  const tx = db.transaction('assets', 'readwrite')
  await Promise.all(assetKeys.map(k => tx.store.delete(k)))
  await tx.done
  // 删除进度
  await db.delete('game_progress', id)
}

// ── Assets ───────────────────────────────────────────────────────────────────

export async function putAsset(gameId: string, name: string, dataUrl: string): Promise<void> {
  const db = await getDB()
  await db.put('assets', {
    key: `${gameId}/${name}`,
    game_id: gameId,
    data_url: dataUrl,
    updated_at: new Date().toISOString(),
  })
}

export async function getAsset(gameId: string, name: string): Promise<string | null> {
  const db = await getDB()
  const rec = await db.get('assets', `${gameId}/${name}`)
  return rec?.data_url ?? null
}

// ── AI Config ────────────────────────────────────────────────────────────────

export async function saveAIConfig(cfg: AIConfigRecord): Promise<void> {
  const db = await getDB()
  if (cfg.is_default) {
    // 清除其他默认
    const all = await db.getAll('ai_configs')
    const tx = db.transaction('ai_configs', 'readwrite')
    for (const c of all) {
      if (c.id !== cfg.id && c.is_default) {
        await tx.store.put({ ...c, is_default: false })
      }
    }
    await tx.done
  }
  await db.put('ai_configs', cfg)
}

export async function listAIConfigs(): Promise<AIConfigRecord[]> {
  const db = await getDB()
  return db.getAll('ai_configs')
}

export async function getDefaultAIConfig(): Promise<AIConfigRecord | undefined> {
  const all = await listAIConfigs()
  return all.find(c => c.is_default) ?? all[0]
}

export async function deleteAIConfig(id: string): Promise<void> {
  const db = await getDB()
  await db.delete('ai_configs', id)
}

// ── Progress ─────────────────────────────────────────────────────────────────

export async function saveProgress(rec: GameProgressRecord): Promise<void> {
  const db = await getDB()
  await db.put('game_progress', { ...rec, updated_at: new Date().toISOString() })
}

export async function getProgress(gameId: string): Promise<GameProgressRecord | undefined> {
  const db = await getDB()
  return db.get('game_progress', gameId)
}
