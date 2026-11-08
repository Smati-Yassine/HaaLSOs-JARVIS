// A harder routing test, written after the rules were tuned, with traps where an action word
// appears but nothing should happen. Nothing really runs: it's a dry run.
// Usage: node bench/hard_phrases.ts [--fails]
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Jarvis, unloadModel } from "../app/main/brain.ts";

process.env.JARVIS_LOG_DIR = mkdtempSync(join(tmpdir(), "jarvis-bench-"));

// null means Jarvis should just talk. A list means any of those tools is fine.
export const HARD: [string, string | string[] | null][] = [
  // Time, weather, live facts
  ["got the time?", "get_time"],
  ["what day of the week is it", "get_time"],
  ["is it going to rain tomorrow", "get_weather"],
  ["how cold is it in Paris", "get_weather"],
  ["do I need an umbrella today", "get_weather"],
  ["who won the champions league final", "web_answer"],
  ["what's the price of gold today", "web_answer"],
  ["any news about the elections", "web_answer"],
  ["what's the euro to dollar rate", "web_answer"],
  // Apps and windows
  ["can you get spotify going", "open_app"],
  ["launch the terminal", "open_app"],
  ["open up files", "open_app"],
  ["quit vlc", "close_app"],
  ["get rid of the discord window", ["close_app", "window_control"]],
  ["maximise brave", "window_control"],
  ["put firefox in front", "window_control"],
  // Web
  ["google how to boil an egg", "google_search"],
  ["go to youtube.com", "open_website"],
  ["open github", "open_website"],
  ["play lofi beats on youtube", "youtube"],
  // Sound, media, screen
  ["turn it down to 20", "set_volume"],
  ["volume fifty", "set_volume"],
  ["mute", "set_volume"],
  ["pause the music", "media_control"],
  ["next song please", "media_control"],
  ["go back a track", "media_control"],
  ["what's playing", "now_playing"],
  ["make the screen brighter", "brightness"],
  ["dim the screen", "brightness"],
  ["turn off bluetooth", "radio"],
  ["switch to dark mode", "color_scheme"],
  ["take a screenshot", "screenshot"],
  ["lock my computer", "lock_screen"],
  // System
  ["how's my battery", "system_info"],
  ["how much storage do I have left", "system_info"],
  ["what's my ip", "my_ip"],
  ["what's on my clipboard", "clipboard"],
  // Timers and memory
  ["timer 10 minutes", "set_reminder"],
  ["remind me to call mum at 6pm", "set_reminder"],
  ["wake me up at 7", "set_reminder"],
  ["remind me in half an hour to check the oven", "set_reminder"],
  ["what timers do I have", "list_reminders"],
  ["cancel my timer", "clear_reminders"],
  ["what's 17 times 23", "say"],
  ["what's 15 percent of 80", "say"],
  // Files
  ["what's in my downloads", "folder_info"],
  ["open my documents folder", "open_folder"],
  ["find my cv", "find_file"],
  ["empty the trash", "power"],
  ["shut down the computer", "power"],
  ["restart the pc", "power"],
  // Coding
  ["start coding luminelle", "start_coding"],
  ["list my projects", "list_projects"],
  ["start a new project called orbit", "create_project"],
  ["I'm done coding", "close_project"],
  ["install vlc", "claude_task"],
  // Traps: action words, but plain talk
  ["I opened firefox earlier and it was slow", null],
  ["my volume knob is broken", null],
  ["I love the song that's playing", null],
  ["what does open source mean", null],
  ["why do timers in javascript drift", null],
  ["is it safe to shut down a laptop by holding the power button", null],
  ["how does a screenshot work", null],
  ["I'm watching youtube", null],
  ["closing time is at 9 at my gym", null],
  ["the weather was lovely yesterday", null],
  ["what's the capital of australia", null],
  ["who invented the telephone", null],
  ["how are you doing today", null],
  ["you're hilarious", null],
  ["good night jarvis", null],
  ["thank you so much", null],
  ["what is a black hole", null],
  ["explain recursion simply", null],
  ["should I learn rust or go", null],
  ["tell me a fun fact", null],
  ["how many legs does a spider have", null],
  ["what's your favourite colour", null],
];

// Stand-ins for Claude, so routing matches the real app without spending plan usage.
const claude = { openProject: null, start() {}, ask: () => true, close() {} };
const app = () => ({ dryRun: true, claude, thinker: async () => "A stand-in answer, sir." });
const TALK = new Set([null, "claude_answer"]);

const fails = process.argv.includes("--fails");
const warm = new Jarvis(app());
await warm.warmUp();
let passed = 0;
const times: number[] = [];
let modelCalls = 0;
for (const [said, want] of HARD) {
  const fresh = new Jarvis(app());
  const reply = await fresh.handle(said);
  const got = reply.tool ?? null;
  const ok = want === null ? TALK.has(got) : Array.isArray(want) ? want.includes(got ?? "") : got === want;
  passed += Number(ok);
  times.push(reply.ms);
  if (reply.source === "model") modelCalls += 1;
  if (!fails || !ok) console.log(`${ok ? "ok  " : "FAIL"} ${String(reply.ms).padStart(5)}ms ${reply.source.padEnd(5)} ${JSON.stringify(said)} -> ${got ?? "spoke"}${ok ? "" : ` (wanted ${want ?? "speech"}): ${reply.say.slice(0, 70)}`}`);
}
times.sort((a, b) => a - b);
await unloadModel();
console.log(`\n${passed}/${HARD.length} on hard phrases, ${modelCalls} needed the model, median ${times[times.length >> 1]}ms, worst ${times.at(-1)}ms`);
