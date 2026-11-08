import gsap from "gsap";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";

import { ClaudeWorkspace, type Snapshot } from "./ClaudePanel";
import { Icon } from "./icons";
import { VoiceLine, type Mood } from "./Line";

type Pending = { command: string; level: "run" | "say-back" | "confirm"; options?: string[]; title?: string };
type Reply = { say: string; source: string; tool?: string; pending?: Pending; ms: number; tag?: number };
type Turn = { role: "user" | "jarvis"; text: string };
type Chat = { id: number; title: string; updated: number; turns: number };
type Fact = { id: number; text: string };
// A restored message is shown as it is, without the letters resolving again.
// A spoken message is live while the voice says it: each sentence appears as it's said, over
// exactly the time it takes to say. Then it settles into its full text.
type Part = { text: string; seconds: number };
type Message = {
  id: number; from: "jarvis" | "you"; text: string; restored?: boolean; viaClaude?: boolean; fromClaude?: boolean;
  tag?: number; live?: boolean; parts?: Part[]; final?: string; settled?: boolean;
};
type Reminder = { id: number; kind: string; text: string; due: number };
type VoiceEvent = {
  type: string;
  text?: string;
  reply?: Reply;
  on?: boolean;
  active?: boolean;
  message?: string;
  tag?: number;
  seconds?: number;
  stopped?: boolean;
};
type VoiceStatus = "off" | "loading" | "on" | "muted";
type ThemeMode = "dark" | "light";

declare global {
  interface Window {
    jarvis: {
      ask(said: string): Promise<Reply>;
      choose(index: number, label: string): Promise<Reply>;
      listChats(): Promise<{ chats: Chat[]; current: number | null }>;
      openChat(id: number): Promise<Turn[]>;
      newChat(): Promise<void>;
      deleteChat(id: number): Promise<void>;
      listFacts(): Promise<Fact[]>;
      deleteFact(id: number): Promise<void>;
      reminders(): Promise<Reminder[]>;
      deleteReminder(id: number): Promise<void>;
      listProjects(): Promise<string[]>;
      warmUp(): Promise<boolean>;
      welcome(text: string): Promise<number | undefined>;
      setTheme(mode: ThemeMode): Promise<void>;
      setMuted(muted: boolean): Promise<void>;
      voiceAvailable(): Promise<"off" | "loading" | "ready">;
      health(): Promise<string[]>;
      getAutostart(): Promise<boolean>;
      setAutostart(enabled: boolean): Promise<boolean>;
      minimize(): void;
      toggleMaximize(): void;
      close(): void;
      onEvent(listener: (event: VoiceEvent) => void): () => void;
    };
  }
}

const GLYPHS = "abcdefghjkmnprstuvxyz0123456789";
const calm = matchMedia("(prefers-reduced-motion: reduce)").matches;
let nextId = 1;

function savedMode(): ThemeMode {
  try {
    return localStorage.getItem("jarvis-mode") === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

const DAY = 86_400_000;
function dayOf(time: number): string {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  if (time >= start.getTime()) return "Today";
  if (time >= start.getTime() - DAY) return "Yesterday";
  return new Date(time).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}
const clock = (time: number) => new Date(time).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

const asMessages = (turns: Turn[]): Message[] => turns.map((turn) => ({ id: nextId++, from: turn.role === "user" ? "you" : "jarvis", text: turn.text, restored: true }));

// Jarvis's words resolve out of scrambled letters as he says them.
function Spoken({ text }: { text: string }) {
  const [shown, setShown] = useState(calm ? text : "");
  useEffect(() => {
    if (calm) return;
    const progress = { value: 0 };
    const tween = gsap.to(progress, {
      value: 1,
      duration: Math.min(1.4, 0.3 + text.length * 0.016),
      ease: "none",
      onUpdate() {
        const at = Math.floor(progress.value * text.length);
        let out = text.slice(0, at);
        for (let i = at; i < Math.min(text.length, at + 5); i++) {
          out += text[i] === " " ? " " : GLYPHS[Math.floor(Math.random() * GLYPHS.length)];
        }
        setShown(out);
      },
      onComplete() {
        setShown(text);
      },
    });
    return () => void tween.kill();
    // The message text never changes after it appears.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return <p aria-label={text}>{shown}</p>;
}

// Words that appear as the voice says them. Earlier sentences are whole; the one being said
// resolves across the length of its sound.
function Voiced({ parts }: { parts: Part[] }) {
  const [at, setAt] = useState(0);
  const latest = parts.at(-1);
  useEffect(() => {
    if (!latest) return;
    if (calm) return setAt(latest.text.length);
    setAt(0);
    const progress = { value: 0 };
    const tween = gsap.to(progress, {
      value: latest.text.length,
      duration: Math.max(0.2, latest.seconds * 0.92),
      ease: "none",
      onUpdate: () => setAt(Math.floor(progress.value)),
      onComplete: () => setAt(latest.text.length),
    });
    return () => void tween.kill();
  }, [parts.length, latest]);
  const before = parts.slice(0, -1).map((part) => part.text).join(" ");
  let now = latest ? latest.text.slice(0, at) : "";
  if (latest && at < latest.text.length) {
    for (let i = at; i < Math.min(latest.text.length, at + 4); i++) now += latest.text[i] === " " ? " " : GLYPHS[Math.floor(Math.random() * GLYPHS.length)];
  }
  const full = parts.map((part) => part.text).join(" ");
  return <p aria-label={full}>{before && `${before} `}{now}</p>;
}

// Jarvis waking up: what's starting, until everything he needs is ready.
type Step = "wait" | "ok" | "off" | "warn" | "fail";
const BOOT_STEPS = [
  ["model", "Language model"],
  ["voice", "Voice"],
  ["checks", "System checks"],
] as const;
const STEP_WORDS: Record<Step, string> = { wait: "starting", ok: "online", off: "not installed", warn: "needs attention", fail: "offline" };

function Boot({ steps, leaving }: { steps: Record<string, Step>; leaving: boolean }) {
  const done = Object.values(steps).filter((step) => step !== "wait").length;
  return (
    <div className={`boot${leaving ? " leaving" : ""}`} role="status" aria-label="Jarvis is starting">
      <div className="boot-mark">JARVIS</div>
      <div className="boot-bar"><span style={{ width: `${(100 * (done + 0.35)) / (BOOT_STEPS.length + 0.35)}%` }} /></div>
      <ul className="boot-steps">
        {BOOT_STEPS.map(([key, label]) => (
          <li key={key} data-step={steps[key]}>
            <span>{label}</span>
            <span>{STEP_WORDS[steps[key]]}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// A decision sits above the message box, so it can't scroll away while Claude waits on it.
function Decision({ pending, fromClaude, onChoose, onSay }: { pending: Pending; fromClaude: boolean; onChoose(index: number, label: string): void; onSay(text: string): void }) {
  const danger = pending.level === "confirm";
  const options = pending.options;
  return (
    <section className={`decision${danger ? " danger" : ""}`} aria-label="Your decision is needed">
      <div className="top">
        <Icon name={danger ? "shield" : fromClaude ? "claude" : "shield"} />
        <h3>{pending.title ?? (danger ? "This one is dangerous. Run it?" : fromClaude ? "Claude wants to run a command" : "Shall I run this?")}</h3>
      </div>
      {pending.command && <code>{pending.command}</code>}
      <div className="options">
        {options ? options.map((option, index) => (
          <button key={option} type="button" className={`opt${index === 0 ? " go" : ""}`} onClick={() => onChoose(index, option)}>
            {option}
          </button>
        )) : (
          <>
            <button type="button" className="opt go" onClick={() => onSay(danger ? "confirm" : "yes")}>{danger ? "Run it" : "Go ahead"}</button>
            <button type="button" className="opt" onClick={() => onSay("cancel")}>Cancel</button>
          </>
        )}
      </div>
    </section>
  );
}

// Past conversations, grouped by day. Deleting asks once, in place.
function Sidebar({ chats, current, onOpen, onNew, onDeleted }: { chats: Chat[]; current: number | null; onOpen(id: number): void; onNew(): void; onDeleted(): void }) {
  const [confirming, setConfirming] = useState<number | null>(null);
  const groups: [string, Chat[]][] = [];
  for (const chat of [...chats].sort((a, b) => b.updated - a.updated)) {
    const day = dayOf(chat.updated);
    const group = groups.find(([name]) => name === day);
    if (group) group[1].push(chat);
    else groups.push([day, [chat]]);
  }
  return (
    <aside className="rail" aria-label="Conversations">
      <div className="rail-head">
        <button type="button" className="btn wide" onClick={onNew}><Icon name="plus" />New conversation</button>
      </div>
      <div className="rail-scroll">
        {groups.length === 0 && <p className="empty-note">Your conversations will appear here.</p>}
        {groups.map(([day, list]) => (
          <div key={day}>
            <div className="label">{day}</div>
            <div className="group">
              {list.map((chat) => confirming === chat.id ? (
                <div key={chat.id} className="item confirm">
                  <span className="t">Delete for good?</span>
                  <button
                    type="button"
                    className="mini danger"
                    onClick={() => {
                      setConfirming(null);
                      window.jarvis.deleteChat(chat.id).then(onDeleted);
                    }}
                  >
                    Delete
                  </button>
                  <button type="button" className="mini" onClick={() => setConfirming(null)}>Keep</button>
                </div>
              ) : (
                <div key={chat.id} className="item" role="button" tabIndex={0} aria-current={chat.id === current} title={chat.title}
                  onClick={() => onOpen(chat.id)}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" && event.key !== " ") return;
                    event.preventDefault();
                    onOpen(chat.id);
                  }}
                >
                  <Icon name="chat" />
                  <span className="t">{chat.title}</span>
                  {day === "Today" && <span className="m">{clock(chat.updated)}</span>}
                  <button
                    type="button"
                    className="x"
                    aria-label={`Delete ${chat.title}`}
                    title="Delete"
                    onClick={(event) => {
                      event.stopPropagation();
                      setConfirming(chat.id);
                    }}
                  >
                    <Icon name="trash" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </aside>
  );
}

function Setting({ title, about, children }: { title: string; about: string; children: ReactNode }) {
  return (
    <div className="setting">
      <div>
        <b>{title}</b>
        <p>{about}</p>
      </div>
      {children}
    </div>
  );
}

function Settings({ mode, setMode, autostart, setAutostart, voice, setMuted, bypass, onClose }: {
  mode: ThemeMode;
  setMode(mode: ThemeMode): void;
  autostart: boolean;
  setAutostart(on: boolean): void;
  voice: VoiceStatus;
  setMuted(muted: boolean): void;
  bypass: boolean;
  onClose(): void;
}) {
  const [warning, setWarning] = useState(false);
  const [facts, setFacts] = useState<Fact[]>([]);
  useEffect(() => {
    window.jarvis.listFacts().then(setFacts);
  }, []);
  const micReady = voice === "on" || voice === "muted";
  return (
    <div className="scrim" onPointerDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label="Settings">
        <header>
          <h2>Settings</h2>
          <button type="button" className="tb-btn sq" aria-label="Close settings" onClick={onClose}><Icon name="close" /></button>
        </header>
        <section>
          <h3>Jarvis</h3>
          <Setting title="Appearance" about="Dark, or a warm champagne.">
            <div className="seg" role="group" aria-label="Appearance">
              {(["dark", "light"] as const).map((name) => (
                <button key={name} type="button" aria-pressed={mode === name} onClick={() => setMode(name)}>{name === "dark" ? "Dark" : "Champagne"}</button>
              ))}
            </div>
          </Setting>
          <Setting title="Start with your computer" about="Opens Jarvis when you log in.">
            <div className="seg" role="group" aria-label="Start with your computer">
              {[true, false].map((enabled) => (
                <button key={String(enabled)} type="button" aria-pressed={autostart === enabled} onClick={() => window.jarvis.setAutostart(enabled).then(setAutostart)}>{enabled ? "On" : "Off"}</button>
              ))}
            </div>
          </Setting>
          <Setting
            title="Microphone"
            about={voice === "on" ? 'Jarvis wakes when you say "Hey Jarvis".' : voice === "muted" ? "Muted. Jarvis only reads what you type." : voice === "loading" ? "The voice is still loading." : "The voice isn't running."}
          >
            <div className="seg" role="group" aria-label="Microphone">
              <button type="button" disabled={!micReady} aria-pressed={voice === "on"} onClick={() => setMuted(false)}>On</button>
              <button type="button" disabled={!micReady} aria-pressed={voice === "muted"} onClick={() => setMuted(true)}>Muted</button>
            </div>
          </Setting>
        </section>
        <section>
          <h3>Claude</h3>
          <Setting title="Permissions" about={bypass ? "Bypass is on. Claude runs commands without asking." : "Claude asks before it runs commands or changes files."}>
            <div className="seg" role="group" aria-label="Claude permissions">
              <button type="button" aria-pressed={!bypass} onClick={() => { setWarning(false); window.claude.setBypass(false); }}>Ask me</button>
              <button type="button" className="danger-on" aria-pressed={bypass} onClick={() => !bypass && setWarning(true)}>Bypass</button>
            </div>
          </Setting>
          {warning && (
            <div className="warning" role="alert">
              <b>Let Claude act without asking?</b>
              <p>
                Claude will run any command and change any file without checking with you. This computer has passwordless sudo, so
                a mistake, or a malicious instruction hidden in a web page or file Claude reads, could change or delete anything on
                it, with no prompt to stop it.
              </p>
              <div>
                <button type="button" className="btn danger" onClick={() => { setWarning(false); window.claude.setBypass(true); }}>Turn on bypass</button>
                <button type="button" className="btn" onClick={() => setWarning(false)}>Keep asking me</button>
              </div>
            </div>
          )}
        </section>
        <section>
          <h3>Memory</h3>
          <p className="about">What Jarvis has picked up about you, or was told to remember. It stays on this computer. Deleting removes it for good.</p>
          {facts.length === 0 && <p className="about">Nothing yet.</p>}
          <ul className="facts">
            {facts.map((fact) => (
              <li key={fact.id}>
                <span>{fact.text}</span>
                <button
                  type="button"
                  aria-label={`Forget: ${fact.text}`}
                  title="Forget this"
                  onClick={() => window.jarvis.deleteFact(fact.id).then(() => window.jarvis.listFacts()).then(setFacts)}
                >
                  <Icon name="trash" />
                </button>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}

// With no project open, the Claude button lists the folders in the projects folder.
function ProjectMenu({ onPick, onClose }: { onPick(name: string): void; onClose(): void }) {
  const [projects, setProjects] = useState<string[] | null>(null);
  useEffect(() => {
    window.jarvis.listProjects().then(setProjects, () => setProjects([]));
    const away = (event: PointerEvent) => {
      if (!(event.target as HTMLElement).closest(".pop, .open-claude")) onClose();
    };
    const esc = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("pointerdown", away);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("pointerdown", away);
      window.removeEventListener("keydown", esc);
    };
  }, [onClose]);
  return (
    <div className="pop project-pop" role="menu" aria-label="Open a project">
      <div className="pop-head">
        <b>Open a project</b>
        <span>Or say "let's start coding" and its name.</span>
      </div>
      <hr />
      <div className="pop-list">
        {projects === null && <p className="pop-note">Looking…</p>}
        {projects?.length === 0 && <p className="pop-note">No folders in ~/Documents/Projects yet.</p>}
        {projects?.map((name) => (
          <button key={name} type="button" role="menuitem" onClick={() => onPick(name)}>
            <Icon name="folder" />
            <span>{name}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

export function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(true);
  const [booting, setBooting] = useState(true);
  const [leaving, setLeaving] = useState(false);
  const [steps, setSteps] = useState<Record<string, Step>>({ model: "wait", voice: "wait", checks: "wait" });
  // Called once the voice is ready, or known not to be coming.
  const voiceUp = useRef<(ready: boolean) => void>(() => {});
  const [mood, setMood] = useState<Mood>("idle");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [claudeAsking, setClaudeAsking] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [chats, setChats] = useState<Chat[]>([]);
  const [currentChat, setCurrentChat] = useState<number | null>(null);
  const [mode, setMode] = useState(savedMode);
  const [pending, setPending] = useState<Pending | null>(null);
  const [voice, setVoice] = useState<VoiceStatus>("off");
  const voiceRef = useRef<VoiceStatus>("off");
  const [autostart, setAutostart] = useState(false);
  const [claude, setClaude] = useState<Snapshot | null>(null);
  const [workOpen, setWorkOpen] = useState(true);
  const [railOpen, setRailOpen] = useState(false);
  const [projectMenu, setProjectMenu] = useState(false);
  const claudeNow = useRef<Snapshot | null>(null);
  claudeNow.current = claude;
  const win = useRef<HTMLDivElement>(null);
  const log = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const stopSpeaking = useRef(0);

  // A layout effect, so the theme is in place before the line reads its colors.
  useLayoutEffect(() => {
    document.documentElement.dataset.mode = mode;
    window.jarvis.setTheme(mode);
    try {
      localStorage.setItem("jarvis-mode", mode);
    } catch {
      // The choice just won't be remembered.
    }
  }, [mode]);

  const scrollDown = useCallback(() => {
    if (log.current) log.current.scrollTop = log.current.scrollHeight;
  }, []);
  useLayoutEffect(scrollDown, [messages, pending, busy, scrollDown]);

  // The box grows with what's written, up to a limit, then scrolls.
  useLayoutEffect(() => {
    const box = input.current;
    if (!box) return;
    box.style.height = "auto";
    box.style.height = `${Math.min(box.scrollHeight, 160)}px`;
  }, [draft]);

  // A spoken message finished, or was cut off: it shows its full text from now on.
  const settle = useCallback((which: (message: Message) => boolean) => {
    setMessages((list) => list.map((message) => (message.live && which(message)
      ? { ...message, live: false, settled: true, text: message.final ?? (message.parts ?? []).map((part) => part.text).join(" ") }
      : message)));
  }, []);

  const speak = useCallback((text: string, withPending?: Pending, tool?: string, tag?: number) => {
    const fromClaude = tool === "claude";
    const viaClaude = tool === "claude_answer";
    if (tag === undefined) {
      setMessages((list) => [...list, { id: nextId++, from: "jarvis", text, viaClaude, fromClaude }]);
    } else {
      // Shown as the voice says it. An answer that streamed may already be partly on screen.
      setMessages((list) => list.some((message) => message.tag === tag)
        ? list.map((message) => (message.tag === tag ? { ...message, final: text, viaClaude, fromClaude, ...(message.live ? {} : { text }) } : message))
        : [...list, { id: nextId++, from: "jarvis", text: "", tag, live: true, parts: [], final: text, viaClaude, fromClaude }]);
      // If the voice never gets to it, the words still appear.
      window.setTimeout(() => settle((message) => message.tag === tag && !message.parts?.length), 6000);
    }
    setPending(withPending ?? null);
    setClaudeAsking(fromClaude && Boolean(withPending));
    // A question has to be seen, so it closes Settings if they're open.
    if (withPending) setSettingsOpen(false);
    // With a voice, the line follows the real sound. Without one, it estimates.
    if (tag !== undefined || voiceRef.current === "on" || voiceRef.current === "muted" || voiceRef.current === "loading") return;
    setMood("speaking");
    window.clearTimeout(stopSpeaking.current);
    stopSpeaking.current = window.setTimeout(
      () => setMood("idle"),
      calm ? 150 : Math.min(3400, 900 + text.length * 34),
    );
  }, [settle]);

  const updateVoice = useCallback((status: VoiceStatus) => {
    voiceRef.current = status;
    setVoice(status);
  }, []);

  useEffect(() => {
    window.jarvis.voiceAvailable().then((state) => {
      if (voiceRef.current !== "loading" || state === "loading") return;
      updateVoice(state === "ready" ? "on" : "off");
      voiceUp.current(state === "ready");
    });
    return window.jarvis.onEvent((event) => {
      switch (event.type) {
        case "ready":
          updateVoice("on");
          voiceUp.current(true);
          break;
        case "saying": {
          const tag = event.tag;
          if (tag === undefined || !event.text) break; // Untagged words, like "one moment", aren't shown.
          const part = { text: event.text, seconds: event.seconds ?? 1 };
          setMessages((list) => list.some((message) => message.tag === tag)
            ? list.map((message) => (message.tag === tag && message.live ? { ...message, parts: [...(message.parts ?? []), part] } : message))
            : [...list, { id: nextId++, from: "jarvis", text: "", tag, live: true, parts: [part], viaClaude: true }]);
          break;
        }
        case "mic":
          if (voiceRef.current !== "loading") updateVoice(event.on ? "on" : "muted");
          break;
        case "gone":
          updateVoice("off");
          setMood("idle");
          voiceUp.current(false);
          settle(() => true);
          break;
        case "voice-restarting":
          updateVoice("loading");
          break;
        case "wake":
          setMood("listening");
          break;
        case "heard":
          if (event.text) {
            setBusy(true);
            setPending(null);
            setMood("thinking");
            setMessages((list) => [...list, { id: nextId++, from: "you", text: event.text! }]);
          } else {
            setMood("idle");
          }
          break;
        case "stopped":
          setBusy(false);
          setMood("idle");
          break;
        case "reply":
          speak(event.reply!.say, event.reply!.pending, event.reply!.tool, event.reply!.tag);
          setBusy(false);
          break;
        case "chat-reset":
          setMessages([]);
          setPending(null);
          setSettingsOpen(false);
          break;
        case "speaking":
          setMood(event.active ? "speaking" : "idle");
          if (event.stopped) settle(() => true);
          else if (!event.active && event.tag !== undefined) settle((message) => message.tag === event.tag);
          break;
        case "show-claude":
          setWorkOpen(true);
          break;
        case "hide-claude":
          setWorkOpen(false);
          break;
        case "settled":
          setPending(null);
          break;
      }
    });
  }, [speak, settle, updateVoice]);

  useEffect(() => {
    window.jarvis.getAutostart().then(setAutostart);
    window.claude.snapshot().then(setClaude);
    return window.claude.onChange(setClaude);
  }, []);

  // A newly opened project always shows Claude.
  const openProject = claude?.project ?? null;
  useEffect(() => {
    if (openProject) {
      setWorkOpen(true);
      setProjectMenu(false);
    }
    setChoosing(false);
  }, [openProject]);

  // Esc leaves the session view, instead of stopping Claude behind it.
  useEffect(() => {
    if (!choosing || pending) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setChoosing(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [choosing, pending]);

  const refreshChats = useCallback(() => {
    window.jarvis.listChats().then((list) => {
      setChats(list.chats);
      setCurrentChat(list.current);
    });
  }, []);
  useEffect(refreshChats, [refreshChats, messages.length]);

  useEffect(() => {
    let alive = true;
    const started = Date.now();
    const mark = (key: string, step: Step) => setSteps((now) => ({ ...now, [key]: step }));
    const model = window.jarvis.warmUp().then((ready) => (mark("model", ready ? "ok" : "fail"), ready));
    const checks = window.jarvis.health().then((problems) => {
      mark("checks", problems.filter((problem) => !problem.startsWith("Ollama")).length ? "warn" : "ok");
      return problems;
    });
    // The voice takes longest to load. Past a minute, Jarvis starts without it and it joins later.
    const voiceReady = new Promise<boolean>((resolve) => {
      voiceUp.current = resolve;
      window.setTimeout(() => resolve(false), 60_000);
    }).then((ready) => (mark("voice", ready ? "ok" : voiceRef.current === "off" ? "off" : "fail"), ready));
    Promise.all([model, checks, voiceReady]).then(async ([ready, problems]) => {
      if (!alive) return;
      await new Promise((done) => window.setTimeout(done, Math.max(400, 1600 - (Date.now() - started))));
      setLeaving(true);
      await new Promise((done) => window.setTimeout(done, calm ? 0 : 650));
      setBooting(false);
      const welcome = ready ? "Welcome back, sir. All systems online." : "Welcome back, sir. Ollama isn't running, so I can only do simple commands.";
      speak(welcome, undefined, undefined, await window.jarvis.welcome(welcome));
      // Only speaks up when something's actually wrong. "Ollama isn't running" is already said.
      const rest = problems.filter((problem) => !problem.startsWith("Ollama"));
      if (rest.length) window.setTimeout(() => speak(`One thing to know, sir: ${rest.join("; ")}.`), 3500);
      setBusy(false);
      input.current?.focus();
    });
    return () => {
      alive = false;
    };
  }, [speak]);

  const send = useCallback(
    async (text: string) => {
      const said = text.trim();
      if (!said || busy) return;
      setBusy(true);
      setPending(null);
      setSettingsOpen(false);
      setMood("thinking");
      setMessages((list) => [...list, { id: nextId++, from: "you", text: said }]);
      try {
        const reply = await window.jarvis.ask(said);
        speak(reply.say, reply.pending, reply.tool, reply.tag);
        if (voiceRef.current !== "on" && voiceRef.current !== "muted") setMood("idle");
      } catch {
        speak("Something went wrong on my side, sir. Please try again.");
      }
      setBusy(false);
      input.current?.focus();
    },
    [busy, speak],
  );

  const choose = useCallback(
    async (index: number, label: string) => {
      setPending(null);
      setMessages((list) => [...list, { id: nextId++, from: "you", text: label }]);
      const reply = await window.jarvis.choose(index, label);
      speak(reply.say, reply.pending, undefined, reply.tag);
      input.current?.focus();
    },
    [speak],
  );

  // A number picks a choice and Esc cancels, unless he's in the middle of writing something.
  useEffect(() => {
    if (!pending) return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest?.(".terminal-host, .term-box")) return;
      if (event.key === "Escape") {
        event.preventDefault();
        send("cancel");
        return;
      }
      if (draft || event.ctrlKey || event.altKey || event.metaKey || !/^[1-9]$/.test(event.key)) return;
      const index = Number(event.key) - 1;
      event.preventDefault();
      if (pending.options) {
        if (pending.options[index]) choose(index, pending.options[index]);
      } else if (index === 0) {
        send(pending.level === "confirm" ? "confirm" : "yes");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pending, draft, send, choose]);

  const openChat = useCallback((id: number) => {
    window.jarvis.openChat(id).then((turns) => {
      setMessages(asMessages(turns));
      setPending(null);
      setRailOpen(false);
      refreshChats();
      input.current?.focus();
    });
  }, [refreshChats]);

  const newChat = useCallback(() => {
    window.jarvis.newChat().then(() => {
      setMessages([]);
      setPending(null);
      setRailOpen(false);
      refreshChats();
      input.current?.focus();
    });
  }, [refreshChats]);

  const setMuted = useCallback((muted: boolean) => {
    updateVoice(muted ? "muted" : "on");
    window.jarvis.setMuted(muted);
  }, [updateVoice]);

  // Ctrl+N, Ctrl+J and Ctrl+, work without being shown anywhere.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === "n" && !event.shiftKey) {
        event.preventDefault();
        newChat();
      } else if (key === "j" && claudeNow.current?.project) {
        event.preventDefault();
        setWorkOpen((open) => !open);
      } else if (key === ",") {
        event.preventDefault();
        setSettingsOpen((open) => !open);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [newChat]);

  // Drag the edge to size Claude's side.
  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const handle = event.currentTarget;
    const frame = win.current;
    if (!frame) return;
    handle.setPointerCapture(event.pointerId);
    handle.classList.add("drag");
    const rail = frame.querySelector<HTMLElement>(".rail")?.offsetWidth ?? 0;
    const move = (moved: PointerEvent) => {
      const box = frame.getBoundingClientRect();
      const width = Math.max(340, Math.min(box.width - rail - 380, box.right - moved.clientX));
      frame.style.setProperty("--work-w", `${width}px`);
    };
    const up = () => {
      handle.classList.remove("drag");
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
  };

  const submit = () => {
    if (busy || !draft.trim()) return;
    const value = draft;
    setDraft("");
    setMood((now) => (now === "listening" ? "idle" : now));
    send(value);
  };

  const chatTitle = chats.find((chat) => chat.id === currentChat)?.title ?? (messages.some((message) => message.from === "you") ? "Conversation" : "New conversation");
  const showWork = Boolean(openProject && claude && workOpen);
  const askingId = pending && claudeAsking && claude ? (claude.sessions.find((session) => session.working)?.id ?? claude.active) : null;
  const hints = openProject
    ? ["What's Claude doing?", "Did the tests pass?", "How much Claude do I have left?", "Close the project"]
    : ["What's the weather in Tunis?", "Set a timer for 10 minutes", "Let's start coding"];
  const showHints = !booting && !pending && !busy && messages.filter((message) => message.from === "you").length === 0;
  const lastJarvis = messages.map((message) => message.from).lastIndexOf("jarvis");

  return (
    <div className="win" ref={win} data-work={showWork ? "on" : "off"} data-rail={railOpen ? "open" : "closed"}>
      <header className="titlebar">
        <button type="button" className="tb-btn menu-btn" aria-label="Conversations" title="Conversations" onClick={() => setRailOpen((open) => !open)}><Icon name="menu" /></button>
        <div className="mark"><i />JARVIS</div>
        <div className="grow" />
        <div className="tb-anchor">
          <button
            type="button"
            className="tb-btn open-claude"
            aria-pressed={showWork}
            aria-label={openProject ? (workOpen ? "Hide Claude" : "Show Claude") : "Open a project"}
            title={openProject ? (workOpen ? "Hide Claude" : "Show Claude") : "Open a project"}
            onClick={() => (openProject ? setWorkOpen((open) => !open) : setProjectMenu((open) => !open))}
          >
            <Icon name="claude" />
          </button>
          {projectMenu && !openProject && (
            <ProjectMenu
              onClose={() => setProjectMenu(false)}
              onPick={(name) => {
                setProjectMenu(false);
                send(`Let's start coding ${name}`);
              }}
            />
          )}
        </div>
        <button type="button" className="tb-btn" aria-label="Settings" title="Settings" aria-pressed={settingsOpen} onClick={() => setSettingsOpen((open) => !open)}><Icon name="gear" /></button>
        <button type="button" className="tb-btn" aria-label="Minimize" title="Minimize" onClick={() => window.jarvis.minimize()}><Icon name="min" /></button>
        <button type="button" className="tb-btn" aria-label="Maximize" title="Maximize" onClick={() => window.jarvis.toggleMaximize()}><Icon name="max" /></button>
        <button type="button" className="tb-btn quit" aria-label="Close" title="Close" onClick={() => window.jarvis.close()}><Icon name="close" /></button>
      </header>

      <Sidebar chats={chats} current={currentChat} onOpen={openChat} onNew={newChat} onDeleted={refreshChats} />

      <main className="chat" aria-label="Conversation with Jarvis" onPointerDown={() => railOpen && setRailOpen(false)}>
        <div className="chat-head"><div className="col"><h1>{chatTitle}</h1></div></div>
        <div className="log" ref={log}>
          <div className="col" role="log" aria-live="polite">
            {messages.map((message, index) => (
              <div key={message.id} className={`msg ${message.from}`}>
                {message.from === "jarvis" && (message.viaClaude || message.fromClaude) && !(message.live && !message.parts?.length) && (
                  <span className="who" title={message.viaClaude ? "Jarvis asked Claude" : "From Claude"}><Icon name="claude" /></span>
                )}
                {message.live ? (
                  <Voiced parts={message.parts ?? []} />
                ) : message.from === "jarvis" && !message.restored && !message.settled && index === lastJarvis ? (
                  <Spoken text={message.text} />
                ) : (
                  <p>{message.text}</p>
                )}
              </div>
            ))}
            {busy && !booting && <span className="sr-only" role="status">Jarvis is thinking</span>}
          </div>
        </div>
        {pending && !settingsOpen && (
          <div className="col decision-slot">
            <Decision pending={pending} fromClaude={claudeAsking} onChoose={choose} onSay={send} />
          </div>
        )}
        {showHints && (
          <div className="col hints">
            {hints.map((hint) => (
              <button key={hint} type="button" className="chip" onClick={() => send(hint)}>{hint}</button>
            ))}
          </div>
        )}
        <div className="band">
          <VoiceLine mood={mood} asking={Boolean(pending)} mode={mode} />
          <form
            className="box col"
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
          >
            <button
              className="round mic"
              type="button"
              disabled={voice === "off" || voice === "loading"}
              aria-pressed={voice === "muted"}
              aria-label={voice === "muted" ? "Turn microphone on" : "Mute microphone"}
              title={voice === "muted" ? "Microphone is off. Click to turn it on." : voice === "on" ? "Microphone is on. Click to mute." : "The voice isn't ready."}
              onClick={() => setMuted(voice !== "muted")}
            >
              <Icon name={voice === "muted" ? "micOff" : "mic"} />
            </button>
            <textarea
              ref={input}
              rows={1}
              value={draft}
              autoComplete="off"
              placeholder={voice === "on" ? 'Say "Hey Jarvis" or type' : voice === "loading" ? "Voice is loading. You can type" : voice === "muted" ? "Microphone off. Type to Jarvis" : "Type to Jarvis"}
              aria-label="Message to Jarvis"
              onChange={(event) => {
                setDraft(event.target.value);
                setMood((now) => (now === "idle" || now === "listening" ? (event.target.value ? "listening" : "idle") : now));
              }}
              onKeyDown={(event) => {
                // Enter sends and Shift+Enter starts a new line. Enter also has to wait while
                // an accent or other composed character is being typed.
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  submit();
                }
              }}
            />
            <button className="round send" type="submit" disabled={busy || !draft.trim()} aria-label="Send" title="Send">
              <Icon name="up" />
            </button>
          </form>
        </div>
      </main>

      {openProject && claude && (
        <section className="work" aria-label="Claude" hidden={!showWork}>
          <div className="resizer" aria-hidden="true" onPointerDown={startResize} />
          <ClaudeWorkspace
            snap={claude}
            mode={mode}
            askingId={askingId}
            choosing={choosing}
            setChoosing={setChoosing}
            onHide={() => setWorkOpen(false)}
          />
        </section>
      )}

      {settingsOpen && (
        <Settings
          mode={mode}
          setMode={setMode}
          autostart={autostart}
          setAutostart={setAutostart}
          voice={voice}
          setMuted={setMuted}
          bypass={Boolean(claude?.bypass)}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      {booting && <Boot steps={steps} leaving={leaving} />}
    </div>
  );
}
