// The Claude side of the app: sessions, real terminals and the status bar.
import "@xterm/xterm/css/xterm.css";

import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef, useState } from "react";

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
      buffer(id: string): Promise<string>;
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
      onData(listener: (id: string, data: string) => void): () => void;
    };
  }
}

const THEMES = {
  dark: { background: "#070707", foreground: "#f0f0f0", cursor: "#ffffff", selectionBackground: "#444444" },
  light: { background: "#f6eedb", foreground: "#2b2415", cursor: "#2b2415", selectionBackground: "#dfd0a8" },
};

function savedMode(): "dark" | "light" {
  try {
    return localStorage.getItem("jarvis-mode") === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

// One terminal per session. They stay alive when hidden, so switching keeps their screens.
type Live = { term: Terminal; fit: FitAddon; host: HTMLDivElement; early: string[] | null };
const terminals = new Map<string, Live>();

function refit(id: string) {
  const live = terminals.get(id);
  if (!live || live.host.offsetParent === null) return;
  live.fit.fit();
  window.claude.resize(id, live.term.cols, live.term.rows);
}

function attach(id: string, parent: HTMLElement) {
  if (terminals.has(id)) return;
  const host = document.createElement("div");
  host.className = "terminal-host";
  parent.append(host);
  const term = new Terminal({
    cursorBlink: true,
    fontFamily: '"DejaVu Sans Mono", "Ubuntu Mono", monospace',
    fontSize: 13,
    scrollback: 5000,
    allowProposedApi: true,
    theme: THEMES[savedMode()],
    minimumContrastRatio: 4.5, // Claude's colors assume a dark screen, so this keeps them readable.
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(host);
  term.onData((data) => window.claude.write(id, data));
  const live: Live = { term, fit, host, early: [] };
  terminals.set(id, live);
  // The saved screen already includes anything sent before this point.
  window.claude.buffer(id).then((text) => {
    if (text) term.write(text);
    live.early = null;
  });
}

const percent = (value: number | null) => (value === null ? "--" : `${Math.round(value)}%`);
function until(seconds: number | null) {
  if (!seconds) return "";
  const minutes = Math.max(0, Math.round((seconds * 1000 - Date.now()) / 60000));
  if (minutes >= 1440) return `resets in ${Math.round(minutes / 1440)}d`;
  return minutes >= 60 ? `resets in ${Math.floor(minutes / 60)}h ${minutes % 60}m` : `resets in ${minutes}m`;
}

function Meter({ label, value, warm, hint }: { label: string; value: number | null; warm?: boolean; hint?: string }) {
  return (
    <span className="meter" title={hint}>
      {label}
      <span className="bar"><i className={warm ? "warm" : ""} style={{ width: `${value ?? 0}%` }} /></span>
      <b>{percent(value)}</b>
    </span>
  );
}

export function ClaudePanel({ snap, mode, asking, onMinimize }: { snap: Snapshot; mode: "dark" | "light"; asking: boolean; onMinimize(): void }) {
  const [showArchived, setShowArchived] = useState(false);
  const area = useRef<HTMLDivElement>(null);

  useEffect(() => {
    return window.claude.onData((id, data) => {
      const live = terminals.get(id);
      if (live && !live.early) live.term.write(data);
    });
  }, []);

  useEffect(() => {
    for (const live of terminals.values()) live.term.options.theme = THEMES[mode];
  }, [mode]);

  // Esc stops Claude wherever the cursor is, not only inside the terminal.
  const workingId = snap.sessions.find((session) => session.working)?.id;
  useEffect(() => {
    // While Jarvis is showing one of Claude's questions, Esc answers that instead.
    if (!workingId || asking) return;
    const onKey = (event: KeyboardEvent) => {
      const inTerminal = (event.target as HTMLElement | null)?.closest?.(".terminal-host");
      if (event.key === "Escape" && !inTerminal) window.claude.write(workingId, "\x1b");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [workingId, asking]);

  const liveIds = snap.sessions.filter((session) => session.state === "running").map((session) => session.id).join(",");
  const active = snap.sessions.find((session) => session.id === snap.active) ?? null;

  useEffect(() => {
    const parent = area.current;
    if (!parent) return;
    for (const session of snap.sessions) if (session.state === "running") attach(session.id, parent);
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

  useEffect(() => {
    const parent = area.current;
    if (!parent) return;
    const observer = new ResizeObserver(() => snap.active && refit(snap.active));
    observer.observe(parent);
    return () => observer.disconnect();
  }, [snap.active]);

  const claudes = snap.sessions.filter((session) => session.kind === "claude" && session.state !== "archived");
  const shells = snap.sessions.filter((session) => session.kind === "shell");
  const archived = snap.sessions.filter((session) => session.state === "archived");

  return (
    <section className="claude-panel" aria-label="Claude">
      <header className="panel-bar">
        <b>Claude</b>
        <span className="sep">/</span>
        <span className="project">{snap.project}</span>
        <span className="path">{snap.path}</span>
        <button className="win" type="button" aria-label="Hide Claude" title="Hide Claude" onClick={onMinimize}>&minus;</button>
        <button className="win close" type="button" onClick={() => window.claude.closeProject()}>Close project</button>
      </header>
      <div className="work">
        <nav className="side" aria-label="Sessions and terminals">
          <div className="side-title">Claude sessions<button type="button" aria-label="New Claude session" onClick={() => window.claude.newSession()}>+</button></div>
          {claudes.map((session) => (
            <div key={session.id} className={`row ${session.id === snap.active ? "on" : ""}`}>
              <button
                type="button"
                className="row-main"
                disabled={session.elsewhere}
                title={session.elsewhere ? "Open in VS Code or another terminal. Close it there to continue it here." : session.title}
                onClick={() => window.claude.select(session.id)}
              >
                <span className={`dot ${session.working ? "working" : session.state}`} />
                <span className="name">{session.title}</span>
                {session.elsewhere && <span className="pct">open elsewhere</span>}
                {session.context !== null && <span className="pct">{percent(session.context)}</span>}
              </button>
              <button type="button" className="row-x" aria-label={`Archive ${session.title}`} onClick={() => window.claude.archive(session.id)}>×</button>
            </div>
          ))}
          <div className="side-title">Terminals<button type="button" aria-label="New terminal" onClick={() => window.claude.newTerminal()}>+</button></div>
          {shells.map((session) => (
            <div key={session.id} className={`row ${session.id === snap.active ? "on" : ""}`}>
              <button type="button" className="row-main" onClick={() => window.claude.select(session.id)}>
                <span className="glyph">&gt;</span>
                <span className="name">{session.title}</span>
              </button>
              <button type="button" className="row-x" aria-label={`Close ${session.title}`} onClick={() => window.claude.archive(session.id)}>×</button>
            </div>
          ))}
          {archived.length > 0 && (
            <button type="button" className="archive-toggle" onClick={() => setShowArchived((value) => !value)}>
              {showArchived ? "Hide" : "Show"} archived ({archived.length})
            </button>
          )}
          {showArchived && archived.map((session) => (
            <div key={session.id} className="archived">
              <span title={session.title}>{session.title}</span>
              <button type="button" onClick={() => window.claude.restore(session.id)}>Restore</button>
            </div>
          ))}
        </nav>
        <div className="terminals" ref={area}>
          {!snap.active && <p className="empty">Nothing is open. Use + to start a Claude session or a terminal.</p>}
        </div>
      </div>
      <footer className="status">
        {active?.kind === "claude" ? (
          <>
            <label className="pick">
              Model
              <select value={active.model ?? ""} onChange={(event) => window.claude.setModel(active.id, event.target.value)}>
                {!active.model && <option value="">Default</option>}
                {active.model && !snap.models.some((model) => model.id === active.model) && <option value={active.model}>{active.model}</option>}
                {snap.models.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}
              </select>
            </label>
            <label className="pick">
              Effort
              <select value={active.effort ?? ""} onChange={(event) => window.claude.setEffort(active.id, event.target.value)}>
                {!active.effort && <option value="">Default</option>}
                {snap.efforts.map((effort) => <option key={effort} value={effort}>{effort}</option>)}
              </select>
            </label>
            <Meter label="Context" value={active.context} />
            <span className="stat">{active.minutes} min{active.tokens !== null ? ` · ${Math.round(active.tokens / 1000)}k tokens` : ""}</span>
            {snap.bypass && <span className="bypass-tag" title="Claude runs commands without asking. Change this in Preferences.">Bypass on</span>}
          </>
        ) : active ? (
          <span>Plain terminal. Jarvis and Claude can't see or touch it.</span>
        ) : null}
        {workingId && <button type="button" className="stop" onClick={() => window.claude.write(workingId, "\x1b")}>Stop</button>}
        <span className="plan">
          <Meter label="5-hour" value={snap.plan.fiveHour} hint={until(snap.plan.fiveHourResets)} />
          <Meter label="Weekly" value={snap.plan.week} warm hint={until(snap.plan.weekResets)} />
        </span>
      </footer>
    </section>
  );
}


