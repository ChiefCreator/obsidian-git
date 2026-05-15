import { Modal, Setting } from "obsidian";
import type ObsidianGit from "../../main";

export class ScanReposModal extends Modal {
    constructor(private readonly plugin: ObsidianGit) {
        super(plugin.app);
    }

    async onOpen(): Promise<void> {
        this.contentEl.empty();
        this.contentEl.createEl("h2", { text: "Scan vault for git repos" });
        const status = this.contentEl.createEl("p", { text: "Scanning..." });
        const found = await this.plugin.scanVaultForGitRepos();
        status.setText(`Found ${found.length} unregistered repo(s).`);
        if (found.length === 0) return;

        const selected = new Set<string>(found);
        for (const path of found) {
            new Setting(this.contentEl)
                .setName(path || "<vault root>")
                .addToggle((t) =>
                    t.setValue(true).onChange((v) => {
                        if (v) selected.add(path);
                        else selected.delete(path);
                    })
                );
        }
        new Setting(this.contentEl).addButton((b) =>
            b
                .setButtonText("Add selected")
                .setCta()
                .onClick(async () => {
                    for (const p of selected) {
                        await this.plugin.addRepoFromDetectedPath(p);
                    }
                    this.plugin.settingsTab?.display();
                    this.close();
                })
        );
    }
}
