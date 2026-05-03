"""
orchestrator.py — AI 生成流程协调器（开源版）
与主项目的主要区别：使用本地文件存储替代 MinIO，去掉流式生成模式。
"""
import asyncio
import logging
from typing import Any, Dict, Optional

from app.services.ai import image_gen, text_gen, voice_gen
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
            details = []
            if missing_portraits:
                details.append("缺少角色立绘：" + "、".join(missing_portraits[:5]))
            if missing_backgrounds:
                details.append("缺少场景背景：" + "、".join(missing_backgrounds[:5]))
            raise ValueError("关键图片素材生成不完整：" + "；".join(details) + "。请检查图像模型配置后重试。")

    async def run(
        self,
        game_id: str,
        task_id: str,
        prompt: str,
        ai_config: Dict[str, Any],
        story_spec: Dict[str, Any],
        character_prompt: str = "",
        on_script_ready=None,
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
        global_style = script.get("global_style", "anime style, detailed illustration")
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
        portrait_tasks = [
            self._generate_portrait(char, expr, global_style, image_cfg, game_id, assets_manifest)
            for char in characters
            for expr in char.get("expressions", ["normal"])
        ]
        if portrait_tasks:
            await asyncio.gather(*portrait_tasks, return_exceptions=True)
        await self.update_progress("portraits", 50, model=_img_model)

        await self.update_progress("backgrounds", 50, model=_img_model)
        background_tasks = [
            self._generate_background(scene, global_style, image_cfg, game_id, assets_manifest)
            for scene in scenes
        ]
        if background_tasks:
            await asyncio.gather(*background_tasks, return_exceptions=True)
        self._validate_required_visual_assets(characters, scenes, assets_manifest)
        await self.update_progress("backgrounds", 65, model=_img_model)

        await self.update_progress("cg_images", 65, model=_img_model)
        cg_prompts = _dict_list(img_prompts.get("cg_prompts"))
        cg_tasks = [self._generate_cg(cg, image_cfg, game_id, assets_manifest) for cg in cg_prompts]
        if cg_tasks:
            await asyncio.gather(*cg_tasks, return_exceptions=True)
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
    ) -> Dict[str, Any]:
        """仅重新生成图片资产（剧本已存在）"""
        ai_config = _normalize_ai_config(ai_config)
        image_cfg = _ensure_dict(ai_config.get("image_model"))
        voice_cfg = _ensure_dict(ai_config.get("voice_model"))

        characters = script.get("characters", [])
        scenes = script.get("scenes", [])
        global_style = script.get("global_style", "anime style, detailed illustration")

        assets_manifest: Dict[str, Any] = {
            "portraits": {}, "backgrounds": {}, "cg": {}, "voices": {}, "bgm": {},
        }

        _img_model = image_cfg.get("model", "dall-e-3")
        await self.update_progress("portraits", 30, model=_img_model)
        portrait_tasks = [
            self._generate_portrait(char, expr, global_style, image_cfg, game_id, assets_manifest)
            for char in characters
            for expr in char.get("expressions", ["normal"])
        ]
        if portrait_tasks:
            await asyncio.gather(*portrait_tasks, return_exceptions=True)

        await self.update_progress("backgrounds", 50, model=_img_model)
        background_tasks = [
            self._generate_background(scene, global_style, image_cfg, game_id, assets_manifest)
            for scene in scenes
        ]
        if background_tasks:
            await asyncio.gather(*background_tasks, return_exceptions=True)

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

        if api_key:
            try:
                data = await image_gen.generate_portrait(character_appearance=appearance, expression=expr, global_style=global_style, api_key=api_key, model=model, endpoint=endpoint)
                key = f"games/{game_id}/portraits/{char_id}_{expr}.png"
                url = await upload_bytes(data, key, "image/png")
                manifest["portraits"].setdefault(char_id, {})[expr] = url
                return
            except Exception as e:
                logger.warning(f"立绘 fallback 生成失败 {char_id}/{expr}: {e}")
        manifest["portraits"].setdefault(char_id, {})[expr] = ""

    async def _generate_background(self, scene, global_style, image_cfg, game_id, manifest):
        scene_id = scene["id"]
        desc = scene.get("background_description") or scene.get("background_desc", "a beautiful scene")
        model = image_cfg.get("model", "dall-e-3")
        endpoint = _resolve_endpoint(image_cfg)
        api_key = image_cfg.get("api_key", "")

        if api_key:
            try:
                data = await image_gen.generate_background(scene_description=desc, global_style=global_style, api_key=api_key, model=model, endpoint=endpoint)
                key = f"games/{game_id}/backgrounds/{scene_id}.png"
                url = await upload_bytes(data, key, "image/png")
                manifest["backgrounds"][scene_id] = url
                return
            except Exception as e:
                logger.warning(f"背景 fallback 生成失败 {scene_id}: {e}")
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

        if api_key:
            try:
                data = await image_gen.generate_cg(cg_prompt=cg_prompt, api_key=api_key, model=model, endpoint=endpoint)
                key = f"games/{game_id}/cg/{cg_id}.png"
                url = await upload_bytes(data, key, "image/png")
                manifest["cg"][cg_id] = url
                return
            except Exception as e:
                logger.warning(f"CG fallback 生成失败 {cg_id}: {e}")
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

        if api_key:
            try:
                data = await image_gen.generate_cover(title=title, synopsis=synopsis, characters=characters, scenes=key_scenes, global_style=global_style, api_key=api_key, model=model, endpoint=endpoint)
                key = f"games/{game_id}/cover.png"
                url = await upload_bytes(data, key, "image/png")
                return url
            except Exception as e:
                logger.warning(f"封面图 fallback 生成失败: {e}")
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
