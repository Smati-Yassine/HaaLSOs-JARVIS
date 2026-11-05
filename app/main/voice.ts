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

// Long terminal output belongs in the chat, not read aloud.
const MAX_SPOKEN = 240;
export function spokenForm(text: string): string {
  const plain = text.trim();
  if (plain.length <= MAX_SPOKEN) return plain;
  return "That's a long answer, sir. It's in the chat.";
}

export class Voice {
  private child: ChildProcessWithoutNullStreams | null = null;

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
  stop() {
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
