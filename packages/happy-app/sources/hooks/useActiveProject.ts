/**
 * Global active project context.
 * Like GCP's project selector — one project active at a time,
 * affects session list filtering and new session defaults.
 */
import { create } from 'zustand';
import { ProjectConfig, fetchProjects } from '@/sync/apiProjects';
import { AuthCredentials } from '@/auth/tokenStorage';

interface ActiveProjectState {
    projects: ProjectConfig[];
    projectsLoading: boolean;
    activeProjectId: string | null;

    setProjects: (projects: ProjectConfig[]) => void;
    setProjectsLoading: (loading: boolean) => void;
    setActiveProjectId: (id: string | null) => void;
}

export const useActiveProjectStore = create<ActiveProjectState>((set) => ({
    projects: [],
    projectsLoading: false,
    activeProjectId: null,

    setProjects: (projects) => set({ projects }),
    setProjectsLoading: (loading) => set({ projectsLoading: loading }),
    setActiveProjectId: (id) => set({ activeProjectId: id }),
}));

export function useActiveProject(): ProjectConfig | null {
    const projects = useActiveProjectStore(s => s.projects);
    const activeProjectId = useActiveProjectStore(s => s.activeProjectId);
    return projects.find(p => p.id === activeProjectId) ?? null;
}

export function useProjects(): ProjectConfig[] {
    return useActiveProjectStore(s => s.projects);
}

export async function loadProjects(credentials: AuthCredentials): Promise<void> {
    const store = useActiveProjectStore.getState();
    store.setProjectsLoading(true);
    try {
        const projects = await fetchProjects(credentials);
        store.setProjects(projects);
        if (!store.activeProjectId && projects.length > 0) {
            store.setActiveProjectId(projects[0].id);
        }
    } finally {
        store.setProjectsLoading(false);
    }
}
