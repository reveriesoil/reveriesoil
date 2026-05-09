"""
orchestrator.py — AI 生成流程协调器（开源版）
与主项目的主要区别：使用本地文件存储替代 MinIO，去掉流式生成模式。
"""
import asyncio
import logging
from typing import Any, Dict, Optional

from app.services.ai import AccountOverdueError, image_gen, jimeng_gen, seedream5_gen, text_gen, voice_gen
from app.services.ai.text_gen import (
    generate_outline,
    validate_and_refine,
    generate_director_vision,
    generate_image_prompts,
    generate_voice_direction,
    generate_storyboard,
)
from app.storage.local_storage import upload_bytes

logger = logging.getLogger(__name__)


def _classify_image_error(err_msg: str) -> str:
    """根据错误消息分类，返回用户可读的原因说明。"""
    msg = err_msg.lower()
    if any(k in msg for k in ("overdue", "overdraft", "insufficient", "balance", "欠费", "余额不足", "quota", "exceed")):
        return "图像模型账户可能已欠费，请登录对应平台充值后重试"
    if any(k in msg for k in ("timeout", "connection", "network", "connect", "timed out", "reset", "unreachable", "eof", "ssl")):
        return "网络连接异常，请检查网络后重试"
    if any(k in msg for k in ("401", "unauthorized", "invalid api key", "authentication")):
        return "图像模型 API Key 无效或已失效，请检查配置"
    if any(k in msg for k in ("403", "forbidden", "permission", "disabled", "not allowed")):
        return "图像模型访问被拒绝，模型可能已下线或无权限使用"
    if any(k in msg for k in ("429", "rate limit", "too many")):
        return "图像模型请求频率超限，请稍后重试"
    if any(k in msg for k in ("500", "502", "503", "server error", "internal error")):
        return "图像模型服务端错误，请稍后重试"
    if err_msg:
        snippet = err_msg[:120].rstrip()
        return f"图像生成失败，请检查图像模型配置（错误：{snippet}）"
    return "图像生成失败，请检查图像模型配置后重试"


def _check_overdraft(e: Exception) -> None:
    """若异常信息含欠费关键字，转换为 AccountOverdueError 立即中止生成。"""
    msg = str(e).lower()
    if "accountoverdue" in msg or "account overdue" in msg:
        raise AccountOverdueError("豆包 ARK API 账户欠费，请充值后重试") from e


def _raise_if_overdraft(results) -> None:
    """检查 asyncio.gather(..., return_exceptions=True) 的结果，如有欠费错误立即抛出。"""
    for r in results:
        if isinstance(r, AccountOverdueError):
            raise r


def _resolve_api_key(provider: str) -> str:
    return ""


def _resolve_endpoint(cfg: Dict[str, Any]) -> Optional[str]:
    if cfg.get("endpoint"):
        return cfg["endpoint"]
    return None


def _ensure_dict(value: Any) -> Dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _dict_list(value: Any) -> list[dict]:
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, dict)]


def _collect_used_expressions(scenes: list) -> Dict[str, set]:
    """从 scenes[].dialogues[] 中收集每个角色实际用到的表情。

    返回：{character_id -> {expression, ...}}，每个集合至少包含 "normal" 兜底。
    """
    used: Dict[str, set] = {}
    for scene in scenes or []:
        if not isinstance(scene, dict):
            continue
        for dlg in scene.get("dialogues") or []:
            if not isinstance(dlg, dict):
                continue
            cid = (dlg.get("character_id") or "").strip()
            expr = (dlg.get("expression") or "normal").strip() or "normal"
            if cid:
                used.setdefault(cid, set()).add(expr)
    return used


def _expressions_for_char(char: dict, used_exprs: Dict[str, set]) -> list[str]:
    """根据剧本实际用到的表情过滤 char.expressions，避免全量生成。

    保证至少包含 "normal" 兜底；若 used 集合为空则回退到 ["normal"]。
    """
    declared = list(char.get("expressions") or ["normal"])
    if "normal" not in declared:
        declared.insert(0, "normal")
    cid = (char.get("id") or "").strip()
    used = used_exprs.get(cid, set()) | {"normal"}
    filtered = [e for e in declared if e in used]
    return filtered or ["normal"]


def _resolve_text_call(text_cfg: Dict[str, Any], agent_key: str) -> tuple[str, str, Optional[str]]:
    overrides = text_cfg.get("agent_overrides") or {}
    cfg = overrides.get(agent_key) if isinstance(overrides, dict) else None
    if not cfg:
        cfg = text_cfg
    api_key = cfg.get("api_key") or _resolve_api_key(cfg.get("provider", ""))
    model = cfg.get("model") or text_cfg.get("model", "deepseek-chat")
    endpoint = _resolve_endpoint(cfg)
    return api_key, model, endpoint


def _normalize_ai_config(ai_config: Dict[str, Any]) -> Dict[str, Any]:
    if isinstance(ai_config.get("text_model"), dict):
        overrides = ai_config.get("text_agent_overrides")
        if overrides and isinstance(overrides, dict):
            tm = dict(ai_config["text_model"])
            existing = tm.get("agent_overrides") or {}
            merged = {**existing, **overrides}
            tm["agent_overrides"] = merged
            ai_config = {**ai_config, "text_model": tm}
        normalized = dict(ai_config)
        for key in ("text_model", "image_model", "voice_model", "music_model"):
            normalized[key] = _ensure_dict(normalized.get(key))
        return normalized

    api_key = ai_config.get("api_key", "")
    endpoint = ai_config.get("endpoint") or None
    return {
        "text_model": {
            "provider": ai_config.get("text_provider", "deepseek"),
            "model": ai_config.get("text_model", "deepseek-chat"),
            "api_key": api_key,
            "endpoint": endpoint,
        },
        "image_model": {
            "provider": ai_config.get("image_provider", "custom"),
            "model": ai_config.get("image_model", ""),
            "api_key": api_key,
            "endpoint": None,
        },
        "voice_model": {
            "provider": ai_config.get("voice_provider", "_placeholder"),
            "model": ai_config.get("voice_model", "placeholder"),
            "api_key": api_key,
            "enabled": False,
            "endpoint": None,
        },
        "music_model": {
            "provider": "local",
            "api_key": "",
            "enabled": False,
        },
    }


class GenerationOrchestrator:
    def __init__(self, update_progress_fn):
        self.update_progress = update_progress_fn  # async fn(step, progress, error=None, model=None)

    def _validate_scene_count(self, scenes: list, target_scene_count: int) -> None:
        if target_scene_count == 0:
            return  # 小说模式：AI 自主决定场景数，不做验证
        actual = len([s for s in scenes if isinstance(s, dict)])
        if actual < target_scene_count:
            raise ValueError(
                f"分镜生成不完整：预期至少 {target_scene_count} 个场景，实际 {actual} 个。请重试。"
            )

    def _validate_required_visual_assets(self, characters: list, scenes: list, manifest: Dict[str, Any]) -> None:
        portraits = manifest.get("portraits", {})
        backgrounds = manifest.get("backgrounds", {})
        missing_portraits = [
            (c.get("name") or c.get("id"))
            for c in characters
            if isinstance(c, dict) and c.get("id") and not any(portraits.get(c["id"], {}).values())
        ]
        missing_backgrounds = [
            (s.get("title") or s.get("id"))
            for s in scenes
            if isinstance(s, dict) and not backgrounds.get(s.get("id"))
        ]
        if missing_portraits or missing_backgrounds:
            last_err = manifest.get("_last_image_error", "")
            reason = _classify_image_error(last_err)
            raise ValueError(f"图片素材生成失败：{reason}")

    async def run(
        self,
        game_id: str,
        task_id: str,
        prompt: str,
        ai_config: Dict[str, Any],
        story_spec: Dict[str, Any],
        character_prompt: str = "",
        on_script_ready=None,
        on_portraits_done=None,
        on_backgrounds_done=None,
    ) -> Dict[str, Any]:
        ai_config = _normalize_ai_config(ai_config)
        text_cfg = _ensure_dict(ai_config.get("text_model"))
        image_cfg = _ensure_dict(ai_config.get("image_model"))
        voice_cfg = _ensure_dict(ai_config.get("voice_model"))

        outline_call = _resolve_text_call(text_cfg, "outline")
        refine_call = _resolve_text_call(text_cfg, "refine")
        director_call = _resolve_text_call(text_cfg, "director")
        image_prompts_call = _resolve_text_call(text_cfg, "image_prompts")
        voice_dir_call = _resolve_text_call(text_cfg, "voice_direction")
        storyboard_call = _resolve_text_call(text_cfg, "storyboard")
        target_scene_count = text_gen._target_scene_count(story_spec)

        await self.update_progress("outline", 5, model=outline_call[1])
        outline = await generate_outline(prompt, story_spec, *outline_call, character_prompt=character_prompt)

        await self.update_progress("reviewing", 12, model=refine_call[1])
        outline = await validate_and_refine(outline, *refine_call, target_scene_count=target_scene_count)

        # 将用户选择的故事/美术风格注入 outline，供后续导演/分镜阶段在 JSON 中看到
        if isinstance(outline, dict):
            user_story_style = (story_spec.get("story_style") or "").strip()
            user_art_style = (story_spec.get("art_style") or "").strip()
            if user_story_style:
                outline["user_story_style"] = user_story_style
            if user_art_style:
                outline["user_art_style"] = user_art_style

        await self.update_progress("directing", 18, model=director_call[1])
        director = await generate_director_vision(outline, *director_call)

        await self.update_progress("exec_directing", 25, model=image_prompts_call[1])
        img_prompts = await generate_image_prompts(outline, director, *image_prompts_call)

        voice_prompts: Dict[str, str] = {}
        voice_enabled = voice_cfg.get("enabled", False)
        if voice_enabled:
            await self.update_progress("voice_direction", 27, model=voice_dir_call[1])
            voice_prompts = await generate_voice_direction(outline, director, *voice_dir_call)

        await self.update_progress("storyboard", 30, model=storyboard_call[1])
        scenes = await generate_storyboard(
            outline, director, img_prompts, *storyboard_call,
            depth=story_spec.get("depth", 2),
        )
        self._validate_scene_count(scenes, target_scene_count)

        script = text_gen._build_script(outline, director, img_prompts, scenes)
        # 优先用用户选择的风格名称做确定性映射，避免 LLM 翻译偏差导致风格错误
        _ART_STYLE_MAP = {
            "动漫": "2D anime style, cel shading, clean line art, vibrant colors, 2D illustration",
            "写实": "realistic photorealistic style, high detail, cinematic photography",
            "水彩": "watercolor painting style, soft brushstrokes, painterly, aquarelle",
            "像素": "pixel art style, 8-bit retro game sprite, pixelated, low-resolution aesthetic",
            "古风": "traditional Chinese ink painting style, wuxia aesthetic, classical brush art, guofeng",
            "赛博朋克": "cyberpunk neon-lit style, futuristic dystopian, synthwave aesthetic, neon city",
        }
        _user_art = (outline.get("user_art_style") or "").strip()
        _llm_global_style = script.get("global_style", "anime style, detailed illustration")
        global_style = _ART_STYLE_MAP.get(_user_art, _llm_global_style)
        characters = script.get("characters", [])

        if on_script_ready:
            try:
                await on_script_ready(script)
            except Exception as _e:
                logger.warning(f"on_script_ready 回调异常（不中断生成）: {_e}")

        assets_manifest: Dict[str, Any] = {
            "portraits": {}, "backgrounds": {}, "cg": {}, "voices": {}, "bgm": {},
        }

        _img_model = image_cfg.get("model", "dall-e-3")
        await self.update_progress("portraits", 30, model=_img_model)
        # 仅生成剧本中实际用到的表情（保留 normal 兜底）
        _used_exprs = _collect_used_expressions(scenes)
        portrait_tasks = [
            self._generate_portrait(char, expr, global_style, image_cfg, game_id, assets_manifest)
            for char in characters
            for expr in _expressions_for_char(char, _used_exprs)
        ]
        if portrait_tasks:
            _portrait_results = await asyncio.gather(*portrait_tasks, return_exceptions=True)
            _raise_if_overdraft(_portrait_results)
        await self.update_progress("portraits", 50, model=_img_model)

        # 立绘批次完成：触发增量保存回调（断点续传支持）
        if on_portraits_done:
            try:
                await on_portraits_done(script, assets_manifest)
            except Exception as _cb_e:
                logger.warning(f"on_portraits_done 回调异常（不中断生成）: {_cb_e}")

        await self.update_progress("backgrounds", 50, model=_img_model)
        token_save_mode = bool(image_cfg.get("token_save_mode", False))
        if token_save_mode:
            # Token 节省模式：按 bg_key 去重，相同 bg_key 的场景复用同一张图
            _bg_key_map: Dict[str, str] = {}    # scene_id → bg_key
            _bg_canonical: Dict[str, str] = {}  # bg_key → 首个 scene_id（主场景）
            for _bp in _dict_list(img_prompts.get("background_prompts", [])):
                _sid = _bp.get("scene_id", "")
                _bk = str(_bp.get("bg_key") or "").strip() or _sid
                if _sid:
                    _bg_key_map[_sid] = _bk
                    if _bk not in _bg_canonical:
                        _bg_canonical[_bk] = _sid
            # 只为每个 bg_key 的主场景生成图片
            unique_scenes = [s for s in scenes if _bg_canonical.get(_bg_key_map.get(s.get("id", ""), ""), "") == s.get("id", "")]
            background_tasks = [
                self._generate_background(scene, global_style, image_cfg, game_id, assets_manifest)
                for scene in unique_scenes
            ]
            if background_tasks:
                _bg_results = await asyncio.gather(*background_tasks, return_exceptions=True)
                _raise_if_overdraft(_bg_results)
            # 将主场景图片 URL 复用到同组的其余场景
            for scene in scenes:
                _sid = scene.get("id", "") if isinstance(scene, dict) else ""
                if not _sid or _sid in assets_manifest["backgrounds"]:
                    continue
                _bk = _bg_key_map.get(_sid, _sid)
                _canonical = _bg_canonical.get(_bk, _sid)
                _reuse_url = assets_manifest["backgrounds"].get(_canonical, "")
                assets_manifest["backgrounds"][_sid] = _reuse_url
                logger.info(f"[bg/token_save] dedup {_sid} bg_key={_bk} → reuse {_canonical}")
            logger.info(
                f"[bg/token_save] 实际生成 {len(unique_scenes)} 张, "
                f"复用 {len(scenes) - len(unique_scenes)} 张"
            )
        else:
            background_tasks = [
                self._generate_background(scene, global_style, image_cfg, game_id, assets_manifest)
                for scene in scenes
            ]
            if background_tasks:
                _bg_results = await asyncio.gather(*background_tasks, return_exceptions=True)
                _raise_if_overdraft(_bg_results)
        # 背景批次完成：在校验报错前触发增量保存回调（断点续传支持）
        if on_backgrounds_done:
            try:
                await on_backgrounds_done(script, assets_manifest)
            except Exception as _cb_e:
                logger.warning(f"on_backgrounds_done 回调异常（不中断生成）: {_cb_e}")
        self._validate_required_visual_assets(characters, scenes, assets_manifest)
        await self.update_progress("backgrounds", 65, model=_img_model)

        await self.update_progress("cg_images", 65, model=_img_model)
        cg_prompts = _dict_list(img_prompts.get("cg_prompts"))
        cg_tasks = [self._generate_cg(cg, image_cfg, game_id, assets_manifest) for cg in cg_prompts]
        if cg_tasks:
            _cg_results = await asyncio.gather(*cg_tasks, return_exceptions=True)
            _raise_if_overdraft(_cg_results)
        await self.update_progress("cg_images", 72, model=_img_model)

        if voice_enabled and voice_cfg.get("api_key"):
            _voice_model = voice_cfg.get("model", "tts-1")
            await self.update_progress("voices", 78, model=_voice_model)
            char_gender_map = {c["id"]: c.get("gender", "default") for c in characters if isinstance(c, dict) and c.get("id")}
            voice_tasks = [
                self._generate_voice(dlg, char_gender_map.get(dlg.get("character_id", ""), "default"),
                                     voice_cfg.get("api_key"), _voice_model,
                                     _resolve_endpoint(voice_cfg), game_id, assets_manifest)
                for scene in scenes if isinstance(scene, dict)
                for dlg in scene.get("dialogues", []) if isinstance(dlg, dict)
            ]
            await asyncio.gather(*voice_tasks, return_exceptions=True)
            await self.update_progress("voices", 88, model=_voice_model)

        await self.update_progress("packaging", 93, model="")
        script = self._inject_asset_urls(script, assets_manifest)

        await self.update_progress("cover", 95, model=_img_model)
        cover_url = await self._generate_cover(script, characters, scenes, global_style, game_id, image_cfg)
        assets_manifest["cover"] = cover_url

        return {"script_json": script, "assets_manifest": assets_manifest, "cover_url": cover_url}

    async def run_image_only(
        self,
        game_id: str,
        task_id: str,
        script: dict,
        ai_config: dict,
        on_portraits_done=None,
        on_backgrounds_done=None,
    ) -> Dict[str, Any]:
        """仅重新生成图片资产（剧本已存在）。
        
        断点续传：自动读取 script 中已有的 portrait_urls / background_url，
        跳过已成功生成的图片，只补全缺失部分。
        on_portraits_done: 可选异步回调 async(script, manifest)，立绘完成后调用
        """
        import copy
        ai_config = _normalize_ai_config(ai_config)
        image_cfg = _ensure_dict(ai_config.get("image_model"))
        voice_cfg = _ensure_dict(ai_config.get("voice_model"))

        script = copy.deepcopy(script)
        characters = script.get("characters", [])
        scenes = script.get("scenes", [])
        # 优先用保存的用户风格做确定性映射，避免 LLM 翻译偏差
        _ART_STYLE_MAP = {
            "动漫": "2D anime style, cel shading, clean line art, vibrant colors, 2D illustration",
            "写实": "realistic photorealistic style, high detail, cinematic photography",
            "水彩": "watercolor painting style, soft brushstrokes, painterly, aquarelle",
            "像素": "pixel art style, 8-bit retro game sprite, pixelated, low-resolution aesthetic",
            "古风": "traditional Chinese ink painting style, wuxia aesthetic, classical brush art, guofeng",
            "赛博朋克": "cyberpunk neon-lit style, futuristic dystopian, synthwave aesthetic, neon city",
        }
        _user_art = (script.get("user_art_style") or "").strip()
        _llm_global_style = script.get("global_style", "anime style, detailed illustration")
        global_style = _ART_STYLE_MAP.get(_user_art, _llm_global_style)

        assets_manifest: Dict[str, Any] = {
            "portraits": {}, "backgrounds": {}, "cg": {}, "voices": {}, "bgm": {},
        }

        # ── 断点续传：从 script 中恢复已生成的图片 URL ─────────────────────
        for char in characters:
            char_id = char.get("id", "")
            if not char_id:
                continue
            existing_portraits = char.get("portrait_urls") or {}
            for expr, url in existing_portraits.items():
                if url:
                    assets_manifest["portraits"].setdefault(char_id, {})[expr] = url

        for scene in scenes:
            scene_id = scene.get("id", "")
            if not scene_id:
                continue
            existing_bg = scene.get("background_url", "")
            if existing_bg:
                assets_manifest["backgrounds"][scene_id] = existing_bg

        skipped_p = sum(len(v) for v in assets_manifest["portraits"].values())
        skipped_b = len(assets_manifest["backgrounds"])
        if skipped_p or skipped_b:
            logger.info(f"断点续传：跳过已生成 {skipped_p} 张立绘, {skipped_b} 张背景")

        _img_model = image_cfg.get("model", "dall-e-3")
        await self.update_progress("portraits", 30, model=_img_model)

        # 仅生成剧本中实际用到的表情（保留 normal 兜底）
        _used_exprs = _collect_used_expressions(scenes)
        portrait_tasks = [
            self._generate_portrait(char, expr, global_style, image_cfg, game_id, assets_manifest)
            for char in characters
            for expr in _expressions_for_char(char, _used_exprs)
            # 跳过已有 URL 的立绘
            if not assets_manifest["portraits"].get(char.get("id", ""), {}).get(expr)
        ]
        if portrait_tasks:
            _p_results = await asyncio.gather(*portrait_tasks, return_exceptions=True)
            _raise_if_overdraft(_p_results)

        # 立绘完成：触发增量保存回调
        if on_portraits_done:
            try:
                await on_portraits_done(script, assets_manifest)
            except Exception as _cb_e:
                logger.warning(f"run_image_only on_portraits_done 回调异常: {_cb_e}")

        await self.update_progress("backgrounds", 50, model=_img_model)
        background_tasks = [
            self._generate_background(scene, global_style, image_cfg, game_id, assets_manifest)
            for scene in scenes
            # 跳过已有 URL 的背景
            if not assets_manifest["backgrounds"].get(scene.get("id", ""))
        ]
        if background_tasks:
            _b_results = await asyncio.gather(*background_tasks, return_exceptions=True)
            _raise_if_overdraft(_b_results)

        # 背景批次完成：在校验报错前触发增量保存回调
        if on_backgrounds_done:
            try:
                await on_backgrounds_done(script, assets_manifest)
            except Exception as _cb_e:
                logger.warning(f"run_image_only on_backgrounds_done 回调异常: {_cb_e}")

        await self.update_progress("packaging", 90, model="")
        script = self._inject_asset_urls(script, assets_manifest)

        await self.update_progress("cover", 95, model=_img_model)
        cover_url = await self._generate_cover(script, characters, scenes, global_style, game_id, image_cfg)
        assets_manifest["cover"] = cover_url

        return {"script_json": script, "assets_manifest": assets_manifest, "cover_url": cover_url}

    # ── 图片生成辅助方法 ──────────────────────────────────────────────────────

    async def _generate_portrait(self, char, expr, global_style, image_cfg, game_id, manifest):
        char_id = char["id"]
        provider = image_cfg.get("provider", "")
        expr_prompts = char.get("expression_prompts") or {}
        if isinstance(expr_prompts, dict) and expr_prompts.get(expr):
            appearance = expr_prompts[expr]
        elif char.get("base_prompt"):
            appearance = char["base_prompt"]
        else:
            appearance = char.get("appearance", char.get("appearance_en", ""))

        model = image_cfg.get("model", "dall-e-3")
        endpoint = _resolve_endpoint(image_cfg)
        api_key = image_cfg.get("api_key", "")

        try:
            if provider == "jimeng":
                ak = image_cfg.get("access_key_id", "")
                sk = image_cfg.get("secret_access_key", "")
                if ak and sk:
                    data = await jimeng_gen.generate_portrait(ak, sk, appearance, expr, global_style)
                    key = f"games/{game_id}/portraits/{char_id}_{expr}.png"
                    url = await upload_bytes(data, key, "image/png")
                    manifest["portraits"].setdefault(char_id, {})[expr] = url
                    return
            elif provider == "doubao":
                if api_key:
                    data = await seedream5_gen.generate_portrait(api_key, appearance, expr, global_style)
                    key = f"games/{game_id}/portraits/{char_id}_{expr}.png"
                    url = await upload_bytes(data, key, "image/png")
                    manifest["portraits"].setdefault(char_id, {})[expr] = url
                    return
            else:
                if api_key:
                    data = await image_gen.generate_portrait(character_appearance=appearance, expression=expr, global_style=global_style, api_key=api_key, model=model, endpoint=endpoint)
                    key = f"games/{game_id}/portraits/{char_id}_{expr}.png"
                    url = await upload_bytes(data, key, "image/png")
                    manifest["portraits"].setdefault(char_id, {})[expr] = url
                    return
        except Exception as e:
            _check_overdraft(e)
            manifest.setdefault("_last_image_error", str(e))
            logger.warning(f"立绘生成失败 {char_id}/{expr}: {e}")
        manifest["portraits"].setdefault(char_id, {})[expr] = ""

    async def _generate_background(self, scene, global_style, image_cfg, game_id, manifest):
        scene_id = scene["id"]
        desc = scene.get("background_description") or scene.get("background_desc", "a beautiful scene")
        provider = image_cfg.get("provider", "")
        model = image_cfg.get("model", "dall-e-3")
        endpoint = _resolve_endpoint(image_cfg)
        api_key = image_cfg.get("api_key", "")

        try:
            if provider == "jimeng":
                ak = image_cfg.get("access_key_id", "")
                sk = image_cfg.get("secret_access_key", "")
                if ak and sk:
                    data = await jimeng_gen.generate_background(ak, sk, desc, global_style)
                    key = f"games/{game_id}/backgrounds/{scene_id}.png"
                    url = await upload_bytes(data, key, "image/png")
                    manifest["backgrounds"][scene_id] = url
                    return
            elif provider == "doubao":
                if api_key:
                    data = await seedream5_gen.generate_background(api_key, desc, global_style)
                    key = f"games/{game_id}/backgrounds/{scene_id}.png"
                    url = await upload_bytes(data, key, "image/png")
                    manifest["backgrounds"][scene_id] = url
                    return
            else:
                if api_key:
                    data = await image_gen.generate_background(scene_description=desc, global_style=global_style, api_key=api_key, model=model, endpoint=endpoint)
                    key = f"games/{game_id}/backgrounds/{scene_id}.png"
                    url = await upload_bytes(data, key, "image/png")
                    manifest["backgrounds"][scene_id] = url
                    return
        except Exception as e:
            _check_overdraft(e)
            manifest.setdefault("_last_image_error", str(e))
            logger.warning(f"背景生成失败 {scene_id}: {e}")
        manifest["backgrounds"][scene_id] = ""

    async def _generate_cg(self, cg: dict, image_cfg, game_id, manifest):
        if not isinstance(cg, dict):
            return
        cg_id = cg.get("cg_id") or cg.get("id") or cg.get("scene_id")
        if not cg_id:
            return
        cg_prompt = cg.get("prompt", "")
        provider = image_cfg.get("provider", "")
        model = image_cfg.get("model", "dall-e-3")
        endpoint = _resolve_endpoint(image_cfg)
        api_key = image_cfg.get("api_key", "")
        logger.info(
            "[CG] start cg_id=%s provider=%s model=%s prompt_len=%d",
            cg_id, provider, model, len(cg_prompt),
        )

        try:
            if provider == "jimeng":
                ak = image_cfg.get("access_key_id", "")
                sk = image_cfg.get("secret_access_key", "")
                if ak and sk:
                    data = await jimeng_gen.generate_cg(ak, sk, cg_prompt)
                    key = f"games/{game_id}/cg/{cg_id}.png"
                    url = await upload_bytes(data, key, "image/png")
                    manifest["cg"][cg_id] = url
                    logger.info("[CG] ok cg_id=%s url=%s", cg_id, url)
                    return
                else:
                    logger.warning("[CG] jimeng 缺少 access_key/secret cg_id=%s", cg_id)
            elif provider == "doubao":
                if api_key:
                    data = await seedream5_gen.generate_cg(api_key, cg_prompt)
                    key = f"games/{game_id}/cg/{cg_id}.png"
                    url = await upload_bytes(data, key, "image/png")
                    manifest["cg"][cg_id] = url
                    logger.info("[CG] ok cg_id=%s url=%s", cg_id, url)
                    return
                else:
                    logger.warning("[CG] doubao 缺少 api_key cg_id=%s", cg_id)
            else:
                if api_key:
                    data = await image_gen.generate_cg(cg_prompt=cg_prompt, api_key=api_key, model=model, endpoint=endpoint)
                    key = f"games/{game_id}/cg/{cg_id}.png"
                    url = await upload_bytes(data, key, "image/png")
                    manifest["cg"][cg_id] = url
                    logger.info("[CG] ok cg_id=%s url=%s", cg_id, url)
                    return
                else:
                    logger.warning("[CG] 无 api_key cg_id=%s provider=%s", cg_id, provider)
        except Exception as e:
            _check_overdraft(e)
            logger.exception(f"CG 生成失败 {cg_id}: {e}")
        manifest["cg"][cg_id] = ""

    async def _generate_voice(self, dlg, gender, api_key, model, endpoint, game_id, manifest):
        dlg_id = dlg["id"]
        try:
            data = await voice_gen.synthesize_voice(dlg["text"], gender, api_key, model, endpoint)
            key = f"games/{game_id}/voices/{dlg_id}.mp3"
            url = await upload_bytes(data, key, "audio/mpeg")
            manifest["voices"][dlg_id] = url
        except Exception as e:
            logger.warning(f"语音合成失败 {dlg_id}: {e}")
            manifest["voices"][dlg_id] = ""

    async def _generate_cover(self, script, characters, scenes, global_style, game_id, image_cfg=None) -> str:
        title = script.get("title", "未命名故事")
        synopsis = script.get("synopsis", "")
        key_scenes = [s for s in scenes if s.get("background_description") or s.get("background_desc", "")][:3]
        image_cfg = _ensure_dict(image_cfg)
        provider = image_cfg.get("provider", "")
        model = image_cfg.get("model", "dall-e-3")
        endpoint = _resolve_endpoint(image_cfg)
        api_key = image_cfg.get("api_key", "")

        try:
            if provider == "jimeng":
                ak = image_cfg.get("access_key_id", "")
                sk = image_cfg.get("secret_access_key", "")
                if ak and sk:
                    data = await jimeng_gen.generate_cover(ak, sk, title, synopsis, characters, key_scenes, global_style)
                    key = f"games/{game_id}/cover.png"
                    url = await upload_bytes(data, key, "image/png")
                    return url
            elif provider == "doubao":
                if api_key:
                    data = await seedream5_gen.generate_cover(api_key, title, synopsis, characters, key_scenes, global_style)
                    key = f"games/{game_id}/cover.png"
                    url = await upload_bytes(data, key, "image/png")
                    return url
            else:
                if api_key:
                    data = await image_gen.generate_cover(title=title, synopsis=synopsis, characters=characters, scenes=key_scenes, global_style=global_style, api_key=api_key, model=model, endpoint=endpoint)
                    key = f"games/{game_id}/cover.png"
                    url = await upload_bytes(data, key, "image/png")
                    return url
        except Exception as e:
            _check_overdraft(e)
            logger.warning(f"封面图生成失败: {e}")
        return ""

    def _inject_asset_urls(self, script: dict, manifest: dict) -> dict:
        portraits = manifest.get("portraits", {})
        backgrounds = manifest.get("backgrounds", {})
        voices = manifest.get("voices", {})
        cg = manifest.get("cg", {})
        bgm = manifest.get("bgm", {})

        for char in script.get("characters", []):
            if not isinstance(char, dict):
                continue
            char_id = char.get("id", "")
            if char_id:
                char["portrait_urls"] = portraits.get(char_id, {})

        for scene in script.get("scenes", []):
            if not isinstance(scene, dict):
                continue
            scene_id = scene.get("id", "")
            scene["background_url"] = backgrounds.get(scene_id, "")
            mood = scene.get("bgm_mood", "peaceful")
            scene["bgm_url"] = bgm.get(mood, "")
            cg_id = scene.get("cg_trigger", "")
            if cg_id:
                scene["cg_url"] = cg.get(cg_id, "")
            for dlg in scene.get("dialogues", []):
                if not isinstance(dlg, dict):
                    continue
                dlg["voice_url"] = voices.get(dlg.get("id", ""), "")

        script["cg_assets"] = {cg_id: {"image_url": cg.get(cg_id, "")} for cg_id in cg}
        return script
