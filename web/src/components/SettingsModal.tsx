/**
 * SettingsModal - 开源版 AI 配置弹窗
 * 用户自行填写 Base URL / API Key / 模型名称，不内置任何预设凭据。
 */
import React, { useEffect, useState, useCallback } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { getAIConfig, saveAIConfig, testModel } from '../api'
import type { AIConfigResponse } from '../types'

const IconText = () => (
  <svg viewBox="0 0 18 18" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M3 3h12M5 3v12M11 3v12M3 15h6" />
  </svg>
)
const IconImage = () => (
  <svg viewBox="0 0 18 18" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <rect x="2" y="3" width="14" height="12" rx="1.5" />
    <circle cx="6" cy="7" r="1.2" />
    <path d="M2 12 L6 9 L10 12 L13 10 L16 13" />
  </svg>
)
const IconVoice = () => (
  <svg viewBox="0 0 18 18" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M9 2v14M5 5v8M13 5v8M2 7v4M16 7v4" />
  </svg>
)
const IconLayers = () => (
  <svg viewBox="0 0 18 18" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M9 2 L16 6 L9 10 L2 6 Z" />
    <path d="M2 10 L9 14 L16 10" />
  </svg>
)
const IconInfo = () => (
  <svg viewBox="0 0 18 18" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <circle cx="9" cy="9" r="7" />
    <path d="M9 8v5M9 5.5v0.01" />
  </svg>
)
const IconKey = () => (
  <svg viewBox="0 0 18 18" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <circle cx="6" cy="9" r="3" />
    <path d="M9 9h7M14 9v3M16 9v2" />
  </svg>
)
const IconLink = () => (
  <svg viewBox="0 0 18 18" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M7 11a3 3 0 0 0 4 0l3-3a3 3 0 0 0-4-4l-1 1" />
    <path d="M11 7a3 3 0 0 0-4 0l-3 3a3 3 0 0 0 4 4l1-1" />
  </svg>
)
const IconSave = () => (
  <svg viewBox="0 0 18 18" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M3 3h10l3 3v9a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" />
    <path d="M5 3v4h7V3M6 11h6v5H6z" />
  </svg>
)
const IconClose = () => (
  <svg viewBox="0 0 14 14" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
    <path d="M2 2 L12 12 M12 2 L2 12" />
  </svg>
)
const IconChevron = ({ open }: { open: boolean }) => (
  <svg viewBox="0 0 14 14" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden
       style={{ transform: open ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 0.18s' }}>
    <path d="M5 3 L10 7 L5 11" />
  </svg>
)
const IconCheck = () => (
  <svg viewBox="0 0 14 14" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M2 7 L6 11 L12 3" />
  </svg>
)
const IconModelBox = () => (
  <svg viewBox="0 0 18 18" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <rect x="2" y="3" width="14" height="12" rx="1.5" />
    <path d="M5 8h8M5 11h5" />
  </svg>
)
const IconFlash = () => (
  <svg viewBox="0 0 18 18" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M10 2 L5 10 h4 L8 16 L14 8 h-4 Z" />
  </svg>
)

// ─── 数据类型 ──────────────────────────────────────────────────────────────────
interface ModelValue {
  provider: string
  model: string
  api_key: string
  endpoint: string
}

function emptyModel(): ModelValue {
  return { provider: 'custom', model: '', api_key: '', endpoint: '' }
}

const TEXT_AGENTS: { key: string; name: string; desc: string }[] = [
  { key: 'outline',         name: '总编剧',     desc: '故事大纲 / 人物档案 / 场景规划' },
  { key: 'refine',          name: '剧本统筹',   desc: '检查结构 / 一致性 / 节奏并修正' },
  { key: 'director',        name: '艺术总监',   desc: '画面风格 / 人物视觉 / 配音风格' },
  { key: 'image_prompts',   name: '执行导演',   desc: '生成详细绘图 prompt' },
  { key: 'voice_direction', name: '配音导演',   desc: '为角色生成 TTS 音色提示词' },
  { key: 'storyboard',      name: '分镜师',     desc: '展开为完整对话与选项' },
]

// ─── 单模型配置区块 ─────────────────────────────────────────────────────────────
interface ModelSectionProps {
  icon: React.ReactNode
  title: string
  desc?: string
  value: ModelValue
  onChange: (v: ModelValue) => void
  required?: boolean
  skippable?: boolean
  skipped?: boolean
  onSkipToggle?: () => void
  compact?: boolean
  modelType?: 'text' | 'image' | 'voice'
}

type TestState = { status: 'idle' } | { status: 'testing' } | { status: 'ok'; msg: string; ms: number } | { status: 'fail'; msg: string; ms: number }

function ModelSection({
  icon, title, desc, value, onChange, required, skippable, skipped, onSkipToggle, compact, modelType,
}: ModelSectionProps) {
  const [showKey, setShowKey] = useState(false)
  const [testState, setTestState] = useState<TestState>({ status: 'idle' })

  const handleTest = useCallback(async () => {
    if (!modelType) return
    setTestState({ status: 'testing' })
    try {
      const res = await testModel({ model_type: modelType, endpoint: value.endpoint, api_key: value.api_key, model: value.model })
      const { success, message, latency_ms } = res.data
      setTestState(success ? { status: 'ok', msg: message, ms: latency_ms } : { status: 'fail', msg: message, ms: latency_ms })
    } catch {
      setTestState({ status: 'fail', msg: '请求失败，请检查网络或配置', ms: 0 })
    }
  }, [modelType, value])
  return (
    <section className={`sm-section ${compact ? 'sm-section--compact' : ''} ${skipped ? 'sm-section--skipped' : ''}`}>
      {!compact && (
        <header className="sm-section-head">
          <span className="sm-section-icon">{icon}</span>
          <div className="sm-section-titles">
            <div className="sm-section-title">
              {title}
              {required && <span className="sm-required">必填</span>}
              {!required && !skippable && <span className="sm-optional">可选</span>}
            </div>
            {desc && <div className="sm-section-desc">{desc}</div>}
          </div>
          {skippable && (
            <label className="sm-skip-toggle">
              <input type="checkbox" checked={!skipped} onChange={onSkipToggle} style={{ display: 'none' }} />
              <span className={`sm-skip-track ${!skipped ? 'sm-skip-track--on' : ''}`}>
                <span className="sm-skip-thumb" />
              </span>
              <span className="sm-skip-label">{skipped ? '已跳过' : '已启用'}</span>
            </label>
          )}
        </header>
      )}
      {!skipped && (
        <div className="sm-field-grid">
          <div className="sm-field">
            <label className="sm-label"><IconLink /><span>API Base URL</span></label>
            <input
              className="sm-input"
              value={value.endpoint}
              onChange={e => onChange({ ...value, endpoint: e.target.value })}
              placeholder="https://api.openai.com/v1"
              autoComplete="off"
              spellCheck={false}
            />
            <div className="sm-hint">兼容 OpenAI 接口协议的服务地址（含 /v1）</div>
          </div>
          <div className="sm-field">
            <label className="sm-label"><IconKey /><span>API Key</span></label>
            <div className="sm-input-wrap">
              <input
                className="sm-input sm-input--key"
                type={showKey ? 'text' : 'password'}
                value={value.api_key}
                onChange={e => onChange({ ...value, api_key: e.target.value })}
                placeholder="sk-..."
                autoComplete="off"
              />
              <button
                type="button"
                className="sm-eye-btn"
                onClick={() => setShowKey(s => !s)}
                tabIndex={-1}
                aria-label={showKey ? '隐藏' : '显示'}
              >
                {showKey ? (
                  <svg viewBox="0 0 18 14" width="16" height="12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M1 7C3 3 6 1 9 1s6 2 8 6c-2 4-5 6-8 6s-6-2-8-6z" />
                    <circle cx="9" cy="7" r="2.5" />
                    <line x1="2" y1="2" x2="16" y2="12" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 18 14" width="16" height="12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M1 7C3 3 6 1 9 1s6 2 8 6c-2 4-5 6-8 6s-6-2-8-6z" />
                    <circle cx="9" cy="7" r="2.5" />
                  </svg>
                )}
              </button>
            </div>
          </div>
          <div className="sm-field">
            <label className="sm-label"><IconModelBox /><span>模型名称</span></label>
            <input
              className="sm-input"
              value={value.model}
              onChange={e => onChange({ ...value, model: e.target.value })}
              placeholder="如 gpt-4o / deepseek-v3 / qwen-plus"
              autoComplete="off"
              spellCheck={false}
            />
            <div className="sm-hint">填写服务商文档中的模型 ID，区分大小写</div>
          </div>
        </div>
      )}
      {!skipped && !compact && modelType && (
        <div className="sm-test-row">
          <button
            type="button"
            className={`sm-test-btn ${testState.status === 'testing' ? 'sm-test-btn--testing' : ''}`}
            disabled={testState.status === 'testing'}
            onClick={handleTest}
          >
            {testState.status === 'testing'
              ? <><span className="sm-test-spinner" />测试中…</>
              : <><IconFlash />测试连接</>
            }
          </button>
          {testState.status === 'ok' && (
            <span className="sm-test-result sm-test-result--ok">
              <IconCheck /> {testState.msg}{testState.ms > 0 ? ` · ${testState.ms}ms` : ''}
            </span>
          )}
          {testState.status === 'fail' && (
            <span className="sm-test-result sm-test-result--fail">
              <IconInfo /> {testState.msg}
            </span>
          )}
        </div>
      )}
      {skipped && (
        <div className="sm-skipped-tip"><IconInfo /> <span>已跳过，开启后可使用此功能。</span></div>
      )}
    </section>
  )
}

// ─── 主弹窗 ────────────────────────────────────────────────────────────────────
export default function SettingsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [text, setText] = useState<ModelValue>(emptyModel())
  const [image, setImage] = useState<ModelValue>(emptyModel())
  const [voice, setVoice] = useState<ModelValue>(emptyModel())
  const [imageSkipped, setImageSkipped] = useState(false)
  const [voiceSkipped, setVoiceSkipped] = useState(true)
  const [tokenSaveMode, setTokenSaveMode] = useState(false)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [agentEnabled, setAgentEnabled] = useState<Record<string, boolean>>({})
  const [agentOverrides, setAgentOverrides] = useState<Record<string, ModelValue>>({})
  const [msg, setMsg] = useState<{ type: 'error' | 'success'; text: string } | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!open) return
    setMsg(null)
    getAIConfig().then(r => {
      const def = r.data.find((c: AIConfigResponse) => c.is_default) ?? r.data[0]
      if (!def) return
      const tm = (def.text_model ?? {}) as ModelValue
      const im = (def.image_model ?? {}) as ModelValue
      const vm = (def.voice_model ?? {}) as ModelValue
      setText({ provider: 'custom', model: tm.model ?? '', api_key: tm.api_key ?? '', endpoint: tm.endpoint ?? '' })
      if (im.model || im.endpoint || im.api_key) {
        setImage({ provider: 'custom', model: im.model ?? '', api_key: im.api_key ?? '', endpoint: im.endpoint ?? '' })
        setImageSkipped(false)
      } else {
        setImage(emptyModel()); setImageSkipped(true)
      }
      setTokenSaveMode(!!(im as unknown as Record<string, unknown>).token_save_mode)
      if (vm.model || vm.endpoint || vm.api_key) {
        setVoice({ provider: 'custom', model: vm.model ?? '', api_key: vm.api_key ?? '', endpoint: vm.endpoint ?? '' })
        setVoiceSkipped(false)
      } else {
        setVoice(emptyModel()); setVoiceSkipped(true)
      }
      const overrides = (def.text_agent_overrides ?? {}) as Record<string, ModelValue>
      const enabled: Record<string, boolean> = {}
      const vals: Record<string, ModelValue> = {}
      for (const key of Object.keys(overrides)) {
        enabled[key] = true
        vals[key] = {
          provider: 'custom',
          model: overrides[key].model ?? '',
          api_key: overrides[key].api_key ?? '',
          endpoint: overrides[key].endpoint ?? '',
        }
      }
      setAgentEnabled(enabled)
      setAgentOverrides(vals)
    }).catch(() => {})
  }, [open])

  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open, onClose])

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault()
    setMsg(null)
    if (!text.endpoint.trim()) { setMsg({ type: 'error', text: '请填写文本模型的 API Base URL' }); return }
    if (!text.api_key.trim()) { setMsg({ type: 'error', text: '请填写文本模型的 API Key' }); return }
    if (!text.model.trim()) { setMsg({ type: 'error', text: '请填写文本模型的模型名称' }); return }
    setLoading(true)
    const overrides: Record<string, ModelValue> = {}
    for (const a of TEXT_AGENTS) {
      if (agentEnabled[a.key] && agentOverrides[a.key]) overrides[a.key] = agentOverrides[a.key]
    }
    try {
      await saveAIConfig({
        config_name: '默认配置',
        text_model: text,
        image_model: imageSkipped
          ? { provider: 'custom', model: '', api_key: '', endpoint: '' }
          : ({ ...(image as unknown as Record<string, unknown>), token_save_mode: tokenSaveMode }) as unknown as typeof image,
        voice_model: voiceSkipped
          ? { provider: 'custom', model: '', api_key: '', endpoint: '' }
          : voice,
        is_default: true,
        ...(Object.keys(overrides).length > 0 ? { text_agent_overrides: overrides } : {}),
      })
      setMsg({ type: 'success', text: '配置已保存' })
      setTimeout(onClose, 700)
    } catch (err: unknown) {
      const e = err as { response?: { data?: { detail?: string } } }
      setMsg({ type: 'error', text: e.response?.data?.detail ?? '保存失败，请重试' })
    } finally {
      setLoading(false)
    }
  }

  const enabledAgentCount = TEXT_AGENTS.filter(a => agentEnabled[a.key]).length

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="sm-backdrop"
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          onClick={onClose}
        >
          <motion.div
            className="sm-modal"
            initial={{ opacity: 0, y: 20, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 12, scale: 0.97 }}
            transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
            onClick={e => e.stopPropagation()}
          >
            <header className="sm-header">
              <div>
                <div className="sm-title">AI 配置</div>
                <div className="sm-subtitle">填写任意兼容 OpenAI 接口的服务地址、API Key 和模型名称即可使用</div>
              </div>
              <button className="sm-close" onClick={onClose} aria-label="关闭"><IconClose /></button>
            </header>

            <div className="sm-banner">
              <IconInfo />
              <span>
                开源版不内置任何 API Key，所有凭据由你自行提供。支持任何兼容 OpenAI 格式的服务商：
                OpenAI、DeepSeek、阿里百炼、硅基流动、Kimi、智谱、本地 Ollama 等。
              </span>
            </div>

            <form className="sm-body" onSubmit={handleSave}>
              <ModelSection
                icon={<IconText />}
                title="文本模型（剧本生成）"
                desc="用于 AI 编写故事大纲、对话脚本和生成 prompt — 必须配置"
                required
                modelType="text"
                value={text}
                onChange={setText}
              />

              <section className="sm-collapse">
                <button type="button" className="sm-collapse-head" onClick={() => setAdvancedOpen(o => !o)}>
                  <span className="sm-section-icon"><IconLayers /></span>
                  <div className="sm-section-titles" style={{ flex: 1 }}>
                    <div className="sm-section-title">高级：为每个智能体单独配置模型</div>
                    <div className="sm-section-desc">可为剧本流水线的 6 个步骤分别指定不同模型（可选）</div>
                  </div>
                  {enabledAgentCount > 0 && <span className="sm-counter">{enabledAgentCount}/6 启用</span>}
                  <IconChevron open={advancedOpen} />
                </button>
                {advancedOpen && (
                  <div className="sm-collapse-body">
                    <div className="sm-agents">
                      {TEXT_AGENTS.map(a => {
                        const enabled = !!agentEnabled[a.key]
                        const val = agentOverrides[a.key] ?? emptyModel()
                        return (
                          <div key={a.key} className={`sm-agent ${enabled ? 'sm-agent--on' : ''}`}>
                            <label className="sm-agent-head">
                              <input
                                type="checkbox"
                                checked={enabled}
                                onChange={ev => {
                                  setAgentEnabled(prev => ({ ...prev, [a.key]: ev.target.checked }))
                                  if (ev.target.checked && !agentOverrides[a.key]) {
                                    setAgentOverrides(prev => ({ ...prev, [a.key]: { ...text } }))
                                  }
                                }}
                              />
                              <span className="sm-check-box" aria-hidden><IconCheck /></span>
                              <div className="sm-agent-titles">
                                <div className="sm-agent-name">{a.name}</div>
                                <div className="sm-agent-desc">{a.desc}</div>
                              </div>
                            </label>
                            {enabled && (
                              <div className="sm-agent-body">
                                <ModelSection
                                  icon={null}
                                  title=""
                                  compact
                                  value={val}
                                  onChange={v => setAgentOverrides(prev => ({ ...prev, [a.key]: v }))}
                                />
                              </div>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )}
              </section>

              <ModelSection
                icon={<IconImage />}
                title="图像模型（场景 / 立绘）"
                desc="生成游戏中的背景图和角色立绘，需要支持图像生成的模型（如 DALL-E 3 或兼容接口）"
                skippable
                skipped={imageSkipped}
                onSkipToggle={() => setImageSkipped(s => !s)}
                modelType="image"
                value={image}
                onChange={setImage}
              />
              {!imageSkipped && (
                <section className="sm-section sm-section--compact" style={{ marginTop: '-8px', paddingTop: '12px', borderTop: 'none' }}>
                  <label style={{ display: 'flex', alignItems: 'flex-start', gap: '12px', cursor: 'pointer', padding: '0 2px' }}>
                    <span
                      onClick={() => setTokenSaveMode(s => !s)}
                      style={{
                        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                        width: '36px', height: '20px', borderRadius: '10px', flexShrink: 0, marginTop: '2px',
                        background: tokenSaveMode ? 'var(--accent, #7c6af7)' : 'var(--border, rgba(255,255,255,0.12))',
                        transition: 'background 0.18s', cursor: 'pointer',
                        position: 'relative',
                      }}
                      role="switch" aria-checked={tokenSaveMode}
                    >
                      <span style={{
                        position: 'absolute',
                        left: tokenSaveMode ? '18px' : '3px',
                        width: '14px', height: '14px', borderRadius: '50%',
                        background: '#fff', transition: 'left 0.18s',
                        boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
                      }} />
                    </span>
                    <div>
                      <div style={{ fontSize: '13px', fontWeight: 500, color: 'var(--text-primary, #fff)', lineHeight: 1.3 }}>Token 节省模式</div>
                      <div style={{ fontSize: '11.5px', color: 'var(--text-secondary, rgba(255,255,255,0.5))', marginTop: '3px', lineHeight: 1.5 }}>
                        开启后，视觉效果相同的场景将共用同一张背景图，减少约 40% 的图片 API 调用，适合 Token 较紧张时使用
                      </div>
                    </div>
                  </label>
                </section>
              )}

              <ModelSection
                icon={<IconVoice />}
                title="语音模型（角色配音）"
                desc="将对话文本合成为角色配音，需要兼容 OpenAI TTS 接口的服务"
                skippable
                skipped={voiceSkipped}
                onSkipToggle={() => setVoiceSkipped(s => !s)}
                modelType="voice"
                value={voice}
                onChange={setVoice}
              />
            </form>

            <footer className="sm-footer">
              {msg && (
                <div className={`sm-alert sm-alert--${msg.type}`} style={{ marginRight: 'auto' }}>
                  {msg.type === 'success' ? <IconCheck /> : <IconInfo />}
                  <span>{msg.text}</span>
                </div>
              )}
              <button type="button" className="btn btn-ghost" onClick={onClose}>取消</button>
              <button
                type="button"
                className="btn btn-primary sm-submit"
                disabled={loading}
                onClick={ev => handleSave(ev as unknown as React.FormEvent)}
              >
                {loading
                  ? <span className="spinner" />
                  : msg?.type === 'success'
                    ? <><IconCheck /><span>已保存</span></>
                    : <><IconSave /><span>保存配置</span></>
                }
              </button>
            </footer>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
