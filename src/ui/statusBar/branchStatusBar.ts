import type ObsidianGit from "src/main";

export class BranchStatusBar {
    constructor(
        private statusBarEl: HTMLElement,
        private readonly plugin: ObsidianGit
    ) {
        this.statusBarEl.addClass("mod-clickable");
        this.statusBarEl.onClickEvent((_) => {
            this.plugin.switchBranch().catch((e) => plugin.displayError(e));
        });
    }

    async display() {
        const repo = this.plugin.activeRepo();
        if (!this.plugin.gitReady || !repo || !repo.ready) {
            this.statusBarEl.empty();
            return;
        }
        const branchInfo = await repo.gitManager
            .branchInfo()
            .catch(() => undefined);
        if (branchInfo?.current != undefined) {
            const suffix =
                this.plugin.repos.size > 1 ? ` [${repo.displayName}]` : "";
            this.statusBarEl.setText(branchInfo.current + suffix);
        } else {
            this.statusBarEl.empty();
        }
    }

    remove() {
        this.statusBarEl.remove();
    }
}
