// Tests the real brain on phrasing it was never tuned on. Nothing really runs: it's a dry run.
// Usage: node bench/unseen_phrases.ts
import { Jarvis, unloadModel } from "../app/main/brain.ts";

const CASES: [string, string | null][] = [
  ["what's the time right now", "get_time"],
  ["could you tell me what time it is", "get_time"],
  ["fire up firefox for me", "open_app"],
  ["I need the calculator", "open_app"],
  ["shut down spotify", "close_app"],
  ["kill discord", "close_app"],
  ["shrink the firefox window", "window_control"],
  ["bring firefox to the front", "window_control"],
  ["look up flights to Paris", "web_answer"],
  ["what's the latest news in Tunisia", "web_answer"],
  ["how much is bitcoin right now", "web_answer"],
  ["who is winning the premier league this season", "web_answer"],
  ["do a google search for cheap laptops", "google_search"],
  ["take me to reddit", "open_website"],
  ["pull up stackoverflow.com", "open_website"],
  ["make it louder, set the sound to 70", "set_volume"],
  ["silence the audio", "set_volume"],
  ["skip this track", "media_control"],
  ["resume the song", "media_control"],
  ["is my laptop charging", "system_info"],
  ["how much ram is being used", "system_info"],
  ["am I connected to the internet", "system_info"],
  ["let's work on my tempura project", "start_coding"],
  ["open resido in claude", "start_coding"],
  ["begin coding on kamayra", "start_coding"],
  ["refactor the payment module", "ask_claude"],
  ["write a test for the login page", "ask_claude"],
  ["make the navbar sticky", "ask_claude"],
  ["I'm finished coding for today", "close_project"],
  ["shut the project down", "close_project"],
  ["how big is my downloads folder", "folder_info"],
  ["install htop", "run_command"],
  ["make a folder called invoices in my documents", "run_command"],
  ["tell me something funny", null],
  ["what's the speed of light", null],
  ["who painted the Mona Lisa", null],
  ["good morning Jarvis", null],
  ["you're the best", null],
];

const jarvis = new Jarvis({ dryRun: true });
await jarvis.warmUp();
let passed = 0;
const times: number[] = [];
for (const [said, want] of CASES) {
  const fresh = new Jarvis({ dryRun: true }); // Each phrase stands alone.
  const reply = await fresh.handle(said);
  const got = reply.tool ?? null;
  const ok = got === want;
  passed += Number(ok);
  times.push(reply.ms);
  console.log(`${ok ? "ok  " : "FAIL"} ${String(reply.ms).padStart(5)}ms ${reply.source.padEnd(5)} ${JSON.stringify(said)} -> ${got ?? "spoke"}${ok ? "" : ` (wanted ${want ?? "speech"}): ${reply.say.slice(0, 70)}`}`);
}
times.sort((a, b) => a - b);
await unloadModel();
console.log(`\n${passed}/${CASES.length} on unseen phrases, median ${times[times.length >> 1]}ms, worst ${times.at(-1)}ms`);
