import type { Debouncer } from "obsidian";
import { debounce } from "obsidian";
import type { GitRepo } from "./gitRepo";
import type ObsidianGit from "./main";

export default class AutomaticsManager {
    private timeoutIDCommitAndSync?: number;
    private timeoutIDPush?: number;
    private timeoutIDPull?: number;
    readonly plugin: ObsidianGit;
    readonly repo: GitRepo;
    /** Per-repo debouncer for the auto commit after file changes. */
    autoCommitDebouncer: Debouncer<[], void> | undefined;

    constructor(repo: GitRepo) {
        this.repo = repo;
        this.plugin = repo.plugin;
    }

    private saveLastAuto(date: Date, mode: "backup" | "pull" | "push") {
        if (mode === "backup") {
            this.plugin.localStorage.setLastAutoBackup(date.toString());
        } else if (mode === "pull") {
            this.plugin.localStorage.setLastAutoPull(date.toString());
        } else if (mode === "push") {
            this.plugin.localStorage.setLastAutoPush(date.toString());
        }
    }

    private loadLastAuto(): { backup: Date; pull: Date; push: Date } {
        return {
            backup: new Date(
                this.plugin.localStorage.getLastAutoBackup() ?? ""
            ),
            pull: new Date(this.plugin.localStorage.getLastAutoPull() ?? ""),
            push: new Date(this.plugin.localStorage.getLastAutoPush() ?? ""),
        };
    }

    async init() {
        await this.setUpAutoCommitAndSync();
        const lastAutos = this.loadLastAuto();

        if (
            this.repo.settings.differentIntervalCommitAndPush &&
            this.repo.settings.autoPushInterval > 0
        ) {
            const diff = this.diff(
                this.repo.settings.autoPushInterval,
                lastAutos.push
            );
            this.startAutoPush(diff);
        }
        if (this.repo.settings.autoPullInterval > 0) {
            const diff = this.diff(
                this.repo.settings.autoPullInterval,
                lastAutos.pull
            );
            this.startAutoPull(diff);
        }
    }

    unload() {
        this.clearAutoPull();
        this.clearAutoPush();
        this.clearAutoCommitAndSync();
    }

    /**
     * Clears all timers and sets all timers to their current settings.
     *
     * This does not calculate any differences to last autos or commits.
     * Should only be used when settings are changed.
     */
    reload(...type: ("commit" | "push" | "pull")[]) {
        if (this.plugin.localStorage.getPausedAutomatics()) return;
        if (this.plugin.localStorage.isAutomaticsPausedForRepo(this.repo.id))
            return;

        if (type.contains("commit")) {
            this.clearAutoCommitAndSync();
            if (this.repo.settings.autoSaveInterval > 0) {
                this.startAutoCommitAndSync(
                    this.repo.settings.autoSaveInterval
                );
            }
        }
        if (type.contains("push")) {
            this.clearAutoPush();
            if (
                this.repo.settings.differentIntervalCommitAndPush &&
                this.repo.settings.autoPushInterval > 0
            ) {
                this.startAutoPush(this.repo.settings.autoPushInterval);
            }
        }
        if (type.contains("pull")) {
            this.clearAutoPull();
            if (this.repo.settings.autoPullInterval > 0) {
                this.startAutoPull(this.repo.settings.autoPullInterval);
            }
        }
    }

    /**
     * Starts the auto commit-and-sync with the correct remaining time.
     *
     * Additionally, if `setLastSaveToLastCommit` is enabled, the last auto commit-and-sync
     * is set to the last commit time.
     */
    private async setUpAutoCommitAndSync() {
        if (this.repo.settings.setLastSaveToLastCommit) {
            this.clearAutoCommitAndSync();
            const lastCommitDate =
                await this.repo.gitManager.getLastCommitTime();
            if (lastCommitDate) {
                this.saveLastAuto(lastCommitDate, "backup");
            }
        }

        if (!this.timeoutIDCommitAndSync && !this.autoCommitDebouncer) {
            const lastAutos = this.loadLastAuto();

            if (this.repo.settings.autoSaveInterval > 0) {
                const diff = this.diff(
                    this.repo.settings.autoSaveInterval,
                    lastAutos.backup
                );
                this.startAutoCommitAndSync(diff);
            }
        }
    }

    private startAutoCommitAndSync(minutes?: number) {
        let time = (minutes ?? this.repo.settings.autoSaveInterval) * 60000;
        if (this.repo.settings.autoBackupAfterFileChange) {
            if (minutes === 0) {
                this.doAutoCommitAndSync();
            } else {
                this.autoCommitDebouncer = debounce(
                    () => this.doAutoCommitAndSync(),
                    time,
                    true
                );
            }
        } else {
            // max timeout in js
            if (time > 2147483647) time = 2147483647;
            this.timeoutIDCommitAndSync = window.setTimeout(
                () => this.doAutoCommitAndSync(),
                time
            );
        }
    }

    // This is used for both auto commit-and-sync and commit only
    private doAutoCommitAndSync(): void {
        this.repo.promiseQueue.addTask(
            async () => {
                // Re-check if the auto commit should run now or be postponed,
                // because the last commit time has changed
                if (this.repo.settings.setLastSaveToLastCommit) {
                    const lastCommitDate =
                        await this.repo.gitManager.getLastCommitTime();
                    if (lastCommitDate) {
                        this.saveLastAuto(lastCommitDate, "backup");
                        const diff = this.diff(
                            this.repo.settings.autoSaveInterval,
                            lastCommitDate
                        );
                        if (diff > 0) {
                            this.startAutoCommitAndSync(diff);
                            // Return false to mark the next iteration
                            // already being scheduled
                            return false;
                        }
                    }
                }
                const onlyStaged = this.repo.settings.autoCommitOnlyStaged;
                if (this.repo.settings.differentIntervalCommitAndPush) {
                    await this.plugin.commitRepo(this.repo, {
                        fromAuto: true,
                        onlyStaged,
                    });
                } else {
                    await this.plugin.commitAndSyncRepo(this.repo, {
                        fromAutoBackup: true,
                        onlyStaged,
                    });
                }
                return true;
            },
            (schedule) => {
                // Don't schedule if the next iteration is already scheduled
                if (schedule !== false) {
                    this.saveLastAuto(new Date(), "backup");
                    this.startAutoCommitAndSync();
                }
            }
        );
    }

    private startAutoPull(minutes?: number) {
        let time = (minutes ?? this.repo.settings.autoPullInterval) * 60000;
        // max timeout in js
        if (time > 2147483647) time = 2147483647;

        this.timeoutIDPull = window.setTimeout(() => this.doAutoPull(), time);
    }

    private doAutoPull(): void {
        this.repo.promiseQueue.addTask(
            () => this.plugin.pullRepoFromRemote(this.repo),
            () => {
                this.saveLastAuto(new Date(), "pull");
                this.startAutoPull();
            }
        );
    }

    private startAutoPush(minutes?: number) {
        let time = (minutes ?? this.repo.settings.autoPushInterval) * 60000;
        // max timeout in js
        if (time > 2147483647) time = 2147483647;

        this.timeoutIDPush = window.setTimeout(() => this.doAutoPush(), time);
    }

    private doAutoPush(): void {
        this.repo.promiseQueue.addTask(
            () => this.plugin.pushRepo(this.repo),
            () => {
                this.saveLastAuto(new Date(), "push");
                this.startAutoPush();
            }
        );
    }

    private clearAutoCommitAndSync(): boolean {
        let wasActive = false;
        if (this.timeoutIDCommitAndSync) {
            window.clearTimeout(this.timeoutIDCommitAndSync);
            this.timeoutIDCommitAndSync = undefined;
            wasActive = true;
        }
        if (this.autoCommitDebouncer) {
            this.autoCommitDebouncer?.cancel();
            this.autoCommitDebouncer = undefined;
            wasActive = true;
        }
        return wasActive;
    }

    private clearAutoPull(): boolean {
        if (this.timeoutIDPull) {
            window.clearTimeout(this.timeoutIDPull);
            this.timeoutIDPull = undefined;
            return true;
        }
        return false;
    }

    private clearAutoPush(): boolean {
        if (this.timeoutIDPush) {
            window.clearTimeout(this.timeoutIDPush);
            this.timeoutIDPush = undefined;
            return true;
        }
        return false;
    }

    /**
     * Calculates the minutes until the next auto action. >= 0
     *
     * This is done by the difference between the setting and the time since the last auto action, but at least 0.
     */
    private diff(setting: number, lastAuto: Date) {
        const now = new Date();
        const diff =
            setting -
            Math.round((now.getTime() - lastAuto.getTime()) / 1000 / 60);
        return Math.max(0, diff);
    }
}
