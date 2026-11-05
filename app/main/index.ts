// The desktop app: one window for Jarvis, connected to the brain.
import { join } from "node:path";

import { app, BrowserWindow, ipcMain, Menu, nativeTheme, session } from "electron";

import { Jarvis, unloadModel } from "./brain.ts";

// Draw natively on Wayland instead of through XWayland.
app.commandLine.appendSwitch("ozone-platform-hint", "auto");

const jarvis = new Jarvis({ dryRun: process.env.JARVIS_DRY_RUN === "1" });
let window: BrowserWindow | null = null;

function createWindow() {
  window = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 720,
    minHeight: 480,
    title: "Jarvis",
    backgroundColor: "#070707",
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  window.once("ready-to-show", () => window?.show());
  // Jarvis's window only ever shows its own page.
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.on("closed", () => (window = null));

  if (process.env.ELECTRON_RENDERER_URL) window.loadURL(process.env.ELECTRON_RENDERER_URL);
  else window.loadFile(join(__dirname, "../renderer/index.html"));
}

ipcMain.handle("jarvis:ask", (_event, said: unknown) => jarvis.handle(String(said).slice(0, 2000)));
ipcMain.handle("jarvis:warm-up", () => jarvis.warmUp().then(() => true, () => false));
ipcMain.handle("theme:set", (_event, mode: unknown) => {
  nativeTheme.themeSource = mode === "light" ? "light" : "dark";
});

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  // No permissions for the page: voice comes from a separate process, never the browser.
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  createWindow();
});

// Free the graphics card when Jarvis closes.
let unloading = false;
app.on("before-quit", (event) => {
  if (unloading) return;
  unloading = true;
  event.preventDefault();
  Promise.race([unloadModel(), new Promise((done) => setTimeout(done, 1500))]).finally(() => app.quit());
});
app.on("window-all-closed", () => app.quit());
