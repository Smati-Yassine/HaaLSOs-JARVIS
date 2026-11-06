// The desktop app: one window holding Jarvis and, while coding, Claude, plus the voice engine.
import { homedir } from "node:os";
import { join } from "node:path";

import { app, BrowserWindow, ipcMain, Menu, nativeTheme, session } from "electron";

import { Jarvis, pruneLog, summarize, unloadModel, type Pending, type Reply } from "./brain.ts";
import { ClaudeManager, type Gate } from "./claude.ts";
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
// `menu` means the options were read off Claude's screen, so their numbers are its real numbers.
type Asking = Pending & { session: string; options: string[]; gate?: Gate; question?: boolean; menu?: boolean };
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
    enqueue({
      session: permission.session,
      command: permission.command,
      level: level === "run" ? "say-back" : level,
      options: permission.menu?.options ?? ["Yes", "No"],
      title: permission.menu?.question ?? undefined,
      menu: Boolean(permission.menu),
    });
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
      if (permissions[at].session === session && !permissions[at].gate) permissions.splice(at, 1);
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
  gate(project, gate) {
    const options = gate === "bypass" ? ["Yes, I accept", "No, keep asking me"] : ["Yes, trust this folder", "No, close it"];
    permissions.unshift({ session: "", command: project, level: "say-back", gate, options });
    askPermission();
  },
});

function announce(say: string, pending?: Pending, spoken = say) {
  const reply: Reply = { say, source: "tool", tool: "claude", pending, ms: 0 };
  toWindow({ type: "reply", reply });
  // Questions vanish once answered. Only lasting news belongs in the conversation.
  if (!pending) jarvis.note(say);
  voice?.say(spoken, Boolean(pending));
}

function enqueue(item: Asking) {
  permissions.push(item);
  if (permissions.length === 1) askPermission();
}

function askPermission() {
  const next = permissions[0];
  if (!next) return;
  if (next.gate === "bypass") {
    const title = "Claude shows this warning once: in bypass mode it won't ask before running anything, and you accept responsibility for what it does. Do you accept?";
    announce("Claude wants your word on its bypass warning, sir.", { command: "", level: "say-back", options: next.options, title }, "Claude wants your word on its bypass warning, sir. It's on the screen.");
    return;
  }
  if (next.gate) {
    const ask = next.command === "Computer"
      ? "Claude needs your OK to work across your home folder, sir. Do you allow it?"
      : `This is Claude's first time in ${next.command}, sir. Do you trust this folder?`;
    announce(ask, { command: "", level: "say-back", options: next.options, title: ask });
    return;
  }
  if (next.question) {
    const list = next.options.map((option, index) => `${index + 1}, ${option}`).join(". ");
    announce(`Claude asks: ${next.command}`, { command: "", level: "say-back", options: next.options, title: next.command }, `Claude asks: ${next.command} Your options are ${list}.`);
    return;
  }
  // A second request can be waiting behind the first, so read the menu showing now.
  const current = next.menu ? claude.menu(next.session) : null;
  if (current) {
    next.options = current.options;
    next.title = current.question ?? next.title;
  }
  const danger = next.level === "confirm";
  const pending: Pending = { command: next.command, level: next.level, options: next.options, title: next.title ?? "Allow this?" };
  const ask = danger ? "Careful, sir. Claude wants to do something dangerous." : `Claude asks: ${next.title ?? "may it do this?"}`;
  // Long commands and every option would be unbearable read aloud. The screen has them all.
  const tail = danger ? "Say confirm to allow it, or cancel." : "Say yes, no, or a number, sir.";
  const shown = danger && next.command.length <= 70 ? ` ${next.command}.` : "";
  announce(ask, pending, `${ask}${shown} ${tail}`);
}

// Moves on to the next question once this one is settled. A null choice means cancel.
function settleAsking(next: Asking, pick: number | null): Reply {
  permissions.shift();
  setTimeout(askPermission, 300);
  const answer = (say: string): Reply => ({ say, source: "fast", tool: "claude", ms: 0 });
  if (next.gate) {
    const allowed = pick === 0;
    claude.answerGate(allowed, () => announce("Claude's question didn't respond, sir. Please choose Yes in its panel."));
    if (next.gate === "bypass") return answer(allowed ? "Understood, sir. Claude will no longer ask." : "Very good, sir. Claude will keep asking.");
    return answer(allowed ? "Thank you, sir. Claude is starting." : "Understood, sir. I've closed it.");
  }
  if (pick === null) {
    claude.answerPermission(next.session, false);
    return answer("Cancelled, sir. Claude won't do it.");
  }
  if (next.question) {
    claude.answerChoice(next.session, pick);
    return answer(`${next.options[pick]}, sir.`);
  }
  if (next.menu) {
    const pressed = claude.answerMenu(next.session, pick, next.options[pick]);
    return answer(pressed ? `${next.options[pick]}, sir.` : "That question has already moved on, sir.");
  }
  // The screen couldn't be read, so only the two answers that are always safe to press.
  claude.answerPermission(next.session, pick === 0);
  return answer(pick === 0 ? "Allowed, sir." : "Denied, sir. Claude won't run it.");
}

// A click or a number key: a deliberate choice, so it never needs repeating.
function chooseOption(index: number): Reply | null {
  const next = permissions[0];
  if (!next || !Number.isInteger(index) || !next.options[index]) return null;
  return settleAsking(next, index);
}

// While Claude is waiting, the next thing said answers it.
function answerPermission(said: string): Reply | null {
  const next = permissions[0];
  if (!next) return null;
  const text = said.trim();
  if (/^(jarvis,? )?(cancel|never ?mind|stop|deny|nope|no)(,? sir)?[.!]?$/i.test(text) && (!next.gate || next.gate === "bypass")) return settleAsking(next, null);
  const pending: Pending = { command: next.gate || next.question ? "" : next.command, level: next.level, options: next.options, title: next.title };
  const repeat = (say: string): Reply => ({ say, source: "fast", tool: "claude", pending, ms: 0 });
  if (next.gate) {
    if (isApproval(text, "say-back")) return settleAsking(next, 0);
    return /^(no|nope|cancel)\b/i.test(text) ? settleAsking(next, 1) : repeat("Yes or no, sir?");
  }
  const yes = next.options.findIndex((option) => /^yes\b/i.test(option));
  if (next.level === "confirm" && isPlainYes(text)) return repeat("This one is dangerous, sir, so I need you to say confirm, or cancel.");
  if (next.level === "confirm" && isApproval(text, "confirm")) return settleAsking(next, Math.max(yes, 0));
  if (!next.question) {
    if (isApproval(text, "say-back") && next.level !== "confirm") return settleAsking(next, Math.max(yes, 0));
    // "No, use a different name" refuses and tells Claude what to do instead.
    if (/^(no|nope|don'?t|instead)\b/i.test(text) && text.split(/\s+/).length >= 3) {
      const reply = settleAsking(next, null);
      setTimeout(() => claude.ask(text), 400);
      return { ...reply, say: "Understood, sir. I've told Claude." };
    }
    if (/\b(always|don'?t ask|all edits|session)\b/i.test(text)) {
      const lasting = next.options.findIndex((option) => /^yes\b.*(don'?t ask|session)/i.test(option));
      if (lasting >= 0 && next.level !== "confirm") return settleAsking(next, lasting);
    }
  }
  const pick = pickOption(text, next.options);
  if (pick === null) return repeat("Which one, sir? You can say the number.");
  // A dangerous request can't be approved by a stray number heard from across the room.
  if (next.level === "confirm" && /^yes\b/i.test(next.options[pick])) return repeat("This one is dangerous, sir, so I need you to say confirm, or cancel.");
  return settleAsking(next, pick);
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

const NEW_CHAT = /^(jarvis,? )?(please )?(let'?s )?(start |begin |open )?(a )?new (chat|conversation)( please)?[.!]?$/i;

async function handleSaid(said: string): Promise<Reply> {
  if (NEW_CHAT.test(said.trim())) {
    jarvis.startChat();
    toWindow({ type: "chat-reset" });
    return { say: "A clean page, sir.", source: "fast", ms: 0 };
  }
  const answered = answerPermission(said);
  if (answered) {
    jarvis.record(said, answered.say);
    return answered;
  }
  return jarvis.handle(said);
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
  const reply = await handleSaid(String(said).slice(0, 8000));
  speakReply(reply);
  return reply;
});
ipcMain.handle("jarvis:choose", (_event, index: unknown, label: unknown) => {
  voice?.stop();
  const reply = chooseOption(Number(index));
  if (!reply) return { say: "That question has already moved on, sir.", source: "fast", ms: 0 } satisfies Reply;
  jarvis.record(String(label), reply.say);
  speakReply(reply);
  return reply;
});
ipcMain.handle("chats:resume", () => jarvis.resumeRecent());
ipcMain.handle("chats:list", () => ({ chats: memory.chats(), current: memory.currentChat }));
ipcMain.handle("chats:open", (_event, id: unknown) => jarvis.openChat(Number(id)));
ipcMain.handle("chats:new", () => jarvis.startChat());
ipcMain.handle("chats:delete", (_event, id: unknown) => jarvis.deleteChat(Number(id)));
ipcMain.handle("facts:list", () => memory.allFacts());
ipcMain.handle("facts:delete", (_event, id: unknown) => jarvis.forgetFact(Number(id)));
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
ipcMain.on("claude:bypass", (_event, on: unknown) => claude.setBypass(on === true));
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
