import { FuzzySuggestModal } from "obsidian";
import type { GitRepo } from "../../gitRepo";
import type ObsidianGit from "../../main";

export class RepoSelectorModal extends FuzzySuggestModal<GitRepo> {
    constructor(private readonly plugin: ObsidianGit) {
        super(plugin.app);
        this.setPlaceholder("Pick the active repository");
    }
    getItems(): GitRepo[] {
        return this.plugin.repoOrder
            .map((id) => this.plugin.repos.get(id))
            .filter((r): r is GitRepo => !!r);
    }
    getItemText(repo: GitRepo): string {
        return `${repo.displayName}  (${repo.config.path || "<root>"})`;
    }
    onChooseItem(repo: GitRepo): void {
        this.plugin.localStorage.setActiveRepoOverride(repo.id);
        this.plugin.mirrorLegacySettingsFields();
        this.plugin.statusBar?.display();
        void this.plugin.branchBar?.display();
        this.plugin.app.workspace.trigger("obsidian-git:refresh");
    }
}
