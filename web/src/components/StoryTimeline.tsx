import React, { useRef, useEffect } from 'react'
import { motion } from 'framer-motion'
import type { GameDetail } from '../types'

interface ChoiceRecord {
  scene: string
  choice: number
  text: string
}

interface StoryTimelineProps {
  game: GameDetail
  currentSceneId: string
  visitedScenes: Set<string>
  choicesMade: ChoiceRecord[]
  onClose: () => void
}

export default function StoryTimeline({
  game,
  currentSceneId,
  visitedScenes,
  choicesMade,
  onClose,
}: StoryTimelineProps) {
  const scenes = game.script_json?.scenes ?? []
  const currentRef = useRef<HTMLDivElement | null>(null)

  // 打开时自动滚动到当前场景
  useEffect(() => {
    const el = currentRef.current
    if (el) {
      setTimeout(() => el.scrollIntoView({ behavior: 'smooth', block: 'center' }), 120)
    }
  }, [])

  const getChoiceForScene = (sceneId: string): ChoiceRecord | undefined =>
    choicesMade.find(c => c.scene === sceneId)

  const exploredCount = scenes.filter(s => visitedScenes.has(s.id)).length

  return (
    <motion.div
      className="stl-overlay"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
      onClick={onClose}
    >
      <motion.div
        className="stl-panel"
        initial={{ x: '100%' }}
        animate={{ x: 0 }}
        exit={{ x: '100%' }}
        transition={{ type: 'spring', damping: 28, stiffness: 280 }}
        onClick={e => e.stopPropagation()}
      >
        {/* 标题栏 */}
        <div className="stl-header">
          <div className="stl-header-left">
            <svg viewBox="0 0 20 20" width="16" height="16" fill="currentColor" style={{ flexShrink: 0 }}>
              <path d="M3 4h14v2H3V4zm0 5h10v2H3V9zm0 5h14v2H3v-2z"/>
            </svg>
            <span className="stl-header-title">故事线</span>
          </div>
          <div className="stl-header-sub">{exploredCount} / {scenes.length} 场景已探索</div>
          <button className="stl-close-btn" onClick={onClose} title="关闭">✕</button>
        </div>

        {/* 图例 */}
        <div className="stl-legend">
          <span className="stl-legend-item stl-legend--current">▶ 当前</span>
          <span className="stl-legend-item stl-legend--visited">✓ 已访问</span>
          <span className="stl-legend-item stl-legend--future">? 未探索</span>
        </div>

        {/* 场景列表 */}
        <div className="stl-body">
          {scenes.map((scene, idx) => {
            const isVisited = visitedScenes.has(scene.id)
            const isCurrent = scene.id === currentSceneId
            const isRevealed = isVisited || isCurrent
            const choiceRecord = getChoiceForScene(scene.id)
            const hasChoices = (scene.choices?.length ?? 0) > 0

            return (
              <div key={scene.id} className="stl-scene-wrapper">
                {/* 连接线 */}
                {idx > 0 && (
                  <div className={`stl-connector${isRevealed ? ' stl-connector--visited' : ''}`} />
                )}

                {/* 场景卡片（仅展示，不可点击跳转） */}
                <div
                  ref={isCurrent ? currentRef : undefined}
                  className={[
                    'stl-scene-node',
                    isCurrent ? 'stl-scene-node--current' : '',
                    isVisited && !isCurrent ? 'stl-scene-node--visited' : '',
                    !isRevealed ? 'stl-scene-node--future' : '',
                  ].join(' ')}
                  title={isRevealed ? (scene.title ?? `场景 ${idx + 1}`) : '未探索的故事'}
                >
                  {/* 缩略图 */}
                  {scene.background_url && isRevealed ? (
                    <div
                      className="stl-scene-thumb"
                      style={{ backgroundImage: `url(${scene.background_url})` }}
                    />
                  ) : (
                    <div className="stl-scene-thumb stl-scene-thumb--empty">
                      {isRevealed ? idx + 1 : '?'}
                    </div>
                  )}

                  {/* 信息 */}
                  <div className="stl-scene-info">
                    <div className="stl-scene-num">第 {idx + 1} 场</div>
                    <div className="stl-scene-title-row">
                      <span className={`stl-scene-name${!isRevealed ? ' stl-scene-name--hidden' : ''}`}>
                        {isRevealed ? (scene.title ?? `场景 ${idx + 1}`) : '???'}
                      </span>
                      {isCurrent && <span className="stl-current-badge">当前</span>}
                    </div>
                    {hasChoices && isRevealed && (
                      <div className="stl-scene-meta">
                        {scene.choices!.length} 个选项
                      </div>
                    )}
                  </div>

                  {/* 状态图标 */}
                  <div className="stl-scene-status-icon">
                    {isCurrent ? (
                      <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor">
                        <path d="M5 3l8 5-8 5V3z"/>
                      </svg>
                    ) : isVisited ? (
                      <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor">
                        <path d="M13 3L6 10.59 3 7.6 1.59 9l4.41 4.41 8-8z"/>
                      </svg>
                    ) : (
                      <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor">
                        <path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm0 12A5 5 0 1 1 8 3a5 5 0 0 1 0 10zm-.5-8h1v5h-1zm0 6h1v1h-1z"/>
                      </svg>
                    )}
                  </div>
                </div>

                {/* 选择分支（已访问且有选项时显示；未访问不展示） */}
                {hasChoices && isRevealed && (
                  <div className="stl-choices-block">
                    {scene.choices!.map((choice, ci) => {
                      const chosen = choiceRecord?.choice === ci
                      const targetId = choice.next_scene_id ?? choice.next_scene
                      const targetScene = targetId ? scenes.find(s => s.id === targetId) : undefined
                      const targetIdx = targetScene ? scenes.indexOf(targetScene) : -1
                      const hasChosen = !!choiceRecord

                      return (
                        <div
                          key={ci}
                          className={`stl-choice-item${chosen ? ' stl-choice-item--chosen' : ' stl-choice-item--other'}`}
                        >
                          <span className="stl-choice-bullet">{chosen ? '●' : '○'}</span>
                          <span className="stl-choice-text">
                            {hasChosen ? choice.text : (chosen ? choice.text : '???')}
                          </span>
                          {chosen && targetScene && targetIdx >= 0 && (
                            <span className="stl-choice-dest">→ 第 {targetIdx + 1} 场</span>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            )
          })}

          {scenes.length === 0 && (
            <div className="stl-empty">暂无场景数据</div>
          )}
        </div>
      </motion.div>
    </motion.div>
  )
}
