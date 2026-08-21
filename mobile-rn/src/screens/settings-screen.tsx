import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useNavigation } from "@react-navigation/native";
import { useCallback, useMemo, useState } from "react";
import { ActivityIndicator, Alert, FlatList, Modal, Pressable, StyleSheet, Text, View } from "react-native";

import { Button, ErrorNotice, Field, Header, Screen } from "@/components/ui";
import {
  deleteProvider,
  getProviderApiKey,
  getSetting,
  listModels,
  listProviders,
  saveModel,
  saveProvider,
  setSetting,
} from "@/data/repositories";
import { fetchProviderModels, type RemoteModel } from "@/llm/model-catalog";
import { DEFAULT_MAX_OUTPUT_TOKENS, MAX_CONFIGURED_OUTPUT_TOKENS } from "@/llm/limits";
import type { RootStackParamList } from "@/navigation/types";
import { SettingsCategoryScreen, type SettingsCategory } from "@/screens/settings-category-screen";
import { useAppStore } from "@/store/app-store";
import { colors, radius, spacing } from "@/theme";
import type { Model, Provider, ProviderType } from "@/types";

const providerDefaults: Record<ProviderType, { name: string; url: string }> = {
  "openai-compatible": { name: "OpenAI Compatible", url: "https://api.openai.com/v1" },
  "google-genai": { name: "Google Gemini", url: "https://generativelanguage.googleapis.com/v1beta" },
  anthropic: { name: "Anthropic", url: "https://api.anthropic.com/v1" },
};

const settingsCategories: Array<{
  id: SettingsCategory;
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
}> = [
  { id: "general", label: "通用", icon: "options-outline" },
  { id: "connections", label: "连接", icon: "link-outline" },
  { id: "models", label: "模型与供应商", icon: "hardware-chip-outline" },
  { id: "index", label: "索引", icon: "layers-outline" },
  { id: "context", label: "上下文", icon: "document-text-outline" },
  { id: "style", label: "作者文风", icon: "color-wand-outline" },
  { id: "agent-tools", label: "工具权限", icon: "shield-checkmark-outline" },
  { id: "rules", label: "规则", icon: "list-outline" },
  { id: "skills", label: "技能", icon: "flash-outline" },
  { id: "agents", label: "智能体", icon: "git-network-outline" },
  { id: "advanced", label: "高级", icon: "construct-outline" },
];

export function SettingsScreen() {
  const rootNavigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const revision = useAppStore((state) => state.dataRevision);
  const refreshData = useAppStore((state) => state.refreshData);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [models, setModels] = useState<Model[]>([]);
  const [activeModelId, setActiveModelId] = useState<string | null>(null);
  const [providerType, setProviderType] = useState<ProviderType>("openai-compatible");
  const [providerName, setProviderName] = useState(providerDefaults["openai-compatible"].name);
  const [baseUrl, setBaseUrl] = useState(providerDefaults["openai-compatible"].url);
  const [apiKey, setApiKey] = useState("");
  const [selectedProviderId, setSelectedProviderId] = useState("");
  const [modelName, setModelName] = useState("");
  const [modelId, setModelId] = useState("");
  const [temperature, setTemperature] = useState("0.8");
  const [maxTokens, setMaxTokens] = useState(String(DEFAULT_MAX_OUTPUT_TOKENS));
  const [saving, setSaving] = useState(false);
  const [savingModel, setSavingModel] = useState(false);
  const [fetchingProviderId, setFetchingProviderId] = useState<string | null>(null);
  const [modelPickerProvider, setModelPickerProvider] = useState<Provider | null>(null);
  const [remoteModels, setRemoteModels] = useState<RemoteModel[]>([]);
  const [modelFilter, setModelFilter] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [activeCategory, setActiveCategory] = useState<SettingsCategory | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [nextProviders, nextModels, selected] = await Promise.all([listProviders(), listModels(), getSetting("activeModelId")]);
      setProviders(nextProviders);
      setModels(nextModels);
      const validSelected = selected && nextModels.some((model) => model.id === selected) ? selected : null;
      setActiveModelId(validSelected);
      setSelectedProviderId((current) => current && nextProviders.some((provider) => provider.id === current)
        ? current
        : nextProviders[0]?.id ?? "");
      if (selected && !validSelected) await setSetting("activeModelId", "");
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    }
  }, []);

  useFocusEffect(useCallback(() => {
    void load();
  }, [load, revision]));

  const modelsByProvider = useMemo(() => new Map(providers.map((provider) => [
    provider.id,
    models.filter((model) => model.providerId === provider.id),
  ])), [providers, models]);

  const chooseType = (type: ProviderType) => {
    setProviderType(type);
    setProviderName(providerDefaults[type].name);
    setBaseUrl(providerDefaults[type].url);
  };

  const addProvider = async () => {
    if (!providerName.trim() || !baseUrl.trim() || !apiKey.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const provider = await saveProvider({ name: providerName, type: providerType, baseUrl, apiKey });
      setApiKey("");
      setSelectedProviderId(provider.id);
      refreshData();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally { setSaving(false); }
  };

  const addModel = async () => {
    if (!selectedProviderId || !modelName.trim() || !modelId.trim()) return;
    const parsedTemperature = Number(temperature);
    const parsedMaxTokens = Number(maxTokens);
    if (!Number.isFinite(parsedTemperature) || parsedTemperature < 0 || parsedTemperature > 2) {
      setError("温度必须在 0 到 2 之间");
      return;
    }
    if (!Number.isInteger(parsedMaxTokens) || parsedMaxTokens < 1 || parsedMaxTokens > MAX_CONFIGURED_OUTPUT_TOKENS) {
      setError(`最大输出 Token 数必须在 1 到 ${MAX_CONFIGURED_OUTPUT_TOKENS} 之间；1M 通常是上下文窗口，不需要填写 1000000`);
      return;
    }
    setSavingModel(true);
    setError(null);
    try {
      const model = await saveModel({
        providerId: selectedProviderId,
        name: modelName,
        modelId,
        temperature: parsedTemperature,
        maxTokens: parsedMaxTokens,
      });
      if (!activeModelId) {
        await setSetting("activeModelId", model.id);
        setActiveModelId(model.id);
      }
      setModelName("");
      setModelId("");
      refreshData();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setSavingModel(false);
    }
  };

  const removeProvider = async (provider: Provider) => {
    try {
      await deleteProvider(provider);
      refreshData();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : String(deleteError));
    }
  };

  const selectModel = async (model: Model) => {
    try {
      await setSetting("activeModelId", model.id);
      setActiveModelId(model.id);
      refreshData();
    } catch (selectError) {
      setError(selectError instanceof Error ? selectError.message : String(selectError));
    }
  };

  const fetchRemoteModels = async (provider: Provider) => {
    setFetchingProviderId(provider.id);
    setError(null);
    try {
      const key = await getProviderApiKey(provider);
      const fetched = await fetchProviderModels(provider, key);
      if (!fetched.length) throw new Error("供应商没有返回可用于生成内容的模型");
      setRemoteModels(fetched);
      setModelFilter("");
      setModelPickerProvider(provider);
    } catch (fetchError) {
      setError(fetchError instanceof Error ? fetchError.message : String(fetchError));
    } finally {
      setFetchingProviderId(null);
    }
  };

  const chooseRemoteModel = (model: RemoteModel) => {
    if (!modelPickerProvider) return;
    setSelectedProviderId(modelPickerProvider.id);
    setModelName(model.name);
    setModelId(model.id);
    setModelFilter("");
    setModelPickerProvider(null);
  };

  // 中转站常常返回几百个模型，按名称和 ID 做不区分大小写的子串过滤。
  const filteredRemoteModels = useMemo(() => {
    const keyword = modelFilter.trim().toLowerCase();
    if (!keyword) return remoteModels;
    return remoteModels.filter((model) => model.name.toLowerCase().includes(keyword)
      || model.id.toLowerCase().includes(keyword));
  }, [modelFilter, remoteModels]);

  if (activeCategory && activeCategory !== "models") {
    return <SettingsCategoryScreen category={activeCategory} onBack={() => setActiveCategory(null)} />;
  }

  if (!activeCategory) {
    return (
      <Screen scroll>
        <Header title="设置" />
        <View style={styles.categoryList}>
          {settingsCategories.map((category) => (
            <Pressable
              key={category.id}
              onPress={() => {
                if (category.id === "style") rootNavigation.navigate("StyleLibrary");
                else setActiveCategory(category.id);
              }}
              style={({ pressed }) => [styles.categoryRow, pressed && styles.categoryRowPressed]}
            >
              <View style={styles.categoryIcon}><Ionicons name={category.icon} size={21} color={colors.primary} /></View>
              <Text style={styles.categoryLabel}>{category.label}</Text>
              <Ionicons name="chevron-forward" size={19} color={colors.textMuted} />
            </Pressable>
          ))}
        </View>
      </Screen>
    );
  }

  return (
    <Screen scroll>
      <Header title="模型与供应商" onBack={() => setActiveCategory(null)} />
      {error ? <View style={styles.errorWrap}><ErrorNotice message={error} onRetry={() => void load()} /></View> : null}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>供应商</Text>
        <View style={styles.segmented}>
          {(["openai-compatible", "google-genai", "anthropic"] as ProviderType[]).map((type) => (
            <Pressable key={type} onPress={() => chooseType(type)} style={[styles.segment, providerType === type && styles.segmentActive]}>
              <Text style={[styles.segmentText, providerType === type && styles.segmentTextActive]}>
                {type === "openai-compatible" ? "OpenAI" : type === "google-genai" ? "Gemini" : "Anthropic"}
              </Text>
            </Pressable>
          ))}
        </View>
        <Field label="显示名称" value={providerName} onChangeText={setProviderName} />
        <Field label="Base URL" value={baseUrl} onChangeText={setBaseUrl} autoCapitalize="none" keyboardType="url" />
        <Field label="API Key" value={apiKey} onChangeText={setApiKey} autoCapitalize="none" secureTextEntry />
        <Button label="保存供应商" onPress={() => void addProvider()} disabled={!providerName.trim() || !baseUrl.trim() || !apiKey.trim()} loading={saving} />
      </View>

      {providers.map((provider) => (
        <View key={provider.id} style={styles.providerBlock}>
          <View style={styles.providerHeader}>
            <View style={styles.providerInfo}>
              <Text style={styles.providerName}>{provider.name}</Text>
              <Text style={styles.providerUrl} numberOfLines={1}>{provider.baseUrl}</Text>
            </View>
            <View style={styles.providerActions}>
              <Pressable
                accessibilityLabel="获取模型列表"
                disabled={fetchingProviderId !== null}
                onPress={() => void fetchRemoteModels(provider)}
                style={styles.fetchButton}
              >
                {fetchingProviderId === provider.id
                  ? <ActivityIndicator size="small" color={colors.primary} />
                  : <Ionicons name="cloud-download-outline" size={18} color={colors.primary} />}
                <Text style={styles.fetchButtonText}>获取模型</Text>
              </Pressable>
              <Pressable accessibilityLabel="删除供应商" onPress={() => {
                Alert.alert("删除供应商", `删除 ${provider.name} 及其全部模型？`, [
                  { text: "取消", style: "cancel" },
                  { text: "删除", style: "destructive", onPress: () => void removeProvider(provider) },
                ]);
              }} style={styles.iconButton}><Ionicons name="trash-outline" size={20} color={colors.danger} /></Pressable>
            </View>
          </View>
          {(modelsByProvider.get(provider.id) ?? []).map((model) => (
            <Pressable key={model.id} onPress={() => void selectModel(model)} style={styles.modelRow}>
              <Ionicons name={activeModelId === model.id ? "radio-button-on" : "radio-button-off"} size={20} color={activeModelId === model.id ? colors.primary : colors.textMuted} />
              <View style={styles.modelText}>
                <Text style={styles.modelName}>{model.name}</Text>
                <Text style={styles.modelId}>{model.modelId}</Text>
              </View>
            </Pressable>
          ))}
        </View>
      ))}

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>添加模型</Text>
        <View style={styles.providerChoices}>
          {providers.map((provider) => (
            <Pressable key={provider.id} onPress={() => setSelectedProviderId(provider.id)} style={[styles.choice, selectedProviderId === provider.id && styles.choiceActive]}>
              <Text style={[styles.choiceText, selectedProviderId === provider.id && styles.choiceTextActive]}>{provider.name}</Text>
            </Pressable>
          ))}
        </View>
        <Field label="模型名称" value={modelName} onChangeText={setModelName} placeholder="Gemini 2.5 Pro" />
        <Field label="模型 ID" value={modelId} onChangeText={setModelId} autoCapitalize="none" placeholder="gemini-2.5-pro" />
        <Field label="温度" value={temperature} onChangeText={setTemperature} keyboardType="decimal-pad" />
        <Field label="最大输出 Token 数" value={maxTokens} onChangeText={setMaxTokens} keyboardType="number-pad" />
        <Text style={styles.fieldHint}>单次回复长度，不是上下文窗口；1M 上下文模型保持 {DEFAULT_MAX_OUTPUT_TOKENS} 或按需填写，最高 {MAX_CONFIGURED_OUTPUT_TOKENS}。</Text>
        <Button label="添加模型" onPress={() => void addModel()} disabled={!selectedProviderId || !modelName.trim() || !modelId.trim()} loading={savingModel} />
      </View>

      <Modal
        visible={modelPickerProvider !== null}
        transparent
        animationType="slide"
        onRequestClose={() => setModelPickerProvider(null)}
      >
        <Pressable style={styles.modalBackdrop} onPress={() => setModelPickerProvider(null)}>
          <View style={styles.modelSheet} onStartShouldSetResponder={() => true}>
            <View style={styles.sheetHeader}>
              <View style={styles.providerInfo}>
                <Text style={styles.sectionTitle}>选择模型</Text>
                <Text style={styles.providerUrl}>
                  {modelFilter.trim()
                    ? `${filteredRemoteModels.length} / ${remoteModels.length} 个模型`
                    : `${remoteModels.length} 个可用模型`}
                </Text>
              </View>
              <Pressable accessibilityLabel="关闭模型列表" onPress={() => setModelPickerProvider(null)} style={styles.iconButton}>
                <Ionicons name="close" size={24} color={colors.textMuted} />
              </Pressable>
            </View>
            <View style={styles.modelFilterWrap}>
              <Field
                label="查找模型"
                value={modelFilter}
                onChangeText={setModelFilter}
                placeholder="输入名称或模型 ID 的一部分"
                autoCapitalize="none"
                autoCorrect={false}
              />
            </View>
            <FlatList
              data={filteredRemoteModels}
              keyExtractor={(item) => item.id}
              keyboardShouldPersistTaps="handled"
              ListEmptyComponent={(
                <Text style={styles.modelFilterEmpty}>
                  {remoteModels.length ? `没有匹配“${modelFilter.trim()}”的模型` : "还没有获取到模型列表"}
                </Text>
              )}
              renderItem={({ item }) => (
                <Pressable onPress={() => chooseRemoteModel(item)} style={styles.remoteModelRow}>
                  <View style={styles.modelText}>
                    <Text style={styles.modelName}>{item.name}</Text>
                    <Text style={styles.modelId}>{item.id}</Text>
                  </View>
                  <Ionicons name="add-circle-outline" size={22} color={colors.primary} />
                </Pressable>
              )}
            />
          </View>
        </Pressable>
      </Modal>
    </Screen>
  );
}

const styles = StyleSheet.create({
  categoryList: { paddingVertical: spacing.sm },
  categoryRow: { minHeight: 58, flexDirection: "row", alignItems: "center", gap: spacing.md, paddingHorizontal: spacing.lg, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  categoryRowPressed: { backgroundColor: colors.surfaceMuted },
  categoryIcon: { width: 36, height: 36, alignItems: "center", justifyContent: "center", borderRadius: radius.sm, backgroundColor: "#E6F3EF" },
  categoryLabel: { flex: 1, color: colors.text, fontSize: 16, fontWeight: "600" },
  section: { padding: spacing.lg, gap: spacing.md, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  errorWrap: { paddingHorizontal: spacing.lg, paddingTop: spacing.md },
  sectionTitle: { color: colors.text, fontSize: 18, fontWeight: "700" },
  segmented: { flexDirection: "row", padding: 3, borderRadius: radius.md, backgroundColor: colors.surfaceMuted },
  segment: { flex: 1, minHeight: 38, alignItems: "center", justifyContent: "center", borderRadius: radius.sm },
  segmentActive: { backgroundColor: colors.surface },
  segmentText: { color: colors.textMuted, fontSize: 13, fontWeight: "600" },
  segmentTextActive: { color: colors.primary },
  providerBlock: { paddingHorizontal: spacing.lg, paddingVertical: spacing.md, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  providerHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  providerActions: { flexDirection: "row", alignItems: "center", gap: spacing.xs },
  providerInfo: { flex: 1, minWidth: 0, marginRight: spacing.sm },
  providerName: { color: colors.text, fontSize: 16, fontWeight: "700" },
  providerUrl: { color: colors.textMuted, fontSize: 12, marginTop: 3 },
  iconButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  fetchButton: { minHeight: 44, flexDirection: "row", alignItems: "center", gap: spacing.xs, paddingHorizontal: spacing.sm },
  fetchButtonText: { color: colors.primary, fontSize: 13, fontWeight: "700" },
  modelRow: { flexDirection: "row", alignItems: "center", gap: spacing.md, paddingVertical: spacing.md },
  modelText: { flex: 1 },
  modelName: { color: colors.text, fontSize: 15, fontWeight: "600" },
  modelId: { color: colors.textMuted, fontSize: 12, marginTop: 2 },
  fieldHint: { color: colors.textMuted, fontSize: 12, lineHeight: 18, marginTop: -spacing.sm },
  providerChoices: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  choice: { paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md },
  choiceActive: { borderColor: colors.primary, backgroundColor: "#E6F3EF" },
  choiceText: { color: colors.textMuted, fontSize: 13 },
  choiceTextActive: { color: colors.primary, fontWeight: "700" },
  modalBackdrop: { flex: 1, justifyContent: "flex-end", backgroundColor: colors.overlay },
  modelSheet: { maxHeight: "78%", paddingBottom: spacing.lg, borderTopLeftRadius: radius.md, borderTopRightRadius: radius.md, backgroundColor: colors.background },
  modelFilterWrap: { paddingHorizontal: spacing.lg, paddingTop: spacing.md },
  modelFilterEmpty: { padding: spacing.lg, color: colors.textMuted, fontSize: 14, lineHeight: 20 },
  sheetHeader: { minHeight: 64, flexDirection: "row", alignItems: "center", paddingHorizontal: spacing.lg, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  remoteModelRow: { minHeight: 62, flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingHorizontal: spacing.lg, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
});
