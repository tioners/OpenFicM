import { Ionicons } from "@expo/vector-icons";
import { useCallback, useEffect, useState } from "react";
import { Alert, Pressable, StyleSheet, Switch, Text, View } from "react-native";

import { Button, ErrorNotice, Field, Header, Screen } from "@/components/ui";
import { getSetting, setSetting } from "@/data/repositories";
import {
  deleteSearchProvider,
  getActiveSearchProvider,
  listSearchProviders,
  saveSearchProvider,
  setActiveSearchProvider,
} from "@/data/workspace-repositories";
import { colors, radius, spacing } from "@/theme";
import { themedStyles } from "@/themed-styles";
import type { SearchProvider, SearchProviderType } from "@/types";
import { SEARCH_PROVIDER_PRESETS } from "@/web/search-providers";
import { runWebSearch } from "@/web/web-tools";

const TYPES = Object.keys(SEARCH_PROVIDER_PRESETS) as SearchProviderType[];

/** 联网搜索服务的管理页：和模型供应商一样，类型、地址、Key 都由用户自己填。 */
export function WebSearchSettingsScreen({ onBack }: { onBack: () => void }) {
  const [providers, setProviders] = useState<SearchProvider[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [fetchEnabled, setFetchEnabled] = useState(false);
  const [editing, setEditing] = useState<SearchProvider | null>(null);
  const [type, setType] = useState<SearchProviderType>("tavily");
  const [name, setName] = useState(SEARCH_PROVIDER_PRESETS.tavily.label);
  const [baseUrl, setBaseUrl] = useState(SEARCH_PROVIDER_PRESETS.tavily.defaultBaseUrl);
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [nextProviders, active, fetchValue] = await Promise.all([
        listSearchProviders(),
        getActiveSearchProvider(),
        getSetting("web.fetchEnabled"),
      ]);
      setProviders(nextProviders);
      setActiveId(active?.id ?? null);
      setFetchEnabled(fetchValue === "true" || (nextProviders.length > 0 && fetchValue !== "false"));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const resetForm = (nextType: SearchProviderType = "tavily") => {
    setEditing(null);
    setType(nextType);
    setName(SEARCH_PROVIDER_PRESETS[nextType].label);
    setBaseUrl(SEARCH_PROVIDER_PRESETS[nextType].defaultBaseUrl);
    setApiKey("");
  };

  const beginEdit = (provider: SearchProvider) => {
    setEditing(provider);
    setType(provider.type);
    setName(provider.name);
    setBaseUrl(provider.baseUrl);
    setApiKey("");
    setNotice(null);
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const saved = await saveSearchProvider({ id: editing?.id, name, type, baseUrl, apiKey });
      if (!activeId) await setActiveSearchProvider(saved.id);
      resetForm();
      await load();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setSaving(false);
    }
  };

  const choose = async (provider: SearchProvider) => {
    try {
      await setActiveSearchProvider(provider.id);
      setActiveId(provider.id);
    } catch (chooseError) {
      setError(chooseError instanceof Error ? chooseError.message : String(chooseError));
    }
  };

  const remove = (provider: SearchProvider) => {
    Alert.alert("删除搜索服务", `删除“${provider.name}”？`, [
      { text: "取消", style: "cancel" },
      {
        text: "删除",
        style: "destructive",
        onPress: () => {
          void deleteSearchProvider(provider)
            .then(async () => {
              if (editing?.id === provider.id) resetForm();
              await load();
            })
            .catch((deleteError) => setError(deleteError instanceof Error ? deleteError.message : String(deleteError)));
        },
      },
    ]);
  };

  const test = async () => {
    setTesting(true);
    setError(null);
    setNotice(null);
    try {
      const response = await runWebSearch("OpenFic 小说创作", 3);
      setNotice(`${response.provider} 可用：返回 ${response.results.length} 条结果${response.results[0] ? `，第一条是“${response.results[0].title}”` : ""}`);
    } catch (testError) {
      setError(testError instanceof Error ? testError.message : String(testError));
    } finally {
      setTesting(false);
    }
  };

  const preset = SEARCH_PROVIDER_PRESETS[type];
  const canSave = Boolean(name.trim() && baseUrl.trim() && (apiKey.trim() || editing || !preset.requiresApiKey));

  return (
    <Screen scroll>
      <Header title="联网搜索" onBack={onBack} />
      {error ? <View style={styles.errorWrap}><ErrorNotice message={error} /></View> : null}
      <View style={styles.section}>
        <Text style={styles.hint}>
          添加搜索服务后，助手才会带上“联网搜索”工具；没有添加时不会联网检索。搜索词会发给你选的服务商，作品内容不会发送。
        </Text>
        {providers.map((provider) => (
          <View key={provider.id} style={[styles.providerRow, activeId === provider.id && styles.providerRowActive]}>
            <Pressable accessibilityLabel={`使用 ${provider.name}`} onPress={() => void choose(provider)} style={styles.providerSelect}>
              <Ionicons name={activeId === provider.id ? "radio-button-on" : "radio-button-off"} size={20} color={activeId === provider.id ? colors.primary : colors.textMuted} />
              <View style={styles.providerText}>
                <Text style={styles.providerName}>{provider.name}</Text>
                <Text style={styles.providerMeta} numberOfLines={1}>{SEARCH_PROVIDER_PRESETS[provider.type].label} · {provider.baseUrl}</Text>
              </View>
            </Pressable>
            <Pressable accessibilityLabel={`编辑 ${provider.name}`} onPress={() => beginEdit(provider)} style={styles.iconButton}>
              <Ionicons name="create-outline" size={20} color={colors.text} />
            </Pressable>
            <Pressable accessibilityLabel={`删除 ${provider.name}`} onPress={() => remove(provider)} style={styles.iconButton}>
              <Ionicons name="trash-outline" size={20} color={colors.danger} />
            </Pressable>
          </View>
        ))}
        {providers.length ? (
          <Button label={testing ? "测试中" : "测试当前搜索服务"} variant="secondary" onPress={() => void test()} disabled={testing} loading={testing} />
        ) : null}
        {notice ? <Text style={styles.notice}>{notice}</Text> : null}
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>{editing ? `编辑“${editing.name}”` : "添加搜索服务"}</Text>
        {editing ? null : (
          <View style={styles.choices}>
            {TYPES.map((item) => (
              <Pressable key={item} onPress={() => resetForm(item)} style={[styles.choice, type === item && styles.choiceActive]}>
                <Text style={[styles.choiceText, type === item && styles.choiceTextActive]}>{SEARCH_PROVIDER_PRESETS[item].label}</Text>
              </Pressable>
            ))}
          </View>
        )}
        <Text style={styles.hint}>接口：{preset.hint}。Base URL 可以改成中转或自建地址。</Text>
        <Field label="显示名称" value={name} onChangeText={setName} />
        <Field label="Base URL" value={baseUrl} onChangeText={setBaseUrl} autoCapitalize="none" keyboardType="url" placeholder="https://" />
        <Field
          label={editing ? "API Key（留空保持原值）" : preset.requiresApiKey ? "API Key" : "API Key（可不填）"}
          value={apiKey}
          onChangeText={setApiKey}
          autoCapitalize="none"
          secureTextEntry
        />
        <Button label={editing ? "保存修改" : "保存搜索服务"} onPress={() => void save()} disabled={!canSave} loading={saving} />
        {editing ? <Button label="取消编辑" variant="secondary" onPress={() => resetForm()} /> : null}
      </View>

      <View style={styles.section}>
        <View style={styles.toggleRow}>
          <Text style={styles.toggleLabel}>允许助手读取网页</Text>
          <Switch
            value={fetchEnabled}
            onValueChange={(value) => {
              setFetchEnabled(value);
              void setSetting("web.fetchEnabled", String(value)).catch(() => undefined);
            }}
            trackColor={{ false: colors.border, true: colors.primary }}
          />
        </View>
        <Text style={styles.hint}>
          开启后助手可以打开公开网页并读取正文（最多 5 MB，分段返回）。不会访问本机或局域网地址；需要登录或靠脚本渲染的页面读不到内容。
        </Text>
      </View>
    </Screen>
  );
}

const styles = themedStyles((colors) => StyleSheet.create({
  errorWrap: { paddingHorizontal: spacing.lg, paddingTop: spacing.md },
  section: { gap: spacing.md, padding: spacing.lg, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  sectionTitle: { color: colors.text, fontSize: 17, fontWeight: "700" },
  hint: { color: colors.textMuted, fontSize: 12, lineHeight: 18 },
  notice: { color: colors.primary, fontSize: 13, lineHeight: 19 },
  providerRow: { minHeight: 60, flexDirection: "row", alignItems: "center", paddingLeft: spacing.md, borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm },
  providerRowActive: { borderColor: colors.primary, backgroundColor: colors.primarySoft },
  providerSelect: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: spacing.md, paddingVertical: spacing.sm },
  providerText: { flex: 1, minWidth: 0 },
  providerName: { color: colors.text, fontSize: 15, fontWeight: "600" },
  providerMeta: { marginTop: 2, color: colors.textMuted, fontSize: 12 },
  iconButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  choices: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  choice: { paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md },
  choiceActive: { borderColor: colors.primary, backgroundColor: colors.primarySoft },
  choiceText: { color: colors.textMuted, fontSize: 13 },
  choiceTextActive: { color: colors.primary, fontWeight: "700" },
  toggleRow: { minHeight: 48, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing.md },
  toggleLabel: { flex: 1, color: colors.text, fontSize: 15, fontWeight: "600" },
}));
