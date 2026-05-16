<script lang="ts">
    import { SOURCE_CONTROL_VIEW_CONFIG } from "src/constants";
    import type ObsidianGit from "src/main";
    import RepoPanel from "./components/repoPanel.svelte";
    import type GitView from "./sourceControl";

    interface Props {
        plugin: ObsidianGit;
        view: GitView;
    }

    let { plugin, view }: Props = $props();

    function openSettings() {
        plugin.app.setting.open();
        plugin.app.setting.openTabById(plugin.manifest.id);
    }
</script>

<main data-type={SOURCE_CONTROL_VIEW_CONFIG.type} class="git-view">
    {#if plugin.repos.size === 0}
        <div class="git-empty-state">
            <p>No repositories configured.</p>
            <button class="mod-cta" onclick={openSettings}>
                Open settings
            </button>
        </div>
    {:else}
        {#each plugin.repoOrder as id (id)}
            {@const repo = plugin.repos.get(id)}
            {#if repo}
                <RepoPanel {plugin} {repo} {view} />
            {/if}
        {/each}
    {/if}
</main>

<style lang="scss">
    .git-empty-state {
        padding: 32px 16px;
        text-align: center;
        color: var(--text-muted);
        display: flex;
        flex-direction: column;
        gap: 12px;
        align-items: center;
    }
</style>
