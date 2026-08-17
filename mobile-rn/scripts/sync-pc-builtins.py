from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import yaml


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
SKILLS_DIR = REPOSITORY_ROOT / "backend" / "app" / "skills"
AGENTS_DIR = REPOSITORY_ROOT / "backend" / "app" / "prompts" / "builtin-agents"
OUTPUT_PATH = REPOSITORY_ROOT / "mobile-rn" / "src" / "settings" / "builtin-catalog.json"
MOBILE_AGENT_TEXT_REPLACEMENTS = {
    "来自OpenFic的高级AI Agent": "来自OpenFicM的高级AI Agent",
    "OpenFic是一款原生Agent集成的Vibe Writing工具": "OpenFicM是一款原生Agent集成的Vibe Writing工具",
    "https://github.com/syrizelink/OpenFic/issues": "https://github.com/tioners/OpenFicM/issues",
}

AGENT_METADATA = (
    {
        "key": "build",
        "name": "Build",
        "description": "默认主智能体，执行通用写作任务并调度子智能体协作。",
        "kind": "primary",
        "delegatable": ("explore", "composer", "auditor", "writer", "actor", "reviewer"),
    },
    {
        "key": "plan",
        "name": "Plan",
        "description": "专注规划、协调、审查与交付，组织子智能体完成系统写作。",
        "kind": "primary",
        "delegatable": ("explore", "composer", "auditor", "writer", "actor", "reviewer"),
    },
    {
        "key": "explore",
        "name": "Explore",
        "description": "负责信息搜集、上下文梳理与证据查找。",
        "kind": "subagent",
        "delegatable": (),
    },
    {
        "key": "composer",
        "name": "Composer",
        "description": "负责剧情设计、结构规划与写作方案组织。",
        "kind": "subagent",
        "delegatable": (),
    },
    {
        "key": "auditor",
        "name": "Auditor",
        "description": "负责审查计划，指出问题并提出修正建议。",
        "kind": "subagent",
        "delegatable": (),
    },
    {
        "key": "writer",
        "name": "Writer",
        "description": "负责章节内容撰写、补写与正文修改。",
        "kind": "subagent",
        "delegatable": (),
    },
    {
        "key": "actor",
        "name": "Actor",
        "description": "负责按既定目标执行修改并推进具体动作。",
        "kind": "subagent",
        "delegatable": (),
    },
    {
        "key": "reviewer",
        "name": "Reviewer",
        "description": "负责审查写作内容，指出问题并提出修正建议。",
        "kind": "subagent",
        "delegatable": (),
    },
)

READ_TOOL_NAMES = (
    "list_chapters",
    "read_chapter",
    "search_chapters",
    "search_knowledge",
    "list_characters",
    "read_character",
    "list_world_entries",
    "read_world_entry",
    "ask_user",
    "activate_skill",
)
CHAPTER_WRITE_TOOL_NAMES = ("write_chapter", "edit_chapter")
CHARACTER_WRITE_TOOL_NAMES = ("create_character", "edit_character", "delete_character")
WORLD_WRITE_TOOL_NAMES = ("create_world_entry", "edit_world_entry", "delete_world_entry")
AGENT_TOOL_NAMES = {
    "build": (*READ_TOOL_NAMES, *CHAPTER_WRITE_TOOL_NAMES, *CHARACTER_WRITE_TOOL_NAMES, *WORLD_WRITE_TOOL_NAMES, "delegate_agent"),
    "plan": (*READ_TOOL_NAMES, "delegate_agent"),
    "explore": READ_TOOL_NAMES,
    "composer": (*READ_TOOL_NAMES, *CHARACTER_WRITE_TOOL_NAMES, *WORLD_WRITE_TOOL_NAMES),
    "auditor": READ_TOOL_NAMES,
    "writer": (*READ_TOOL_NAMES, *CHAPTER_WRITE_TOOL_NAMES),
    "actor": (*READ_TOOL_NAMES, *CHAPTER_WRITE_TOOL_NAMES, *CHARACTER_WRITE_TOOL_NAMES, *WORLD_WRITE_TOOL_NAMES),
    "reviewer": READ_TOOL_NAMES,
}


def load_mapping(path: Path) -> dict[str, Any]:
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"{path} must contain a YAML mapping")
    return data


def required_text(data: dict[str, Any], key: str, path: Path) -> str:
    value = data.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{path}: {key} must be a non-empty string")
    return value.strip()


def adapt_agent_content(content: str) -> str:
    for source, replacement in MOBILE_AGENT_TEXT_REPLACEMENTS.items():
        content = content.replace(source, replacement)
    return content


def load_skills() -> list[dict[str, Any]]:
    skills: list[dict[str, Any]] = []
    for path in sorted(SKILLS_DIR.glob("*.yaml")):
        data = load_mapping(path)
        skill_id = required_text(data, "id", path)
        if not skill_id.startswith("builtin-skill--"):
            raise ValueError(f"{path}: invalid built-in skill id")
        instructions = required_text(data, "content", path)
        references = data.get("references", [])
        if not isinstance(references, list):
            raise ValueError(f"{path}: references must be a list")
        for reference in references:
            if not isinstance(reference, dict):
                raise ValueError(f"{path}: each reference must be a mapping")
            reference_name = required_text(reference, "name", path)
            reference_content = required_text(reference, "content", path)
            instructions += f"\n\n# 参考资料：{reference_name}\n\n{reference_content}"
        skills.append(
            {
                "id": skill_id,
                "name": required_text(data, "name", path),
                "description": required_text(data, "summary", path),
                "instructions": instructions,
                "enabled": data.get("is_enabled", True) is not False,
                "source": "builtin",
            }
        )
    return skills


def load_agents(skill_ids: list[str]) -> list[dict[str, Any]]:
    agents: list[dict[str, Any]] = []
    for metadata in AGENT_METADATA:
        key = str(metadata["key"])
        path = AGENTS_DIR / f"{key}.yaml"
        data = load_mapping(path)
        entries = data.get("entries")
        if not isinstance(entries, list) or not entries:
            raise ValueError(f"{path}: entries must be a non-empty list")
        enabled_entries: list[tuple[int, str]] = []
        for entry in entries:
            if not isinstance(entry, dict):
                raise ValueError(f"{path}: each entry must be a mapping")
            if entry.get("is_enabled", True) is False:
                continue
            if entry.get("role", "system") != "system":
                raise ValueError(f"{path}: mobile built-ins only support system entries")
            content = adapt_agent_content(required_text(entry, "content", path))
            order = entry.get("order_index", 0)
            if not isinstance(order, int):
                raise ValueError(f"{path}: order_index must be an integer")
            enabled_entries.append((order, content))
        enabled_entries.sort(key=lambda item: item[0])
        delegatable = [f"builtin-agent--{item}" for item in metadata["delegatable"]]
        agents.append(
            {
                "id": f"builtin-agent--{key}",
                "name": metadata["name"],
                "description": metadata["description"],
                "systemPrompt": "\n\n".join(content for _, content in enabled_entries),
                "modelId": "",
                "kind": metadata["kind"],
                "skillIds": skill_ids,
                "toolNames": list(AGENT_TOOL_NAMES[key]),
                "delegatableAgentIds": delegatable,
                "enabled": True,
                "source": "builtin",
            }
        )
    return agents


def main() -> None:
    skills = load_skills()
    catalog = {
        "generatedFrom": "backend/app/skills and backend/app/prompts/builtin-agents",
        "skills": skills,
        "agents": load_agents([skill["id"] for skill in skills]),
    }
    OUTPUT_PATH.write_text(
        json.dumps(catalog, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"wrote {len(catalog['skills'])} skills and {len(catalog['agents'])} agents to {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
