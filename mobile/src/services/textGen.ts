/**
 * textGen.ts — TypeScript 版文本生成服务
 * 移植自 opensource/backend/app/services/ai/text_gen.py
 * 直接通过 fetch 调用兼容 OpenAI 格式的 LLM API（无需后端服务器）
 */

// ── Tool Schemas (与 Python 版对齐) ──────────────────────────────────────────

const OUTLINE_SCHEMA = {
  name: 'generate_story_outline',
  description: '生成视觉小说故事大纲及人物档案',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      genre: { type: 'string' },
      theme: { type: 'string' },
      synopsis: { type: 'string' },
      characters: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            age: { type: 'integer' },
            gender: { type: 'string', enum: ['male', 'female', 'neutral'] },
            role: { type: 'string' },
            personality: { type: 'string' },
            background: { type: 'string' },
            speech_style: { type: 'string' },
            arc: { type: 'string' },
            relationships: { type: 'string' },
          },
          required: ['id', 'name', 'age', 'gender', 'role', 'personality',
            'background', 'speech_style', 'arc', 'relationships'],
        },
      },
      scene_outlines: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            title: { type: 'string' },
            summary: { type: 'string' },
            location: { type: 'string' },
            time: { type: 'string' },
            mood: { type: 'string', enum: ['peaceful', 'tense', 'romantic', 'mysterious', 'battle', 'sad', 'triumphant'] },
            characters_present: { type: 'array', items: { type: 'string' } },
            key_event: { type: 'string' },
            has_cg: { type: 'boolean' },
            cg_description: { type: 'string' },
            has_branch: { type: 'boolean' },
            branch_summary: { type: 'string' },
            next_scene_id: { type: 'string' },
          },
          required: ['id', 'title', 'summary', 'location', 'time', 'mood',
            'characters_present', 'key_event', 'has_cg', 'cg_description',
            'has_branch', 'branch_summary', 'next_scene_id'],
        },
      },
      ending: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['good', 'bad', 'neutral', 'multiple'] },
          title: { type: 'string' },
          summary: { type: 'string' },
        },
        required: ['type', 'title', 'summary'],
      },
    },
    required: ['title', 'genre', 'theme', 'synopsis', 'characters', 'scene_outlines', 'ending'],
  },
}

const DIRECTOR_VISION_SCHEMA = {
  name: 'generate_director_vision',
  description: '导演：输出全局艺术风格指导、人物视觉设计和声音设计',
  parameters: {
    type: 'object',
    properties: {
      global_art_style: { type: 'string' },
      color_palette: { type: 'string' },
      lighting_style: { type: 'string' },
      art_direction_notes: { type: 'string' },
      character_designs: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            character_id: { type: 'string' },
            appearance_en: { type: 'string' },
            outfit_en: { type: 'string' },
            makeup_en: { type: 'string' },
            expressions: { type: 'array', items: { type: 'string' } },
            voice_character: { type: 'string' },
            voice_age: { type: 'string', enum: ['child', 'youth', 'adult', 'elder'] },
            speaking_pace: { type: 'string', enum: ['slow', 'moderate', 'fast'] },
          },
          required: ['character_id', 'appearance_en', 'outfit_en', 'makeup_en',
            'expressions', 'voice_character', 'voice_age', 'speaking_pace'],
        },
      },
      scene_styles: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            scene_id: { type: 'string' },
            atmosphere_en: { type: 'string' },
            style_modifier_en: { type: 'string' },
            time_of_day: { type: 'string' },
            special_elements: { type: 'string' },
          },
          required: ['scene_id', 'atmosphere_en', 'style_modifier_en', 'time_of_day', 'special_elements'],
        },
      },
    },
    required: ['global_art_style', 'color_palette', 'lighting_style',
      'art_direction_notes', 'character_designs', 'scene_styles'],
  },
}

const CHARACTER_PROMPTS_SCHEMA = {
  name: 'generate_character_prompts',
  description: '执行导演：输出人物绘图提示词',
  parameters: {
    type: 'object',
    properties: {
      character_prompts: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            character_id: { type: 'string' },
            base_prompt: { type: 'string' },
            negative_prompt: { type: 'string' },
            expression_prompts: { type: 'object', additionalProperties: { type: 'string' } },
          },
          required: ['character_id', 'base_prompt', 'negative_prompt', 'expression_prompts'],
        },
      },
    },
    required: ['character_prompts'],
  },
}

const SCENE_PROMPTS_SCHEMA = {
  name: 'generate_scene_prompts',
  description: '执行导演：输出背景/CG 绘图提示词',
  parameters: {
    type: 'object',
    properties: {
      background_prompts: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            scene_id: { type: 'string' },
            prompt: { type: 'string' },
            negative_prompt: { type: 'string' },
          },
          required: ['scene_id', 'prompt', 'negative_prompt'],
        },
      },
      cg_prompts: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            scene_id: { type: 'string' },
            cg_id: { type: 'string' },
            prompt: { type: 'string' },
            negative_prompt: { type: 'string' },
            is_animatable: { type: 'boolean' },
          },
          required: ['scene_id', 'cg_id', 'prompt', 'negative_prompt', 'is_animatable'],
        },
      },
    },
    required: ['background_prompts', 'cg_prompts'],
  },
}

// ── 类型 ─────────────────────────────────────────────────────────────────────

export interface TextModelCfg {
  model: string
  api_key: string
  endpoint?: string
}

// ── 辅助函数 ─────────────────────────────────────────────────────────────────

const KIMI_K2_HINTS = ['kimi-k2', 'kimi-thinking', 'moonshot-thinking']

function isKimiK2(model: string): boolean {
  return KIMI_K2_HINTS.some(h => model.toLowerCase().includes(h))
}

function normalizeTemperature(model: string, t: number): number {
  if (isKimiK2(model)) return 0.6
  return t
}

function modelExtraBody(_model: string): Record<string, unknown> {
  // 全局禁用 thinking 模式，避免 tool_call 在思考模型上失败
  return { thinking: { type: 'disabled' } }
}

/** 根据模型特性返回合适的 AbortSignal（Kimi K2 MoE 推理最长 6 分钟） */
function timeoutSignal(model: string): AbortSignal {
  const ms = isKimiK2(model) ? 360_000 : 180_000
  return AbortSignal.timeout(ms)
}

function targetSceneCount(storySpec: Record<string, unknown>): number {
  const manual = storySpec['scene_count']
  if (manual) {
    const n = parseInt(String(manual), 10)
    if (!isNaN(n)) return Math.max(1, n)
  }
  const duration = parseInt(String(storySpec['duration_minutes'] ?? 30), 10) || 30
  return Math.min(40, Math.max(20, Math.floor(duration / 2)))
}

function tryRepairJson(raw: string): Record<string, unknown> {
  try { return JSON.parse(raw) } catch { /* fall through */ }
  // 截断修复：找最后一个完整的顶层值
  const trimmed = raw.trim()
  let depth = 0, inStr = false, escNext = false, lastEnd = -1
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i]
    if (escNext) { escNext = false; continue }
    if (ch === '\\' && inStr) { escNext = true; continue }
    if (ch === '"') { inStr = !inStr; continue }
    if (inStr) continue
    const prev = depth
    if (ch === '{' || ch === '[') depth++
    else if (ch === '}' || ch === ']') depth--
    if (prev >= 2 && depth === 1) lastEnd = i + 1
  }
  if (lastEnd > 0) {
    const candidate = trimmed.slice(0, lastEnd).trimEnd().replace(/,$/, '') + '\n}'
    try { return JSON.parse(candidate) } catch { /* fall through */ }
  }
  throw new SyntaxError('JSON repair failed')
}

// ── 核心 API 调用 ─────────────────────────────────────────────────────────────

async function callTool(
  cfg: TextModelCfg,
  system: string,
  user: string,
  toolSchema: Record<string, unknown>,
  temperature = 0.8,
  maxTokens = 8192,
): Promise<Record<string, unknown>> {
  const base = (cfg.endpoint ?? 'https://api.deepseek.com/v1').replace(/\/$/, '')
  const body: Record<string, unknown> = {
    model: cfg.model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    tools: [{ type: 'function', function: toolSchema }],
    tool_choice: { type: 'function', function: { name: (toolSchema as { name: string }).name } },
    temperature: normalizeTemperature(cfg.model, temperature),
    max_tokens: maxTokens,
    ...modelExtraBody(cfg.model),
  }

  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.api_key}`,
    },
    body: JSON.stringify(body),
    signal: timeoutSignal(cfg.model),
  })
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`LLM API error ${res.status}: ${err}`)
  }
  const data = await res.json() as {
    choices: Array<{ message: { tool_calls?: Array<{ function: { arguments: string } }> } }>
  }
  const toolCall = data.choices[0]?.message?.tool_calls?.[0]
  if (!toolCall) throw new Error('Model did not return a tool call')
  try {
    return JSON.parse(toolCall.function.arguments) as Record<string, unknown>
  } catch {
    return tryRepairJson(toolCall.function.arguments)
  }
}

async function callJson(
  cfg: TextModelCfg,
  system: string,
  user: string,
  temperature = 0.7,
  maxTokens = 4000,
): Promise<Record<string, unknown>> {
  const base = (cfg.endpoint ?? 'https://api.deepseek.com/v1').replace(/\/$/, '')
  const body: Record<string, unknown> = {
    model: cfg.model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    response_format: { type: 'json_object' },
    temperature: normalizeTemperature(cfg.model, temperature),
    max_tokens: maxTokens,
    ...modelExtraBody(cfg.model),
  }

  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.api_key}`,
    },
    body: JSON.stringify(body),
    signal: timeoutSignal(cfg.model),
  })
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`LLM API error ${res.status}: ${err}`)
  }
  const data = await res.json() as {
    choices: Array<{ message: { content: string | null } }>
  }
  const raw = data.choices[0]?.message?.content
  if (!raw) throw new Error('Empty response from LLM')
  try {
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    return tryRepairJson(raw)
  }
}

// ── Step 1 — 生成大纲 ─────────────────────────────────────────────────────────

export async function generateOutline(
  prompt: string,
  storySpec: Record<string, unknown>,
  cfg: TextModelCfg,
  characterPrompt = '',
): Promise<Record<string, unknown>> {
  const duration = parseInt(String(storySpec['duration_minutes'] ?? 30), 10) || 30
  const depth = parseInt(String(storySpec['depth'] ?? 2), 10) || 2
  const sceneCount = targetSceneCount(storySpec)

  const depthStyles: Record<number, string> = {
    1: '【叙事风格：轻盈】故事节奏明快，情感直白温暖，对白幽默生动，适合轻松愉快的阅读体验。',
    2: '【叙事风格：标准】故事有完整起伏，角色情感层次清晰，对白自然流畅，整体易读易懂。',
    3: '【叙事风格：深沉】注重人物内心刻画，对白含蓄有潜台词，埋设伏笔与隐喻，角色动机复杂。',
    4: '【叙事风格：厚重】叙事多线交织，对话字面义与深层义并存，主题通过细节和象征缓慢渗透。',
    5: '【叙事风格：极致深邃】叙事如精密钟表，哲学命题融入日常对话，结局余韵无穷。',
  }
  const depthHint = depthStyles[depth] ?? depthStyles[2]

  const interactionLevel = Math.max(1, Math.min(5, parseInt(String(storySpec['interaction_level'] ?? 3), 10) || 3))
  const interactionHints: Record<number, string> = {
    1: '本作为【沉浸观影模式】：完全线性叙事，全程无任何分支选择；不要安排任何 has_branch 节点。',
    2: '本作为【轻度互动】：仅在 1 个关键转折点安排分支选择。',
    3: '本作为【标准互动】：在 2-3 个关键节点安排分支选择，使故事有至少 2 条不同走向。',
    4: '本作为【高互动】：在 4-5 个节点安排分支选择，故事走向多样，结局至少 3 个分支变体。',
    5: '本作为【极致互动/角色扮演】：每 2-3 个场景就出现一次玩家选择，构造多结局网状叙事。',
  }
  const branchHint = interactionHints[interactionLevel] ?? interactionHints[3]

  const storyStyle = String(storySpec['story_style'] ?? '').trim()
  const artStyle = String(storySpec['art_style'] ?? '').trim()
  const titleHint = String(storySpec['title'] ?? '').trim()

  const system = `你是一位顶级视觉小说总编剧，负责创作故事大纲和人物档案。

${depthHint}

任务：
- 创作 3-5 名人物，每人有鲜明性格、背景故事、成长弧线、独特说话方式和口头禅
- 规划恰好 ${sceneCount} 个场景，按照"引入→建立关系→冲突积累→情感爆发→高潮→余波→结局"结构编排
- 每个场景只需写情节摘要，不需要写对话
- 每个场景的 characters_present 必填，列出该场景出场的所有角色 ID，最多 2-3 人
- ${branchHint}
- 在高潮或重要情感时刻安排 CG（has_cg=true），整个故事 2-4 个 CG 为宜
- 所有 ID 用英文下划线格式（如 scene_001, char_alice）
- 故事时长约 ${duration} 分钟`

  const userParts = [`请根据以下提示词创作故事大纲：\n${prompt}`]
  if (titleHint) userParts.push(`\n\n【用户指定的故事标题】：${titleHint}（请使用此标题）`)
  if (storyStyle) userParts.push(`\n\n【故事风格类型】：${storyStyle}`)
  if (artStyle) userParts.push(`\n\n【未来绘画风格】：${artStyle}`)
  if (characterPrompt?.trim()) userParts.push(`\n\n【用户指定的人物设定】：\n${characterPrompt}\n请严格按照以上角色创作人物档案。`)

  let result = await callTool(cfg, system, userParts.join(''), OUTLINE_SCHEMA, 0.9, 8192)

  // 验校场景数量
  const scenes = (result['scene_outlines'] as unknown[] | undefined) ?? []
  if (scenes.length < sceneCount) {
    const retrySystem = system + `\n\n注意：你必须完整输出 scene_outlines 数组，数量必须恰好为 ${sceneCount} 个场景。上一版只输出了 ${scenes.length} 个，这是不合格输出。`
    result = await callJson(cfg, retrySystem, `请根据以下提示词创作故事大纲，务必输出完整的 scene_outlines 数组，共 ${sceneCount} 个场景：\n${prompt}`, 0.9, 12288)
  }

  const finalScenes = (result['scene_outlines'] as unknown[] | undefined) ?? []
  if (finalScenes.length < sceneCount) {
    throw new Error(`大纲场景数不足：预期 ${sceneCount} 个，实际 ${finalScenes.length} 个。请稍后重试或降低游戏时长。`)
  }
  return result
}

// ── Step 2 — 剧本统筹师 ───────────────────────────────────────────────────────

export async function validateAndRefine(
  outline: Record<string, unknown>,
  cfg: TextModelCfg,
  targetSceneCountVal?: number,
): Promise<Record<string, unknown>> {
  const system = `你是一位资深剧本统筹师，负责审核和改进故事大纲。
检查：场景连贯性、人物一致性、人物弧线、节奏把控、CG 合理性、分支逻辑。
直接修正输出改进后的大纲（JSON 格式与输入相同）。返回纯 JSON，不要解释文字。`

  try {
    const result = await callJson(
      cfg, system,
      `请检查并改进以下故事大纲：\n${JSON.stringify(outline)}`,
      0.3, 8192,
    )
    const candidate = (result['outline'] as Record<string, unknown> | undefined) ?? result
    const scenes = getSceneOutlines(candidate)
    if (scenes.length > 0) {
      if (targetSceneCountVal && scenes.length < targetSceneCountVal) return outline
      return candidate
    }
    return outline
  } catch {
    return outline
  }
}

function getSceneOutlines(d: Record<string, unknown>): unknown[] {
  for (const key of ['scene_outlines', 'scenes', 'chapters', 'scene_list']) {
    const v = d[key]
    if (Array.isArray(v) && v.length > 0) return v
  }
  return []
}

// ── Step 3 — 导演视觉 ─────────────────────────────────────────────────────────

export async function generateDirectorVision(
  outline: Record<string, unknown>,
  cfg: TextModelCfg,
): Promise<Record<string, unknown>> {
  const charsList = (outline['characters'] as Array<Record<string, unknown>> | undefined ?? [])
    .map(c => `${c['id']}(${c['name']})`).join(', ')
  const scenesList = getSceneOutlines(outline)
    .map(s => (s as Record<string, unknown>)['id']).join(', ')

  const userArtStyle = String(outline['user_art_style'] ?? '').trim()
  const userStoryStyle = String(outline['user_story_style'] ?? '').trim()
  const styleLines: string[] = []
  if (userArtStyle) styleLines.push(`⚠️ 用户已指定【绘画风格】：${userArtStyle}\n  → global_art_style 必须明确反映该风格，所有视觉描述须与该风格保持一致。`)
  if (userStoryStyle) styleLines.push(`⚠️ 用户已指定【故事风格类型】：${userStoryStyle}\n  → color_palette / lighting_style / atmosphere_en 须与该题材气氛吻合。`)

  const system = `你是视觉小说的艺术总监（导演），负责整体视觉和声音风格设计。${styleLines.length ? '\n\n' + styleLines.join('\n') : ''}

严格输出要求：
- character_designs 必须是 JSON 数组，每个元素含 character_id（使用大纲中的 ID）
- 已知角色 ID：${charsList}
- scene_styles 必须是 JSON 数组，每个元素含 scene_id（使用大纲中的 ID）
- 已知场景 ID：${scenesList}
- color_palette 必须是字符串
- appearance_en / outfit_en / makeup_en / atmosphere_en 全部使用英文
- expressions 只能从以下选取：normal / happy / sad / surprised / angry / shy / serious / hurt`

  const result = await callTool(
    cfg, system,
    `请根据以下剧本大纲进行艺术设计：\n${JSON.stringify(outline)}`,
    DIRECTOR_VISION_SCHEMA, 0.75, 8192,
  )
  return normalizeDirectorVision(result, outline)
}

function normalizeDirectorVision(
  result: Record<string, unknown>,
  outline: Record<string, unknown>,
): Record<string, unknown> {
  // color_palette dict → string
  const cp = result['color_palette']
  if (cp && typeof cp === 'object' && !Array.isArray(cp)) {
    result['color_palette'] = Object.entries(cp as Record<string, string>).map(([k, v]) => `${k}: ${v}`).join(', ')
  }
  // character_designs dict → array
  const cd = result['character_designs']
  if (cd && !Array.isArray(cd)) {
    const outlineChars = new Map<string, string>(
      (outline['characters'] as Array<Record<string, unknown>> | undefined ?? [])
        .map(c => [String(c['name'] ?? ''), String(c['id'] ?? '')])
    )
    result['character_designs'] = Object.entries(cd as Record<string, Record<string, unknown>>).map(([key, val], i) => ({
      character_id: outlineChars.get(key) || `char_${String(i).padStart(3, '0')}`,
      appearance_en: val['appearance_en'] || val['外貌'] || '',
      outfit_en: val['outfit_en'] || val['服装'] || '',
      makeup_en: val['makeup_en'] || val['妆造'] || '',
      expressions: (Array.isArray(val['expressions']) ? val['expressions'] : ['normal', 'happy', 'sad'])
        .filter((e: unknown) => ['normal', 'happy', 'sad', 'surprised', 'angry', 'shy', 'serious', 'hurt'].includes(String(e))),
      voice_character: val['voice_character'] || val['声音气质'] || '',
      voice_age: val['voice_age'] || 'youth',
      speaking_pace: val['speaking_pace'] || 'moderate',
    }))
  }
  return result
}

// ── Step 4 — 执行导演：绘图 Prompt ───────────────────────────────────────────

export async function generateImagePrompts(
  outline: Record<string, unknown>,
  directorVision: Record<string, unknown>,
  cfg: TextModelCfg,
): Promise<Record<string, unknown>> {
  const system = `你是执行导演，负责将艺术总监的风格指导转化为具体的 AI 绘图提示词。

要求：
- 人物 base_prompt（英文，Stable Diffusion 关键词格式）：外貌+服装+妆容+构图关键词（full body shot, standing pose, centered in frame, looking at viewer, facing camera, complete figure with feet visible）+质量关键词（masterpiece, best quality, highres, ultra detailed, sharp focus）+背景关键词（pure solid green background, chroma key green #00FF00, no background details, no shadows）+风格关键词；base_prompt 字数不低于 60 个英文单词
- expression_prompts：为 normal/happy/sad/surprised/angry/shy/serious/hurt 每种表情输出完整 prompt（= base_prompt 全文 + 该表情细节）
- 人物 negative_prompt：bad anatomy, extra fingers, missing limbs, deformed body, multiple characters, duplicate, text, watermark, lowres, blurry
- 背景 prompt：必须 16:9 widescreen cinematic landscape composition，不能出现任何人物（追加 no people, no humans, no figures, no silhouettes）
- CG prompt：vertical 9:16 portrait，包含所有相关人物、互动动作、情绪、场景
- 所有 prompt 使用英文`

  const baseCtx = `故事大纲：\n${JSON.stringify(outline)}\n\n导演艺术指导：\n${JSON.stringify(directorVision)}`

  const [charResult, sceneResult] = await Promise.all([
    callTool(cfg, system, `${baseCtx}\n\n请生成所有人物（character_prompts）的详细绘图提示词，包含 base_prompt、negative_prompt 和 8 种表情的 expression_prompts。`, CHARACTER_PROMPTS_SCHEMA, 0.5, 8192),
    callTool(cfg, system, `${baseCtx}\n\n请生成所有背景（background_prompts）和 CG（cg_prompts）的详细绘图提示词。`, SCENE_PROMPTS_SCHEMA, 0.5, 8192),
  ])

  return {
    character_prompts: charResult['character_prompts'] ?? [],
    background_prompts: sceneResult['background_prompts'] ?? [],
    cg_prompts: sceneResult['cg_prompts'] ?? [],
  }
}

// ── Step 5 — 分镜师 ───────────────────────────────────────────────────────────

export async function generateStoryboard(
  outline: Record<string, unknown>,
  _directorVision: Record<string, unknown>,
  imagePrompts: Record<string, unknown>,
  cfg: TextModelCfg,
  depth = 2,
  onSceneProgress?: (done: number, total: number) => void,
): Promise<Record<string, unknown>[]> {
  const sceneOutlines = getSceneOutlines(outline)
  if (sceneOutlines.length === 0) throw new Error('大纲缺少场景数据（scene_outlines 为空）')

  const branchEnabled = sceneOutlines.some(s => (s as Record<string, unknown>)['has_branch'])

  const charRef = (outline['characters'] as Array<Record<string, unknown>> | undefined ?? [])
    .map((c, i) => ({
      id: String(c['id'] ?? `char_${i.toString().padStart(3, '0')}`),
      name: String(c['name'] ?? `角色${i + 1}`),
      personality: String(c['personality'] ?? ''),
      speech_style: String(c['speech_style'] ?? ''),
      gender: String(c['gender'] ?? 'neutral'),
    }))

  const bgPrompts = new Map<string, string>(
    (imagePrompts['background_prompts'] as Array<Record<string, unknown>> | undefined ?? [])
      .filter(bp => bp['scene_id'])
      .map(bp => [String(bp['scene_id']), String(bp['prompt'] ?? '')])
  )

  const cgByScene = new Map<string, string[]>()
  const cgPromptMap = new Map<string, string>()
  for (const cp of (imagePrompts['cg_prompts'] as Array<Record<string, unknown>> | undefined ?? [])) {
    const sid = String(cp['scene_id'] ?? '')
    const cid = String(cp['cg_id'] ?? cp['id'] ?? '')
    if (sid && cid) {
      if (!cgByScene.has(sid)) cgByScene.set(sid, [])
      cgByScene.get(sid)!.push(cid)
      cgPromptMap.set(cid, String(cp['prompt'] ?? '').slice(0, 80))
    }
  }

  const depthStyles: Record<number, string> = {
    1: '台词直白表达情感，人物说出内心想法，对话轻松自然。',
    2: '台词有基本层次感，人物情感通过言行自然流露，偶有言外之意。',
    3: '台词含蓄克制，人物常以行动或侧面描写暗示内心，留白供读者联想。',
    4: '台词多义，表面含义与潜台词并存；人物对话折射各自的价值观和创伤。',
    5: '台词极度凝练，每句话都可多层解读；旁白充满隐喻与象征。',
  }

  const dlgCountHints: Record<number, string> = {
    1: '6-10 条对话',
    2: '8-12 条对话（高潮场景可达 14 条）',
    3: '10-15 条对话（高潮场景可达 18 条）',
    4: '12-17 条对话（高潮场景可达 22 条）',
    5: '14-20 条对话（高潮场景可达 25 条）',
  }
  const dlgHint = dlgCountHints[depth] ?? dlgCountHints[2]

  const system = `你是视觉小说分镜师，将单个场景大纲展开为完整对话脚本。

【叙事深度要求（${depth}/5）】：${depthStyles[depth] ?? depthStyles[2]}

规则：
- 对话须忠实于人物性格和 speech_style，台词要有个性、情感丰富
- **语言一致性**：台词和旁白必须与故事大纲所使用的语言完全一致
- 每个场景生成 ${dlgHint}，高潮场景（has_cg=true）可酌情增加；确保剧情展开充分、情感层次丰富
- expression 枚举：normal / happy / sad / surprised / angry / shy / serious / hurt
- position 枚举：left / right / center / none（none=旁白）
- 旁白使用 character_id="narrator"，position="none"
${branchEnabled ? '- 在 has_branch=true 的场景末尾提供 2-3 个有实质差异的 choices\n' : ''}
- 只输出纯 JSON 对象，不包含 markdown 或解释
- 必须包含字段：id、title、background_description、dialogues、choices、next_scene_id、bgm_mood`

  const allSceneIds = sceneOutlines.map((s, i) => String((s as Record<string, unknown>)['id'] ?? `scene_${(i + 1).toString().padStart(3, '0')}`))
  const allScenes: Record<string, unknown>[] = []

  for (let i = 0; i < sceneOutlines.length; i++) {
    const so = sceneOutlines[i] as Record<string, unknown>
    const sceneId = allSceneIds[i]
    const charsPresent = (so['characters_present'] as string[] | undefined) ?? []
    const sceneChars = charsPresent.length > 0 ? charRef.filter(c => charsPresent.includes(c.id)) : charRef

    const posMapParts = sceneChars.map((c, pi) => {
      const pos = pi === 0 ? 'left' : pi === 1 ? 'right' : 'center'
      return `${c.id} → "${pos}"`
    })
    const posHint = posMapParts.length > 0 ? `\n【位置固定映射（全场景严格遵守）】${posMapParts.join(' | ')}` : ''

    const hasBranch = Boolean(so['has_branch'])
    const branchHint = hasBranch && i + 1 < allSceneIds.length
      ? `\n当前场景是分支节点（has_branch=true），choices 中每个选项的 next_scene_id 必须使用以下真实场景 ID 之一：${JSON.stringify(allSceneIds.slice(i + 1))}`
      : ''

    const sceneCgs = cgByScene.get(sceneId) ?? []
    const cgHint = sceneCgs.length > 0
      ? `\n【可用 CG 列表（必须从中选 1 个填入 cg_trigger）】\n${sceneCgs.map(cid => `  · ${cid}：${cgPromptMap.get(cid) ?? ''}`).join('\n')}\n请选择剧情最高潮的对话 id 填入 cg_after_dialogue 字段。`
      : ''

    const nextSceneId = i + 1 < allSceneIds.length ? allSceneIds[i + 1] : ''

    const userMsg = `角色参考：${JSON.stringify(sceneChars)}\n\n所有场景 ID（按顺序）：${JSON.stringify(allSceneIds)}\n当前场景大纲：\n${JSON.stringify(so)}\n\n注意：请生成 ${dlgHint}，确保剧情有铺垫、发展和情感高峰，台词充实生动，人物性格鲜明。${posHint}${cgHint}${branchHint}\nnext_scene_id 请使用："${nextSceneId}"（若是最后一场景则留空字符串）\n请输出单个场景 JSON（勿嵌套在列表中）`

    let scene: Record<string, unknown> | null = null
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        scene = await callJson(cfg, system, userMsg, 0.8, 8192)
        if (scene && typeof scene === 'object' && scene['dialogues']) break
      } catch (e) {
        if (attempt === 2) throw e
      }
    }
    if (scene) {
      if (!scene['background_description'] && bgPrompts.has(sceneId)) {
        scene['background_description'] = bgPrompts.get(sceneId)
      }
      allScenes.push(scene)
    }
    onSceneProgress?.(i + 1, sceneOutlines.length)
  }

  return allScenes
}

// ── Step 6 — 构建最终脚本 ─────────────────────────────────────────────────────

export function buildScript(
  outline: Record<string, unknown>,
  directorVision: Record<string, unknown>,
  imagePrompts: Record<string, unknown>,
  scenes: Record<string, unknown>[],
): Record<string, unknown> {
  const charDesigns = new Map<string, Record<string, unknown>>(
    (directorVision['character_designs'] as Array<Record<string, unknown>> | undefined ?? [])
      .map(cd => [String(cd['character_id'] ?? ''), cd])
  )
  const charPrompts = new Map<string, Record<string, unknown>>(
    (imagePrompts['character_prompts'] as Array<Record<string, unknown>> | undefined ?? [])
      .map(cp => [String(cp['character_id'] ?? ''), cp])
  )

  const characters = (outline['characters'] as Array<Record<string, unknown>> | undefined ?? [])
    .map(c => {
      const cid = String(c['id'] ?? '')
      const design = charDesigns.get(cid) ?? {}
      const prompt = charPrompts.get(cid) ?? {}
      return {
        ...c,
        expressions: design['expressions'] ?? ['normal', 'happy', 'sad'],
        portrait_urls: {} as Record<string, string>,
        image_prompt: prompt['base_prompt'] ?? '',
        expression_prompts: prompt['expression_prompts'] ?? {},
        negative_prompt: prompt['negative_prompt'] ?? '',
      }
    })

  return {
    title: outline['title'] ?? '',
    genre: outline['genre'] ?? '',
    theme: outline['theme'] ?? '',
    synopsis: outline['synopsis'] ?? '',
    ending: outline['ending'] ?? {},
    global_style: directorVision['global_art_style'] ?? 'anime style, detailed illustration',
    color_palette: directorVision['color_palette'] ?? '',
    lighting_style: directorVision['lighting_style'] ?? '',
    characters,
    scenes,
    cg_assets: (imagePrompts['cg_prompts'] as Array<Record<string, unknown>> | undefined ?? [])
      .map(cp => ({
        id: cp['cg_id'] ?? cp['id'] ?? '',
        scene_id: cp['scene_id'] ?? '',
        prompt: cp['prompt'] ?? '',
        negative_prompt: cp['negative_prompt'] ?? '',
        url: '',
      })),
  }
}

export { targetSceneCount }
