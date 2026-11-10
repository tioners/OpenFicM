import { currentColors, resolvedScheme, type ThemePalette } from "@/theme";

/**
 * 按当前明暗缓存样式表。
 *
 * 用法：`const styles = themedStyles((colors) => StyleSheet.create({ ... }))`。
 * 样式在首次访问时按当时配色构建，切换模式后自动用另一套重算；
 * 工厂里的 `colors` 参数会遮蔽模块级的同名导入，所以样式块本身不用改。
 */
export function themedStyles<T extends Record<string, unknown>>(
  factory: (colors: ThemePalette) => T,
): T {
  const cache = new Map<string, T>();
  return new Proxy({} as T, {
    get(_target, property) {
      const scheme = resolvedScheme();
      let styles = cache.get(scheme);
      if (!styles) {
        styles = factory(currentColors());
        cache.set(scheme, styles);
      }
      return Reflect.get(styles, property);
    },
    has(_target, property) {
      const scheme = resolvedScheme();
      const styles = cache.get(scheme) ?? factory(currentColors());
      cache.set(scheme, styles);
      return Reflect.has(styles, property);
    },
    ownKeys() {
      const scheme = resolvedScheme();
      const styles = cache.get(scheme) ?? factory(currentColors());
      cache.set(scheme, styles);
      return Reflect.ownKeys(styles);
    },
    getOwnPropertyDescriptor(_target, property) {
      const scheme = resolvedScheme();
      const styles = cache.get(scheme) ?? factory(currentColors());
      cache.set(scheme, styles);
      return Reflect.getOwnPropertyDescriptor(styles, property);
    },
  });
}
