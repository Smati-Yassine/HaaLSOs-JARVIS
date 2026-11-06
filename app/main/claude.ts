// Runs the real Claude Code in real terminals, and hears what it does through its official
// hooks and status line. Jarvis never reads your login, and never answers a prompt by itself.
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

import { spawn, type IPty } from "node-pty";

const HOME = join(homedir(), ".Jarvis");
const RUN = join(HOME, "run");
const SOCKET = join(RUN, "claude.sock");
const BRIDGE = join(RUN, "bridge.py");
const SETTINGS = join(RUN, "claude-settings.json");
const STORE = join(HOME, "claude-sessions.json");
const MAX_BUFFER = 400_000;

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
};
export type Snapshot = {
  project: string | null;
  path: string | null;
  sessions: SessionView[];
  active: string | null;
  plan: { fiveHour: number | null; fiveHourResets: number | null; week: number | null; weekResets: number | null };
  models: typeof MODELS;
  efforts: string[];
};
export type Permission = { session: string; command: string; shell: boolean };
export type Question = { question: string; options: string[]; simple: boolean };

type Session = SessionView & { pty: IPty | null; buffer: string; queued: string[]; started: number; ready: boolean; trustAsked: boolean; leftoverInput: boolean };
type Stored = { id: string; title: string; archived: boolean; updated: number };

type Listeners = {
  changed(snapshot: Snapshot): void;
  data(session: string, data: string): void;
  permission(permission: Permission): void;
  question(session: string, question: Question): void;
  // Something Jarvis was asking about got answered or moved on, possibly in the terminal.
  settled(session: string): void;
  finished(session: string, message: string): void;
  trustNeeded(project: string): void;
};

// Which answer the trust menu has selected, read from the latest screen.
export function trustSelection(buffer: string): "yes" | "no" | null {
  const screen = buffer.slice(-8000).replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07]*\x07/g, "").replace(/\s/g, "");
  const at = screen.lastIndexOf("❯");
  if (at < 0) return null;
  const after = screen.slice(at + 1, at + 40).replace(/^\d+\./, "");
  if (/^Yes,?Itrust/i.test(after)) return "yes";
  if (/^No,?exit/i.test(after)) return "no";
  return null;
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
  private readonly on: Listeners;

  constructor(listeners: Listeners) {
    this.on = listeners;
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
          session.needsTrust = false;
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
        this.on.permission({ session: data.session_id, command: what.text, shell: what.shell });
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
        if (session) session.working = true; // It carried on, even if Esc only closed a menu.
        this.on.settled(data.session_id);
        return;
    }
    this.changed();
  }

  // The menu starts on "No, exit". Keys sent before it's ready get lost, and Enter would then
  // choose No, so Enter is only pressed once the screen shows Yes selected.
  answerTrust(allow: boolean, onFail?: () => void) {
    const session = [...this.sessions.values()].find((item) => item.needsTrust);
    if (!session?.pty) return;
    session.needsTrust = false;
    if (!allow) {
      this.closeProject();
      return;
    }
    let tries = 0;
    const step = () => {
      if (!session.pty || session.ready) return;
      if (trustSelection(session.buffer) === "yes") {
        session.pty.write("\r");
        return;
      }
      if (++tries > 20) {
        session.needsTrust = true;
        this.changed();
        onFail?.();
        return;
      }
      if (trustSelection(session.buffer) !== "yes") session.pty.write("\x1b[B");
      setTimeout(step, 400);
    };
    setTimeout(step, 400);
    this.changed();
  }

  // Answers Claude's own prompt on its screen, the same keys a person would press.
  answerPermission(id: string, allow: boolean) {
    this.sessions.get(id)?.pty?.write(allow ? "1" : "\x1b");
  }

  answerChoice(id: string, index: number) {
    this.sessions.get(id)?.pty?.write(String(index + 1));
  }

  // Claude reports nothing when interrupted, so the app records it here.
  private markStopped(session: Session) {
    session.working = false;
    session.leftoverInput = true; // Claude puts a stopped request back in its input box.
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
      this.on.data(session.id, data);
      // Claude asks this before it starts. The user answers through Jarvis.
      if (session.kind === "claude" && !session.ready && !session.trustAsked) {
        const screen = session.buffer.slice(-6000).replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07]*\x07/g, "").replace(/\s/g, "");
        if (/Yes,?Itrustthisfolder/i.test(screen)) {
          session.trustAsked = true;
          session.needsTrust = true;
          this.changed();
          if (this.project) this.on.trustNeeded(this.project);
        }
      }
    });
    pty.onExit(() => {
      if (session.pty !== pty) return;
      session.pty = null;
      session.working = false;
      if (session.kind === "shell") {
        this.sessions.delete(session.id);
        if (this.active === session.id) this.active = [...this.sessions.keys()][0] ?? null;
      } else if (session.state === "running") session.state = "paused";
      this.changed();
    });
  }

  private blank(id: string, kind: Session["kind"], title: string): Session {
    return {
      id, kind, title, state: "running", working: false, needsTrust: false, model: null, effort: null, context: null,
      tokens: null, minutes: 0, pty: null, buffer: "", queued: [], started: Date.now(), ready: kind === "shell", trustAsked: false, leftoverInput: false,
    };
  }

  private launchClaude(session: Session, resume: boolean) {
    const args = ["--permission-mode", "default", "--settings", SETTINGS];
    args.push(...(resume ? ["--resume", session.id] : ["--session-id", session.id]));
    if (session.model) args.push("--model", session.model);
    if (session.effort) args.push("--effort", session.effort);
    session.ready = false;
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
    return this.newSession();
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
    if (!session || session.state === "archived") return;
    this.active = id;
    if (session.kind === "claude" && !session.pty) this.launchClaude(session, true);
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
    for (const session of this.sessions.values()) {
      const pty = session.pty;
      session.pty = null;
      pty?.kill();
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
    this.sessions.get(id)?.pty?.resize(cols, rows);
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
    session.buffer = "";
    this.on.data(session.id, "\x1b[2J\x1b[3J\x1b[H");
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
    const sessions = [...this.sessions.values()].map(({ pty: _pty, buffer: _buffer, queued: _queued, started: _started, ready: _ready, ...view }) => view);
    return { project: this.project, path: this.path, sessions, active: this.active, plan: this.plan, models: MODELS, efforts: EFFORTS };
  }

  private changed() {
    this.on.changed(this.snapshot());
  }
}
