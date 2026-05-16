<script lang="ts">
    import { setIcon } from "obsidian";
    import type { GitRepo } from "src/gitRepo";
    import type ObsidianGit from "src/main";
    import { showRepoMenu } from "./repoMenu";

    interface Props {
        plugin: ObsidianGit;
        repo: GitRepo;
        collapsed: boolean;
        loading: boolean;
        branchName: string | undefined;
        hasUpstream: boolean;
        unPushedCommits: number;
        onToggleCollapsed: () => void;
        onCommitAndSync: () => void;
        onCommit: () => void;
        onRefresh: () => void;
        onToggleLayout: () => void;
    }

    let {
        plugin,
        repo,
        collapsed,
        loading,
        branchName,
        hasUpstream,
        unPushedCommits,
        onToggleCollapsed,
        onCommitAndSync,
        onCommit,
        onRefresh,
        onToggleLayout,
    }: Props = $props();

    let iconHosts: HTMLElement[] = $state([]);
    let syncIcon = $derived(hasUpstream ? "refresh-cw" : "upload");

    $effect(() => {
        for (const el of iconHosts) {
            if (el) setIcon(el, el.getAttr("data-icon")!);
        }
    });

    function openMenu(event: MouseEvent) {
        event.stopPropagation();
        showRepoMenu(event, { plugin, repo, onToggleLayout });
    }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
    class="git-repo-header tree-item-self is-clickable nav-folder-title"
    class:is-collapsed={collapsed}
    role="button"
    tabindex="0"
    aria-expanded={!collapsed}
    aria-label={`Toggle ${repo.displayName}`}
    onclick={onToggleCollapsed}
>
    <div
        class="tree-item-icon nav-folder-collapse-indicator collapse-icon"
        class:is-collapsed={collapsed}
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
    <div class="git-repo-name">{repo.displayName}</div>
    {#if branchName}
        <div class="git-repo-branch">{branchName}</div>
    {/if}
    {#if unPushedCommits > 0}
        <div class="git-repo-ahead" aria-label="Unpushed commits">
            ↑{unPushedCommits}
        </div>
    {/if}
    <div class="git-repo-actions">
        <div
            class="clickable-icon"
            class:loading
            aria-label="Commit and sync"
            data-icon={syncIcon}
            bind:this={iconHosts[0]}
            onclick={(e) => {
                e.stopPropagation();
                onCommitAndSync();
            }}
        ></div>
        <div
            class="clickable-icon"
            aria-label="Commit"
            data-icon="check"
            bind:this={iconHosts[1]}
            onclick={(e) => {
                e.stopPropagation();
                onCommit();
            }}
        ></div>
        <div
            class="clickable-icon"
            aria-label="Refresh"
            data-icon="rotate-cw"
            bind:this={iconHosts[2]}
            onclick={(e) => {
                e.stopPropagation();
                onRefresh();
            }}
        ></div>
        <div
            class="clickable-icon"
            aria-label="More actions"
            data-icon="more-horizontal"
            bind:this={iconHosts[3]}
            onclick={openMenu}
        ></div>
    </div>
</div>

<style lang="scss">
    .git-repo-header {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 4px 8px;
    }
    .git-repo-name {
        font-weight: var(--font-medium);
    }
    .git-repo-branch {
        color: var(--text-muted);
        font-size: var(--font-ui-smaller);
    }
    .git-repo-ahead {
        color: var(--text-muted);
        font-size: var(--font-ui-smaller);
    }
    .git-repo-actions {
        margin-left: auto;
        display: flex;
        align-items: center;
        gap: 2px;
    }
    .clickable-icon.loading {
        opacity: 0.5;
    }
</style>
