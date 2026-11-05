import gsap from "gsap";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

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
      }
    });
  }, [speak, updateVoice]);

  useEffect(() => {
    let alive = true;
    const started = Date.now();
    window.jarvis.warmUp().then((ready) => {
      if (!alive) return;
      window.setTimeout(() => {
        const welcome = ready ? "Welcome back, sir. All systems online." : "Welcome back, sir. Ollama isn't running, so I can only do simple commands.";
        speak(welcome);
        window.jarvis.welcome(welcome);
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

  return (
    <div className="desk">
      <div className="stage">
        <Line mood={mood} pulse={pulse} />
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
        </div>
      </section>
    </div>
  );
}
