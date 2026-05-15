import { normalizePath } from "obsidian";

/**
 * Normalize a vault-relative path for storage in {@link RepoConfig.path}.
 * Vault root is represented as the empty string.
 */
export function normalizeRepoPath(path: string): string {
    const trimmed = (path ?? "").trim();
    if (trimmed === "" || trimmed === "/" || trimmed === ".") {
        return "";
    }
    return normalizePath(trimmed);
}

/**
 * True if `vaultPath` lies inside the working tree of a repo whose
 * registered path is `repoPath`. The root repo (`repoPath === ""`)
 * matches every vault path as a last resort.
 *
 * Uses proper-prefix matching: `repoPath="foo"` does NOT match `"foobar/x.md"`.
 */
export function vaultPathInRepo(vaultPath: string, repoPath: string): boolean {
    if (repoPath === "") return true;
    if (vaultPath === repoPath) return true;
    return vaultPath.startsWith(repoPath + "/");
}

/**
 * True if two registered repo paths would overlap (one is inside the other,
 * or they're identical). Used to validate adds. The empty string ("" = root)
 * overlaps every other path.
 */
export function repoPathsOverlap(a: string, b: string): boolean {
    if (a === b) return true;
    if (a === "" || b === "") return true;
    return vaultPathInRepo(a, b) || vaultPathInRepo(b, a);
}

/** Generate a stable UUID v4 (no external dep). */
export function newRepoId(): string {
    // RFC4122 v4
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        const v = c === "x" ? r : (r & 0x3) | 0x8;
        return v.toString(16);
    });
}

/**
 * Derive a default display name for a repo registered at `path`.
 * Returns "Vault" for the root, otherwise the last segment.
 */
export function defaultDisplayName(path: string): string {
    if (path === "") return "Vault";
    const idx = path.lastIndexOf("/");
    return idx === -1 ? path : path.substring(idx + 1);
}
