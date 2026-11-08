// Runs the Python voice engine and passes messages to and from it, one JSON object per line.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

export type VoiceEvent =
  | { type: "ready"; load_seconds: number }
  | { type: "mic"; on: boolean }
  | { type: "wake"; score: number }
  | { type: "heard"; text: string; stt_ms?: number }
  | { type: "speaking"; active: boolean; first_audio_ms?: number }
  | { type: "follow_up" }
  | { type: "error"; message: string; fatal?: boolean }
  | { type: "gone" };

// About forty-five seconds of speech. Past that it reads the start and says where the rest is.
const MAX_SPOKEN = 700;

// Output from a command or a listing reads badly aloud: few sentences, lots of symbols.
const looksLikeOutput = (text: string) => {
  const letters = (text.match(/[a-z ]/gi) ?? []).length;
  return letters / text.length < 0.75 || !/[a-z]{3,} [a-z]{2,} [a-z]{2,}/i.test(text);
};

// Markdown, links and paths made into something a voice can say.
function speechText(text: string): string {
  return text
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/https?:\/\/\S+/g, "a link")
    .replace(/(^|\s)(~|\.{0,2})?\/[\w.\/-]+/g, " ")
    .replace(/^\s*(?:[-*•]|\d+[.)])\s+(.*?)[.!?:;]?\s*$/gm, "$1.") // List items become sentences.
    .replace(/^#+\s*(.*?)[.!?:]?\s*$/gm, "$1.")
    .replace(/\*\*?|`|_{2}/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// What the voice reads: the full answer, made speakable. Code, links and paths stay in the chat.
export function spokenForm(text: string): string {
  let plain = text.trim();
  if (plain.length <= 240 && !plain.includes("```")) return plain;
  const hadCode = /```/.test(plain);
  plain = speechText(plain);
  if (!plain || looksLikeOutput(plain)) return "That's a long answer, sir. It's in the chat.";
  const sentences = plain.match(/[^.!?]+[.!?]+["')]*|[^.!?]+$/g)?.map((part) => part.trim()) ?? [plain];
  let spoken = "";
  for (const sentence of sentences) {
    if (spoken && spoken.length + sentence.length > MAX_SPOKEN) return `${spoken} The rest is in the chat, sir.`;
    spoken = spoken ? `${spoken} ${sentence}` : sentence.slice(0, MAX_SPOKEN);
  }
  return hadCode ? `${spoken} The code is in the chat, sir.` : spoken;
}

// Speaks an answer while it's still being written: each finished sentence goes to the voice at
// once. Code is skipped, and past the usual length it says where the rest is.
export class SpeechStream {
  private buffer = "";
  private inCode = false;
  private hadCode = false;
  private length = 0;
  private full = false;
  spoke = false;

  private readonly out: (text: string, more: boolean) => void;
  private readonly live: () => boolean;

  constructor(out: (text: string, more: boolean) => void, live: () => boolean = () => true) {
    this.out = out;
    this.live = live;
  }

  push = (delta: string) => {
    this.buffer += delta;
    for (;;) {
      if (this.inCode) {
        const close = this.buffer.indexOf("```");
        if (close < 0) return;
        this.buffer = this.buffer.slice(close + 3);
        this.inCode = false;
        continue;
      }
      const fence = this.buffer.indexOf("```");
      const end = this.buffer.search(/[.!?]["')]*\s|\n/);
      if (fence >= 0 && (end < 0 || fence < end)) {
        this.sentence(this.buffer.slice(0, fence));
        this.buffer = this.buffer.slice(fence + 3);
        this.inCode = this.hadCode = true;
        continue;
      }
      if (end < 0) return;
      const cut = this.buffer.slice(end).match(/^[.!?]["')]*\s|^\n/)![0].length + end;
      this.sentence(this.buffer.slice(0, cut));
      this.buffer = this.buffer.slice(cut);
    }
  };

  end() {
    if (!this.inCode) this.sentence(this.buffer);
    this.buffer = "";
    if (this.hadCode && this.spoke && !this.full) this.send("The code is in the chat, sir.");
    if (this.spoke && this.live()) this.out("", false);
  }

  private sentence(raw: string) {
    const text = raw.trim() ? speechText(raw) : "";
    if (!text || this.full || !/[a-z0-9]/i.test(text)) return;
    if (this.spoke && this.length + text.length > MAX_SPOKEN) {
      this.full = true;
      return this.send("The rest is in the chat, sir.");
    }
    this.length += text.length;
    this.send(text);
  }

  private send(text: string) {
    if (!this.live()) return;
    this.spoke = true;
    this.out(text, true);
  }
}

export class Voice {
  private child: ChildProcessWithoutNullStreams | null = null;
  // Counts stops, so an answer still streaming in after one isn't spoken.
  private turn = 0;

  private readonly folder: string;
  private readonly onEvent: (event: VoiceEvent) => void;
  private readonly extraArgs: string[];

  constructor(folder: string, onEvent: (event: VoiceEvent) => void, extraArgs: string[] = []) {
    this.folder = folder;
    this.onEvent = onEvent;
    this.extraArgs = extraArgs;
  }

  start(): boolean {
    const python = join(this.folder, ".venv", "bin", "python");
    if (!existsSync(python)) return false;
    const logs = join(homedir(), ".Jarvis", "logs");
    mkdirSync(logs, { recursive: true });

    const child = spawn(python, [join(this.folder, "daemon.py"), ...this.extraArgs], { cwd: this.folder });
    this.child = child;
    child.stderr.pipe(createWriteStream(join(logs, "voice.log"), { flags: "w" }));
    createInterface({ input: child.stdout }).on("line", (line) => {
      try {
        this.onEvent(JSON.parse(line) as VoiceEvent);
      } catch {
        // Native libraries sometimes print to stdout. Only JSON lines are messages.
      }
    });
    child.on("error", () => this.onEvent({ type: "gone" }));
    child.on("exit", () => {
      this.child = null;
      this.onEvent({ type: "gone" });
    });
    return true;
  }

  private send(message: Record<string, unknown>) {
    if (this.child?.stdin.writable) this.child.stdin.write(JSON.stringify(message) + "\n");
  }

  say(text: string, thenListen = false) {
    if (text.trim()) this.send({ type: "speak", text: spokenForm(text), then_listen: thenListen });
  }
  // For an answer that's still being written. Nothing more is spoken once something stops the voice.
  stream(): SpeechStream {
    const turn = this.turn;
    return new SpeechStream((text, more) => this.send({ type: "speak", text, then_listen: false, more }), () => this.turn === turn);
  }
  stop() {
    this.turn += 1;
    this.send({ type: "stop" });
  }
  listen() {
    this.send({ type: "listen" });
  }
  setMuted(muted: boolean) {
    this.send({ type: muted ? "mute" : "unmute" });
  }
  quit() {
    this.send({ type: "quit" });
    const child = this.child;
    setTimeout(() => child?.kill(), 500).unref();
  }
}
