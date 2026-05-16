import { Menu, Notice } from "obsidian";
import { HISTORY_VIEW_CONFIG } from "src/constants";
import type { GitRepo } from "src/gitRepo";
import type ObsidianGit from "src/main";
import { BranchModal } from "src/ui/modals/branchModal";

interface RepoMenuOptions {
    plugin: ObsidianGit;
    repo: GitRepo;
    /** Called when the tree/list layout toggle is selected. */
    onToggleLayout: () => void;
}

export function showRepoMenu(
    event: MouseEvent,
    { plugin, repo, onToggleLayout }: RepoMenuOptions
): void {
    const menu = new Menu();
    const runAndRefresh = (run: () => Promise<unknown>) =>
        repo.promiseQueue.addTask(() =>
            run().finally(() =>
                plugin.app.workspace.trigger(
                    "obsidian-git:refresh",
                    repo.id
                )
            )
        );

    menu.addItem((item) =>
        item
            .setTitle("Stage all")
            .setIcon("plus-circle")
            .onClick(() =>
                runAndRefresh(() =>
                    repo.gitManager.stageAll({ status: repo.cachedStatus })
                )
            )
    );
    menu.addItem((item) =>
        item
            .setTitle("Unstage all")
            .setIcon("minus-circle")
            .onClick(() =>
                runAndRefresh(() =>
                    repo.gitManager.unstageAll({ status: repo.cachedStatus })
                )
            )
    );
    menu.addItem((item) =>
        item
            .setTitle("Discard all")
            .setIcon("undo")
            .onClick(() => {
                void plugin.discardAll(undefined, repo);
            })
    );
    menu.addSeparator();
    menu.addItem((item) =>
        item
            .setTitle("Pull")
            .setIcon("download")
            .onClick(() => runAndRefresh(() => plugin.pullRepoFromRemote(repo)))
    );
    menu.addItem((item) =>
        item
            .setTitle("Push")
            .setIcon("upload")
            .onClick(() => runAndRefresh(() => plugin.pushRepo(repo)))
    );
    menu.addItem((item) =>
        item
            .setTitle("Fetch")
            .setIcon("refresh-cw")
            .onClick(() => runAndRefresh(() => plugin.fetchRepo(repo)))
    );
    menu.addSeparator();
    menu.addItem((item) =>
        item
            .setTitle("Switch branch")
            .setIcon("git-branch")
            .onClick(() => {
                void (async () => {
                    try {
                        const info = await repo.gitManager.branchInfo();
                        const selected = await new BranchModal(
                            plugin,
                            info.branches
                        ).openAndGetReslt();
                        if (selected != null) {
                            await repo.gitManager.checkout(selected);
                            new Notice(
                                `[${repo.displayName}] Switched to ${selected}`
                            );
                            plugin.app.workspace.trigger(
                                "obsidian-git:refresh",
                                repo.id
                            );
                        }
                    } catch (e) {
                        plugin.displayError(e);
                    }
                })();
            })
    );
    menu.addItem((item) =>
        item
            .setTitle("Show history")
            .setIcon("history")
            .onClick(() => {
                const previous =
                    plugin.localStorage.getActiveRepoOverride();
                plugin.localStorage.setActiveRepoOverride(repo.id);
                const leaves = plugin.app.workspace.getLeavesOfType(
                    HISTORY_VIEW_CONFIG.type
                );
                const leaf =
                    leaves[0] ??
                    plugin.app.workspace.getRightLeaf(false) ??
                    plugin.app.workspace.getLeaf();
                void (async () => {
                    try {
                        if (leaves.length === 0) {
                            await leaf.setViewState({
                                type: HISTORY_VIEW_CONFIG.type,
                            });
                        }
                        await plugin.app.workspace.revealLeaf(leaf);
                        plugin.app.workspace.trigger(
                            "obsidian-git:refresh",
                            repo.id
                        );
                    } finally {
                        plugin.localStorage.setActiveRepoOverride(previous);
                    }
                })();
            })
    );
    menu.addItem((item) =>
        item
            .setTitle("Open settings for this repo")
            .setIcon("settings")
            .onClick(() => {
                plugin.app.setting.open();
                plugin.app.setting.openTabById(plugin.manifest.id);
            })
    );
    menu.addSeparator();
    menu.addItem((item) =>
        item
            .setTitle("Toggle tree/list layout")
            .setIcon(plugin.settings.treeStructure ? "list" : "folder")
            .onClick(onToggleLayout)
    );

    menu.showAtMouseEvent(event);
}
