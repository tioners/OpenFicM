import { Ionicons } from "@expo/vector-icons";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { StatusBar } from "expo-status-bar";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { SafeAreaProvider, useSafeAreaInsets } from "react-native-safe-area-context";

import type { RootStackParamList, RootTabParamList } from "@/navigation/types";
import { CharactersScreen } from "@/screens/characters-screen";
import { AssistantScreen } from "@/screens/assistant-screen";
import { ProjectsScreen } from "@/screens/projects-screen";
import { SettingsScreen } from "@/screens/settings-screen";
import { WritingScreen } from "@/screens/writing-screen";
import { WorldInfoScreen } from "@/screens/world-info-screen";
import { colors } from "@/theme";

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
        <NavigationContainer>
          <StatusBar style="dark" />
          <Stack.Navigator screenOptions={{ headerShown: false }}>
            <Stack.Screen name="Main" component={MainTabs} />
            <Stack.Screen name="Characters" component={CharactersScreen} />
            <Stack.Screen name="WorldInfo" component={WorldInfoScreen} />
          </Stack.Navigator>
        </NavigationContainer>
      </KeyboardProvider>
    </SafeAreaProvider>
  );
}
