// The Jarvis loop: try the fast path, otherwise ask the local model, then run one tool.
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { fastPath, type Call } from "./fastpath.ts";
import { isApproval, type Level } from "./safety.ts";
import { runApproved, toolSchemas, TOOLS, type Context } from "./tools.ts";

const OLLAMA = "http://localhost:11434/api/chat";
const MODEL = "qwen3.5:2b";
const LOG_DIR = join(homedir(), ".Jarvis", "logs");
const KEEP_TURNS = 6;

const SYSTEM = `You are Jarvis, the user's personal assistant on his Linux computer. Address him as sir. \
Keep spoken replies to one or two short sentences, with no emoji. Use a tool whenever the request is an action on the \
computer or needs live information. Answer directly, without tools, for jokes, general knowledge, thanks \
and conversation. Never search for facts you already know. Only use google_search when he explicitly says \
google or search. Any request to add, fix, change or build something in code goes to ask_claude. A website \
or web address goes to open_website. Shell commands run from his home folder, so use paths like ~/Downloads.`;

type Message = { role: string; content: string };
export type Pending = { command: string; level: Level };
export type Reply = { say: string; source: "fast" | "model" | "tool"; tool?: string; pending?: Pending; ms: number };

function log(entry: Record<string, unknown>) {
  mkdirSync(LOG_DIR, { recursive: true });
  appendFileSync(join(LOG_DIR, "commands.jsonl"), JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n");
}

// Small models sometimes print a tool call as text instead of calling it. Catch that,
// so raw JSON is never spoken.
export function parseTextCall(content: string): Call | null {
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const data = JSON.parse(content.slice(start, end + 1));
    const fn = data.function && typeof data.function === "object" ? data.function : data;
    const name = typeof data.function === "string" ? data.function : fn.name;
    if (typeof name !== "string" || !(name in TOOLS)) return null;
    return { tool: name, args: fn.arguments ?? fn.parameters ?? data.parameters ?? data.arguments ?? {} };
  } catch {
    return null;
  }
}

async function askModel(history: Message[]): Promise<{ call: Call | null; content: string }> {
  const response = await fetch(OLLAMA, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      stream: false,
      think: false,
      keep_alive: -1, // Stays in GPU memory: the first load takes about 8 seconds.
      options: { temperature: 0, num_ctx: 4096, num_predict: 200 },
      tools: toolSchemas(),
      messages: [{ role: "system", content: SYSTEM }, ...history],
    }),
  });
  if (!response.ok) throw new Error(`Ollama answered ${response.status}`);
  const { message } = (await response.json()) as {
    message: { content?: string; tool_calls?: { function: { name: string; arguments: Record<string, string> } }[] };
  };
  const native = message.tool_calls?.[0]?.function;
  const content = (message.content ?? "").trim();
  if (native) return { call: { tool: native.name, args: native.arguments ?? {} }, content };
  return { call: parseTextCall(content), content };
}

// Frees the graphics card. Call this when Jarvis exits.
export async function unloadModel() {
  await fetch("http://localhost:11434/api/generate", {
    method: "POST",
    body: JSON.stringify({ model: MODEL, keep_alive: 0 }),
  }).catch(() => {});
}

// Replies get read aloud, so symbols a voice can't say are removed.
export function speakable(text: string): string {
  return text.replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, "").replace(/\s+$/gm, "").trim();
}

export class Jarvis {
  private history: Message[] = [];
  private pending: Pending | null = null;
  private ctx: Context;

  constructor(ctx: Context = { dryRun: false }) {
    this.ctx = ctx;
  }

  async warmUp() {
    await askModel([{ role: "user", content: "hello" }]);
  }

  private remember(said: string, reply: string) {
    this.history.push({ role: "user", content: said }, { role: "assistant", content: reply });
    this.history = this.history.slice(-KEEP_TURNS);
  }

  private async runTool(call: Call, source: Reply["source"], said: string, begin: number): Promise<Reply> {
    const tool = TOOLS[call.tool];
    if (!tool) return this.finish(said, "I'm not able to do that, sir.", source, begin);
    log({ said, tool: call.tool, args: call.args, source, dryRun: this.ctx.dryRun });
    try {
      const result = await tool.run(call.args, this.ctx);
      if (result.needsApproval) {
        this.pending = result.needsApproval;
        const { command, level } = result.needsApproval;
        const ask = level === "confirm"
          ? `This one is dangerous, sir: ${command}. Say confirm to run it.`
          : `I'll run: ${command}. Shall I go ahead, sir?`;
        return { say: ask, source, tool: call.tool, pending: result.needsApproval, ms: Date.now() - begin };
      }
      return this.finish(said, result.say, source, begin, call.tool);
    } catch (error) {
      log({ said, tool: call.tool, error: String(error) });
      return this.finish(said, "That didn't work, sir.", source, begin, call.tool);
    }
  }

  private finish(said: string, say: string, source: Reply["source"], begin: number, tool?: string): Reply {
    this.remember(said, say);
    return { say, source, tool, ms: Date.now() - begin };
  }

  async handle(said: string): Promise<Reply> {
    const begin = Date.now();
    if (/^(jarvis,? )?(stop|cancel|never ?mind)[.!]?$/i.test(said.trim()) && this.pending) {
      this.pending = null;
      return { say: "Cancelled, sir.", source: "fast", ms: Date.now() - begin };
    }
    if (this.pending) {
      const { command, level } = this.pending;
      this.pending = null;
      if (!isApproval(said, level)) {
        log({ said, command, level, approved: false });
        return { say: "Cancelled, sir. I didn't run it.", source: "fast", ms: Date.now() - begin };
      }
      log({ said, command, level, approved: true, dryRun: this.ctx.dryRun });
      const result = this.ctx.dryRun ? { say: "Done, sir." } : await runApproved(command);
      return { say: result.say, source: "tool", tool: "run_command", ms: Date.now() - begin };
    }

    const quick = fastPath(said);
    if (quick) return this.runTool(quick, "fast", said, begin);

    try {
      const { call, content } = await askModel([...this.history, { role: "user", content: said }]);
      if (call) return this.runTool(call, "model", said, begin);
      return this.finish(said, speakable(content) || "I didn't catch that, sir.", "model", begin);
    } catch (error) {
      log({ said, error: String(error) });
      const offline = String(error).includes("fetch failed");
      return {
        say: offline ? "Ollama isn't running, sir." : "My brain just failed, sir. Please try again.",
        source: "model",
        ms: Date.now() - begin,
      };
    }
  }
}
