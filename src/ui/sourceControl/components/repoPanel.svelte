<script lang="ts">
    import { setIcon } from "obsidian";
    import { onMount } from "svelte";
    import { slide } from "svelte/transition";
    import type { GitRepo } from "src/gitRepo";
    import type ObsidianGit from "src/main";
    import {
        FileType,
        type FileStatusResult,
        type Status,
        type StatusRootTreeItem,
    } from "src/types";
    import { arrayProxyWithNewLength, getDisplayPath } from "src/utils";
    import type GitView from "../sourceControl";
    import FileComponent from "./fileComponent.svelte";
    import PulledFileComponent from "./pulledFileComponent.svelte";
    import RepoHeader from "./repoHeader.svelte";
    import StagedFileComponent from "./stagedFileComponent.svelte";
    import TooManyFilesComponent from "./tooManyFilesComponent.svelte";
    import TreeComponent from "./treeComponent.svelte";

    interface Props {
        plugin: ObsidianGit;
        repo: GitRepo;
        view: GitView;
    }

    let { plugin, repo, view }: Props = $props();

    // svelte-ignore state_referenced_locally
    let collapsed = $state(
        plugin.localStorage.getCollapsedRepos().has(repo.id)
    );
    let loading = $state(false);
    let status: Status | undefined = $state();
    // svelte-ignore state_referenced_locally
    let commitMessage = $state(repo.settings.commitMessage);
    let unPushedCommits = $state(0);
    let branchName: string | undefined = $state();
    let hasUpstream = $state(true);
    let changeHierarchy: StatusRootTreeItem | undefined = $state();
    let stagedHierarchy: StatusRootTreeItem | undefined = $state();
    let lastPulledFilesHierarchy: StatusRootTreeItem | undefined = $state();
    let changesOpen = $state(true);
    let stagedOpen = $state(true);
    let lastPulledFilesOpen = $state(true);
    let stagedClosed: Record<string, boolean> = $state({});
    let unstagedClosed: Record<string, boolean> = $state({});
    let pulledClosed: Record<string, boolean> = $state({});
    let lastPulledFiles: FileStatusResult[] = $state([]);
    let iconButtons: HTMLElement[] = $state([]);
    let refreshSeq = 0;

    let showTree = $derived(plugin.settings.treeStructure);
    let rows = $derived((commitMessage.match(/\n/g)?.length ?? 0) + 1);

    onMount(() => {
        view.registerEvent(
            view.app.workspace.on(
                "obsidian-git:loading-status",
                (repoId) => {
                    if (!repoId || repoId === repo.id) loading = true;
                }
            )
        );
        view.registerEvent(
            view.app.workspace.on(
                "obsidian-git:status-changed",
                (_status, repoId) => {
                    if (!repoId || repoId === repo.id) {
                        void refresh().catch(console.error);
                    }
                }
            )
        );

        if (!repo.cachedStatus) {
            plugin.refresh(repo.id).catch(console.error);
        } else {
            refresh().catch(console.error);
        }
    });

    $effect(() => {
        for (const el of iconButtons) {
            if (el) setIcon(el, el.getAttr("data-icon")!);
        }
    });

    async function refresh(): Promise<void> {
        if (!plugin.gitReady || !repo.ready) {
            status = undefined;
            return;
        }
        const mySeq = ++refreshSeq;
        let nextUnpushed = 0;
        try {
            nextUnpushed = await repo.gitManager.getUnpushedCommits();
        } catch {
            nextUnpushed = 0;
        }
        let nextBranch: string | undefined;
        let nextHasUpstream = false;
        try {
            const info = await repo.gitManager.branchInfo();
            nextBranch = info.current;
            nextHasUpstream = Boolean(info.tracking);
        } catch {
            nextBranch = undefined;
            nextHasUpstream = false;
        }

        // Discard results if a newer refresh has started.
        if (mySeq !== refreshSeq) return;

        unPushedCommits = nextUnpushed;
        branchName = nextBranch;
        hasUpstream = nextHasUpstream;
        status = repo.cachedStatus;
        loading = false;
        if (status) {
            const sort = (a: FileStatusResult, b: FileStatusResult) =>
                a.vaultPath
                    .split("/")
                    .last()!
                    .localeCompare(getDisplayPath(b.vaultPath));
            status.changed.sort(sort);
            status.staged.sort(sort);
            changeHierarchy = {
                title: "",
                path: "",
                vaultPath: "",
                children: repo.gitManager.getTreeStructure(status.changed),
            };
            stagedHierarchy = {
                title: "",
                path: "",
                vaultPath: "",
                children: repo.gitManager.getTreeStructure(status.staged),
            };
        } else {
            changeHierarchy = undefined;
            stagedHierarchy = undefined;
        }
    }

    function triggerRefresh() {
        view.app.workspace.trigger("obsidian-git:refresh", repo.id);
    }

    function toggleCollapsed() {
        collapsed = !collapsed;
        const set = plugin.localStorage.getCollapsedRepos();
        if (collapsed) set.add(repo.id);
        else set.delete(repo.id);
        plugin.localStorage.setCollapsedRepos(set);
    }

    function commit() {
        loading = true;
        const onlyStaged = (status?.staged.length ?? 0) > 0;
        repo.promiseQueue.addTask(() =>
            plugin
                .commitRepo(repo, {
                    fromAuto: false,
                    commitMessage,
                    onlyStaged,
                })
                .then(() => {
                    commitMessage = repo.settings.commitMessage;
                })
                .finally(triggerRefresh)
        );
    }

    function commitAndSync() {
        loading = true;
        const onlyStaged = (status?.staged.length ?? 0) > 0;
        repo.promiseQueue.addTask(() =>
            plugin
                .commitAndSyncRepo(repo, {
                    fromAutoBackup: false,
                    commitMessage,
                    onlyStaged,
                })
                .then(() => {
                    commitMessage = repo.settings.commitMessage;
                })
                .finally(triggerRefresh)
        );
    }

    function stageAll(event: MouseEvent) {
        event.stopPropagation();
        loading = true;
        repo.promiseQueue.addTask(() =>
            repo.gitManager.stageAll({ status }).finally(triggerRefresh)
        );
    }

    function unstageAll(event: MouseEvent) {
        event.stopPropagation();
        loading = true;
        repo.promiseQueue.addTask(() =>
            repo.gitManager.unstageAll({ status }).finally(triggerRefresh)
        );
    }

    function discard(event: Event) {
        event.stopPropagation();
        void plugin.discardAll(undefined, repo);
    }

    function handleTextareaKeydown(event: KeyboardEvent) {
        if (event.ctrlKey && event.key === "Enter") {
            event.preventDefault();
            commitAndSync();
        }
    }

    function toggleLayout() {
        plugin.settings.treeStructure = !plugin.settings.treeStructure;
        void plugin.saveSettings();
    }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="git-repo-panel" class:is-collapsed={collapsed}>
    <RepoHeader
        {plugin}
        {repo}
        {collapsed}
        {loading}
        {branchName}
        {hasUpstream}
        {unPushedCommits}
        onToggleCollapsed={toggleCollapsed}
        onCommitAndSync={commitAndSync}
        onCommit={commit}
        onRefresh={triggerRefresh}
        onToggleLayout={toggleLayout}
    />

    {#if !collapsed}
        <div class="git-repo-body">
            <div class="git-commit-msg">
                <textarea
                    {rows}
                    class="commit-msg-input"
                    spellcheck="true"
                    placeholder="Commit message (Ctrl+Enter to commit-and-sync)"
                    bind:value={commitMessage}
                    onkeydown={handleTextareaKeydown}
                ></textarea>
                {#if commitMessage}
                    <div
                        class="git-commit-msg-clear-button"
                        onclick={() => (commitMessage = "")}
                        aria-label="Clear"
                    ></div>
                {/if}
            </div>
            <button
                class="git-repo-commit-button mod-cta"
                onclick={commit}
                disabled={!status}
            >
                Commit
            </button>

            <div class="nav-files-container" style="position: relative;">
                {#if status && stagedHierarchy && changeHierarchy}
                    <div class="tree-item nav-folder mod-root">
                        <div
                            class="staged tree-item nav-folder"
                            class:is-collapsed={!stagedOpen}
                        >
                            <div
                                class="tree-item-self is-clickable nav-folder-title"
                                onclick={() => (stagedOpen = !stagedOpen)}
                            >
                                <div
                                    class="tree-item-icon nav-folder-collapse-indicator collapse-icon"
                                    class:is-collapsed={!stagedOpen}
                                >
                                    <svg
                                        xmlns="http://www.w3.org/2000/svg"
                                        width="24"
                                        height="24"
                                        viewBox="0 0 24 24"
                                        fill="none"
                                        stroke="currentColor"
                                        stroke-width="2"
                                        stroke-linecap="round"
                                        stroke-linejoin="round"
                                        class="svg-icon right-triangle"
                                        ><path d="M3 8L12 17L21 8" /></svg
                                    >
                                </div>
                                <div
                                    class="tree-item-inner nav-folder-title-content"
                                >
                                    Staged Changes
                                </div>
                                <div class="git-tools">
                                    <div class="buttons">
                                        <div
                                            data-icon="minus"
                                            aria-label="Unstage"
                                            bind:this={iconButtons[0]}
                                            onclick={unstageAll}
                                            class="clickable-icon"
                                        ></div>
                                    </div>
                                    <div class="files-count">
                                        {status.staged.length}
                                    </div>
                                </div>
                            </div>
                            {#if stagedOpen}
                                <div
                                    class="tree-item-children nav-folder-children"
                                    transition:slide|local={{ duration: 150 }}
                                >
                                    {#if showTree}
                                        <TreeComponent
                                            hierarchy={stagedHierarchy}
                                            {plugin}
                                            {view}
                                            {repo}
                                            fileType={FileType.staged}
                                            topLevel={true}
                                            bind:closed={stagedClosed}
                                        />
                                    {:else}
                                        {#each arrayProxyWithNewLength(status.staged, 500) as stagedFile}
                                            <StagedFileComponent
                                                change={stagedFile}
                                                {view}
                                                manager={repo.gitManager}
                                            />
                                        {/each}
                                        <TooManyFilesComponent
                                            files={status.staged}
                                        />
                                    {/if}
                                </div>
                            {/if}
                        </div>
                        <div
                            class="changes tree-item nav-folder"
                            class:is-collapsed={!changesOpen}
                        >
                            <div
                                class="tree-item-self is-clickable nav-folder-title"
                                onclick={() => (changesOpen = !changesOpen)}
                            >
                                <div
                                    class="tree-item-icon nav-folder-collapse-indicator collapse-icon"
                                    class:is-collapsed={!changesOpen}
                                >
                                    <svg
                                        xmlns="http://www.w3.org/2000/svg"
                                        width="24"
                                        height="24"
                                        viewBox="0 0 24 24"
                                        fill="none"
                                        stroke="currentColor"
                                        stroke-width="2"
                                        stroke-linecap="round"
                                        stroke-linejoin="round"
                                        class="svg-icon right-triangle"
                                        ><path d="M3 8L12 17L21 8" /></svg
                                    >
                                </div>
                                <div
                                    class="tree-item-inner nav-folder-title-content"
                                >
                                    Changes
                                </div>
                                <div class="git-tools">
                                    <div class="buttons">
                                        <div
                                            data-icon="undo"
                                            aria-label="Discard"
                                            onclick={discard}
                                            class="clickable-icon"
                                            bind:this={iconButtons[1]}
                                        ></div>
                                        <div
                                            data-icon="plus"
                                            aria-label="Stage"
                                            bind:this={iconButtons[2]}
                                            onclick={stageAll}
                                            class="clickable-icon"
                                        ></div>
                                    </div>
                                    <div class="files-count">
                                        {status.changed.length}
                                    </div>
                                </div>
                            </div>
                            {#if changesOpen}
                                <div
                                    class="tree-item-children nav-folder-children"
                                    transition:slide|local={{ duration: 150 }}
                                >
                                    {#if showTree}
                                        <TreeComponent
                                            hierarchy={changeHierarchy}
                                            {plugin}
                                            {view}
                                            {repo}
                                            fileType={FileType.changed}
                                            topLevel={true}
                                            bind:closed={unstagedClosed}
                                        />
                                    {:else}
                                        {#each arrayProxyWithNewLength(status.changed, 500) as change}
                                            <FileComponent
                                                {change}
                                                {view}
                                                manager={repo.gitManager}
                                            />
                                        {/each}
                                        <TooManyFilesComponent
                                            files={status.changed}
                                        />
                                    {/if}
                                </div>
                            {/if}
                        </div>
                        {#if lastPulledFiles.length > 0 && lastPulledFilesHierarchy}
                            <div
                                class="pulled nav-folder"
                                class:is-collapsed={!lastPulledFilesOpen}
                            >
                                <div
                                    class="tree-item-self is-clickable nav-folder-title"
                                    onclick={() =>
                                        (lastPulledFilesOpen =
                                            !lastPulledFilesOpen)}
                                >
                                    <div
                                        class="tree-item-icon nav-folder-collapse-indicator collapse-icon"
                                    >
                                        <svg
                                            xmlns="http://www.w3.org/2000/svg"
                                            width="24"
                                            height="24"
                                            viewBox="0 0 24 24"
                                            fill="none"
                                            stroke="currentColor"
                                            stroke-width="2"
                                            stroke-linecap="round"
                                            stroke-linejoin="round"
                                            class="svg-icon right-triangle"
                                            ><path d="M3 8L12 17L21 8" /></svg
                                        >
                                    </div>
                                    <div
                                        class="tree-item-inner nav-folder-title-content"
                                    >
                                        Recently Pulled Files
                                    </div>
                                    <span class="tree-item-flair"
                                        >{lastPulledFiles.length}</span
                                    >
                                </div>
                                {#if lastPulledFilesOpen}
                                    <div
                                        class="tree-item-children nav-folder-children"
                                        transition:slide|local={{
                                            duration: 150,
                                        }}
                                    >
                                        {#if showTree}
                                            <TreeComponent
                                                hierarchy={lastPulledFilesHierarchy}
                                                {plugin}
                                                {view}
                                                {repo}
                                                fileType={FileType.pulled}
                                                topLevel={true}
                                                bind:closed={pulledClosed}
                                            />
                                        {:else}
                                            {#each lastPulledFiles as change}
                                                <PulledFileComponent
                                                    {change}
                                                    {view}
                                                />
                                            {/each}
                                            <TooManyFilesComponent
                                                files={lastPulledFiles}
                                            />
                                        {/if}
                                    </div>
                                {/if}
                            </div>
                        {/if}
                    </div>
                {/if}
            </div>
        </div>
    {/if}
</div>

<style lang="scss">
    .git-repo-panel {
        border-bottom: 1px solid var(--background-modifier-border);
    }
    .git-repo-panel:last-child {
        border-bottom: none;
    }

    .commit-msg-input {
        width: 100%;
        overflow: hidden;
        resize: none;
        padding: 7px 5px;
        background-color: var(--background-modifier-form-field);
    }

    .git-commit-msg {
        position: relative;
        padding: 0;
        width: calc(100% - var(--size-4-8));
        margin: 4px auto;
    }

    .git-repo-commit-button {
        display: block;
        width: calc(100% - var(--size-4-8));
        margin: 4px auto 8px auto;
        height: 32px;
    }

    .git-tools {
        .files-count {
            padding-left: var(--size-2-1);
            width: 11px;
            display: flex;
            align-items: center;
            justify-content: center;
        }
    }

    .git-commit-msg-clear-button {
        position: absolute;
        background: transparent;
        border-radius: 50%;
        color: var(--search-clear-button-color);
        cursor: var(--cursor);
        top: -4px;
        right: 2px;
        bottom: 0px;
        line-height: 0;
        height: var(--input-height);
        width: 28px;
        margin: auto;
        padding: 0 0;
        text-align: center;
        display: flex;
        justify-content: center;
        align-items: center;
        transition: color 0.15s ease-in-out;
    }

    .git-commit-msg-clear-button:after {
        content: "";
        height: var(--search-clear-button-size);
        width: var(--search-clear-button-size);
        display: block;
        background-color: currentColor;
        mask-image: url("data:image/svg+xml,<svg viewBox='0 0 12 12' fill='none' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath fill-rule='evenodd' clip-rule='evenodd' d='M6 12C9.31371 12 12 9.31371 12 6C12 2.68629 9.31371 0 6 0C2.68629 0 0 2.68629 0 6C0 9.31371 2.68629 12 6 12ZM3.8705 3.09766L6.00003 5.22718L8.12955 3.09766L8.9024 3.8705L6.77287 6.00003L8.9024 8.12955L8.12955 8.9024L6.00003 6.77287L3.8705 8.9024L3.09766 8.12955L5.22718 6.00003L3.09766 3.8705L3.8705 3.09766Z' fill='currentColor'/></svg>");
        mask-repeat: no-repeat;
        -webkit-mask-image: url("data:image/svg+xml,<svg viewBox='0 0 12 12' fill='none' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath fill-rule='evenodd' clip-rule='evenodd' d='M6 12C9.31371 12 12 9.31371 12 6C12 2.68629 9.31371 0 6 0C2.68629 0 0 2.68629 0 6C0 9.31371 2.68629 12 6 12ZM3.8705 3.09766L6.00003 5.22718L8.12955 3.09766L8.9024 3.8705L6.77287 6.00003L8.9024 8.12955L8.12955 8.9024L6.00003 6.77287L3.8705 8.9024L3.09766 8.12955L5.22718 6.00003L3.09766 3.8705L3.8705 3.09766Z' fill='currentColor'/></svg>");
        -webkit-mask-repeat: no-repeat;
    }
</style>
