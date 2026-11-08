// Everything Jarvis can do on the computer. Shortcut tools start programs directly with
// no shell, so text from the model can't smuggle in extra commands.
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statfsSync, statSync, writeFileSync } from "node:fs";
import { cpus, freemem, homedir, loadavg, networkInterfaces, totalmem } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";

import type { Memory } from "./memory.ts";
import { findProject, listProjects, PROJECTS_ROOT, validProjectName } from "./projects.ts";
import { classify, type Level } from "./safety.ts";
import { SMALL_MODEL } from "./ollama.ts";
import { answerPrompt, searchWeb, webAnswer } from "./web.ts";
import { controlWindow, knownAction, listWindows, NOT_INSTALLED, pickWindow } from "./windows.ts";

const run = promisify(execFile);
const BRAVE = "/snap/bin/brave";

export type Args = Record<string, unknown>;
export type Result = {
  say: string;
  // When what's shown doesn't suit being read aloud, like terminal output.
  spoken?: string;
  ok: boolean;
  // Set when a command must wait for the user before running.
  needsApproval?: { command: string; level: Level; title?: string };
};
export type ClaudeControl = {
  openProject: string | null;
  start(project: string, path: string): void;
  ask(task: string): boolean;
  close(): void;
  setEffort?(level: string): boolean;
  setModel?(name: string): string | null;
  newSession?(): void;
  newTerminal?(): void;
  archive?(): string | null;
  setVisible?(visible: boolean): void;
  interrupt?(): boolean;
};
export type Context = {
  dryRun: boolean;
  claude?: ClaudeControl;
  ack?: (words: string) => void;
  projects?: () => string[];
  reminders?: Pick<Memory, "addReminder" | "reminders" | "clearReminders">;
  // Sends a question to Claude. Only the real app has this, so tests never spend plan usage.
  // "deep" asks for the stronger, costlier model; everything else uses the quick one.
  thinker?: (prompt: string, onText?: (delta: string) => void, tier?: "quick" | "deep") => Promise<string | null>;
  // Starts speaking an answer while it's still being written.
  speech?: () => { push: (delta: string) => void; end: () => void; spoke: boolean } | null;
  clipboard?: { read(): string | Promise<string>; write(text: string): void };
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
  "file manager": "files", "text editor": "text editor", terminal: "ptyxis",
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
  const raw = spoken.trim().toLowerCase().replace(/^(a|an|the|my)\s+/, "");
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
    const results = await searchWeb(question);
    if (results === null) return { ok: false, say: "My web search isn't responding, sir." };
    if (!results.length) return { ok: true, say: "I couldn't find anything on that, sir." };
    // Claude reads the results far more accurately than the small model, and with no tools, so
    // a web page can only change the words of the answer. It's spoken as it's written.
    if (ctx.thinker) {
      const speech = ctx.speech?.();
      const best = await ctx.thinker(answerPrompt(question, results), speech?.push).catch(() => null);
      speech?.end();
      if (best) return { ok: true, say: best.replace(/\*\*?|`/g, "").trim(), spoken: speech?.spoke ? "" : undefined };
    }
    const answer = await webAnswer(question, SMALL_MODEL, results);
    return { ok: true, say: answer || "I couldn't find anything on that, sir." };
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
  // A step from wherever it is now. The cap keeps it from going past full, which distorts.
  if (level === "up" || level === "down") {
    if (!ctx.dryRun) await run("wpctl", ["set-volume", "-l", "1.0", SINK, level === "up" ? "10%+" : "10%-"]);
    return { ok: true, say: level === "up" ? "Louder, sir." : "Quieter, sir." };
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

// ---- Folders and projects ---------------------------------------------------

const FOLDERS: Record<string, string> = {
  downloads: "Downloads", documents: "Documents", desktop: "Desktop", pictures: "Pictures",
  music: "Music", videos: "Videos", home: "",
};

export function describeFolder(label: string, names: string[]): string {
  const visible = names.filter((name) => !name.startsWith(".")).sort();
  if (!visible.length) return `Your ${label} folder is empty, sir.`;
  const count = `${visible.length} ${visible.length === 1 ? "item" : "items"}`;
  if (visible.length <= 8) return `You have ${count} in ${label}, sir: ${visible.join(", ")}.`;
  return `You have ${count} in ${label}, sir, including ${visible.slice(0, 6).join(", ")}.`;
}

export function describeSize(label: string, bytes: number): string {
  if (bytes >= 2 ** 30) return `Your ${label} folder is ${(bytes / 2 ** 30).toFixed(1)} gigabytes, sir.`;
  if (bytes >= 2 ** 20) return `Your ${label} folder is ${Math.round(bytes / 2 ** 20)} megabytes, sir.`;
  return `Your ${label} folder is under one megabyte, sir.`;
}

async function folderInfo(args: Args): Promise<Result> {
  const key = text(args.folder).toLowerCase();
  if (!(key in FOLDERS)) return { ok: false, say: "I can't find that folder, sir." };
  const path = join(homedir(), FOLDERS[key]);
  const label = FOLDERS[key] || "home";
  if (!existsSync(path)) return { ok: false, say: `You don't have a ${label} folder, sir.` };
  if (text(args.want) === "size") {
    const { stdout } = await run("du", ["-sb", path], { timeout: 20_000 });
    return { ok: true, say: describeSize(label, Number(stdout.split(/\s/)[0])) };
  }
  return { ok: true, say: describeFolder(label, readdirSync(path)) };
}

// What a project is, from its own files, so a question about it stays about your project.
export function projectSummary(name: string, root = PROJECTS_ROOT): string {
  const folder = join(root, name);
  const clip = (value: string) => value.replace(/[#*_`>[\]]/g, "").replace(/\s+/g, " ").trim().slice(0, 180);
  try {
    const description = JSON.parse(readFileSync(join(folder, "package.json"), "utf8")).description;
    if (typeof description === "string" && description.trim()) return `${name} is one of your projects, sir: ${clip(description)}.`;
  } catch {
    // Not every project has a package.json.
  }
  try {
    const readme = readFileSync(join(folder, "README.md"), "utf8");
    const paragraph = readme.split(/\n\s*\n/).map(clip).find((part) => part.length > 20 && !part.startsWith("!"));
    if (paragraph) return `${name} is one of your projects, sir: ${paragraph}.`;
  } catch {
    // Nor a README.
  }
  return `${name} is one of your projects, sir. Tell me to start working on it and Claude can explain it.`;
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
    if (!output) return { ok: true, say: "Done, sir." };
    return { ok: true, say: output.slice(0, 1500), spoken: "Done, sir. The result is in the chat." };
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

// ---- Everyday abilities -----------------------------------------------------

// Spoken words about the user, turned round for Jarvis to say back.
export const inYourWords = (words: string) => words.replace(/\bmy\b/gi, "your").replace(/\bI\b/g, "you").replace(/\bme\b/gi, "you");

function clockTime(due: number, now = Date.now()): string {
  const time = new Date(due).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  const days = Math.round((new Date(due).setHours(0, 0, 0, 0) - new Date(now).setHours(0, 0, 0, 0)) / 86_400_000);
  return days === 0 ? time : days === 1 ? `${time} tomorrow` : new Date(due).toLocaleDateString("en-GB", { weekday: "long", hour: "2-digit", minute: "2-digit" });
}

// "5 minutes" reads as "your 5 minute timer".
const timerLength = (words: string) => words.replace(/(\d+ (?:hour|minute|second))s\b/g, "$1");

// What's said when a reminder goes off.
export function reminderMessage(kind: string, words: string, due: number, now = Date.now()): string {
  const late = now - due > 120_000 ? `I was closed at ${clockTime(due, now)}, sir, so this is late. ` : "";
  if (kind === "timer") return `${late}Your ${timerLength(words)} timer is up, sir.`;
  if (kind === "alarm") return `${late}Time to wake up, sir.`;
  return `${late}A reminder, sir: ${inYourWords(words) || "you asked me to remind you about something"}.`;
}

function setReminder(args: Args, ctx: Context): Result {
  if (!ctx.reminders) return { ok: false, say: "I can't keep reminders right now, sir." };
  const due = Number(args.due);
  const kind = text(args.kind);
  const words = text(args.text);
  if (!ctx.dryRun) ctx.reminders.addReminder(kind, words, due);
  if (kind === "timer") return { ok: true, say: `Timer set for ${words}, sir.` };
  if (kind === "alarm") return { ok: true, say: `I'll wake you at ${clockTime(due)}, sir.` };
  return { ok: true, say: `I'll remind you at ${clockTime(due)}, sir${words ? `: ${inYourWords(words)}` : ""}.` };
}

function listReminders(ctx: Context): Result {
  const list = ctx.reminders?.reminders() ?? [];
  if (!list.length) return { ok: true, say: "You have no timers or reminders, sir." };
  const lines = list.map((item) => {
    const what = item.kind === "timer" ? `a ${timerLength(item.text)} timer` : item.kind === "alarm" ? "an alarm" : item.text ? `a reminder to ${inYourWords(item.text)}` : "a reminder";
    return `${what} at ${clockTime(item.due)}`;
  });
  return { ok: true, say: `You have ${lines.join(", ")}, sir.` };
}

const POWER: Record<string, { command: string; word: string }> = {
  shutdown: { command: "systemctl poweroff", word: "shut the computer down" },
  restart: { command: "systemctl reboot", word: "restart the computer" },
  sleep: { command: "systemctl suspend", word: "put the computer to sleep" },
  logout: { command: "gnome-session-quit --logout --no-prompt", word: "log you out" },
  trash: { command: "gio trash --empty", word: "empty the trash for good" },
};

// Snap-packaged parents leave their own settings list behind, which hides the system's keys.
function desktopEnv() {
  const env = { ...process.env };
  delete env.GSETTINGS_SCHEMA_DIR;
  delete env.GSETTINGS_BACKEND;
  delete env.XDG_DATA_DIRS;
  return env;
}

const BACKLIGHT = "/sys/class/backlight";

async function setBrightness(args: Args, ctx: Context): Promise<Result> {
  const device = existsSync(BACKLIGHT) ? readdirSync(BACKLIGHT)[0] : undefined;
  if (!device) return { ok: false, say: "I can't find a screen I can dim, sir." };
  const read = (file: string) => Number(readFileSync(join(BACKLIGHT, device, file), "utf8"));
  const max = read("max_brightness");
  const current = (read("brightness") / max) * 100;
  const wanted = args.level !== undefined ? Number(args.level) : current + Number(args.step);
  // A completely black screen would leave him unable to see how to undo it.
  const percent = Math.round(Math.min(100, Math.max(5, wanted)));
  if (!ctx.dryRun) {
    await run("busctl", ["call", "org.freedesktop.login1", "/org/freedesktop/login1/session/auto", "org.freedesktop.login1.Session", "SetBrightness", "ssu", "backlight", device, String(Math.round((percent / 100) * max))]);
  }
  return { ok: true, say: `Brightness at ${percent}, sir.` };
}

async function setRadio(args: Args, ctx: Context): Promise<Result> {
  const on = text(args.on) === "true";
  const bluetooth = text(args.what) === "bluetooth";
  if (!ctx.dryRun) {
    if (bluetooth) await run("rfkill", [on ? "unblock" : "block", "bluetooth"]);
    else await run("nmcli", ["radio", "wifi", on ? "on" : "off"]);
  }
  return { ok: true, say: `${bluetooth ? "Bluetooth" : "Wi-Fi"} is ${on ? "on" : "off"}, sir.` };
}

async function setColorScheme(args: Args, ctx: Context): Promise<Result> {
  const dark = text(args.mode) === "dark";
  if (!ctx.dryRun) await run("gsettings", ["set", "org.gnome.desktop.interface", "color-scheme", dark ? "prefer-dark" : "default"], { env: desktopEnv() });
  return { ok: true, say: `${dark ? "Dark" : "Light"} mode, sir.` };
}

async function takeScreenshot(ctx: Context): Promise<Result> {
  if (ctx.dryRun) return { ok: true, say: "Screenshot taken, sir." };
  // GNOME refuses other programs directly, so this goes through the desktop's official route.
  const folder = join(homedir(), "Pictures");
  const newest = () => Math.max(0, ...readdirSync(folder).filter((name) => name.startsWith("Screenshot") && name.endsWith(".png")).map((name) => statSync(join(folder, name)).mtimeMs));
  const before = existsSync(folder) ? newest() : 0;
  await run("gdbus", ["call", "--session", "--dest", "org.freedesktop.portal.Desktop", "--object-path", "/org/freedesktop/portal/desktop", "--method", "org.freedesktop.portal.Screenshot.Screenshot", "", "{'interactive': <false>}"]);
  for (let tries = 0; tries < 20; tries++) {
    await new Promise((done) => setTimeout(done, 150));
    if (existsSync(folder) && newest() > before) return { ok: true, say: "Screenshot saved in your Pictures folder, sir." };
  }
  return { ok: false, say: "The desktop didn't give me a screenshot, sir." };
}

async function nowPlaying(ctx: Context): Promise<Result> {
  if (ctx.dryRun) return { ok: true, say: "Nothing is playing, sir." };
  const listed = await run("gdbus", ["call", "--session", "--dest", "org.freedesktop.DBus", "--object-path", "/org/freedesktop/DBus", "--method", "org.freedesktop.DBus.ListNames"]);
  for (const player of listed.stdout.match(/org\.mpris\.MediaPlayer2\.[\w.-]+/g) ?? []) {
    const get = (name: string) => run("gdbus", ["call", "--session", "--dest", player, "--object-path", "/org/mpris/MediaPlayer2", "--method", "org.freedesktop.DBus.Properties.Get", "org.mpris.MediaPlayer2.Player", name]).then((out) => out.stdout, () => "");
    if (!(await get("PlaybackStatus")).includes("Playing")) continue;
    const metadata = await get("Metadata");
    const title = metadata.match(/'xesam:title': <'([^']*)'>/)?.[1];
    const artist = metadata.match(/'xesam:artist': <\['([^']*)'/)?.[1];
    if (title) return { ok: true, say: artist ? `${title}, by ${artist}, sir.` : `${title}, sir.` };
  }
  return { ok: true, say: "Nothing is playing, sir." };
}

// Skips hidden folders and installed code, which would drown out his own files.
export function findArgs(home: string, name: string): string[] {
  const pattern = `*${name.replace(/[*?[\]\\]/g, "").trim().replace(/\s+/g, "*")}*`;
  return [home, "(", "-name", ".*", "-o", "-name", "node_modules", "-o", "-name", "snap", "-o", "-name", "__pycache__", "-o", "-name", "go", "-o", "-name", "site-packages", "-o", "-name", "vendor", "-o", "-name", "dist", "-o", "-name", "out", "-o", "-name", "target", ")", "-prune", "-o", "-type", "f", "-iname", pattern, "-print"];
}

// His own files first, and whole-word matches over accidental ones: "cv" shouldn't mean "recv.c".
export function rankFiles(files: string[], name: string, home: string): string[] {
  const words = name.toLowerCase().split(/\s+/).filter(Boolean);
  const score = (file: string) => {
    const parts = basename(file).toLowerCase().split(/[^\p{L}\p{N}]+/u);
    const whole = words.every((word) => parts.includes(word)) ? 0 : 4;
    const personal = /^(Documents|Downloads|Desktop|Pictures|Music|Videos)\//.test(file.slice(home.length + 1)) && !file.includes("/Documents/Projects/") ? 0 : 1;
    return whole + personal;
  };
  const ranked = files.map((file) => ({ file, rank: score(file) })).sort((a, b) => a.rank - b.rank);
  // If real matches exist, the accidental ones are just noise.
  return ranked.filter((item) => item.rank < 4 || ranked[0].rank >= 4).map((item) => item.file);
}

async function findFile(args: Args): Promise<Result> {
  const name = text(args.name);
  const home = homedir();
  // A timeout still leaves whatever was found so far.
  const output = await run("find", findArgs(home, name), { timeout: 15_000, maxBuffer: 4_000_000 }).then((out) => out.stdout, (error: { stdout?: string }) => error.stdout ?? "");
  const files = rankFiles(output.split("\n").filter(Boolean), name, home);
  if (!files.length) return { ok: true, say: `I can't find a file called ${name}, sir.` };
  const shown = files.slice(0, 5).map((file) => file.replace(home, "~"));
  const more = files.length > 5 ? `, and ${files.length - 5} more` : "";
  return { ok: true, say: `I found ${files.length === 1 ? "this" : `${files.length} files`}, sir:\n${shown.join("\n")}${more}`, spoken: files.length === 1 ? `I found it, sir: ${basename(files[0])}. It's in the chat.` : `I found ${files.length} files, sir. They're in the chat.` };
}

function createItem(args: Args, ctx: Context): Result {
  const key = text(args.folder).toLowerCase();
  const name = text(args.name);
  const isFile = text(args.kind) === "file";
  if (!(key in FOLDERS) || !validProjectName(name)) return { ok: false, say: "I can't use that name, sir. Keep it to letters, numbers, dots and dashes." };
  const path = join(homedir(), FOLDERS[key], name);
  const where = FOLDERS[key] || "your home folder";
  if (existsSync(path)) return { ok: false, say: `${name} already exists in ${where}, sir, so I left it alone.` };
  if (!ctx.dryRun) {
    if (isFile) writeFileSync(path, "", { flag: "wx" });
    else mkdirSync(path);
  }
  return { ok: true, say: `${name} is in ${where}, sir.` };
}

async function minimizeAll(ctx: Context): Promise<Result> {
  try {
    const windows = await listWindows();
    const others = windows.filter((window) => !/^jarvis$/i.test(window.wm_class) && !/^jarvis$/i.test(window.title));
    if (!ctx.dryRun) for (const window of others) await controlWindow(window, "minimize").catch(() => {});
    return { ok: true, say: "All clear, sir." };
  } catch {
    return { ok: false, say: "The window control extension isn't responding, sir." };
  }
}

function createProject(args: Args, ctx: Context): Result {
  const name = text(args.name);
  if (!validProjectName(name)) return { ok: false, say: "I can't use that as a folder name, sir. Keep it to letters, numbers, dots and dashes." };
  const names = ctx.projects?.() ?? listProjects();
  const existing = names.find((item) => item.toLowerCase() === name.toLowerCase());
  const open = ctx.claude?.openProject;
  if (open) return { ok: false, say: `${open} is still open, sir. Tell me to close the project first.` };
  const path = join(PROJECTS_ROOT, existing ?? name);
  if (!ctx.dryRun) {
    if (!existing) mkdirSync(path);
    ctx.claude?.start(existing ?? name, path);
  }
  return { ok: true, say: existing ? `You already have ${existing}, sir. Opening Claude in it.` : `${name} is created, sir. Opening Claude in it.` };
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
    params: { level: "Volume from 0 to 100, or up, down, mute or unmute" },
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
  folder_info: {
    description: "What's in a personal folder, or how big it is.",
    fastOnly: true,
    run: folderInfo,
  },
  project_info: {
    description: "What one of his projects is.",
    fastOnly: true,
    run: (args) => ({ ok: true, say: projectSummary(text(args.project)) }),
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
      const name = findProject(spoken, ctx.projects?.() ?? listProjects());
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
  say: { description: "A fixed answer.", fastOnly: true, run: (args) => ({ ok: true, say: text(args.say) }) },
  set_reminder: { description: "Set a timer, alarm or reminder.", fastOnly: true, run: setReminder },
  list_reminders: { description: "List timers and reminders.", fastOnly: true, run: (_args, ctx) => listReminders(ctx) },
  clear_reminders: {
    description: "Cancel all timers and reminders.",
    fastOnly: true,
    run: (_args, ctx) => {
      const gone = ctx.dryRun ? 0 : (ctx.reminders?.clearReminders() ?? 0);
      return { ok: true, say: gone ? "All cancelled, sir." : "There was nothing to cancel, sir." };
    },
  },
  power: {
    description: "Shut down, restart, sleep, log out, or empty the trash. Always asks first.",
    fastOnly: true,
    run: (args) => {
      const action = POWER[text(args.action)];
      if (!action) return { ok: false, say: "I can't do that, sir." };
      return { ok: true, say: "", needsApproval: { command: action.command, level: "confirm", title: `Shall I ${action.word}?` } };
    },
  },
  lock_screen: {
    description: "Lock the screen.",
    fastOnly: true,
    run: async (_args, ctx) => {
      if (!ctx.dryRun) await run("gdbus", ["call", "--session", "--dest", "org.gnome.ScreenSaver", "--object-path", "/org/gnome/ScreenSaver", "--method", "org.gnome.ScreenSaver.Lock"]);
      return { ok: true, say: "Locking the screen, sir." };
    },
  },
  screenshot: { description: "Take a screenshot.", fastOnly: true, run: (_args, ctx) => takeScreenshot(ctx) },
  brightness: { description: "Set screen brightness.", fastOnly: true, run: setBrightness },
  radio: { description: "Turn Wi-Fi or Bluetooth on or off.", fastOnly: true, run: setRadio },
  color_scheme: { description: "Switch the desktop between dark and light.", fastOnly: true, run: setColorScheme },
  open_folder: {
    description: "Open a personal folder in the file manager.",
    fastOnly: true,
    run: (args, ctx) => {
      const key = text(args.folder).toLowerCase();
      if (!(key in FOLDERS)) return { ok: false, say: "I can't find that folder, sir." };
      if (!ctx.dryRun) launch("xdg-open", [join(homedir(), FOLDERS[key])]);
      return { ok: true, say: `Opening ${FOLDERS[key] || "your home folder"}, sir.` };
    },
  },
  create_item: { description: "Create a file or folder in a personal folder.", fastOnly: true, run: createItem },
  find_file: { description: "Find a file by name.", fastOnly: true, run: findFile },
  minimize_all: { description: "Minimize every window except Jarvis.", fastOnly: true, run: (_args, ctx) => minimizeAll(ctx) },
  now_playing: { description: "Say what's playing.", fastOnly: true, run: (_args, ctx) => nowPlaying(ctx) },
  youtube: {
    description: "Search YouTube in Brave.",
    fastOnly: true,
    run: (args, ctx) => {
      const query = text(args.query);
      if (!ctx.dryRun) launch(BRAVE, [`https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`]);
      return { ok: true, say: `Searching YouTube for ${query}, sir.` };
    },
  },
  clipboard: {
    description: "Read or set the clipboard.",
    fastOnly: true,
    run: async (args, ctx) => {
      if (!ctx.clipboard) return { ok: false, say: "I can only reach the clipboard from the app, sir." };
      if (args.write !== undefined) {
        ctx.clipboard.write(text(args.write));
        return { ok: true, say: "Copied, sir." };
      }
      const held = (await ctx.clipboard.read()).trim();
      if (!held) return { ok: true, say: "Your clipboard is empty, sir." };
      return { ok: true, say: `Your clipboard says:\n${held.slice(0, 1000)}`, spoken: held.length <= 120 ? `Your clipboard says: ${held}` : "It's a long one, sir. It's in the chat." };
    },
  },
  my_ip: {
    description: "Say this computer's address on the local network.",
    fastOnly: true,
    run: () => {
      const address = Object.values(networkInterfaces()).flat().find((item) => item && !item.internal && item.family === "IPv4")?.address;
      return { ok: true, say: address ? `Your address on this network is ${address}, sir.` : "You're not on a network, sir." };
    },
  },
  create_project: { description: "Create a new project folder and open Claude in it.", fastOnly: true, run: createProject },
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
