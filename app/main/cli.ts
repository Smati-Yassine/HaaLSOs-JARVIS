// Talk to the real Jarvis by typing. Commands really run on this computer.
// Use --dry-run to see what would happen without doing it.
import { createInterface } from "node:readline/promises";

import { Jarvis, unloadModel } from "./brain.ts";

const dryRun = process.argv.includes("--dry-run");
const jarvis = new Jarvis({ dryRun });
const terminal = createInterface({ input: process.stdin, output: process.stdout });

console.log(`Jarvis, typed mode${dryRun ? " (dry run: nothing really happens)" : ""}. Type exit to leave.`);
console.log("Warming up...");
await jarvis.warmUp().catch(() => console.log("Ollama isn't running. Only fast commands will work."));
console.log("Welcome back, sir. All systems online.\n");

for (;;) {
  let said: string;
  try {
    said = (await terminal.question("> ")).trim();
  } catch {
    break;
  }
  if (said === "exit" || said === "quit") break;
  if (!said) continue;
  const reply = await jarvis.handle(said);
  const detail = [reply.source, reply.tool, `${reply.ms}ms`].filter(Boolean).join(", ");
  console.log(`Jarvis: ${reply.say}  (${detail})\n`);
}
terminal.close();
await unloadModel();
