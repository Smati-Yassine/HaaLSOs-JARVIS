// The desktop app: one window for Jarvis, connected to the brain and the voice engine.
import { join } from "node:path";

import { app, BrowserWindow, ipcMain, Menu, nativeTheme, session } from "electron";

import { Jarvis, unloadModel, type Reply } from "./brain.ts";
import { Voice, type VoiceEvent } from "./voice.ts";

// Draw natively on Wayland instead of through XWayland.
app.commandLine.appendSwitch("ozone-platform-hint", "auto");
// Hides Chromium's harmless warnings about GNOME fonts and video hardware.
app.commandLine.appendSwitch("log-level", "3");

const jarvis = new Jarvis({ dryRun: process.env.JARVIS_DRY_RUN === "1" });
let window: BrowserWindow | null = null;
let voice: Voice | null = null;

function toWindow(event: Record<string, unknown>) {
  window?.webContents.send("jarvis:event", event);
}

function speakReply(reply: Reply) {
  voice?.say(reply.say, Boolean(reply.pending));
}

async function onVoiceEvent(event: VoiceEvent) {
  if (event.type === "follow_up") return voice?.listen();
  if (event.type !== "heard") return toWindow(event);
  const said = event.text.trim();
  if (!said) return toWindow({ type: "heard", text: "" });
  toWindow({ type: "heard", text: said });
  if (/^(hey )?(jarvis,? )?stop[.!]?$/i.test(said)) {
    voice?.stop();
    return toWindow({ type: "stopped" });
  }
  const reply = await jarvis.handle(said);
  toWindow({ type: "reply", reply });
  speakReply(reply);
}

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

ipcMain.handle("jarvis:ask", async (_event, said: unknown) => {
  voice?.stop();
  const reply = await jarvis.handle(String(said).slice(0, 2000));
  speakReply(reply);
  return reply;
});
ipcMain.handle("jarvis:warm-up", () => jarvis.warmUp().then(() => true, () => false));
ipcMain.handle("jarvis:welcome", (_event, text: unknown) => voice?.say(String(text)));
ipcMain.handle("voice:mute", (_event, muted: unknown) => voice?.setMuted(Boolean(muted)));
ipcMain.handle("voice:available", () => voice !== null);
ipcMain.handle("theme:set", (_event, mode: unknown) => {
  nativeTheme.themeSource = mode === "light" ? "light" : "dark";
});

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  // No permissions for the page: the microphone belongs to the voice engine, never the browser.
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  if (process.env.JARVIS_NO_VOICE !== "1") {
    const args = process.env.JARVIS_VOICE_ARGS ? (JSON.parse(process.env.JARVIS_VOICE_ARGS) as string[]) : [];
    const engine = new Voice(join(app.getAppPath(), "..", "voice"), onVoiceEvent, args);
    if (engine.start()) voice = engine;
  }
  createWindow();
});

// Stop the microphone and free the graphics card when Jarvis closes.
let unloading = false;
app.on("before-quit", (event) => {
  voice?.quit();
  if (unloading) return;
  unloading = true;
  event.preventDefault();
  Promise.race([unloadModel(), new Promise((done) => setTimeout(done, 1500))]).finally(() => app.quit());
});
app.on("window-all-closed", () => app.quit());
// Ctrl+C in the terminal should clean up too.
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => app.quit());
