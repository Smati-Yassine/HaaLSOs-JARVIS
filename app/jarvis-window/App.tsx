import gsap from "gsap";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { ClaudePanel, type Snapshot } from "./ClaudePanel";
import { Line, type Mood } from "./Line";

type Pending = { command: string; level: "run" | "say-back" | "confirm" };
type Reply = { say: string; source: string; tool?: string; pending?: Pending; ms: number };
type Message = { id: number; from: "jarvis" | "you"; text: string; pending?: Pending };
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

// Claude's minimized form: click to bring the window back, drag to move it anywhere.
function Bubble({ working, project, onOpen }: { working: boolean; project: string; onOpen(): void }) {
  const element = useRef<HTMLButtonElement>(null);
  const drag = useRef<{ dx: number; dy: number; moved: boolean } | null>(null);
  return (
    <button
      ref={element}
      type="button"
      className="bubble"
      data-working={working}
      aria-label={`Open Claude: ${project}`}
      title={`Open Claude: ${project}`}
      onPointerDown={(event) => {
        const box = event.currentTarget.getBoundingClientRect();
        drag.current = { dx: event.clientX - box.left, dy: event.clientY - box.top, moved: false };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (!drag.current || !element.current) return;
        const parent = element.current.offsetParent!.getBoundingClientRect();
        const x = event.clientX - parent.left - drag.current.dx;
        const y = event.clientY - parent.top - drag.current.dy;
        drag.current.moved = true;
        element.current.style.left = `${Math.max(4, Math.min(parent.width - 72, x))}px`;
        element.current.style.top = `${Math.max(4, Math.min(parent.height - 72, y))}px`;
        element.current.style.bottom = "auto";
      }}
      onPointerUp={() => {
        const wasDragged = drag.current?.moved;
        drag.current = null;
        if (!wasDragged) onOpen();
      }}
    >
      <svg viewBox="0 5 24 15" fill="#d97757" aria-hidden="true">
        <path fillRule="evenodd" clipRule="evenodd" d="M20.998 10.949H24v3.102h-3v3.028h-1.487V20H18v-2.921h-1.487V20H15v-2.921H9V20H7.488v-2.921H6V20H4.487v-2.921H3V14.05H0V10.95h3V5h17.998v5.949zM6 10.949h1.488V8.102H6v2.847zm10.51 0H18V8.102h-1.49v2.847z" />
      </svg>
    </button>
  );
}

export function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(true);
  const [mood, setMood] = useState<Mood>("idle");
  const [pulse, setPulse] = useState(0);
  const [tab, setTab] = useState<"chat" | "preferences">("chat");
  const [mode, setMode] = useState(savedMode);
  const [hints, setHints] = useState(true);
  const [pending, setPending] = useState<Pending | null>(null);
  const [voice, setVoice] = useState<VoiceStatus>("off");
  const voiceRef = useRef<VoiceStatus>("off");
  const [autostart, setAutostart] = useState(false);
  const [claude, setClaude] = useState<Snapshot | null>(null);
  const [panelHidden, setPanelHidden] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
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
  useLayoutEffect(scrollDown, [messages, tab, scrollDown]);

  const speak = useCallback((text: string, withPending?: Pending) => {
    setMessages((list) => [...list, { id: nextId++, from: "jarvis", text, pending: withPending }]);
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
          setHints(false);
          setMood("listening");
          break;
        case "heard":
          if (event.text) {
            setHints(false);
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
        case "speaking":
          setMood(event.active ? "speaking" : "idle");
          break;
        case "show-claude":
          setPanelHidden(false);
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
      setHints(false);
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
        {openProject && panelHidden && (
          <Bubble working={Boolean(claude?.sessions.some((session) => session.working))} project={openProject} onOpen={() => setPanelHidden(false)} />
        )}
      </div>
      <section className="talk" aria-label="Conversation with Jarvis">
        <div className="tabs" role="tablist">
          {(["chat", "preferences"] as const).map((name) => (
            <button key={name} type="button" role="tab" aria-selected={tab === name} onClick={() => setTab(name)}>
              {name === "chat" ? "Chat" : "Preferences"}
            </button>
          ))}
        </div>

        <div className="pane" hidden={tab !== "chat"}>
            <div className="scroller" ref={scroller}>
              <div className="log" role="log" aria-live="polite">
                {messages.map((message) => (
                  <div key={message.id} className={`message ${message.from}`}>
                    <small>{message.from === "jarvis" ? "Jarvis" : "You"}</small>
                    {message.from === "jarvis" ? <Spoken text={message.text} onDone={scrollDown} /> : <p>{message.text}</p>}
                    {message.pending && pending === message.pending && (
                      <div className="choices">
                        <code>{message.pending.command}</code>
                        <button
                          type="button"
                          className={message.pending.level === "confirm" ? "choice danger" : "choice"}
                          onClick={() => send(message.pending!.level === "confirm" ? "confirm" : "yes")}
                        >
                          {message.pending.level === "confirm" ? "Confirm" : "Go ahead"}
                        </button>
                        <button type="button" className="choice" onClick={() => send("cancel")}>
                          Cancel
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
            <div className="bottom">
              {hints && (
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
                  const value = draft;
                  setDraft("");
                  setMood((now) => (now === "listening" ? "idle" : now));
                  send(value);
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
                <input
                  ref={input}
                  value={draft}
                  autoComplete="off"
                  placeholder={voice === "on" ? 'Say "Hey Jarvis" or type' : voice === "loading" ? "Voice is loading. You can type" : voice === "muted" ? "Microphone off. Type to Jarvis" : "Type to Jarvis"}
                  aria-label="Message to Jarvis"
                  onChange={(event) => {
                    setDraft(event.target.value);
                    setPulse((value) => value + 1);
                    setMood((now) => (now === "idle" || now === "listening" ? (event.target.value ? "listening" : "idle") : now));
                  }}
                />
                <button className="send" type="submit" disabled={busy} aria-label="Send">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M5 12h14M13 6l6 6-6 6" />
                  </svg>
                </button>
              </form>
            </div>
        </div>
        <div className="preferences" hidden={tab !== "preferences"}>
            <h2 id="appearance">Appearance</h2>
            <div className="segments" role="group" aria-labelledby="appearance">
              {(["dark", "light"] as const).map((name) => (
                <button key={name} type="button" aria-pressed={mode === name} onClick={() => setMode(name)}>
                  {name === "dark" ? "Dark" : "Light"}
                </button>
              ))}
            </div>
            <h2 id="login" className="pref-gap">Start with your computer</h2>
            <div className="segments" role="group" aria-labelledby="login">
              {[true, false].map((enabled) => (
                <button
                  key={String(enabled)}
                  type="button"
                  aria-pressed={autostart === enabled}
                  onClick={() => window.jarvis.setAutostart(enabled).then(setAutostart)}
                >
                  {enabled ? "On" : "Off"}
                </button>
              ))}
            </div>
        </div>
      </section>
    </div>
    {openProject && claude && (
      <div className="panel-slot" hidden={panelHidden}>
        <ClaudePanel snap={claude} mode={mode} onMinimize={() => setPanelHidden(true)} />
      </div>
    )}
    </div>
    </div>
  );
}
