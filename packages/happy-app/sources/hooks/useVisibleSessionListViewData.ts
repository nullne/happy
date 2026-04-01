import * as React from 'react';
import { SessionListViewItem, useSessionListViewData, useSetting } from '@/sync/storage';
import { useActiveProjectStore } from '@/hooks/useActiveProject';

export function useVisibleSessionListViewData(): SessionListViewItem[] | null {
    const data = useSessionListViewData();
    const hideInactiveSessions = useSetting('hideInactiveSessions');
    const activeProjectId = useActiveProjectStore(s => s.activeProjectId);

    return React.useMemo(() => {
        if (!data) {
            return data;
        }

        let result = data;

        // Filter by active project
        if (activeProjectId) {
            const projectFiltered: SessionListViewItem[] = [];
            for (const item of result) {
                if (item.type === 'active-sessions') {
                    const filtered = item.sessions.filter(s => s.projectId === activeProjectId);
                    if (filtered.length > 0) {
                        projectFiltered.push({ ...item, sessions: filtered });
                    }
                } else if (item.type === 'session') {
                    if (item.session.projectId === activeProjectId) {
                        projectFiltered.push(item);
                    }
                } else if (item.type === 'header') {
                    projectFiltered.push(item);
                } else if (item.type === 'project-group') {
                    projectFiltered.push(item);
                }
            }
            // Remove headers with no sessions after them
            result = cleanupEmptyHeaders(projectFiltered);
        }

        if (!hideInactiveSessions) {
            return result;
        }

        const filtered: SessionListViewItem[] = [];
        let pendingProjectGroup: SessionListViewItem | null = null;

        for (const item of result) {
            if (item.type === 'project-group') {
                pendingProjectGroup = item;
                continue;
            }

            if (item.type === 'session') {
                if (item.session.active) {
                    if (pendingProjectGroup) {
                        filtered.push(pendingProjectGroup);
                        pendingProjectGroup = null;
                    }
                    filtered.push(item);
                }
                continue;
            }

            pendingProjectGroup = null;

            if (item.type === 'active-sessions') {
                filtered.push(item);
            }
        }

        return filtered;
    }, [data, hideInactiveSessions, activeProjectId]);
}

function cleanupEmptyHeaders(items: SessionListViewItem[]): SessionListViewItem[] {
    const result: SessionListViewItem[] = [];
    for (let i = 0; i < items.length; i++) {
        if (items[i].type === 'header') {
            const next = items[i + 1];
            if (next && (next.type === 'session' || next.type === 'active-sessions')) {
                result.push(items[i]);
            }
        } else {
            result.push(items[i]);
        }
    }
    return result;
}
