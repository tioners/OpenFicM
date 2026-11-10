import { useSyncExternalStore } from "react";

/**
 * 主题调色板与模式切换。
 *
 * 设计：`colors` 是一个读取"当前配色"的代理，模块级样式块改成
 * `themedStyles((colors) => StyleSheet.create({...}))` 后按配色分别缓存。
 * 这样切换模式不需要重启，也不用把 487 处 `colors.x` 逐个改成 hook。
 */

export type ThemeMode = "light" | "dark" | "system";
export type ResolvedScheme = "light" | "dark";

export interface ThemePalette {
  background: string;
  surface: string;
  surfaceMuted: string;
  text: string;
  textMuted: string;
  border: string;
  primary: string;
  primaryPressed: string;
  accent: string;
  danger: string;
  overlay: string;
  /** 选中态/强调块底色（浅绿）。 */
  primarySoft: string;
  /** 比 primarySoft 更深一档的强调底色。 */
  primarySoftStrong: string;
  /** 失败卡片的底色与描边。 */
  dangerSoft: string;
  dangerBorder: string;
  /** 主色背景上的文字/图标。 */
  onPrimary: string;
  /** 阴影色。 */
  shadow: string;
}

export const lightColors: ThemePalette = {
  background: "#F7F7F5",
  surface: "#FFFFFF",
  surfaceMuted: "#EFEFEC",
  text: "#20211F",
  textMuted: "#696B66",
  border: "#D9DAD5",
  primary: "#176B57",
  primaryPressed: "#0F5444",
  accent: "#D95D39",
  danger: "#B42318",
  overlay: "rgba(20, 21, 19, 0.48)",
  primarySoft: "#E6F3EF",
  primarySoftStrong: "#DCECE6",
  dangerSoft: "#FFF4F2",
  dangerBorder: "#E4B4AE",
  onPrimary: "#FFFFFF",
  shadow: "#000000",
};

export const darkColors: ThemePalette = {
  background: "#101312",
  surface: "#1A1E1C",
  surfaceMuted: "#242A27",
  text: "#E9ECE8",
  textMuted: "#9DA69F",
  border: "#333B36",
  primary: "#67C7A6",
  primaryPressed: "#8AD9BC",
  accent: "#F08A63",
  danger: "#FF8A7A",
  overlay: "rgba(0, 0, 0, 0.62)",
  primarySoft: "#1E322B",
  primarySoftStrong: "#264238",
  dangerSoft: "#3A211E",
  dangerBorder: "#7A4038",
  onPrimary: "#08201A",
  shadow: "#000000",
};

let mode: ThemeMode = "light";
let systemScheme: ResolvedScheme = "light";
const listeners = new Set<() => void>();

export function getThemeMode(): ThemeMode {
  return mode;
}

export function setThemeMode(next: ThemeMode): void {
  if (mode === next) return;
  mode = next;
  notify();
}

export function getSystemScheme(): ResolvedScheme {
  return systemScheme;
}

export function setSystemScheme(next: ResolvedScheme): void {
  if (systemScheme === next) return;
  systemScheme = next;
  // 只有跟随系统时才需要通知，否则配色不变。
  if (mode === "system") notify();
}

export function resolvedScheme(): ResolvedScheme {
  return mode === "system" ? systemScheme : mode;
}

export function currentColors(): ThemePalette {
  return resolvedScheme() === "dark" ? darkColors : lightColors;
}

function notify(): void {
  for (const listener of listeners) listener();
}

export function subscribeTheme(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * 当前配色的代理。所有 `colors.x` 读取都发生在渲染期或样式工厂内，
 * 因此拿到的是"此刻"的配色，模块加载时不会把值定死。
 */
export const colors: ThemePalette = new Proxy({} as ThemePalette, {
  get(_target, key) {
    return currentColors()[key as keyof ThemePalette];
  },
});

/** 订阅主题模式：模式变化时组件会重渲染。 */
export function useThemeMode(): ThemeMode {
  return useSyncExternalStore(subscribeTheme, getThemeMode, getThemeMode);
}

/** 订阅解析后的明暗（跟随系统时也会随系统变化）。 */
export function useResolvedScheme(): ResolvedScheme {
  return useSyncExternalStore(subscribeTheme, resolvedScheme, resolvedScheme);
}

export function useThemeColors(): ThemePalette {
  useResolvedScheme();
  return currentColors();
}

export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;
export const radius = { sm: 4, md: 8 } as const;
