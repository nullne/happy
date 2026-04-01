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
 * Set up a project directory for a new session:
 * 1. Clone the repo if not already cloned
 * 2. Fetch latest and reset to main/master
 * 3. Create a new branch for this session
 */
export async function setupProjectSession(
    machineId: string,
    workspaceRoot: string,
    project: ProjectConfig,
    promptHint: string
): Promise<{ success: boolean; directory: string; branch: string; error?: string }> {
    const projectSlug = slugify(project.name);
    const projectDir = `${workspaceRoot}/${projectSlug}`;
    const branchSlug = slugify(promptHint.slice(0, 40));
    const branchName = `session/${branchSlug}-${randomId(6)}`;

    // Ensure project directory exists
    await machineBash(machineId, `mkdir -p "${projectDir}"`, workspaceRoot);

    if (!project.githubUrl) {
        return { success: true, directory: projectDir, branch: '' };
    }

    // Check if repo is already cloned
    const gitCheck = await machineBash(machineId, 'git rev-parse --git-dir', projectDir);

    if (!gitCheck.success) {
        // Clone the repo
        const cloneResult = await machineBash(
            machineId,
            `git clone "${project.githubUrl}" .`,
            projectDir
        );
        if (!cloneResult.success) {
            return {
                success: false,
                directory: projectDir,
                branch: '',
                error: `Failed to clone: ${cloneResult.stderr}`
            };
        }
    } else {
        // Already cloned — fetch latest and checkout default branch
        const fetchResult = await machineBash(
            machineId,
            'git fetch origin',
            projectDir
        );
        if (!fetchResult.success) {
            return {
                success: false,
                directory: projectDir,
                branch: '',
                error: `Failed to fetch: ${fetchResult.stderr}`
            };
        }

        // Detect default branch (main or master)
        const defaultBranch = await detectDefaultBranch(machineId, projectDir);
        await machineBash(machineId, `git checkout ${defaultBranch} && git pull origin ${defaultBranch}`, projectDir);
    }

    // Create a new branch for this session
    const defaultBranch = await detectDefaultBranch(machineId, projectDir);
    const branchResult = await machineBash(
        machineId,
        `git checkout -b "${branchName}" "origin/${defaultBranch}"`,
        projectDir
    );
    if (!branchResult.success) {
        return {
            success: false,
            directory: projectDir,
            branch: '',
            error: `Failed to create branch: ${branchResult.stderr}`
        };
    }

    return { success: true, directory: projectDir, branch: branchName };
}

async function detectDefaultBranch(machineId: string, cwd: string): Promise<string> {
    const result = await machineBash(
        machineId,
        'git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed "s@^refs/remotes/origin/@@" || echo main',
        cwd
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
        `git push -u origin "${branch}"`,
        directory
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
    githubUrl: string,
): Promise<string | null> {
    // Try gh CLI first
    const ghResult = await machineBash(
        machineId,
        `gh pr view "${branch}" --json url -q .url 2>/dev/null`,
        directory
    );
    if (ghResult.success && ghResult.stdout.trim().startsWith('http')) {
        return ghResult.stdout.trim();
    }

    return null;
}
