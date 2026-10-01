import type { StyleProfile } from "@/types";

/**
 * 参考文风每本参考书只有一份、反复蒸馏就地更新，版本号没有信息量，标签不拼 V 号；
 * 作者文风仍按版本累积，标签保留 V 号以便区分。
 */
export function styleProfileLabel(profile: Pick<StyleProfile, "name" | "kind" | "version">): string {
  return profile.kind === "reference" ? profile.name : `${profile.name} V${profile.version}`;
}
