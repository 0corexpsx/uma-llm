---
name: electron-app
description: Build or fix an Electron desktop app: main process, preload, renderer, IPC, and packaging into an exe.
---

# Electron app

1. Call read_file on package.json: "main" names the main process file, "scripts" the start and build commands.
2. Know which side code runs on:
   - main process: windows, files, the OS (BrowserWindow, ipcMain, fs)
   - preload: the only bridge, with contextBridge.exposeInMainWorld
   - renderer: the page; it has no Node and no fs when contextIsolation is on
3. Renderer needs something from the system: add an ipcMain.handle('name', ...) in main, expose a function in preload that calls ipcRenderer.invoke('name', ...), and call that from the page. Never turn off contextIsolation to make it work.
4. A blank window usually means the page failed to load: check the path given to loadFile or loadURL with list_files, and look for errors in the main process output.
5. Run with the start script through run_command and a timeout_seconds of about 30; the app keeps running, so read what it printed rather than waiting for it to end.
6. Packaging: use the build script in package.json (electron-builder or electron-forge). Read its error, fix the config, run it again, and give the user the path of the exe it made.

Report only what the commands printed. You cannot see the window: ask the user to check it.
