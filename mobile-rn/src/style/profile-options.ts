import { listStyleProfiles, listStyleSources } from "@/data/style-repositories";
import { styleProfileLabel } from "@/lib/style-label";
import { getStyleDistillationCoverage, type StyleDistillationCoverage } from "@/settings/lorn-style-plugin";
import type { StyleProfile, StyleSource } from "@/types";

/**
 * 选择文风要用的完整信息：文风本身、它对应的参考书（作者文风没有）、以及这本书的蒸馏进度。
 * 同名参考文风来自多次导入的不同文件，光看名字分不出来，必须带上来源与进度。
 */
export interface StyleProfileOption {
  profile: StyleProfile;
  source: StyleSource | null;
  coverage: StyleDistillationCoverage | null;
}

export async function listStyleProfileOptions(projectId: string): Promise<StyleProfileOption[]> {
  const [profiles, sources] = await Promise.all([listStyleProfiles(projectId), listStyleSources()]);
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const coverageBySource = new Map<string, StyleDistillationCoverage | null>();
  const options: StyleProfileOption[] = [];
  for (const profile of profiles) {
    const source = profile.sourceId ? sourceById.get(profile.sourceId) ?? null : null;
    let coverage: StyleDistillationCoverage | null = null;
    if (source) {
      // 同一本书的多份文风共用一条进度记录，按来源缓存避免重复读设置。
      if (!coverageBySource.has(source.id)) {
        coverageBySource.set(source.id, await getStyleDistillationCoverage(source.id).catch(() => null));
      }
      const stored = coverageBySource.get(source.id) ?? null;
      // 换书或重新导入后哈希会变，旧进度不再可信。
      coverage = stored && stored.contentHash === source.contentHash ? stored : null;
    }
    options.push({ profile, source, coverage });
  }
  return options;
}

export interface StyleProfileDescription {
  title: string;
  meta: string;
  preview: string;
}

function sourceFormatLabel(source: StyleSource): string {
  return source.format === "epub" ? "EPUB" : source.format === "markdown" ? "Markdown" : "TXT";
}

export function describeStyleProfileOption(option: StyleProfileOption): StyleProfileDescription {
  const { profile, source, coverage } = option;
  const unitName = coverage?.unitKind === "segment" ? "段" : "章";
  const meta = profile.kind === "reference"
    ? [
      "参考小说文风",
      source ? `${sourceFormatLabel(source)} · ${source.characterCount.toLocaleString()} 字` : "参考书已删除",
      coverage ? `第 ${coverage.rounds} 轮 · 覆盖 ${coverage.coveredUntil}/${coverage.totalUnits} ${unitName}` : "尚未开始蒸馏",
    ].join(" · ")
    : `作者文风 · 第 ${profile.version} 版`;
  return {
    title: styleProfileLabel(profile),
    meta,
    preview: profile.guide.replace(/\s+/g, " ").trim().slice(0, 96) || "（这份文风还没有内容）",
  };
}
