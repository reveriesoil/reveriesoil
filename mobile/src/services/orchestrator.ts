/**
 * orchestrator.ts — 移动端生成编排引擎
 * 替代 Python 版 GenerationOrchestrator，在设备上直接调用 AI API
 * 全流程：文本大纲 → 艺术设计 → 分镜 → 图片生成 → 存储
 */
import { nanoid } from 'nanoid'
import {
  createGame,
  updateGame,
  putAsset,
  type GameRecord,
  type AssetsManifest,
} from './db'
import {
  generateOutline,
  validateAndRefine,
  generateDirectorVision,
  generateImagePrompts,
  generateStoryboard,
  buildScript,
  targetSceneCount,
  type TextModelCfg,
} from './textGen'
import {
  generatePortrait,
  generateBackground,
  generateCG,
  generateCover,
  type ImageModelCfg,
} from './imageGen'

// ── 类型 ─────────────────────────────────────────────────────────────────────

export interface StorySpec {
  duration_minutes?: number
  depth?: number
  interaction_level?: number
  story_style?: string
  art_style?: string
  title?: string
  scene_count?: number
}

export interface AIConfig {
  text_model: TextModelCfg & { agent_overrides?: Record<string, Partial<TextModelCfg>> }
  image_model: ImageModelCfg
}

export interface ProgressUpdate {
  step: string
  progress: number   // 0-100
  model?: string
  error?: string
}

export type ProgressCallback = (update: ProgressUpdate) => void

// ── 编排器 ───────────────────────────────────────────────────────────────────

function resolveTextCfg(
  textModel: AIConfig['text_model'],
  agentKey: string,
): TextModelCfg {
  const overrides = textModel.agent_overrides
  const override = overrides?.[agentKey]
  if (override) {
    return {
      model:    override.model     ?? textModel.model,
      api_key:  override.api_key   ?? textModel.api_key,
      endpoint: override.endpoint  ?? textModel.endpoint,
    }
  }
  return { model: textModel.model, api_key: textModel.api_key, endpoint: textModel.endpoint }
}

export async function runGeneration(opts: {
  prompt: string
  storySpec: StorySpec
  aiConfig: AIConfig
  characterPrompt?: string
  onProgress?: ProgressCallback
}): Promise<{ gameId: string }> {
  const { prompt, storySpec, aiConfig, characterPrompt = '', onProgress } = opts
  const gameId = nanoid()
  const now = new Date().toISOString()

  const progress = (step: string, pct: number, model?: string) =>
    onProgress?.({ step, progress: pct, model })

  const textCfg  = aiConfig.text_model
  const imageCfg = aiConfig.image_model

  // 初始化游戏记录
  const record: GameRecord = {
    id: gameId,
    prompt,
    character_prompt: characterPrompt,
    title: storySpec.title ?? '',
    status: 'generating',
    created_at: now,
    updated_at: now,
  }
  await createGame(record)

  const manifest: AssetsManifest = {
    portraits: {}, backgrounds: {}, cg: {}, voices: {},
  }

  try {
    // ── 文本生成流水线 ─────────────────────────────────────────────────────
    progress('outline', 5, resolveTextCfg(textCfg, 'outline').model)
    const outline = await generateOutline(
      prompt, storySpec as unknown as Record<string, unknown>, resolveTextCfg(textCfg, 'outline'), characterPrompt,
    )
    // 注入用户风格到 outline（供后续导演阶段读取）
    if (storySpec.story_style) (outline as Record<string, unknown>)['user_story_style'] = storySpec.story_style
    if (storySpec.art_style)   (outline as Record<string, unknown>)['user_art_style']   = storySpec.art_style

    progress('reviewing', 12, resolveTextCfg(textCfg, 'refine').model)
    const refined = await validateAndRefine(
      outline, resolveTextCfg(textCfg, 'refine'), targetSceneCount(storySpec as unknown as Record<string, unknown>),
    )

    progress('directing', 18, resolveTextCfg(textCfg, 'director').model)
    const director = await generateDirectorVision(refined, resolveTextCfg(textCfg, 'director'))

    progress('exec_directing', 25, resolveTextCfg(textCfg, 'image_prompts').model)
    const imgPrompts = await generateImagePrompts(refined, director, resolveTextCfg(textCfg, 'image_prompts'))

    progress('storyboard', 30, resolveTextCfg(textCfg, 'storyboard').model)
    const scenes = await generateStoryboard(
      refined, director, imgPrompts,
      resolveTextCfg(textCfg, 'storyboard'),
      storySpec.depth ?? 2,
      (done, total) => {
        const pct = 30 + Math.round((done / total) * 10)
        progress('storyboard', pct)
      },
    )

    const script = buildScript(refined, director, imgPrompts, scenes)
    // 更新脚本（无图片）
    await updateGame(gameId, { script_json: script, title: String(script['title'] ?? ''), synopsis: String(script['synopsis'] ?? '') })

    // ── 图片生成 ──────────────────────────────────────────────────────────
    const characters = (script['characters'] as Array<Record<string, unknown>>) ?? []
    const globalStyle = String(script['global_style'] ?? 'anime style, detailed illustration')

    // 立绘
    progress('portraits', 40, imageCfg.model)
    const portraitTasks: Promise<void>[] = []
    for (const char of characters) {
      const cid = String(char['id'] ?? '')
      const appearance = String(char['image_prompt'] ?? '')
      const exprPrompts = (char['expression_prompts'] as Record<string, string> | undefined) ?? {}
      const expressions = Object.keys(exprPrompts).length > 0
        ? Object.keys(exprPrompts)
        : (char['expressions'] as string[] | undefined) ?? ['normal', 'happy', 'sad']

      if (!manifest.portraits[cid]) manifest.portraits[cid] = {}

      for (const expr of expressions) {
        const exprAppearance = exprPrompts[expr] || appearance
        portraitTasks.push(
          generatePortrait(exprAppearance, expr, globalStyle, imageCfg)
            .then(async dataUrl => {
              manifest.portraits[cid][expr] = dataUrl
              await putAsset(gameId, `portraits/${cid}_${expr}.png`, dataUrl)
            })
            .catch(e => { console.warn(`Portrait ${cid}/${expr} failed:`, e) }),
        )
      }
    }
    await Promise.all(portraitTasks)
    progress('portraits', 55, imageCfg.model)

    // 背景
    progress('backgrounds', 55, imageCfg.model)
    const bgPrompts = new Map<string, string>(
      (imgPrompts['background_prompts'] as Array<Record<string, unknown>> | undefined ?? [])
        .map(bp => [String(bp['scene_id'] ?? ''), String(bp['prompt'] ?? '')])
    )
    const bgTasks: Promise<void>[] = []
    for (const scene of scenes) {
      const sid = String(scene['id'] ?? '')
      const bgDesc = bgPrompts.get(sid) ?? String(scene['background_description'] ?? '')
      if (!bgDesc) continue
      bgTasks.push(
        generateBackground(bgDesc, globalStyle, 'landscape', imageCfg)
          .then(async dataUrl => {
            manifest.backgrounds[sid] = dataUrl
            await putAsset(gameId, `backgrounds/${sid}.png`, dataUrl)
          })
          .catch(e => { console.warn(`Background ${sid} failed:`, e) }),
      )
    }
    await Promise.all(bgTasks)

    // 校验必须资产
    const missingPortraits = characters
      .filter(c => {
        const cid = String(c['id'] ?? '')
        return !manifest.portraits[cid] || Object.keys(manifest.portraits[cid]).length === 0
      })
      .map(c => String(c['name'] ?? c['id']))
    const missingBgs = scenes
      .filter(s => !manifest.backgrounds[String(s['id'] ?? '')])
      .map(s => String(s['title'] ?? s['id']))
    if (missingPortraits.length > 0 || missingBgs.length > 0) {
      const details: string[] = []
      if (missingPortraits.length) details.push('缺少角色立绘：' + missingPortraits.slice(0, 5).join('、'))
      if (missingBgs.length) details.push('缺少场景背景：' + missingBgs.slice(0, 5).join('、'))
      throw new Error('关键图片素材生成不完整：' + details.join('；') + '。请检查图像模型配置后重试。')
    }
    progress('backgrounds', 70, imageCfg.model)

    // CG
    progress('cg_images', 70, imageCfg.model)
    const cgAssets = (script['cg_assets'] as Array<Record<string, unknown>>) ?? []
    const cgTasks: Promise<void>[] = []
    for (const cg of cgAssets) {
      const cid = String(cg['id'] ?? '')
      const cgPrompt = String(cg['prompt'] ?? '')
      if (!cgPrompt) continue
      cgTasks.push(
        generateCG(cgPrompt, imageCfg)
          .then(async dataUrl => {
            manifest.cg[cid] = dataUrl
            await putAsset(gameId, `cg/${cid}.png`, dataUrl)
          })
          .catch(e => { console.warn(`CG ${cid} failed:`, e) }),
      )
    }
    await Promise.all(cgTasks)
    progress('cg_images', 78, imageCfg.model)

    // 封面
    progress('cover', 90, imageCfg.model)
    let coverUrl = ''
    try {
      coverUrl = await generateCover(
        String(script['title'] ?? ''), String(script['synopsis'] ?? ''), globalStyle, imageCfg,
      )
      manifest.cover = coverUrl
      await putAsset(gameId, 'cover.png', coverUrl)
    } catch (e) {
      console.warn('Cover generation failed:', e)
    }

    // 注入资产 URL 到 script
    const finalScript = injectAssetUrls(script, manifest)

    await updateGame(gameId, {
      status: 'done',
      script_json: finalScript,
      assets_manifest: manifest,
      cover_url: coverUrl,
      cover_image_url: coverUrl,
    })

    progress('done', 100)
    return { gameId }
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e)
    await updateGame(gameId, { status: 'error', error_msg: errMsg })
    onProgress?.({ step: 'error', progress: 0, error: errMsg })
    throw e
  }
}

function injectAssetUrls(
  script: Record<string, unknown>,
  manifest: AssetsManifest,
): Record<string, unknown> {
  const characters = (script['characters'] as Array<Record<string, unknown>>) ?? []
  const injectedChars = characters.map(c => {
    const cid = String(c['id'] ?? '')
    return { ...c, portrait_urls: manifest.portraits[cid] ?? {} }
  })

  const scenes = (script['scenes'] as Array<Record<string, unknown>>) ?? []
  const injectedScenes = scenes.map(s => {
    const sid = String(s['id'] ?? '')
    return { ...s, background_url: manifest.backgrounds[sid] ?? '' }
  })

  const cgAssets = (script['cg_assets'] as Array<Record<string, unknown>>) ?? []
  const injectedCg = cgAssets.map(cg => {
    const cid = String(cg['id'] ?? '')
    return { ...cg, url: manifest.cg[cid] ?? '' }
  })

  return {
    ...script,
    characters: injectedChars,
    scenes: injectedScenes,
    cg_assets: injectedCg,
    cover_url: manifest.cover ?? '',
  }
}
