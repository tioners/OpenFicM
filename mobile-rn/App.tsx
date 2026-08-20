import { Ionicons } from "@expo/vector-icons";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { SafeAreaProvider, useSafeAreaInsets } from "react-native-safe-area-context";

import type { RootStackParamList, RootTabParamList } from "@/navigation/types";
import { CharactersScreen } from "@/screens/characters-screen";
import { AssistantScreen } from "@/screens/assistant-screen";
import { ProjectsScreen } from "@/screens/projects-screen";
import { SettingsScreen } from "@/screens/settings-screen";
import { StyleLibraryScreen } from "@/screens/style-library-screen";
import { WritingScreen } from "@/screens/writing-screen";
import { WorldInfoScreen } from "@/screens/world-info-screen";
import { colors } from "@/theme";
import { installMissingRuntimeResources, getRuntimeResourceState, type RuntimeResourceState } from "@/settings/remote-resources";
import { warmUpLocalModels } from "@/search/local-models";

const Tab = createBottomTabNavigator<RootTabParamList>();
const Stack = createNativeStackNavigator<RootStackParamList>();

function MainTabs() {
  const insets = useSafeAreaInsets();

  return (
    <Tab.Navigator
        screenOptions={({ route }) => ({
          headerShown: false,
          tabBarActiveTintColor: colors.primary,
          tabBarInactiveTintColor: colors.textMuted,
          tabBarStyle: {
            backgroundColor: colors.surface,
            borderTopColor: colors.border,
            height: 58 + insets.bottom,
            paddingBottom: Math.max(insets.bottom, 5),
            paddingTop: 4,
          },
          tabBarHideOnKeyboard: true,
          tabBarLabelStyle: { fontSize: 11 },
          tabBarIcon: ({ color, size }) => {
            const icons: Record<keyof RootTabParamList, keyof typeof Ionicons.glyphMap> = {
              Projects: "library-outline",
              Writing: "create-outline",
              Assistant: "sparkles-outline",
              Settings: "settings-outline",
            };
            return <Ionicons name={icons[route.name]} color={color} size={size} />;
          },
        })}
      >
        <Tab.Screen name="Projects" component={ProjectsScreen} options={{ title: "书架" }} />
        <Tab.Screen name="Writing" component={WritingScreen} options={{ title: "写作" }} />
        <Tab.Screen name="Assistant" component={AssistantScreen} options={{ title: "助手" }} />
        <Tab.Screen name="Settings" component={SettingsScreen} options={{ title: "设置" }} />
    </Tab.Navigator>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <KeyboardProvider preserveEdgeToEdge>
        <RuntimeResourceGate />
      </KeyboardProvider>
    </SafeAreaProvider>
  );
}

function RuntimeResourceGate() {
  const [state, setState] = useState<RuntimeResourceState | null>(null);
  const [warmed, setWarmed] = useState(false);
  const [busy, setBusy] = useState(true);
  const [progress, setProgress] = useState("正在检查运行资源…");
  const [error, setError] = useState<string | null>(null);

  const checkAndWarm = useCallback(async () => {
    setBusy(true);
    setWarmed(false);
    setError(null);
    try {
      const next = await getRuntimeResourceState();
      setState(next);
      if (!next.ready) {
        setProgress("部分运行资源尚未安装");
        return;
      }
      setProgress("正在预热本地检索模型…");
      await warmUpLocalModels();
      setWarmed(true);
      setProgress("本地检索模型已就绪");
    } catch (checkError) {
      setError(checkError instanceof Error ? checkError.message : String(checkError));
      setProgress("运行资源检查失败");
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void checkAndWarm();
  }, [checkAndWarm]);

  const download = async () => {
    setBusy(true);
    setWarmed(false);
    setError(null);
    setProgress("准备一键拉取运行资源…");
    try {
      const next = await installMissingRuntimeResources((item) => {
        if (item.totalBytes && item.totalBytes > 0 && item.bytesWritten !== undefined) {
          const percent = Math.min(100, Math.round(item.bytesWritten / item.totalBytes * 100));
          setProgress(`${item.label} · ${percent}%`);
        } else {
          setProgress(item.total > 1 ? `${item.label} · ${item.completed}/${item.total}` : item.label);
        }
      });
      setState(next);
      setProgress("正在预热本地检索模型…");
      await warmUpLocalModels();
      setWarmed(true);
      setProgress("全部运行资源已就绪");
    } catch (downloadError) {
      setError(downloadError instanceof Error ? downloadError.message : String(downloadError));
      setProgress("资源拉取未完成，可稍后继续");
      const next = await getRuntimeResourceState().catch(() => null);
      if (next) setState(next);
    } finally {
      setBusy(false);
    }
  };

  if (!state?.ready || !warmed) {
    const resourcesReady = state?.ready === true;
    return (
      <View style={styles.resourceGate}>
        <StatusBar style="dark" />
        <Text style={styles.resourceTitle}>{resourcesReady ? "预热本地检索" : "准备 OpenFicM"}</Text>
        <Text style={styles.resourceSubtitle}>{resourcesReady ? "运行资源已完整，进入应用前需要加载嵌入和重排模型。" : "首次使用需要下载 Agent、Skill 和本地检索模型。"}</Text>
        <View style={styles.resourceList}>
          {(state?.missing ?? []).map((item) => (
            <View key={item.id} style={styles.resourceRow}>
              <View style={styles.resourceDot} />
              <View style={styles.resourceCopy}>
                <Text style={styles.resourceLabel}>{item.label}</Text>
                <Text style={styles.resourceDetail}>{item.detail}</Text>
              </View>
            </View>
          ))}
        </View>
        <Text style={styles.resourceProgress}>{error ?? progress}</Text>
        <Pressable accessibilityRole="button" disabled={busy} onPress={() => void (resourcesReady ? checkAndWarm() : download())} style={[styles.downloadButton, busy && styles.downloadButtonDisabled]}>
          {busy ? <ActivityIndicator color="#FFFFFF" /> : <Text style={styles.downloadButtonText}>{resourcesReady ? "重新预热" : "一键拉取并预热"}</Text>}
        </Pressable>
        <Pressable accessibilityRole="button" disabled={busy} onPress={() => void checkAndWarm()} style={styles.retryResourceButton}>
          <Text style={styles.retryResourceText}>重新检查</Text>
        </Pressable>
      </View>
    );
  }

  if (busy) {
    return <View style={styles.resourceLoading}><StatusBar style="dark" /><ActivityIndicator size="large" color={colors.primary} /><Text style={styles.resourceProgress}>{progress}</Text></View>;
  }

  return (
    <NavigationContainer>
      <StatusBar style="dark" />
      <Stack.Navigator screenOptions={{ headerShown: false }}>
        <Stack.Screen name="Main" component={MainTabs} />
        <Stack.Screen name="Characters" component={CharactersScreen} />
        <Stack.Screen name="WorldInfo" component={WorldInfoScreen} />
        <Stack.Screen name="StyleLibrary" component={StyleLibraryScreen} />
      </Stack.Navigator>
    </NavigationContainer>
  );
}

const styles = StyleSheet.create({
  resourceGate: { flex: 1, justifyContent: "center", padding: 28, backgroundColor: colors.background },
  resourceLoading: { flex: 1, alignItems: "center", justifyContent: "center", gap: 16, backgroundColor: colors.background },
  resourceTitle: { color: colors.text, fontSize: 28, fontWeight: "800" },
  resourceSubtitle: { marginTop: 10, color: colors.textMuted, fontSize: 15, lineHeight: 22 },
  resourceList: { marginTop: 28, gap: 14 },
  resourceRow: { flexDirection: "row", alignItems: "flex-start", gap: 12 },
  resourceDot: { width: 9, height: 9, marginTop: 6, borderRadius: 5, backgroundColor: colors.primary },
  resourceCopy: { flex: 1, gap: 2 },
  resourceLabel: { color: colors.text, fontSize: 15, fontWeight: "700" },
  resourceDetail: { color: colors.textMuted, fontSize: 12, lineHeight: 18 },
  resourceProgress: { marginTop: 24, color: colors.textMuted, fontSize: 13, lineHeight: 20 },
  downloadButton: { minHeight: 50, alignItems: "center", justifyContent: "center", marginTop: 20, borderRadius: 8, backgroundColor: colors.primary },
  downloadButtonDisabled: { opacity: 0.55 },
  downloadButtonText: { color: "#FFFFFF", fontSize: 15, fontWeight: "700" },
  retryResourceButton: { minHeight: 44, alignItems: "center", justifyContent: "center", marginTop: 8 },
  retryResourceText: { color: colors.primary, fontSize: 14, fontWeight: "700" },
});
