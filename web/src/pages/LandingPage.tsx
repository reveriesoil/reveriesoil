import React, { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { generateGame, getAIConfig } from '../api'
import type { AIConfigResponse } from '../types'
import SettingsModal from '../components/SettingsModal'

// ─── 风格选项 ──────────────────────────────────────────────────────────────────
const STORY_STYLES = ['言�?, '悬疑', '奇幻', '科幻', '治愈', '历史', '恐�?, '冒险']
const ART_STYLES   = ['动漫', '写实', '水彩', '像素', '古风', '赛博朋克']

const IconPlay = () => (
  <svg viewBox="0 0 24 24" width="16" height="18" fill="none" stroke="#3d2b1e" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <circle cx="12" cy="12" r="10"/>
    <polygon points="10,8 17,12 10,16" fill="#3d2b1e" stroke="none"/>
  </svg>
)
const IconHistory = () => (
  <svg viewBox="0 0 24 24" width="16" height="18" fill="none" stroke="#3d2b1e" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M3 12a9 9 0 1 0 9-9 9 9 0 0 0-6.16 2.5L3 7"/>
    <polyline points="3,3 3,7 7,7"/>
    <polyline points="12,7 12,12 15,15"/>
  </svg>
)
const IconSettingsOutline = () => (
  <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
  </svg>
)
const IconStart = () => (
  <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden>
    <polygon points="5,3 19,12 5,21"/>
  </svg>
)
const IconClose = () => (
  <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden>
    <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
  </svg>
)
const Sparkle = ({ style }: { style?: React.CSSProperties }) => (
  <svg viewBox="0 0 20 20" width="16" height="16" fill="white" style={{ position: 'absolute', opacity: 0.85, ...style }} aria-hidden>
    <path d="M10 0 L11.5 8.5 L20 10 L11.5 11.5 L10 20 L8.5 11.5 L0 10 L8.5 8.5 Z" />
  </svg>
)

export default function LandingPage() {
  const navigate = useNavigate()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [panelOpen, setPanelOpen] = useState(false)

  const [autoGen, setAutoGen]         = useState(false)
  const [autoLang, setAutoLang]       = useState('zh')
  const [storyTitle, setStoryTitle]   = useState('')
  const [storyPrompt, setStoryPrompt] = useState('')
  const [characters, setCharacters]   = useState<{ name: string; personality: string; appearance: string }[]>([])
  const [storyStyle, setStoryStyle]       = useState('')
  const [artStyle, setArtStyle]           = useState('')
  const [quickDuration, setQuickDuration] = useState(30)
  const [storyDepth, setStoryDepth]       = useState(2)
  const [interactionLevel, setInteractionLevel] = useState(3)
  const [savedConfig, setSavedConfig] = useState<AIConfigResponse | null>(null)

  const [loading, setLoading] = useState(false)
  const [error, setError]     = useState('')

  const openPanel = () => {
    setError('')
    setPanelOpen(true)
    getAIConfig().then(r => {
      const def = r.data.find((c: AIConfigResponse) => c.is_default) ?? r.data[0]
      if (def) setSavedConfig(def)
    }).catch(() => {})
  }

  const closePanel = () => { if (!loading) setPanelOpen(false) }

  const AUTO_LANG_PROMPTS: Record<string, string> = {
    zh: '请用中文完全自动生成一个有趣的视觉小说故事',
    en: 'Please fully automatically generate an interesting visual novel story in English',
    ja: '面白いビジュアルノベルのストーリーを日本語で完全自動生成してください',
    ko: '흥미로운 비주�?노벨 스토리를 한국어로 완전 자동으로 생성�?주세�?,
  }

  const handleSubmit = async () => {
    setError('')
    if (!savedConfig) { setError('请先点击右上角「设置」配�?AI 模型 API Key'); return }
    if (!autoGen && !storyPrompt.trim()) { setError('请输入故事提示词，或勾�?完全自动生成"'); return }
    if (!storyStyle) { setError('请选择故事风格类型（言�?悬疑/奇幻 等）'); return }
    if (!artStyle)   { setError('请选择绘画风格（动�?写实/水彩 等）'); return }
    const finalPrompt = autoGen
      ? (AUTO_LANG_PROMPTS[autoLang] ?? AUTO_LANG_PROMPTS['zh'])
      : storyPrompt.trim()

    const aiConfig: Record<string, unknown> = savedConfig ? {
      text_model:  savedConfig.text_model,
      image_model: savedConfig.image_model,
      voice_model: savedConfig.voice_model,
    } : {}

    // 格式化人物设定（性格 + 形象 拆分�?    const charLines = characters
      .filter(c => c.name.trim() || c.personality.trim() || c.appearance.trim())
      .map((c, i) => {
        const head = `角色${i + 1}${c.name.trim() ? '�? + c.name.trim() + '�? : ''}`
        const segs: string[] = []
        if (c.personality.trim()) segs.push(`性格�?{c.personality.trim()}`)
        if (c.appearance.trim())  segs.push(`形象�?{c.appearance.trim()}`)
        return `${head}�?{segs.join('�?)}`
      })
    const charPromptStr = charLines.length >= 1 ? charLines.join('\n') : ''

    setLoading(true)
    try {
      const res = await generateGame({
        prompt: finalPrompt,
        character_prompt: !autoGen ? (charPromptStr || undefined) : undefined,
        story_style: storyStyle || undefined,
        art_style:   artStyle   || undefined,
        ai_config: aiConfig,
        story_spec: {
          duration_minutes: quickDuration,
          branch_enabled:   interactionLevel >= 2,
          depth: storyDepth,
          interaction_level: interactionLevel,
          ...(storyTitle.trim() ? { title: storyTitle.trim() } : {}),
        },
      })
      navigate(`/generating/${res.data.game_id}?task_id=${res.data.task_id}`)
    } catch (err: unknown) {
      const e = err as { response?: { data?: { detail?: string } } }
      setError(e.response?.data?.detail ?? '提交失败，请稍后重试')
      setLoading(false)
    }
  }

  const menuItems = [
    { icon: <IconPlay />,    label: '开始游�?, onClick: openPanel },
    { icon: <IconHistory />, label: '我的故事', onClick: () => navigate('/history') },
  ]

  const containerVariants = {
    hidden: {},
    show: { transition: { staggerChildren: 0.09 } },
  }
  const itemVariants = {
    hidden: { opacity: 0, y: 24, scale: 0.97 },
    show:   { opacity: 1, y: 0,  scale: 1, transition: { duration: 0.42, ease: 'easeOut' as const } },
  }

  return (
    <div className="landing-root">
      <div className={`landing-bg${panelOpen ? ' landing-bg--blurred' : ''}`} />
      <div className="landing-bg-overlay" />

      <motion.div
        className="landing-header"
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, delay: 0.1 }}
        style={{ position: 'absolute' }}
      >
        <motion.button
          className="landing-icon-btn"
          title="AI 模型配置"
          whileHover={{ scale: 1.08 }} whileTap={{ scale: 0.93 }}
          onClick={() => setSettingsOpen(true)}
        ><IconSettingsOutline /></motion.button>
      </motion.div>

      <motion.div className="landing-logo-area"
        initial={{ opacity: 0, y: -28 }} animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.85, ease: [0.22, 1, 0.36, 1] }}
      >
        <Sparkle style={{ top: 20, right: -8,  width: 14, height: 14 }} />
        <Sparkle style={{ top: -4, right: 40,  width: 10, height: 10, opacity: 0.6 }} />
        <Sparkle style={{ top: 60, left: 10,   width: 12, height: 12, opacity: 0.7 }} />
        <img src="/reveriesoil-logo.png" alt="ReverieSoil 梦壤" className="landing-logo" draggable={false} />
      </motion.div>

      <motion.div className="landing-menu" variants={containerVariants}
        initial="hidden" animate="show" style={{ position: 'relative', zIndex: 10 }}
      >
        {menuItems.map((item) => (
          <motion.button key={item.label}
            className="landing-menu-btn"
            variants={itemVariants} whileHover={{}} whileTap={{}}
            onClick={item.onClick}
          >
            <span className="landing-btn-icon">{item.icon}</span>
            <span className="landing-btn-label">{item.label}</span>
          </motion.button>
        ))}
      </motion.div>

      <div className="landing-footer-left">ReverieSoil 梦壤 OSS 0.6.2</div>
      <div className="landing-footer-right">开源版 · WeiCui / 微萃科技</div>

      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />

      <AnimatePresence>
        {panelOpen && (
          <>
            <motion.div className="setup-backdrop"
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              onClick={closePanel}
            />
            <div className="setup-center">
            <motion.div className="setup-panel"
              initial={{ opacity: 0, y: 40, scale: 0.97 }}
              animate={{ opacity: 1, y: 0,  scale: 1 }}
              exit={{   opacity: 0, y: 24, scale: 0.96 }}
              transition={{ type: 'spring', stiffness: 360, damping: 34 }}
            >
              <div className="setup-header">
                <span className="setup-title">开始游�?/span>
                <button className="setup-close-btn" onClick={closePanel} disabled={loading} aria-label="关闭"><IconClose /></button>
              </div>

              {error && <div className="setup-error">{error}</div>}

              {!savedConfig && (
                <div className="setup-error" style={{ marginBottom: 8 }}>
                  ⚠️ 尚未配置 AI 模型，请先点击右上角「设置」填�?API Key
                  <button
                    type="button"
                    style={{ marginLeft: 10, textDecoration: 'underline', background: 'none', border: 'none', cursor: 'pointer', color: 'inherit', fontSize: 'inherit' }}
                    onClick={() => { closePanel(); setSettingsOpen(true) }}
                  >前往配置</button>
                </div>
              )}

              <div className="setup-body">
                <label className="setup-checkbox-row">
                  <input type="checkbox" checked={autoGen} onChange={e => setAutoGen(e.target.checked)} />
                  <span>完全自动生成（AI 自由发挥故事与角色）</span>
                </label>

                {autoGen && (
                  <div className="setup-field">
                    <label className="setup-label">生成语言</label>
                    <div className="setup-pills">
                      {([['zh', '中文'], ['en', 'English'], ['ja', '日語'], ['ko', '한국�?]] as [string, string][]).map(([val, label]) => (
                        <button key={val} type="button"
                          className={`setup-pill${autoLang === val ? ' setup-pill--active' : ''}`}
                          onClick={() => setAutoLang(val)}
                        >{label}</button>
                      ))}
                    </div>
                  </div>
                )}

                <div className="setup-field">
                  <label className="setup-label">故事标题<span className="setup-optional"> （选填�?/span></label>
                  <input type="text" className="setup-style-input"
                    placeholder="为你的故事起个名字，留空则由 AI 自动取名"
                    value={storyTitle} onChange={e => setStoryTitle(e.target.value)}
                    maxLength={40} disabled={autoGen}
                  />
                </div>

                <div className="setup-field">
                  <label className="setup-label">故事时长</label>
                  <div className="uh-depth-btns">
                    {[
                      { val: 15,  label: '短篇',  desc: '~15分钟',  novel: false },
                      { val: 30,  label: '标准',  desc: '~30分钟',  novel: false },
                      { val: 60,  label: '长篇',  desc: '~1小时',   novel: false },
                      { val: 120, label: '史诗',  desc: '~2小时',   novel: false },
                      { val: -1,  label: '极致',  desc: '完整小说', novel: true  },
                    ].map(d => (
                      <button key={d.val} type="button"
                        className={`uh-depth-btn${quickDuration === d.val ? ' uh-depth-btn--active' : ''}${d.novel ? ' uh-depth-btn--novel' : ''}`}
                        onClick={() => setQuickDuration(d.val)}
                        disabled={loading}
                      >
                        <span className="uh-depth-btn-name">{d.label}</span>
                        <span className="uh-depth-btn-desc">{d.desc}</span>
                      </button>
                    ))}
                  </div>
                </div>

                <div className="setup-field">
                  <label className="setup-label">叙事深度</label>
                  <div className="uh-depth-btns">
                    {[
                      { level: 1, label: '轻盈', desc: '直白温暖'    },
                      { level: 2, label: '标准', desc: '易读有层�?  },
                      { level: 3, label: '深沉', desc: '含蓄有潜台词'},
                      { level: 4, label: '厚重', desc: '多义耐细�?  },
                      { level: 5, label: '极致', desc: '余韵无穷'    },
                    ].map(d => (
                      <button key={d.level} type="button"
                        className={`uh-depth-btn${storyDepth === d.level ? ' uh-depth-btn--active' : ''}`}
                        onClick={() => setStoryDepth(d.level)}
                        disabled={loading}
                      >
                        <span className="uh-depth-btn-name">{d.label}</span>
                        <span className="uh-depth-btn-desc">{d.desc}</span>
                      </button>
                    ))}
                  </div>
                </div>

                <div className="setup-field">
                  <label className="setup-label">交互程度<span className="setup-optional"> 越高 �?选择节点越多，剧情走向更多元</span></label>
                  <div className="uh-depth-btns">
                    {[
                      { level: 1, label: '沉浸观影', desc: '全程无选择'   },
                      { level: 2, label: '轻度',     desc: '1 个关键选择' },
                      { level: 3, label: '标准',     desc: '2-3 个分�?   },
                      { level: 4, label: '高互�?,   desc: '4-5 个分�?   },
                      { level: 5, label: '极致',     desc: '多结局网状'   },
                    ].map(d => (
                      <button key={d.level} type="button"
                        className={`uh-depth-btn${interactionLevel === d.level ? ' uh-depth-btn--active' : ''}`}
                        onClick={() => setInteractionLevel(d.level)}
                        disabled={loading}
                      >
                        <span className="uh-depth-btn-name">{d.label}</span>
                        <span className="uh-depth-btn-desc">{d.desc}</span>
                      </button>
                    ))}
                  </div>
                </div>

                <div className="setup-field">
                  <label className="setup-label">故事提示词{autoGen && <span className="setup-optional"> （已自动�?/span>}</label>
                  <textarea className="setup-textarea" rows={3} disabled={autoGen}
                    placeholder="例：一个少女在废弃图书馆发现了一封来自未来的�?.."
                    value={storyPrompt} onChange={e => setStoryPrompt(e.target.value)}
                  />
                </div>

                <div className="setup-field">
                  <label className="setup-label">人物设定<span className="setup-optional"> （选填，留空则�?AI 自动生成�?/span></label>
                  <div className="char-list">
                    {characters.map((char, idx) => (
                      <div key={idx} className="char-row">
                        <span className="char-row-num">{idx + 1}</span>
                        <input
                          className="char-name-input"
                          type="text"
                          placeholder="角色�?
                          disabled={autoGen}
                          value={char.name}
                          onChange={e => {
                            const next = [...characters]
                            next[idx] = { ...next[idx], name: e.target.value }
                            setCharacters(next)
                          }}
                        />
                        <div className="char-desc-stack">
                          <textarea
                            className="char-desc-input"
                            rows={2}
                            placeholder="人物性格设定（如：内向、聪明、外冷内�?..�?
                            disabled={autoGen}
                            value={char.personality}
                            onChange={e => {
                              const next = [...characters]
                              next[idx] = { ...next[idx], personality: e.target.value }
                              setCharacters(next)
                            }}
                          />
                          <textarea
                            className="char-desc-input"
                            rows={2}
                            placeholder="人物形象设定（如：长发蓝瞳、红色制服、身高约 165cm...�?
                            disabled={autoGen}
                            value={char.appearance}
                            onChange={e => {
                              const next = [...characters]
                              next[idx] = { ...next[idx], appearance: e.target.value }
                              setCharacters(next)
                            }}
                          />
                        </div>
                        <button
                          type="button"
                          className="char-remove-btn"
                          title="删除角色"
                          disabled={autoGen}
                          onClick={() => setCharacters(characters.filter((_, i) => i !== idx))}
                        >×</button>
                      </div>
                    ))}
                    {characters.length < 5 && (
                      <button
                        type="button"
                        className="char-add-btn"
                        disabled={autoGen}
                        onClick={() => setCharacters([...characters, { name: '', personality: '', appearance: '' }])}
                      >�?添加角色</button>
                    )}
                  </div>
                </div>

                <div className="setup-field">
                  <label className="setup-label">故事风格</label>
                  <div className="setup-pills">
                    {STORY_STYLES.map(s => (
                      <button key={s} type="button"
                        className={`setup-pill${storyStyle === s ? ' setup-pill--active' : ''}`}
                        onClick={() => setStoryStyle(storyStyle === s ? '' : s)}
                      >{s}</button>
                    ))}
                  </div>
                  <input
                    type="text"
                    className="setup-style-input"
                    placeholder="或输入自定义风格，如：蒸汽朋克、洛可可..."
                    value={storyStyle}
                    onChange={e => setStoryStyle(e.target.value)}
                  />
                </div>

                <div className="setup-field">
                  <label className="setup-label">画风风格</label>
                  <div className="setup-pills">
                    {ART_STYLES.map(s => (
                      <button key={s} type="button"
                        className={`setup-pill${artStyle === s ? ' setup-pill--active' : ''}`}
                        onClick={() => setArtStyle(artStyle === s ? '' : s)}
                      >{s}</button>
                    ))}
                  </div>
                  <input
                    type="text"
                    className="setup-style-input"
                    placeholder="或输入自定义画风，如：浮世绘、油画风..."
                    value={artStyle}
                    onChange={e => setArtStyle(e.target.value)}
                  />
                </div>
              </div>

              <div className="setup-footer">
                <motion.button
                  className="setup-submit-btn"
                  onClick={handleSubmit}
                  disabled={loading || !savedConfig || !storyStyle || !artStyle}
                  whileHover={loading ? {} : { scale: 1.02 }}
                  whileTap={loading ? {} : { scale: 0.98 }}
                >
                  {loading ? (
                    <><div className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }} /> 生成�?..</>
                  ) : (
                    <><IconStart /> 开始生�?/>
                  )}
                </motion.button>
              </div>
            </motion.div>
            </div>
          </>
        )}
      </AnimatePresence>
    </div>
  )
}
