import React, { useEffect, useState, useCallback, useRef } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { getGame, getProgress, saveTimeline } from '../api'
import type { GameDetail, Scene, Character, GameProgress } from '../types'
import StoryTimeline from '../components/StoryTimeline'
import PortraitImage from '../components/PortraitImage'

function getPortrait(chars: Character[], characterId?: string, expression?: string): string | undefined {
  if (!characterId) return undefined
  const c = chars.find(c => c.id === characterId || c.name === characterId)
  if (!c) return undefined
  if (c.portrait_urls) {
    const expr = expression ?? 'normal'
    const url = c.portrait_urls[expr] || Object.values(c.portrait_urls).find(v => v) || ''
    return url || undefined
  }
  return c.portrait_url || undefined
}

function getCharName(chars: Character[], characterId?: string): string {
  if (!characterId) return ''
  if (characterId.toUpperCase() === 'NARRATOR') return '旁白'
  const c = chars.find(c => c.id === characterId || c.name === characterId)
  return c?.name ?? characterId
}

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

const fmtTime = (s: number) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`

export default function PlayPage() {
  const { gameId } = useParams()
  const navigate = useNavigate()

  const [game, setGame] = useState<GameDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const [sceneId, setSceneId] = useState<string>('')
  const [dialogueIdx, setDialogueIdx] = useState(0)
  const [choicesMade, setChoicesMade] = useState<unknown[]>([])
  const [playTime, setPlayTime] = useState(0)
  const [gameOver, setGameOver] = useState(false)
  const [shareUrl] = useState('')
  const [saveMsg, setSaveMsg] = useState('')
  const [showSceneTitle, setShowSceneTitle] = useState(false)
  const [currentSceneTitle, setCurrentSceneTitle] = useState('')

  const [showCgOverlay, setShowCgOverlay] = useState(false)
  const [cgOverlayUrl, setCgOverlayUrl] = useState('')
  const [cgOverlayVideoUrl, setCgOverlayVideoUrl] = useState('')

  // 隐藏 UI（仅显示背景 + 立绘 / CG）
  const [hideUI, setHideUI] = useState(false)

  const bgmRef = useRef<HTMLAudioElement | null>(null)
  const voiceRef = useRef<HTMLAudioElement | null>(null)
  const [muted, setMuted] = useState(false)

  useEffect(() => {
    if (!game || !sceneId) return
    const s = game.script_json?.scenes?.find(sc => sc.id === sceneId)
    if (s?.cg_url) {
      setCgOverlayUrl(s.cg_url)
      setCgOverlayVideoUrl(s.cg_video_url ?? '')
      setShowCgOverlay(true)
    }
  }, [sceneId, game])

  useEffect(() => {
    if (!game || !sceneId) return
    const s = game.script_json?.scenes?.find(sc => sc.id === sceneId)
    const url = s?.bgm_url
    const audio = bgmRef.current
    if (!audio) return
    if (!url) {
      audio.pause()
      audio.removeAttribute('src')
      return
    }
    if (audio.src !== url) {
      audio.src = url
      audio.loop = true
      audio.volume = 0.45
      audio.muted = muted
      audio.play().catch(() => {})
    }
  }, [sceneId, game])

  useEffect(() => {
    if (bgmRef.current) bgmRef.current.muted = muted
    if (voiceRef.current) voiceRef.current.muted = muted
  }, [muted])

  useEffect(() => {
    const t = setInterval(() => setPlayTime(p => p + 1), 1000)
    return () => clearInterval(t)
  }, [])

  // 快捷键：H 切换隐藏 UI
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

  useEffect(() => {
    if (!gameId) return
    getGame(gameId)
      .then(async (gRes) => {
        const g = gRes.data
        setGame(g)
        const scenes = g.script_json?.scenes ?? []
        if (scenes.length === 0) { setError('游戏剧本为空'); return }
        // 尝试恢复进度
        let restored = false
        try {
          const pRes = await getProgress(gameId)
          const prog = pRes.data
          if (prog && prog.current_scene && scenes.some(s => s.id === prog.current_scene)) {
            setSceneId(prog.current_scene)
            setDialogueIdx(prog.dialogue_index || 0)
            setChoicesMade(Array.isArray(prog.choices_made) ? prog.choices_made : [])
            setPlayTime(prog.play_time || 0)
            setVisitedScenes(new Set(prog.visited_scenes || []))
            restored = true
          }
        } catch { /* 没有进度记录，忽略 */ }
        if (!restored) {
          setSceneId(scenes[0].id)
          if (scenes[0].title) {
            setCurrentSceneTitle(scenes[0].title)
            setShowSceneTitle(true)
            setTimeout(() => setShowSceneTitle(false), 2200)
          }
        }
      })
      .catch(() => setError('加载游戏失败'))
      .finally(() => setLoading(false))
  }, [gameId])

  const currentScene = useCallback((): Scene | undefined => {
    return game?.script_json?.scenes?.find(s => s.id === sceneId)
  }, [game, sceneId])

  const scene = currentScene()
  const dialogues = scene?.dialogues ?? []
  const currentDialogue = dialogues[dialogueIdx]
  const chars = game?.script_json?.characters ?? []
  const speakerName = getCharName(chars, currentDialogue?.character_id ?? currentDialogue?.character)

  let sceneCharIds = scene?.characters_present ?? []
  if ((!sceneCharIds || sceneCharIds.length === 0) && scene) {
    const seen: string[] = []
    for (const dlg of (scene.dialogues ?? [])) {
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

  useEffect(() => {
    if (!currentDialogue) return
    const audio = voiceRef.current
    const url = currentDialogue.voice_url
    if (audio) {
      audio.pause()
      if (url) {
        audio.src = url
        audio.muted = muted
        audio.play().catch(() => {})
      } else {
        audio.removeAttribute('src')
      }
    }
    const cgId = (currentDialogue as { cg_trigger_id?: string }).cg_trigger_id
    if (cgId && game) {
      const cg = game.script_json?.cg_assets?.find(c => c.scene_id === cgId || (c as { id?: string }).id === cgId)
      if (cg?.url) {
        setCgOverlayUrl(cg.url)
        setCgOverlayVideoUrl(cg.video_url ?? '')
        setShowCgOverlay(true)
      }
    }
  }, [currentDialogue, game, muted])

  const goToNextSequential = () => {
    const allScenes = game?.script_json?.scenes ?? []
    const idx = allScenes.findIndex(s => s.id === sceneId)
    if (idx >= 0 && idx < allScenes.length - 1) {
      const seq = allScenes[idx + 1]
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
  }

  const advance = () => {
    if (!scene) return
    if (!done) { skip(); return }
    if (dialogueIdx < dialogues.length - 1) {
      setDialogueIdx(i => i + 1)
      return
    }
    const choices = scene.choices
    if (choices && choices.length > 0) return
    const nextSceneId = scene.next_scene_id || scene.next_scene
    if (nextSceneId) {
      goToScene(nextSceneId)
    } else {
      goToNextSequential()
    }
  }

  const goToScene = (nextId: string) => {
    const allScenes = game?.script_json?.scenes ?? []
    const next = allScenes.find(s => s.id === nextId)
    if (!next) { goToNextSequential(); return }
    setSceneId(nextId)
    setDialogueIdx(0)
    if (next.title) {
      setCurrentSceneTitle(next.title)
      setShowSceneTitle(true)
      setTimeout(() => setShowSceneTitle(false), 2200)
    }
  }

  const handleChoice = (choiceIdx: number) => {
    const c = scene?.choices?.[choiceIdx]
    if (!c) return
    setChoicesMade(prev => [...prev, { scene: sceneId, choice: choiceIdx, text: (c as any).text || (c as any).option_text || '' }])
    const nextId = c.next_scene_id || c.next_scene
    if (nextId) {
      goToScene(nextId)
    } else {
      goToNextSequential()
    }
  }

  // 进度保存
  const handleSave = async () => {
    if (!gameId || !sceneId) return
    try {
      await saveTimeline(gameId, {
        current_scene: sceneId,
        dialogue_index: dialogueIdx,
        visited_scenes: Array.from(visitedScenes),
        choices_made: choicesMade,
        play_time: playTime,
      })
      setSaveMsg('进度已保存 ✓')
      setTimeout(() => setSaveMsg(''), 1800)
    } catch { setSaveMsg('保存失败') }
  }
  const handleShare = () => {}

  // 故事线面板
  const [showTimeline, setShowTimeline] = useState(false)
  const [visitedScenes, setVisitedScenes] = useState<Set<string>>(new Set())

  // 每次场景切换时记录到已访问集合
  useEffect(() => {
    if (sceneId) setVisitedScenes(prev => new Set([...prev, sceneId]))
  }, [sceneId])

  if (loading) return <div className="empty-state" style={{ marginTop: 80 }}><div className="spinner" style={{ width: 32, height: 32 }} /></div>
  if (error) return <div className="alert alert-error" style={{ margin: 32 }}>{error}</div>
  if (!game) return null

  if (game.status !== 'ready') {
    return (
      <div style={{ textAlign: 'center', marginTop: 80 }}>
        <div style={{ fontSize: 48, marginBottom: 16 }}>⏳</div>
        <h2>游戏正在生成中</h2>
        <p className="text-muted" style={{ marginTop: 8 }}>状态：<span style={{ color: game.status === 'generating' ? '#f59e0b' : '#ef4444' }}>{game.status}</span></p>
        <button className="btn btn-ghost" style={{ marginTop: 24 }} onClick={() => navigate('/history')}>{'←'} 返回列表</button>
      </div>
    )
  }

  const scenes = game.script_json?.scenes ?? []
  const sceneIndex = scenes.findIndex(s => s.id === sceneId)

  if (gameOver) {
    return (
      <div className="vn-gameover">
        <motion.div
          className="vn-gameover-card"
          initial={{ opacity: 0, scale: 0.9, y: 30 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
        >
          <motion.div
            className="vn-gameover-badge"
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            transition={{ type: 'spring', bounce: 0.55, delay: 0.3 }}
          >🎊</motion.div>
          <h2 className="vn-gameover-title">游戏通关</h2>
          <p className="vn-gameover-sub">{game.title}</p>
          <div className="vn-gameover-stats">
            <div className="vn-stat-item">
              <span className="vn-stat-val">{fmtTime(playTime)}</span>
              <span className="vn-stat-label">游玩时长</span>
            </div>
            <div className="vn-stat-sep" />
            <div className="vn-stat-item">
              <span className="vn-stat-val">{choicesMade.length}</span>
              <span className="vn-stat-label">做出选择</span>
            </div>
            <div className="vn-stat-sep" />
            <div className="vn-stat-item">
              <span className="vn-stat-val">{scenes.length}</span>
              <span className="vn-stat-label">经历场景</span>
            </div>
          </div>
          {shareUrl && (
            <div className="alert alert-info" style={{ marginTop: 20, textAlign: 'left', fontSize: 13 }}>
              分享链接：<a href={shareUrl} target="_blank" rel="noreferrer" style={{ color: 'var(--accent2)' }}>{shareUrl}</a>
            </div>
          )}
          <div className="vn-gameover-actions">
            <button className="btn btn-primary" onClick={() => {
              setSceneId(scenes[0].id)
              setDialogueIdx(0)
              setChoicesMade([])
              setGameOver(false)
              if (scenes[0].title) {
                setCurrentSceneTitle(scenes[0].title)
                setShowSceneTitle(true)
                setTimeout(() => setShowSceneTitle(false), 2200)
              }
            }}>🔄 重新游玩</button>
            {!shareUrl && (
              <button className="btn btn-ghost" onClick={handleShare}>📤 分享游戏</button>
            )}
            <button className="btn btn-ghost" onClick={() => navigate('/history')}>{'←'} 返回列表</button>
          </div>
        </motion.div>
      </div>
    )
  }

  const isNarrator = !speakingId || speakingId.toUpperCase() === 'NARRATOR'
  const showChoices = done && dialogueIdx >= dialogues.length - 1 && scene?.choices && scene.choices.length > 0

  return (
    <div className="vn-player" onClick={hideUI ? () => setHideUI(false) : (!showChoices && !showSceneTitle ? advance : undefined)}>
      {/* 背景 */}
      <AnimatePresence mode="wait">
        <motion.div
          key={sceneId}
          className="vn-background"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.7 }}
          style={{ backgroundImage: scene?.background_url ? `url(${scene.background_url})` : 'linear-gradient(135deg,#1a1040,#0a0a1a)' }}
        />
      </AnimatePresence>
      <div className="vn-background-overlay" />

      {/* CG 图全屏 overlay */}
      <AnimatePresence>
        {showCgOverlay && cgOverlayUrl && (
          <motion.div
            className="vn-cg-overlay"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.5 }}
            onClick={e => { e.stopPropagation(); setShowCgOverlay(false) }}
          >
            {cgOverlayVideoUrl ? (
              <video
                className="vn-cg-media"
                src={cgOverlayVideoUrl}
                autoPlay
                loop
                muted
                playsInline
              />
            ) : (
              <img className="vn-cg-media" src={cgOverlayUrl} alt="CG" />
            )}
            <div className="vn-cg-hint">点击继续</div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* 场景标题 overlay */}
      <AnimatePresence>
        {showSceneTitle && (
          <motion.div
            className="vn-scene-title-overlay"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.45 }}
          >
            <motion.div
              className="vn-scene-title-text"
              initial={{ y: 20, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: -16, opacity: 0 }}
              transition={{ duration: 0.45, delay: 0.05 }}
            >
              {currentSceneTitle}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {hideUI && (
        <button
          onClick={e => { e.stopPropagation(); setHideUI(false) }}
          title="显示界面 (H)"
          style={{
            position: 'absolute', top: 12, right: 12, zIndex: 50,
            background: 'rgba(0,0,0,0.35)', border: '1px solid rgba(255,255,255,0.2)',
            color: '#fff', borderRadius: 999, padding: '6px 12px',
            fontSize: 12, cursor: 'pointer', backdropFilter: 'blur(4px)',
          }}
        >👁 显示界面 (H)</button>
      )}

      {/* 顶栏 */}
      {!hideUI && (
      <div className="vn-topbar" onClick={e => e.stopPropagation()}>
        <button className="vn-exit-btn" onClick={() => navigate('/history')}>
          <svg viewBox="0 0 20 20" width="16" height="16" fill="currentColor" style={{ marginRight: 4 }}>
            <path d="M10 18L2 10l8-8 1.41 1.41L5.83 9H18v2H5.83l5.59 5.59L10 18z"/>
          </svg>
          退出
        </button>

        <div className="vn-topbar-center">
          <span className="vn-title-label">{game.title ?? '视觉小说'}</span>
          {scenes.length > 1 && (
            <div className="vn-scene-dots">
              {scenes.map((s, i) => (
                <span
                  key={s.id}
                  className={`vn-scene-dot${i === sceneIndex ? ' vn-scene-dot--active' : i < sceneIndex ? ' vn-scene-dot--done' : ''}`}
                />
              ))}
            </div>
          )}
        </div>

        <div className="vn-topbar-right" onClick={e => e.stopPropagation()}>
          <span className="vn-playtime">{fmtTime(playTime)}</span>
          <AnimatePresence>
            {saveMsg && (
              <motion.span
                initial={{ opacity: 0, x: 10 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0 }}
                style={{ color: '#4ade80', fontSize: 12 }}
              >{saveMsg}</motion.span>
            )}
          </AnimatePresence>
          <button className="vn-save-btn" onClick={() => setHideUI(true)} title="隐藏对话框 (H)">隐藏</button>
          <button className="vn-save-btn" onClick={() => setMuted(m => !m)} title={muted ? '取消静音' : '静音'}>
            <svg viewBox="0 0 20 20" width="15" height="15" fill="currentColor">
              {muted
                ? <path d="M3 7v6h4l5 4V3L7 7H3zm13.59 5L19 14.41 17.59 16 15 13.41 12.41 16 11 14.59 13.59 12 11 9.41 12.41 8 15 10.59 17.59 8 19 9.41 16.59 12z"/>
                : <path d="M3 7v6h4l5 4V3L7 7H3zm10.5 0v6c1.66-.53 3-2.34 3-3s-1.34-3.47-3-3z"/>}
            </svg>
            {muted ? '已静音' : '静音'}
          </button>
          <button className="vn-save-btn" onClick={handleSave}>
            <svg viewBox="0 0 20 20" width="15" height="15" fill="currentColor">
              <path d="M17 3H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V5l-2-2zm-5 14a3 3 0 1 1 0-6 3 3 0 0 1 0 6zm3-10H5V5h10v2z"/>
            </svg>
            存档
          </button>
          <button className="vn-timeline-btn" onClick={() => setShowTimeline(true)} title="查看故事线">
            <svg viewBox="0 0 20 20" width="15" height="15" fill="currentColor">
              <path d="M3 4h14v2H3V4zm0 5h10v2H3V9zm0 5h14v2H3v-2z"/>
            </svg>
            故事线
          </button>
        </div>
      </div>
      )}

      {/* 角色立绘 - 左 */}
      <AnimatePresence>
        {leftPortrait && !showChoices && !showSceneTitle && (
          <motion.div
            key={`left-${sceneId}`}
            className="vn-char-left"
            initial={{ opacity: 0, x: -30 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -30 }}
            transition={{ duration: 0.35 }}
          >
            <PortraitImage src={leftPortrait} className={`vn-portrait${leftActive ? '' : ' vn-portrait--inactive'}`} alt={leftChar?.name} />
          </motion.div>
        )}
      </AnimatePresence>

      {/* 角色立绘 - 右 */}
      <AnimatePresence>
        {rightPortrait && !showChoices && !showSceneTitle && (
          <motion.div
            key={`right-${sceneId}`}
            className="vn-char-right"
            initial={{ opacity: 0, x: 30 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 30 }}
            transition={{ duration: 0.35 }}
          >
            <PortraitImage src={rightPortrait} className={`vn-portrait${rightActive ? '' : ' vn-portrait--inactive'}`} alt={rightChar?.name} />
          </motion.div>
        )}
      </AnimatePresence>

      {/* 选项 */}
      <AnimatePresence>
        {showChoices && (
          <motion.div
            className="vn-choices"
            initial={{ opacity: 0, y: 30 }} animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.4 }}
            onClick={e => e.stopPropagation()}
          >
            <div className="vn-choices-prompt">◆ 做出你的选择</div>
            {scene!.choices!.map((c, i) => (
              <motion.button
                key={i}
                className="choice-btn"
                initial={{ opacity: 0, x: -24 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: i * 0.1 }}
                whileHover={{ x: 6 }}
                onClick={e => { e.stopPropagation(); handleChoice(i) }}
              >
                <span className="choice-num">{i + 1}</span>
                {(c as any).text || (c as any).option_text || ''}
              </motion.button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>

      {/* 对话框 */}
      {!hideUI && !showChoices && !showSceneTitle && (
        <AnimatePresence mode="wait">
          <motion.div
            key={`${sceneId}-${dialogueIdx}`}
            className={`vn-dialogue-box${isNarrator ? ' vn-narrator' : ''}`}
            initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
            transition={{ duration: 0.22 }}
          >
            {!isNarrator && (
              <div className="vn-speaker">
                <span className="vn-speaker-name">{speakerName}</span>
              </div>
            )}
            {isNarrator && (
              <div className="vn-narrator-label">· 旁白 ·</div>
            )}
            <div className="vn-text">
              {displayed}
              {!done && <span className="vn-cursor">▋</span>}
            </div>
            <div className="vn-controls">
              <span className="vn-dialogue-count">
                {dialogueIdx + 1} / {dialogues.length}
              </span>
              <button className="vn-advance-btn" onClick={e => { e.stopPropagation(); advance() }}>
                {!done ? '跳过' : (dialogueIdx < dialogues.length - 1 ? '继续' : (scene?.next_scene ? '下一章' : '结局'))}
                <svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor" style={{ marginLeft: 5 }}>
                  <polygon points="4,2 12,8 4,14"/>
                </svg>
              </button>
            </div>
          </motion.div>
        </AnimatePresence>
      )}

      {/* 隐藏音频元素 */}
      <audio ref={bgmRef} preload="auto" style={{ display: 'none' }} />
      <audio ref={voiceRef} preload="auto" style={{ display: 'none' }} />

      {/* 故事线面板 */}
      <AnimatePresence>
        {showTimeline && game && (
          <StoryTimeline
            game={game}
            currentSceneId={sceneId}
            visitedScenes={visitedScenes}
            choicesMade={choicesMade as Array<{ scene: string; choice: number; text: string }>}
            onClose={() => setShowTimeline(false)}
          />
        )}
      </AnimatePresence>
    </div>
  )
}
