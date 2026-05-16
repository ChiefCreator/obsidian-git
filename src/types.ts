import type { LineAuthorSettings } from "src/editor/lineAuthor/model";

/**
 * Settings that may differ per Git repository registered with the plugin.
 * Every field has a value in `ObsidianGitSettings.globalRepoDefaults`; a
 * `RepoConfig.overrides` object may set a subset of these fields to override
 * the global default for that specific repo.
 */
export interface PerRepoSettings {
    commitMessage: string;
    autoCommitMessage: string;
    commitMessageScript: string;
    commitDateFormat: string;
    autoSaveInterval: number;
    autoPushInterval: number;
    autoPullInterval: number;
    autoPullOnBoot: boolean;
    autoCommitOnlyStaged: boolean;
    syncMethod: SyncMethod;
    mergeStrategy: MergeStrategy;
    disablePush: boolean;
    pullBeforePush: boolean;
    differentIntervalCommitAndPush: boolean;
    customMessageOnAutoBackup: boolean;
    autoBackupAfterFileChange: boolean;
    setLastSaveToLastCommit: boolean;
    updateSubmodules: boolean;
    submoduleRecurseCheckout: boolean;
    listChangedFilesInMessageBody: boolean;
}

/**
 * Persisted configuration for one registered Git repository.
 */
export interface RepoConfig {
    /** Stable UUID generated at add time. */
    id: string;
    /** User-editable display name. Defaults to last path segment, or "Vault" for root. */
    displayName: string;
    /** Vault-relative path. "" means the vault root. Normalized with `normalizePath`. */
    path: string;
    /** Optional GIT_DIR override. Empty/absent means `<path>/.git`. */
    gitDir?: string;
    /** Subset of {@link PerRepoSettings} to override the global defaults. Empty `{}` = inherit all. */
    overrides: Partial<PerRepoSettings>;
}

export interface ObsidianGitSettings {
    // ----- Repositories (NEW) -----
    repos: RepoConfig[];
    defaultRepoId: string | null;
    globalRepoDefaults: PerRepoSettings;

    // ----- UI chrome (global) -----
    showStatusBar: boolean;
    showBranchStatusBar: boolean;
    changedFilesInStatusBar: boolean;
    treeStructure: boolean;
    refreshSourceControl: boolean;
    refreshSourceControlTimer: number;
    showFileMenu: boolean;
    authorInHistoryView: ShowAuthorInHistoryView;
    dateInHistoryView: boolean;
    diffStyle: "git_unified" | "split";
    hunks: {
        hunkCommands: boolean;
        showSigns: boolean;
        statusBar: "disabled" | "colored" | "monochrome";
    };
    lineAuthor: LineAuthorSettings;

    // ----- Notifications (global) -----
    disablePopups: boolean;
    showErrorNotices: boolean;
    disablePopupsForNoChanges: boolean;

    // ----- Mobile notice flag (global) -----
    showedMobileNotice: boolean;

    // ----- Migration flag -----
    _migratedToMultiRepoV1: boolean;

    // ----- DEPRECATED legacy mirror fields -----
    // These remain in the settings object as a runtime mirror of the active repo's
    // effective settings (and basePath/gitDir from its RepoConfig). New code should
    // read from `repos[].overrides` / `globalRepoDefaults`. The fields stay so legacy
    // consumer code (settings UI, commands, etc.) continues to work pending a full
    // rewrite per plan Tasks 13-20.
    /** @deprecated Mirror of active repo's `config.path`. */
    basePath: string;
    /** @deprecated Mirror of active repo's `config.gitDir`. */
    gitDir: string;
    /** @deprecated Mirror of active repo's effective `commitMessage`. */
    commitMessage: string;
    /** @deprecated */ autoCommitMessage: string;
    /** @deprecated */ commitMessageScript: string;
    /** @deprecated */ commitDateFormat: string;
    /** @deprecated */ autoSaveInterval: number;
    /** @deprecated */ autoPushInterval: number;
    /** @deprecated */ autoPullInterval: number;
    /** @deprecated */ autoPullOnBoot: boolean;
    /** @deprecated */ autoCommitOnlyStaged: boolean;
    /** @deprecated */ syncMethod: SyncMethod;
    /** @deprecated */ mergeStrategy: MergeStrategy;
    /** @deprecated */ disablePush: boolean;
    /** @deprecated */ pullBeforePush: boolean;
    /** @deprecated */ differentIntervalCommitAndPush: boolean;
    /** @deprecated */ customMessageOnAutoBackup: boolean;
    /** @deprecated */ autoBackupAfterFileChange: boolean;
    /** @deprecated */ setLastSaveToLastCommit: boolean;
    /** @deprecated */ updateSubmodules: boolean;
    /** @deprecated */ submoduleRecurseCheckout: boolean;
    /** @deprecated */ listChangedFilesInMessageBody: boolean;
    /** @deprecated Already deprecated pre-v2. */
    mergeOnPull?: boolean;
    /** @deprecated Already deprecated pre-v2. */
    gitPath?: string;
    /** @deprecated Already deprecated pre-v2. */
    username?: string;
}

/**
 * Ensures, that nested values objects are correctly merged.
 */
export function mergeSettingsByPriority(
    low: ObsidianGitSettings,
    high: Partial<ObsidianGitSettings>
): ObsidianGitSettings {
    const lineAuthor = Object.assign({}, low.lineAuthor, high.lineAuthor);
    const globalRepoDefaults = Object.assign(
        {},
        low.globalRepoDefaults,
        high.globalRepoDefaults
    );
    return Object.assign({}, low, high, { lineAuthor, globalRepoDefaults });
}

export type SyncMethod = "rebase" | "merge" | "reset";

export type MergeStrategy = "none" | "ours" | "theirs";

export type ShowAuthorInHistoryView = "full" | "initials" | "hide";

export interface Author {
    name: string;
    email: string;
}

export interface Status {
    all: FileStatusResult[];
    changed: FileStatusResult[];
    staged: FileStatusResult[];

    /*
     * Only available for `SimpleGit` gitManager
     */
    conflicted: string[];
}

export interface GitTimestamp {
    /**
     * The number of unix seconds since epoch time (UTC).
     */
    epochSeconds: number;
    /**
     * The time zone, in which the commit was originally created.
     * This can be used to reconstruct the local time during creating time.
     */
    tz: string;
}

export interface UserEmail {
    name: string;
    email: string;
}

export interface BlameCommit {
    hash: string;
    author?: UserEmail & GitTimestamp;
    committer?: UserEmail & GitTimestamp;
    previous?: { commitHash?: string; filename: string };
    filename?: string;
    summary: string;
    isZeroCommit: boolean; // true, if hash is 000...000
}

/**
 * See https://git-scm.com/docs/git-blame#_the_porcelain_format
 */
export interface Blame {
    commits: Map<string, BlameCommit>;
    /**
     * hashPerLine[i] is the commit hash where line i originates from
     *
     * The first element is always `undefined`, since line-numbers are 1-based.
     */
    hashPerLine: string[];
    /**
     * originalFileLineNrPerLine[i] contains the original files' line number from where line i
     *
     * The first element is always `undefined`, since line-numbers are 1-based.originated
     */
    originalFileLineNrPerLine: number[];
    /**
     * finalFileLineNrPerLine[i] contains the final files' line number from where line i originated
     *
     * The first element is always `undefined`, since line-numbers are 1-based.
     */
    finalFileLineNrPerLine: number[];
    /**
     * For each line i, which originates from a different commit than it's previous line,
     * groupSizePerStartingLine[i] contains the number of lines until either the next
     * group of lines or EOF is reached.
     */
    groupSizePerStartingLine: Map<number, number>;
}

/**
 * `index` and `working_dir` are each one-character codes, based off the git
 * status short format: git status --short
 * The following is from: https://www.git-scm.com/docs/git-status#_short_format
 *
 * The possible values are:
 * - ' ': unmodified
 * - M  : modified
 * - T  : file type changed
 * - A  : added
 * - D  : deleted
 * - R  : renamed
 * - C  : copied
 * - U  : updated but unmerged
 *
 *  index            working_dir            Meaning
 * ------------------------------------------------------------------------
 *                    [AMD]                 not updated
 *    M               [ MTD]                updated in index
 *    T               [ MTD]                type changed in index
 *    A               [ MTD]                added to index
 *    D                                     deleted from index
 *    R               [ MTD]                renamed in index
 *    C               [ MTD]                copied in index
 * [MTARC]                                  index and work tree match
 * [ MTARC]              M                  work tree changed since index
 * [ MTARC]              T                  type changed in work tree since index
 * [ MTARC]              D                  deleted in work tree
 *                       R                  renamed in work tree
 *                       C                  copied in work tree
 *    D                  D                  unmerged, both deleted
 *    A                  U                  unmerged, added by us
 *    U                  D                  unmerged, deleted by them
 *    U                  A                  unmerged, added by them
 *    D                  U                  unmerged, deleted by us
 *    A                  A                  unmerged, both added
 *    U                  U                  unmerged, both modified
 *    ?                  ?                  untracked
 *    !                  !                  ignored
 *
 *
 * FileStatusResult is based off simple-git's FileStatusResult:
 * https://github.com/steveukx/git-js/blob/a569868d800a0d872e8fb1534bb0dceccff47a4f/typings/response.d.ts#L267
 */
export interface FileStatusResult {
    path: string;
    vaultPath: string;
    from?: string;

    // First digit of the status code of the file, e.g. 'M' = modified.
    // Represents the status of the index if no merge conflicts, otherwise represents
    // status of one side of the merge.
    index: string;
    // Second digit of the status code of the file. Represents status of the working directory
    // if no merge conflicts, otherwise represents status of other side of a merge.
    workingDir: string;
}

export interface PluginState {
    offlineMode: boolean;
    gitAction: CurrentGitAction;
}

export enum CurrentGitAction {
    idle,
    status,
    pull,
    add,
    commit,
    push,
}

export interface LogEntry {
    hash: string;
    date: string;
    message: string;
    refs: string[];
    body: string;
    diff: DiffEntry;
    author: {
        name: string;
        email: string;
    };
}

export interface DiffEntry {
    changed: number;
    files: DiffFile[];
}

export interface DiffFile {
    path: string;
    vaultPath: string;
    fromPath?: string;
    fromVaultPath?: string;
    hash: string;
    status: string;
    binary?: boolean;
}

export interface WalkDifference {
    path: string;
    type: "M" | "A" | "D";
}

export type UnstagedFile = WalkDifference;

export interface BranchInfo {
    current?: string;
    tracking?: string;
    branches: string[];
}

export interface TreeItem<T = DiffFile | FileStatusResult> {
    title: string;
    path: string;
    vaultPath: string;
    data?: T;
    children?: TreeItem<T>[];
}

export type RootTreeItem<T> = TreeItem<T> & { children: TreeItem<T>[] };

export type StatusRootTreeItem = RootTreeItem<FileStatusResult>;

export type HistoryRootTreeItem = RootTreeItem<DiffFile>;

export type DiffViewState = {
    /**
     * Id of the repository this diff was opened against. Undefined values
     * indicate a pre-multi-repo persisted state and are tolerated for backward
     * compatibility (the view falls back to the active repo).
     */
    repoId?: string;

    /**
     * The repo relative file path for a.
     * For diffing a renamed file, this is the old path.
     */
    aFile: string;

    /**
     * The git ref to specify which state of that file should be shown.
     * An empty string refers to the index version of a file, so you have to specifically check against undefined.
     */
    aRef: string;

    /**
     * The repo relative file path for b.
     */
    bFile: string;

    /**
     * The git ref to specify which state of that file should be shown.
     * An empty string refers to the index version of a file, so you have to specifically check against undefined.
     * `undefined` stands for the working tree version.
     */
    bRef?: string;
};

export enum FileType {
    staged,
    changed,
    pulled,
}

export class NoNetworkError extends Error {
    constructor(public readonly originalError: string) {
        super("No network connection available");
    }
}

declare module "obsidian" {
    interface App {
        openWithDefaultApp(path: string): void;
        getTheme(): "obsidian" | "moonstone";
        viewRegistry: ViewRegistry;
        setting: {
            open(): void;
            openTabById(id: string): void;
        };
    }
    interface View {
        titleEl: HTMLElement;
        inlineTitleEl: HTMLElement;
    }
    interface ViewRegistry {
        /**
         * PRIVATE API
         *
         * Returns the view type for the given extension if available.
         */
        getTypeByExtension(extension: string): string;
    }
    interface Workspace {
        /**
         * Emitted when some git action has been completed and plugin has been refreshed
         */
        on(
            name: "obsidian-git:refreshed",
            callback: (repoId?: string) => void,
            ctx?: unknown
        ): EventRef;
        /**
         * Emitted when some git action has been completed and the plugin should refresh
         */
        on(
            name: "obsidian-git:refresh",
            callback: (repoId?: string) => void,
            ctx?: unknown
        ): EventRef;
        /**
         * Emitted when the plugin is currently loading a new cached status.
         */
        on(
            name: "obsidian-git:loading-status",
            callback: (repoId?: string) => void,
            ctx?: unknown
        ): EventRef;
        /**
         * Emitted when the HEAD changed.
         */
        on(
            name: "obsidian-git:head-change",
            callback: (repoId?: string) => void,
            ctx?: unknown
        ): EventRef;
        /**
         * Emitted when a new cached status is available.
         */
        on(
            name: "obsidian-git:status-changed",
            callback: (status: Status, repoId?: string) => void,
            ctx?: unknown
        ): EventRef;

        on(
            name: "obsidian-git:menu",
            callback: (
                menu: Menu,
                path: string,
                source: string,
                leaf?: WorkspaceLeaf
            ) => unknown,
            ctx?: unknown
        ): EventRef;
        trigger(name: string, ...data: unknown[]): void;
        trigger(name: "obsidian-git:refreshed", repoId?: string): void;
        trigger(name: "obsidian-git:refresh", repoId?: string): void;
        trigger(name: "obsidian-git:loading-status", repoId?: string): void;
        trigger(name: "obsidian-git:head-change", repoId?: string): void;
        trigger(
            name: "obsidian-git:status-changed",
            status: Status,
            repoId?: string
        ): void;
        trigger(
            name: "obsidian-git:menu",
            menu: Menu,
            path: string,
            source: string,
            leaf?: WorkspaceLeaf
        ): void;
    }
}
