// Everything Jarvis can do on the computer. Shortcut tools start programs directly with
// no shell, so text from the model can't smuggle in extra commands.
import { execFile, spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statfsSync } from "node:fs";
import { cpus, freemem, homedir, loadavg, networkInterfaces, totalmem } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";

import { findProject, listProjects, PROJECTS_ROOT } from "./projects.ts";
import { classify, type Level } from "./safety.ts";
import { webAnswer } from "./web.ts";
import { controlWindow, knownAction, listWindows, NOT_INSTALLED, pickWindow } from "./windows.ts";

const run = promisify(execFile);
const BRAVE = "/snap/bin/brave";

export type Args = Record<string, unknown>;
export type Result = {
  say: string;
  ok: boolean;
  // Set when a command must wait for the user before running.
  needsApproval?: { command: string; level: Level };
};
export type ClaudeControl = {
  openProject: string | null;
  start(project: string, path: string): void;
  ask(task: string): boolean;
  close(): void;
};
export type Context = {
  dryRun: boolean;
  claude?: ClaudeControl;
  ack?: (words: string) => void;
  projects?: () => string[];
};

const text = (value: unknown) => String(value ?? "").trim();

// Starts a program that keeps running after this call returns.
function launch(file: string, args: string[]) {
  const child = spawn(file, args, { detached: true, stdio: "ignore" });
  child.on("error", () => {});
  child.unref();
}

// ---- Applications -----------------------------------------------------------

type App = { name: string; path: string; bin: string };

const ALIASES: Record<string, string> = {
  "vs code": "code", vscode: "code", "visual studio code": "code", browser: "brave",
  "file manager": "files", "text editor": "text editor",
};

function desktopEntries(): App[] {
  const dirs = [
    join(homedir(), ".local/share/applications"),
    "/usr/share/applications",
    "/var/lib/snapd/desktop/applications",
    "/var/lib/flatpak/exports/share/applications",
    join(homedir(), ".local/share/flatpak/exports/share/applications"),
  ];
  const apps: App[] = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".desktop")) continue;
      const path = join(dir, file);
      const body = readFileSync(path, "utf8").split(/^\[/m).find((part) => part.startsWith("Desktop Entry]")) ?? "";
      if (/^(NoDisplay|Hidden)=true/m.test(body)) continue;
      const name = body.match(/^Name=(.+)$/m)?.[1];
      const exec = body.match(/^Exec=(.+)$/m)?.[1] ?? "";
      if (!name || !exec) continue;
      const program = exec.split(/\s+/).find((part) => !part.includes("=") && part !== "env") ?? "";
      apps.push({ name, path, bin: basename(program).replace(/_.*$/, "") });
    }
  }
  return apps;
}

export function findApp(spoken: string, apps: App[] = desktopEntries()): App | null {
  const raw = spoken.trim().toLowerCase();
  const want = ALIASES[raw] ?? raw;
  if (!want) return null;
  const words = (name: string) => name.toLowerCase().split(/[^a-z0-9]+/);
  return (
    apps.find((app) => app.name.toLowerCase() === want || app.bin.toLowerCase() === want) ??
    apps.find((app) => words(app.name).includes(want)) ??
    apps.find((app) => want.length >= 4 && app.name.toLowerCase().includes(want)) ??
    null
  );
}

async function windowControl(args: Args, ctx: Context): Promise<Result> {
  const action = text(args.action).toLowerCase();
  const name = text(args.name);
  if (!knownAction(action)) return { ok: false, say: "I can minimize, maximize, focus or restore a window, sir." };
  try {
    const window = pickWindow(name, await listWindows());
    if (!window) return { ok: false, say: `I can't see a ${name} window, sir.` };
    if (!ctx.dryRun) await controlWindow(window, action);
    const done: Record<string, string> = {
      focus: "Bringing up", restore: "Restoring", close: "Closing", unmaximize: "Restoring",
      minimize: "Minimizing", minimise: "Minimizing", maximize: "Maximizing", maximise: "Maximizing",
    };
    const verb = done[action];
    return { ok: true, say: `${verb} ${name}, sir.` };
  } catch (error) {
    if (String(error).includes(NOT_INSTALLED)) return { ok: false, say: "The window control extension isn't installed yet, sir." };
    throw error;
  }
}

async function openApp(args: Args, ctx: Context): Promise<Result> {
  const name = text(args.name);
  const app = findApp(name);
  if (!app) return { ok: false, say: `I can't find a program called ${name}, sir.` };
  if (!ctx.dryRun) launch("gio", ["launch", app.path]);
  return { ok: true, say: `Opening ${app.name}, sir.` };
}

async function closeApp(args: Args, ctx: Context): Promise<Result> {
  const name = text(args.name);
  if (!name) return { ok: false, say: "Which program, sir?" };
  const app = findApp(name);
  // Closing the window lets the program ask about unsaved work, so try that first.
  const open = await listWindows().catch(() => []);
  const window = pickWindow(app?.bin || name, open) ?? pickWindow(name, open);
  if (window) {
    if (!ctx.dryRun) await controlWindow(window, "close");
    return { ok: true, say: `Closing ${app?.name ?? name}, sir.` };
  }
  const target = app?.bin || name.toLowerCase();
  // Exact process name only, and never another user's process.
  const uid = String(process.getuid?.() ?? "");
  const check = await run("pgrep", ["-i", "-x", "-U", uid, target]).catch(() => null);
  if (!check) return { ok: false, say: `${app?.name ?? name} isn't running, sir.` };
  if (!ctx.dryRun) await run("pkill", ["-TERM", "-i", "-x", "-U", uid, target]);
  return { ok: true, say: `Closing ${app?.name ?? name}, sir.` };
}

// ---- Browser ----------------------------------------------------------------

export function googleUrl(query: string): string {
  return `https://www.google.com/search?q=${encodeURIComponent(query.trim())}`;
}

export function websiteUrl(address: string): string | null {
  let value = address.trim().toLowerCase();
  if (!value || /\s/.test(value)) return null;
  if (!/^https?:\/\//.test(value)) {
    if (value.includes(":")) return null; // Refuses file:, javascript: and similar.
    if (!value.includes(".")) value += ".com";
    value = `https://${value}`;
  }
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

async function googleSearch(args: Args, ctx: Context): Promise<Result> {
  const query = text(args.query);
  if (!query) return { ok: false, say: "What should I search for, sir?" };
  if (!ctx.dryRun) launch(BRAVE, [googleUrl(query)]);
  return { ok: true, say: `Searching Google for ${query}, sir.` };
}

async function openWebsite(args: Args, ctx: Context): Promise<Result> {
  const url = websiteUrl(text(args.url));
  if (!url) return { ok: false, say: "That doesn't look like a website address, sir." };
  if (!ctx.dryRun) launch(BRAVE, [url]);
  return { ok: true, say: `Opening ${new URL(url).hostname.replace(/^www\./, "")}, sir.` };
}

// ---- Weather ----------------------------------------------------------------

const SKY: [number, string][] = [
  [0, "clear"], [1, "mostly clear"], [2, "partly cloudy"], [3, "overcast"], [48, "foggy"], [57, "drizzling"],
  [67, "rainy"], [77, "snowy"], [82, "showery"], [86, "snow showers"], [99, "stormy"],
];
const sky = (code: number) => SKY.find(([limit]) => code <= limit)?.[1] ?? "unsettled";

// Without a named place, the computer's timezone says where home is, with no location lookup.
export function homeCity(zone = Intl.DateTimeFormat().resolvedOptions().timeZone): string {
  return zone.split("/").pop()?.replace(/_/g, " ") ?? "";
}

type Forecast = {
  current: { temperature_2m: number; weather_code: number };
  daily: { temperature_2m_max: number[]; temperature_2m_min: number[]; weather_code: number[]; precipitation_probability_max: number[] };
};

export function weatherSentence(place: string, data: Forecast, tomorrow: boolean): string {
  const day = tomorrow ? 1 : 0;
  const high = Math.round(data.daily.temperature_2m_max[day]);
  const low = Math.round(data.daily.temperature_2m_min[day]);
  const rain = data.daily.precipitation_probability_max[day];
  const chance = rain >= 30 ? `, with a ${rain} percent chance of rain` : "";
  if (tomorrow) return `Tomorrow in ${place} looks ${sky(data.daily.weather_code[1])}, ${low} to ${high} degrees${chance}, sir.`;
  return `It's ${Math.round(data.current.temperature_2m)} degrees and ${sky(data.current.weather_code)} in ${place}, sir, with a high of ${high}${chance}.`;
}

async function getWeather(args: Args, ctx: Context): Promise<Result> {
  const place = text(args.location) || homeCity();
  if (ctx.dryRun) return { ok: true, say: `Checking the weather in ${place}, sir.` };
  try {
    const find = await fetch(`https://geocoding-api.open-meteo.com/v1/search?count=1&format=json&name=${encodeURIComponent(place)}`, { signal: AbortSignal.timeout(6000) });
    const spot = ((await find.json()) as { results?: { latitude: number; longitude: number; name: string }[] }).results?.[0];
    if (!spot) return { ok: false, say: `I can't find a place called ${place}, sir.` };
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${spot.latitude}&longitude=${spot.longitude}&current=temperature_2m,weather_code&daily=temperature_2m_max,temperature_2m_min,weather_code,precipitation_probability_max&forecast_days=2&timezone=auto`;
    const response = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!response.ok) throw new Error(String(response.status));
    return { ok: true, say: weatherSentence(spot.name, (await response.json()) as Forecast, /tomorrow/i.test(text(args.when))) };
  } catch {
    return { ok: false, say: "I can't reach the weather service right now, sir." };
  }
}

// ---- Web answers ------------------------------------------------------------

async function askWeb(args: Args, ctx: Context): Promise<Result> {
  const question = text(args.question);
  if (!question) return { ok: false, say: "What should I look up, sir?" };
  if (ctx.dryRun) return { ok: true, say: `Looking up ${question}, sir.` };
  ctx.ack?.("Let me check, sir.");
  try {
    const answer = await webAnswer(question, "qwen3.5:2b");
    if (answer === null) return { ok: false, say: "My web search isn't responding, sir." };
    return { ok: true, say: answer || `I couldn't find anything on that, sir.` };
  } catch {
    return { ok: false, say: "My web search isn't running right now, sir. Say google if you want it in Brave." };
  }
}

// ---- Sound and media --------------------------------------------------------

const SINK = "@DEFAULT_AUDIO_SINK@";

async function setVolume(args: Args, ctx: Context): Promise<Result> {
  const level = text(args.level).toLowerCase();
  if (level === "mute" || level === "unmute") {
    if (!ctx.dryRun) await run("wpctl", ["set-mute", SINK, level === "mute" ? "1" : "0"]);
    return { ok: true, say: level === "mute" ? "Muted, sir." : "Sound is back on, sir." };
  }
  const value = Number(level.replace("%", ""));
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    return { ok: false, say: "Volume goes from 0 to 100, sir." };
  }
  if (!ctx.dryRun) await run("wpctl", ["set-volume", SINK, `${Math.round(value)}%`]);
  return { ok: true, say: `Volume at ${Math.round(value)}, sir.` };
}

const MEDIA: Record<string, string> = { play: "Play", pause: "Pause", next: "Next", previous: "Previous" };

async function mediaControl(args: Args, ctx: Context): Promise<Result> {
  const method = MEDIA[text(args.action).toLowerCase()];
  if (!method) return { ok: false, say: "I can play, pause, or skip, sir." };
  if (ctx.dryRun) return { ok: true, say: "Done, sir." };
  const listed = await run("gdbus", [
    "call", "--session", "--dest", "org.freedesktop.DBus", "--object-path", "/org/freedesktop/DBus",
    "--method", "org.freedesktop.DBus.ListNames",
  ]);
  const players = listed.stdout.match(/org\.mpris\.MediaPlayer2\.[\w.-]+/g) ?? [];
  if (!players.length) return { ok: false, say: "Nothing is playing, sir." };
  await run("gdbus", [
    "call", "--session", "--dest", players[0]!, "--object-path", "/org/mpris/MediaPlayer2",
    "--method", `org.mpris.MediaPlayer2.Player.${method}`,
  ]);
  return { ok: true, say: "Done, sir." };
}

// ---- System information -----------------------------------------------------

function battery(): string {
  const root = "/sys/class/power_supply";
  const name = existsSync(root) ? readdirSync(root).find((entry) => entry.startsWith("BAT")) : undefined;
  if (!name) return "I can't find a battery, sir.";
  const percent = readFileSync(join(root, name, "capacity"), "utf8").trim();
  const status = readFileSync(join(root, name, "status"), "utf8").trim().toLowerCase();
  return `Battery is at ${percent} percent and ${status}, sir.`;
}

function systemInfo(args: Args): Result {
  const what = text(args.what).toLowerCase();
  const gb = (bytes: number) => (bytes / 2 ** 30).toFixed(0);
  if (what.includes("batter")) return { ok: true, say: battery() };
  if (what.includes("cpu")) {
    const percent = Math.min(100, Math.round((loadavg()[0] / cpus().length) * 100));
    return { ok: true, say: `CPU load is about ${percent} percent, sir.` };
  }
  if (what.includes("mem") || what.includes("ram")) {
    return { ok: true, say: `${gb(totalmem() - freemem())} of ${gb(totalmem())} gigabytes of memory are in use, sir.` };
  }
  if (what.includes("disk") || what.includes("storage") || what.includes("space")) {
    const disk = statfsSync(homedir());
    return { ok: true, say: `${gb(disk.bavail * disk.bsize)} gigabytes are free on your disk, sir.` };
  }
  if (what.includes("net") || what.includes("wifi") || what.includes("internet")) {
    const online = Object.values(networkInterfaces()).flat().some((a) => a && !a.internal && a.family === "IPv4");
    return { ok: true, say: online ? "You're connected to a network, sir." : "You're offline, sir." };
  }
  return { ok: false, say: "I can check battery, CPU, memory, disk or network, sir." };
}

// ---- Terminal ---------------------------------------------------------------

export async function runApproved(command: string): Promise<Result> {
  try {
    const { stdout, stderr } = await run("bash", ["-c", command], {
      cwd: homedir(), // "my Downloads folder" should mean ~/Downloads wherever Jarvis was started.
      timeout: 120_000,
      maxBuffer: 4_000_000,
    });
    const output = (stdout || stderr).trim();
    return { ok: true, say: output ? output.slice(0, 500) : "Done, sir." };
  } catch (error) {
    const failed = error as { stderr?: string; message: string };
    return { ok: false, say: `That failed, sir. ${(failed.stderr || failed.message).trim().slice(0, 300)}` };
  }
}

async function runCommand(args: Args, ctx: Context): Promise<Result> {
  const command = text(args.command);
  if (!command) return { ok: false, say: "I didn't get a command, sir." };
  const level = classify(command);
  if (level !== "run") return { ok: true, say: "", needsApproval: { command, level } };
  return ctx.dryRun ? { ok: true, say: "Done, sir." } : runApproved(command);
}

// ---- Tool table -------------------------------------------------------------

type Tool = {
  description: string;
  // Reached only through exact phrases. Offering it to the model makes it the model's favourite guess.
  fastOnly?: boolean;
  params?: Record<string, string>;
  run: (args: Args, ctx: Context) => Result | Promise<Result>;
};

const later = (feature: string): Result => ({ ok: false, say: `${feature} isn't connected yet, sir.` });

export const TOOLS: Record<string, Tool> = {
  get_time: {
    description: "Get the current time and date.",
    run: (args) => {
      const now = new Date();
      if (/date|day/.test(text(args.want))) {
        const date = now.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
        return { ok: true, say: `It's ${date}, sir.` };
      }
      const time = now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
      return { ok: true, say: `It's ${time}, sir.` };
    },
  },
  get_weather: {
    description: "Get the weather forecast for a place, or for home if no place is named.",
    params: { location: "City name, or empty for home", when: "today or tomorrow" },
    run: getWeather,
  },
  web_answer: {
    description: "Look up something on the internet and read the answer aloud: news, scores, prices, recent events, or anything that may have changed.",
    params: { question: "What to find out" },
    run: askWeb,
  },
  open_app: {
    description: "Open a program on the computer.",
    params: { name: "Program name, like firefox or spotify" },
    run: openApp,
  },
  close_app: { description: "Close a running program.", params: { name: "Program name" }, run: closeApp },
  window_control: {
    description: "Minimize, maximize or focus a program's window.",
    params: { action: "minimize, maximize or focus", name: "Program name" },
    run: windowControl,
  },
  google_search: {
    description: "Open a Google search in Brave. Only when he says the word google.",
    params: { query: "What to search for" },
    run: googleSearch,
  },
  open_website: {
    description: "Open a website in a new Brave browser tab.",
    params: { url: "Website address" },
    run: openWebsite,
  },
  set_volume: {
    description: "Set the system volume.",
    params: { level: "Volume from 0 to 100, or mute or unmute" },
    run: setVolume,
  },
  media_control: {
    description: "Control music or video playback. Next song means next.",
    params: { action: "play, pause, next or previous" },
    run: mediaControl,
  },
  system_info: {
    description: "Read battery, CPU, memory, disk or network status.",
    params: { what: "battery, cpu, memory, disk or network" },
    run: systemInfo,
  },
  list_projects: {
    description: "List his coding projects.",
    fastOnly: true,
    run: () => {
      const names = listProjects();
      if (!names.length) return { ok: true, say: "You don't have any projects yet, sir." };
      return { ok: true, say: `You have ${names.length} projects, sir: ${names.join(", ")}.` };
    },
  },
  start_coding: {
    description: "Open a coding project in the Claude window.",
    params: { project: "Project name" },
    run: (args, ctx) => {
      const spoken = text(args.project);
      const name = findProject(spoken, listProjects());
      if (!name) return { ok: false, say: `I can't find a project called ${spoken}, sir.` };
      if (!ctx.claude) return { ok: true, say: `I found ${name}, sir, but the Claude window only works in the app.` };
      const open = ctx.claude.openProject;
      if (open === name) return { ok: true, say: `${name} is already open, sir.` };
      if (open) return { ok: false, say: `${open} is still open, sir. Tell me to close the project first.` };
      if (!ctx.dryRun) ctx.claude.start(name, join(PROJECTS_ROOT, name));
      return { ok: true, say: `Opening Claude in ${name}, sir.` };
    },
  },
  ask_claude: {
    description: "Send a coding task to the open Claude session: adding features, fixing bugs, changing code or pages.",
    params: { task: "The user's exact request" },
    run: (args, ctx) => {
      if (!ctx.claude) return later("Claude");
      if (!ctx.claude.openProject) return { ok: false, say: "No project is open, sir. Tell me which one to start." };
      if (!ctx.claude.ask(text(args.task))) return { ok: false, say: "There's no Claude session open, sir." };
      return { ok: true, say: "Passing that to Claude, sir." };
    },
  },
  close_project: {
    description: "Close the open coding project and everything in it, when he says he is done coding.",
    run: (_args, ctx) => {
      if (!ctx.claude?.openProject) return { ok: true, say: "Nothing is open, sir." };
      const name = ctx.claude.openProject;
      if (!ctx.dryRun) ctx.claude.close();
      return { ok: true, say: `${name} is closed, sir. All its sessions and terminals are shut down.` };
    },
  },
  run_command: {
    description: "Run a shell command for anything no other tool covers, like managing files or installing software.",
    params: { command: "The shell command" },
    run: runCommand,
  },
};

export function toolSchemas() {
  return Object.entries(TOOLS).filter(([, tool]) => !tool.fastOnly).map(([name, tool]) => ({
    type: "function",
    function: {
      name,
      description: tool.description,
      parameters: {
        type: "object",
        properties: Object.fromEntries(
          Object.entries(tool.params ?? {}).map(([key, description]) => [key, { type: "string", description }]),
        ),
        required: Object.keys(tool.params ?? {}),
      },
    },
  }));
}
