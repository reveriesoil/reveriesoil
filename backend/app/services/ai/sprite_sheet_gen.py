"""
sprite_sheet_gen.py — 单次调用生成多表情 sprite sheet 后切分立绘（开源版）

用途：
  传统流程 N 角色 × M 表情 = N×M 次图像 API 调用，且每次表情独立生成
  极易出现脸型/发色/服饰漂移。本模块改为：
    - 单角色一次调用生成 1×K 横向 strip（K ≤ 4），单元间用黑线分隔
    - 接收图像后等宽切分成 K 张子图
    - 每张子图独立调 matting.cutout_portrait 抠掉绿幕背景

约束：
  - 仅适用于支持高分辨率（≥3686400 像素）+ 强一致性的先进模型
    （Doubao Seedream 5.0 已实测）
  - K=4 时 size = 4096x2048，每格 1024x2048
  - K=3 时 size = 3072x2048，每格 1024x2048
  - K=2 时 size = 2048x2048，每格 1024x2048
  - K=1 时直接降级走 seedream5_gen.generate_portrait
"""

from __future__ import annotations

import asyncio
import io
import logging
from typing import Dict, List

from PIL import Image

from app.services.ai.seedream5_gen import _generate as _seedream_generate

logger = logging.getLogger(__name__)


_CELL_W = 1024
_CELL_H = 2048
_MAX_CELLS = 4

_EXPRESSION_MAP = {
    "normal":    "calm and natural expression",
    "happy":     "gentle smile with bright eyes",
    "sad":       "sad expression with tearful eyes",
    "surprised": "wide-open eyes and slightly opened mouth, surprised",
    "angry":     "furrowed brows and sharp gaze, angry",
    "shy":       "blushing cheeks and shy smile, eyes slightly averted",
    "serious":   "serious expression with determined gaze",
    "hurt":      "painful expression with teary eyes",
}


def _build_sheet_prompt(
    character_appearance: str,
    expressions: List[str],
    global_style: str,
) -> str:
    n = len(expressions)
    expr_lines: List[str] = []
    for i, expr in enumerate(expressions, 1):
        desc = _EXPRESSION_MAP.get(expr, expr)
        expr_lines.append(f"  cell {i} (left to right): {desc}")
    expr_block = "\n".join(expr_lines)

    return (
        f"masterpiece, best quality, highres, ultra detailed character sheet. "
        f"A single anime-style character drawn {n} times in a 1-row × {n}-column grid. "
        f"The same character appears in every cell with IDENTICAL face, hair, eye color, outfit, body proportions and skin tone — "
        f"only the facial expression and slight pose differ between cells.\n"
        f"Character description: {character_appearance}.\n"
        f"Expression order from LEFT to RIGHT:\n{expr_block}\n"
        f"Layout rules (CRITICAL): "
        f"divide the canvas into exactly {n} EQUAL vertical cells separated by SOLID BLACK vertical lines, 10 pixels wide. "
        f"In EACH cell, draw ONE full-body standing character, fully centered, "
        f"with at least 8% safety margin to the cell's left, right, top and bottom edges — "
        f"NO body part (head, hair, hands, feet, clothing) may touch or cross the cell border or the canvas border. "
        f"Each character must be a complete figure with feet visible at the bottom of the cell.\n"
        f"Background: pure solid green chroma key #00FF00 in every cell, no shadows or gradients on background, no props, no text, no watermark.\n"
        f"Style: {global_style}, cel shading, clean line art, vibrant colors."
    )


def _split_sheet(image_bytes: bytes, n_cells: int) -> List[bytes]:
    img = Image.open(io.BytesIO(image_bytes)).convert("RGB")
    w, h = img.size
    cell_w = w // n_cells
    out: List[bytes] = []
    for i in range(n_cells):
        x0 = i * cell_w
        x1 = w if i == n_cells - 1 else (i + 1) * cell_w
        inset = 8
        l = x0 + inset if i > 0 else x0
        r = x1 - inset if i < n_cells - 1 else x1
        cell = img.crop((l, 0, r, h))
        buf = io.BytesIO()
        cell.save(buf, format="PNG")
        out.append(buf.getvalue())
    return out


async def generate_portrait_sprite_sheet(
    api_key: str,
    character_appearance: str,
    expressions: List[str],
    global_style: str,
    model_id: str,
) -> Dict[str, bytes]:
    expressions = [e for e in expressions if e]
    if not expressions:
        return {}
    if len(expressions) > _MAX_CELLS:
        logger.warning(
            f"sprite_sheet expressions={len(expressions)} 超过单批上限 {_MAX_CELLS}，截断"
        )
        expressions = expressions[:_MAX_CELLS]

    n = len(expressions)
    width = _CELL_W * n
    size = f"{width}x{_CELL_H}"
    prompt = _build_sheet_prompt(character_appearance, expressions, global_style)

    logger.info(
        f"[sprite_sheet] model={model_id} size={size} expressions={expressions} "
        f"appearance={character_appearance[:40]}"
    )
    sheet_bytes = await _seedream_generate(
        api_key=api_key,
        prompt=prompt,
        size=size,
        output_format=None,
        model_id=model_id,
    )
    cells = _split_sheet(sheet_bytes, n)

    from app.services.ai.matting import cutout_portrait
    out: Dict[str, bytes] = {}
    for expr, cell_bytes in zip(expressions, cells):
        try:
            png = await asyncio.to_thread(cutout_portrait, cell_bytes)
            out[expr] = png
        except Exception as e:
            logger.warning(f"[sprite_sheet] 单元抠图失败 expr={expr}: {e}")
            out[expr] = cell_bytes
    return out


def chunk_expressions(expressions: List[str], chunk: int = _MAX_CELLS) -> List[List[str]]:
    expressions = [e for e in expressions if e]
    return [expressions[i:i + chunk] for i in range(0, len(expressions), chunk)]
