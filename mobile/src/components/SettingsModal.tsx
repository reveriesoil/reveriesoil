/**
 * SettingsModal (mobile) — 保存到 IndexedDB，替代 HTTP API 调用
 * 样式复用 web 版，逻辑改为读写本地 DB
 */
import React, { useEffect, useState, useCallback } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { nanoid } from 'nanoid'
import {
  getDefaultAIConfig,
  saveAIConfig,
  type AIConfigRecord,
  type ModelCfg,
} from '../services/db'

// ── Icons ─────────────────────────────────────────────────────────────────────
const IconText = () => (
  <svg viewBox="0 0 18 18" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M3 3h12M5 3v12M11 3v12M3 15h6" /></svg>
)
const IconImage = () => (
  <svg viewBox="0 0 18 18" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="3" width="14" height="12" rx="1.5" /><circle cx="6" cy="7" r="1.2" /><path d="M2 12 L6 9 L10 12 L13 10 L16 13" /></svg>
)
const IconInfo = () => (
  <svg viewBox="0 0 18 18" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><circle cx="9" cy="9" r="7" /><path d="M9 8v5M9 5.5v0.01" /></svg>
)
const IconKey = () => (
  <svg viewBox="0 0 18 18" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><circle cx="6" cy="9" r="3" /><path d="M9 9h7M14 9v3M16 9v2" /></svg>
)
const IconLink = () => (
  <svg viewBox="0 0 18 18" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M7 11a3 3 0 0 0 4 0l3-3a3 3 0 0 0-4-4l-1 1" /><path d="M11 7a3 3 0 0 0-4 0l-3 3a3 3 0 0 0 4 4l1-1" /></svg>
)
const IconModelBox = () => (
  <svg viewBox="0 0 18 18" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="3" width="14" height="12" rx="1.5" /><path d="M5 8h8M5 11h5" /></svg>
)
const IconClose = () => (
  <svg viewBox="0 0 14 14" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M2 2 L12 12 M12 2 L2 12" /></svg>
)
const IconFlash = () => (
  <svg viewBox="0 0 18 18" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M10 2 L5 10 h4 L8 16 L14 8 h-4 Z" /></svg>
)
const IconCheck = () => (
  <svg viewBox="0 0 14 14" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M2 7 L6 11 L12 3" /></svg>
)

// ── Types ──────────────────────────────────────────────────────────────────────
interface ModelValue { model: string; api_key: string; endpoint: string }
function emptyModel(): ModelValue { return { model: '', api_key: '', endpoint: '' } }

// ── Test connection ───────────────────────────────────────────────────────────
type TestState = { status: 'idle' } | { status: 'testing' } | { status: 'ok'; msg: string } | { status: 'fail'; msg: string }

async function testTextModel(v: ModelValue): Promise<{ success: boolean; message: string }> {
  const base = (v.endpoint || 'https://api.openai.com/v1').replace(/\/$/, '')
  const t0 = Date.now()
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${v.api_key}` },
      body: JSON.stringify({ model: v.model, messages: [{ role: 'user', content: 'Hi' }], max_tokens: 5 }),
    })
    const ms = Date.now() - t0
    if (res.ok) return { success: true, message: `连接成功 · ${ms}ms` }
    const body = await res.text()
    return { success: false, message: `${res.status}: ${body.slice(0, 80)}` }
  } catch (e) {
    return { success: false, message: String(e) }
  }
}

// ── ModelSection ──────────────────────────────────────────────────────────────
function ModelSection({
  icon, title, desc, value, onChange, required, compact, testable,
}: {
  icon: React.ReactNode; title: string; desc?: string; value: ModelValue
  onChange: (v: ModelValue) => void; required?: boolean; compact?: boolean; testable?: boolean
}) {
  const [showKey, setShowKey] = useState(false)
  const [testState, setTestState] = useState<TestState>({ status: 'idle' })

  const handleTest = useCallback(async () => {
    setTestState({ status: 'testing' })
    const result = await testTextModel(value)
    setTestState(result.success ? { status: 'ok', msg: result.message } : { status: 'fail', msg: result.message })
  }, [value])

  return (
    <section className={`sm-section${compact ? ' sm-section--compact' : ''}`}>
      {!compact && (
        <header className="sm-section-head">
          <span className="sm-section-icon">{icon}</span>
          <div className="sm-section-titles">
            <div className="sm-section-title">
              {title}
              {required && <span className="sm-required">必填</span>}
            </div>
            {desc && <div className="sm-section-desc">{desc}</div>}
          </div>
        </header>
      )}
      <div className="sm-field-grid">
        <div className="sm-field">
          <label className="sm-label"><IconLink /><span>API Base URL</span></label>
          <input className="sm-input" value={value.endpoint} onChange={e => onChange({ ...value, endpoint: e.target.value })}
            placeholder="https://api.openai.com/v1" autoComplete="off" spellCheck={false} />
          <div className="sm-hint">兼容 OpenAI 接口协议的服务地址（含 /v1）</div>
        </div>
        <div className="sm-field">
          <label className="sm-label"><IconKey /><span>API Key</span></label>
          <div className="sm-input-wrap">
            {/* 用条件渲染两个独立 input 代替切换 type，避免 Android WebView
                在 type 从 password→text 变化时触发空值 onChange 清空数据 */}
            {showKey ? (
              <input
                key="apikey-text"
                className="sm-input sm-input--key"
                type="text"
                value={value.api_key}
                onChange={e => onChange({ ...value, api_key: e.target.value })}
                placeholder="sk-..."
                autoComplete="off"
                spellCheck={false}
              />
            ) : (
              <input
                key="apikey-pass"
                className="sm-input sm-input--key"
                type="password"
                value={value.api_key}
                onChange={e => onChange({ ...value, api_key: e.target.value })}
                placeholder="sk-..."
                autoComplete="new-password"
                spellCheck={false}
              />
            )}
            <button type="button" className="sm-eye-btn" onClick={e => { e.preventDefault(); e.stopPropagation(); setShowKey(s => !s) }} tabIndex={-1} aria-label={showKey ? '隐藏' : '显示'}>
              {showKey
                ? <svg viewBox="0 0 18 14" width="16" height="12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M1 7C3 3 6 1 9 1s6 2 8 6c-2 4-5 6-8 6s-6-2-8-6z" /><circle cx="9" cy="7" r="2.5" /><line x1="2" y1="2" x2="16" y2="12" /></svg>
                : <svg viewBox="0 0 18 14" width="16" height="12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M1 7C3 3 6 1 9 1s6 2 8 6c-2 4-5 6-8 6s-6-2-8-6z" /><circle cx="9" cy="7" r="2.5" /></svg>
              }
            </button>
          </div>
        </div>
        <div className="sm-field">
          <label className="sm-label"><IconModelBox /><span>模型名称</span></label>
          <input className="sm-input" value={value.model} onChange={e => onChange({ ...value, model: e.target.value })}
            placeholder="如 gpt-4o / deepseek-v3 / qwen-plus" autoComplete="off" spellCheck={false} />
          <div className="sm-hint">填写服务商文档中的模型 ID，区分大小写</div>
        </div>
      </div>
      {testable && (
        <div className="sm-test-row">
          <button type="button" className={`sm-test-btn${testState.status === 'testing' ? ' sm-test-btn--testing' : ''}`}
            disabled={testState.status === 'testing' || !value.api_key.trim() || !value.model.trim()} onClick={handleTest}>
            {testState.status === 'testing' ? <><span className="sm-test-spinner" />测试中…</> : <><IconFlash />测试连接</>}
          </button>
          {testState.status === 'ok' && <span className="sm-test-result sm-test-result--ok"><IconCheck /> {testState.msg}</span>}
          {testState.status === 'fail' && <span className="sm-test-result sm-test-result--fail"><IconInfo /> {testState.msg}</span>}
        </div>
      )}
    </section>
  )
}

// ── Main Modal ────────────────────────────────────────────────────────────────
export default function SettingsModal({ open, onClose, onSaved }: {
  open: boolean; onClose: () => void; onSaved?: (cfg: AIConfigRecord) => void
}) {
  const [text,  setText]  = useState<ModelValue>(emptyModel())
  const [image, setImage] = useState<ModelValue>(emptyModel())
  const [imageSkipped, setImageSkipped] = useState(false)
  const [msg, setMsg] = useState<{ type: 'error' | 'success'; text: string } | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!open) return
    setMsg(null)
    getDefaultAIConfig().then(def => {
      if (!def) return
      const tm = def.text_model
      const im = def.image_model
      setText({ model: tm.model ?? '', api_key: tm.api_key ?? '', endpoint: tm.endpoint ?? '' })
      if (im?.model || im?.endpoint || im?.api_key) {
        setImage({ model: im.model ?? '', api_key: im.api_key ?? '', endpoint: im.endpoint ?? '' })
        setImageSkipped(false)
      } else {
        setImage(emptyModel()); setImageSkipped(true)
      }
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
    if (!text.api_key.trim())  { setMsg({ type: 'error', text: '请填写文本模型的 API Key' }); return }
    if (!text.model.trim())    { setMsg({ type: 'error', text: '请填写文本模型的模型名称' }); return }
    setLoading(true)
    try {
      const toModelCfg = (v: ModelValue): ModelCfg => ({
        provider: 'custom', model: v.model, api_key: v.api_key, endpoint: v.endpoint,
      })
      const cfg: AIConfigRecord = {
        id: nanoid(),
        config_name: '默认配置',
        text_model: toModelCfg(text),
        image_model: imageSkipped ? { provider: 'custom', model: '', api_key: '', endpoint: '' } : toModelCfg(image),
        is_default: true,
        created_at: new Date().toISOString(),
      }
      await saveAIConfig(cfg)
      setMsg({ type: 'success', text: '配置已保存' })
      onSaved?.(cfg)
      setTimeout(onClose, 600)
    } catch {
      setMsg({ type: 'error', text: '保存失败，请重试' })
    } finally {
      setLoading(false)
    }
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div className="sm-backdrop"
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }} onClick={onClose}
        >
          <motion.div className="sm-modal"
            initial={{ opacity: 0, y: 20, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 12, scale: 0.97 }}
            transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] as [number, number, number, number] }}
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
              <span>支持 OpenAI、DeepSeek、硅基流动、Kimi 等任何兼容 OpenAI 格式的服务商。</span>
            </div>

            <form className="sm-body" onSubmit={handleSave}>
              <ModelSection icon={<IconText />} title="文本模型（剧本生成）"
                desc="用于 AI 编写故事大纲、对话脚本和生成 prompt — 必须配置" required testable
                value={text} onChange={setText} />

              <section className="sm-section">
                <header className="sm-section-head">
                  <span className="sm-section-icon"><IconImage /></span>
                  <div className="sm-section-titles">
                    <div className="sm-section-title">图像模型（立绘/背景/CG）</div>
                    <div className="sm-section-desc">用于 AI 绘制角色立绘和场景背景 — 不填则仅生成剧本</div>
                  </div>
                  <label className="sm-skip-toggle">
                    <input type="checkbox" checked={!imageSkipped} onChange={() => setImageSkipped(s => !s)} style={{ display: 'none' }} />
                    <span className={`sm-skip-track${!imageSkipped ? ' sm-skip-track--on' : ''}`}><span className="sm-skip-thumb" /></span>
                    <span className="sm-skip-label">{imageSkipped ? '已跳过' : '已启用'}</span>
                  </label>
                </header>
                {!imageSkipped && (
                  <ModelSection icon={null} title="" compact value={image} onChange={setImage} />
                )}
                {imageSkipped && (
                  <div className="sm-skipped-tip"><IconInfo /> <span>已跳过，仅生成纯文字剧本。</span></div>
                )}
              </section>

              {/* 语音模型占位 — v0.7.x 后续版本支持 */}
              <section
                className="sm-section"
                style={{ opacity: 0.62, position: 'relative' }}
                aria-disabled
              >
                <header className="sm-section-head">
                  <span className="sm-section-icon">
                    <svg viewBox="0 0 18 18" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M9 2v14M5 6v6M13 6v6M2 8v2M16 8v2" />
                    </svg>
                  </span>
                  <div className="sm-section-titles">
                    <div className="sm-section-title">
                      语音模型（角色配音）
                      <span
                        style={{
                          marginLeft: 8,
                          fontSize: 10.5,
                          padding: '1px 7px',
                          borderRadius: 8,
                          background: 'rgba(255, 200, 80, 0.18)',
                          color: '#ffcc66',
                          border: '1px solid rgba(255, 200, 80, 0.35)',
                          fontWeight: 500,
                          letterSpacing: 0.2,
                        }}
                      >
                        即将支持
                      </span>
                    </div>
                    <div className="sm-section-desc">
                      将对话文本合成为角色配音 — 移动端 TTS 适配将在后续版本（v0.7.3+）开放。当前可在 Web/桌面端正常使用。
                    </div>
                  </div>
                </header>
                <div className="sm-skipped-tip"><IconInfo /> <span>本端暂未集成端侧/云端 TTS 通路；剧本仍可正常生成与游玩，仅无 AI 配音。</span></div>
              </section>

              {msg && (
                <div className={`sm-msg ${msg.type === 'error' ? 'sm-msg--error' : 'sm-msg--success'}`}>
                  {msg.type === 'error' ? <IconInfo /> : <IconCheck />}
                  <span>{msg.text}</span>
                </div>
              )}

              <div className="sm-footer">
                <button type="button" className="sm-btn sm-btn--ghost" onClick={onClose} disabled={loading}>取消</button>
                <button type="submit" className="sm-btn sm-btn--primary" disabled={loading}>
                  {loading ? '保存中…' : '保存配置'}
                </button>
              </div>
            </form>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
