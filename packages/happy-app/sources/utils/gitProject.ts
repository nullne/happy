/**
 * Git project operations: clone, branch setup for project-bound sessions.
 * Uses machineBash RPC to run git commands on the daemon machine.
 */

import { machineBash } from '@/sync/ops';
import { ProjectConfig } from '@/sync/apiProjects';

function slugify(text: string): string {
    return text.toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 60);
}

/** Extract repo name from GitHub URL: https://github.com/org/repo.git → repo */
function repoNameFromUrl(githubUrl: string): string {
    const match = githubUrl.match(/\/([^/]+?)(?:\.git)?$/);
    return match ? match[1] : slugify(githubUrl);
}

function randomId(length: number): string {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < length; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

/**
 * Set up a session directory for a project-bound session.
 *
 * Layout:
 *   {workspaceRoot}/{project-slug}/repos/{repo-name}  — cached clone per repo, kept on latest main
 *   {workspaceRoot}/{project-slug}/{session-id}        — per-session working copy (cp from cache)
 *
 * Supports multiple repos per project in the future.
 * First session: clones into repos/{name}.
 * Subsequent sessions: fetches latest in cache, then cp -r to session dir.
 */
export async function setupProjectSession(
    machineId: string,
    workspaceRoot: string,
    project: ProjectConfig,
    sessionId: string
): Promise<{ success: boolean; directory: string; branch: string; error?: string }> {
    const projectSlug = slugify(project.name);
    const sessionDir = `${workspaceRoot}/${projectSlug}/${sessionId}`;
    const branchName = `session/${sessionId}`;

    if (!project.githubUrl) {
        await machineBash(machineId, `mkdir -p "${sessionDir}"`, '/');
        return { success: true, directory: sessionDir, branch: '' };
    }

    const repoName = repoNameFromUrl(project.githubUrl);
    const cacheDir = `${workspaceRoot}/${projectSlug}/repos/${repoName}`;

    // Step 1: ensure cached repo exists and is up to date
    const cacheCheck = await machineBash(machineId, `git -C "${cacheDir}" rev-parse --git-dir`, '/');

    if (!cacheCheck.success) {
        await machineBash(machineId, `mkdir -p "${cacheDir}"`, '/');
        const cloneResult = await machineBash(
            machineId,
            `git clone "${project.githubUrl}" "${cacheDir}"`,
            '/',
            { timeout: 300000 }
        );
        if (!cloneResult.success) {
            return {
                success: false,
                directory: sessionDir,
                branch: '',
                error: `Failed to clone: ${cloneResult.stderr || cloneResult.stdout || 'Unknown error'}`
            };
        }
    } else {
        const defaultBranch = await detectDefaultBranch(machineId, cacheDir);
        await machineBash(
            machineId,
            `git -C "${cacheDir}" fetch origin && git -C "${cacheDir}" checkout ${defaultBranch} && git -C "${cacheDir}" reset --hard "origin/${defaultBranch}"`,
            '/',
            { timeout: 120000 }
        );
    }

    // Step 2: copy cached repo to session directory
    const copyResult = await machineBash(
        machineId,
        `cp -r "${cacheDir}" "${sessionDir}"`,
        '/',
        { timeout: 60000 }
    );
    if (!copyResult.success) {
        return {
            success: false,
            directory: sessionDir,
            branch: '',
            error: `Failed to copy repo: ${copyResult.stderr || 'Unknown error'}`
        };
    }

    // Step 3: create session branch in the working copy
    const defaultBranch = await detectDefaultBranch(machineId, sessionDir);
    const branchResult = await machineBash(
        machineId,
        `git -C "${sessionDir}" checkout -b "${branchName}" "origin/${defaultBranch}"`,
        '/'
    );
    if (!branchResult.success) {
        return {
            success: false,
            directory: sessionDir,
            branch: '',
            error: `Failed to create branch: ${branchResult.stderr}`
        };
    }

    return { success: true, directory: sessionDir, branch: branchName };
}

async function detectDefaultBranch(machineId: string, projectDir: string): Promise<string> {
    const result = await machineBash(
        machineId,
        `git -C "${projectDir}" symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed "s@^refs/remotes/origin/@@" || echo main`,
        '/'
    );
    const branch = result.stdout.trim();
    return branch || 'main';
}

/**
 * Push the current branch and return a compare URL for PR creation.
 */
export async function pushAndGetPRUrl(
    machineId: string,
    directory: string,
    branch: string,
    githubUrl: string,
): Promise<{ success: boolean; url: string; error?: string }> {
    const pushResult = await machineBash(
        machineId,
        `git -C "${directory}" push -u origin "${branch}"`,
        '/',
        { timeout: 120000 }
    );
    if (!pushResult.success) {
        return { success: false, url: '', error: `Failed to push: ${pushResult.stderr}` };
    }

    const repoUrl = githubUrl.replace(/\.git$/, '');
    const defaultBranch = await detectDefaultBranch(machineId, directory);
    const compareUrl = `${repoUrl}/compare/${defaultBranch}...${encodeURIComponent(branch)}?expand=1`;

    return { success: true, url: compareUrl };
}

/**
 * Check if a PR already exists for the branch and return its URL.
 */
export async function getExistingPRUrl(
    machineId: string,
    directory: string,
    branch: string,
    _githubUrl: string,
): Promise<string | null> {
    const ghResult = await machineBash(
        machineId,
        `cd "${directory}" && gh pr view "${branch}" --json url -q .url 2>/dev/null`,
        '/'
    );
    if (ghResult.success && ghResult.stdout.trim().startsWith('http')) {
        return ghResult.stdout.trim();
    }

    return null;
}
