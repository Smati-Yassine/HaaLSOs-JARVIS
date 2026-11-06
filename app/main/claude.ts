// Runs the real Claude Code in real terminals, and hears what it does through its official
// hooks and status line. Jarvis never reads your login. The only prompts it answers by itself are
// a folder you already said yes to, and resuming a session you just clicked.
import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

import headless from "@xterm/headless";
import { spawn, type IPty } from "node-pty";

type Screen = InstanceType<typeof headless.Terminal>;

const HOME = process.env.JARVIS_HOME || join(homedir(), ".Jarvis");
const RUN = join(HOME, "run");
const SOCKET = join(RUN, "claude.sock");
const BRIDGE = join(RUN, "bridge.py");
const SETTINGS = join(RUN, "claude-settings.json");
const STORE = join(HOME, "claude-sessions.json");
const PREFERENCES = join(HOME, "preferences.json");
const MAX_BUFFER = 400_000;

// Where Claude Code keeps its own records. Only ever read here, never written.
const CLAUDE_HOME = process.env.JARVIS_CLAUDE_HOME || join(homedir(), ".claude");
const MAX_LISTED = 40;

// Claude's folder name for a project: every character but letters and digits becomes a dash.
export const claudeFolderName = (path: string) => path.replace(/[^a-zA-Z0-9]/g, "-");

// Finds a session's title in its record file: Claude's own title if it made one, otherwise the
// first thing that was asked. Prompts that are really system text don't count.
export function sessionTitle(lines: string[]): string | null {
  let first: string | null = null;
  let titled: string | null = null;
  for (const line of lines) {
    let entry: Record<string, any>;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // The last line of a chunk can be cut off.
    }
    // Run automatically by a program, not a session anyone worked in. Claude's own list hides these.
    if (entry.entrypoint === "sdk-cli") return null;
    if (entry.type === "custom-title" && entry.customTitle) titled = String(entry.customTitle);
    if (entry.type === "ai-title" && entry.aiTitle && !titled) titled = String(entry.aiTitle);
    if (first === null && entry.type === "user" && !entry.isSidechain && !entry.isMeta) {
      const content = entry.message?.content;
      const words = typeof content === "string" ? content : Array.isArray(content) ? content.find((part: any) => part.type === "text")?.text : null;
      if (typeof words === "string" && words.trim() && !words.trimStart().startsWith("<")) first = words.trim();
    }
  }
  // Some tools put a "[tag | date]" in front of the prompt, which says nothing about the session.
  const title = (titled ?? first)?.replace(/^\[[^\]]*\]\s*/, "").replace(/\s+/g, " ").trim();
  return title ? (title.length > 60 ? `${title.slice(0, 60).trimEnd()}...` : title) : null;
}

// Reads both ends of the file: the first prompt is near the start, Claude's title near the end.
function readEnds(path: string, size: number): string[] {
  const chunk = 256_000;
  const file = openSync(path, "r");
  try {
    const read = (from: number, length: number) => {
      const buffer = Buffer.alloc(length);
      const count = readSync(file, buffer, 0, length, from);
      return buffer.toString("utf8", 0, count).split("\n");
    };
    if (size <= chunk * 2) return read(0, size);
    return [...read(0, chunk), ...read(size - chunk, chunk).slice(1)];
  } finally {
    closeSync(file);
  }
}

export type OutsideSession = { id: string; title: string; updated: number };

// Every session Claude has for this folder, wherever it was started: VS Code, a terminal, Jarvis.
export function outsideSessions(path: string, claudeHome = CLAUDE_HOME): OutsideSession[] {
  const folder = join(claudeHome, "projects", claudeFolderName(path));
  if (!existsSync(folder)) return [];
  const files = readdirSync(folder)
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => {
      const stat = statSync(join(folder, name));
      return { name, size: stat.size, updated: stat.mtimeMs };
    })
    .sort((a, b) => b.updated - a.updated);
  const found: OutsideSession[] = [];
  for (const file of files) {
    if (found.length >= MAX_LISTED) break;
    const title = sessionTitle(readEnds(join(folder, file.name), file.size));
    // No real prompt means nothing was ever said in it, so there's nothing to resume.
    if (title) found.push({ id: file.name.replace(/\.jsonl$/, ""), title, updated: file.updated });
  }
  return found;
}

// Sessions open right now in another program. Resuming one of those would have two copies of
// Claude writing to the same conversation.
export function sessionsInUse(claudeHome = CLAUDE_HOME): Set<string> {
  const folder = join(claudeHome, "sessions");
  const open = new Set<string>();
  if (!existsSync(folder)) return open;
  for (const name of readdirSync(folder)) {
    if (!name.endsWith(".json")) continue;
    try {
      const { pid, sessionId } = JSON.parse(readFileSync(join(folder, name), "utf8"));
      process.kill(Number(pid), 0); // Throws if that program has ended.
      if (typeof sessionId === "string") open.add(sessionId);
    } catch {
      // A leftover record from something already closed.
    }
  }
  return open;
}

export const MODELS = [
  { id: "claude-fable-5-1", label: "Fable 5.1" },
  { id: "claude-opus-5-5", label: "Opus 5.5" },
  { id: "claude-sonnet-5-5", label: "Sonnet 5.5" },
  { id: "claude-haiku-5-5", label: "Haiku 5.5" },
];
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

// Claude Code runs this for every hook and status update. It only informs Jarvis and never
// answers, so Claude's own prompts and menus always appear on its screen.
const BRIDGE_SCRIPT = `#!/usr/bin/env python3
import json, socket, sys
kind = sys.argv[1]
raw = sys.stdin.read()
session = sys.argv[2] if len(sys.argv) > 2 else ""
try:
    client = socket.socket(socket.AF_UNIX)
    client.settimeout(5)
    client.connect(${JSON.stringify(SOCKET)})
    client.sendall((json.dumps({"kind": kind, "data": json.loads(raw)}) + "\\n").encode())
    client.close()
except Exception:
    pass
`;

export type SessionView = {
  id: string;
  kind: "claude" | "shell";
  title: string;
  state: "running" | "paused" | "archived";
  working: boolean;
  needsTrust: boolean;
  model: string | null;
  effort: string | null;
  context: number | null;
  tokens: number | null;
  minutes: number;
  // Running in VS Code or another terminal right now, so it shouldn't be opened here too.
  elsewhere: boolean;
};
export type Snapshot = {
  project: string | null;
  path: string | null;
  sessions: SessionView[];
  active: string | null;
  plan: { fiveHour: number | null; fiveHourResets: number | null; week: number | null; weekResets: number | null };
  models: typeof MODELS;
  efforts: string[];
  bypass: boolean;
};
// Claude's own menu, read off its screen, so every choice it offers reaches the chat.
export type Menu = { question: string | null; options: string[] };
export type Gate = "trust" | "bypass";
export type Permission = { session: string; command: string; shell: boolean; menu: Menu | null };
export type Question = { question: string; options: string[]; simple: boolean };

type Session = SessionView & { pty: IPty | null; buffer: string; queued: string[]; started: number; ready: boolean; trustAsked: boolean; bypassAsked: boolean; gate: Gate | null; leftoverInput: boolean; screen: Screen | null; askSeq: number; resumeHandled: boolean };
type Stored = { id: string; title: string; archived: boolean; updated: number };

type Listeners = {
  changed(snapshot: Snapshot): void;
  data(session: string, data: string): void;
  permission(permission: Permission): void;
  question(session: string, question: Question): void;
  // Something Jarvis was asking about got answered or moved on, possibly in the terminal.
  settled(session: string): void;
  finished(session: string, message: string): void;
  gate(project: string, gate: Gate): void;
  // A question Jarvis was asking got answered in the terminal, or its session went away.
  gateCleared(gate: Gate): void;
  notice(text: string): void;
};

// Which answer the trust menu has selected, read from the latest screen.
export function trustSelection(buffer: string): "yes" | "no" | null {
  const screen = buffer.slice(-8000).replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07]*\x07/g, "").replace(/\s/g, "");
  const at = screen.lastIndexOf("❯");
  if (at < 0) return null;
  const after = screen.slice(at + 1, at + 40).replace(/^\d+\./, "");
  if (/^Yes,?I(trust|accept)/i.test(after)) return "yes";
  if (/^No,?exit/i.test(after)) return "no";
  return null;
}

// Finds the numbered menu with the selection arrow in it. A row may wrap onto further lines.
export function readMenu(lines: string[]): Menu | null {
  const rows = lines.map((line) => line.replace(/^[\s│]+|[\s│]+$/g, ""));
  let arrow = -1;
  for (let at = rows.length - 1; at >= 0 && arrow < 0; at--) if (/^❯\s*\d+\.\s/.test(rows[at])) arrow = at;
  if (arrow < 0) return null;
  let first = arrow;
  for (let at = arrow; at >= 0 && arrow - at < 30; at--) {
    if (/^(❯\s*)?1\.\s/.test(rows[at])) {
      first = at;
      break;
    }
  }
  if (!/^(❯\s*)?1\.\s/.test(rows[first])) return null;
  const options: string[] = [];
  for (let at = first; at < rows.length; at++) {
    const option = rows[at].match(/^(?:❯\s*)?(\d+)\.\s+(.+)$/);
    if (option && Number(option[1]) === options.length + 1) options.push(option[2]);
    else if (!rows[at] || /^(esc|enter|tab)\b/i.test(rows[at])) break;
    else options[options.length - 1] += ` ${rows[at]}`;
  }
  if (options.length < 2) return null;
  let question: string | null = null;
  for (let at = first - 1; at >= 0 && question === null; at--) if (rows[at]) question = rows[at].endsWith("?") ? rows[at] : "";
  return {
    question: question || null,
    options: options.map((option) => option.replace(/\s*\((shift\+tab|esc)\)$/i, "").replace(/\s+/g, " ").trim()),
  };
}

// Claude's question when reopening an old or long session. Returns what continuing would cost,
// from the screen with all spaces removed, or null if this isn't that question.
export function resumeCost(screen: string): { asked: boolean; cost: string | null } {
  if (!/Resumethisconversation\?/i.test(screen)) return { asked: false, cost: null };
  const found = screen.match(/willuseabout(\d+%)ofyour([\w-]+?)usagelimit/i);
  return { asked: true, cost: found ? `${found[1]} of your ${found[2]} limit` : null };
}

function describe(tool: string, input: Record<string, unknown>): { text: string; shell: boolean } {
  if (tool === "Bash") return { text: String(input.command ?? ""), shell: true };
  const target = input.file_path ?? input.notebook_path ?? input.url ?? input.pattern ?? input.path;
  return { text: target ? `${tool}: ${String(target)}` : tool, shell: false };
}

export class ClaudeManager {
  private sessions = new Map<string, Session>();
  private project: string | null = null;
  private path: string | null = null;
  private active: string | null = null;
  private plan: Snapshot["plan"] = { fiveHour: null, fiveHourResets: null, week: null, weekResets: null };
  private server: Server | null = null;
  private shellCount = 0;
  // A restarted session has to come back at the size of the window, or its screen garbles.
  private cols = 100;
  private rows = 30;
  private bypass = false;
  // Folders the user has said yes to. Claude doesn't save this for the home folder, so without
  // this list it would ask on every launch.
  private trusted = new Set<string>();
  private watcher: ReturnType<typeof setInterval> | null = null;
  private readonly on: Listeners;

  constructor(listeners: Listeners) {
    this.on = listeners;
    try {
      const saved = JSON.parse(readFileSync(PREFERENCES, "utf8"));
      this.bypass = saved.bypass === true;
      this.trusted = new Set(Array.isArray(saved.trusted) ? saved.trusted.map(String) : []);
    } catch {
      // No saved choice yet, so Claude keeps asking.
    }
  }

  private savePreferences() {
    mkdirSync(HOME, { recursive: true, mode: 0o700 });
    writeFileSync(PREFERENCES, JSON.stringify({ bypass: this.bypass, trusted: [...this.trusted] }), { mode: 0o600 });
  }

  // Applies to sessions from now on, and to idle ones straight away. A busy one finishes first.
  setBypass(on: boolean) {
    this.bypass = on;
    this.savePreferences();
    for (const session of this.sessions.values()) if (session.pty) this.relaunch(session);
    this.changed();
  }

  start() {
    mkdirSync(RUN, { recursive: true, mode: 0o700 });
    writeFileSync(BRIDGE, BRIDGE_SCRIPT, { mode: 0o700 });
    const run = (kind: string) => `python3 ${JSON.stringify(BRIDGE)} ${kind}`;
    const hook = { hooks: [{ type: "command", command: run("hook"), timeout: 10 }] };
    const events = ["SessionStart", "UserPromptSubmit", "PermissionRequest", "PostToolUse", "Stop", "SessionEnd"];
    writeFileSync(SETTINGS, JSON.stringify({
      statusLine: { type: "command", command: run("status") },
      hooks: {
        ...Object.fromEntries(events.map((event) => [event, [hook]])),
        PreToolUse: [{ matcher: "AskUserQuestion", ...hook }],
      },
    }, null, 1));
    if (existsSync(SOCKET)) rmSync(SOCKET);
    this.server = createServer((socket) => this.receive(socket));
    this.server.listen(SOCKET, () => chmodSync(SOCKET, 0o600));
  }

  stop() {
    this.closeProject();
    this.server?.close();
    if (existsSync(SOCKET)) rmSync(SOCKET);
  }

  get openProject() {
    return this.project;
  }
  get working() {
    return [...this.sessions.values()].some((session) => session.working);
  }

  private receive(socket: Socket) {
    let text = "";
    socket.on("error", () => {});
    socket.on("data", (chunk) => {
      text += chunk.toString();
      const end = text.indexOf("\n");
      if (end < 0) return;
      const line = text.slice(0, end);
      text = text.slice(end + 1);
      try {
        const { kind, data } = JSON.parse(line);
        if (kind === "status") this.onStatus(data);
        else this.onHook(data);
      } catch {
        socket.destroy();
      }
    });
  }

  private onStatus(data: Record<string, any>) {
    const limits = data.rate_limits;
    if (limits) {
      this.plan = {
        fiveHour: limits.five_hour?.used_percentage ?? null,
        fiveHourResets: limits.five_hour?.resets_at ?? null,
        week: limits.seven_day?.used_percentage ?? null,
        weekResets: limits.seven_day?.resets_at ?? null,
      };
    }
    const session = this.sessions.get(data.session_id);
    if (session) {
      session.model = data.model?.id ?? session.model;
      session.effort = data.effort?.level ?? session.effort;
      session.context = data.context_window?.used_percentage ?? session.context;
      const window = data.context_window;
      if (window) session.tokens = (window.total_input_tokens ?? 0) + (window.total_output_tokens ?? 0);
      session.minutes = Math.round((data.cost?.total_duration_ms ?? (Date.now() - session.started)) / 60000);
    }
    this.changed();
  }

  private onHook(data: Record<string, any>) {
    const session = this.sessions.get(data.session_id);
    switch (data.hook_event_name) {
      case "SessionStart":
        if (session) {
          session.ready = true;
          // Still waiting on a question means it was answered in the terminal.
          this.gateAnswered(session);
          for (const prompt of session.queued.splice(0)) this.type(session, prompt);
        }
        break;
      case "UserPromptSubmit":
        if (session) {
          session.working = true;
          if (session.title === "New session" && typeof data.prompt === "string") {
            session.title = data.prompt.length > 34 ? `${data.prompt.slice(0, 34)}...` : data.prompt;
            this.remember(session);
          }
        }
        break;
      case "Stop":
        if (session) {
          session.working = false;
          session.askSeq += 1;
          this.on.settled(session.id);
          this.on.finished(session.id, String(data.last_assistant_message ?? ""));
        }
        break;
      case "SessionEnd":
        if (session) session.working = false;
        break;
      case "PermissionRequest": {
        if (data.tool_name === "AskUserQuestion") return;
        const what = describe(String(data.tool_name), data.tool_input ?? {});
        // The hook runs just before the menu is drawn, so give it a moment to appear.
        const seq = session ? ++session.askSeq : 0;
        const began = Date.now();
        const look = () => {
          if (session && session.askSeq !== seq) return; // Already answered in the terminal.
          const menu = this.menu(data.session_id);
          // A file inside the project reads better without the whole path in front of it.
          const command = !what.shell && this.path ? what.text.replace(`${this.path}/`, "") : what.text;
          if (menu || Date.now() - began > 2500) this.on.permission({ session: data.session_id, command, shell: what.shell, menu });
          else setTimeout(look, 100);
        };
        look();
        return;
      }
      case "PreToolUse": {
        const questions = (data.tool_input?.questions ?? []) as { question: string; multiSelect?: boolean; options?: { label: string }[] }[];
        const first = questions[0];
        if (first) {
          this.on.question(data.session_id, {
            question: first.question,
            options: (first.options ?? []).map((option) => option.label),
            simple: questions.length === 1 && !first.multiSelect,
          });
        }
        return;
      }
      case "PostToolUse":
        if (session) {
          session.working = true; // It carried on, even if Esc only closed a menu.
          session.askSeq += 1;
        }
        this.on.settled(data.session_id);
        return;
    }
    this.changed();
  }

  // These menus start on "No, exit". Keys sent before one is ready get lost, and Enter would then
  // choose No, so Enter is only pressed once the screen shows Yes selected.
  private pressYes(session: Session, onFail?: () => void) {
    const gate = session.gate;
    session.needsTrust = false;
    session.gate = null;
    let tries = 0;
    const step = () => {
      if (!session.pty || session.ready) return;
      if (trustSelection(session.buffer) === "yes") {
        session.pty.write("\r");
        return;
      }
      if (++tries > 20) {
        session.needsTrust = true;
        session.gate = gate;
        this.changed();
        onFail?.();
        return;
      }
      session.pty.write("\x1b[B");
      setTimeout(step, 400);
    };
    setTimeout(step, 400);
  }

  private waitingOn(gate: Gate) {
    return [...this.sessions.values()].filter((session) => session.needsTrust && session.gate === gate && session.pty);
  }

  private rememberFolder() {
    if (!this.path || this.trusted.has(this.path)) return;
    this.trusted.add(this.path);
    this.savePreferences();
  }

  // The user answered through Jarvis. One answer covers every session waiting on that question.
  answerGate(gate: Gate, allow: boolean, onFail?: () => void) {
    const waiting = this.waitingOn(gate);
    if (!allow) {
      for (const session of waiting) {
        session.needsTrust = false;
        session.gate = null;
      }
      // Refusing the bypass warning only means going back to asking, not losing the project.
      if (gate === "bypass") this.setBypass(false);
      else this.closeProject();
      return;
    }
    if (gate === "trust") this.rememberFolder();
    for (const session of waiting) this.pressYes(session, onFail);
    this.changed();
  }

  // The question moved on without Jarvis: answered in the terminal, or the session ended.
  private gateAnswered(session: Session, accepted = true) {
    const gate = session.gate;
    session.needsTrust = false;
    session.gate = null;
    if (!gate) return;
    if (accepted && gate === "trust") this.rememberFolder();
    if (this.waitingOn(gate).length) {
      if (accepted) for (const other of this.waitingOn(gate)) this.pressYes(other);
      else return;
    }
    this.on.gateCleared(gate);
  }

  // What Claude's screen shows right now, as a person would see it.
  menu(id: string): Menu | null {
    const screen = this.sessions.get(id)?.screen;
    if (!screen) return null;
    const buffer = screen.buffer.active;
    const lines: string[] = [];
    for (let row = 0; row < screen.rows; row++) lines.push(buffer.getLine(buffer.baseY + row)?.translateToString(true) ?? "");
    return readMenu(lines);
  }

  // Claude treats a refusal like an interruption: it stops without saying so.
  answerPermission(id: string, allow: boolean) {
    const session = this.sessions.get(id);
    session?.pty?.write(allow ? "1" : "\x1b");
    if (session && !allow) this.markStopped(session);
  }

  // Presses the number only if that same choice is still on the screen, because otherwise the
  // digit would land in Claude's input box.
  answerMenu(id: string, index: number, label: string): boolean {
    const session = this.sessions.get(id);
    const menu = this.menu(id);
    if (!session?.pty || menu?.options[index] !== label) return false;
    session.pty.write(String(index + 1));
    if (/^no\b/i.test(label)) this.markStopped(session);
    return true;
  }

  answerChoice(id: string, index: number) {
    this.sessions.get(id)?.pty?.write(String(index + 1));
  }

  // Claude reports nothing when interrupted, so the app records it here.
  private markStopped(session: Session) {
    session.working = false;
    session.leftoverInput = true; // Claude puts a stopped request back in its input box.
    session.askSeq += 1;
    this.on.settled(session.id);
    this.changed();
  }

  // Esc is how Claude Code stops what it's doing.
  interrupt(): boolean {
    const session = [...this.sessions.values()].find((item) => item.working && item.pty);
    if (!session) return false;
    session.pty!.write("\x1b");
    this.markStopped(session);
    return true;
  }

  // ---- Sessions ------------------------------------------------------------

  private cleanEnv() {
    const env: Record<string, string> = { TERM: "xterm-256color", COLORTERM: "truecolor" };
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && !key.startsWith("CLAUDE") && !key.startsWith("ELECTRON")) env[key] = value;
    }
    env.TERM = "xterm-256color";
    return env;
  }

  private spawnInto(session: Session, file: string, args: string[]) {
    const pty = spawn(file, args, { name: "xterm-256color", cols: this.cols, rows: this.rows, cwd: this.path ?? homedir(), env: this.cleanEnv() });
    session.pty = pty;
    session.state = "running";
    pty.onData((data) => {
      session.buffer = (session.buffer + data).slice(-MAX_BUFFER);
      session.screen?.write(data);
      this.on.data(session.id, data);
      if (session.kind === "claude") this.watchStartup(session);
    });
    pty.onExit(() => {
      if (session.pty !== pty) return;
      session.pty = null;
      session.working = false;
      if (session.gate) this.gateAnswered(session, false);
      if (session.kind === "shell") {
        this.sessions.delete(session.id);
        if (this.active === session.id) this.active = [...this.sessions.keys()][0] ?? null;
      } else if (session.state === "running") session.state = "paused";
      this.changed();
    });
  }

  // Claude can ask things before it starts. Reads the screen for them as it's drawn.
  private watchStartup(session: Session) {
    const screen = session.buffer.slice(-6000).replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07]*\x07/g, "").replace(/\s/g, "");
    if (!session.resumeHandled) {
      const { asked, cost } = resumeCost(screen);
      if (asked) {
        session.resumeHandled = true;
        // Clicking the session already answered this, and nothing is spent until a message is sent.
        setTimeout(() => {
          if (this.menu(session.id)?.options[0] === "Resume") session.pty?.write("\r");
          this.on.notice(cost ? `That conversation is a long one, sir. Your next message in it will use about ${cost}.` : "That conversation is a long one, sir, so your next message in it will use more of your limit.");
        }, 400);
      }
    }
    if (session.ready) return;
    const ask = (gate: Gate) => {
      session.needsTrust = true;
      session.gate = gate;
      // Already said yes to this folder, so there's no need to ask again.
      if (gate === "trust" && this.path && this.trusted.has(this.path)) {
        this.pressYes(session);
        return;
      }
      this.changed();
      if (this.project) this.on.gate(this.project, gate);
    };
    // The next question showing means the last one was answered in the terminal.
    if (session.gate === "trust" && /Yes,?Iaccept/i.test(screen)) this.gateAnswered(session);
    if (session.needsTrust) return;
    if (!session.trustAsked && /Yes,?Itrustthisfolder/i.test(screen)) {
      session.trustAsked = true;
      ask("trust");
    } else if (!session.bypassAsked && /Yes,?Iaccept/i.test(screen)) {
      session.bypassAsked = true;
      ask("bypass");
    }
  }

  private blank(id: string, kind: Session["kind"], title: string): Session {
    return {
      id, kind, title, state: "running", working: false, needsTrust: false, model: null, effort: null, context: null,
      tokens: null, minutes: 0, elsewhere: false, pty: null, buffer: "", queued: [], started: Date.now(), ready: kind === "shell", trustAsked: false, bypassAsked: false, gate: null, leftoverInput: false,
      screen: kind === "claude" ? new headless.Terminal({ cols: this.cols, rows: this.rows, scrollback: 0, allowProposedApi: true }) : null, askSeq: 0, resumeHandled: false,
    };
  }

  private launchClaude(session: Session, resume: boolean) {
    const args = ["--permission-mode", this.bypass ? "bypassPermissions" : "default", "--settings", SETTINGS];
    args.push(...(resume ? ["--resume", session.id] : ["--session-id", session.id]));
    if (session.model) args.push("--model", session.model);
    if (session.effort) args.push("--effort", session.effort);
    // A fresh start: old text on the screen must not be mistaken for a new question.
    session.ready = false;
    session.trustAsked = false;
    session.bypassAsked = false;
    session.resumeHandled = false;
    session.needsTrust = false;
    session.gate = null;
    session.buffer = "";
    session.screen?.reset();
    this.on.data(session.id, "\x1b[2J\x1b[3J\x1b[H");
    this.spawnInto(session, "claude", args);
  }

  open(project: string, path: string) {
    this.project = project;
    this.path = path;
    this.sessions.clear();
    for (const stored of this.load(project)) {
      const session = this.blank(stored.id, "claude", stored.title);
      session.state = stored.archived ? "archived" : "paused";
      this.sessions.set(stored.id, session);
    }
    this.syncOutside();
    if (this.watcher) clearInterval(this.watcher);
    this.watcher = setInterval(() => this.syncOutside(), 15_000);
    this.watcher.unref();
    return this.newSession();
  }

  // Brings in sessions from VS Code and terminals, most recent first, including new ones that
  // appear while the project is open.
  private syncOutside() {
    if (!this.path) return;
    let found: OutsideSession[];
    let inUse: Set<string>;
    try {
      found = outsideSessions(this.path);
      inUse = sessionsInUse();
    } catch {
      return; // Unreadable records shouldn't get in the way of working.
    }
    let changed = false;
    for (const item of found) {
      const known = this.sessions.get(item.id);
      if (known) {
        if (known.title !== "New session" && !known.pty && known.state === "paused" && known.title !== item.title) {
          known.title = item.title;
          changed = true;
        }
      } else {
        const session = this.blank(item.id, "claude", item.title);
        session.state = "paused";
        this.sessions.set(item.id, session);
        changed = true;
      }
    }
    for (const session of this.sessions.values()) {
      const elsewhere = !session.pty && inUse.has(session.id);
      if (session.elsewhere !== elsewhere) {
        session.elsewhere = elsewhere;
        changed = true;
      }
    }
    if (changed) {
      // What's running stays on top, then the rest with the most recent first.
      const when = new Map(found.map((item) => [item.id, item.updated]));
      const rank = (session: Session) => (session.pty ? Infinity : (when.get(session.id) ?? 0));
      this.sessions = new Map([...this.sessions].sort(([, a], [, b]) => rank(b) - rank(a)));
      this.changed();
    }
  }

  newSession(): string {
    const session = this.blank(randomUUID(), "claude", "New session");
    this.sessions = new Map([[session.id, session], ...this.sessions]);
    this.active = session.id;
    this.launchClaude(session, false);
    this.changed();
    return session.id;
  }

  newTerminal(): string {
    this.shellCount += 1;
    const session = this.blank(randomUUID(), "shell", `Terminal ${this.shellCount}`);
    this.sessions.set(session.id, session);
    this.active = session.id;
    this.spawnInto(session, process.env.SHELL || "bash", ["-l"]);
    this.changed();
    return session.id;
  }

  select(id: string) {
    const session = this.sessions.get(id);
    if (!session || session.state === "archived" || session.elsewhere) return;
    this.active = id;
    // A session nothing was ever said in has no conversation to resume.
    if (session.kind === "claude" && !session.pty) this.launchClaude(session, session.title !== "New session");
    this.changed();
  }

  archive(id: string) {
    const session = this.sessions.get(id);
    if (!session) return;
    if (session.kind === "shell") {
      session.pty?.kill();
      this.sessions.delete(id);
    } else {
      const pty = session.pty;
      session.pty = null;
      pty?.kill();
      session.state = "archived";
      session.working = false;
      session.screen?.reset();
      this.remember(session);
    }
    if (this.active === id) {
      this.active = [...this.sessions.values()].find((other) => other.state !== "archived")?.id ?? null;
    }
    this.changed();
  }

  restore(id: string) {
    const session = this.sessions.get(id);
    if (!session) return;
    session.state = "paused";
    this.remember(session);
    this.select(id);
  }

  closeProject() {
    if (this.watcher) clearInterval(this.watcher);
    this.watcher = null;
    for (const session of this.sessions.values()) {
      const pty = session.pty;
      session.pty = null;
      pty?.kill();
      session.screen?.dispose();
    }
    this.sessions.clear();
    this.project = null;
    this.path = null;
    this.active = null;
    this.changed();
  }

  write(id: string, data: string) {
    const session = this.sessions.get(id);
    session?.pty?.write(data);
    if (session?.working && data === "\x1b") this.markStopped(session);
  }

  resize(id: string, cols: number, rows: number) {
    if (cols <= 0 || rows <= 0) return;
    this.cols = cols;
    this.rows = rows;
    const session = this.sessions.get(id);
    session?.pty?.resize(cols, rows);
    session?.screen?.resize(cols, rows);
  }

  buffer(id: string) {
    return this.sessions.get(id)?.buffer ?? "";
  }

  // Passes the user's exact words to Claude, as if typed.
  private type(session: Session, text: string) {
    // Ctrl+U clears that leftover, so the new request doesn't get glued onto the old one.
    if (session.leftoverInput) session.pty?.write("\x15");
    session.leftoverInput = false;
    session.pty?.write(`\x1b[200~${text}\x1b[201~`);
    setTimeout(() => session.pty?.write("\r"), 150);
  }

  private currentClaude(): Session | null {
    const active = this.active ? this.sessions.get(this.active) : null;
    if (active?.kind === "claude" && active.pty) return active;
    return [...this.sessions.values()].find((session) => session.kind === "claude" && session.pty) ?? null;
  }

  ask(text: string): boolean {
    const session = this.currentClaude();
    if (!session) return false;
    this.active = session.id;
    if (session.ready) this.type(session, text);
    else session.queued.push(text);
    this.changed();
    return true;
  }

  // Typing /model or /effort would save them as the user's global Claude Code defaults, so
  // the session restarts with command-line options instead. Those apply to this session only,
  // and --resume keeps the whole conversation. It waits while Claude is mid-task.
  private relaunch(session: Session): boolean {
    if (session.working || session.kind !== "claude") return false;
    const pty = session.pty;
    session.pty = null;
    pty?.kill();
    // A session that hasn't been used yet has no conversation to resume.
    this.launchClaude(session, session.title !== "New session");
    this.changed();
    return true;
  }

  setModel(id: string, model: string): boolean {
    const session = this.sessions.get(id);
    if (!session?.pty || session.working) return false;
    session.model = model;
    return this.relaunch(session);
  }

  setEffort(id: string, effort: string): boolean {
    const session = this.sessions.get(id);
    if (!session?.pty || session.working) return false;
    session.effort = effort;
    return this.relaunch(session);
  }

  setActiveModel(name: string): string | null {
    const session = this.currentClaude();
    const model = MODELS.find((option) => option.label.toLowerCase().startsWith(name.toLowerCase()));
    if (!session || !model) return null;
    return this.setModel(session.id, model.id) ? model.label : null;
  }

  setActiveEffort(level: string): boolean {
    const session = this.currentClaude();
    if (!session || !EFFORTS.includes(level)) return false;
    return this.setEffort(session.id, level);
  }

  archiveActive(): string | null {
    const session = this.currentClaude();
    if (!session || session.working) return null;
    const title = session.title;
    this.archive(session.id);
    return title;
  }

  // ---- Remembering sessions between runs -----------------------------------

  private readStore(): Record<string, Stored[]> {
    try {
      return JSON.parse(readFileSync(STORE, "utf8"));
    } catch {
      return {};
    }
  }

  private load(project: string): Stored[] {
    return this.readStore()[project] ?? [];
  }

  private remember(session: Session) {
    if (!this.project || session.kind !== "claude" || session.title === "New session") return;
    const store = this.readStore();
    const list = (store[this.project] ?? []).filter((item) => item.id !== session.id);
    list.unshift({ id: session.id, title: session.title, archived: session.state === "archived", updated: Date.now() });
    store[this.project] = list.slice(0, 30);
    writeFileSync(STORE, JSON.stringify(store, null, 1), { mode: 0o600 });
  }

  snapshot(): Snapshot {
    const sessions: SessionView[] = [...this.sessions.values()].map((session) => ({
      id: session.id, kind: session.kind, title: session.title, state: session.state, working: session.working, needsTrust: session.needsTrust,
      model: session.model, effort: session.effort, context: session.context, tokens: session.tokens, minutes: session.minutes, elsewhere: session.elsewhere,
    }));
    return { project: this.project, path: this.path, sessions, active: this.active, plan: this.plan, models: MODELS, efforts: EFFORTS, bypass: this.bypass };
  }

  private changed() {
    this.on.changed(this.snapshot());
  }
}
