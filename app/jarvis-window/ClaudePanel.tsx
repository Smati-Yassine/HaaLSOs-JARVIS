// Claude's side of the line: real terminals and the status bar below it, and the strands that
// stand in for the session list on it.
import "@xterm/xterm/css/xterm.css";

import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef, useState } from "react";

import type { LineEngine, StrandItem } from "./Line";

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
  fit.fit();
  window.claude.resize(id, term.cols, term.rows);
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

// What you see when no session is open, and whenever you press + on the line.
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
          <button type="button" className="primary" onClick={() => pick(() => window.claude.newSession())}>New Claude session</button>
          <button type="button" onClick={() => pick(() => window.claude.newTerminal())}>New terminal</button>
        </div>
        {sessions.length > 0 && <h2>Sessions</h2>}
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
              <button type="button" className="session-x" aria-label={`Archive ${session.title}`} title="Archive" onClick={() => window.claude.archive(session.id)}>×</button>
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

export function ClaudePanel({ snap, mode, asking, choosing, onChosen }: { snap: Snapshot; mode: "dark" | "light"; asking: boolean; choosing: boolean; onChosen(): void }) {
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

  // The room changes on every frame while the line moves, so only refit once it has settled.
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

  return (
    <section className="claude-panel" aria-label="Claude">
      <div className="terminals" ref={area}>
        {(choosing || active?.state !== "running") && <SessionView snap={snap} onDone={onChosen} />}
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

// How many strands fit beside the message box. The rest wait in the + menu.
function useRoom() {
  const [width, setWidth] = useState(innerWidth);
  useEffect(() => {
    const onResize = () => setWidth(innerWidth);
    addEventListener("resize", onResize);
    return () => removeEventListener("resize", onResize);
  }, []);
  if (width < 760) return { claudes: Math.max(1, Math.floor((width * 0.62) / 120)), shells: 1 };
  const side = (width - Math.min(600, width * 0.44)) / 2;
  return { claudes: Math.max(1, Math.floor((side - 32) / 120)), shells: Math.max(1, Math.floor((side - 114) / 90)) };
}

function fitted(list: Session[], max: number, active: string | null) {
  if (list.length <= max) return list;
  const shown = list.slice(0, max);
  const current = list.find((session) => session.id === active);
  if (current && !shown.includes(current)) shown[max - 1] = current;
  return shown;
}

export function ClaudeBand({ snap, engine, asking, choosing, onToggleChoosing }: { snap: Snapshot; engine: LineEngine; asking: boolean; choosing: boolean; onToggleChoosing(): void }) {
  const [moved, setMoved] = useState(engine.moved);
  const [lowered, setLowered] = useState(engine.snap === "low");
  const room = useRoom();

  useEffect(() => {
    engine.onMoved = () => setMoved(true);
    engine.onSnap = (name) => setLowered(name === "low");
    setLowered(engine.snap === "low");
    return () => {
      engine.onMoved = null;
      engine.onSnap = null;
    };
  }, [engine]);

  const open = snap.sessions.filter((session) => session.state === "running");
  const claudes = fitted(open.filter((session) => session.kind === "claude"), room.claudes, snap.active);
  const shells = fitted(open.filter((session) => session.kind === "shell"), room.shells, snap.active);
  const onLine = [...claudes, ...shells];

  // Claude's question belongs to the session that's busy, or else the one in front of you.
  const askingId = asking ? (snap.sessions.find((session) => session.working)?.id ?? snap.active) : null;
  const signature = onLine.map((session) => `${session.id}:${session.id === snap.active}:${session.working}:${session.id === askingId}`).join();
  useEffect(() => {
    const items: StrandItem[] = onLine.map((session) => ({
      id: session.id,
      kind: session.kind,
      active: session.id === snap.active,
      working: session.working,
      asking: session.id === askingId,
      frac: 1,
    }));
    engine.sync("sessions", items);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, signature]);
  useEffect(() => () => engine.sync("sessions", []), [engine]);

  return (
    <div className="band">
      {onLine.map((session) => (
        <div
          key={session.id}
          ref={(element) => engine.label(session.id, element)}
          className={`label ${session.kind}${session.id === snap.active ? " on" : ""}${session.id === askingId ? " asking" : ""}`}
        >
          <button type="button" className="label-main" title={session.title} onClick={() => window.claude.select(session.id)}>{session.title}</button>
          {session.context !== null && <span className="pct">{percent(session.context)}</span>}
          <button type="button" className="label-x" aria-label={`${session.kind === "claude" ? "Archive" : "Close"} ${session.title}`} onClick={() => window.claude.archive(session.id)}>×</button>
        </div>
      ))}
      <div className="where"><b>{snap.project}</b>{moved ? snap.path : "drag the line to make room"}</div>
      <div className="band-tools">
        <button type="button" aria-label="Sessions and terminals" title="Sessions and terminals" aria-pressed={choosing} onClick={onToggleChoosing}>
          <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M6 1.5v9M1.5 6h9" stroke="currentColor" strokeWidth="1.3" /></svg>
        </button>
        <button
          type="button"
          aria-label={lowered ? "Bring Claude back" : "Minimize Claude"}
          title={lowered ? "Bring Claude back" : "Minimize Claude"}
          onClick={() => engine.setSnap(lowered ? "mid" : "low")}
        >
          <svg viewBox="0 0 12 12" aria-hidden="true">{lowered ? <rect x="1.5" y="1.5" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="1.3" /> : <path d="M1 6h10" stroke="currentColor" strokeWidth="1.3" />}</svg>
        </button>
        <button type="button" className="quit" aria-label="Close project" title="Close project" onClick={() => window.claude.closeProject()}>
          <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.3" /></svg>
        </button>
      </div>
    </div>
  );
}
