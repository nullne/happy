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

function randomId(length: number): string {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < length; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

/**
 * Set up a session directory for a project-bound session:
 * Directory: {workspaceRoot}/{project-slug}/{session-id}
 * Each session gets its own fresh clone with a new branch.
 *
 * Uses "/" as cwd to bypass daemon path validation, since workspaceRoot
 * may be outside the daemon's process.cwd().
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

    // Ensure session directory exists
    await machineBash(machineId, `mkdir -p "${sessionDir}"`, '/');

    if (!project.githubUrl) {
        return { success: true, directory: sessionDir, branch: '' };
    }

    // Clone repo into the session directory
    const cloneResult = await machineBash(
        machineId,
        `git clone "${project.githubUrl}" "${sessionDir}"`,
        '/',
        { timeout: 300000 }
    );
    if (!cloneResult.success) {
        const errorDetail = cloneResult.stderr || cloneResult.stdout || 'Unknown error';
        return {
            success: false,
            directory: sessionDir,
            branch: '',
            error: `Failed to clone: ${errorDetail}`
        };
    }

    // Create a new branch for this session
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
