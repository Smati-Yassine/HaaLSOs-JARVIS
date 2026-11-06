// The desktop app: one window holding Jarvis and, while coding, Claude, plus the voice engine.
import { homedir } from "node:os";
import { join } from "node:path";

import { app, BrowserWindow, ipcMain, Menu, nativeTheme, session } from "electron";

import { Jarvis, pruneLog, summarize, unloadModel, type Pending, type Reply } from "./brain.ts";
import { ClaudeManager } from "./claude.ts";
import { pickOption } from "./fastpath.ts";
import { Memory } from "./memory.ts";
import { classifyForClaude, isApproval, isPlainYes } from "./safety.ts";
import { healthCheck, setStartAtLogin, startsAtLogin } from "./system.ts";
import { Voice, type VoiceEvent } from "./voice.ts";
import { startSearch, stopSearch } from "./web.ts";

// Matches the app menu entry, so the dock groups this window under Jarvis's icon.
app.setName("jarvis");
// Draw natively on Wayland instead of through XWayland.
app.commandLine.appendSwitch("ozone-platform-hint", "auto");
// Hides Chromium's harmless warnings about GNOME fonts and video hardware.
app.commandLine.appendSwitch("log-level", "3");

// Only one Jarvis at a time: two would fight over the microphone.
if (!app.requestSingleInstanceLock()) app.exit(0);
app.on("second-instance", () => {
  if (window?.isMinimized()) window.restore();
  window?.show();
  window?.focus();
});

const memory = new Memory(process.env.JARVIS_MEMORY || join(homedir(), ".Jarvis", "memory.sqlite"));
const jarvis = new Jarvis({
  dryRun: process.env.JARVIS_DRY_RUN === "1",
  ack: (words) => voice?.say(words), // Searching takes seconds, so Jarvis says so first.
}, memory);
let window: BrowserWindow | null = null;
let voice: Voice | null = null;

// Claude can't continue until the user answers, so questions wait in line here.
type Asking = Pending & { session: string; trust?: boolean; question?: boolean };
const permissions: Asking[] = [];

function toWindow(event: Record<string, unknown>) {
  window?.webContents.send("jarvis:event", event);
}

const claude = new ClaudeManager({
  changed(snapshot) {
    window?.webContents.send("claude:changed", snapshot);
  },
  data(id, data) {
    window?.webContents.send("claude:data", id, data);
  },
  permission(permission) {
    const level = permission.shell ? classifyForClaude(permission.command) : "say-back";
    enqueue({ session: permission.session, command: permission.command, level: level === "run" ? "say-back" : level });
  },
  question(session, question) {
    // Several questions or multi-select need the menu itself, which is on Claude's screen.
    if (!question.simple || !question.options.length) {
      toWindow({ type: "show-claude" });
      announce("Claude has some questions for you, sir. They're in its panel.");
      return;
    }
    toWindow({ type: "show-claude" });
    enqueue({ session, command: question.question, level: "say-back", options: question.options, question: true });
  },
  settled(session) {
    const before = permissions.length;
    const wasAsking = permissions[0]?.session === session;
    for (let at = permissions.length - 1; at >= 0; at--) {
      if (permissions[at].session === session && !permissions[at].trust) permissions.splice(at, 1);
    }
    if (permissions.length !== before && wasAsking) {
      toWindow({ type: "settled" });
      askPermission();
    }
  },
  async finished(_id, message) {
    const summary = await summarize(message);
    announce(summary ? `Claude has finished, sir. ${summary}` : "Claude has finished, sir.");
  },
  trustNeeded(project) {
    permissions.unshift({ session: "", command: project, level: "say-back", trust: true });
    askPermission();
  },
});

function announce(say: string, pending?: Pending, spoken = say) {
  const reply: Reply = { say, source: "tool", tool: "claude", pending, ms: 0 };
  toWindow({ type: "reply", reply });
  voice?.say(spoken, Boolean(pending));
}

function enqueue(item: Asking) {
  permissions.push(item);
  if (permissions.length === 1) askPermission();
}

function askPermission() {
  const next = permissions[0];
  if (!next) return;
  if (next.trust) {
    const ask = next.command === "Computer"
      ? "Claude needs your OK to work across your home folder, sir. Do you allow it?"
      : `This is Claude's first time in ${next.command}, sir. Do you trust this folder?`;
    announce(ask, { command: next.command, level: "say-back" });
    return;
  }
  if (next.question) {
    const list = next.options!.map((option, index) => `${index + 1}, ${option}`).join(". ");
    announce(`Claude asks: ${next.command}`, { command: next.command, level: "say-back", options: next.options }, `Claude asks: ${next.command} Your options are ${list}.`);
    return;
  }
  const ask = next.level === "confirm"
    ? `Claude wants to do something dangerous, sir: ${next.command}. Say confirm to allow it.`
    : `Claude wants to run: ${next.command}. Allow it, sir?`;
  // A long command is unbearable read aloud. The chat shows it in full either way.
  const short = next.command.length <= 70;
  const spoken = short ? ask : next.level === "confirm"
    ? "Claude wants to do something dangerous, sir. It's in the chat. Say confirm to allow it."
    : "Claude wants to run a long command, sir. It's in the chat. Allow it?";
  announce(ask, { command: next.command, level: next.level }, spoken);
}

// While Claude is waiting on a permission, the next thing said answers it.
function answerPermission(said: string): Reply | null {
  const next = permissions[0];
  if (!next) return null;
  if (next.question) {
    if (/^(cancel|never ?mind|stop)[.!]?$/i.test(said.trim())) {
      permissions.shift();
      claude.answerPermission(next.session, false);
      setTimeout(askPermission, 300);
      return { say: "Cancelled, sir.", source: "fast", tool: "claude", ms: 0 };
    }
    const pick = pickOption(said, next.options!);
    if (pick === null) return { say: "Which one, sir? You can say the number.", source: "fast", tool: "claude", pending: { command: next.command, level: next.level, options: next.options }, ms: 0 };
    permissions.shift();
    claude.answerChoice(next.session, pick);
    setTimeout(askPermission, 300);
    return { say: `${next.options![pick]}, sir.`, source: "fast", tool: "claude", ms: 0 };
  }
  if (next.level === "confirm" && isPlainYes(said)) {
    return { say: "This one is dangerous, sir, so I need you to say confirm, or cancel.", source: "fast", tool: "claude", pending: { command: next.command, level: next.level }, ms: 0 };
  }
  permissions.shift();
  const allowed = isApproval(said, next.level);
  if (next.trust) {
    claude.answerTrust(allowed, () => announce("Claude's question didn't respond, sir. Please choose Yes in its panel."));
    setTimeout(askPermission, 300);
    return { say: allowed ? "Thank you, sir. Claude is starting." : "Understood, sir. I've closed it.", source: "fast", tool: "claude", ms: 0 };
  }
  claude.answerPermission(next.session, allowed);
  const reply: Reply = { say: allowed ? "Allowed, sir." : "Denied, sir. Claude won't run it.", source: "fast", tool: "claude", ms: 0 };
  setTimeout(askPermission, 300);
  return reply;
}

jarvis.connectClaude({
  get openProject() {
    return claude.openProject;
  },
  start(project, path) {
    claude.open(project, path);
  },
  ask(task) {
    return claude.ask(task);
  },
  close() {
    closeClaude();
  },
  setEffort: (level) => claude.setActiveEffort(level),
  setModel: (name) => claude.setActiveModel(name),
  newSession: () => void claude.newSession(),
  newTerminal: () => void claude.newTerminal(),
  archive: () => claude.archiveActive(),
  setVisible: (visible) => toWindow({ type: visible ? "show-claude" : "hide-claude" }),
  interrupt: () => claude.interrupt(),
});

function closeClaude() {
  permissions.length = 0;
  claude.closeProject();
}

function speakReply(reply: Reply) {
  voice?.say(reply.spoken ?? reply.say, Boolean(reply.pending || reply.listen));
}

async function handleSaid(said: string): Promise<Reply> {
  return answerPermission(said) ?? (await jarvis.handle(said));
}

// The voice engine comes back by itself if it crashes, but won't loop forever if it's broken.
let voiceCrashes = 0;
let quitting = false;
function restartVoice() {
  if (quitting || voiceCrashes >= 3) return;
  voiceCrashes += 1;
  setTimeout(() => {
    if (quitting) return;
    if (voice?.start()) toWindow({ type: "voice-restarting" });
  }, 2000);
}

async function onVoiceEvent(event: VoiceEvent) {
  if (event.type === "follow_up") return voice?.listen();
  if (event.type === "ready") setTimeout(() => (voiceCrashes = 0), 60_000).unref();
  if (event.type === "gone") restartVoice();
  if (event.type !== "heard") return toWindow(event);
  const said = event.text.trim();
  if (!said) return toWindow({ type: "heard", text: "" });
  toWindow({ type: "heard", text: said });
  if (/^(hey )?(jarvis,? )?stop[.!]?$/i.test(said) && !permissions.length) {
    voice?.stop();
    if (claude.interrupt()) return announce("Stopped Claude, sir.");
    return toWindow({ type: "stopped" });
  }
  const reply = await handleSaid(said);
  toWindow({ type: "reply", reply });
  speakReply(reply);
}

function createWindow() {
  window = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 480,
    minHeight: 400,
    title: "Jarvis",
    frame: false, // The app draws its own title bar with minimize, maximize and close.
    backgroundColor: "#070707",
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
  window.on("closed", () => {
    window = null;
    app.quit();
  });
  // If the page itself ever crashes, bring it back rather than leaving a blank window.
  window.webContents.on("render-process-gone", (_event, details) => {
    if (details.reason !== "clean-exit") window?.webContents.reload();
  });

  if (process.env.ELECTRON_RENDERER_URL) window.loadURL(`${process.env.ELECTRON_RENDERER_URL}/jarvis-window/index.html`);
  else window.loadFile(join(__dirname, "../renderer/jarvis-window/index.html"));
}

ipcMain.handle("jarvis:ask", async (_event, said: unknown) => {
  voice?.stop();
  const reply = await handleSaid(String(said).slice(0, 2000));
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
ipcMain.handle("jarvis:health", () => healthCheck(join(app.getAppPath(), "..", "voice")));
ipcMain.handle("autostart:get", () => startsAtLogin());
ipcMain.handle("autostart:set", (_event, enabled: unknown) => setStartAtLogin(Boolean(enabled)));
ipcMain.on("window:minimize", () => window?.minimize());
ipcMain.on("window:toggle-maximize", () => (window?.isMaximized() ? window.unmaximize() : window?.maximize()));
ipcMain.on("window:close", () => window?.close());

// ---- Claude panel -----------------------------------------------------------
ipcMain.handle("claude:snapshot", () => claude.snapshot());
ipcMain.handle("claude:buffer", (_event, id: string) => claude.buffer(String(id)));
ipcMain.on("claude:write", (_event, id: string, data: string) => claude.write(String(id), String(data)));
ipcMain.on("claude:resize", (_event, id: string, cols: number, rows: number) => claude.resize(String(id), Number(cols), Number(rows)));
ipcMain.on("claude:select", (_event, id: string) => claude.select(String(id)));
ipcMain.on("claude:archive", (_event, id: string) => claude.archive(String(id)));
ipcMain.on("claude:restore", (_event, id: string) => claude.restore(String(id)));
ipcMain.on("claude:new-session", () => claude.newSession());
ipcMain.on("claude:new-terminal", () => claude.newTerminal());
ipcMain.on("claude:model", (_event, id: string, model: string) => claude.setModel(String(id), String(model)));
ipcMain.on("claude:effort", (_event, id: string, effort: string) => claude.setEffort(String(id), String(effort)));
ipcMain.on("claude:close-project", () => {
  const name = claude.openProject;
  closeClaude();
  if (name) announce(`${name} is closed, sir. All its sessions and terminals are shut down.`);
});

app.whenReady().then(() => {
  pruneLog();
  void startSearch();
  Menu.setApplicationMenu(null);
  // No permissions for the page: the microphone belongs to the voice engine, never the browser.
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  claude.start();
  if (process.env.JARVIS_NO_VOICE !== "1") {
    const args = process.env.JARVIS_VOICE_ARGS ? (JSON.parse(process.env.JARVIS_VOICE_ARGS) as string[]) : [];
    const engine = new Voice(join(app.getAppPath(), "..", "voice"), onVoiceEvent, args);
    if (engine.start()) voice = engine;
  }
  createWindow();
});

// Stop the microphone, end Claude's terminals, and free the graphics card when Jarvis closes.
let unloading = false;
app.on("before-quit", (event) => {
  quitting = true;
  stopSearch();
  voice?.quit();
  claude.stop();
  if (unloading) return;
  unloading = true;
  event.preventDefault();
  Promise.race([unloadModel(), new Promise((done) => setTimeout(done, 1500))]).finally(() => app.quit());
});
// Ctrl+C in the terminal should clean up too.
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => app.quit());
