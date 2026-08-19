import {
  createChapter,
  deleteCharacter,
  deleteWorldInfoEntry,
  getCharacter,
  getChapter,
  getOrCreateWorldInfo,
  getWorldInfoEntry,
  listChapters,
  listCharacters,
  listVolumes,
  listWorldInfoEntries,
  saveCharacter,
  saveChapter,
  saveWorldInfoEntry,
  searchChapters,
} from "@/data/repositories";
import type { AgentToolDefinition } from "@/llm/types";
import { searchProjectKnowledge } from "@/search/indexer";
import { getAuthorStyleGuide, saveAuthorStyleGuide } from "@/settings/lorn-style-plugin";

export const agentTools: AgentToolDefinition[] = [
  {
    name: "list_chapters",
    description: "列出当前项目的章节",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
  },
  {
    name: "read_chapter",
    description: "读取指定章节的完整正文",
    parameters: {
      type: "object",
      properties: { chapter_id: { type: "string", description: "章节 ID" } },
      required: ["chapter_id"],
      additionalProperties: false,
    },
  },
  {
    name: "search_chapters",
    description: "在当前项目的章节标题和正文中搜索",
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "搜索关键词" } },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "search_knowledge",
    description: "使用手机内置嵌入和重排模型，在章节、角色与世界书中进行语义检索",
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "要检索的问题或情节描述" } },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "list_characters",
    description: "列出当前项目的角色",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
  },
  {
    name: "read_character",
    description: "读取指定角色的完整设定",
    parameters: {
      type: "object",
      properties: { character_id: { type: "string", description: "角色 ID" } },
      required: ["character_id"],
      additionalProperties: false,
    },
  },
  {
    name: "list_world_entries",
    description: "列出当前项目中启用的世界书条目",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
  },
  {
    name: "read_world_entry",
    description: "读取指定世界书条目的完整内容",
    parameters: {
      type: "object",
      properties: { entry_id: { type: "string", description: "世界书条目 ID" } },
      required: ["entry_id"],
      additionalProperties: false,
    },
  },
  {
    name: "ask_user",
    description: "在关键偏好或需求存在歧义、不同答案会显著改变创作结果时，向用户提出一至三个互不依赖的问题。界面会自动提供自行输入答案，不要添加其它或类似兜底选项",
    parameters: {
      type: "object",
      properties: {
        questions: {
          type: "array",
          description: "互不依赖的问题列表",
          items: {
            type: "object",
            properties: {
              title: { type: "string", description: "简洁、完整的问题" },
              description: { type: "string", description: "必要的背景或影响说明" },
              options: {
                type: "array",
                description: "可选建议；推荐项放在首位并在标签后注明（推荐）",
                items: {
                  type: "object",
                  properties: {
                    label: { type: "string", description: "选项显示文本" },
                    description: { type: "string", description: "该选项的影响或取舍" },
                  },
                  required: ["label", "description"],
                  additionalProperties: false,
                },
              },
            },
            required: ["title", "description", "options"],
            additionalProperties: false,
          },
        },
      },
      required: ["questions"],
      additionalProperties: false,
    },
  },
  {
    name: "activate_skill",
    description: "按名称加载一个已启用技能的完整专业指令；任务符合技能说明时应先调用",
    parameters: {
      type: "object",
      properties: { skill_name: { type: "string", description: "可用技能列表中的完整名称" } },
      required: ["skill_name"],
      additionalProperties: false,
    },
  },
  {
    name: "delegate_agent",
    description: "把自包含任务委派给当前主智能体允许的一个子智能体，并返回其执行结果",
    parameters: {
      type: "object",
      properties: {
        agent_id: { type: "string", description: "可委派子智能体列表中的 ID" },
        task: { type: "string", description: "包含目标、上下文、交付物和限制的完整任务" },
      },
      required: ["agent_id", "task"],
      additionalProperties: false,
    },
  },
  {
    name: "read_author_style_guide",
    description: "读取当前作品保存的作者专属文风约束指南",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
  },
  {
    name: "save_author_style_guide",
    description: "保存或替换当前作品的完整作者专属文风约束指南",
    parameters: {
      type: "object",
      properties: { guide: { type: "string", description: "完整 Markdown 文风约束指南" } },
      required: ["guide"],
      additionalProperties: false,
    },
  },
  {
    name: "evolve_author_style",
    description: "对比 AI 原稿和作者定稿，通过 Lorn 插件服务或当前模型更新并保存作者文风指南",
    parameters: {
      type: "object",
      properties: {
        ai_draft: { type: "string", description: "AI 生成的原稿" },
        author_revision: { type: "string", description: "作者修改后的定稿" },
      },
      required: ["ai_draft", "author_revision"],
      additionalProperties: false,
    },
  },
  {
    name: "create_character",
    description: "根据当前作品新出现或确认的设定创建角色",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "角色名称" },
        description: { type: "string", description: "完整角色设定" },
      },
      required: ["name", "description"],
      additionalProperties: false,
    },
  },
  {
    name: "edit_character",
    description: "根据正文或设定变化更新已有角色；调用前先读取角色，至少提供 name 或 description",
    parameters: {
      type: "object",
      properties: {
        character_id: { type: "string", description: "角色 ID" },
        name: { type: "string", description: "更新后的角色名称" },
        description: { type: "string", description: "更新后的完整角色设定" },
      },
      required: ["character_id"],
      additionalProperties: false,
    },
  },
  {
    name: "delete_character",
    description: "删除当前作品中的角色，仅在用户明确要求时调用",
    parameters: {
      type: "object",
      properties: { character_id: { type: "string", description: "角色 ID" } },
      required: ["character_id"],
      additionalProperties: false,
    },
  },
  {
    name: "create_world_entry",
    description: "根据当前作品新出现或确认的设定创建世界书条目",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "条目标题" },
        content: { type: "string", description: "完整设定内容" },
      },
      required: ["title", "content"],
      additionalProperties: false,
    },
  },
  {
    name: "edit_world_entry",
    description: "根据正文或设定变化更新世界书条目；调用前先读取条目，至少提供 title 或 content",
    parameters: {
      type: "object",
      properties: {
        entry_id: { type: "string", description: "世界书条目 ID" },
        title: { type: "string", description: "更新后的条目标题" },
        content: { type: "string", description: "更新后的完整设定内容" },
      },
      required: ["entry_id"],
      additionalProperties: false,
    },
  },
  {
    name: "delete_world_entry",
    description: "删除当前作品中的世界书条目，仅在用户明确要求时调用",
    parameters: {
      type: "object",
      properties: { entry_id: { type: "string", description: "世界书条目 ID" } },
      required: ["entry_id"],
      additionalProperties: false,
    },
  },
  {
    name: "write_chapter",
    description: "在当前项目中创建新章节",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string" },
        content: { type: "string" },
        volume_id: { type: "string", description: "可选的卷 ID" },
      },
      required: ["title", "content"],
      additionalProperties: false,
    },
  },
  {
    name: "edit_chapter",
    description: "修改已有章节标题或正文",
    parameters: {
      type: "object",
      properties: {
        chapter_id: { type: "string" },
        title: { type: "string" },
        content: { type: "string" },
      },
      required: ["chapter_id"],
      additionalProperties: false,
    },
  },
];

function requiredString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`缺少参数 ${key}`);
  return value;
}

export async function executeAgentTool(
  projectId: string,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (name === "list_chapters") {
    const chapters = await listChapters(projectId);
    return { chapters: chapters.map(({ id, title, volumeId, orderIndex, updatedAt }) => ({ id, title, volumeId, orderIndex, updatedAt })) };
  }
  if (name === "read_chapter") {
    const chapter = await getChapter(requiredString(args, "chapter_id"));
    if (!chapter || chapter.projectId !== projectId) throw new Error("未找到章节");
    return { chapter };
  }
  if (name === "search_chapters") {
    const chapters = await searchChapters(projectId, requiredString(args, "query"));
    return { results: chapters.map((chapter) => ({ id: chapter.id, title: chapter.title, excerpt: chapter.content.slice(0, 500) })) };
  }
  if (name === "search_knowledge") {
    const results = await searchProjectKnowledge(projectId, requiredString(args, "query"));
    return {
      results: results.map((result) => ({
        source_type: result.sourceType,
        source_id: result.sourceId,
        title: result.title,
        content: result.content,
        score: result.rerankScore ?? result.score,
      })),
    };
  }
  if (name === "list_characters") {
    const characters = await listCharacters(projectId);
    return {
      characters: characters.map(({ id, name, description, isFavorited, updatedAt }) => ({
        id,
        name,
        description: description.slice(0, 300),
        is_favorited: isFavorited,
        updated_at: updatedAt,
      })),
    };
  }
  if (name === "read_character") {
    const character = await getCharacter(requiredString(args, "character_id"));
    if (!character || character.projectId !== projectId) throw new Error("未找到角色");
    return { character };
  }
  if (name === "list_world_entries") {
    const worldInfo = await getOrCreateWorldInfo(projectId);
    const entries = await listWorldInfoEntries(worldInfo.id);
    return {
      world_info: { id: worldInfo.id, name: worldInfo.name, description: worldInfo.description },
      entries: entries.filter((entry) => entry.isEnabled).map(({ id, uid, name, tokenCount, updatedAt }) => ({
        id,
        uid,
        name,
        token_count: tokenCount,
        updated_at: updatedAt,
      })),
    };
  }
  if (name === "read_world_entry") {
    const entry = await getWorldInfoEntry(requiredString(args, "entry_id"));
    if (!entry) throw new Error("未找到世界书条目");
    const worldInfo = await getOrCreateWorldInfo(projectId);
    if (entry.worldInfoId !== worldInfo.id) throw new Error("未找到世界书条目");
    return { entry };
  }
  if (name === "read_author_style_guide") {
    const guide = await getAuthorStyleGuide(projectId);
    return { guide, exists: Boolean(guide) };
  }
  if (name === "save_author_style_guide") {
    const guide = requiredString(args, "guide");
    await saveAuthorStyleGuide(projectId, guide);
    return { success: true, guide_characters: guide.trim().length };
  }
  if (name === "create_character") {
    const characterName = requiredString(args, "name");
    const existing = await listCharacters(projectId);
    if (existing.some((character) => character.name === characterName.trim())) throw new Error("角色名称已存在");
    const character = await saveCharacter({
      projectId,
      name: characterName,
      description: requiredString(args, "description"),
    });
    return { success: true, character_id: character.id, name: character.name };
  }
  if (name === "edit_character") {
    const character = await getCharacter(requiredString(args, "character_id"));
    if (!character || character.projectId !== projectId) throw new Error("未找到角色");
    const hasName = typeof args.name === "string";
    const hasDescription = typeof args.description === "string";
    if (!hasName && !hasDescription) throw new Error("至少需要提供 name 或 description");
    const nextName = hasName ? requiredString(args, "name") : character.name;
    if (nextName !== character.name) {
      const existing = await listCharacters(projectId);
      if (existing.some((item) => item.id !== character.id && item.name === nextName.trim())) throw new Error("角色名称已存在");
    }
    const updated = await saveCharacter({
      id: character.id,
      projectId,
      name: nextName,
      description: hasDescription ? args.description as string : character.description,
      imagePath: character.imagePath,
      isFavorited: character.isFavorited,
    });
    return { success: true, character_id: updated.id, name: updated.name };
  }
  if (name === "delete_character") {
    const character = await getCharacter(requiredString(args, "character_id"));
    if (!character || character.projectId !== projectId) throw new Error("未找到角色");
    await deleteCharacter(character.id);
    return { success: true, character_id: character.id, name: character.name };
  }
  if (name === "create_world_entry") {
    const worldInfo = await getOrCreateWorldInfo(projectId);
    const title = requiredString(args, "title");
    const existing = await listWorldInfoEntries(worldInfo.id);
    if (existing.some((entry) => entry.name === title.trim())) throw new Error("世界书条目标题已存在");
    const entry = await saveWorldInfoEntry({
      worldInfoId: worldInfo.id,
      name: title,
      content: requiredString(args, "content"),
    });
    return { success: true, entry_id: entry.id, title: entry.name };
  }
  if (name === "edit_world_entry") {
    const entry = await getWorldInfoEntry(requiredString(args, "entry_id"));
    if (!entry) throw new Error("未找到世界书条目");
    const worldInfo = await getOrCreateWorldInfo(projectId);
    if (entry.worldInfoId !== worldInfo.id) throw new Error("未找到世界书条目");
    const hasTitle = typeof args.title === "string";
    const hasContent = typeof args.content === "string";
    if (!hasTitle && !hasContent) throw new Error("至少需要提供 title 或 content");
    const nextTitle = hasTitle ? requiredString(args, "title") : entry.name;
    if (nextTitle !== entry.name) {
      const existing = await listWorldInfoEntries(worldInfo.id);
      if (existing.some((item) => item.id !== entry.id && item.name === nextTitle.trim())) throw new Error("世界书条目标题已存在");
    }
    const updated = await saveWorldInfoEntry({
      id: entry.id,
      worldInfoId: worldInfo.id,
      name: nextTitle,
      content: hasContent ? args.content as string : entry.content,
      isEnabled: entry.isEnabled,
    });
    return { success: true, entry_id: updated.id, title: updated.name };
  }
  if (name === "delete_world_entry") {
    const entry = await getWorldInfoEntry(requiredString(args, "entry_id"));
    if (!entry) throw new Error("未找到世界书条目");
    const worldInfo = await getOrCreateWorldInfo(projectId);
    if (entry.worldInfoId !== worldInfo.id) throw new Error("未找到世界书条目");
    await deleteWorldInfoEntry(entry.id);
    return { success: true, entry_id: entry.id, title: entry.name };
  }
  if (name === "write_chapter") {
    const volumes = await listVolumes(projectId);
    const requestedVolumeId = typeof args.volume_id === "string" ? args.volume_id : null;
    const volume = requestedVolumeId
      ? volumes.find((item) => item.id === requestedVolumeId)
      : volumes[0];
    if (requestedVolumeId && !volume) throw new Error("未找到指定卷");
    if (!volume) throw new Error("项目没有可用卷");
    const chapter = await createChapter(
      projectId,
      volume.id,
      requiredString(args, "title"),
      requiredString(args, "content"),
    );
    return { success: true, chapter_id: chapter.id, title: chapter.title };
  }
  if (name === "edit_chapter") {
    const chapter = await getChapter(requiredString(args, "chapter_id"));
    if (!chapter || chapter.projectId !== projectId) throw new Error("未找到章节");
    const title = typeof args.title === "string" ? args.title : chapter.title;
    const content = typeof args.content === "string" ? args.content : chapter.content;
    await saveChapter(chapter.id, title, content);
    return { success: true, chapter_id: chapter.id, title };
  }
  throw new Error(`未知工具: ${name}`);
}
