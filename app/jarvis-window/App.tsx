import gsap from "gsap";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { ClaudePanel, type Snapshot } from "./ClaudePanel";
import { Line, type Mood } from "./Line";

type Pending = { command: string; level: "run" | "say-back" | "confirm"; options?: string[]; title?: string };
type Reply = { say: string; source: string; tool?: string; pending?: Pending; ms: number };
type Turn = { role: "user" | "jarvis"; text: string };
type Chat = { id: number; title: string; updated: number; turns: number };
type Fact = { id: number; text: string };
// A restored message is shown as it is, without the letters resolving again.
type Message = { id: number; from: "jarvis" | "you"; text: string; restored?: boolean };
type VoiceEvent = {
  type: string;
  text?: string;
  reply?: Reply;
  on?: boolean;
  active?: boolean;
  message?: string;
};
type VoiceStatus = "off" | "loading" | "on" | "muted";
type Tab = "chat" | "sessions" | "preferences";

declare global {
  interface Window {
    jarvis: {
      ask(said: string): Promise<Reply>;
      choose(index: number, label: string): Promise<Reply>;
      resumeChat(): Promise<Turn[]>;
      listChats(): Promise<{ chats: Chat[]; current: number | null }>;
      openChat(id: number): Promise<Turn[]>;
      newChat(): Promise<void>;
      deleteChat(id: number): Promise<void>;
      listFacts(): Promise<Fact[]>;
      deleteFact(id: number): Promise<void>;
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
function Spoken({ text, onDone }: { text: string; onDone?: () => void }) {
  const [shown, setShown] = useState(calm ? text : "");
  useEffect(() => {
    if (calm) {
      onDone?.();
      return;
    }
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
        onDone?.();
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

function Sessions({ open, onOpen, onNew }: { open: boolean; onOpen(id: number): void; onNew(): void }) {
  const [chats, setChats] = useState<Chat[]>([]);
  const [current, setCurrent] = useState<number | null>(null);
  const [confirming, setConfirming] = useState<number | null>(null);
  const refresh = useCallback(() => {
    window.jarvis.listChats().then((list) => {
      setChats(list.chats);
      setCurrent(list.current);
    });
  }, []);
  useEffect(() => {
    if (open) refresh();
    setConfirming(null);
  }, [open, refresh]);
  return (
    <div className="sessions" hidden={!open}>
      <button type="button" className="new-chat" onClick={onNew}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
        New conversation
      </button>
      {chats.length === 0 && <p className="sessions-empty">Nothing here yet, sir. Conversations will appear once we've had one.</p>}
      <ul>
        {chats.map((chat) => (
          <li key={chat.id} className={chat.id === current ? "on" : ""}>
            {confirming === chat.id ? (
              <div className="chat-confirm">
                <span>Delete this for good?</span>
                <button
                  type="button"
                  className="alarm"
                  onClick={() => {
                    setConfirming(null);
                    window.jarvis.deleteChat(chat.id).then(() => {
                      refresh();
                      if (chat.id === current) onNew();
                    });
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
                  <span className="chat-meta">{chat.id === current ? "Current · " : ""}{whenWas(chat.updated)} · {chat.turns} {chat.turns === 1 ? "line" : "lines"}</span>
                </button>
                <button type="button" className="row-delete" aria-label={`Delete ${chat.title}`} title="Delete" onClick={() => setConfirming(chat.id)}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" /></svg>
                </button>
              </>
            )}
          </li>
        ))}
      </ul>
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
  );
}

export function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(true);
  const [mood, setMood] = useState<Mood>("idle");
  const [pulse, setPulse] = useState(0);
  const [tab, setTab] = useState<Tab>("chat");
  const [mode, setMode] = useState(savedMode);
  const [pending, setPending] = useState<Pending | null>(null);
  const [voice, setVoice] = useState<VoiceStatus>("off");
  const voiceRef = useRef<VoiceStatus>("off");
  const [autostart, setAutostart] = useState(false);
  const [claude, setClaude] = useState<Snapshot | null>(null);
  const [panelHidden, setPanelHidden] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const stopSpeaking = useRef(0);

  useEffect(() => {
    document.documentElement.dataset.mode = mode;
    window.jarvis.setTheme(mode);
    try {
      localStorage.setItem("jarvis-mode", mode);
    } catch {
      // The choice just won't be remembered.
    }
  }, [mode]);

  const scrollDown = useCallback(() => {
    if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, []);
  useLayoutEffect(scrollDown, [messages, tab, pending, busy, scrollDown]);

  // The box grows with what's written, up to a limit, then scrolls.
  useLayoutEffect(() => {
    const box = input.current;
    if (!box) return;
    box.style.height = "auto";
    box.style.height = `${Math.min(box.scrollHeight, 200)}px`;
  }, [draft, tab]);

  const speak = useCallback((text: string, withPending?: Pending) => {
    setMessages((list) => [...list, { id: nextId++, from: "jarvis", text }]);
    setPending(withPending ?? null);
    // With a voice, the line follows the real sound. Without one, it estimates.
    if (voiceRef.current === "on" || voiceRef.current === "muted" || voiceRef.current === "loading") return;
    setMood("speaking");
    window.clearTimeout(stopSpeaking.current);
    stopSpeaking.current = window.setTimeout(
      () => setMood("idle"),
      calm ? 150 : Math.min(3400, 900 + text.length * 34),
    );
  }, []);

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
          speak(event.reply!.say, event.reply!.pending);
          setBusy(false);
          break;
        case "chat-reset":
          setMessages([]);
          setPending(null);
          setTab("chat");
          break;
        case "speaking":
          setMood(event.active ? "speaking" : "idle");
          break;
        case "show-claude":
          setPanelHidden(false);
          break;
        case "hide-claude":
          setPanelHidden(true);
          break;
        case "settled":
          setPending(null);
          break;
      }
    });
  }, [speak, updateVoice]);

  useEffect(() => {
    window.jarvis.getAutostart().then(setAutostart);
    window.claude.snapshot().then(setClaude);
    return window.claude.onChange(setClaude);
  }, []);

  // A newly opened project always shows its panel.
  const openProject = claude?.project ?? null;
  useEffect(() => setPanelHidden(false), [openProject]);

  useEffect(() => {
    let alive = true;
    const started = Date.now();
    window.jarvis.resumeChat().then((turns) => alive && setMessages((list) => [...asMessages(turns), ...list]));
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
      setMood("thinking");
      setMessages((list) => [...list, { id: nextId++, from: "you", text: said }]);
      try {
        const reply = await window.jarvis.ask(said);
        speak(reply.say, reply.pending);
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
      setTab("chat");
      input.current?.focus();
    });
  }, []);

  const newChat = useCallback(() => {
    window.jarvis.newChat().then(() => {
      setMessages([]);
      setPending(null);
      setTab("chat");
      input.current?.focus();
    });
  }, []);

  const panelOpen = Boolean(openProject) && !panelHidden;
  return (
    <div className="shell">
    <header className="appbar">
      <b>Jarvis</b>
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
    <div className="main" data-claude={panelOpen ? "open" : "closed"}>
    <div className="desk">
      <div className="stage">
        <Line mood={mood} pulse={pulse} />
      </div>
      <section className="talk" aria-label="Conversation with Jarvis">
        <div className="tabs">
          <button type="button" aria-selected={tab === "chat"} onClick={() => setTab("chat")}>Chat</button>
          <button type="button" aria-selected={tab === "sessions"} onClick={() => setTab("sessions")}>Sessions</button>
          <span className="tabs-gap" />
          {openProject && (
            <button
              type="button"
              className="icon-tab claude-tab"
              data-working={Boolean(claude?.sessions.some((session) => session.working))}
              aria-label={panelHidden ? `Open Claude: ${openProject}` : "Hide Claude"}
              title={panelHidden ? `Open Claude: ${openProject}` : "Hide Claude"}
              onClick={() => setPanelHidden((value) => !value)}
            >
              <svg viewBox="0 0 24 24" fill="#d97757" aria-hidden="true"><path d="M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z" /></svg>
            </button>
          )}
          <button
            type="button"
            className="icon-tab"
            aria-label="Preferences"
            title="Preferences"
            aria-pressed={tab === "preferences"}
            onClick={() => setTab((now) => (now === "preferences" ? "chat" : "preferences"))}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2V21a2 2 0 0 1-4 0v-.1a1.7 1.7 0 0 0-2.9-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0-1.2-2.9H3a2 2 0 0 1 0-4h.1a1.7 1.7 0 0 0 1.2-2.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3h.1a1.7 1.7 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9v.1a1.7 1.7 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
            </svg>
          </button>
        </div>

        <div className="pane" hidden={tab !== "chat"}>
            <div className="scroller" ref={scroller}>
              <div className="log" role="log" aria-live="polite">
                {messages.map((message) => (
                  <div key={message.id} className={`message ${message.from}`}>
                    <small>{message.from === "jarvis" ? "Jarvis" : "You"}</small>
                    {message.from === "jarvis" && !message.restored ? <Spoken text={message.text} onDone={scrollDown} /> : <p>{message.text}</p>}
                  </div>
                ))}
                {busy && (
                  <div className="thinking" role="status" aria-label="Jarvis is thinking">
                    <i /><i /><i />
                  </div>
                )}
              </div>
            </div>
            <div className="bottom">
              {pending && <Decision pending={pending} onChoose={choose} onSay={send} />}
              {messages.length <= 1 && !pending && (
                <div className="hints">
                  {HINTS.map((hint) => (
                    <button key={hint} type="button" onClick={() => send(hint)}>
                      {hint}
                    </button>
                  ))}
                </div>
              )}
              <form
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
            </div>
        </div>
        <Sessions open={tab === "sessions"} onOpen={openChat} onNew={newChat} />
        <Preferences open={tab === "preferences"} mode={mode} setMode={setMode} autostart={autostart} setAutostart={setAutostart} bypass={Boolean(claude?.bypass)} />
      </section>
    </div>
    {openProject && claude && (
      <div className="panel-slot" hidden={panelHidden}>
        <ClaudePanel snap={claude} mode={mode} asking={Boolean(pending)} onMinimize={() => setPanelHidden(true)} />
      </div>
    )}
    </div>
    </div>
  );
}
