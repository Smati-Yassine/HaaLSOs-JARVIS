// Casual, misheard and non-English requests: what Claude's understanding step is for.
// Usage: node bench/casual_phrases.ts --live   (without --live, Claude is stood in by "NONE")
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.JARVIS_LOG_DIR = mkdtempSync(join(tmpdir(), "jarvis-messy-"));
const dir = "../app/main/";
const { Jarvis, unloadModel } = await import(dir + "brain.ts");
const { askClaudeOnce } = await import(dir + "thinker.ts");
const live = process.argv.includes("--live");
export const MESSY: [string, string][] = [
  ["i want to travaille on jarvis", "start_coding"],
  ["get me into the luminelle stuff", "start_coding"],
  ["could u put some music on youtube, lofi", "youtube"],
  ["it's way too loud", "set_volume"],
  ["ping me in 20 min about the pasta", "set_reminder"],
  ["make the screen less bright", "brightness"],
  ["kill spotify", "close_app"],
  ["fais une capture d'ecran", "screenshot"],
  ["i'm done for today with the code", "close_project"],
  ["what's the deal with my battery", "system_info"],
  ["chuck firefox in the background", "window_control"],
  ["tell me a joke", "talk"],
  ["what's the capital of peru", "talk"],
  ["i had a long day", "talk"],
];
const projects = () => ["HaaLSO's JARVIS", "luminelle", "portfolio", "resido"];
let ok = 0;
for (const [said, want] of MESSY) {
  let started = "";
  const claude = { openProject: said.includes("done for today") ? "luminelle" : null, start: (p: string) => { started = p; }, close() {}, ask: () => true };
  const thinker = live
    ? (p: string, on?: (d: string) => void, tier?: "quick" | "deep", system?: string) => askClaudeOnce(p, system, "claude", on, tier)
    : async (_p: string, _on?: unknown, _t?: unknown, system?: string) => (system ? "NONE" : "A chat answer, sir.");
  const t = Date.now();
  const reply = await new Jarvis({ dryRun: true, claude, projects, thinker }).handle(said);
  const got = reply.tool && reply.tool !== "claude_answer" ? reply.tool : "talk";
  ok += Number(got === want);
  console.log(`${got === want ? "ok  " : "MISS"} ${String(Date.now() - t).padStart(5)}ms ${said.padEnd(42)} -> ${got.padEnd(14)} ${reply.say.slice(0, 60)}`);
}
console.log(`${ok}/${MESSY.length}`);
await unloadModel();
