import { create } from "zustand";

interface AppState {
  currentProjectId: string | null;
  currentChapterId: string | null;
  dataRevision: number;
  setCurrentProject: (projectId: string | null) => void;
  setCurrentChapter: (chapterId: string | null) => void;
  refreshData: () => void;
}

export const useAppStore = create<AppState>((set) => ({
  currentProjectId: null,
  currentChapterId: null,
  dataRevision: 0,
  setCurrentProject: (currentProjectId) => set({ currentProjectId, currentChapterId: null }),
  setCurrentChapter: (currentChapterId) => set({ currentChapterId }),
  refreshData: () => set((state) => ({ dataRevision: state.dataRevision + 1 })),
}));
