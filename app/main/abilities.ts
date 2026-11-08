// Recognizes everyday requests with exact rules. Timers, power and the like must never depend on
// the small model's guess: left to it, "set a timer" set the volume and "shut down" closed a project.
import type { Call } from "./fastpath.ts";

const SMALL_NUMBERS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  fifteen: 15, twenty: 20, thirty: 30, forty: 40, "forty five": 45, fifty: 50, sixty: 60,
};
const UNIT_SECONDS: Record<string, number> = { second: 1, sec: 1, minute: 60, min: 60, hour: 3600, hr: 3600, day: 86400 };
const DELAY = /\b(half an?|forty five|\d+(?:\.\d+)?|an?|one|two|three|four|five|six|seven|eight|nine|ten|fifteen|twenty|thirty|forty|fifty|sixty)[ -]*(second|sec|minute|min|hour|hr|day)s?\b/gi;
const CLOCK = /\bat\s+(noon|midday|midnight|\d{1,2}(?::\d{2})?(?:\s*(?:am|pm|a\.m\.?|p\.m\.?))?)(?![\d:])/i;

// Seconds described in the text: "an hour and 30 minutes". Null if there's no length of time.
export function parseDelay(text: string): number | null {
  let total = 0;
  for (const match of text.matchAll(DELAY)) {
    const amount = /^half/i.test(match[1]) ? 0.5 : (SMALL_NUMBERS[match[1].toLowerCase()] ?? Number(match[1]));
    total += amount * UNIT_SECONDS[match[2].toLowerCase()];
  }
  return total > 0 ? total : null;
}

// The next time the clock reads what was said. Without am or pm, the sooner of the two,
// except that nobody asks to be woken up in the evening.
export function parseClock(text: string, now: Date, morning = false): number | null {
  const found = text.match(CLOCK)?.[1].toLowerCase();
  if (!found) return null;
  let hour: number;
  let minute = 0;
  let certain = true;
  if (found === "noon" || found === "midday") hour = 12;
  else if (found === "midnight") hour = 0;
  else {
    const parts = found.match(/^(\d{1,2})(?::(\d{2}))?\s*([ap])?/)!;
    hour = Number(parts[1]);
    minute = Number(parts[2] ?? 0);
    if (hour > 23 || minute > 59) return null;
    if (parts[3]) {
      if (hour > 12 || hour === 0) return null;
      hour = (hour % 12) + (parts[3] === "p" ? 12 : 0);
    } else if (hour <= 12 && hour !== 0) certain = false;
  }
  const at = (h: number, days = 0) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + days, h, minute).getTime();
  const tomorrow = /\btomorrow\b/i.test(text) ? 1 : 0;
  const options = certain ? [hour] : morning ? [hour % 12] : [hour % 12, (hour % 12) + 12];
  const times = options.flatMap((h) => [at(h, tomorrow), at(h, tomorrow + 1)]).filter((time) => time > now.getTime());
  return times.length ? Math.min(...times) : null;
}

export function describeLength(seconds: number): string {
  const parts: string[] = [];
  const add = (value: number, unit: string) => value && parts.push(`${value} ${unit}${value === 1 ? "" : "s"}`);
  add(Math.floor(seconds / 3600), "hour");
  add(Math.floor((seconds % 3600) / 60), "minute");
  add(Math.round(seconds % 60), "second");
  return parts.join(" and ");
}

// A small calculator of its own: + - * / and brackets, and nothing else can run.
function evaluate(expression: string): number | null {
  const tokens = expression.match(/\d+(?:\.\d+)?|[-+*/()]/g) ?? [];
  if (tokens.join("") !== expression.replace(/\s/g, "")) return null;
  let at = 0;
  const atom = (): number => {
    const token = tokens[at++];
    if (token === "(") {
      const value = sum();
      if (tokens[at++] !== ")") throw new Error("bracket");
      return value;
    }
    if (token === "-") return -atom();
    if (token === undefined || !/^\d/.test(token)) throw new Error("number");
    return Number(token);
  };
  const product = (): number => {
    let value = atom();
    while (tokens[at] === "*" || tokens[at] === "/") value = tokens[at++] === "*" ? value * atom() : value / atom();
    return value;
  };
  const sum = (): number => {
    let value = product();
    while (tokens[at] === "+" || tokens[at] === "-") value = tokens[at++] === "+" ? value + product() : value - product();
    return value;
  };
  try {
    const value = sum();
    return at === tokens.length && Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

// "what's 15 percent of 240" or "128 times 47". Returns null if it isn't arithmetic.
export function calculate(said: string): number | null {
  const text = said.toLowerCase().replace(/^(what'?s|what is|how much is|calculate|compute|work out)\s+/, "").replace(/,(?=\d)/g, "");
  const percent = text.match(/^(\d+(?:\.\d+)?)\s*(?:%|percent)\s+of\s+(\d+(?:\.\d+)?)$/);
  if (percent) return (Number(percent[1]) * Number(percent[2])) / 100;
  const expression = text
    .replace(/\b(multiplied by|times)\b|\bx\b/g, "*")
    .replace(/\b(divided by|over)\b/g, "/")
    .replace(/\bplus\b/g, "+")
    .replace(/\bminus\b/g, "-");
  if (!/\d\s*[-+*/]\s*[(\d-]/.test(expression) || /[a-z]/.test(expression)) return null;
  return evaluate(expression);
}

const COMPUTER = "(?:the |my |this )?(?:computer|laptop|pc|machine|system)";
const FOLDER = "(?:my |the )?(downloads|documents|desktop|pictures|music|videos|home)(?: folder)?";

export const CAPABILITIES = "I can open and close programs and windows, set timers and reminders, do sums, take screenshots, control volume, media, brightness, Wi-Fi, Bluetooth and the theme, lock or shut down the computer, find files, make folders, search the web, check the weather, remember what you tell me, and hand harder work to Claude, sir. I can't read your email or calendar.";

export function abilityCall(text: string, now = new Date()): Call | null {
  const lower = text.toLowerCase().replace(/[.!?]+$/, "").trim();
  let match: RegExpMatchArray | null;
  const say = (words: string): Call => ({ tool: "say", args: { say: words } });
  const remind = (kind: string, due: number, words: string): Call => ({ tool: "set_reminder", args: { kind, due: String(due), text: words } });

  if (/^(what can you do|what are you able to do|what do you do|help|what are your (abilities|skills|capabilities))$/.test(lower)) return say(CAPABILITIES);
  // "How does a screenshot work" and "why do timers drift" want an explanation, not the action.
  const explaining = /^(how (do|does|did|is|are|can|could|would|should|to)|why|explain|what (is|are|does|do) (a|an)|what does|is it (safe|bad|ok|okay|normal)|tell me (about|how|why))\b/.test(lower);

  // ---- Timers, reminders, alarms
  if (/\b(cancel|stop|clear|delete|remove)\b.*\b(timers?|reminders?|alarms?)\b/.test(lower)) return { tool: "clear_reminders", args: {} };
  if (/\b(show|list|what|any|do i have|read)\b.*\b(timers?|reminders?|alarms?)\b/.test(lower) && !/\b(code|app|page|function)\b/.test(lower)) return { tool: "list_reminders", args: {} };
  if (!explaining && /\btimer\b/.test(lower) && !/\b(code|app|page|component|function|add|fix|build)\b/.test(lower)) {
    const seconds = parseDelay(lower);
    return seconds ? remind("timer", now.getTime() + seconds * 1000, describeLength(seconds)) : say("For how long, sir? Say something like a timer for five minutes.");
  }
  if (/^(wake me( up)?|set (an? |my |the )?alarm)\b/.test(lower)) {
    const seconds = parseDelay(lower);
    const due = seconds ? now.getTime() + seconds * 1000 : parseClock(lower, now, true);
    return due ? remind("alarm", due, "") : say("At what time, sir? Say something like wake me up at seven.");
  }
  if ((match = text.match(/^remind me\b\s*(.*)$/i))) {
    const rest = match[1];
    const seconds = parseDelay(rest);
    const due = seconds ? now.getTime() + seconds * 1000 : parseClock(rest, now);
    if (!due) return say("Tell me when, sir. Say something like remind me in ten minutes to call home.");
    const words = rest
      .replace(new RegExp(`\\b(?:in|after)\\s+${DELAY.source}(?:\\s+and\\s+${DELAY.source})?`, "gi"), " ")
      .replace(CLOCK, " ")
      .replace(/\b(tomorrow|today|tonight)\b/gi, " ")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^(?:to|about|that)\s+/i, "")
      .replace(/[.!?]+$/, "");
    return remind("reminder", due, words);
  }

  // ---- Arithmetic
  const sum = calculate(lower);
  if (sum !== null) return { tool: "say", args: { say: `${Number(sum.toFixed(6)).toLocaleString("en-GB")}, sir.` } };

  // ---- Power, which always asks first
  if (new RegExp(`\\b(shut ?down|power off|turn off|switch off)\\b.*\\b${COMPUTER}$`).test(lower) || /^(shut ?down|power off)$/.test(lower)) return { tool: "power", args: { action: "shutdown" } };
  if (new RegExp(`\\b(restart|reboot)\\b.*\\b${COMPUTER}$`).test(lower) || /^(restart|reboot)$/.test(lower)) return { tool: "power", args: { action: "restart" } };
  if (new RegExp(`^(go to sleep|sleep mode|suspend|hibernate|(suspend|put) ${COMPUTER}( to sleep)?)$`).test(lower)) return { tool: "power", args: { action: "sleep" } };
  if (/^(log|sign) ?(me )?out$/.test(lower)) return { tool: "power", args: { action: "logout" } };
  if (new RegExp(`^lock( ${COMPUTER}| (?:the |my )?(?:screen|session))?$`).test(lower)) return { tool: "lock_screen", args: {} };

  // ---- Screen and radios
  if (!explaining && /\b(screenshot|screen ?shot|screen capture|capture (?:the |my )?screen)\b/.test(lower)) return { tool: "screenshot", args: {} };
  if (!explaining && /\bbrightness\b|\bscreen\b.*\b(brighter|dimmer|darker)\b|\b(brighten|dim)\b.*\bscreen\b/.test(lower) && !/\b(code|app|page)\b/.test(lower)) {
    const level = lower.match(/\b(\d{1,3})\b/)?.[1];
    if (level) return { tool: "brightness", args: { level } };
    if (/\b(up|brighter|brighten|increase|raise|more)\b/.test(lower)) return { tool: "brightness", args: { step: "20" } };
    if (/\b(down|dimmer|darker|dim|lower|decrease|less)\b/.test(lower)) return { tool: "brightness", args: { step: "-20" } };
    return say("What level, sir? Say something like brightness to forty.");
  }
  if (!explaining && /\b(wi-?fi|bluetooth)\b/.test(lower) && (match = lower.match(/\b(on|off|enable|disable)\b/)) && /^(turn|switch|enable|disable|wi-?fi|bluetooth)/.test(lower)) {
    return { tool: "radio", args: { what: lower.includes("bluetooth") ? "bluetooth" : "wifi", on: String(match[1] === "on" || match[1] === "enable") } };
  }
  if ((match = lower.match(/^(?:(?:switch|change|go|turn)(?: on)?(?: to)? |enable |use |set (?:the )?(?:theme|computer|desktop) to )?(?:the )?(dark|light)(?: mode| theme)$/))) return { tool: "color_scheme", args: { mode: match[1] } };

  // ---- Files and folders
  if ((match = lower.match(new RegExp(`^open ${FOLDER}$`)))) return { tool: "open_folder", args: { folder: match[1] } };
  if ((match = text.match(new RegExp(`^(?:create|make)\\s+(?:a |an |new )*(folder|directory|file)\\s+(?:called|named)\\s+(.+?)\\s+(?:in|on)\\s+${FOLDER}$`, "i")))) {
    return { tool: "create_item", args: { kind: match[1].toLowerCase() === "file" ? "file" : "folder", name: match[2], folder: match[3].toLowerCase() } };
  }
  if ((match = text.match(/^(?:find|locate|where(?:'s| is)|look for)\s+(?:my|the file|a file called|the file called)\s+(.+?)(?:\s+files?|\s+documents?)?$/i))) return { tool: "find_file", args: { name: match[1] } };
  if (/^(empty|clear)( out)?( the| my)? (trash|bin|recycle bin|rubbish)$/.test(lower)) return { tool: "power", args: { action: "trash" } };

  // ---- Windows
  if (/^(minimi[sz]e (everything|all( windows)?)|show( me)?( the)? desktop|hide (everything|all( windows)?))$/.test(lower)) return { tool: "minimize_all", args: {} };
  if (/^close (everything|all( the)?( windows| programs| apps)?)$/.test(lower)) return say("That could lose unsaved work, sir, so I'd rather you named the programs.");

  // ---- Media and web
  if (/^what('?s| is)( this| that)?( song| track| music)?( playing| is this| called)?$/.test(lower) && /\b(song|track|music|playing)\b/.test(lower)) return { tool: "now_playing", args: {} };
  if (/^(now playing|what song is (this|playing)|what am i listening to)$/.test(lower)) return { tool: "now_playing", args: {} };
  if ((match = text.match(/^(?:play|put on|watch|search(?: for)?|find|look up)\s+(.+?)\s+on youtube$/i)) || (match = text.match(/^(?:search|look up|find)\s+(?:on\s+)?youtube\s+(?:for\s+)?(.+)$/i))) return { tool: "youtube", args: { query: match[1] } };

  // ---- Clipboard and network
  if ((match = text.match(/^copy\s+(.+?)\s+to\s+(?:the |my )?clipboard$/i))) return { tool: "clipboard", args: { write: match[1] } };
  if (/\bclipboard\b/.test(lower) && /^(what|read|show|tell)/.test(lower)) return { tool: "clipboard", args: {} };
  if (/^(what'?s|what is|show|tell me)( me)?( my)?( local)? ip( address)?$/.test(lower)) return { tool: "my_ip", args: {} };

  // ---- Things Jarvis has no access to, which the model would otherwise cheerfully invent
  if (/^(read|check|show|send|write|compose|reply to|open)\b.*\b(e-?mails?|inbox)\b|^(do i have|any) (new |unread )?e-?mails?/.test(lower) && !/\b(validat|function|code|template|field|component)/.test(lower)) {
    return say("I can't reach your email, sir. Say open gmail and I'll bring it up.");
  }
  if (/\b(calendar|agenda|appointments?|my schedule|meetings?)\b/.test(lower) && /^(what|show|check|read|add|do i have|am i|any)/.test(lower) && !/\b(code|app|page|component)\b/.test(lower)) {
    return say("I can't see your calendar, sir, though I can set you a reminder.");
  }

  // ---- Work for Claude on the computer as a whole
  if (/^(install|uninstall)\s+\S+/.test(lower) || new RegExp(`^(update|upgrade) ${COMPUTER}$|^update (?:my |the )?(packages|software)$`).test(lower)) return { tool: "run_command", args: {} };
  return null;
}
