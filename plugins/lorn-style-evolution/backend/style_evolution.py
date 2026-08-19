"""Author-style evolution endpoint for the isolated Lorn style plugin.

The plugin talks only to an OpenAI-compatible chat-completions endpoint. It does
not import or modify any oh-story content and never logs the configured API key.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from urllib.parse import urlparse

import httpx
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field


MAX_TEXT_CHARACTERS = 120_000
REQUEST_TIMEOUT_SECONDS = 120.0


class StyleEvolutionRequest(BaseModel):
    ai_draft: str = Field(min_length=1)
    author_revision: str = Field(min_length=1)
    current_style_guide: str = ""


class StyleEvolutionResponse(BaseModel):
    style_guide: str


class StyleEvolutionError(RuntimeError):
    """A safe, user-facing error raised by the style evolution integration."""


@dataclass(frozen=True)
class LlmConfig:
    base_url: str
    api_key: str
    model: str


def _clip(value: str) -> str:
    value = value.strip()
    if len(value) > MAX_TEXT_CHARACTERS:
        raise StyleEvolutionError(f"输入文本超过 {MAX_TEXT_CHARACTERS} 字符限制")
    return value


def _config() -> LlmConfig:
    base_url = os.getenv("OPENFICM_STYLE_API_BASE_URL", "").strip().rstrip("/")
    api_key = os.getenv("OPENFICM_STYLE_API_KEY", "").strip()
    model = os.getenv("OPENFICM_STYLE_MODEL", "").strip()
    parsed = urlparse(base_url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise StyleEvolutionError("未配置有效的 OPENFICM_STYLE_API_BASE_URL")
    if not api_key:
        raise StyleEvolutionError("未配置 OPENFICM_STYLE_API_KEY")
    if not model:
        raise StyleEvolutionError("未配置 OPENFICM_STYLE_MODEL")
    return LlmConfig(base_url=base_url, api_key=api_key, model=model)


def _endpoint(base_url: str) -> str:
    return base_url if base_url.endswith("/chat/completions") else f"{base_url}/chat/completions"


def _evolution_prompt(ai_draft: str, author_revision: str, current_style_guide: str) -> str:
    return f"""请比较下面的 AI 原稿与作者定稿，提取作者在修改中稳定表现出的文风偏好，并更新现有的作者专属文风约束指南。

必须具体分析：
1. 作者增加、删除或替换了哪些词汇、表达和叙述动作；区分偶然修改与可重复的词汇偏好。
2. 作者偏好长句还是短句，句子连接、段落节奏和信息密度发生了什么变化。
3. 对话风格如何改变，包括称呼、语气、潜台词、对白长度和角色区分度。
4. 感官描写、比喻修辞、情绪表达、叙事视角和去 AI 味规则是否出现可证实的新倾向。

只依据两份文本的差异，不猜测作者没有展示的偏好。样本不足时明确写“样本不足”，不要把单次修改提升为硬规则。不得复制任一文本的大段原句，不生成新的小说正文。

当前文风约束指南：
<current_style_guide>
{current_style_guide or "暂无现有指南，请从本次差异建立初版指南"}
</current_style_guide>

AI 原稿：
<ai_draft>
{ai_draft}
</ai_draft>

作者定稿：
<author_revision>
{author_revision}
</author_revision>

只输出更新后的 Markdown《作者专属文风约束指南》，至少包含：样本与置信度、词汇偏好、句长与节奏、对话风格、感官与修辞、禁忌与去 AI 味、可直接注入 Agent 的约束、待确认项。
"""


def _response_content(payload: object) -> str:
    if not isinstance(payload, dict):
        raise StyleEvolutionError("模型服务返回的数据格式无效")
    choices = payload.get("choices")
    if not isinstance(choices, list) or not choices or not isinstance(choices[0], dict):
        raise StyleEvolutionError("模型服务没有返回 choices")
    message = choices[0].get("message")
    if not isinstance(message, dict) or not isinstance(message.get("content"), str):
        raise StyleEvolutionError("模型服务没有返回文本结果")
    content = message["content"].strip()
    if not content:
        raise StyleEvolutionError("模型服务返回了空的文风指南")
    if len(content) > MAX_TEXT_CHARACTERS:
        raise StyleEvolutionError(f"模型服务返回的文风指南超过 {MAX_TEXT_CHARACTERS} 字符限制")
    return content


def evolve_author_style(ai_draft: str, author_revision: str, current_style_guide: str) -> str:
    """Compare an AI draft with the author's revision and return an updated guide."""

    draft = _clip(ai_draft)
    revision = _clip(author_revision)
    guide = _clip(current_style_guide)
    config = _config()
    payload = {
        "model": config.model,
        "temperature": 0.2,
        "messages": [
            {
                "role": "system",
                "content": "你是严谨的中文文风编辑，只输出可执行的 Markdown 文风约束指南。",
            },
            {"role": "user", "content": _evolution_prompt(draft, revision, guide)},
        ],
    }
    try:
        with httpx.Client(timeout=REQUEST_TIMEOUT_SECONDS) as client:
            response = client.post(
                _endpoint(config.base_url),
                headers={"Authorization": f"Bearer {config.api_key}", "Content-Type": "application/json"},
                json=payload,
            )
    except httpx.TimeoutException as error:
        raise StyleEvolutionError("文风进化请求超时") from error
    except httpx.HTTPError as error:
        raise StyleEvolutionError("无法连接文风进化模型服务") from error

    if response.status_code >= 400:
        detail = response.text[:500].strip() or response.reason_phrase
        raise StyleEvolutionError(f"文风进化模型服务返回 HTTP {response.status_code}: {detail}")
    try:
        data = response.json()
    except ValueError as error:
        raise StyleEvolutionError("文风进化模型服务返回了无法解析的 JSON") from error
    return _response_content(data)


app = FastAPI(title="OpenFicM Lorn Style Evolution")


@app.post("/evolve-author-style", response_model=StyleEvolutionResponse)
def evolve_author_style_endpoint(request: StyleEvolutionRequest) -> StyleEvolutionResponse:
    try:
        return StyleEvolutionResponse(
            style_guide=evolve_author_style(
                request.ai_draft,
                request.author_revision,
                request.current_style_guide,
            ),
        )
    except StyleEvolutionError as error:
        raise HTTPException(status_code=502, detail=str(error)) from error
