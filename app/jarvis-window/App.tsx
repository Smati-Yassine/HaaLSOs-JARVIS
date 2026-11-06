import gsap from "gsap";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { ClaudeBand, ClaudePanel, type Snapshot } from "./ClaudePanel";
import { Line, LineEngine, type Mood, type StrandItem } from "./Line";

type Pending = { command: string; level: "run" | "say-back" | "confirm"; options?: string[]; title?: string };
type Reply = { say: string; source: string; tool?: string; pending?: Pending; ms: number };
type Turn = { role: "user" | "jarvis"; text: string };
type Chat = { id: number; title: string; updated: number; turns: number };
type Fact = { id: number; text: string };
// A restored message is shown as it is, without the letters resolving again.
type Message = { id: number; from: "jarvis" | "you"; text: string; restored?: boolean; viaClaude?: boolean; fromClaude?: boolean };
type Reminder = { id: number; kind: string; text: string; due: number };
type VoiceEvent = {
  type: string;
  text?: string;
  reply?: Reply;
  on?: boolean;
  active?: boolean;
  message?: string;
};
type VoiceStatus = "off" | "loading" | "on" | "muted";

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
      warmUp(): Promise<boolean>;
      welcome(text: string): Promise<void>;
      setTheme(mode: "dark" | "light"): Promise<void>;
      setMuted(muted: boolean): Promise<void>;
      voiceAvailable(): Promise<boolean>;
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

const HINTS = ["What time is it?", "Tell me a joke", "Google the weather in Tunis"];
const GLYPHS = "abcdefghjkmnprstuvxyz0123456789";
const calm = matchMedia("(prefers-reduced-motion: reduce)").matches;
let nextId = 1;

function savedMode(): "dark" | "light" {
  try {
    return localStorage.getItem("jarvis-mode") === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

function whenWas(time: number): string {
  const minutes = Math.round((Date.now() - time) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 1440) return `${Math.round(minutes / 60)} h ago`;
  if (minutes < 2880) return "yesterday";
  return new Date(time).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

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

// A decision sits above the message box, so it can't scroll away while Claude waits on it.
function Decision({ pending, onChoose, onSay }: { pending: Pending; onChoose(index: number, label: string): void; onSay(text: string): void }) {
  const danger = pending.level === "confirm";
  const options = pending.options;
  return (
    <section className={`decision ${danger ? "danger" : ""}`} aria-label="Your decision is needed">
      <h3>{pending.title ?? (danger ? "This one is dangerous. Run it?" : "Shall I run this?")}</h3>
      {pending.command && <code>{pending.command}</code>}
      <div className="decision-options">
        {options ? options.map((option, index) => (
          <button
            key={option}
            type="button"
            className={danger && /^yes\b/i.test(option) ? "alarm" : ""}
            onClick={() => onChoose(index, option)}
          >
            <kbd>{index + 1}</kbd>
            <span>{option}</span>
          </button>
        )) : (
          <button type="button" className={danger ? "alarm" : ""} onClick={() => onSay(danger ? "confirm" : "yes")}>
            <kbd>1</kbd>
            <span>{danger ? "Confirm" : "Go ahead"}</span>
          </button>
        )}
      </div>
      <button type="button" className="decision-cancel" onClick={() => onSay("cancel")}><kbd>Esc</kbd> Cancel</button>
    </section>
  );
}

// Earlier conversations sit above the current one. Scrolling up is how you get back to them.
function Earlier({ chats, onOpen, onDeleted }: { chats: Chat[]; onOpen(id: number): void; onDeleted(): void }) {
  const [confirming, setConfirming] = useState<number | null>(null);
  if (chats.length === 0) return null;
  return (
    <ul className="earlier-list">
      {chats.map((chat) => (
        <li key={chat.id}>
          {confirming === chat.id ? (
            <div className="chat-confirm">
              <span>Delete this for good?</span>
              <button
                type="button"
                className="alarm"
                onClick={() => {
                  setConfirming(null);
                  window.jarvis.deleteChat(chat.id).then(onDeleted);
                }}
              >
                Delete
              </button>
              <button type="button" onClick={() => setConfirming(null)}>Keep</button>
            </div>
          ) : (
            <>
              <button type="button" className="chat-open" onClick={() => onOpen(chat.id)}>
                <span className="chat-title">{chat.title}</span>
                <span className="chat-meta">{whenWas(chat.updated)} · {chat.turns} {chat.turns === 1 ? "line" : "lines"}</span>
              </button>
              <button type="button" className="row-delete" aria-label={`Delete ${chat.title}`} title="Delete" onClick={() => setConfirming(chat.id)}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" /></svg>
              </button>
            </>
          )}
        </li>
      ))}
    </ul>
  );
}

// Timers and reminders peel off the top of the line and shrink as their time runs out.
function reminderLabel(item: Reminder, now: number): string {
  const left = Math.max(0, Math.ceil((item.due - now) / 1000));
  if (left >= 86400) return new Date(item.due).toLocaleDateString("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit" });
  if (left >= 3600) return item.kind === "timer" ? `${Math.floor(left / 3600)}:${String(Math.floor(left / 60) % 60).padStart(2, "0")}:${String(left % 60).padStart(2, "0")}` : new Date(item.due).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
}
function reminderTitle(item: Reminder): string {
  if (item.kind === "timer") return `${item.text} timer`;
  if (item.kind === "alarm") return "Alarm";
  return item.text || "Reminder";
}

function Timers({ engine }: { engine: LineEngine }) {
  const [items, setItems] = useState<Reminder[]>([]);
  const [now, setNow] = useState(Date.now());
  const firstSeen = useRef(new Map<number, number>());
  useEffect(() => {
    let alive = true;
    const tick = () => {
      setNow(Date.now());
      window.jarvis.reminders().then((list) => alive && setItems(list.slice(0, 4)));
    };
    tick();
    const interval = window.setInterval(tick, 1000);
    return () => {
      alive = false;
      window.clearInterval(interval);
    };
  }, []);
  useEffect(() => {
    const strands: StrandItem[] = items.map((item) => {
      if (!firstSeen.current.has(item.id)) firstSeen.current.set(item.id, now);
      const start = firstSeen.current.get(item.id)!;
      const frac = item.due > start ? (item.due - now) / (item.due - start) : 0;
      return { id: `reminder-${item.id}`, kind: "timer", title: reminderTitle(item), active: false, working: false, asking: false, frac };
    });
    engine.sync("timers", strands);
  }, [engine, items, now]);
  return (
    <div className="band">
      {items.map((item) => (
        <div
          key={item.id}
          ref={(element) => engine.label(`reminder-${item.id}`, element)}
          className="label timer"
          title={reminderTitle(item)}
          onPointerEnter={() => (engine.hovered = `reminder-${item.id}`)}
          onPointerLeave={() => (engine.hovered = null)}
        >
          <span className="label-main">{reminderLabel(item, now)}</span>
          <button type="button" className="label-x" aria-label={`Cancel: ${reminderTitle(item)}`} onClick={() => window.jarvis.deleteReminder(item.id).then(() => setItems((list) => list.filter((other) => other.id !== item.id)))}>×</button>
        </div>
      ))}
    </div>
  );
}

function Setting({ title, about, children }: { title: string; about: string; children: ReactNode }) {
  return (
    <div className="setting">
      <div>
        <h3>{title}</h3>
        <p>{about}</p>
      </div>
      {children}
    </div>
  );
}

function Preferences({ open, mode, setMode, autostart, setAutostart, bypass }: {
  open: boolean;
  mode: "dark" | "light";
  setMode(mode: "dark" | "light"): void;
  autostart: boolean;
  setAutostart(on: boolean): void;
  bypass: boolean;
}) {
  const [warning, setWarning] = useState(false);
  const [facts, setFacts] = useState<Fact[]>([]);
  useEffect(() => {
    if (open) window.jarvis.listFacts().then(setFacts);
    setWarning(false);
  }, [open]);
  return (
    <div className="preferences" hidden={!open}>
      <div className="col">
      <h2>Jarvis</h2>
      <Setting title="Appearance" about="Dark, or a warm champagne.">
        <div className="segments" role="group" aria-label="Appearance">
          {(["dark", "light"] as const).map((name) => (
            <button key={name} type="button" aria-pressed={mode === name} onClick={() => setMode(name)}>{name === "dark" ? "Dark" : "Light"}</button>
          ))}
        </div>
      </Setting>
      <Setting title="Start with your computer" about="Opens Jarvis when you log in.">
        <div className="segments" role="group" aria-label="Start with your computer">
          {[true, false].map((enabled) => (
            <button key={String(enabled)} type="button" aria-pressed={autostart === enabled} onClick={() => window.jarvis.setAutostart(enabled).then(setAutostart)}>{enabled ? "On" : "Off"}</button>
          ))}
        </div>
      </Setting>

      <h2>Claude</h2>
      <Setting title="Permissions" about={bypass ? "Bypass is on. Claude runs commands without asking." : "Claude asks before running commands or changing files."}>
        <div className="segments" role="group" aria-label="Claude permissions">
          <button type="button" aria-pressed={!bypass} onClick={() => { setWarning(false); window.claude.setBypass(false); }}>Ask me</button>
          <button type="button" className={bypass ? "danger-on" : ""} aria-pressed={bypass} onClick={() => !bypass && setWarning(true)}>Bypass</button>
        </div>
      </Setting>
      {warning && (
        <div className="warning" role="alert">
          <h3>Let Claude act without asking?</h3>
          <p>
            Claude will run any command and change any file without checking with you. This computer has passwordless sudo, so
            a mistake, or a malicious instruction hidden in a web page or file Claude reads, could change or delete anything on
            it, with no prompt to stop it.
          </p>
          <div>
            <button type="button" className="alarm" onClick={() => { setWarning(false); window.claude.setBypass(true); }}>Turn on bypass</button>
            <button type="button" onClick={() => setWarning(false)}>Keep asking me</button>
          </div>
        </div>
      )}

      <h2>Memory</h2>
      <p className="pref-about">What Jarvis has picked up about you, or was told to remember. It stays on this computer. Deleting removes it for good.</p>
      {facts.length === 0 && <p className="pref-about">Nothing yet.</p>}
      <ul className="facts">
        {facts.map((fact) => (
          <li key={fact.id}>
            <span>{fact.text}</span>
            <button
              type="button"
              className="row-delete"
              aria-label={`Forget: ${fact.text}`}
              title="Forget this"
              onClick={() => window.jarvis.deleteFact(fact.id).then(() => window.jarvis.listFacts()).then(setFacts)}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" /></svg>
            </button>
          </li>
        ))}
      </ul>
      </div>
    </div>
  );
}

export function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(true);
  const [mood, setMood] = useState<Mood>("idle");
  const [pulse, setPulse] = useState(0);
  const [prefsOpen, setPrefsOpen] = useState(false);
  const [claudeAsking, setClaudeAsking] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [chats, setChats] = useState<Chat[]>([]);
  const [scrolledBack, setScrolledBack] = useState(false);
  const [engine] = useState(() => new LineEngine());
  const [mode, setMode] = useState(savedMode);
  const [pending, setPending] = useState<Pending | null>(null);
  const [voice, setVoice] = useState<VoiceStatus>("off");
  const voiceRef = useRef<VoiceStatus>("off");
  const [autostart, setAutostart] = useState(false);
  const [claude, setClaude] = useState<Snapshot | null>(null);
  const claudeNow = useRef<Snapshot | null>(null);
  claudeNow.current = claude;
  const current = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLFormElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const stopSpeaking = useRef(0);

  useEffect(() => {
    document.documentElement.dataset.mode = mode;
    window.jarvis.setTheme(mode);
    engine.readTokens();
    try {
      localStorage.setItem("jarvis-mode", mode);
    } catch {
      // The choice just won't be remembered.
    }
  }, [engine, mode]);

  // The conversation is pinned to the line, so 0 is now and negative is back in time.
  const scrollDown = useCallback(() => {
    if (scroller.current) scroller.current.scrollTop = 0;
  }, []);
  useLayoutEffect(scrollDown, [messages, prefsOpen, pending, busy, scrollDown]);

  useEffect(() => engine.watchBox(box.current!), [engine]);
  const watchDecision = useRef<() => void>(() => {});
  const decisionSlot = useCallback((element: HTMLDivElement | null) => {
    watchDecision.current();
    watchDecision.current = engine.watchDecision(element);
  }, [engine]);
  useEffect(() => {
    engine.prefs = prefsOpen;
  }, [engine, prefsOpen]);

  // The box grows with what's written, up to a limit, then scrolls.
  useLayoutEffect(() => {
    const box = input.current;
    if (!box) return;
    box.style.height = "auto";
    box.style.height = `${Math.min(box.scrollHeight, 200)}px`;
  }, [draft, prefsOpen]);

  const speak = useCallback((text: string, withPending?: Pending, tool?: string) => {
    const fromClaude = tool === "claude";
    setMessages((list) => [...list, { id: nextId++, from: "jarvis", text, viaClaude: tool === "claude_answer", fromClaude }]);
    setPending(withPending ?? null);
    setClaudeAsking(fromClaude && Boolean(withPending));
    // A question has to be seen, so it closes Preferences if they're open.
    if (withPending) setPrefsOpen(false);
    const sessions = claudeNow.current?.sessions ?? [];
    const busyId = sessions.find((session) => session.working)?.id ?? claudeNow.current?.active ?? undefined;
    if (tool === "ask_claude") engine.packet(busyId, true);
    if (fromClaude) engine.packet(busyId, false);
    // With a voice, the line follows the real sound. Without one, it estimates.
    if (voiceRef.current === "on" || voiceRef.current === "muted" || voiceRef.current === "loading") return;
    setMood("speaking");
    window.clearTimeout(stopSpeaking.current);
    stopSpeaking.current = window.setTimeout(
      () => setMood("idle"),
      calm ? 150 : Math.min(3400, 900 + text.length * 34),
    );
  }, [engine]);

  const updateVoice = useCallback((status: VoiceStatus) => {
    voiceRef.current = status;
    setVoice(status);
  }, []);

  useEffect(() => {
    window.jarvis.voiceAvailable().then((available) => updateVoice(available ? "loading" : "off"));
    return window.jarvis.onEvent((event) => {
      switch (event.type) {
        case "ready":
          updateVoice("on");
          break;
        case "mic":
          if (voiceRef.current !== "loading") updateVoice(event.on ? "on" : "muted");
          break;
        case "gone":
          updateVoice("off");
          setMood("idle");
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
          speak(event.reply!.say, event.reply!.pending, event.reply!.tool);
          setBusy(false);
          break;
        case "chat-reset":
          setMessages([]);
          setPending(null);
          setPrefsOpen(false);
          break;
        case "speaking":
          setMood(event.active ? "speaking" : "idle");
          break;
        case "show-claude":
          if (engine.snap === "low") engine.setSnap("mid");
          break;
        case "hide-claude":
          engine.setSnap("low");
          break;
        case "settled":
          setPending(null);
          break;
      }
    });
  }, [engine, speak, updateVoice]);

  useEffect(() => {
    window.jarvis.getAutostart().then(setAutostart);
    window.claude.snapshot().then(setClaude);
    return window.claude.onChange(setClaude);
  }, []);

  // A newly opened project always gets room below the line.
  const openProject = claude?.project ?? null;
  useEffect(() => {
    engine.project = Boolean(openProject);
    if (openProject && engine.snap === "low") engine.setSnap("mid");
    setChoosing(false);
  }, [engine, openProject]);

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

  // Alt+arrows move the line from anywhere, even from inside a terminal.
  useEffect(() => {
    if (!openProject) return;
    const onKey = (event: KeyboardEvent) => {
      if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
      event.preventDefault();
      event.stopPropagation();
      engine.step(event.key === "ArrowUp" ? 1 : -1);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [engine, openProject]);

  const refreshChats = useCallback(() => {
    window.jarvis.listChats().then((list) => {
      setChats(list.chats.filter((chat) => chat.id !== list.current).reverse());
    });
  }, []);
  useEffect(refreshChats, [refreshChats, messages.length]);

  useEffect(() => {
    let alive = true;
    const started = Date.now();
    window.jarvis.warmUp().then((ready) => {
      if (!alive) return;
      window.setTimeout(() => {
        const welcome = ready ? "Welcome back, sir. All systems online." : "Welcome back, sir. Ollama isn't running, so I can only do simple commands.";
        speak(welcome);
        window.jarvis.welcome(welcome);
        // Only speaks up when something's actually wrong. "Ollama isn't running" is already said.
        window.jarvis.health().then((problems) => {
          const rest = problems.filter((problem) => !problem.startsWith("Ollama"));
          if (rest.length) window.setTimeout(() => speak(`One thing to know, sir: ${rest.join("; ")}.`), 2500);
        });
        setBusy(false);
        input.current?.focus();
      }, Math.max(0, 900 - (Date.now() - started)));
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
      setPrefsOpen(false);
      setMood("thinking");
      setMessages((list) => [...list, { id: nextId++, from: "you", text: said }]);
      try {
        const reply = await window.jarvis.ask(said);
        speak(reply.say, reply.pending, reply.tool);
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
      speak(reply.say, reply.pending);
      input.current?.focus();
    },
    [speak],
  );

  // A number picks a choice and Esc cancels, unless he's in the middle of writing something.
  useEffect(() => {
    if (!pending) return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest?.(".terminal-host")) return;
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

  const submit = () => {
    if (busy || !draft.trim()) return;
    const value = draft;
    setDraft("");
    setMood((now) => (now === "listening" ? "idle" : now));
    send(value);
  };

  const openChat = useCallback((id: number) => {
    window.jarvis.openChat(id).then((turns) => {
      setMessages(asMessages(turns));
      setPending(null);
      setPrefsOpen(false);
      scrollDown();
      input.current?.focus();
    });
  }, [scrollDown]);

  const newChat = useCallback(() => {
    window.jarvis.newChat().then(() => {
      setMessages([]);
      setPending(null);
      setPrefsOpen(false);
      scrollDown();
      refreshChats();
      input.current?.focus();
    });
  }, [refreshChats, scrollDown]);

  const lastJarvis = messages.map((message) => message.from).lastIndexOf("jarvis");
  const asking = Boolean(pending);
  return (
    <div className="shell" data-project={openProject ? "open" : "closed"} data-room="wide">
      <header className="appbar">
        <b>Jarvis</b>
        {chats.length > 0 && !prefsOpen && (
          <button
            type="button"
            className="earlier"
            onClick={() => scroller.current?.scrollTo({ top: scrolledBack ? 0 : -((current.current?.offsetHeight ?? 0) - 60), behavior: calm ? "auto" : "smooth" })}
          >
            {scrolledBack ? "Back to now" : "Earlier"}
          </button>
        )}
        <button type="button" aria-label="New conversation" title="New conversation" onClick={newChat}>
          <svg className="big" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
        </button>
        <button type="button" aria-label="Preferences" title="Preferences" aria-pressed={prefsOpen} onClick={() => setPrefsOpen((value) => !value)}>
          <svg className="big" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2V21a2 2 0 0 1-4 0v-.1a1.7 1.7 0 0 0-2.9-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0-1.2-2.9H3a2 2 0 0 1 0-4h.1a1.7 1.7 0 0 0 1.2-2.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3h.1a1.7 1.7 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9v.1a1.7 1.7 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
          </svg>
        </button>
        <button type="button" aria-label="Minimize" title="Minimize" onClick={() => window.jarvis.minimize()}>
          <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M1 6h10" stroke="currentColor" strokeWidth="1.3" /></svg>
        </button>
        <button type="button" aria-label="Maximize" title="Maximize" onClick={() => window.jarvis.toggleMaximize()}>
          <svg viewBox="0 0 12 12" aria-hidden="true"><rect x="1.5" y="1.5" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="1.3" /></svg>
        </button>
        <button type="button" className="quit" aria-label="Close" title="Close" onClick={() => window.jarvis.close()}>
          <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.3" /></svg>
        </button>
      </header>

      <section className="above" aria-label="Conversation with Jarvis">
        <div className="scroller" ref={scroller} hidden={prefsOpen} onScroll={(event) => setScrolledBack(event.currentTarget.scrollTop < -40)}>
          <div className="log col">
            <Earlier chats={chats} onOpen={openChat} onDeleted={refreshChats} />
            <div className="now-chat" ref={current} role="log" aria-live="polite">
              {messages.map((message, index) => (
                <div
                  key={message.id}
                  className={`message ${message.from}${index === lastJarvis ? " latest" : ""}${index === messages.length - 1 ? " now" : ""}${index === lastJarvis && message.text.length <= 180 ? " big" : ""}`}
                >
                  {message.from === "jarvis" && (message.viaClaude || message.fromClaude) && <small>{message.viaClaude ? "Jarvis, asking Claude" : "From Claude"}</small>}
                  {message.from === "jarvis" && !message.restored ? <Spoken text={message.text} /> : <p>{message.text}</p>}
                </div>
              ))}
              {busy && <span className="sr-only" role="status">Jarvis is thinking</span>}
            </div>
          </div>
        </div>
        {!prefsOpen && pending && (
          <div className="col decision-slot" ref={decisionSlot}>
            <Decision pending={pending} onChoose={choose} onSay={send} />
          </div>
        )}
        <Preferences open={prefsOpen} mode={mode} setMode={setMode} autostart={autostart} setAutostart={setAutostart} bypass={Boolean(claude?.bypass)} />
      </section>

      {openProject && claude && (
        <div className="below">
          <ClaudePanel snap={claude} mode={mode} asking={asking} choosing={choosing} onChosen={() => setChoosing(false)} />
        </div>
      )}

      <Line engine={engine} mood={mood} pulse={pulse} movable={Boolean(openProject) && !prefsOpen} />
      {openProject && claude && (
        <ClaudeBand
          snap={claude}
          engine={engine}
          asking={asking && claudeAsking}
          choosing={choosing}
          onToggleChoosing={() => {
            if (engine.snap === "low") engine.setSnap("mid");
            setChoosing((value) => !value);
            input.current?.focus();
          }}
        />
      )}
      <Timers engine={engine} />

      <form
        ref={box}
        className="ask"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <button
          className="mic"
          type="button"
          disabled={voice === "off" || voice === "loading"}
          aria-pressed={voice === "muted"}
          aria-label={voice === "muted" ? "Turn microphone on" : "Mute microphone"}
          title={voice === "muted" ? "Microphone is off. Click to turn it on." : "Microphone is on. Click to mute."}
          onClick={() => {
            const mute = voice !== "muted";
            updateVoice(mute ? "muted" : "on");
            window.jarvis.setMuted(mute);
          }}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true">
            <rect x="9" y="3" width="6" height="11" rx="3" />
            <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
            {voice === "muted" && <path d="M4 4l16 16" />}
          </svg>
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
            setPulse((value) => value + 1);
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
        <button className="send" type="submit" disabled={busy || !draft.trim()} aria-label="Send" title="Send (Enter). Shift+Enter starts a new line.">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 19V5M6 11l6-6 6 6" />
          </svg>
        </button>
      </form>

      {messages.length <= 1 && !pending && !openProject && !prefsOpen && (
        <div className="hints">
          {HINTS.map((hint) => (
            <button key={hint} type="button" onClick={() => send(hint)}>
              {hint}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
