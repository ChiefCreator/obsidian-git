# Pekarski Git — Manual Installation

This plugin is installed manually (not through the Obsidian Community Plugins list). Follow the steps below to copy it into your vault.

## What you get

The `pekarski-obsidian-git/` folder in the repository root contains everything Obsidian needs to load the plugin:

- `main.js` — compiled plugin code
- `styles.css` — plugin styles
- `manifest.json` — plugin metadata (id, version, author, etc.)
- `data.json` — default plugin settings

## Installation steps

1. **Locate the plugin folder.** In this repository, find the folder `pekarski-obsidian-git/` at the project root.

2. **Open your vault folder.** This is the folder you opened in Obsidian (the one containing your notes).

3. **Open the hidden `.obsidian` folder inside the vault.**
   - On Windows: enable "Show hidden items" in File Explorer, then open `<your-vault>\.obsidian\`.
   - On macOS: press `Cmd + Shift + .` in Finder to show hidden folders, then open `<your-vault>/.obsidian/`.
   - On Linux: hidden folders start with a dot — use your file manager's "Show hidden files" option.

4. **Open (or create) the `plugins/` subfolder.** The full path should be:
   ```
   <your-vault>/.obsidian/plugins/
   ```
   If `plugins/` does not exist, create it.

5. **Copy the `pekarski-obsidian-git/` folder** from this repository into that `plugins/` folder. The final layout must be:
   ```
   <your-vault>/.obsidian/plugins/pekarski-obsidian-git/
       ├── main.js
       ├── manifest.json
       ├── styles.css
       └── data.json
   ```

6. **Enable the plugin in Obsidian:**
   1. Open Obsidian and load the vault.
   2. Go to `Settings` → `Community plugins`.
   3. If you see "Turn on community plugins", click it (you may need to disable Restricted/Safe mode first).
   4. Under "Installed plugins", find **Pekarski Git** and toggle it on.

7. **Restart Obsidian** if the plugin does not appear or its commands are missing.
