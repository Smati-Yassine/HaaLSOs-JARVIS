// Held out: run once after changing the rules, and never tune the rules to these phrases.
// Usage: node bench/heldout_phrases.ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.JARVIS_LOG_DIR = mkdtempSync(join(tmpdir(), "jarvis-bench-"));
const { Jarvis, unloadModel } = await import("../app/main/brain.ts");
const C: [string, string[] | null][] = [
  ["what's the time in my timezone", ["get_time"]], ["tell me the date", ["get_time"]],
  ["will it be sunny this weekend", ["get_weather"]], ["what's the temperature outside", ["get_weather"]],
  ["how did the lakers do last night", ["web_answer"]], ["what's tesla stock at", ["web_answer"]],
  ["open the calculator app", ["open_app"]], ["start vs code", ["open_app"]], ["close firefox", ["close_app"]],
  ["minimize the terminal", ["window_control"]], ["search youtube for cat videos", ["youtube"]],
  ["google best pizza near me", ["google_search"]], ["open wikipedia", ["open_website"]],
  ["crank the volume up", ["set_volume"]], ["set volume to 35", ["set_volume"]], ["unmute", ["set_volume"]],
  ["skip", ["media_control"]], ["play the music", ["media_control"]], ["brightness 60", ["brightness"]],
  ["turn wifi off", ["radio"]], ["use light mode", ["color_scheme"]], ["grab a screenshot", ["screenshot"]],
  ["how much memory am I using", ["system_info"]], ["set a 3 minute timer", ["set_reminder"]],
  ["remind me tomorrow at 9 to pay rent", ["set_reminder"]], ["what's 144 divided by 12", ["say"]],
  ["show me my desktop folder", ["folder_info"]], ["where is my resume file", ["find_file"]],
  ["let's code on luminelle", ["start_coding"]], ["we're done coding", ["close_project"]],
  ["put the computer to sleep", ["power"]],
  ["my wifi has been terrible lately", null], ["I took a screenshot of my exam results", null],
  ["what is bluetooth", null], ["why is the sky blue", null], ["can you explain how vaccines work", null],
  ["what's the tallest mountain on earth", null], ["how are things", null], ["you're a legend", null],
  ["I set a timer but forgot why", null], ["tell me a joke about programmers", null],
  ["what's the meaning of life", null], ["how far is the moon", null],
];
const claude = { openProject: null, start() {}, ask: () => true, close() {} };
const app = () => ({ dryRun: true, claude, thinker: async () => "stand-in" });
await new Jarvis(app()).warmUp();
let ok = 0;
for (const [said, want] of C) {
  const r = await new Jarvis(app()).handle(said);
  const got = r.tool ?? null;
  const pass = want === null ? (got === null || got === "claude_answer") : want.includes(got ?? "");
  ok += Number(pass);
  if (!pass) console.log(`FAIL ${r.source} ${JSON.stringify(said)} -> ${got ?? "spoke"} (wanted ${want ?? "speech"}): ${r.say.slice(0, 60)}`);
}
await unloadModel();
console.log(`${ok}/${C.length} held out`);
