import { Notice, Platform, TFile, TFolder, WorkspaceLeaf } from "obsidian";
import { HISTORY_VIEW_CONFIG, SOURCE_CONTROL_VIEW_CONFIG } from "./constants";
import { SimpleGit } from "./gitManager/simpleGit";
import type { GitRepo } from "./gitRepo";
import ObsidianGit from "./main";
import { openHistoryInGitHub, openLineInGitHub } from "./openInGitHub";
import { ChangedFilesModal } from "./ui/modals/changedFilesModal";
import { RepoSelectorModal } from "./ui/modals/repoSelectorModal";
import { IgnoreModal } from "./ui/modals/ignoreModal";
import { assertNever } from "./utils";
import { togglePreviewHunk } from "./editor/signs/tooltip";

function requireActiveRepo(plugin: ObsidianGit): GitRepo | undefined {
    const repo = plugin.activeRepo();
    if (!repo) {
        new Notice(
            "No active repository. Open a file in a configured repo, set a default repo in settings, or use 'Switch active repo'.",
            8000
        );
        return undefined;
    }
    return repo;
}

function requireRepoForActiveFile(
    plugin: ObsidianGit
): { repo: GitRepo; file: TFile } | undefined {
    const file = plugin.app.workspace.getActiveFile();
    if (!file) {
        new Notice("No active file.", 5000);
        return undefined;
    }
    const repo = plugin.repoForFile(file);
    if (!repo) {
        new Notice(
            `File "${file.path}" is not inside a registered repository.`,
            6000
        );
        return undefined;
    }
    return { repo, file };
}

export function addCommmands(plugin: ObsidianGit) {
    const app = plugin.app;

    plugin.addCommand({
        id: "edit-gitignore",
        name: "Edit .gitignore",
        callback: async () => {
            const repo = requireActiveRepo(plugin);
            if (!repo) return;
            const path = repo.gitManager.getRelativeVaultPath(".gitignore");
            if (!(await app.vault.adapter.exists(path))) {
                await app.vault.adapter.write(path, "");
            }
            const content = await app.vault.adapter.read(path);
            const modal = new IgnoreModal(app, content);
            const res = await modal.openAndGetReslt();
            if (res !== undefined) {
                await app.vault.adapter.write(path, res);
                await plugin.refresh(repo.id);
            }
        },
    });
    plugin.addCommand({
        id: "open-git-view",
        name: "Open source control view",
        callback: async () => {
            const leafs = app.workspace.getLeavesOfType(
                SOURCE_CONTROL_VIEW_CONFIG.type
            );
            let leaf: WorkspaceLeaf;
            if (leafs.length === 0) {
                leaf =
                    app.workspace.getRightLeaf(false) ??
                    app.workspace.getLeaf();
                await leaf.setViewState({
                    type: SOURCE_CONTROL_VIEW_CONFIG.type,
                });
            } else {
                leaf = leafs.first()!;
            }
            await app.workspace.revealLeaf(leaf);

            app.workspace.trigger("obsidian-git:refresh");
        },
    });
    plugin.addCommand({
        id: "open-history-view",
        name: "Open history view",
        callback: async () => {
            const leafs = app.workspace.getLeavesOfType(
                HISTORY_VIEW_CONFIG.type
            );
            let leaf: WorkspaceLeaf;
            if (leafs.length === 0) {
                leaf =
                    app.workspace.getRightLeaf(false) ??
                    app.workspace.getLeaf();
                await leaf.setViewState({
                    type: HISTORY_VIEW_CONFIG.type,
                });
            } else {
                leaf = leafs.first()!;
            }
            await app.workspace.revealLeaf(leaf);

            app.workspace.trigger("obsidian-git:refresh");
        },
    });

    plugin.addCommand({
        id: "open-diff-view",
        name: "Open diff view",
        checkCallback: (checking) => {
            const file = app.workspace.getActiveFile();
            if (checking) {
                return file !== null;
            } else {
                const r = requireRepoForActiveFile(plugin);
                if (!r) return;
                const filePath = r.repo.gitManager.getRelativeRepoPath(
                    r.file.path,
                    true
                );
                plugin.tools.openDiff(
                    {
                        aFile: filePath,
                        aRef: "",
                    },
                    r.repo
                );
            }
        },
    });

    plugin.addCommand({
        id: "view-file-on-github",
        name: "Open file on GitHub",
        editorCallback: (editor, { file }) => {
            if (!file) return;
            const repo = plugin.repoForFile(file);
            if (!repo) return;
            return openLineInGitHub(editor, file, repo.gitManager);
        },
    });

    plugin.addCommand({
        id: "view-history-on-github",
        name: "Open file history on GitHub",
        editorCallback: (_, { file }) => {
            if (!file) return;
            const repo = plugin.repoForFile(file);
            if (!repo) return;
            return openHistoryInGitHub(file, repo.gitManager);
        },
    });

    plugin.addCommand({
        id: "pull",
        name: "Pull",
        callback: () => {
            const repo = requireActiveRepo(plugin);
            if (!repo) return;
            repo.promiseQueue.addTask(() => plugin.pullRepoFromRemote(repo));
        },
    });

    plugin.addCommand({
        id: "fetch",
        name: "Fetch",
        callback: () => {
            const repo = requireActiveRepo(plugin);
            if (!repo) return;
            repo.promiseQueue.addTask(() => plugin.fetchRepo(repo));
        },
    });

    plugin.addCommand({
        id: "switch-to-remote-branch",
        name: "Switch to remote branch",
        callback: () => {
            const repo = requireActiveRepo(plugin);
            if (!repo) return;
            repo.promiseQueue.addTask(() => plugin.switchRemoteBranch());
        },
    });

    plugin.addCommand({
        id: "add-to-gitignore",
        name: "Add file to .gitignore",
        checkCallback: (checking) => {
            const file = app.workspace.getActiveFile();
            if (checking) {
                return file !== null;
            } else {
                plugin
                    .addFileToGitignore(file!.path, file instanceof TFolder)
                    .catch((e) => plugin.displayError(e));
            }
        },
    });

    plugin.addCommand({
        id: "push",
        name: "Commit-and-sync",
        callback: () => {
            const repo = requireActiveRepo(plugin);
            if (!repo) return;
            repo.promiseQueue.addTask(() =>
                plugin.commitAndSyncRepo(repo, { fromAutoBackup: false })
            );
        },
    });

    plugin.addCommand({
        id: "backup-and-close",
        name: "Commit-and-sync and then close Obsidian",
        callback: () => {
            const repo = requireActiveRepo(plugin);
            if (!repo) return;
            repo.promiseQueue.addTask(async () => {
                await plugin.commitAndSyncRepo(repo, { fromAutoBackup: false });
                window.close();
            });
        },
    });

    plugin.addCommand({
        id: "commit-push-specified-message",
        name: "Commit-and-sync with specific message",
        callback: () => {
            const repo = requireActiveRepo(plugin);
            if (!repo) return;
            repo.promiseQueue.addTask(() =>
                plugin.commitAndSyncRepo(repo, {
                    fromAutoBackup: false,
                    requestCustomMessage: true,
                })
            );
        },
    });

    plugin.addCommand({
        id: "commit",
        name: "Commit all changes",
        callback: () => {
            const repo = requireActiveRepo(plugin);
            if (!repo) return;
            repo.promiseQueue.addTask(() =>
                plugin.commitRepo(repo, { fromAuto: false })
            );
        },
    });

    plugin.addCommand({
        id: "commit-specified-message",
        name: "Commit all changes with specific message",
        callback: () => {
            const repo = requireActiveRepo(plugin);
            if (!repo) return;
            repo.promiseQueue.addTask(() =>
                plugin.commitRepo(repo, {
                    fromAuto: false,
                    requestCustomMessage: true,
                })
            );
        },
    });

    plugin.addCommand({
        id: "commit-smart",
        name: "Commit",
        callback: () => {
            const repo = requireActiveRepo(plugin);
            if (!repo) return;
            repo.promiseQueue.addTask(async () => {
                const status = await repo.updateCachedStatus();
                const onlyStaged = status.staged.length > 0;
                return plugin.commitRepo(repo, {
                    fromAuto: false,
                    requestCustomMessage: false,
                    onlyStaged: onlyStaged,
                });
            });
        },
    });

    plugin.addCommand({
        id: "commit-staged",
        name: "Commit staged",
        checkCallback: function (checking) {
            if (checking) return false;
            const repo = requireActiveRepo(plugin);
            if (!repo) return;
            repo.promiseQueue.addTask(async () => {
                return plugin.commitRepo(repo, {
                    fromAuto: false,
                    requestCustomMessage: false,
                });
            });
        },
    });

    if (Platform.isDesktopApp) {
        plugin.addCommand({
            id: "commit-amend-staged-specified-message",
            name: "Amend staged",
            callback: () => {
                const repo = requireActiveRepo(plugin);
                if (!repo) return;
                repo.promiseQueue.addTask(() =>
                    plugin.commitRepo(repo, {
                        fromAuto: false,
                        requestCustomMessage: true,
                        onlyStaged: true,
                        amend: true,
                    })
                );
            },
        });
    }

    plugin.addCommand({
        id: "commit-smart-specified-message",
        name: "Commit with specific message",
        callback: () => {
            const repo = requireActiveRepo(plugin);
            if (!repo) return;
            repo.promiseQueue.addTask(async () => {
                const status = await repo.updateCachedStatus();
                const onlyStaged = status.staged.length > 0;
                return plugin.commitRepo(repo, {
                    fromAuto: false,
                    requestCustomMessage: true,
                    onlyStaged: onlyStaged,
                });
            });
        },
    });

    plugin.addCommand({
        id: "commit-staged-specified-message",
        name: "Commit staged with specific message",
        checkCallback: function (checking) {
            if (checking) return false;
            const repo = requireActiveRepo(plugin);
            if (!repo) return;
            return repo.promiseQueue.addTask(() =>
                plugin.commitRepo(repo, {
                    fromAuto: false,
                    requestCustomMessage: true,
                    onlyStaged: true,
                })
            );
        },
    });

    plugin.addCommand({
        id: "push2",
        name: "Push",
        callback: () => {
            const repo = requireActiveRepo(plugin);
            if (!repo) return;
            repo.promiseQueue.addTask(() => plugin.pushRepo(repo));
        },
    });

    plugin.addCommand({
        id: "stage-current-file",
        name: "Stage current file",
        checkCallback: (checking) => {
            const file = app.workspace.getActiveFile();
            if (checking) {
                return file !== null;
            } else {
                const r = requireRepoForActiveFile(plugin);
                if (!r) return;
                r.repo.promiseQueue.addTask(() =>
                    plugin.stageFile(r.file, r.repo)
                );
            }
        },
    });

    plugin.addCommand({
        id: "unstage-current-file",
        name: "Unstage current file",
        checkCallback: (checking) => {
            const file = app.workspace.getActiveFile();
            if (checking) {
                return file !== null;
            } else {
                const r = requireRepoForActiveFile(plugin);
                if (!r) return;
                r.repo.promiseQueue.addTask(() =>
                    plugin.unstageFile(r.file, r.repo)
                );
            }
        },
    });

    plugin.addCommand({
        id: "edit-remotes",
        name: "Edit remotes",
        callback: () =>
            plugin.editRemotes().catch((e) => plugin.displayError(e)),
    });

    plugin.addCommand({
        id: "remove-remote",
        name: "Remove remote",
        callback: () =>
            plugin.removeRemote().catch((e) => plugin.displayError(e)),
    });

    plugin.addCommand({
        id: "set-upstream-branch",
        name: "Set upstream branch",
        callback: () =>
            plugin.setUpstreamBranch().catch((e) => plugin.displayError(e)),
    });

    plugin.addCommand({
        id: "delete-repo",
        name: "CAUTION: Delete repository",
        callback: () => {
            plugin.promptDeleteRepo().catch((e) => plugin.displayError(e));
        },
    });

    plugin.addCommand({
        id: "init-repo",
        name: "Initialize a new repo",
        callback: () => {
            plugin.promptInitRepo().catch((e) => plugin.displayError(e));
        },
    });

    plugin.addCommand({
        id: "clone-repo",
        name: "Clone an existing remote repo",
        callback: () => {
            plugin.promptCloneRepo().catch((e) => plugin.displayError(e));
        },
    });

    plugin.addCommand({
        id: "list-changed-files",
        name: "List changed files",
        callback: async () => {
            const repo = requireActiveRepo(plugin);
            if (!repo) return;
            if (!repo.ready) return;

            try {
                const status = await repo.updateCachedStatus();
                if (status.changed.length + status.staged.length > 500) {
                    plugin.displayError("Too many changes to display");
                    return;
                }

                new ChangedFilesModal(plugin, status.all).open();
            } catch (e) {
                plugin.displayError(e);
            }
        },
    });

    plugin.addCommand({
        id: "switch-branch",
        name: "Switch branch",
        callback: () => {
            plugin.switchBranch().catch((e) => plugin.displayError(e));
        },
    });

    plugin.addCommand({
        id: "create-branch",
        name: "Create new branch",
        callback: () => {
            plugin.createBranch().catch((e) => plugin.displayError(e));
        },
    });

    plugin.addCommand({
        id: "delete-branch",
        name: "Delete branch",
        callback: () => {
            plugin.deleteBranch().catch((e) => plugin.displayError(e));
        },
    });

    plugin.addCommand({
        id: "discard-all",
        name: "CAUTION: Discard all changes",
        callback: async () => {
            const res = await plugin.discardAll();
            switch (res) {
                case "discard":
                    new Notice("Discarded all changes in tracked files.");
                    break;
                case "delete":
                    new Notice("Discarded all files.");
                    break;
                case false:
                    break;
                default:
                    assertNever(res);
            }
        },
    });

    plugin.addCommand({
        id: "pause-automatic-routines",
        name: "Pause/Resume automatic routines",
        callback: () => {
            const pause = !plugin.localStorage.getPausedAutomatics();
            plugin.localStorage.setPausedAutomatics(pause);
            if (pause) {
                for (const repo of plugin.repos.values()) {
                    repo.automatics.unload();
                }
                new Notice(`Paused automatic routines.`);
            } else {
                for (const repo of plugin.repos.values()) {
                    repo.automatics.reload("commit", "push", "pull");
                }
                new Notice(`Resumed automatic routines.`);
            }
        },
    });

    plugin.addCommand({
        id: "switch-active-repo",
        name: "Switch active repo",
        callback: () => {
            new RepoSelectorModal(plugin).open();
        },
    });

    plugin.addCommand({
        id: "pause-automatics-this-repo",
        name: "Pause automatics for this repo",
        callback: () => {
            const repo = requireActiveRepo(plugin);
            if (!repo) return;
            plugin.localStorage.setAutomaticsPausedForRepo(repo.id, true);
            repo.automatics.unload();
            new Notice(`[${repo.displayName}] Automatics paused.`);
        },
    });

    plugin.addCommand({
        id: "resume-automatics-this-repo",
        name: "Resume automatics for this repo",
        callback: () => {
            const repo = requireActiveRepo(plugin);
            if (!repo) return;
            plugin.localStorage.setAutomaticsPausedForRepo(repo.id, false);
            void repo.automatics.init();
            new Notice(`[${repo.displayName}] Automatics resumed.`);
        },
    });

    plugin.addCommand({
        id: "raw-command",
        name: "Raw command",
        checkCallback: (checking) => {
            const repo = plugin.activeRepo();
            const gitManager = repo?.gitManager;
            if (checking) {
                return gitManager instanceof SimpleGit;
            } else {
                plugin.tools
                    .runRawCommand()
                    .catch((e) => plugin.displayError(e));
            }
        },
    });

    plugin.addCommand({
        id: "toggle-line-author-info",
        name: "Toggle line author information",
        callback: () =>
            plugin.settingsTab?.configureLineAuthorShowStatus(
                !plugin.settings.lineAuthor.show
            ),
    });

    plugin.addCommand({
        id: "reset-hunk",
        name: "Reset hunk",
        editorCheckCallback(checking, _, __) {
            if (checking) {
                return (
                    plugin.settings.hunks.hunkCommands &&
                    plugin.hunkActions.editor !== undefined
                );
            }

            plugin.hunkActions.resetHunk();
        },
    });

    plugin.addCommand({
        id: "stage-hunk",
        name: "Stage hunk",
        editorCheckCallback: (checking, _, __) => {
            if (checking) {
                return (
                    plugin.settings.hunks.hunkCommands &&
                    plugin.hunkActions.editor !== undefined
                );
            }
            const repo = plugin.activeRepo();
            if (!repo) return;
            repo.promiseQueue.addTask(() => plugin.hunkActions.stageHunk());
        },
    });

    plugin.addCommand({
        id: "preview-hunk",
        name: "Preview hunk",
        editorCheckCallback: (checking, _, __) => {
            if (checking) {
                return (
                    plugin.settings.hunks.hunkCommands &&
                    plugin.hunkActions.editor !== undefined
                );
            }
            const editor = plugin.hunkActions.editor!.editor;
            togglePreviewHunk(editor);
        },
    });

    plugin.addCommand({
        id: "next-hunk",
        name: "Go to next hunk",
        editorCheckCallback: (checking, _, __) => {
            if (checking) {
                return (
                    plugin.settings.hunks.hunkCommands &&
                    plugin.hunkActions.editor !== undefined
                );
            }
            plugin.hunkActions.goToHunk("next");
        },
    });

    plugin.addCommand({
        id: "prev-hunk",
        name: "Go to previous hunk",
        editorCheckCallback: (checking, _, __) => {
            if (checking) {
                return (
                    plugin.settings.hunks.hunkCommands &&
                    plugin.hunkActions.editor !== undefined
                );
            }
            plugin.hunkActions.goToHunk("prev");
        },
    });
}
