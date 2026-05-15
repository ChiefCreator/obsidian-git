import { html } from "diff2html";
import type { EventRef, ViewStateResult, WorkspaceLeaf } from "obsidian";
import { ItemView, Platform } from "obsidian";
import { DIFF_VIEW_CONFIG } from "src/constants";
import { SimpleGit } from "src/gitManager/simpleGit";
import type ObsidianGit from "src/main";
import type { DiffViewState } from "src/types";

export default class DiffView extends ItemView {
    parser: DOMParser;
    gettingDiff = false;
    state: DiffViewState;
    gitRefreshRef: EventRef;
    gitViewRefreshRef: EventRef;

    constructor(
        leaf: WorkspaceLeaf,
        private plugin: ObsidianGit
    ) {
        super(leaf);
        this.parser = new DOMParser();
        this.navigation = true;
        this.contentEl.addClass("git-diff");
        this.gitRefreshRef = this.app.workspace.on(
            "obsidian-git:status-changed",
            () => {
                this.refresh().catch(console.error);
            }
        );
    }

    getViewType(): string {
        return DIFF_VIEW_CONFIG.type;
    }

    getDisplayText(): string {
        if (this.state?.bFile != null) {
            let fileName = this.state.bFile.split("/").last();
            if (fileName?.endsWith(".md")) fileName = fileName.slice(0, -3);

            return `Diff: ${fileName}`;
        }
        return DIFF_VIEW_CONFIG.name;
    }

    getIcon(): string {
        return DIFF_VIEW_CONFIG.icon;
    }

    async setState(state: DiffViewState, _: ViewStateResult): Promise<void> {
        this.state = state;

        if (Platform.isMobile) {
            //Update view title on mobile only to show the file name of the diff
            this.leaf.view.titleEl.textContent = this.getDisplayText();
        }

        await this.refresh();
    }

    getState(): Record<string, unknown> {
        return this.state;
    }

    onClose(): Promise<void> {
        this.app.workspace.offref(this.gitRefreshRef);
        this.app.workspace.offref(this.gitViewRefreshRef);
        return super.onClose();
    }

    async onOpen(): Promise<void> {
        await this.refresh();
        return super.onOpen();
    }

    /** Resolve the GitRepo this diff was opened against. Falls back to active repo
     *  if the persisted state predates multi-repo. */
    private resolveRepo() {
        if (this.state?.repoId) {
            return this.plugin.repos.get(this.state.repoId);
        }
        return this.plugin.activeRepo();
    }

    private renderRemovedRepoPlaceholder(missingId: string): void {
        this.contentEl.empty();
        const div = this.contentEl.createDiv({ cls: "obsidian-git-center" });
        div.createSpan({
            text: `This diff was opened for repository id "${missingId}", which is no longer registered with the plugin. The repo may have been removed.`,
        });
        div.createEl("br");
        const btn = div.createEl("button", { text: "Close" });
        btn.addEventListener("click", () => this.leaf.detach());
    }

    async refresh(): Promise<void> {
        if (!this.state?.bFile || this.gettingDiff) return;

        const repo = this.resolveRepo();
        if (this.state.repoId && !repo) {
            this.renderRemovedRepoPlaceholder(this.state.repoId);
            return;
        }
        if (!repo) return;

        this.gettingDiff = true;
        try {
            let diff = await repo.gitManager.getDiffString(
                this.state.bFile,
                this.state.aRef == "HEAD",
                this.state.bRef
            );
            this.contentEl.empty();

            const vaultPath = repo.gitManager.getRelativeVaultPath(
                this.state.bFile
            );
            if (!diff) {
                if (
                    repo.gitManager instanceof SimpleGit &&
                    (await repo.gitManager.isTracked(this.state.bFile))
                ) {
                    diff = [
                        `--- ${this.state.aFile}`,
                        `+++ ${this.state.bFile}`,
                        "",
                    ].join("\n");
                } else if (await this.app.vault.adapter.exists(vaultPath)) {
                    const content =
                        await this.app.vault.adapter.read(vaultPath);
                    const header = `--- /dev/null
+++ ${this.state.bFile}
@@ -0,0 +1,${content.split("\n").length} @@`;

                    diff = [
                        ...header.split("\n"),
                        ...content.split("\n").map((line) => `+${line}`),
                    ].join("\n");
                }
            }

            if (diff) {
                const diffEl = this.parser
                    .parseFromString(html(diff), "text/html")
                    .querySelector(".d2h-file-diff");
                this.contentEl.append(diffEl!);
            } else {
                const div = this.contentEl.createDiv({
                    cls: "obsidian-git-center",
                });
                div.createSpan({
                    text: "⚠️",
                    attr: { style: "font-size: 2em" },
                });
                div.createEl("br");
                div.createSpan({
                    text: "File not found: " + this.state.bFile,
                });
            }
        } finally {
            this.gettingDiff = false;
        }
    }
}
