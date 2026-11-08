// Claude's workspace, docked on the right while a project is open: its sessions and terminals as
// tabs, the real terminal, a quiet usage line, and a box to type straight to the session.
import "@xterm/xterm/css/xterm.css";

import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef, useState } from "react";

import { Icon } from "./icons";

type Session = {
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
  elsewhere: boolean;
};
export type Snapshot = {
  project: string | null;
  path: string | null;
  sessions: Session[];
  active: string | null;
  plan: { fiveHour: number | null; fiveHourResets: number | null; week: number | null; weekResets: number | null };
  models: { id: string; label: string }[];
  efforts: string[];
  bypass: boolean;
};

declare global {
  interface Window {
    claude: {
      snapshot(): Promise<Snapshot>;
      buffer(id: string): Promise<{ text: string; end: number }>;
      write(id: string, data: string): void;
      resize(id: string, cols: number, rows: number): void;
      select(id: string): void;
      archive(id: string): void;
      restore(id: string): void;
      newSession(): void;
      newTerminal(): void;
      setModel(id: string, model: string): void;
      setEffort(id: string, effort: string): void;
      setBypass(on: boolean): void;
      closeProject(): void;
      onChange(listener: (snapshot: Snapshot) => void): () => void;
      onData(listener: (id: string, data: string, end: number) => void): () => void;
    };
  }
}

const THEMES = {
  dark: { background: "#040404", foreground: "#f0f0f0", cursor: "#ffffff", selectionBackground: "#444444" },
  light: { background: "#f1e7cf", foreground: "#2b2415", cursor: "#2b2415", selectionBackground: "#dfd0a8" },
};

function savedMode(): "dark" | "light" {
  try {
    return localStorage.getItem("jarvis-mode") === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

// One terminal per session. They stay alive when hidden, so switching keeps their screens.
type Chunk = { data: string; end: number };
type Live = { term: Terminal; fit: FitAddon; host: HTMLDivElement; early: Chunk[] | null; replayed: number };
const terminals = new Map<string, Live>();

function refit(id: string) {
  const live = terminals.get(id);
  if (!live || live.host.offsetParent === null) return;
  const { cols, rows } = live.term;
  live.fit.fit();
  // Claude redraws its whole screen on a resize, so only tell it about real ones.
  if (live.term.cols !== cols || live.term.rows !== rows) window.claude.resize(id, live.term.cols, live.term.rows);
}

function attach(id: string, parent: HTMLElement) {
  if (terminals.has(id)) return;
  const host = document.createElement("div");
  host.className = "terminal-host";
  parent.append(host);
  const term = new Terminal({
    cursorBlink: true,
    fontFamily: '"Geist Mono Variable", "DejaVu Sans Mono", "Ubuntu Mono", monospace',
    fontSize: 13,
    lineHeight: 1.15,
    scrollback: 5000,
    allowProposedApi: true,
    theme: THEMES[savedMode()],
    minimumContrastRatio: 4.5, // Claude's colors assume a dark screen, so this keeps them readable.
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(host);
  term.onData((data) => window.claude.write(id, data));
  const live: Live = { term, fit, host, early: [], replayed: 0 };
  terminals.set(id, live);
  fit.fit();
  window.claude.resize(id, term.cols, term.rows);
  // The saved screen is replayed first. Output can reach the window either side of that reply,
  // so anything the replay already included is skipped, or the session's start shows up twice.
  window.claude.buffer(id).then(({ text, end }) => {
    if (text) term.write(text);
    live.replayed = end;
    for (const chunk of live.early ?? []) if (chunk.end > end) term.write(chunk.data);
    live.early = null;
  });
}

function until(seconds: number | null) {
  if (!seconds) return "";
  const minutes = Math.max(0, Math.round((seconds * 1000 - Date.now()) / 60000));
  if (minutes >= 1440) return `Resets in ${Math.round(minutes / 1440)}d`;
  return minutes >= 60 ? `Resets in ${Math.floor(minutes / 60)}h ${minutes % 60}m` : `Resets in ${minutes}m`;
}

function Usage({ label, value, hint }: { label: string; value: number | null; hint: string }) {
  return (
    <span className={value !== null && value >= 80 ? "hot" : ""} title={hint}>
      {label} <b>{value === null ? "--" : `${Math.round(value)}%`}</b>
    </span>
  );
}

// What you see when no session is open, and whenever you press + beside the tabs.
function SessionView({ snap, onDone }: { snap: Snapshot; onDone(): void }) {
  const [showArchived, setShowArchived] = useState(false);
  const sessions = snap.sessions.filter((session) => session.kind === "claude" && session.state !== "archived");
  const archived = snap.sessions.filter((session) => session.state === "archived");
  const pick = (act: () => void) => {
    act();
    onDone();
  };
  return (
    <div className="session-view">
      <div className="session-inner">
        <div className="session-new">
          <button type="button" className="btn primary" onClick={() => pick(() => window.claude.newSession())}><Icon name="claude" />New Claude session</button>
          <button type="button" className="btn" onClick={() => pick(() => window.claude.newTerminal())}><Icon name="terminal" />New terminal</button>
        </div>
        {sessions.length > 0 && <div className="label">Sessions</div>}
        <ul>
          {sessions.map((session) => (
            <li key={session.id} className={session.id === snap.active ? "on" : ""}>
              <button
                type="button"
                className="session-open"
                disabled={session.elsewhere}
                title={session.elsewhere ? "Open in VS Code or another terminal. Close it there to continue it here." : session.title}
                onClick={() => pick(() => window.claude.select(session.id))}
              >
                <span>{session.title}</span>
                {session.elsewhere && <em>open elsewhere</em>}
                {session.state === "running" && <em>{session.working ? "working" : "open"}</em>}
              </button>
              <button type="button" className="session-x" aria-label={`Archive ${session.title}`} title="Archive" onClick={() => window.claude.archive(session.id)}>
                <Icon name="x" />
              </button>
            </li>
          ))}
        </ul>
        {archived.length > 0 && (
          <button type="button" className="session-archived" aria-expanded={showArchived} onClick={() => setShowArchived((value) => !value)}>
            {showArchived ? "Hide archived" : `View archived (${archived.length})`}
          </button>
        )}
        {showArchived && (
          <ul>
            {archived.map((session) => (
              <li key={session.id}>
                <button type="button" className="session-open" title={session.title} onClick={() => pick(() => window.claude.restore(session.id))}>
                  <span>{session.title}</span>
                  <em>Restore</em>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// Claude's own text goes in as a paste, then Enter a moment later, the way Jarvis relays it.
// A plain terminal just gets the command and Enter.
function typeInto(session: Session, text: string) {
  if (session.kind === "shell") {
    window.claude.write(session.id, `${text}\r`);
    return;
  }
  window.claude.write(session.id, `\x1b[200~${text}\x1b[201~`);
  window.setTimeout(() => window.claude.write(session.id, "\r"), 150);
}

export function ClaudeWorkspace({ snap, mode, askingId, choosing, setChoosing, onHide }: {
  snap: Snapshot;
  mode: "dark" | "light";
  askingId: string | null;
  choosing: boolean;
  setChoosing(open: boolean): void;
  onHide(): void;
}) {
  const area = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState("");

  useEffect(() => {
    return window.claude.onData((id, data, end) => {
      const live = terminals.get(id);
      if (!live) return;
      if (live.early) live.early.push({ data, end });
      else if (end > live.replayed) live.term.write(data);
    });
  }, []);

  useEffect(() => {
    for (const live of terminals.values()) live.term.options.theme = THEMES[mode];
  }, [mode]);

  // Esc stops Claude wherever the cursor is, not only inside the terminal.
  const workingId = snap.sessions.find((session) => session.working)?.id;
  useEffect(() => {
    // While Jarvis is showing one of Claude's questions, Esc answers that instead.
    if (!workingId || askingId || choosing) return;
    const onKey = (event: KeyboardEvent) => {
      const inTerminal = (event.target as HTMLElement | null)?.closest?.(".terminal-host");
      if (event.key === "Escape" && !inTerminal) window.claude.write(workingId, "\x1b");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [workingId, askingId, choosing]);

  const running = snap.sessions.filter((session) => session.state === "running");
  const liveIds = running.map((session) => session.id).join(",");
  const active = snap.sessions.find((session) => session.id === snap.active) ?? null;
  const showChooser = choosing || active?.state !== "running";

  useEffect(() => {
    const parent = area.current;
    if (!parent) return;
    for (const session of running) attach(session.id, parent);
    for (const [id, live] of terminals) {
      if (!snap.sessions.some((session) => session.id === id && session.state !== "archived")) {
        live.term.dispose();
        live.host.remove();
        terminals.delete(id);
      }
    }
    for (const [id, live] of terminals) live.host.hidden = id !== snap.active;
    if (snap.active) {
      refit(snap.active);
      terminals.get(snap.active)?.term.focus();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveIds, snap.active]);

  // Dragging the edge resizes on every frame, so only refit once it has settled.
  useEffect(() => {
    const parent = area.current;
    if (!parent) return;
    let timer = 0;
    const observer = new ResizeObserver(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => snap.active && refit(snap.active), 140);
    });
    observer.observe(parent);
    return () => {
      window.clearTimeout(timer);
      observer.disconnect();
    };
  }, [snap.active]);

  const claude = active?.kind === "claude" && active.state === "running";
  const send = () => {
    if (!active || active.state !== "running" || !draft.trim()) return;
    typeInto(active, draft.trim());
    setDraft("");
  };

  return (
    <>
      <div className="work-head">
        <div className="tabs" role="tablist" aria-label="Sessions and terminals">
          {running.map((session) => (
            <div
              key={session.id}
              role="tab"
              tabIndex={0}
              className="tab"
              data-kind={session.kind}
              aria-selected={session.id === snap.active && !choosing}
              title={session.title}
              onClick={() => {
                window.claude.select(session.id);
                setChoosing(false);
              }}
              onKeyDown={(event) => {
                if (event.key !== "Enter" && event.key !== " ") return;
                event.preventDefault();
                window.claude.select(session.id);
                setChoosing(false);
              }}
            >
              <Icon name={session.kind === "claude" ? "claude" : "terminal"} />
              <span className="tab-title">{session.title}</span>
              {session.id === askingId ? <span className="dot asking" /> : session.working ? <span className="dot working" /> : null}
              <button
                type="button"
                className="x"
                aria-label={`${session.kind === "claude" ? "Archive" : "Close"} ${session.title}`}
                title={session.kind === "claude" ? "Archive" : "Close"}
                onClick={(event) => {
                  event.stopPropagation();
                  window.claude.archive(session.id);
                }}
              >
                <Icon name="x" />
              </button>
            </div>
          ))}
          <button type="button" className="tab-add" aria-label="Sessions and terminals" title="New session, terminal, or an earlier session" aria-pressed={choosing} onClick={() => setChoosing(!choosing)}>
            <Icon name="plus" />
          </button>
        </div>
        <button type="button" className="tb-btn sq" aria-label="Hide Claude" title="Hide Claude. It keeps working." onClick={onHide}>
          <Icon name="side" />
        </button>
        <button type="button" className="tb-btn sq close-proj" aria-label={`Close ${snap.project}`} title={`Close ${snap.project}. Shuts every session and terminal.`} onClick={() => window.claude.closeProject()}>
          <Icon name="close" />
        </button>
      </div>

      <div className="terminals" ref={area}>
        {showChooser && <SessionView snap={snap} onDone={() => setChoosing(false)} />}
      </div>

      <div className="term-status">
        {workingId && <button type="button" className="stop" onClick={() => window.claude.write(workingId, "\x1b")}>Stop Claude</button>}
        {active?.kind === "shell" && <span>Plain terminal. Jarvis and Claude can't see or touch it.</span>}
        <span className="grow" />
        {snap.bypass && <span className="bypass" title="Claude runs commands without asking. Change this in Settings.">bypass on</span>}
        {claude && <Usage label="context" value={active.context} hint={`${active.minutes} min${active.tokens !== null ? ` · ${Math.round(active.tokens / 1000)}k tokens` : ""}`} />}
        <Usage label="5h" value={snap.plan.fiveHour} hint={until(snap.plan.fiveHourResets)} />
        <Usage label="week" value={snap.plan.week} hint={until(snap.plan.weekResets)} />
      </div>

      <div className="band work-band">
        <form
          className="box term-box"
          data-kind={active?.kind ?? "claude"}
          onSubmit={(event) => {
            event.preventDefault();
            send();
          }}
        >
          <span className="prompt" aria-hidden="true">{active?.kind === "shell" ? "$" : "›"}</span>
          <input
            value={draft}
            autoComplete="off"
            spellCheck={false}
            disabled={!active || active.state !== "running"}
            aria-label={active?.kind === "shell" ? "Command for this terminal" : "Message straight to Claude"}
            placeholder={active?.kind === "shell" ? "Type a command" : "Type straight to Claude"}
            onChange={(event) => setDraft(event.target.value)}
          />
          {claude && (
            <span className="term-ctl">
              <span className="sel">
                <select aria-label="Model" value={active.model ?? ""} onChange={(event) => window.claude.setModel(active.id, event.target.value)}>
                  {!active.model && <option value="">Default</option>}
                  {active.model && !snap.models.some((model) => model.id === active.model) && <option value={active.model}>{active.model}</option>}
                  {snap.models.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}
                </select>
              </span>
              <span className="sel">
                <select aria-label="Effort" value={active.effort ?? ""} onChange={(event) => window.claude.setEffort(active.id, event.target.value)}>
                  {!active.effort && <option value="">Default</option>}
                  {snap.efforts.map((effort) => <option key={effort} value={effort}>{effort}</option>)}
                </select>
              </span>
            </span>
          )}
        </form>
      </div>
    </>
  );
}
