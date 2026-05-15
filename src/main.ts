import { Errors } from "isomorphic-git";
import type { Debouncer, Menu, TAbstractFile, WorkspaceLeaf } from "obsidian";
import {
    debounce,
    FileSystemAdapter,
    MarkdownView,
    normalizePath,
    Notice,
    Platform,
    Plugin,
    TFile,
    TFolder,
    moment,
} from "obsidian";
import * as path from "path";
import * as fsPromises from "fs/promises";
import { pluginRef } from "src/pluginGlobalRef";
import { PromiseQueue } from "src/promiseQueue";
import { ObsidianGitSettingsTab } from "src/setting/settings";
import { StatusBar } from "src/statusBar";
import { CustomMessageModal } from "src/ui/modals/customMessageModal";
import { GitRepo } from "./gitRepo";
import type AutomaticsManager from "./automaticsManager";
import { addCommmands } from "./commands";
import {
    CONFLICT_OUTPUT_FILE,
    DEFAULT_SETTINGS,
    DIFF_VIEW_CONFIG,
    HISTORY_VIEW_CONFIG,
    SOURCE_CONTROL_VIEW_CONFIG,
    SPLIT_DIFF_VIEW_CONFIG,
} from "./constants";
import type { GitManager } from "./gitManager/gitManager";
import { IsomorphicGit } from "./gitManager/isomorphicGit";
import { SimpleGit } from "./gitManager/simpleGit";
import { LocalStorageSettings } from "./setting/localStorageSettings";
import Tools from "./tools";
import type {
    FileStatusResult,
    ObsidianGitSettings,
    PerRepoSettings,
    PluginState,
    RepoConfig,
    Status,
    SyncMethod,
    UnstagedFile,
} from "./types";
import {
    CurrentGitAction,
    mergeSettingsByPriority,
    NoNetworkError,
} from "./types";
import {
    defaultDisplayName,
    newRepoId,
    normalizeRepoPath,
    repoPathsOverlap,
    vaultPathInRepo,
} from "./utils/repoPath";
import DiffView from "./ui/diff/diffView";
import SplitDiffView from "./ui/diff/splitDiffView";
import HistoryView from "./ui/history/historyView";
import { BranchModal } from "./ui/modals/branchModal";
import { GeneralModal } from "./ui/modals/generalModal";
import GitView from "./ui/sourceControl/sourceControl";
import { BranchStatusBar } from "./ui/statusBar/branchStatusBar";
import {
    assertNever,
    convertPathToAbsoluteGitignoreRule,
    formatRemoteUrl,
    spawnAsync,
    splitRemoteBranch,
} from "./utils";
import { DiscardModal, type DiscardResult } from "./ui/modals/discardModal";
import { HunkActions } from "./editor/signs/hunkActions";
import { EditorIntegration } from "./editor/editorIntegration";

export default class ObsidianGit extends Plugin {
    /** All registered repos, keyed by id. */
    repos: Map<string, GitRepo> = new Map();
    /** Stable display order matching `settings.repos`. */
    repoOrder: string[] = [];
    /** Per-repo debouncers for source-control refresh. */
    repoDebouncers: Map<string, Debouncer<[], void>> = new Map();

    /**
     * @deprecated Use `repoForFile` / `activeRepo` instead.
     * Retained as a compatibility shim. Returns the gitManager of `activeRepo()`.
     */
    get gitManager(): GitManager {
        const repo = this.activeRepo();
        // Type assertion because callers expect non-null; if no repo is registered
        // upstream methods short-circuit via gitReady.
        return repo?.gitManager as GitManager;
    }

    tools = new Tools(this);
    localStorage = new LocalStorageSettings(this);
    settings: ObsidianGitSettings;
    settingsTab?: ObsidianGitSettingsTab;
    statusBar?: StatusBar;
    branchBar?: BranchStatusBar;
    state: PluginState = {
        gitAction: CurrentGitAction.idle,
        offlineMode: false,
    };
    lastPulledFiles: FileStatusResult[];
    gitReady = false;

    /**
     * @deprecated Use `repo.promiseQueue` instead. Shim that targets the active repo.
     */
    get promiseQueue(): PromiseQueue {
        return this.activeRepo()?.promiseQueue ?? this._fallbackQueue;
    }
    private _fallbackQueue: PromiseQueue = new PromiseQueue(this);

    /**
     * @deprecated Use `repo.cachedStatus` instead. Shim that targets the active repo.
     */
    get cachedStatus(): Status | undefined {
        return this.activeRepo()?.cachedStatus;
    }
    set cachedStatus(value: Status | undefined) {
        const repo = this.activeRepo();
        if (repo) repo.cachedStatus = value;
    }

    /**
     * @deprecated Use `repo.automatics` instead. Shim that targets the active repo.
     */
    get automaticsManager(): AutomaticsManager | undefined {
        return this.activeRepo()?.automatics;
    }

    /**
     * @deprecated Debouncer is now per-repo (`repo.automatics.autoCommitDebouncer`).
     */
    get autoCommitDebouncer(): Debouncer<[], void> | undefined {
        return this.activeRepo()?.automatics.autoCommitDebouncer;
    }
    set autoCommitDebouncer(value: Debouncer<[], void> | undefined) {
        const repo = this.activeRepo();
        if (repo) repo.automatics.autoCommitDebouncer = value;
    }

    // Used to store the path of the file that is currently shown in the diff view.
    lastDiffViewState: Record<string, unknown> | undefined;
    intervalsToClear: number[] = [];
    editorIntegration: EditorIntegration = new EditorIntegration(this);
    hunkActions = new HunkActions(this);

    /**
     * @deprecated Debouncer is now per-repo (`repo.fileEventDebouncer`).
     * Shim returns the active repo's debouncer when present.
     */
    get debRefresh(): Debouncer<[], void> | undefined {
        return this.activeRepo()?.fileEventDebouncer;
    }

    setPluginState(state: Partial<PluginState>): void {
        this.state = Object.assign(this.state, state);
        // Mirror onto active repo for consistency
        const repo = this.activeRepo();
        if (repo) repo.state = Object.assign(repo.state, state);
        this.statusBar?.display();
    }

    /**
     * Longest-prefix lookup of the repo that owns `vaultPath`.
     * `""` (root) is the last-resort match.
     */
    repoForVaultPath(vaultPath: string): GitRepo | undefined {
        const candidates: GitRepo[] = [];
        for (const repo of this.repos.values()) {
            if (vaultPathInRepo(vaultPath, repo.config.path)) {
                candidates.push(repo);
            }
        }
        if (candidates.length === 0) return undefined;
        candidates.sort((a, b) => b.config.path.length - a.config.path.length);
        return candidates[0];
    }

    repoForFile(file: TAbstractFile | null | undefined): GitRepo | undefined {
        if (!file) return undefined;
        return this.repoForVaultPath(file.path);
    }

    /**
     * Resolve the "active" repo for repo-targeted commands.
     * 1. localStorage override (if the repo still exists)
     * 2. repo of the currently active file
     * 3. configured default repo
     * 4. undefined
     */
    activeRepo(): GitRepo | undefined {
        const overrideId = this.localStorage.getActiveRepoOverride();
        if (overrideId) {
            const repo = this.repos.get(overrideId);
            if (repo) return repo;
            this.localStorage.setActiveRepoOverride(null);
        }
        const activeFile = this.app.workspace.getActiveFile();
        if (activeFile) {
            const repo = this.repoForFile(activeFile);
            if (repo) return repo;
        }
        const defaultId = this.settings.defaultRepoId;
        if (defaultId) {
            const repo = this.repos.get(defaultId);
            if (repo) return repo;
        }
        // Fall back to the first repo if nothing else matches.
        return this.repos.values().next().value as GitRepo | undefined;
    }

    /**
     * Build a fresh GitRepo from a RepoConfig, register it, init it, surface errors.
     * Does not save settings (caller is responsible for persistence).
     */
    async registerRepo(config: RepoConfig): Promise<GitRepo> {
        const repo = new GitRepo(this, config);
        const result = await repo.init();
        switch (result) {
            case "missing-git":
                this.displayError(
                    `[${config.displayName}] Cannot run git command. Trying to run: '${
                        this.localStorage.getGitPath() || "git"
                    }'.`
                );
                break;
            case "missing-repo":
                new Notice(
                    `[${config.displayName}] No valid git repository at "${config.path || "<vault root>"}". Initialize or clone first.`,
                    10000
                );
                break;
        }
        this.repos.set(repo.id, repo);
        if (!this.repoOrder.includes(repo.id)) {
            this.repoOrder.push(repo.id);
        }
        this.setRepoDebouncer(repo);
        if (repo.ready) {
            const pausedGlobal = this.localStorage.getPausedAutomatics();
            const pausedRepo = this.localStorage.isAutomaticsPausedForRepo(
                repo.id
            );
            if (!pausedGlobal && !pausedRepo) {
                await repo.automatics.init();
            }
        }
        return repo;
    }

    /** Remove a repo at runtime. Caller is responsible for saving settings. */
    unregisterRepo(id: string): void {
        const repo = this.repos.get(id);
        if (!repo) return;
        this.repoDebouncers.get(id)?.cancel();
        this.repoDebouncers.delete(id);
        repo.unload();
        this.repos.delete(id);
        const idx = this.repoOrder.indexOf(id);
        if (idx >= 0) this.repoOrder.splice(idx, 1);
        // Reassign default if needed.
        if (this.settings.defaultRepoId === id) {
            this.settings.defaultRepoId = this.repoOrder[0] ?? null;
        }
    }

    setRepoDebouncer(repo: GitRepo): void {
        const existing = this.repoDebouncers.get(repo.id);
        existing?.cancel();
        const debouncer = debounce(
            () => {
                if (this.settings.refreshSourceControl) {
                    this.refresh(repo.id).catch(console.error);
                }
            },
            this.settings.refreshSourceControlTimer,
            true
        );
        this.repoDebouncers.set(repo.id, debouncer);
        repo.fileEventDebouncer = debouncer;
    }

    async pullRepoFromRemote(repo: GitRepo): Promise<void> {
        if (!repo.ready) return;
        try {
            const filesUpdated = await repo.gitManager.pull();
            if (filesUpdated === undefined || filesUpdated === null) return;
            if (filesUpdated.length === 0) {
                this.displayMessage(
                    `[${repo.displayName}] Pull: Everything is up-to-date`
                );
            }
            this.app.workspace.trigger("obsidian-git:refresh", repo.id);
        } catch (e) {
            this.displayError(e);
        }
    }

    async pushRepo(repo: GitRepo): Promise<void> {
        if (!repo.ready) return;
        try {
            const result = await repo.gitManager.push();
            if (typeof result === "number") {
                this.displayMessage(
                    `[${repo.displayName}] Pushed ${result} files.`
                );
            }
            this.app.workspace.trigger("obsidian-git:refresh", repo.id);
        } catch (e) {
            this.displayError(e);
        }
    }

    async fetchRepo(repo: GitRepo): Promise<void> {
        if (!repo.ready) return;
        try {
            await repo.gitManager.fetch();
            this.displayMessage(`[${repo.displayName}] Fetched from remote`);
            this.app.workspace.trigger("obsidian-git:refresh", repo.id);
        } catch (e) {
            this.displayError(e);
        }
    }

    /**
     * Per-repo commit. Mirrors the legacy `commit()` method but targets the given repo.
     * Reads per-repo settings from `repo.settings`.
     */
    async commitRepo(
        repo: GitRepo,
        {
            fromAuto,
            requestCustomMessage = false,
            onlyStaged = false,
            commitMessage,
            amend = false,
        }: {
            fromAuto: boolean;
            requestCustomMessage?: boolean;
            onlyStaged?: boolean;
            commitMessage?: string;
            amend?: boolean;
        }
    ): Promise<boolean> {
        // Active-repo override: temporarily target the requested repo so the legacy
        // implementation (which reads `this.gitManager` etc.) operates on it.
        const previous = this.localStorage.getActiveRepoOverride();
        this.localStorage.setActiveRepoOverride(repo.id);
        try {
            return await this.commit({
                fromAuto,
                requestCustomMessage,
                onlyStaged,
                commitMessage,
                amend,
            });
        } finally {
            this.localStorage.setActiveRepoOverride(previous);
        }
    }

    async commitAndSyncRepo(
        repo: GitRepo,
        opts: {
            fromAutoBackup: boolean;
            requestCustomMessage?: boolean;
            commitMessage?: string;
            onlyStaged?: boolean;
        }
    ): Promise<void> {
        const previous = this.localStorage.getActiveRepoOverride();
        this.localStorage.setActiveRepoOverride(repo.id);
        try {
            await this.commitAndSync(opts);
        } finally {
            this.localStorage.setActiveRepoOverride(previous);
        }
    }

    /** True if any open Source Control or History view shows `repo`. */
    private hasOpenViewForRepo(_repo: GitRepo): boolean {
        const gitViews = this.app.workspace.getLeavesOfType(
            SOURCE_CONTROL_VIEW_CONFIG.type
        );
        const historyViews = this.app.workspace.getLeavesOfType(
            HISTORY_VIEW_CONFIG.type
        );
        return (
            gitViews.some((leaf) => !(leaf.isDeferred ?? false)) ||
            historyViews.some((leaf) => !(leaf.isDeferred ?? false))
        );
    }

    async updateCachedStatus(): Promise<Status> {
        const repo = this.activeRepo();
        if (!repo) {
            throw new Error("No active repository.");
        }
        const status = await repo.updateCachedStatus();
        if (status.conflicted.length > 0) {
            this.localStorage.setConflict(true);
        } else {
            this.localStorage.setConflict(false);
        }
        await this.branchBar?.display();
        return status;
    }

    async refresh(repoId?: string) {
        if (!this.gitReady) return;
        const repos = repoId
            ? ([this.repos.get(repoId)].filter(Boolean) as GitRepo[])
            : Array.from(this.repos.values());
        for (const repo of repos) {
            if (
                this.settings.changedFilesInStatusBar ||
                this.hasOpenViewForRepo(repo)
            ) {
                await repo
                    .updateCachedStatus()
                    .catch((e) => this.displayError(e));
            }
        }
        this.app.workspace.trigger("obsidian-git:refreshed", repoId);

        // We don't put a line authoring refresh here, as it would force a re-loading
        // of the line authoring feature - which would lead to a jumpy editor-view in the
        // ui after every rename event.
    }

    refreshUpdatedHead() {}

    async onload() {
        console.log(
            "loading " +
                this.manifest.name +
                " plugin: v" +
                this.manifest.version
        );

        pluginRef.plugin = this;

        this.localStorage.migrate();
        await this.loadSettings();
        await this.migrateSettings();

        this.settingsTab = new ObsidianGitSettingsTab(this.app, this);
        this.addSettingTab(this.settingsTab);

        if (!this.localStorage.getPluginDisabled()) {
            this.registerStuff();

            this.app.workspace.onLayoutReady(() =>
                this.init({ fromReload: false }).catch((e) =>
                    this.displayError(e)
                )
            );
        }
    }

    onExternalSettingsChange() {
        this.reloadSettings().catch((e) => this.displayError(e));
    }

    /** Reloads the settings from disk and applies them by unloading the plugin
     * and initializing it again.
     */
    async reloadSettings(): Promise<void> {
        const previousSettings = JSON.stringify(this.settings);

        await this.loadSettings();

        const newSettings = JSON.stringify(this.settings);

        // Only reload plugin if the settings have actually changed
        if (previousSettings !== newSettings) {
            this.log("Reloading settings");

            this.unloadPlugin();

            await this.init({ fromReload: true });

            this.app.workspace
                .getLeavesOfType(SOURCE_CONTROL_VIEW_CONFIG.type)
                .forEach((leaf) => {
                    if (!(leaf.isDeferred ?? false))
                        return (leaf.view as GitView).reload();
                });

            this.app.workspace
                .getLeavesOfType(HISTORY_VIEW_CONFIG.type)
                .forEach((leaf) => {
                    if (!(leaf.isDeferred ?? false))
                        return (leaf.view as HistoryView).reload();
                });
        }
    }

    /** This method only registers events, views, commands and more.
     *
     * This only needs to be called once since the registered events are
     * unregistered when the plugin is unloaded.
     *
     * This mustn't depend on the plugin's settings.
     */
    registerStuff(): void {
        this.registerEvent(
            this.app.workspace.on("obsidian-git:refresh", () => {
                this.refresh().catch((e) => this.displayError(e));
            })
        );
        this.registerEvent(
            this.app.workspace.on("obsidian-git:head-change", () => {
                this.refreshUpdatedHead();
            })
        );

        this.registerEvent(
            this.app.workspace.on("file-menu", (menu, file, source) => {
                this.handleFileMenu(menu, file, source, "file-manu");
            })
        );

        this.registerEvent(
            this.app.workspace.on("obsidian-git:menu", (menu, path, source) => {
                this.handleFileMenu(menu, path, source, "obsidian-git:menu");
            })
        );

        this.registerEvent(
            this.app.workspace.on("active-leaf-change", (leaf) => {
                this.onActiveLeafChange(leaf);
                // Auto-clear repo override if user opened a file in a different repo.
                const override = this.localStorage.getActiveRepoOverride();
                if (override) {
                    const file = this.app.workspace.getActiveFile();
                    if (file) {
                        const repo = this.repoForFile(file);
                        if (repo && repo.id !== override) {
                            this.localStorage.setActiveRepoOverride(null);
                            this.mirrorLegacySettingsFields();
                            this.statusBar?.display();
                            void this.branchBar?.display();
                        }
                    }
                }
            })
        );
        const routeVaultEvent = (filePath: string) => {
            const repo = this.repoForVaultPath(filePath);
            if (repo) {
                repo.fileEventDebouncer?.();
                repo.automatics.autoCommitDebouncer?.();
            }
        };

        this.registerEvent(
            this.app.vault.on("modify", (file) => routeVaultEvent(file.path))
        );
        this.registerEvent(
            this.app.vault.on("delete", (file) => routeVaultEvent(file.path))
        );
        this.registerEvent(
            this.app.vault.on("create", (file) => {
                routeVaultEvent(file.path);
            })
        );
        this.registerEvent(
            this.app.vault.on("rename", (file, oldPath) => {
                routeVaultEvent(file.path);
                routeVaultEvent(oldPath);
            })
        );

        this.registerView(SOURCE_CONTROL_VIEW_CONFIG.type, (leaf) => {
            return new GitView(leaf, this);
        });

        this.registerView(HISTORY_VIEW_CONFIG.type, (leaf) => {
            return new HistoryView(leaf, this);
        });

        this.registerView(DIFF_VIEW_CONFIG.type, (leaf) => {
            return new DiffView(leaf, this);
        });

        this.registerView(SPLIT_DIFF_VIEW_CONFIG.type, (leaf) => {
            return new SplitDiffView(leaf, this);
        });
        this.addRibbonIcon(
            "git-pull-request",
            "Open Git source control",
            async () => {
                const leafs = this.app.workspace.getLeavesOfType(
                    SOURCE_CONTROL_VIEW_CONFIG.type
                );
                let leaf: WorkspaceLeaf;
                if (leafs.length === 0) {
                    leaf =
                        this.app.workspace.getRightLeaf(false) ??
                        this.app.workspace.getLeaf();
                    await leaf.setViewState({
                        type: SOURCE_CONTROL_VIEW_CONFIG.type,
                    });
                } else {
                    leaf = leafs.first()!;
                }
                await this.app.workspace.revealLeaf(leaf);
            }
        );

        this.registerHoverLinkSource(SOURCE_CONTROL_VIEW_CONFIG.type, {
            display: "Git View",
            defaultMod: true,
        });

        this.editorIntegration.onLoadPlugin();

        addCommmands(this);
    }

    /**
     * @deprecated Per-repo debouncers are now created in `registerRepo`.
     */
    setRefreshDebouncer(): void {
        // No-op: replaced by per-repo `setRepoDebouncer`.
    }

    async addFileToGitignore(
        filePath: string,
        isFolder?: boolean
    ): Promise<void> {
        const repo = this.repoForVaultPath(filePath);
        if (!repo) {
            this.displayError(`No repository contains "${filePath}".`);
            return;
        }
        const gitRelativePath = repo.gitManager.getRelativeRepoPath(
            filePath,
            true
        );
        const gitignoreRule = convertPathToAbsoluteGitignoreRule({
            isFolder,
            gitRelativePath,
        });
        await this.app.vault.adapter.append(
            repo.gitManager.getRelativeVaultPath(".gitignore"),
            "\n" + gitignoreRule
        );
        this.app.workspace.trigger("obsidian-git:refresh", repo.id);
    }

    handleFileMenu(
        menu: Menu,
        file: TAbstractFile | string,
        source: string,
        type: "file-manu" | "obsidian-git:menu"
    ): void {
        if (!this.gitReady) return;
        if (!this.settings.showFileMenu) return;
        if (!file) return;
        let filePath: string;
        if (typeof file === "string") {
            filePath = file;
        } else {
            filePath = file.path;
        }

        if (source == "file-explorer-context-menu") {
            menu.addItem((item) => {
                item.setTitle(`Git: Stage`)
                    .setIcon("plus-circle")
                    .setSection("action")
                    .onClick((_) => {
                        this.promiseQueue.addTask(async () => {
                            if (file instanceof TFile) {
                                await this.stageFile(file);
                            } else {
                                await this.gitManager.stageAll({
                                    dir: this.gitManager.getRelativeRepoPath(
                                        filePath,
                                        true
                                    ),
                                });
                                this.app.workspace.trigger(
                                    "obsidian-git:refresh"
                                );
                            }
                        });
                    });
            });
            menu.addItem((item) => {
                item.setTitle(`Git: Unstage`)
                    .setIcon("minus-circle")
                    .setSection("action")
                    .onClick((_) => {
                        this.promiseQueue.addTask(async () => {
                            if (file instanceof TFile) {
                                await this.unstageFile(file);
                            } else {
                                await this.gitManager.unstageAll({
                                    dir: this.gitManager.getRelativeRepoPath(
                                        filePath,
                                        true
                                    ),
                                });

                                this.app.workspace.trigger(
                                    "obsidian-git:refresh"
                                );
                            }
                        });
                    });
            });
            menu.addItem((item) => {
                item.setTitle(`Git: Add to .gitignore`)
                    .setIcon("file-x")
                    .setSection("action")
                    .onClick((_) => {
                        this.addFileToGitignore(
                            filePath,
                            file instanceof TFolder
                        ).catch((e) => this.displayError(e));
                    });
            });
        }

        if (source == "git-source-control") {
            menu.addItem((item) => {
                item.setTitle(`Git: Add to .gitignore`)
                    .setIcon("file-x")
                    .setSection("action")
                    .onClick((_) => {
                        this.addFileToGitignore(
                            filePath,
                            file instanceof TFolder
                        ).catch((e) => this.displayError(e));
                    });
            });
            const gitManager = this.app.vault.adapter;
            if (
                type === "obsidian-git:menu" &&
                gitManager instanceof FileSystemAdapter
            ) {
                menu.addItem((item) => {
                    item.setTitle("Open in default app")
                        .setIcon("arrow-up-right")
                        .setSection("action")
                        .onClick((_) => {
                            this.app.openWithDefaultApp(filePath);
                        });
                });
                menu.addItem((item) => {
                    item.setTitle("Show in system explorer")
                        .setIcon("arrow-up-right")
                        .setSection("action")
                        .onClick((_) => {
                            // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
                            (window as any).electron.shell.showItemInFolder(
                                path.join(gitManager.getBasePath(), filePath)
                            );
                        });
                });
            }
        }
    }

    async migrateSettings(): Promise<void> {
        const s = this.settings;

        // Pre-existing legacy migrations (kept from v1.x)
        if (s.mergeOnPull != undefined) {
            const target: SyncMethod = s.mergeOnPull ? "merge" : "rebase";
            // Stage the value into the legacy field so the multi-repo migration below picks it up.
            s.syncMethod = target;
            s.mergeOnPull = undefined;
        }
        if (s.gitPath != undefined) {
            this.localStorage.setGitPath(s.gitPath);
            s.gitPath = undefined;
        }
        if (s.username != undefined) {
            this.localStorage.setPassword(s.username);
            s.username = undefined;
        }

        // Multi-repo v1 migration (one-shot)
        if (!s._migratedToMultiRepoV1) {
            const defaults = DEFAULT_SETTINGS.globalRepoDefaults;
            const pick = <K extends keyof PerRepoSettings>(
                key: K,
                fallback: PerRepoSettings[K]
            ): PerRepoSettings[K] => {
                const v = (s as unknown as Record<string, unknown>)[key];
                return v === undefined ? fallback : (v as PerRepoSettings[K]);
            };

            const legacyAutoCommitMessage =
                s.autoCommitMessage ??
                s.commitMessage ??
                defaults.autoCommitMessage;

            const migratedDefaults: PerRepoSettings = {
                commitMessage: pick("commitMessage", defaults.commitMessage),
                autoCommitMessage:
                    legacyAutoCommitMessage ?? defaults.autoCommitMessage,
                commitMessageScript: pick(
                    "commitMessageScript",
                    defaults.commitMessageScript
                ),
                commitDateFormat: pick(
                    "commitDateFormat",
                    defaults.commitDateFormat
                ),
                autoSaveInterval: pick(
                    "autoSaveInterval",
                    defaults.autoSaveInterval
                ),
                autoPushInterval: pick(
                    "autoPushInterval",
                    defaults.autoPushInterval
                ),
                autoPullInterval: pick(
                    "autoPullInterval",
                    defaults.autoPullInterval
                ),
                autoPullOnBoot: pick("autoPullOnBoot", defaults.autoPullOnBoot),
                autoCommitOnlyStaged: pick(
                    "autoCommitOnlyStaged",
                    defaults.autoCommitOnlyStaged
                ),
                syncMethod: pick("syncMethod", defaults.syncMethod),
                mergeStrategy: pick("mergeStrategy", defaults.mergeStrategy),
                disablePush: pick("disablePush", defaults.disablePush),
                pullBeforePush: pick("pullBeforePush", defaults.pullBeforePush),
                differentIntervalCommitAndPush: pick(
                    "differentIntervalCommitAndPush",
                    defaults.differentIntervalCommitAndPush
                ),
                customMessageOnAutoBackup: pick(
                    "customMessageOnAutoBackup",
                    defaults.customMessageOnAutoBackup
                ),
                autoBackupAfterFileChange: pick(
                    "autoBackupAfterFileChange",
                    defaults.autoBackupAfterFileChange
                ),
                setLastSaveToLastCommit: pick(
                    "setLastSaveToLastCommit",
                    defaults.setLastSaveToLastCommit
                ),
                updateSubmodules: pick(
                    "updateSubmodules",
                    defaults.updateSubmodules
                ),
                submoduleRecurseCheckout: pick(
                    "submoduleRecurseCheckout",
                    defaults.submoduleRecurseCheckout
                ),
                listChangedFilesInMessageBody: pick(
                    "listChangedFilesInMessageBody",
                    defaults.listChangedFilesInMessageBody
                ),
            };

            const legacyBasePath = normalizeRepoPath(s.basePath ?? "");
            const legacyGitDir =
                s.gitDir && s.gitDir.length > 0 ? s.gitDir : undefined;

            const repoId = newRepoId();
            const repo: RepoConfig = {
                id: repoId,
                displayName: defaultDisplayName(legacyBasePath),
                path: legacyBasePath,
                gitDir: legacyGitDir,
                overrides: {},
            };

            s.repos = [repo];
            s.defaultRepoId = repoId;
            s.globalRepoDefaults = migratedDefaults;

            // Mirror per-repo defaults onto the legacy top-level fields so
            // existing consumer code (settings UI, commands) keeps working.
            this.mirrorLegacySettingsFields();

            s._migratedToMultiRepoV1 = true;
            await this.saveSettings();
        } else {
            // Re-mirror on every load to keep legacy fields aligned with the active repo.
            this.mirrorLegacySettingsFields();
        }
    }

    /**
     * Copy effective per-repo settings (active repo) onto the legacy top-level
     * fields in `this.settings`. Keeps deprecated consumer code working.
     */
    mirrorLegacySettingsFields(): void {
        const s = this.settings;
        const repo = this.activeRepo();
        const eff: PerRepoSettings = repo
            ? repo.settings
            : s.globalRepoDefaults;
        s.basePath = repo?.config.path ?? s.basePath ?? "";
        s.gitDir = repo?.config.gitDir ?? s.gitDir ?? "";
        s.commitMessage = eff.commitMessage;
        s.autoCommitMessage = eff.autoCommitMessage;
        s.commitMessageScript = eff.commitMessageScript;
        s.commitDateFormat = eff.commitDateFormat;
        s.autoSaveInterval = eff.autoSaveInterval;
        s.autoPushInterval = eff.autoPushInterval;
        s.autoPullInterval = eff.autoPullInterval;
        s.autoPullOnBoot = eff.autoPullOnBoot;
        s.autoCommitOnlyStaged = eff.autoCommitOnlyStaged;
        s.syncMethod = eff.syncMethod;
        s.mergeStrategy = eff.mergeStrategy;
        s.disablePush = eff.disablePush;
        s.pullBeforePush = eff.pullBeforePush;
        s.differentIntervalCommitAndPush = eff.differentIntervalCommitAndPush;
        s.customMessageOnAutoBackup = eff.customMessageOnAutoBackup;
        s.autoBackupAfterFileChange = eff.autoBackupAfterFileChange;
        s.setLastSaveToLastCommit = eff.setLastSaveToLastCommit;
        s.updateSubmodules = eff.updateSubmodules;
        s.submoduleRecurseCheckout = eff.submoduleRecurseCheckout;
        s.listChangedFilesInMessageBody = eff.listChangedFilesInMessageBody;
    }

    unloadPlugin() {
        this.gitReady = false;

        this.editorIntegration.onUnloadPlugin();
        for (const repo of this.repos.values()) {
            repo.unload();
        }
        this.repos.clear();
        this.repoOrder = [];
        for (const d of this.repoDebouncers.values()) d.cancel();
        this.repoDebouncers.clear();
        this._fallbackQueue.clear();

        this.branchBar?.remove();
        this.statusBar?.remove();
        this.statusBar = undefined;
        this.branchBar = undefined;

        for (const interval of this.intervalsToClear) {
            window.clearInterval(interval);
        }
        this.intervalsToClear = [];
    }

    onunload() {
        this.unloadPlugin();

        console.log("unloading " + this.manifest.name + " plugin");
    }

    async loadSettings() {
        // At first startup, `data` is `null` because data.json does not exist.
        let data = (await this.loadData()) as ObsidianGitSettings | null;
        //Check for existing settings
        if (data == undefined) {
            data = <ObsidianGitSettings>{ showedMobileNotice: true };
        }
        this.settings = mergeSettingsByPriority(DEFAULT_SETTINGS, data);
    }

    async saveSettings() {
        this.settingsTab?.beforeSaveSettings();
        await this.saveData(this.settings);
    }

    get useSimpleGit(): boolean {
        return Platform.isDesktopApp;
    }

    async init({ fromReload = false }): Promise<void> {
        if (this.settings.showStatusBar && !this.statusBar) {
            const statusBarEl = this.addStatusBarItem();
            this.statusBar = new StatusBar(statusBarEl, this);
            this.intervalsToClear.push(
                window.setInterval(() => this.statusBar?.display(), 1000)
            );
        }

        try {
            // On mobile, only the first repo is active (Section 11 of spec).
            const configs = Platform.isDesktopApp
                ? this.settings.repos
                : this.settings.repos.slice(0, 1);

            this.repos.clear();
            this.repoOrder = [];

            if (configs.length === 0) {
                new Notice(
                    "No git repositories configured. Add one in the plugin settings, or run 'Initialize a new repo'.",
                    10000
                );
                this.gitReady = false;
                return;
            }

            for (const config of configs) {
                await this.registerRepo(config);
            }

            const anyReady = Array.from(this.repos.values()).some(
                (r) => r.ready
            );
            this.gitReady = anyReady;

            if (anyReady) {
                this.setPluginState({ gitAction: CurrentGitAction.idle });

                if (
                    Platform.isDesktop &&
                    this.settings.showBranchStatusBar &&
                    !this.branchBar
                ) {
                    const branchStatusBarEl = this.addStatusBarItem();
                    this.branchBar = new BranchStatusBar(
                        branchStatusBarEl,
                        this
                    );
                    this.intervalsToClear.push(
                        window.setInterval(
                            () =>
                                void this.branchBar
                                    ?.display()
                                    .catch(console.error),
                            60000
                        )
                    );
                }
                await this.branchBar?.display();

                this.editorIntegration.onReady();

                this.app.workspace.trigger("obsidian-git:refresh");
                this.app.workspace.trigger("obsidian-git:head-change");

                const pausedGlobal = this.localStorage.getPausedAutomatics();
                if (!fromReload && !pausedGlobal) {
                    // Per-repo autoPullOnBoot
                    for (const repo of this.repos.values()) {
                        if (
                            repo.ready &&
                            repo.settings.autoPullOnBoot &&
                            !this.localStorage.isAutomaticsPausedForRepo(
                                repo.id
                            )
                        ) {
                            repo.promiseQueue.addTask(() =>
                                this.pullRepoFromRemote(repo)
                            );
                        }
                    }
                }

                if (pausedGlobal) {
                    new Notice(
                        "Automatic routines are currently paused (all repos)."
                    );
                }

                // Background scan for externally-inited repos.
                window.setTimeout(() => {
                    void this.scanVaultForGitRepos().then((paths) => {
                        for (const p of paths) {
                            new Notice(
                                `Found unregistered git repo at "${
                                    p || "<root>"
                                }". Use Settings → Repositories → "Scan vault for repos" to add it.`,
                                10000
                            );
                        }
                    });
                }, 0);
            }
        } catch (error) {
            this.displayError(error);
            console.error(error);
        }
    }

    async createNewRepo() {
        try {
            await this.gitManager.init();
            new Notice("Initialized new repo");
            await this.init({ fromReload: true });
        } catch (e) {
            this.displayError(e);
        }
    }

    async cloneNewRepo() {
        const modal = new GeneralModal(this, {
            placeholder: "Enter remote URL",
        });
        const url = await modal.openAndGetResult();
        if (url) {
            const confirmOption = "Vault Root";
            let dir = await new GeneralModal(this, {
                options:
                    this.gitManager instanceof IsomorphicGit
                        ? [confirmOption]
                        : [],
                placeholder:
                    "Enter directory for clone. It needs to be empty or not existent.",
                allowEmpty: this.gitManager instanceof IsomorphicGit,
            }).openAndGetResult();
            if (dir == undefined) return;
            if (dir === confirmOption) {
                dir = ".";
            }

            dir = normalizePath(dir);
            if (dir === "/") {
                dir = ".";
            }

            if (dir === ".") {
                const modal = new GeneralModal(this, {
                    options: ["NO", "YES"],
                    placeholder: `Does your remote repo contain a ${this.app.vault.configDir} directory at the root?`,
                    onlySelection: true,
                });
                const containsConflictDir = await modal.openAndGetResult();
                if (containsConflictDir === undefined) {
                    new Notice("Aborted clone");
                    return;
                } else if (containsConflictDir === "YES") {
                    const confirmOption =
                        "DELETE ALL YOUR LOCAL CONFIG AND PLUGINS";
                    const modal = new GeneralModal(this, {
                        options: ["Abort clone", confirmOption],
                        placeholder: `To avoid conflicts, the local ${this.app.vault.configDir} directory needs to be deleted.`,
                        onlySelection: true,
                    });
                    const shouldDelete =
                        (await modal.openAndGetResult()) === confirmOption;
                    if (shouldDelete) {
                        await this.app.vault.adapter.rmdir(
                            this.app.vault.configDir,
                            true
                        );
                    } else {
                        new Notice("Aborted clone");
                        return;
                    }
                }
            }
            const depth = await new GeneralModal(this, {
                placeholder:
                    "Specify depth of clone. Leave empty for full clone.",
                allowEmpty: true,
            }).openAndGetResult();
            let depthInt = undefined;
            if (depth === undefined) {
                new Notice("Aborted clone");
                return;
            }

            if (depth !== "") {
                depthInt = parseInt(depth);
                if (isNaN(depthInt)) {
                    new Notice("Invalid depth. Aborting clone.");
                    return;
                }
            }
            new Notice(`Cloning new repo into "${dir}"`);
            const oldBase = this.settings.basePath;
            const customDir = dir && dir !== ".";
            //Set new base path before clone to ensure proper .git/index file location in isomorphic-git
            if (customDir) {
                this.settings.basePath = dir;
            }
            try {
                await this.gitManager.clone(
                    formatRemoteUrl(url),
                    dir,
                    depthInt
                );
                new Notice("Cloned new repo.");
                new Notice("Please restart Obsidian");

                if (customDir) {
                    await this.saveSettings();
                }
            } catch (error) {
                this.displayError(error);
                this.settings.basePath = oldBase;
                await this.saveSettings();
            }
        }
    }

    /**
     * Prompt for a path and initialize a new repo there.
     */
    async promptInitRepo(): Promise<void> {
        const modal = new GeneralModal(this, {
            placeholder:
                "Enter vault-relative path for the new repo (blank = vault root)",
            allowEmpty: true,
        });
        const raw = await modal.openAndGetResult();
        if (raw === undefined) return;
        const repoPath = normalizeRepoPath(raw);
        if (
            this.settings.repos.some((r) => repoPathsOverlap(r.path, repoPath))
        ) {
            this.displayError(
                `Path "${repoPath || "<root>"}" overlaps an existing registered repo.`
            );
            return;
        }
        const adapter = this.app.vault.adapter;
        if (repoPath !== "" && !(await adapter.exists(repoPath))) {
            await adapter.mkdir(repoPath);
        }
        const config: RepoConfig = {
            id: newRepoId(),
            path: repoPath,
            displayName: defaultDisplayName(repoPath),
            overrides: {},
        };
        const tempRepo = new GitRepo(this, config);
        try {
            await tempRepo.gitManager.init();
        } catch (e) {
            this.displayError(e);
            return;
        }
        this.settings.repos.push(config);
        if (this.settings.defaultRepoId === null) {
            this.settings.defaultRepoId = config.id;
        }
        await this.saveSettings();
        await this.registerRepo(config);
        this.gitReady = Array.from(this.repos.values()).some((r) => r.ready);
        this.mirrorLegacySettingsFields();
        new Notice(`Initialized new repo "${config.displayName}".`);
        this.app.workspace.trigger("obsidian-git:refresh");
    }

    /**
     * Prompt for URL/directory and clone a new repo.
     */
    async promptCloneRepo(): Promise<void> {
        const urlModal = new GeneralModal(this, {
            placeholder: "Enter remote URL",
        });
        const url = await urlModal.openAndGetResult();
        if (!url) return;

        const dirModal = new GeneralModal(this, {
            placeholder:
                "Enter vault-relative path for the clone (blank = vault root).",
            allowEmpty: true,
        });
        const dirRaw = await dirModal.openAndGetResult();
        if (dirRaw === undefined) return;
        const dir = normalizeRepoPath(dirRaw);
        if (this.settings.repos.some((r) => repoPathsOverlap(r.path, dir))) {
            this.displayError(
                `Path "${dir || "<root>"}" overlaps an existing registered repo.`
            );
            return;
        }
        const depthModal = new GeneralModal(this, {
            placeholder: "Clone depth (blank for full).",
            allowEmpty: true,
        });
        const depthRaw = await depthModal.openAndGetResult();
        if (depthRaw === undefined) return;
        let depth: number | undefined;
        if (depthRaw !== "") {
            depth = parseInt(depthRaw);
            if (isNaN(depth)) {
                this.displayError("Invalid depth.");
                return;
            }
        }
        const config: RepoConfig = {
            id: newRepoId(),
            path: dir,
            displayName: defaultDisplayName(dir),
            overrides: {},
        };
        const tempRepo = new GitRepo(this, config);
        try {
            await tempRepo.gitManager.clone(
                formatRemoteUrl(url),
                dir || ".",
                depth
            );
        } catch (e) {
            this.displayError(e);
            return;
        }
        this.settings.repos.push(config);
        if (this.settings.defaultRepoId === null) {
            this.settings.defaultRepoId = config.id;
        }
        await this.saveSettings();
        await this.registerRepo(config);
        this.gitReady = Array.from(this.repos.values()).some((r) => r.ready);
        this.mirrorLegacySettingsFields();
        new Notice(`Cloned new repo "${config.displayName}".`);
        this.app.workspace.trigger("obsidian-git:refresh");
    }

    /**
     * Walk the vault depth-first looking for `.git` directories.
     * Skips `.obsidian`, working trees of already-registered repos, and
     * paths in `localStorage.getIgnoredRepoPaths()`.
     *
     * Returns a list of vault-relative repo paths (parent of each found `.git`).
     */
    async scanVaultForGitRepos(): Promise<string[]> {
        const adapter = this.app.vault.adapter;
        const found: string[] = [];
        const ignored = new Set(this.localStorage.getIgnoredRepoPaths());
        const registeredPaths = new Set(this.settings.repos.map((r) => r.path));

        const walk = async (dir: string) => {
            let list: { folders: string[] };
            try {
                list = await adapter.list(dir || "/");
            } catch {
                return;
            }
            for (const sub of list.folders) {
                const rel = sub;
                const lastSeg = rel.split("/").pop();
                if (lastSeg === ".obsidian") continue;
                const skip = Array.from(registeredPaths).some(
                    (rp) =>
                        rp !== "" && (rel === rp || rel.startsWith(rp + "/"))
                );
                if (skip) continue;
                const gitPath = rel + "/.git";
                if (await adapter.exists(gitPath)) {
                    const candidate = rel;
                    if (
                        !ignored.has(candidate) &&
                        !registeredPaths.has(candidate)
                    ) {
                        found.push(candidate);
                    }
                    continue;
                }
                await walk(rel);
            }
        };

        if (await adapter.exists(".git")) {
            if (!ignored.has("") && !registeredPaths.has("")) {
                found.push("");
            }
        } else {
            await walk("");
        }
        return found;
    }

    /** Register a repo at the given detected path. */
    addRepoFromDetectedPath = async (path: string): Promise<void> => {
        if (this.settings.repos.some((r) => repoPathsOverlap(r.path, path))) {
            this.displayError(
                `Path "${path || "<root>"}" overlaps an existing registered repo.`
            );
            return;
        }
        const config: RepoConfig = {
            id: newRepoId(),
            path,
            displayName: defaultDisplayName(path),
            overrides: {},
        };
        this.settings.repos.push(config);
        if (this.settings.defaultRepoId === null) {
            this.settings.defaultRepoId = config.id;
        }
        await this.saveSettings();
        await this.registerRepo(config);
        this.gitReady = Array.from(this.repos.values()).some((r) => r.ready);
        this.mirrorLegacySettingsFields();
        this.app.workspace.trigger("obsidian-git:refresh");
        new Notice(`Added "${config.displayName}".`);
    };

    /**
     * Pick a repo, confirm, then delete its `.git` directory and deregister.
     */
    async promptDeleteRepo(): Promise<void> {
        if (this.repos.size === 0) {
            new Notice("No repos to delete.");
            return;
        }
        const ordered = this.repoOrder
            .map((id) => this.repos.get(id))
            .filter((r): r is GitRepo => !!r);
        const picker = new GeneralModal(this, {
            options: ordered.map(
                (r) => `${r.displayName}  (${r.config.path || "<root>"})`
            ),
            placeholder: "Pick the repository to delete",
            onlySelection: true,
        });
        const picked = await picker.openAndGetResult();
        if (!picked) return;
        const repo = ordered.find(
            (r) => `${r.displayName}  (${r.config.path || "<root>"})` === picked
        );
        if (!repo) return;
        const confirmText = `DELETE .git of "${repo.displayName}"`;
        const confirm = new GeneralModal(this, {
            options: ["Abort", confirmText],
            placeholder: "This deletes the .git directory on disk. Proceed?",
            onlySelection: true,
        });
        const decision = await confirm.openAndGetResult();
        if (decision !== confirmText) {
            new Notice("Aborted.");
            return;
        }
        const gitDir =
            repo.config.gitDir ||
            (repo.config.path ? repo.config.path + "/" : "") + ".git";
        this.unregisterRepo(repo.id);
        this.settings.repos = this.settings.repos.filter(
            (c) => c.id !== repo.id
        );
        await this.saveSettings();
        try {
            await this.app.vault.adapter.rmdir(gitDir, true);
        } catch (e) {
            console.error(e);
        }
        new Notice(
            `Deleted "${repo.displayName}" from plugin and removed .git on disk.`
        );
        this.gitReady = Array.from(this.repos.values()).some((r) => r.ready);
        this.app.workspace.trigger("obsidian-git:refresh");
    }

    /**
     * Retries to call `this.init()` if necessary, otherwise returns directly
     * @returns true if `this.gitManager` is ready to be used, false if not.
     */
    async isAllInitialized(): Promise<boolean> {
        if (!this.gitReady) {
            await this.init({ fromReload: true });
        }
        return this.gitReady;
    }

    ///Used for command
    async pullChangesFromRemote(): Promise<void> {
        if (!(await this.isAllInitialized())) return;

        const filesUpdated = await this.pull();
        if (filesUpdated === false) {
            return;
        }
        if (!filesUpdated) {
            this.displayMessage("Pull: Everything is up-to-date");
        }

        if (this.gitManager instanceof SimpleGit) {
            const status = await this.updateCachedStatus();
            if (status.conflicted.length > 0) {
                this.displayError(
                    `You have conflicts in ${status.conflicted.length} ${
                        status.conflicted.length == 1 ? "file" : "files"
                    }`
                );
                await this.handleConflict(status.conflicted);
            }
        }

        this.app.workspace.trigger("obsidian-git:refresh");
        this.setPluginState({ gitAction: CurrentGitAction.idle });
    }

    async commitAndSync({
        fromAutoBackup,
        requestCustomMessage = false,
        commitMessage,
        onlyStaged = false,
    }: {
        fromAutoBackup: boolean;
        requestCustomMessage?: boolean;
        commitMessage?: string;
        onlyStaged?: boolean;
    }): Promise<void> {
        if (!(await this.isAllInitialized())) return;

        if (
            this.settings.syncMethod == "reset" &&
            this.settings.pullBeforePush
        ) {
            await this.pull();
        }

        const commitSuccessful = await this.commit({
            fromAuto: fromAutoBackup,
            requestCustomMessage,
            commitMessage,
            onlyStaged,
        });
        if (!commitSuccessful) {
            return;
        }

        if (
            this.settings.syncMethod != "reset" &&
            this.settings.pullBeforePush
        ) {
            await this.pull();
        }

        if (!this.settings.disablePush) {
            // Prevent trying to push every time. Only if unpushed commits are present
            if (
                (await this.remotesAreSet()) &&
                (await this.gitManager.canPush())
            ) {
                await this.push();
            } else {
                this.displayMessage("No commits to push");
            }
        }
        this.setPluginState({ gitAction: CurrentGitAction.idle });
    }

    // Returns true if commit was successfully
    async commit({
        fromAuto,
        requestCustomMessage = false,
        onlyStaged = false,
        commitMessage,
        amend = false,
    }: {
        fromAuto: boolean;
        requestCustomMessage?: boolean;
        onlyStaged?: boolean;
        commitMessage?: string;
        amend?: boolean;
    }): Promise<boolean> {
        if (!(await this.isAllInitialized())) return false;
        try {
            let hadConflict = this.localStorage.getConflict();

            let status: Status | undefined;
            let stagedFiles: { vaultPath: string; path: string }[] = [];
            let unstagedFiles: (UnstagedFile & { vaultPath: string })[] = [];

            if (this.gitManager instanceof SimpleGit) {
                await this.mayDeleteConflictFile();
                status = await this.updateCachedStatus();

                //Should not be necessary, but just in case
                if (status.conflicted.length == 0) {
                    hadConflict = false;
                }

                // check for conflict files on auto backup
                if (fromAuto && status.conflicted.length > 0) {
                    this.displayError(
                        `Did not commit, because you have conflicts in ${
                            status.conflicted.length
                        } ${
                            status.conflicted.length == 1 ? "file" : "files"
                        }. Please resolve them and commit per command.`
                    );
                    await this.handleConflict(status.conflicted);
                    return false;
                }
                stagedFiles = status.staged;

                // This typecast is only needed to hide the fact that `type` is missing, but that is only needed for isomorphic-git
                unstagedFiles = status.changed as unknown as (UnstagedFile & {
                    vaultPath: string;
                })[];
            } else {
                // isomorphic-git section

                if (fromAuto && hadConflict) {
                    // isomorphic-git doesn't have a way to detect current
                    // conflicts, they are only detected on commit
                    //
                    // Conflicts should only be resolved by manually committing.
                    this.displayError(
                        `Did not commit, because you have conflicts. Please resolve them and commit per command.`
                    );
                    return false;
                } else {
                    if (hadConflict) {
                        await this.mayDeleteConflictFile();
                    }
                    const gitManager = this.gitManager as IsomorphicGit;
                    if (onlyStaged) {
                        stagedFiles = await gitManager.getStagedFiles();
                    } else {
                        const res = await gitManager.getUnstagedFiles();
                        unstagedFiles = res.map(({ path, type }) => ({
                            vaultPath:
                                this.gitManager.getRelativeVaultPath(path),
                            path,
                            type,
                        }));
                    }
                }
            }

            if (
                await this.tools.hasTooBigFiles(
                    onlyStaged
                        ? stagedFiles
                        : [...stagedFiles, ...unstagedFiles]
                )
            ) {
                this.setPluginState({ gitAction: CurrentGitAction.idle });
                return false;
            }

            if (
                unstagedFiles.length + stagedFiles.length !== 0 ||
                hadConflict
            ) {
                // The commit message from settings or previously set in the
                // source control view
                let cmtMessage = (commitMessage ??= fromAuto
                    ? this.settings.autoCommitMessage
                    : this.settings.commitMessage);

                // Optionally ask the user via a modal for a commit message
                if (
                    (fromAuto && this.settings.customMessageOnAutoBackup) ||
                    requestCustomMessage
                ) {
                    if (!this.settings.disablePopups && fromAuto) {
                        new Notice(
                            "Auto backup: Please enter a custom commit message. Leave empty to abort"
                        );
                    }
                    const modalMessage = await new CustomMessageModal(
                        this
                    ).openAndGetResult();

                    if (
                        modalMessage != undefined &&
                        modalMessage != "" &&
                        modalMessage != "..."
                    ) {
                        cmtMessage = modalMessage;
                    } else {
                        this.setPluginState({
                            gitAction: CurrentGitAction.idle,
                        });
                        return false;
                    }

                    // On desktop may run a script to get the commit message
                } else if (
                    this.gitManager instanceof SimpleGit &&
                    this.settings.commitMessageScript
                ) {
                    const templateScript = this.settings.commitMessageScript;
                    const hostname = this.localStorage.getHostname() || "";
                    let formattedScript = templateScript.replace(
                        "{{hostname}}",
                        hostname
                    );

                    formattedScript = formattedScript.replace(
                        "{{date}}",
                        moment().format(this.settings.commitDateFormat)
                    );
                    let shPath = "sh";
                    if (Platform.isWin) {
                        shPath =
                            process.env.PROGRAMFILES + "\\Git\\bin\\sh.exe";
                        let shExists = false;
                        try {
                            await fsPromises.access(
                                shPath,
                                fsPromises.constants.X_OK
                            );
                            shExists = true;
                        } catch {
                            shExists = false;
                        }

                        if (!shExists) {
                            this.displayError(
                                `Cannot find sh.exe at ${shPath}. Please make sure Git is properly installed.`
                            );
                            return false;
                        }
                    }

                    const res = await spawnAsync(
                        shPath,
                        ["-c", formattedScript],
                        { cwd: this.gitManager.absoluteRepoPath }
                    );
                    if (res.code != 0) {
                        this.displayError(res.stderr);
                    } else if (res.stdout.trim().length == 0) {
                        this.displayMessage(
                            "Stdout from commit message script is empty. Using default message."
                        );
                    } else {
                        cmtMessage = res.stdout;
                    }
                }

                // Check if commit message is empty after all processing
                if (!cmtMessage || cmtMessage.trim() === "") {
                    new Notice("Commit aborted: No commit message provided");
                    this.setPluginState({
                        gitAction: CurrentGitAction.idle,
                    });
                    return false;
                }

                let committedFiles: number | undefined;
                if (onlyStaged) {
                    committedFiles = await this.gitManager.commit({
                        message: cmtMessage,
                        amend,
                    });
                } else {
                    committedFiles = await this.gitManager.commitAll({
                        message: cmtMessage,
                        status,
                        unstagedFiles,
                        amend,
                    });
                }

                // Handle eventually resolved conflicts
                if (this.gitManager instanceof SimpleGit) {
                    await this.updateCachedStatus();
                }

                let roughly = false;
                if (committedFiles === undefined) {
                    roughly = true;
                    committedFiles =
                        unstagedFiles.length + stagedFiles.length || 0;
                }
                this.displayMessage(
                    `Committed${roughly ? " approx." : ""} ${committedFiles} ${
                        committedFiles == 1 ? "file" : "files"
                    }`
                );
            } else {
                this.displayMessage("No changes to commit");
            }
            this.app.workspace.trigger("obsidian-git:refresh");

            return true;
        } catch (error) {
            this.displayError(error);
            return false;
        }
    }

    /*
     * Returns true if push was successful
     */
    async push(): Promise<boolean> {
        if (!(await this.isAllInitialized())) return false;
        if (!(await this.remotesAreSet())) {
            return false;
        }
        const hadConflict = this.localStorage.getConflict();
        try {
            if (this.gitManager instanceof SimpleGit)
                await this.mayDeleteConflictFile();

            // Refresh because of pull
            let status: Status;
            if (
                this.gitManager instanceof SimpleGit &&
                (status = await this.updateCachedStatus()).conflicted.length > 0
            ) {
                this.displayError(
                    `Cannot push. You have conflicts in ${
                        status.conflicted.length
                    } ${status.conflicted.length == 1 ? "file" : "files"}`
                );
                await this.handleConflict(status.conflicted);
                return false;
            } else if (
                this.gitManager instanceof IsomorphicGit &&
                hadConflict
            ) {
                this.displayError(`Cannot push. You have conflicts`);
                return false;
            }
            this.log("Pushing....");
            const pushedFiles = await this.gitManager.push();

            if (pushedFiles !== undefined) {
                if (pushedFiles === null) {
                    this.displayMessage(`Pushed to remote`);
                } else if (pushedFiles > 0) {
                    this.displayMessage(
                        `Pushed ${pushedFiles} ${
                            pushedFiles == 1 ? "file" : "files"
                        } to remote`
                    );
                } else {
                    this.displayMessage(`No commits to push`);
                }
            }
            this.setPluginState({ offlineMode: false });
            this.app.workspace.trigger("obsidian-git:refresh");
            return true;
        } catch (e) {
            if (e instanceof NoNetworkError) {
                this.handleNoNetworkError(e);
            } else {
                this.displayError(e);
            }
            return false;
        }
    }

    /** Used for internals
     *  Returns whether the pull added a commit or not.
     *
     *  See {@link pullChangesFromRemote} for the command version.
     */
    async pull(): Promise<false | number> {
        if (!(await this.remotesAreSet())) {
            return false;
        }
        try {
            this.log("Pulling....");
            const pulledFiles = (await this.gitManager.pull()) || [];
            this.setPluginState({ offlineMode: false });

            if (pulledFiles.length > 0) {
                this.displayMessage(
                    `Pulled ${pulledFiles.length} ${
                        pulledFiles.length == 1 ? "file" : "files"
                    } from remote`
                );
                this.lastPulledFiles = pulledFiles;
            }
            return pulledFiles.length;
        } catch (e) {
            this.displayError(e);

            return false;
        }
    }

    async fetch(): Promise<void> {
        if (!(await this.remotesAreSet())) {
            return;
        }
        try {
            await this.gitManager.fetch();

            this.displayMessage(`Fetched from remote`);
            this.setPluginState({ offlineMode: false });
            this.app.workspace.trigger("obsidian-git:refresh");
        } catch (error) {
            this.displayError(error);
        }
    }

    async mayDeleteConflictFile(): Promise<void> {
        const file = this.app.vault.getAbstractFileByPath(CONFLICT_OUTPUT_FILE);
        if (file) {
            this.app.workspace.iterateAllLeaves((leaf) => {
                if (
                    leaf.view instanceof MarkdownView &&
                    leaf.view.file?.path == file.path
                ) {
                    leaf.detach();
                }
            });
            await this.app.vault.delete(file);
        }
    }

    async stageFile(file: TFile, repo?: GitRepo): Promise<boolean> {
        const target = repo ?? this.repoForFile(file);
        if (!target || !target.ready) return false;

        await target.gitManager.stage(file.path, true);

        this.app.workspace.trigger("obsidian-git:refresh", target.id);

        this.setPluginState({ gitAction: CurrentGitAction.idle });
        return true;
    }

    async unstageFile(file: TFile, repo?: GitRepo): Promise<boolean> {
        const target = repo ?? this.repoForFile(file);
        if (!target || !target.ready) return false;

        await target.gitManager.unstage(file.path, true);

        this.app.workspace.trigger("obsidian-git:refresh", target.id);

        this.setPluginState({ gitAction: CurrentGitAction.idle });
        return true;
    }

    async switchBranch(): Promise<string | undefined> {
        if (!(await this.isAllInitialized())) return;

        const branchInfo = await this.gitManager.branchInfo();
        const selectedBranch = await new BranchModal(
            this,
            branchInfo.branches
        ).openAndGetReslt();

        if (selectedBranch != undefined) {
            await this.gitManager.checkout(selectedBranch);
            this.displayMessage(`Switched to ${selectedBranch}`);
            this.app.workspace.trigger("obsidian-git:refresh");
            await this.branchBar?.display();
            return selectedBranch;
        }
    }

    async switchRemoteBranch(): Promise<string | undefined> {
        if (!(await this.isAllInitialized())) return;

        const selectedBranch = (await this.selectRemoteBranch()) || "";

        const [remote, branch] = splitRemoteBranch(selectedBranch);

        if (branch != undefined && remote != undefined) {
            await this.gitManager.checkout(branch, remote);
            this.displayMessage(`Switched to ${selectedBranch}`);
            await this.branchBar?.display();
            return selectedBranch;
        }
    }

    async createBranch(): Promise<string | undefined> {
        if (!(await this.isAllInitialized())) return;

        const newBranch = await new GeneralModal(this, {
            placeholder: "Create new branch",
        }).openAndGetResult();
        if (newBranch != undefined) {
            await this.gitManager.createBranch(newBranch);
            this.displayMessage(`Created new branch ${newBranch}`);
            await this.branchBar?.display();
            return newBranch;
        }
    }

    async deleteBranch(): Promise<string | undefined> {
        if (!(await this.isAllInitialized())) return;

        const branchInfo = await this.gitManager.branchInfo();
        if (branchInfo.current) branchInfo.branches.remove(branchInfo.current);
        const branch = await new GeneralModal(this, {
            options: branchInfo.branches,
            placeholder: "Delete branch",
            onlySelection: true,
        }).openAndGetResult();
        if (branch != undefined) {
            let force = false;
            const merged = await this.gitManager.branchIsMerged(branch);
            // Using await inside IF throws exception
            if (!merged) {
                const forceAnswer = await new GeneralModal(this, {
                    options: ["YES", "NO"],
                    placeholder:
                        "This branch isn't merged into HEAD. Force delete?",
                    onlySelection: true,
                }).openAndGetResult();
                if (forceAnswer !== "YES") {
                    return;
                }
                force = forceAnswer === "YES";
            }
            await this.gitManager.deleteBranch(branch, force);
            this.displayMessage(`Deleted branch ${branch}`);
            await this.branchBar?.display();
            return branch;
        }
    }

    /** Ensures that the upstream branch is set.
     * If not, it will prompt the user to set it.
     *
     * An exception is when the user has submodules enabled.
     * In this case, the upstream branch is not required,
     * to allow pulling/pushing only the submodules and not the outer repo.
     */
    async remotesAreSet(): Promise<boolean> {
        if (this.settings.updateSubmodules) {
            return true;
        }
        if (
            this.gitManager instanceof SimpleGit &&
            (await this.gitManager.getConfig("push.autoSetupRemote", "all")) ==
                "true"
        ) {
            return true;
        }
        if (!(await this.gitManager.branchInfo()).tracking) {
            new Notice("No upstream branch is set. Please select one.");
            return await this.setUpstreamBranch();
        }
        return true;
    }

    async setUpstreamBranch(): Promise<boolean> {
        const remoteBranch = await this.selectRemoteBranch();

        if (remoteBranch == undefined) {
            this.displayError("Aborted. No upstream-branch is set!", 10000);
            this.setPluginState({ gitAction: CurrentGitAction.idle });
            return false;
        } else {
            await this.gitManager.updateUpstreamBranch(remoteBranch);
            this.displayMessage(`Set upstream branch to ${remoteBranch}`);
            this.setPluginState({ gitAction: CurrentGitAction.idle });
            return true;
        }
    }

    async discardAll(path?: string): Promise<DiscardResult> {
        if (!(await this.isAllInitialized())) return false;

        const status = await this.gitManager.status({ path });

        let filesToDeleteCount = 0;
        let filesToDiscardCount = 0;
        for (const file of status.changed) {
            if (file.workingDir == "U") {
                filesToDeleteCount++;
            } else {
                filesToDiscardCount++;
            }
        }
        if (filesToDeleteCount + filesToDiscardCount == 0) {
            return false;
        }

        const result = await new DiscardModal({
            app: this.app,
            filesToDeleteCount,
            filesToDiscardCount,
            path: path ?? "",
        }).openAndGetResult();

        switch (result) {
            case false:
                return result;
            case "discard":
                await this.gitManager.discardAll({
                    dir: path,
                    status: this.cachedStatus,
                });
                break;
            case "delete": {
                await this.gitManager.discardAll({
                    dir: path,
                    status: this.cachedStatus,
                });
                const untrackedPaths = await this.gitManager.getUntrackedPaths({
                    path,
                    status: this.cachedStatus,
                });
                for (const file of untrackedPaths) {
                    const vaultPath =
                        this.gitManager.getRelativeVaultPath(file);
                    const tFile =
                        this.app.vault.getAbstractFileByPath(vaultPath);

                    if (tFile) {
                        await this.app.fileManager.trashFile(tFile);
                    } else {
                        if (file.endsWith("/")) {
                            await this.app.vault.adapter.rmdir(vaultPath, true);
                        } else {
                            await this.app.vault.adapter.remove(vaultPath);
                        }
                    }
                }
                break;
            }
            default:
                assertNever(result);
        }
        this.app.workspace.trigger("obsidian-git:refresh");
        return result;
    }

    async handleConflict(conflicted?: string[]): Promise<void> {
        this.localStorage.setConflict(true);
        let lines: string[] | undefined;
        if (conflicted !== undefined) {
            lines = [
                "# Conflicts",
                "Please resolve them and commit them using the commands `Git: Commit all changes` followed by `Git: Push`",
                "(This file will automatically be deleted before commit)",
                "[[#Additional Instructions]] available below file list",
                "",
                ...conflicted.map((e) => {
                    const file = this.app.vault.getAbstractFileByPath(e);
                    if (file instanceof TFile) {
                        const link = this.app.metadataCache.fileToLinktext(
                            file,
                            "/"
                        );
                        return `- [[${link}]]`;
                    } else {
                        return `- Not a file: ${e}`;
                    }
                }),
                `
# Additional Instructions
I strongly recommend to use "Source mode" for viewing the conflicted files. For simple conflicts, in each file listed above replace every occurrence of the following text blocks with the desired text.

\`\`\`diff
<<<<<<< HEAD
    File changes in local repository
=======
    File changes in remote repository
>>>>>>> origin/main
\`\`\``,
            ];
        }
        await this.tools.writeAndOpenFile(lines?.join("\n"));
    }

    async editRemotes(): Promise<string | undefined> {
        if (!(await this.isAllInitialized())) return;

        const remotes = await this.gitManager.getRemotes();

        const nameModal = new GeneralModal(this, {
            options: remotes,
            placeholder:
                "Select or create a new remote by typing its name and selecting it",
        });
        const remoteName = await nameModal.openAndGetResult();

        if (remoteName) {
            const oldUrl = await this.gitManager.getRemoteUrl(remoteName);

            const urlModal = new GeneralModal(this, {
                initialValue: oldUrl,
                placeholder: "Enter remote URL",
            });
            // urlModal.inputEl.setText(oldUrl ?? "");
            const remoteURL = await urlModal.openAndGetResult();
            if (remoteURL) {
                await this.gitManager.setRemote(
                    remoteName,
                    formatRemoteUrl(remoteURL)
                );
                return remoteName;
            }
        }
    }

    async selectRemoteBranch(): Promise<string | undefined> {
        let remotes = await this.gitManager.getRemotes();
        let selectedRemote: string | undefined;
        if (remotes.length === 0) {
            selectedRemote = await this.editRemotes();
            if (selectedRemote == undefined) {
                remotes = await this.gitManager.getRemotes();
            }
        }

        const nameModal = new GeneralModal(this, {
            options: remotes,
            placeholder:
                "Select or create a new remote by typing its name and selecting it",
        });
        const remoteName =
            selectedRemote ?? (await nameModal.openAndGetResult());

        if (remoteName) {
            this.displayMessage("Fetching remote branches");
            await this.gitManager.fetch(remoteName);
            const branches =
                await this.gitManager.getRemoteBranches(remoteName);
            const branchModal = new GeneralModal(this, {
                options: branches,
                placeholder:
                    "Select or create a new remote branch by typing its name and selecting it",
            });
            const branch = await branchModal.openAndGetResult();
            if (branch == undefined) return;
            if (!branch.startsWith(remoteName + "/")) {
                // If the branch does not start with the remote name, prepend it
                return `${remoteName}/${branch}`;
            }
            return branch; // Already in the correct format
        }
    }

    async removeRemote() {
        if (!(await this.isAllInitialized())) return;

        const remotes = await this.gitManager.getRemotes();

        const nameModal = new GeneralModal(this, {
            options: remotes,
            placeholder: "Select a remote",
        });
        const remoteName = await nameModal.openAndGetResult();

        if (remoteName) {
            await this.gitManager.removeRemote(remoteName);
        }
    }

    onActiveLeafChange(leaf: WorkspaceLeaf | null): void {
        const view = leaf?.view;
        // Prevent removing focus when switching to other panes than file panes like search or GitView
        if (
            !view?.getState().file &&
            !(view instanceof DiffView || view instanceof SplitDiffView)
        )
            return;

        const sourceControlLeaf = this.app.workspace
            .getLeavesOfType(SOURCE_CONTROL_VIEW_CONFIG.type)
            .first();
        const historyLeaf = this.app.workspace
            .getLeavesOfType(HISTORY_VIEW_CONFIG.type)
            .first();

        // Clear existing active state
        sourceControlLeaf?.view.containerEl
            .querySelector(`div.tree-item-self.is-active`)
            ?.removeClass("is-active");
        historyLeaf?.view.containerEl
            .querySelector(`div.tree-item-self.is-active`)
            ?.removeClass("is-active");

        if (
            leaf?.view instanceof DiffView ||
            leaf?.view instanceof SplitDiffView
        ) {
            const path = leaf.view.state.bFile;
            const escapedPath = path.replace(/["\\]/g, "\\$&");
            this.lastDiffViewState = leaf.view.getState();
            let el: Element | undefined | null;
            if (sourceControlLeaf && leaf.view.state.aRef == "HEAD") {
                el = sourceControlLeaf.view.containerEl.querySelector(
                    `div.staged div.tree-item-self[data-path="${escapedPath}"]`
                );
            } else if (sourceControlLeaf && leaf.view.state.aRef == "") {
                el = sourceControlLeaf.view.containerEl.querySelector(
                    `div.changes div.tree-item-self[data-path="${escapedPath}"]`
                );
            } else if (historyLeaf) {
                el = historyLeaf.view.containerEl.querySelector(
                    `div.tree-item-self[data-path='${escapedPath}']`
                );
            }
            el?.addClass("is-active");
        } else {
            this.lastDiffViewState = undefined;
        }
    }

    handleNoNetworkError(_: NoNetworkError): void {
        if (!this.state.offlineMode) {
            this.displayError(
                "Git: Going into offline mode. Future network errors will no longer be displayed.",
                2000
            );
        } else {
            this.log("Encountered network error, but already in offline mode");
        }
        this.setPluginState({
            gitAction: CurrentGitAction.idle,
            offlineMode: true,
        });
    }

    // region: displaying / formatting messages
    displayMessage(message: string, timeout: number = 4 * 1000): void {
        this.statusBar?.displayMessage(message.toLowerCase(), timeout);

        if (!this.settings.disablePopups) {
            if (
                !this.settings.disablePopupsForNoChanges ||
                !message.startsWith("No changes")
            ) {
                new Notice(message, 5 * 1000);
            }
        }

        this.log(message);
    }

    displayError(data: unknown, timeout: number = 10 * 1000): void {
        if (data instanceof Errors.UserCanceledError) {
            new Notice("Aborted");
            return;
        }
        let error: Error;
        if (data instanceof Error) {
            error = data;
        } else {
            error = new Error(String(data));
        }

        this.setPluginState({ gitAction: CurrentGitAction.idle });
        if (this.settings.showErrorNotices) {
            new Notice(error.message, timeout);
        }
        console.error(`${this.manifest.id}:`, error.stack);
        this.statusBar?.displayMessage(error.message.toLowerCase(), timeout);
    }

    log(...data: unknown[]) {
        console.log(`${this.manifest.id}:`, ...data);
    }
}
