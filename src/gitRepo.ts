import type { Debouncer } from "obsidian";
import { Platform } from "obsidian";
import AutomaticsManager from "./automaticsManager";
import type { GitManager } from "./gitManager/gitManager";
import { IsomorphicGit } from "./gitManager/isomorphicGit";
import { SimpleGit } from "./gitManager/simpleGit";
import type ObsidianGit from "./main";
import { PromiseQueue } from "./promiseQueue";
import type {
    BranchInfo,
    PerRepoSettings,
    PluginState,
    RepoConfig,
    Status,
} from "./types";
import { CurrentGitAction } from "./types";

/**
 * Runtime aggregate for one registered Git repository.
 * Owns its own gitManager, automatics, promise queue, status cache, and state.
 */
export class GitRepo {
    readonly plugin: ObsidianGit;
    /** Persisted config (path, displayName, overrides, gitDir, id). */
    config: RepoConfig;
    /** Concrete git manager (SimpleGit on desktop, IsomorphicGit on mobile). */
    gitManager: GitManager;
    /** Per-repo automatics. */
    automatics: AutomaticsManager;
    /** Per-repo serialized op queue. Cross-repo ops run in parallel. */
    promiseQueue: PromiseQueue;
    /** Per-repo file-event debouncer (auto-refresh source control view). */
    fileEventDebouncer?: Debouncer<[], void>;

    /** True after `init()` completes successfully. */
    ready = false;

    /** Per-repo runtime state. */
    state: PluginState = {
        gitAction: CurrentGitAction.idle,
        offlineMode: false,
    };

    /** Last cached status (set by `updateCachedStatus`). */
    cachedStatus?: Status;
    /** Last fetched branch info. */
    branchInfo?: BranchInfo;

    constructor(plugin: ObsidianGit, config: RepoConfig) {
        this.plugin = plugin;
        this.config = config;
        if (Platform.isDesktopApp) {
            this.gitManager = new SimpleGit(plugin, config);
        } else {
            this.gitManager = new IsomorphicGit(plugin, config);
        }
        this.automatics = new AutomaticsManager(this);
        this.promiseQueue = new PromiseQueue(plugin);
    }

    /** Stable id (delegates to config.id). */
    get id(): string {
        return this.config.id;
    }

    /** Display name. */
    get displayName(): string {
        return this.config.displayName;
    }

    /** Vault-relative path; "" for vault root. */
    get vaultRelativePath(): string {
        return this.config.path;
    }

    /** Effective settings = global defaults merged with this repo's overrides. */
    get settings(): PerRepoSettings {
        return {
            ...this.plugin.settings.globalRepoDefaults,
            ...this.config.overrides,
        };
    }

    /**
     * Update status cache. Triggers `obsidian-git:status-changed`.
     */
    async updateCachedStatus(): Promise<Status> {
        this.plugin.app.workspace.trigger(
            "obsidian-git:loading-status",
            this.id
        );
        this.cachedStatus = await this.gitManager.status();
        this.plugin.app.workspace.trigger(
            "obsidian-git:status-changed",
            this.cachedStatus,
            this.id
        );
        return this.cachedStatus;
    }

    /**
     * Setup phase. Calls into the gitManager to verify the repo. Sets `ready`
     * on success. Caller (plugin) handles user-visible errors.
     */
    async init(): Promise<"valid" | "missing-repo" | "missing-git"> {
        if (this.gitManager instanceof SimpleGit) {
            await this.gitManager.setGitInstance(true);
        }
        const result = await this.gitManager.checkRequirements();
        if (result === "valid") {
            this.ready = true;
        }
        return result;
    }

    /** Stop automatics, clear queue, free per-repo resources. */
    unload(): void {
        this.ready = false;
        this.automatics.unload();
        this.gitManager.unload();
        this.promiseQueue.clear();
        this.fileEventDebouncer?.cancel();
        this.fileEventDebouncer = undefined;
    }
}
