import { useEffect, useState, useCallback, useRef } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { getGame, getProgress, saveProgress } from '../services/db'
import type { GameRecord, GameProgressRecord } from '../services/db'
import type { ScriptJson, Scene, Character, Dialogue, Choice } from '../types'

// ─── 工具函数 ─────────────────────────────────────────────────────────────────

function getPortrait(chars: Character[], characterId?: string, expression?: string): string | undefined {
  if (!characterId) return undefined
  const c = chars.find(c => c.id === characterId || c.name === characterId)
  if (!c) return undefined
  if (c.portrait_urls) {
    const expr = expression ?? 'normal'
    return c.portrait_urls[expr] || Object.values(c.portrait_urls).find(v => v) || undefined
  }
  return c.portrait_url || undefined
}

function getCharName(chars: Character[], characterId?: string): string {
  if (!characterId) return ''
  if (characterId.toUpperCase() === 'NARRATOR') return '旁白'
  const c = chars.find(c => c.id === characterId || c.name === characterId)
  return c?.name ?? characterId
}

function fmtTime(s: number) {
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

// ─── Typewriter Hook ──────────────────────────────────────────────────────────

function useTypewriter(text: string, speed = 28) {
  const [displayed, setDisplayed] = useState('')
  const [done, setDone] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const indexRef = useRef(0)

  useEffect(() => {
    setDisplayed('')
    setDone(false)
    indexRef.current = 0
    if (!text) { setDone(true); return }
    const tick = () => {
      indexRef.current += 1
      setDisplayed(text.slice(0, indexRef.current))
      if (indexRef.current < text.length) {
        timerRef.current = setTimeout(tick, speed)
      } else {
        setDone(true)
      }
    }
    timerRef.current = setTimeout(tick, speed)
    return () => { if (timerRef.current) clearTimeout(timerRef.current) }
  }, [text, speed])

  const skip = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current)
    setDisplayed(text)
    setDone(true)
  }, [text])

  return { displayed, done, skip }
}

// ─── 图标 ─────────────────────────────────────────────────────────────────────

const IconBack = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
    <path d="M10 12L6 8l4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
)
const IconSave = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
    <path d="M3 2h8l3 3v9a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/>
    <path d="M5 2v4h6V2M5 9h6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
  </svg>
)
const IconVolume = ({ muted }: { muted: boolean }) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
    {muted ? (
      <>
        <path d="M11 5L6 9H2v6h4l5 4V5z" fill="currentColor" opacity="0.5"/>
        <path d="M23 9l-6 6M17 9l6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
      </>
    ) : (
      <>
        <path d="M11 5L6 9H2v6h4l5 4V5z" fill="currentColor"/>
        <path d="M15.5 8.5A5 5 0 0 1 15.5 15.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
        <path d="M19 5.5A9 9 0 0 1 19 18.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
      </>
    )}
  </svg>
)

// ─── 主组件 ───────────────────────────────────────────────────────────────────

export default function PlayPage() {
  const { gameId } = useParams()
  const navigate = useNavigate()

  const [game, setGame] = useState<GameRecord | null>(null)
  const [script, setScript] = useState<ScriptJson | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  // 播放状态
  const [sceneId, setSceneId] = useState<string>('')
  const [dialogueIdx, setDialogueIdx] = useState(0)
  const [choicesMade, setChoicesMade] = useState<unknown[]>([])
  const [_visitedScenes, setVisitedScenes] = useState<Set<string>>(new Set())
  const [playTime, setPlayTime] = useState(0)
  const [gameOver, setGameOver] = useState(false)
  const [saveMsg, setSaveMsg] = useState('')
  const [showSceneTitle, setShowSceneTitle] = useState(false)
  const [currentSceneTitle, setCurrentSceneTitle] = useState('')
  const [showCgOverlay, setShowCgOverlay] = useState(false)
  const [cgOverlayUrl, setCgOverlayUrl] = useState('')
  const [hideUI, setHideUI] = useState(false)
  const [muted, setMuted] = useState(false)

  // 音频
  const bgmRef = useRef<HTMLAudioElement | null>(null)
  const voiceRef = useRef<HTMLAudioElement | null>(null)

  // ─── 初始化：加载游戏 + 恢复进度 ─────────────────────────────────────────
  useEffect(() => {
    if (!gameId) return
    getGame(gameId)
      .then(async (g) => {
        if (!g) { setError('未找到该故事'); return }
        setGame(g)
        const sc = g.script_json as ScriptJson | undefined
        if (!sc?.scenes?.length) { setError('剧本为空'); return }
        setScript(sc)

        // 尝试恢复进度
        let restored = false
        try {
          const prog = await getProgress(gameId)
          if (prog && prog.current_scene_index >= 0 && prog.current_scene_index < sc.scenes!.length) {
            const timeline = prog.timeline as Array<{ scene_id: string; dialogue_index: number; choices: unknown[] }>
            const lastEntry = timeline[timeline.length - 1]
            if (lastEntry?.scene_id) {
              const sid = lastEntry.scene_id
              if (sc.scenes!.some(s => s.id === sid)) {
                setSceneId(sid)
                setDialogueIdx(lastEntry.dialogue_index ?? 0)
                setChoicesMade(lastEntry.choices ?? [])
                restored = true
              }
            }
          }
        } catch { /* 无进度记录，忽略 */ }

        if (!restored) {
          const first = sc.scenes![0]
          setSceneId(first.id)
          if (first.title) {
            setCurrentSceneTitle(first.title)
            setShowSceneTitle(true)
            setTimeout(() => setShowSceneTitle(false), 2200)
          }
        }
      })
      .catch(() => setError('加载游戏失败'))
      .finally(() => setLoading(false))
  }, [gameId])

  // 计时器
  useEffect(() => {
    const t = setInterval(() => setPlayTime(p => p + 1), 1000)
    return () => clearInterval(t)
  }, [])

  // 隐藏 UI（H键）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'h' || e.key === 'H') {
        const tag = (e.target as HTMLElement)?.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA') return
        setHideUI(v => !v)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // 场景切换时记录已访问
  useEffect(() => {
    if (sceneId) setVisitedScenes(prev => new Set([...prev, sceneId]))
  }, [sceneId])

  // CG overlay（场景级）
  useEffect(() => {
    if (!script || !sceneId) return
    const s = script.scenes?.find(sc => sc.id === sceneId)
    if (s?.cg_url) {
      setCgOverlayUrl(s.cg_url)
      setShowCgOverlay(true)
    }
  }, [sceneId, script])

  // BGM
  useEffect(() => {
    if (!script || !sceneId) return
    const s = script.scenes?.find(sc => sc.id === sceneId)
    const url = s?.bgm_url
    const audio = bgmRef.current
    if (!audio) return
    if (!url) { audio.pause(); audio.removeAttribute('src'); return }
    if (audio.src !== url) {
      audio.src = url; audio.loop = true; audio.volume = 0.45
      audio.muted = muted; audio.play().catch(() => {})
    }
  }, [sceneId, script])

  useEffect(() => {
    if (bgmRef.current) bgmRef.current.muted = muted
    if (voiceRef.current) voiceRef.current.muted = muted
  }, [muted])

  // ─── 派生状态 ─────────────────────────────────────────────────────────────
  const scenes = script?.scenes ?? []
  const scene: Scene | undefined = scenes.find(s => s.id === sceneId)
  const dialogues: Dialogue[] = scene?.dialogues ?? []
  const currentDialogue: Dialogue | undefined = dialogues[dialogueIdx]
  const chars: Character[] = script?.characters ?? []
  const speakerName = getCharName(chars, currentDialogue?.character_id ?? currentDialogue?.character)

  let sceneCharIds = scene?.characters_present ?? []
  if (!sceneCharIds.length && scene) {
    const seen: string[] = []
    for (const dlg of scene.dialogues ?? []) {
      const cid = dlg.character_id ?? dlg.character ?? ''
      if (cid && cid.toLowerCase() !== 'narrator' && !seen.includes(cid)) seen.push(cid)
      if (seen.length >= 2) break
    }
    sceneCharIds = seen
  }
  const presentChars = sceneCharIds
    .map(cid => chars.find(c => c.id === cid || c.name === cid))
    .filter((c): c is Character => !!c)
  const leftChar = presentChars[0]
  const rightChar = presentChars[1]
  const speakingId = currentDialogue?.character_id ?? currentDialogue?.character
  const leftSpeaking = leftChar && (leftChar.id === speakingId || leftChar.name === speakingId)
  const rightSpeaking = rightChar && (rightChar.id === speakingId || rightChar.name === speakingId)
  const neitherSpeaking = !speakingId
  const leftActive = neitherSpeaking || !!leftSpeaking
  const rightActive = neitherSpeaking || !!rightSpeaking
  const leftExpr = leftSpeaking ? (currentDialogue?.expression ?? 'normal') : 'normal'
  const rightExpr = rightSpeaking ? (currentDialogue?.expression ?? 'normal') : 'normal'
  const leftPortrait = leftChar ? getPortrait(chars, leftChar.id ?? leftChar.name, leftExpr) : undefined
  const rightPortrait = rightChar ? getPortrait(chars, rightChar.id ?? rightChar.name, rightExpr) : undefined

  const { displayed, done, skip } = useTypewriter(currentDialogue?.text ?? '')

  // 语音
  useEffect(() => {
    if (!currentDialogue) return
    const audio = voiceRef.current
    const url = currentDialogue.voice_url
    if (audio) {
      audio.pause()
      if (url) { audio.src = url; audio.muted = muted; audio.play().catch(() => {}) }
      else audio.removeAttribute('src')
    }
    // 对话级 CG 触发
    const cgId = (currentDialogue as { cg_trigger_id?: string }).cg_trigger_id
    if (cgId && script) {
      const cg = script.cg_assets?.find(c => c.scene_id === cgId || (c as { id?: string }).id === cgId)
      if (cg?.url || cg?.image_url) {
        setCgOverlayUrl(cg.url || cg.image_url || '')
        setShowCgOverlay(true)
      }
    }
  }, [currentDialogue, script, muted])

  // ─── 场景跳转 ─────────────────────────────────────────────────────────────
  const goToScene = useCallback((nextId: string) => {
    const next = scenes.find(s => s.id === nextId)
    if (!next) {
      // 顺序跳下一个
      const idx = scenes.findIndex(s => s.id === sceneId)
      if (idx >= 0 && idx < scenes.length - 1) {
        const seq = scenes[idx + 1]
        setSceneId(seq.id)
        setDialogueIdx(0)
        if (seq.title) {
          setCurrentSceneTitle(seq.title)
          setShowSceneTitle(true)
          setTimeout(() => setShowSceneTitle(false), 2200)
        }
      } else {
        setGameOver(true)
      }
      return
    }
    setSceneId(nextId)
    setDialogueIdx(0)
    if (next.title) {
      setCurrentSceneTitle(next.title)
      setShowSceneTitle(true)
      setTimeout(() => setShowSceneTitle(false), 2200)
    }
  }, [scenes, sceneId])

  const goToNextSequential = useCallback(() => {
    const idx = scenes.findIndex(s => s.id === sceneId)
    if (idx >= 0 && idx < scenes.length - 1) {
      const seq = scenes[idx + 1]
      setSceneId(seq.id)
      setDialogueIdx(0)
      if (seq.title) {
        setCurrentSceneTitle(seq.title)
        setShowSceneTitle(true)
        setTimeout(() => setShowSceneTitle(false), 2200)
      }
    } else {
      setGameOver(true)
    }
  }, [scenes, sceneId])

  const advance = useCallback(() => {
    if (!scene) return
    if (!done) { skip(); return }
    if (dialogueIdx < dialogues.length - 1) {
      setDialogueIdx(i => i + 1)
      return
    }
    const choices = scene.choices
    if (choices && choices.length > 0) return
    const nextId = scene.next_scene_id || scene.next_scene
    if (nextId) goToScene(nextId)
    else goToNextSequential()
  }, [scene, done, skip, dialogueIdx, dialogues.length, goToScene, goToNextSequential])

  const handleChoice = (choiceIdx: number) => {
    const c = scene?.choices?.[choiceIdx]
    if (!c) return
    setChoicesMade(prev => [
      ...prev,
      { scene: sceneId, choice: choiceIdx, text: c.text || c.option_text || '' },
    ])
    const nextId = c.next_scene_id || c.next_scene
    if (nextId) goToScene(nextId)
    else goToNextSequential()
  }

  // ─── 进度保存 ─────────────────────────────────────────────────────────────
  const handleSave = async () => {
    if (!gameId || !sceneId) return
    try {
      // 构建简化的 timeline 列表
      const sceneIdx = scenes.findIndex(s => s.id === sceneId)
      const prog: Omit<GameProgressRecord, 'updated_at'> = {
        game_id: gameId,
        current_scene_index: sceneIdx,
        timeline: [{ scene_id: sceneId, dialogue_index: dialogueIdx, choices: choicesMade }],
      }
      await saveProgress(prog as GameProgressRecord)
      setSaveMsg('进度已保存 ✓')
      setTimeout(() => setSaveMsg(''), 2000)
    } catch {
      setSaveMsg('保存失败')
    }
  }

  // ─── 渲染 ─────────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#000' }}>
        <div className="spinner" style={{ width: 32, height: 32 }} />
      </div>
    )
  }
  if (error || !game || !script) {
    return (
      <div style={{ padding: 32, textAlign: 'center', color: 'var(--muted)' }}>
        <div style={{ fontSize: 32, marginBottom: 12 }}>⚠️</div>
        <p style={{ marginBottom: 16 }}>{error || '加载失败'}</p>
        <button className="vn-ending-btn" onClick={() => navigate('/')}>返回首页</button>
      </div>
    )
  }

  if (game.status !== 'done') {
    return (
      <div style={{ padding: 32, textAlign: 'center', color: 'var(--muted)' }}>
        <div style={{ fontSize: 32, marginBottom: 12 }}>⏳</div>
        <p>游戏正在生成中…</p>
        <button className="vn-ending-btn" style={{ marginTop: 20 }} onClick={() => navigate(`/generating/${game.id}`)}>查看进度</button>
      </div>
    )
  }

  // 通关画面
  if (gameOver) {
    return (
      <div className="vn-player">
        <div className="vn-background" style={{ background: 'radial-gradient(ellipse at 50% 30%, #2a1a00, #000)' }} />
        <div className="vn-ending">
          <motion.div
            initial={{ opacity: 0, scale: 0.85 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
            style={{ textAlign: 'center' }}
          >
            <div style={{ fontSize: 40, marginBottom: 12 }}>🎊</div>
            <div className="vn-ending-title">游戏通关</div>
            <div className="vn-ending-subtitle" style={{ margin: '6px 0 20px' }}>{game.title || '故事结束'}</div>
            <div style={{ display: 'flex', gap: 12, justifyContent: 'center', flexWrap: 'wrap' }}>
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--accent2)' }}>{fmtTime(playTime)}</div>
                <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>游玩时长</div>
              </div>
              <div style={{ width: 1, background: 'var(--border)', margin: '0 4px' }} />
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--accent2)' }}>{choicesMade.length}</div>
                <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>做出选择</div>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'center', marginTop: 24, flexWrap: 'wrap' }}>
              <button className="vn-ending-btn" onClick={() => {
                setSceneId(scenes[0].id)
                setDialogueIdx(0)
                setChoicesMade([])
                setGameOver(false)
              }}>重新游玩</button>
              <button
                className="vn-ending-btn"
                style={{ background: 'transparent', border: '1px solid var(--border)', color: 'var(--muted)' }}
                onClick={() => navigate('/')}
              >返回首页</button>
            </div>
          </motion.div>
        </div>
      </div>
    )
  }

  const isNarrator = !speakingId || speakingId.toUpperCase() === 'NARRATOR'
  const showChoices = done && dialogueIdx >= dialogues.length - 1 && scene?.choices && scene.choices.length > 0

  return (
    <div
      className="vn-player"
      onClick={hideUI ? () => setHideUI(false) : (!showChoices && !showSceneTitle ? advance : undefined)}
    >
      {/* 音频元素 */}
      <audio ref={bgmRef} style={{ display: 'none' }} />
      <audio ref={voiceRef} style={{ display: 'none' }} />

      {/* 背景 */}
      <AnimatePresence mode="wait">
        <motion.div
          key={sceneId}
          className="vn-background"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.6 }}
          style={{
            backgroundImage: scene?.background_url
              ? `url(${scene.background_url})`
              : 'linear-gradient(135deg,#1a1040,#0a0a1a)',
          }}
        />
      </AnimatePresence>
      <div className="vn-background-overlay" />

      {/* CG 覆层 */}
      <AnimatePresence>
        {showCgOverlay && cgOverlayUrl && (
          <motion.div
            className="vn-cg-layer"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.4 }}
            onClick={e => { e.stopPropagation(); setShowCgOverlay(false) }}
          >
            <img className="vn-cg-img" src={cgOverlayUrl} alt="CG" />
          </motion.div>
        )}
      </AnimatePresence>

      {/* 顶部控制栏 */}
      <AnimatePresence>
        {!hideUI && (
          <motion.div
            className="vn-topbar"
            initial={{ opacity: 0, y: -16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -16 }}
            transition={{ duration: 0.2 }}
          >
            <button className="vn-ctrl-btn" onClick={e => { e.stopPropagation(); navigate('/') }}>
              <IconBack /> 退出
            </button>
            <div style={{ flex: 1, textAlign: 'center', fontSize: 13, color: 'var(--accent2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', padding: '0 8px' }}>
              {game.title || '故事'}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                className="vn-ctrl-btn"
                onClick={e => { e.stopPropagation(); handleSave() }}
                title="保存进度"
              >
                <IconSave /> {saveMsg || '保存'}
              </button>
              <button
                className="vn-mute-btn"
                onClick={e => { e.stopPropagation(); setMuted(m => !m) }}
                title={muted ? '取消静音' : '静音'}
              >
                <IconVolume muted={muted} />
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* 场景标题浮层 */}
      <AnimatePresence>
        {showSceneTitle && (
          <motion.div
            className="vn-scene-title"
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 1.05 }}
            transition={{ duration: 0.4 }}
          >
            <div className="vn-scene-title-text">{currentSceneTitle}</div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* 左侧立绘 */}
      {leftPortrait && !hideUI && (
        <AnimatePresence>
          <motion.div
            className="vn-char-left"
            key={`left-${sceneId}`}
            initial={{ opacity: 0, x: -40 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -40 }}
            transition={{ duration: 0.4 }}
          >
            <img
              className={`vn-portrait${leftActive ? '' : ' vn-portrait--inactive'}`}
              src={leftPortrait}
              alt={leftChar?.name}
            />
          </motion.div>
        </AnimatePresence>
      )}

      {/* 右侧立绘 */}
      {rightPortrait && !hideUI && (
        <AnimatePresence>
          <motion.div
            className="vn-char-right"
            key={`right-${sceneId}`}
            initial={{ opacity: 0, x: 40 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 40 }}
            transition={{ duration: 0.4 }}
          >
            <img
              className={`vn-portrait${rightActive ? '' : ' vn-portrait--inactive'}`}
              src={rightPortrait}
              alt={rightChar?.name}
            />
          </motion.div>
        </AnimatePresence>
      )}

      {/* 对话框 */}
      {!hideUI && currentDialogue && (
        <div className={`vn-dialogue-box${isNarrator ? ' vn-narrator' : ''}`}>
          {isNarrator
            ? <div className="vn-narrator-label">旁 白</div>
            : (
              <div className="vn-speaker">
                <span className="vn-speaker-name">{speakerName}</span>
              </div>
            )}
          <div className="vn-text">
            {displayed}
            {!done && <span className="vn-cursor">▌</span>}
          </div>

          {/* 选项 */}
          {showChoices && (
            <div className="vn-choices" onClick={e => e.stopPropagation()}>
              {scene!.choices!.map((c: Choice, i: number) => (
                <button key={i} className="vn-choice-btn" onClick={() => handleChoice(i)}>
                  {c.text || c.option_text || `选项 ${i + 1}`}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
