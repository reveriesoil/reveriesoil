"""
text_gen.py — AI 文本生成服务（多角色分工流水线）

角色分工：
  1. 总指挥 / 编剧    generate_outline()         故事骨架 + 人物性格
  2. 剧本统筹师       validate_and_refine()       质量校验 + 连贯性修正
  3. 导演             generate_director_vision()  全局艺术风格 + 人物造型 + 场景风格
  4. 执行导演         generate_image_prompts()    人物/场景/CG 详细绘图提示词
  5. 配音导演         generate_voice_direction()  人物音色风格提示词（可选）
  6. 分镜师(全流程)   generate_storyboard()       完整对话台词 + 玩家选项
  7. 分镜师(流式)     generate_stream_segment()   根据玩家选择/输入动态生成后续剧情
"""

import json
import logging
import random
from contextvars import ContextVar
from typing import Any, Dict, List, Optional

from openai import AsyncOpenAI

try:
    from json_repair import repair_json as _repair_json_lib
    _HAS_JSON_REPAIR = True
except ImportError:
    _HAS_JSON_REPAIR = False

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Token 计数上下文变量（Celery asyncio.run 每次创建新事件循环，ContextVar 隔离安全）
# ---------------------------------------------------------------------------
# 用法：在 generation_task.py 中 set({'total': 0})，生成结束后读取 .get()['total']
_token_counter: ContextVar[Optional[Dict[str, int]]] = ContextVar('_token_counter', default=None)

# ---------------------------------------------------------------------------
# 内部辅助
# ---------------------------------------------------------------------------

def _client(api_key: str, endpoint: Optional[str], timeout: float = 180.0) -> AsyncOpenAI:
    # 单次 LLM 调用最多 3 分钟；最多重试 1 次（默认 2 次累计可达 9 分钟，过长）
    return AsyncOpenAI(api_key=api_key, base_url=endpoint, timeout=timeout, max_retries=1)


def _client_for_model(api_key: str, endpoint: Optional[str], model: str) -> AsyncOpenAI:
    """根据模型特性选择合适的超时时长。
    Kimi K2 系列为大型 MoE 模型，单次推理可能耗时 3-5 分钟，需要更长的超时时间。
    """
    if _is_kimi_k2(model):
        return _client(api_key, endpoint, timeout=360.0)  # Kimi K2 允许 6 分钟
    return _client(api_key, endpoint)


# Kimi K2 系列：思考模式下 tool_choice 只能 auto/none、temperature 必须 1.0；
# 非思考模式下可使用 forced tool_choice、temperature 必须 0.6。我们工作流大量使用 forced
# function call，因此对 Kimi K2 默认走非思考模式（thinking=disabled, temperature=0.6）。
_KIMI_K2_HINTS = ("kimi-k2", "kimi-thinking", "moonshot-thinking")
_DEEPSEEK_V4_HINTS = ("deepseek-v4",)


def _is_kimi_k2(model: str) -> bool:
    lower = (model or "").lower()
    return any(h in lower for h in _KIMI_K2_HINTS)


def _is_deepseek_v4(model: str) -> bool:
    lower = (model or "").lower()
    return any(h in lower for h in _DEEPSEEK_V4_HINTS)


def _normalize_temperature(model: str, temperature: float) -> float:
    """对参数受限的模型自动归一化 temperature。
    - Kimi K2 系列：走非思考模式，强制 0.6
    """
    if _is_kimi_k2(model or ""):
        return 0.6
    return temperature


def _model_extra_body(model: str) -> Dict[str, Any]:
    """为所有文本模型统一禁用思考模式。
    强制 tool_choice 与 thinking 模式不兼容（doubao-seed / kimi-k2 / deepseek-v4 等均受此限制），
    全局关闭避免 finish_reason=tool_calls 但无 tool call 返回的错误。
    不支持该参数的模型（如标准 OpenAI 接口）会忽略未知字段，无副作用。
    """
    return {"thinking": {"type": "disabled"}}


def _accumulate_tokens(response) -> None:
    """将本次 LLM 响应的 token 用量累加到当前上下文计数器中。"""
    counter = _token_counter.get()
    if counter is None:
        return
    usage = getattr(response, "usage", None)
    if usage:
        counter["total"] = counter.get("total", 0) + (getattr(usage, "total_tokens", 0) or 0)


def _has_scene_data(d: Dict[str, Any]) -> bool:
    """检查大纲 dict 中是否包含场景数据。"""
    return bool(
        d.get("scene_outlines") or d.get("scenes") or
        d.get("chapters") or d.get("scene_list")
    )


def _outline_scene_list(d: Dict[str, Any]) -> List[Dict[str, Any]]:
    for key in ("scene_outlines", "scenes", "chapters", "scene_list"):
        value = d.get(key)
        if isinstance(value, list):
            return [item for item in value if isinstance(item, dict)]
    return []


def _outline_scene_count(d: Dict[str, Any]) -> int:
    return len(_outline_scene_list(d))


_NOVEL_MODE_DURATION = -1  # duration_minutes 为此值时进入完整小说模式（AI自主决定场景数）


def _is_novel_mode(story_spec: Dict[str, Any]) -> bool:
    """是否为完整小说模式（不限时长，AI自主创作直到故事完结）。"""
    try:
        return int(story_spec.get("duration_minutes", 30) or 30) == _NOVEL_MODE_DURATION
    except (TypeError, ValueError):
        return False


def _target_scene_count(story_spec: Dict[str, Any]) -> int:
    manual_count = story_spec.get("scene_count")
    if manual_count:
        try:
            return max(1, int(manual_count))
        except (TypeError, ValueError):
            pass
    try:
        duration = int(story_spec.get("duration_minutes", 30) or 30)
    except (TypeError, ValueError):
        duration = 30
    if duration == _NOVEL_MODE_DURATION:
        return 0  # 小说模式：由 AI 自行决定，0 表示无约束
    # 场景数与时长成比例：15分钟→8，30分钟→15，60分钟→30，120分钟→40（上限）
    return min(40, max(8, duration // 2))


def _has_required_scene_count(outline: Dict[str, Any], target_count: int) -> bool:
    return _outline_scene_count(outline) >= target_count


def _try_repair_json(raw: str) -> dict:
    """修复 LLM 返回的损坏 JSON（缺逗号/冒号、截断等）。
    优先使用 json-repair 库；不可用时回退到自定义截断修复。"""
    if not raw or not raw.strip():
        raise json.JSONDecodeError("JSON repair failed: empty input", raw or "", 0)

    # ── 优先：使用 json-repair 库 ──────────────────────────────────────────
    if _HAS_JSON_REPAIR:
        try:
            repaired = _repair_json_lib(raw, return_objects=True)
            if isinstance(repaired, dict):
                return repaired
            if isinstance(repaired, str):
                parsed = json.loads(repaired)
                if isinstance(parsed, dict):
                    return parsed
        except Exception as e:
            logger.debug(f"json-repair library failed: {e}, trying fallback repair...")

    # ── 回退：先尝试标准解析 ────────────────────────────────────────────────
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        pass

    # ── 回退：截断修复（仅处理 max_tokens 导致的 JSON 被截断情况）──────────
    raw = raw.strip()
    depth = 0
    in_str = False
    escape_next = False
    last_root_value_end = -1

    for i, ch in enumerate(raw):
        if escape_next:
            escape_next = False
            continue
        if ch == '\\' and in_str:
            escape_next = True
            continue
        if ch == '"':
            in_str = not in_str
            continue
        if in_str:
            continue

        prev_depth = depth
        if ch in ('{', '['):
            depth += 1
        elif ch in ('}', ']'):
            depth -= 1
        if prev_depth >= 2 and depth == 1:
            last_root_value_end = i + 1

    if last_root_value_end > 0:
        candidate = raw[:last_root_value_end].rstrip().rstrip(',') + '\n}'
        try:
            return json.loads(candidate)
        except json.JSONDecodeError:
            pass

    raise json.JSONDecodeError("JSON repair failed", raw, 0)


async def _call_tool(
    client: AsyncOpenAI,
    model: str,
    system: str,
    user: str,
    tool_schema: dict,
    temperature: float = 0.8,
    max_tokens: int = 8192,
) -> dict:
    """调用带 function_call 的 LLM，返回解析后的 JSON 字典。"""
    messages = [
        {"role": "system", "content": system},
        {"role": "user", "content": user},
    ]
    response = await client.chat.completions.create(
        model=model,
        messages=messages,
        tools=[{"type": "function", "function": tool_schema}],
        tool_choice={"type": "function", "function": {"name": tool_schema["name"]}},
        temperature=_normalize_temperature(model, temperature),
        max_tokens=max_tokens,
        extra_body=_model_extra_body(model),
    )
    _accumulate_tokens(response)
    choice = response.choices[0]
    if not choice.message.tool_calls:
        raise ValueError(
            f"_call_tool: model={model} did not return a tool call "
            f"(finish_reason={choice.finish_reason})"
        )
    raw = choice.message.tool_calls[0].function.arguments
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as e:
        logger.warning(f"Tool call JSON parse error: {e}. Trying JSON repair...")
        parsed = _try_repair_json(raw)
    if isinstance(parsed, list):
        # AI occasionally wraps the result in a JSON array; unwrap first dict element
        dict_items = [item for item in parsed if isinstance(item, dict)]
        if dict_items:
            logger.warning(
                f"_call_tool: AI returned a list ({len(parsed)} items), "
                f"using first dict element (model={model})"
            )
            return dict_items[0]
        raise ValueError(
            f"_call_tool: AI returned a list with no dict elements (model={model})"
        )
    return parsed


async def _call_json(
    client: AsyncOpenAI,
    model: str,
    system: str,
    user: str,
    temperature: float = 0.7,
    max_tokens: int = 4000,
) -> dict:
    """调用 LLM，要求返回 JSON 对象（无 function call）。"""
    response = await client.chat.completions.create(
        model=model,
        messages=[
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        response_format={"type": "json_object"},
        temperature=_normalize_temperature(model, temperature),
        max_tokens=max_tokens,
        extra_body=_model_extra_body(model),
    )
    _accumulate_tokens(response)
    raw = response.choices[0].message.content
    if not raw:
        raise ValueError(
            f"_call_json: response content is empty "
            f"(model={model}, finish_reason={response.choices[0].finish_reason})"
        )
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as e:
        logger.warning(f"_call_json JSON parse error: {e}. Trying JSON repair...")
        parsed = _try_repair_json(raw)
    if not isinstance(parsed, dict):
        raise ValueError(f"_call_json: expected JSON object, got {type(parsed).__name__}")
    return parsed


# ---------------------------------------------------------------------------
# Step 1 — 总指挥 / 编剧
# ---------------------------------------------------------------------------

OUTLINE_SCHEMA = {
    "name": "generate_story_outline",
    "description": "生成视觉小说故事大纲及人物档案",
    "parameters": {
        "type": "object",
        "properties": {
            "title": {"type": "string"},
            "genre": {"type": "string"},
            "theme": {"type": "string"},
            "synopsis": {"type": "string"},
            "characters": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "id": {"type": "string"},
                        "name": {"type": "string"},
                        "age": {"type": "integer"},
                        "gender": {"type": "string", "enum": ["male", "female", "neutral"]},
                        "role": {"type": "string"},
                        "personality": {"type": "string"},
                        "background": {"type": "string"},
                        "speech_style": {"type": "string"},
                        "arc": {"type": "string"},
                        "relationships": {"type": "string"},
                    },
                    "required": ["id", "name", "age", "gender", "role",
                                 "personality", "background", "speech_style",
                                 "arc", "relationships"],
                },
            },
            "scene_outlines": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "id": {"type": "string"},
                        "title": {"type": "string"},
                        "summary": {"type": "string"},
                        "location": {"type": "string"},
                        "time": {"type": "string"},
                        "mood": {
                            "type": "string",
                            "enum": ["peaceful", "tense", "romantic", "mysterious",
                                     "battle", "sad", "triumphant"],
                        },
                        "characters_present": {"type": "array", "items": {"type": "string"}},
                        "key_event": {"type": "string"},
                        "has_cg": {"type": "boolean"},
                        "cg_description": {"type": "string"},
                        "has_branch": {"type": "boolean"},
                        "branch_summary": {"type": "string"},
                        "next_scene_id": {"type": "string"},
                    },
                    "required": ["id", "title", "summary", "location", "time", "mood",
                                 "characters_present", "key_event", "has_cg",
                                 "cg_description", "has_branch", "branch_summary",
                                 "next_scene_id"],
                },
            },
            "ending": {
                "type": "object",
                "properties": {
                    "type": {"type": "string", "enum": ["good", "bad", "neutral", "multiple"]},
                    "title": {"type": "string"},
                    "summary": {"type": "string"},
                },
                "required": ["type", "title", "summary"],
            },
        },
        "required": ["title", "genre", "theme", "synopsis",
                     "characters", "scene_outlines", "ending"],
    },
}


async def generate_outline(
    prompt: str,
    story_spec: Dict[str, Any],
    api_key: str,
    model: str,
    endpoint: Optional[str],
    character_prompt: str = "",
) -> Dict[str, Any]:
    """总指挥 / 编剧：生成故事大纲与人物档案（不写对话台词）。"""
    duration = story_spec.get("duration_minutes", 30)
    depth = story_spec.get("depth", 2)  # 1-5 故事深度级别
    _depth_style = {
        1: (
            "【叙事风格：轻盈】故事节奏明快，情感直白温暖，对白幽默生动，"
            "人物心理简单直接，不设置隐晦伏笔，适合轻松愉快的阅读体验。"
        ),
        2: (
            "【叙事风格：标准】故事有完整起伏，角色情感层次清晰，"
            "对白自然流畅，偶尔有意味深长的细节，整体易读易懂。"
        ),
        3: (
            "【叙事风格：深沉】注重人物内心刻画，对白含蓄有潜台词，"
            "埋设可供细品的伏笔与隐喻，角色动机复杂，情感层次丰富，"
            "读者需要思考才能完全理解人物行为背后的真实含义。"
        ),
        4: (
            "【叙事风格：厚重】叙事多线交织，角色弧线相互影响，"
            "对话字面义与深层义并存，主题通过细节和象征缓慢渗透，"
            "人物的每句话都可能折射其内心创伤或世界观，"
            "故事值得反复品读，每次读都能发现新含义。"
        ),
        5: (
            "【叙事风格：极致深邃】叙事如精密钟表，每个细节都有双重甚至三重意涵，"
            "哲学命题与人性拷问融入日常对话，人物言行之下暗流涌动，"
            "结局看似明朗却余韵无穷，令人在阅后长久思索。"
            "写作时刻意保留解读空间，不作任何直白解释。"
        ),
    }
    _depth_hint = _depth_style.get(depth, _depth_style[2])
    novel_mode = _is_novel_mode(story_spec)
    scene_count = _target_scene_count(story_spec)  # 0 表示小说模式（AI自决）
    interaction_level = int(story_spec.get("interaction_level", 3) or 3)
    interaction_level = max(1, min(5, interaction_level))
    # 由交互程度推导分支密度；level=1 退化为线性叙事，更高级别要求更多分支节点
    _interaction_hint = {
        1: "本作为【沉浸观影模式】：完全线性叙事，全程无任何分支选择，角色行动由剧本推进，玩家只需阅读欣赏；不要安排任何 has_branch 节点。",
        2: "本作为【轻度互动】：仅在 1 个关键转折点安排分支选择，影响结局倾向；其余场景为线性。",
        3: "本作为【标准互动】：在 2-3 个关键节点安排分支选择，每个分支影响后续剧情走向，使故事有至少 2 条不同走向。",
        4: "本作为【高互动】：在 4-5 个节点安排分支选择，分支可嵌套形成支线，故事走向多样，结局至少 3 个分支变体。",
        5: "本作为【极致互动 / 角色扮演】：每 2-3 个场景就出现一次玩家选择，重要选择会改变角色关系、剧情走向、甚至人物命运；安排 6 个以上分支节点，构造多结局网状叙事。",
    }
    branch_enabled = story_spec.get("branch_enabled", True) and interaction_level >= 2
    _branch_hint = _interaction_hint.get(interaction_level, _interaction_hint[3])

    if novel_mode:
        # ── 完整小说模式：不限制场景数，AI 按故事完整性自主决定 ─────────────
        system = f"""你是一位顶级视觉小说总编剧，负责创作完整的长篇故事大纲和人物档案。

{_depth_hint}

【重要约束】故事的世界观、时代背景、人物设定与剧情走向仅由叙事深度和故事风格类型决定，与美术画风完全无关。请勿因画风而改变故事的时代背景、世界设定或剧情内容。

【标题与选题独创性】title 字段必须直接从用户提示词中提炼核心意象或冲突，不得使用任何曾出现在动漫/轻小说/视觉小说作品中的常见标题（例如"镜中人""错位时光""命运之约"等流派套话）；故事设定、人物关系须与用户提示词高度相关，不得套用该流派的典型模板情节。

【完整小说模式】本次创作没有场景数量上限，你需要创作一部情节完整、叙事丰富的长篇故事。场景数量由故事本身的需要决定——通常在 60-120 个场景之间，直到故事有自然、圆满、令人满意的结局为止。不要因为场景多而压缩情节，要让每个场景都有独立的戏剧价值。

任务：
- 创作 3-6 名人物，每人有鲜明性格、背景故事、完整成长弧线、独特说话方式和口头禅，以及能体现其内心世界的标志性行为习惯
- 规划足够多的场景以讲述完整故事，每个场景的 summary 控制在 150 字以内，按照"引入→世界建立→人物关系发展→初次冲突→深化矛盾→情感积累→高潮→余波→结局"宏观结构编排，中间可有多个起伏波折
- 每个场景只需写情节摘要，不需要写对话，但**必须**写明：①场景情绪基调，②出场人物的当前心理状态，③该场景发生的核心事件及其对人物关系的影响，④为后续场景留下的伏笔或悬念
- **每个场景的 characters_present 必填**，列出该场景出场的所有角色 ID，最多 2-3 人；旁白场景至少包含主视角角色 ID。该字段决定立绘渲染，禁止留空数组。
- {_branch_hint}
- 在高潮或重要情感时刻安排 CG（has_cg=true），长篇故事可安排 4-8 个 CG
- 故事须有完整起承转合，情感层次丰富，不同场景情绪要有明显起伏
- 每个场景都要推动主线剧情发展，不能重复相似情节
- 最后一个场景必须是故事的真正结局，让读者感到故事已完整落幕
- 所有 ID 用英文下划线格式（如 scene_001, char_alice）"""
        outline_max_tokens = 16384
    else:
        system = f"""你是一位顶级视觉小说总编剧，负责创作故事大纲和人物档案。

{_depth_hint}

【重要约束】故事的世界观、时代背景、人物设定与剧情走向仅由叙事深度和故事风格类型决定，与美术画风完全无关。请勿因画风而改变故事的时代背景、世界设定或剧情内容。

【标题与选题独创性】title 字段必须直接从用户提示词中提炼核心意象或冲突，不得使用任何曾出现在动漫/轻小说/视觉小说作品中的常见标题（例如"镜中人""错位时光""命运之约"等流派套话）；故事设定、人物关系须与用户提示词高度相关，不得套用该流派的典型模板情节。

任务：
- 创作 3-5 名人物，每人有鲜明性格、背景故事、成长弧线、独特说话方式和口头禅，以及能体现其内心世界的标志性行为习惯
- 规划恰好 {scene_count} 个场景，每个场景的 summary 控制在 150 字以内（避免截断），按照"引入→建立关系→冲突积累→情感爆发→高潮→余波→结局"结构编排
- 每个场景只需写情节摘要，不需要写对话，但**必须**写明：①场景情绪基调，②出场人物的当前心理状态，③该场景发生的核心事件及其对人物关系的影响，④为后续场景留下的伏笔或悬念
- **每个场景的 characters_present 必填**，列出该场景出场的所有角色 ID（来自 characters 数组的 id 字段，例如 ["char_alice", "char_bob"]），最多 2-3 人；旁白场景至少包含主视角角色 ID。该字段决定立绘渲染，禁止留空数组。
- {_branch_hint}
- 在高潮或重要情感时刻安排 CG（has_cg=true），整个故事 2-4 个 CG 为宜
- 故事须有完整起承转合，情感层次丰富，不同场景情绪要有明显起伏
- 每个场景都要推动主线剧情发展，不能重复相似情节
- 所有 ID 用英文下划线格式（如 scene_001, char_alice）"""
        outline_max_tokens = 8192

    client = _client_for_model(api_key, endpoint, model)
    title_hint = story_spec.get("title", "")
    story_style_hint = (story_spec.get("story_style") or "").strip()
    art_style_hint = (story_spec.get("art_style") or "").strip()
    # 随机选取创意方向提示，防止模型对相同风格组合固化输出（如持续生成同质化标题）
    _creativity_hints = [
        "请充分发挥创意，从用户提示词出发构建完全原创、独一无二的世界观与人物关系。",
        "故事的标题、核心冲突与人物设定必须紧扣用户提示词，展现这个特定故事才有的独特视角。",
        "请从用户提示词的具体细节中提炼故事灵感，打造与众不同的叙事切入点。",
        "在满足风格要求的同时，请以全新视角演绎这个故事，避免任何流派常见的套路情节。",
        "本次创作的核心挑战是让故事标题和设定令人耳目一新，完全区别于同类型已有作品。",
    ]
    _creativity_note = random.choice(_creativity_hints)
    user_content = (
        f"请根据以下提示词创作故事大纲：\n{prompt}"
        + (f"\n\n【用户指定的故事标题】：{title_hint}（请使用此标题，不要自行另取）" if title_hint else "")
        + (f"\n\n【故事风格类型】：{story_style_hint}（整体叙事、氛围与题材须紧扣此风格）" if story_style_hint else "")
        + (f"\n\n【未来绘画风格】：{art_style_hint}（在人物、场景描述中预留与该美术风格一致的视觉要素，后续导演阶段会据此决定全局美术风格）" if art_style_hint else "")
        + (f"\n\n【用户指定的人物设定】：\n{character_prompt}\n请严格按照以上角色创作人物档案（名字、性格、背景等），可补充细节但不可替换或删除已指定的角色。" if character_prompt and character_prompt.strip() else "")
        + f"\n\n{_creativity_note}"
    )
    result = await _call_tool(
        client, model, system,
        user_content,
        OUTLINE_SCHEMA, temperature=0.9, max_tokens=outline_max_tokens,
    )

    # 验校：若 scene_outlines 缺失或数量不足，用 json_object 模式强制重试。
    actual_scene_count = _outline_scene_count(result)

    if novel_mode:
        # 小说模式：接受 AI 返回的任意场景数（安全上限 200），不强制重试
        actual_scene_count = min(actual_scene_count, 200)
        logger.info(f"小说模式大纲：AI 规划了 {actual_scene_count} 个场景")
        return result

    if actual_scene_count < scene_count:
        logger.warning(
            f"大纲场景数不足：{actual_scene_count}/{scene_count} "
            f"（已有字段：{list(result.keys())}），使用 json_object 模式重试"
        )
        retry_system = (
            system
            + f"\n\n注意：你必须完整输出 scene_outlines 数组，数量必须恰好为 {scene_count} 个场景，"
            f"不能少于 {scene_count} 个。上一版只输出了 {actual_scene_count} 个，这是不合格输出。"
            "每个场景的 summary 字段控制在 120 字以内，以确保完整输出。"
            "\n请以 JSON 格式输出，包含所有必填字段：title, genre, theme, synopsis, "
            "characters, scene_outlines, ending。"
        )
        result = await _call_json(
            client, model, retry_system,
            f"请根据以下提示词创作故事大纲，务必输出完整的 scene_outlines 数组，共 {scene_count} 个场景：\n{prompt}"
            + (f"\n\n【用户指定标题】：{title_hint}" if title_hint else ""),
            temperature=0.9, max_tokens=12288,
        )

    actual_scene_count = _outline_scene_count(result)
    if actual_scene_count < scene_count:
        raise ValueError(
            f"大纲场景数不足：预期 {scene_count} 个，实际 {actual_scene_count} 个。"
            "已停止后续图片生成，请稍后重试或降低游戏时长。"
        )

    return result


# ---------------------------------------------------------------------------
# Step 2 — 剧本统筹师
# ---------------------------------------------------------------------------

async def validate_and_refine(
    outline: Dict[str, Any],
    api_key: str,
    model: str,
    endpoint: Optional[str],
    target_scene_count: Optional[int] = None,
) -> Dict[str, Any]:
    """剧本统筹师：检查大纲结构完整性、人物一致性、场景连贯性并修正。"""
    system = """你是一位资深剧本统筹师，负责审核和改进故事大纲。

检查维度：
1. 场景连贯性：各场景情节是否流畅衔接
2. 人物一致性：人物性格和说话方式是否保持一致
3. 人物弧线：每个主要角色是否有清晰成长
4. 节奏把控：情绪曲线是否有起伏
5. CG 合理性：CG 是否安排在情感最高点
6. 分支逻辑：选项是否有实质性差异

直接修正输出改进后的大纲（JSON 格式与输入相同）。返回纯 JSON，不要解释文字。"""

    user = f"请检查并改进以下故事大纲：\n{json.dumps(outline, ensure_ascii=False)}"

    try:
        result = await _call_json(
            _client_for_model(api_key, endpoint, model), model, system, user,
            temperature=0.3, max_tokens=8192,
        )
        if "outline" in result:
            refined = result["outline"]
            if _has_scene_data(refined):
                if target_scene_count and not _has_required_scene_count(refined, target_scene_count):
                    logger.warning(
                        f"剧本统筹师输出场景数不足：{_outline_scene_count(refined)}/{target_scene_count}，回退原始大纲"
                    )
                    return outline
                return refined
            logger.warning("剧本统筹师返回的 outline 缺少场景数据，回退原始大纲")
            return outline
        if "title" in result:
            if _has_scene_data(result):
                if target_scene_count and not _has_required_scene_count(result, target_scene_count):
                    logger.warning(
                        f"剧本统筹师输出场景数不足：{_outline_scene_count(result)}/{target_scene_count}，回退原始大纲"
                    )
                    return outline
                return result
            logger.warning("剧本统筹师返回结果缺少场景数据，回退原始大纲")
            return outline
        return outline
    except Exception as e:
        logger.warning(f"剧本统筹师校验失败，使用原始大纲: {e}")
        return outline


# ---------------------------------------------------------------------------
# Step 3 — 导演：全局艺术风格 + 人物造型 + 场景风格
# ---------------------------------------------------------------------------

DIRECTOR_VISION_SCHEMA = {
    "name": "generate_director_vision",
    "description": "导演：输出全局艺术风格指导、人物视觉设计和声音设计",
    "parameters": {
        "type": "object",
        "properties": {
            "global_art_style": {"type": "string"},
            "color_palette": {"type": "string"},
            "lighting_style": {"type": "string"},
            "art_direction_notes": {"type": "string"},
            "character_designs": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "character_id": {"type": "string"},
                        "appearance_en": {"type": "string"},
                        "outfit_en": {"type": "string"},
                        "makeup_en": {"type": "string"},
                        "expressions": {
                            "type": "array",
                            "items": {
                                "type": "string",
                                "enum": ["normal", "happy", "sad", "surprised",
                                         "angry", "shy", "serious", "hurt"],
                            },
                        },
                        "voice_character": {"type": "string"},
                        "voice_age": {"type": "string",
                                     "enum": ["child", "youth", "adult", "elder"]},
                        "speaking_pace": {"type": "string",
                                         "enum": ["slow", "moderate", "fast"]},
                    },
                    "required": ["character_id", "appearance_en", "outfit_en",
                                 "makeup_en", "expressions", "voice_character",
                                 "voice_age", "speaking_pace"],
                },
            },
            "scene_styles": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "scene_id": {"type": "string"},
                        "atmosphere_en": {"type": "string"},
                        "style_modifier_en": {"type": "string"},
                        "time_of_day": {"type": "string"},
                        "special_elements": {"type": "string"},
                    },
                    "required": ["scene_id", "atmosphere_en", "style_modifier_en",
                                 "time_of_day", "special_elements"],
                },
            },
        },
        "required": ["global_art_style", "color_palette", "lighting_style",
                     "art_direction_notes", "character_designs", "scene_styles"],
    },
}


def _normalize_director_vision(result: Dict[str, Any], outline: Dict[str, Any]) -> Dict[str, Any]:
    """规范化导演输出，处理模型返回格式不一致的情况。"""
    # 1. color_palette 可能是 dict → 转为字符串
    cp = result.get("color_palette", "")
    if isinstance(cp, dict):
        result["color_palette"] = ", ".join(
            f"{k}: {v}" for k, v in cp.items()
        )

    # 2. character_designs 可能是 dict（中文键）→ 转为数组
    cd = result.get("character_designs", [])
    if isinstance(cd, dict):
        outline_chars = {c.get("name", ""): c.get("id", "") for c in outline.get("characters", []) if isinstance(c, dict)}
        normalized = []
        for key, val in cd.items():
            if not isinstance(val, dict):
                continue
            # 尝试用大纲中对应角色名匹配 ID
            cid = outline_chars.get(key, "") or f"char_{len(normalized):03d}"
            normalized.append({
                "character_id": cid,
                "appearance_en": val.get("appearance_en") or val.get("外貌", ""),
                "outfit_en": val.get("outfit_en") or val.get("服装", ""),
                "makeup_en": val.get("makeup_en") or val.get("妆造", ""),
                "expressions": [
                    e for e in val.get("expressions", val.get("表情状态", ["normal", "happy", "sad"]))
                    if e in {"normal", "happy", "sad", "surprised", "angry", "shy", "serious", "hurt"}
                ] or ["normal", "happy", "sad"],
                "voice_character": val.get("voice_character") or val.get("声音气质", ""),
                "voice_age": val.get("voice_age", "youth"),
                "speaking_pace": val.get("speaking_pace", "moderate"),
            })
        result["character_designs"] = normalized

    # 3. scene_styles 可能是 dict → 转为数组
    ss = result.get("scene_styles", [])
    if isinstance(ss, dict):
        normalized_ss = []
        for key, val in ss.items():
            if isinstance(val, str):
                normalized_ss.append({
                    "scene_id": key,
                    "atmosphere_en": val,
                    "style_modifier_en": "",
                    "time_of_day": "night",
                    "special_elements": "",
                })
            elif isinstance(val, dict):
                normalized_ss.append({
                    "scene_id": key,
                    "atmosphere_en": val.get("atmosphere_en") or val.get("氛围", ""),
                    "style_modifier_en": val.get("style_modifier_en", ""),
                    "time_of_day": val.get("time_of_day", ""),
                    "special_elements": val.get("special_elements", ""),
                })
        result["scene_styles"] = normalized_ss

    return result


async def generate_director_vision(
    outline: Dict[str, Any],
    api_key: str,
    model: str,
    endpoint: Optional[str],
) -> Dict[str, Any]:
    """导演：根据剧本大纲，输出全局艺术风格、人物视觉/声音设计、场景风格。"""
    chars_list = ", ".join(
        f"{c.get('id','?')}({c.get('name','?')})"
        for c in outline.get("characters", [])
        if isinstance(c, dict)
    )
    scenes_list = ", ".join(
        so.get("id", "?") for so in (
            outline.get("scene_outlines") or outline.get("scenes") or []
        )
    )

    user_art_style = (outline.get("user_art_style") or "").strip()
    user_story_style = (outline.get("user_story_style") or "").strip()
    style_hint_lines = []
    if user_art_style:
        style_hint_lines.append(
            f"⚠️ 用户已指定【绘画风格】：{user_art_style}\n"
            f"  → global_art_style 必须明确反映该风格（例如英文化为绘画风格关键词），"
            f"appearance_en / outfit_en / atmosphere_en 中的视觉描述必须与该风格保持一致；不得擅自改用其他美术流派。"
        )
    if user_story_style:
        style_hint_lines.append(
            f"⚠️ 用户已指定【故事风格类型】：{user_story_style}\n"
            f"  → color_palette / lighting_style / atmosphere_en 须与该题材气氛吻合。"
        )
    style_hint_block = ("\n\n" + "\n".join(style_hint_lines)) if style_hint_lines else ""

    system = f"""你是视觉小说的艺术总监（导演），负责整体视觉和声音风格设计。{style_hint_block}

严格输出要求（必须遵守）：
- character_designs 必须是 JSON 数组，每个元素含 character_id（使用大纲中的 ID）
- 已知角色 ID：{chars_list}
- scene_styles 必须是 JSON 数组，每个元素含 scene_id（使用大纲中的 ID）
- 已知场景 ID：{scenes_list}
- color_palette 必须是字符串（如 "deep purple, dark green, gold"）
- appearance_en / outfit_en / makeup_en / atmosphere_en 全部使用英文
- expressions 只能从以下选取：normal / happy / sad / surprised / angry / shy / serious / hurt

输出示例（character_designs 数组格式）：
"character_designs": [
  {{"character_id": "char_xxx", "appearance_en": "...", "outfit_en": "...",
    "makeup_en": "...", "expressions": ["normal","happy","sad"],
    "voice_character": "温柔空灵", "voice_age": "youth", "speaking_pace": "moderate"}}
]"""

    user = f"请根据以下剧本大纲进行艺术设计：\n{json.dumps(outline, ensure_ascii=False)}"

    result = await _call_tool(
        _client_for_model(api_key, endpoint, model), model, system, user,
        DIRECTOR_VISION_SCHEMA, temperature=0.75, max_tokens=8192,
    )
    return _normalize_director_vision(result, outline)


# ---------------------------------------------------------------------------
# Step 4 — 执行导演：详细绘图提示词
# ---------------------------------------------------------------------------

# 拆分为两个 schema，避免单次输出超出模型 token 上限（8192）
# Step 4a — 人物绘图提示词
CHARACTER_PROMPTS_SCHEMA = {
    "name": "generate_character_prompts",
    "description": "执行导演：输出人物绘图提示词",
    "parameters": {
        "type": "object",
        "properties": {
            "character_prompts": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "character_id": {"type": "string"},
                        "base_prompt": {"type": "string"},
                        "negative_prompt": {"type": "string"},
                        "expression_prompts": {
                            "type": "object",
                            "additionalProperties": {"type": "string"},
                        },
                    },
                    "required": ["character_id", "base_prompt",
                                 "negative_prompt", "expression_prompts"],
                },
            },
        },
        "required": ["character_prompts"],
    },
}

# Step 4b — 背景 & CG 绘图提示词
SCENE_PROMPTS_SCHEMA = {
    "name": "generate_scene_prompts",
    "description": "执行导演：输出背景/CG 绘图提示词",
    "parameters": {
        "type": "object",
        "properties": {
            "background_prompts": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "scene_id": {"type": "string"},
                        "bg_key": {"type": "string"},
                        "prompt": {"type": "string"},
                        "negative_prompt": {"type": "string"},
                    },
                    "required": ["scene_id", "bg_key", "prompt", "negative_prompt"],
                },
            },
            "cg_prompts": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "scene_id": {"type": "string"},
                        "cg_id": {"type": "string"},
                        "prompt": {"type": "string"},
                        "negative_prompt": {"type": "string"},
                        "is_animatable": {"type": "boolean"},
                    },
                    "required": ["scene_id", "cg_id", "prompt",
                                 "negative_prompt", "is_animatable"],
                },
            },
        },
        "required": ["background_prompts", "cg_prompts"],
    },
}

# 保留旧名供其他代码引用（不再使用，但避免 NameError）
IMAGE_PROMPTS_SCHEMA = CHARACTER_PROMPTS_SCHEMA


async def generate_image_prompts(
    outline: Dict[str, Any],
    director_vision: Dict[str, Any],
    api_key: str,
    model: str,
    endpoint: Optional[str],
) -> Dict[str, Any]:
    """执行导演：将艺术指导转化为可直接送入图像生成模型的详细 prompt。"""
    _user_art = (outline.get("user_art_style") or "").strip()
    _style_examples = {
        "动漫": "anime style, cel shading, clean line art, vibrant colors, 2D illustration",
        "写实": "realistic, photorealistic, highly detailed, cinematic photography style",
        "水彩": "watercolor painting, soft brushstrokes, painterly, aquarelle art style",
        "像素": "pixel art, 8-bit sprite style, retro game graphics, pixelated, low-res aesthetic",
        "古风": "traditional Chinese ink painting, guofeng style, wuxia aesthetic, brush calligraphy art",
        "赛博朋克": "cyberpunk style, neon-lit, futuristic dystopian, synthwave, holographic effects",
    }
    _art_style_hint = _style_examples.get(_user_art, "match the global_art_style from the director vision exactly")
    system = f"""你是执行导演，负责将艺术总监的风格指导转化为具体的 AI 绘图提示词。

要求：
- 每个 prompt 须整合全局风格 + 场景/人物专属风格

- 人物 base_prompt（必须使用英文，Stable Diffusion 关键词格式）：
  • 外貌：发色、发型、眼色、肤色、体型特征、年龄感
  • 服装：颜色、款式、配饰、材质细节
  • 妆容：唇色、眼妆、整体风格
  • 构图关键词（必须包含）：full body shot, standing pose, centered in frame, looking at viewer, facing camera, complete figure with feet visible
  • 质量关键词（必须包含）：masterpiece, best quality, highres, ultra detailed, sharp focus
  • 背景关键词（必须包含）：pure solid green background, chroma key green #00FF00, no background details, no shadows
  • 风格关键词（必须严格遵循用户指定的【{_user_art or "全局艺术风格"}】，使用如下关键词）：{_art_style_hint}
  • base_prompt 字数不低于 60 个英文单词

- 人物 expression_prompts：为 normal/happy/sad/surprised/angry/shy/serious/hurt 每种表情输出完整 prompt（= base_prompt 全文 + 该表情的表情细节描述，如 "gentle smile, bright eyes, slightly raised corners of mouth"）；不同表情的 base 内容必须与 base_prompt 保持一致

- 人物 negative_prompt：bad anatomy, extra fingers, missing limbs, deformed body, multiple characters, duplicate, text, watermark, lowres, blurry, jpeg artifacts, bad proportions, out of frame

- 背景 prompt：必须 **16:9 widescreen cinematic landscape composition**，强调环境细节、光线、氛围、色调、远景中景前景层次；**绝对不能出现任何人物、人影、剪影**（在 prompt 末尾追加 "no people, no humans, no figures, no silhouettes"），并将这些词复制到 negative_prompt
- **bg_key 规则**：为每个场景分配一个简短的 bg_key（格式：英文地点_时段，如 office_night、bedroom_dawn、rooftop_evening），视觉效果完全相同的场景必须使用相同 bg_key；不同场景使用不同 bg_key；bg_key 相同意味着背景可复用
- CG prompt：vertical 9:16 portrait, 包含所有相关人物、互动动作、情绪、场景、电影构图；与背景不同，CG 允许并鼓励出现人物；**CG 严禁使用绿幕/纯色背景**，必须有真实丰富的场景环境（室内/户外/自然/建筑等），背景需有光线、氛围、深度细节
- negative_prompt：覆盖 lowres、blurry、bad anatomy、watermark、text、jpeg artifacts；背景额外加 person/people/humans；CG 额外加 green screen, chroma key, solid color background, plain background
- 所有 prompt 使用英文
- is_animatable=true 的 CG 应适合动态化（如飘落的樱花、闪烁的光效）"""

    user_chars = (
        f"故事大纲：\n{json.dumps(outline, ensure_ascii=False)}\n\n"
        f"导演艺术指导：\n{json.dumps(director_vision, ensure_ascii=False)}\n\n"
        "请生成所有人物（character_prompts）的详细绘图提示词，包含 base_prompt、"
        "negative_prompt 和 8 种表情的 expression_prompts。"
    )
    user_scenes = (
        f"故事大纲：\n{json.dumps(outline, ensure_ascii=False)}\n\n"
        f"导演艺术指导：\n{json.dumps(director_vision, ensure_ascii=False)}\n\n"
        "请生成所有背景（background_prompts）和 CG（cg_prompts）的详细绘图提示词。"
    )

    # 两次独立调用，避免单次输出超出模型 8192 token 上限
    client = _client_for_model(api_key, endpoint, model)
    char_result = await _call_tool(
        client, model, system, user_chars,
        CHARACTER_PROMPTS_SCHEMA, temperature=0.5, max_tokens=8192,
    )
    scene_result = await _call_tool(
        client, model, system, user_scenes,
        SCENE_PROMPTS_SCHEMA, temperature=0.5, max_tokens=8192,
    )

    return {
        "character_prompts": char_result.get("character_prompts", []),
        "background_prompts": scene_result.get("background_prompts", []),
        "cg_prompts": scene_result.get("cg_prompts", []),
    }


# ---------------------------------------------------------------------------
# Step 5 — 配音导演（可选）
# ---------------------------------------------------------------------------

async def generate_voice_direction(
    outline: Dict[str, Any],
    director_vision: Dict[str, Any],
    api_key: str,
    model: str,
    endpoint: Optional[str],
) -> Dict[str, str]:
    """配音导演：为每个角色生成 TTS 音色风格提示词。返回 {character_id: prompt}。"""
    char_designs = {
        (cd.get("character_id") or cd.get("char_id") or cd.get("id") or ""): cd
        for cd in director_vision.get("character_designs", [])
    }

    system = """你是配音导演，负责为视觉小说角色设计 TTS 语音风格提示词。

对于每个角色，输出适合传递给 TTS 模型的风格描述（英文），包含：
- 音色特征（如 warm, husky, bright, gentle, deep）
- 说话节奏（slow/moderate/fast）
- 情绪底色（如 slightly melancholic, cheerful, calm）
- 特殊说话习惯（如 tends to pause, speaks with emphasis）

返回 JSON：{"character_id": "voice style prompt", ...}"""

    chars_summary = []
    for i, char in enumerate(outline.get("characters", [])):
        if not isinstance(char, dict):
            continue
        cid = char.get("id") or char.get("char_id") or f"char_{i:03d}"
        char_name = (
            char.get("name") or char.get("character_name") or
            char.get("full_name") or f"角色{i+1}"
        )
        design = char_designs.get(cid, {})
        chars_summary.append(
            f"- {char_name} ({cid}): 性格={char.get('personality', '')}, "
            f"声音气质={design.get('voice_character', '')}, "
            f"年龄段={design.get('voice_age', 'adult')}, "
            f"语速={design.get('speaking_pace', 'moderate')}"
        )

    user = "角色信息：\n" + "\n".join(chars_summary)

    try:
        raw = await _call_json(
            _client_for_model(api_key, endpoint, model), model, system, user,
            temperature=0.6, max_tokens=1500,
        )
        # 规范化：确保返回 {char_id: str} 格式
        # 模型有时返回 {"character_name": "...", "voice_style_prompt": "..."}
        if raw and not any(isinstance(v, str) for v in raw.values()):
            logger.warning("配音导演输出格式异常，尝试规范化")
            return {}
        # 过滤掉值不是字符串的键
        normalized = {k: v for k, v in raw.items() if isinstance(v, str)}
        # 如果键名看起来不像 char_id（不含 char_ 前缀），尝试按顺序映射到大纲角色 ID
        char_ids = [c.get("id") or c.get("char_id") or f"char_{i:03d}"
                    for i, c in enumerate(outline.get("characters", []))
                    if isinstance(c, dict)]
        keys = list(normalized.keys())
        if keys and char_ids and not any(k in char_ids for k in keys):
            # 键名不匹配，按顺序重新映射
            remapped = {}
            for idx, (k, v) in enumerate(normalized.items()):
                cid = char_ids[idx] if idx < len(char_ids) else k
                remapped[cid] = v
            return remapped
        return normalized
    except Exception as e:
        logger.warning(f"配音导演生成失败: {e}")
        return {}


# ---------------------------------------------------------------------------
# Step 6 — 分镜师（全流程）
# ---------------------------------------------------------------------------

_DIALOGUE_ITEM = {
    "type": "object",
    "properties": {
        "id": {"type": "string"},
        "character_id": {"type": "string"},
        "text": {"type": "string"},
        "expression": {"type": "string"},
        "position": {"type": "string", "enum": ["left", "right", "center", "none"]},
        "action_note": {"type": "string"},
    },
    "required": ["id", "character_id", "text", "expression", "position"],
}

_CHOICE_ITEM = {
    "type": "object",
    "properties": {
        "id": {"type": "string"},
        "text": {"type": "string"},
        "next_scene_id": {"type": "string"},
        "consequence_hint": {"type": "string"},
    },
    "required": ["id", "text", "next_scene_id"],
}

_SCENE_ITEM = {
    "type": "object",
    "properties": {
        "id": {"type": "string"},
        "title": {"type": "string"},
        "background_description": {"type": "string"},
        "dialogues": {"type": "array", "items": _DIALOGUE_ITEM},
        "choices": {"type": "array", "items": _CHOICE_ITEM},
        "next_scene_id": {"type": "string"},
        "bgm_mood": {
            "type": "string",
            "enum": ["peaceful", "tense", "romantic", "mysterious",
                     "battle", "sad", "triumphant"],
        },
        "cg_trigger": {"type": "string"},
        "cg_after_dialogue": {"type": "string"},
    },
    "required": ["id", "title", "background_description", "dialogues",
                 "choices", "next_scene_id", "bgm_mood"],
}

STORYBOARD_SCHEMA = {
    "name": "generate_storyboard",
    "description": "分镜师（全流程）：生成每个场景的完整对话台词与玩家选项",
    "parameters": {
        "type": "object",
        "properties": {
            "scenes": {"type": "array", "items": _SCENE_ITEM},
        },
        "required": ["scenes"],
    },
}


# ---------------------------------------------------------------------------
# Step 6 辅助：多轮分镜师所需常量和工具
# ---------------------------------------------------------------------------

# 每轮生成的场景数上限（超过此数量自动切换为多轮模式）
_STORYBOARD_BATCH_SIZE = 3
_STORYBOARD_SINGLE_THRESHOLD = 4  # 场景数 <= 此值时使用单轮

# 批次生成的 Schema（与 STORYBOARD_SCHEMA 相同结构，名称不同以便区分）
STORYBOARD_BATCH_SCHEMA = {
    "name": "generate_storyboard_batch",
    "description": "分镜师（批次）：将当前批次的场景大纲展开为完整对话脚本",
    "parameters": {
        "type": "object",
        "properties": {
            "scenes": {"type": "array", "items": _SCENE_ITEM},
        },
        "required": ["scenes"],
    },
}


def _build_storyboard_system(branch_enabled: bool) -> str:
    """构建分镜师系统提示词。"""
    return (
        "你是视觉小说分镜师，负责将故事大纲展开为完整的场景对话脚本。\n\n"
        "原则：\n"
        "- 对话须忠实于人物性格和说话方式（参见大纲中的 speech_style）\n"
        "- 每个场景生成 8-12 条对话，重要高潮场景可达 15 条，确保剧情展开充分\n"
        "- 表情须符合对话情绪（normal/happy/sad/surprised/angry/shy/serious/hurt）\n"
        "- position：left/right/center=立绘位置，none=旁白\n"
        "- 旁白使用 character_id=\"narrator\"，position=\"none\"\n"
        + (
            "- 在 has_branch=true 的场景末尾提供 2-3 个有实质差异的选项\n"
            if branch_enabled
            else "- 所有 choices 为空数组\n"
        )
        + "- cg_trigger 填入对应的 cg_id（若有），cg_after_dialogue 填入触发对话 ID\n"
        "- background_description 使用执行导演提供的 prompt"
    )


async def generate_storyboard(
    outline: Dict[str, Any],
    director_vision: Dict[str, Any],
    image_prompts: Dict[str, Any],
    api_key: str,
    model: str,
    endpoint: Optional[str],
    depth: int = 2,
) -> List[Dict[str, Any]]:
    """
    分镜师（全流程）：逐场景独立调用，每个场景一次 API call。

    采用 json_object 模式避免 tool_call 在大上下文下参数截断问题。
    每个场景只携带精简角色参考 + 当前场景大纲，将输入 token 从 ~3000 降到 ~400。
    """
    # 防御 json_object fallback 可能用不同字段名（scenes / chapters / scene_list）
    scene_outlines = (
        outline.get("scene_outlines")
        or outline.get("scenes")
        or outline.get("chapters")
        or outline.get("scene_list")
        or []
    )
    if not scene_outlines:
        logger.error(
            f"大纲缺少场景数据！outline keys: {list(outline.keys())}，"
            f"scene_outlines={outline.get('scene_outlines')!r}, "
            f"scenes={outline.get('scenes')!r}"
        )
        raise ValueError(
            f"大纲缺少场景数据（scene_outlines 为空），已有字段：{list(outline.keys())}"
        )
    branch_enabled = any(so.get("has_branch") for so in scene_outlines)

    # 角色精简参考（只保留对话创作必要字段）
    # 使用 .get() 防御 json_object fallback 可能使用不同字段名的情况
    char_ref = [
        {
            "id": c.get("id") or c.get("char_id") or f"char_{i:03d}",
            "name": (
                c.get("name") or c.get("character_name") or
                c.get("full_name") or c.get("display_name") or f"角色{i+1}"
            ),
            "personality": c.get("personality", ""),
            "speech_style": c.get("speech_style", ""),
            "gender": c.get("gender", "neutral"),
        }
        for i, c in enumerate(outline.get("characters", []))
        if isinstance(c, dict)
    ]

    art_style = director_vision.get("global_art_style", "anime style")
    color_palette = director_vision.get("color_palette", "")

    bg_prompts = {
        bp["scene_id"]: bp.get("prompt", "")
        for bp in image_prompts.get("background_prompts", [])
        if isinstance(bp, dict) and bp.get("scene_id")
    }

    # 构建 scene_id → [cg_id, ...] 映射，供分镜师填入 cg_trigger
    cg_by_scene: dict = {}
    cg_prompt_map: dict = {}
    _cg_raw = image_prompts.get("cg_prompts") if isinstance(image_prompts, dict) else None
    if isinstance(_cg_raw, list):
        for cp in _cg_raw:
            if not isinstance(cp, dict):
                continue
            sid = cp.get("scene_id")
            cid = cp.get("cg_id") or cp.get("id")
            if sid and cid and isinstance(sid, str) and isinstance(cid, str):
                cg_by_scene.setdefault(sid, []).append(cid)
                cg_prompt_map[cid] = str(cp.get("prompt") or "")[:80]

    _storyboard_depth_style = {
        1: "台词直白表达情感，人物说出内心想法，不隐藏情绪，对话轻松自然。",
        2: "台词有基本层次感，人物情感通过言行自然流露，偶有言外之意。",
        3: "台词含蓄克制，人物常以行动或侧面描写暗示内心，留白供读者联想；"
           "旁白适时用隐喻传达情绪，不直接说破。",
        4: "台词多义，表面含义与潜台词并存；人物对话折射各自的价值观和创伤；"
           "旁白诗意而哲思，细节互相呼应前文伏笔。",
        5: "台词极度凝练，每句话都可多层解读；人物以只言片语暗含整个内心世界；"
           "旁白充满隐喻与象征，意在言外；对话结束后读者仍能长久回味其深意。",
    }
    _sb_depth_hint = _storyboard_depth_style.get(depth, _storyboard_depth_style[2])

    system = (
        "你是视觉小说分镜师，将单个场景大纲展开为完整对话脚本。\n\n"
        f"【叙事深度要求（{depth}/5）】：{_sb_depth_hint}\n\n"
        "规则：\n"
        "- 对话须忠实于人物性格和 speech_style，台词要有个性、情感丰富\n"
        "- **语言一致性**：台词和旁白必须与故事大纲（title/synopsis/人物名称）所使用的语言完全一致；大纲用中文则台词用中文，大纲用日语则台词用日语，大纲用英语则台词用英语\n"
        "- 每个场景生成 8-12 条对话，重要高潮场景（has_cg=true 或 mood=battle/triumphant）可达 15 条，确保剧情展开充分\n"
        "- 对话要有层次感：铺垫→发展→冲突/情感高峰→收尾，不能仅几句话结束\n"
        "- expression 枚举：normal / happy / sad / surprised / angry / shy / serious / hurt\n"
        "- position 枚举：left / right / center / none（none=旁白）\n"
        "- **角色位置强制固定**：每个场景的【位置固定映射】由 user 消息指定，严格按映射填写 position，全场景不得改变\n"
        "- 旁白使用 character_id=\"narrator\"，position=\"none\"\n"
        + (
            "- 在 has_branch=true 的场景末尾提供 2-3 个有实质差异的 choices\n"
            if branch_enabled
            else ""
        )
        + "- 只输出纯 JSON 对象，不包含 markdown 或解释\n"
        "- 必须包含字段：id、title、background_description、dialogues、choices、next_scene_id、bgm_mood\n"
        "- **CG 触发**：若 user 消息提供了【可用 CG 列表】，必须在最能体现该 CG 内容的对话之后触发：\n"
        "  · cg_trigger 字段填入对应的 cg_id（必须是【可用 CG 列表】中的 ID 之一，不能臆造）\n"
        "  · cg_after_dialogue 字段填入触发该 CG 的对话 id（如 dlg_001_05）\n"
        "  · 若本场景没有可用 CG 列表，cg_trigger 留空字符串"
    )

    client = _client_for_model(api_key, endpoint, model)
    all_scenes: List[Dict[str, Any]] = []
    failed_scene_ids: List[str] = []
    total = len(scene_outlines)

    for i, so in enumerate(scene_outlines):
        scene_id = so.get("id", f"scene_{i + 1:03d}")
        # Step 4 的专业 bg_prompts 优先级最高，分镜师生成的文字描述仅作兜底
        bg = bg_prompts.get(scene_id, "")
        chars_present = so.get("characters_present", [])
        scene_chars = (
            [c for c in char_ref if c["id"] in chars_present]
            if chars_present
            else char_ref
        )

        # 构建所有场景 ID 列表，便于 AI 在 choices 中引用正确 ID
        all_scene_ids = [s.get("id", f"scene_{j+1:03d}") for j, s in enumerate(scene_outlines)]
        next_scene_id_hint = all_scene_ids[i + 1] if i + 1 < len(all_scene_ids) else ""
        has_branch = so.get("has_branch", False)
        branch_hint = (
            f"\n当前场景是分支节点（has_branch=true），choices 中每个选项的 next_scene_id 必须使用以下真实场景 ID 之一：{all_scene_ids[i+1:]}"
            if has_branch and i + 1 < len(all_scene_ids) else ""
        )

        # 固定每个角色的 position，写进 user prompt 供 AI 严格遵守
        pos_map_parts = []
        for pi, sc in enumerate(scene_chars):
            pos = "left" if pi == 0 else ("right" if pi == 1 else "center")
            pos_map_parts.append(f"{sc['id']} → \"{pos}\"")
        pos_map_hint = "\n【位置固定映射（全场景严格遵守）】" + " | ".join(pos_map_parts) if pos_map_parts else ""

        # 当前场景的可用 CG 列表（来自 Step 4 cg_prompts），用于强制分镜师正确填写 cg_trigger
        scene_cgs = cg_by_scene.get(scene_id, [])
        cg_hint = ""
        if scene_cgs:
            cg_lines = "\n".join(f"  · {cid}：{cg_prompt_map.get(cid, '')}" for cid in scene_cgs)
            cg_hint = (
                f"\n【可用 CG 列表（必须从中选 1 个填入 cg_trigger）】\n{cg_lines}\n"
                "请选择剧情最高潮的对话 id 填入 cg_after_dialogue 字段。"
            )

        user = (
            f"角色参考：{json.dumps(scene_chars, ensure_ascii=False)}\n\n"
            f"所有场景 ID（按顺序）：{all_scene_ids}\n"
            f"当前场景大纲：\n{json.dumps(so, ensure_ascii=False)}\n\n"
            f"注意：请生成 8-12 条对话（高潮场景可达 15 条），确保剧情有铺垫、发展和情感高峰，台词充实生动。"
            f"{pos_map_hint}"
            f"{cg_hint}"
            f"{branch_hint}\n"
            f"next_scene_id 请使用：\"{next_scene_id_hint}\"（若是最后一场景则留空字符串）\n"
            "请输出单个场景 JSON（勿嵌套在列表中），格式：\n"
            '{"id": "scene_001", "title": "...", "background_description": "...", '
            '"dialogues": [{"id": "dlg_001_01", "character_id": "char_xxx", "text": "...", '
            '"expression": "normal", "position": "left"}], '
            '"choices": [], "next_scene_id": "scene_002", "bgm_mood": "peaceful", '
            '"cg_trigger": "", "cg_after_dialogue": ""}'
        )

        scene = None
        for attempt in range(3):
            try:
                # 重试时不提高 temperature（递增会加大格式崩溃风险），固定 0.8
                scene = await _call_json(
                    client, model, system, user, temperature=0.8, max_tokens=8192
                )
                if not isinstance(scene, dict):
                    logger.warning(f"分镜师 {i + 1}/{total} ({scene_id}) 返回非对象，重试(attempt {attempt+1})...")
                    scene = None
                    continue
                if not isinstance(scene.get("dialogues"), list) or not scene.get("dialogues"):
                    logger.warning(f"分镜师 {i + 1}/{total} ({scene_id}) 返回空对话，重试(attempt {attempt+1})...")
                    scene = None
                    continue
                scene["id"] = scene_id
                scene["title"] = scene.get("title") or so.get("title") or scene_id
                # Step 4 的 bg_prompts 始终优先，分镜师写的文字仅在 bg 为空时保留
                if bg:
                    scene["background_description"] = bg
                if not isinstance(scene.get("choices"), list):
                    scene["choices"] = []
                # 规范化 choices 字段名：AI 有时生成 option_text 而非 text
                for ch in scene["choices"]:
                    if isinstance(ch, dict) and "text" not in ch and "option_text" in ch:
                        ch["text"] = ch.pop("option_text")
                    if isinstance(ch, dict) and "brief_consequence" in ch and "consequence_hint" not in ch:
                        ch["consequence_hint"] = ch.pop("brief_consequence")
                scene["next_scene_id"] = scene.get("next_scene_id") or next_scene_id_hint
                scene["bgm_mood"] = scene.get("bgm_mood") or so.get("mood") or "peaceful"
                break
            except Exception as e:
                logger.warning(f"分镜师 {i + 1}/{total} ({scene_id}) 第{attempt+1}次失败: {e}，重试...")
        if scene:
            all_scenes.append(scene)
            logger.info(
                f"分镜师 {i + 1}/{total} ({scene_id}): "
                f"{len(scene.get('dialogues', []))} 条对话"
            )
        else:
            failed_scene_ids.append(scene_id)
            logger.error(f"分镜师 {i + 1}/{total} ({scene_id}) 3次重试后仍失败")

    logger.info(f"分镜师完成：共 {len(all_scenes)}/{total} 个场景")
    if failed_scene_ids or len(all_scenes) < total:
        failed_text = "、".join(failed_scene_ids[:8])
        if len(failed_scene_ids) > 8:
            failed_text += " 等"
        raise ValueError(
            f"分镜生成不完整：预期 {total} 个场景，实际 {len(all_scenes)} 个。"
            f"失败场景：{failed_text or '未知'}。已停止后续图片生成，请重试。"
        )
    return all_scenes







# ---------------------------------------------------------------------------
# Step 7 — 分镜师（流式）
# ---------------------------------------------------------------------------

STREAM_SEGMENT_SCHEMA = {
    "name": "generate_stream_segment",
    "description": "分镜师（流式）：根据玩家选择生成后续 1-2 个场景",
    "parameters": {
        "type": "object",
        "properties": {
            "scenes": {"type": "array", "items": _SCENE_ITEM},
            "is_ending": {"type": "boolean"},
            "ending": {
                "type": "object",
                "properties": {
                    "type": {"type": "string", "enum": ["good", "bad", "neutral"]},
                    "title": {"type": "string"},
                    "summary": {"type": "string"},
                },
            },
        },
        "required": ["scenes", "is_ending"],
    },
}


async def generate_stream_segment(
    outline: Dict[str, Any],
    director_vision: Dict[str, Any],
    history: List[Dict[str, Any]],
    player_input: Optional[str],
    chosen_scene_id: str,
    remaining_scenes: int,
    api_key: str,
    model: str,
    endpoint: Optional[str],
) -> Dict[str, Any]:
    """
    分镜师（流式）：基于剧情历史和玩家选择，动态生成后续场景。
    - history: 已完成场景列表（最近 5 个）
    - player_input: 玩家自由输入内容（流式模式特有）
    - chosen_scene_id: 玩家选择导向的场景 ID
    - remaining_scenes: 剩余需要生成的场景数（0=生成结局）
    """
    history_summary = [
        f"[{s.get('id')}] {s.get('title')}: {s.get('summary', '')}"
        for s in history[-5:]
    ]

    system = f"""你是视觉小说分镜师（流式模式），负责根据玩家选择实时生成剧情续集。

背景：剩余场景数={remaining_scenes}（0=本段为结局）

规则：
- 生成 1-2 个场景（remaining_scenes=0 时生成结局并 is_ending=true）
- 每场景 4-8 条对话
- 保持人物性格一致
- 若玩家有自由输入，合理融入剧情（不可完全脱离主线）
- 场景 ID 使用 scene_stream_XXX 格式"""

    player_action = f"\n玩家自由输入：{player_input}" if player_input else ""
    user = (
        f"故事大纲摘要：{outline.get('synopsis', '')}\n"
        f"已发生场景：{chr(10).join(history_summary)}\n"
        f"玩家选择导向：{chosen_scene_id}{player_action}\n\n"
        "请生成后续剧情段落。"
    )

    return await _call_tool(
        _client_for_model(api_key, endpoint, model), model, system, user,
        STREAM_SEGMENT_SCHEMA, temperature=0.9, max_tokens=4000,
    )


# ---------------------------------------------------------------------------
# 兼容旧接口
# ---------------------------------------------------------------------------

async def generate_script(
    prompt: str,
    story_spec: Dict[str, Any],
    api_key: str,
    model: str = "gpt-4o",
    endpoint: Optional[str] = None,
) -> Dict[str, Any]:
    """
    旧接口兼容层：单步生成完整剧本。
    内部调用新的多步流水线，将结果合并为旧格式。
    """
    target_scene_count = _target_scene_count(story_spec)
    outline = await generate_outline(prompt, story_spec, api_key, model, endpoint)
    outline = await validate_and_refine(
        outline, api_key, model, endpoint,
        target_scene_count=target_scene_count,
    )
    director = await generate_director_vision(outline, api_key, model, endpoint)
    image_prompts = await generate_image_prompts(outline, director, api_key, model, endpoint)
    scenes = await generate_storyboard(outline, director, image_prompts, api_key, model, endpoint)
    if len(scenes) < target_scene_count:
        raise ValueError(
            f"分镜生成不完整：预期至少 {target_scene_count} 个场景，实际 {len(scenes)} 个。"
        )

    return _build_script(outline, director, image_prompts, scenes)


def _build_script(
    outline: Dict[str, Any],
    director: Dict[str, Any],
    image_prompts: Dict[str, Any],
    scenes: List[Dict[str, Any]],
) -> Dict[str, Any]:
    """将各阶段输出合并为统一的剧本结构（供 orchestrator 使用）。"""
    char_designs = {
        (cd.get("character_id") or cd.get("char_id") or cd.get("id") or ""): cd
        for cd in director.get("character_designs", [])
        if isinstance(cd, dict)
    }
    char_prompts = {
        (cp.get("character_id") or cp.get("char_id") or cp.get("id") or ""): cp
        for cp in image_prompts.get("character_prompts", [])
        if isinstance(cp, dict)
    }

    characters = []
    for i, char in enumerate(outline.get("characters", [])):
        if not isinstance(char, dict):
            continue
        cid = char.get("id") or char.get("char_id") or f"char_{i:03d}"
        design = char_designs.get(cid, {})
        prompt_info = char_prompts.get(cid, {})
        characters.append({
            "id": cid,
            "name": (
                char.get("name") or char.get("character_name") or
                char.get("full_name") or char.get("display_name") or f"角色{i+1}"
            ),
            "description": char.get("background", ""),
            "personality": char.get("personality", ""),
            "speech_style": char.get("speech_style", ""),
            "gender": char.get("gender", "neutral"),
            "appearance": (
                f"{design.get('appearance_en', '')} {design.get('outfit_en', '')} "
                f"{design.get('makeup_en', '')}"
            ).strip(),
            "expressions": design.get("expressions", ["normal", "happy", "sad"]),
            "base_prompt": prompt_info.get("base_prompt", ""),
            "expression_prompts": prompt_info.get("expression_prompts", {}),
            "negative_prompt": prompt_info.get("negative_prompt", ""),
            "voice_character": design.get("voice_character", ""),
        })

    # 合并 characters_present：从大纲拷贝到分镜场景，前端立绘渲染依赖此字段
    outline_by_id: Dict[str, Dict[str, Any]] = {}
    for so in outline.get("scene_outlines", []) or []:
        if isinstance(so, dict):
            sid = so.get("id") or ""
            if sid:
                outline_by_id[sid] = so
    enriched_scenes: List[Dict[str, Any]] = []
    for sc in scenes or []:
        if not isinstance(sc, dict):
            continue
        sid = sc.get("id") or ""
        cp = sc.get("characters_present")
        if not cp:
            cp = (outline_by_id.get(sid) or {}).get("characters_present", []) or []
        # 兜底：若大纲也没填，则从该场景对话里抽出非旁白发言者
        if not cp:
            seen: List[str] = []
            for dlg in sc.get("dialogues", []) or []:
                if not isinstance(dlg, dict):
                    continue
                cid = dlg.get("character_id") or dlg.get("character") or ""
                if cid and cid.lower() != "narrator" and cid not in seen:
                    seen.append(cid)
            cp = seen[:2]  # 最多两人对话布局
        sc["characters_present"] = cp
        enriched_scenes.append(sc)

    return {
        "title": outline.get("title", ""),
        "genre": outline.get("genre", ""),
        "theme": outline.get("theme", ""),
        "synopsis": outline.get("synopsis", ""),
        "user_art_style": outline.get("user_art_style", ""),
        "global_style": director.get("global_art_style", "anime style"),
        "color_palette": director.get("color_palette", ""),
        "lighting_style": director.get("lighting_style", ""),
        "characters": characters,
        "scenes": enriched_scenes,
        "cg_prompts": image_prompts.get("cg_prompts", []),
        "ending": outline.get("ending", {}),
        "director_vision": director,
        "image_prompts": image_prompts,
    }
