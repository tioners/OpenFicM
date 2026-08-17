export type ProviderType = "openai-compatible" | "google-genai" | "anthropic";

export interface Project {
  id: string;
  title: string;
  description: string;
  createdAt: string;
  updatedAt: string;
}

export interface Volume {
  id: string;
  projectId: string;
  title: string;
  orderIndex: number;
}

export interface Chapter {
  id: string;
  projectId: string;
  volumeId: string;
  title: string;
  content: string;
  orderIndex: number;
  updatedAt: string;
}

export interface Provider {
  id: string;
  name: string;
  type: ProviderType;
  baseUrl: string;
  apiKeyRef: string;
  createdAt: string;
}

export interface Model {
  id: string;
  providerId: string;
  name: string;
  modelId: string;
  temperature: number;
  maxTokens: number;
}

export interface ChatSession {
  id: string;
  projectId: string;
  title: string;
  modelId: string | null;
  createdAt: string;
  updatedAt: string;
}

export type AgentRunStatus = "running" | "completed" | "error";
export type AgentTraceEventStatus = "running" | "waiting" | "completed" | "error";
export type AgentTraceEventKind = "agent" | "tool" | "skill" | "question" | "consistency";

export interface AgentTraceEvent {
  id: string;
  kind: AgentTraceEventKind;
  status: AgentTraceEventStatus;
  title: string;
  agentName: string;
  toolName?: string;
  detail?: string;
  input?: string;
  output?: string;
  startedAt: string;
  completedAt?: string;
}

export interface AgentRunTrace {
  version: 1;
  id: string;
  status: AgentRunStatus;
  primaryAgentId: string;
  primaryAgentName: string;
  collaborationRequired: boolean;
  startedAt: string;
  completedAt?: string;
  events: AgentTraceEvent[];
}

export interface AgentClarificationOption {
  label: string;
  description?: string;
}

export interface AgentClarificationQuestion {
  title: string;
  description?: string;
  options: AgentClarificationOption[];
}

export interface AgentClarificationAnswer {
  question: string;
  answer: string;
}

export interface AgentClarificationRequest {
  id: string;
  agentName: string;
  questions: AgentClarificationQuestion[];
}

export interface AgentClarificationResponse {
  answers: AgentClarificationAnswer[];
  cancelled: boolean;
}

export interface ChatMessageMetadata {
  agentTrace?: AgentRunTrace;
}

export interface ChatMessage {
  id: string;
  projectId: string;
  sessionId: string;
  role: "user" | "assistant" | "system";
  content: string;
  metadata: ChatMessageMetadata | null;
  createdAt: string;
}

export interface Character {
  id: string;
  projectId: string;
  name: string;
  description: string;
  imagePath: string | null;
  isFavorited: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface WorldInfo {
  id: string;
  projectId: string;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorldInfoEntry {
  id: string;
  worldInfoId: string;
  uid: number;
  name: string;
  order: number;
  content: string;
  tokenCount: number;
  isEnabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export type IndexSourceType = "chapter" | "character" | "world-entry";

export interface LocalSearchResult {
  id: string;
  sourceType: IndexSourceType;
  sourceId: string;
  title: string;
  content: string;
  score: number;
  rerankScore?: number;
}

export interface ModelSelection {
  provider: Provider;
  model: Model;
  apiKey: string;
}
