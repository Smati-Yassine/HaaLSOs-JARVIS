// Plain commands that never need the AI model, so they answer in milliseconds.
// Anything ambiguous returns null and goes to the model instead.
import { abilityCall } from "./abilities.ts";

export type Call = { tool: string; args: Record<string, string> };

const WEBSITE = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}(\/\S*)?$/i;
const KNOWN_SITES = new Set(["youtube", "github", "gmail", "reddit", "netflix", "twitter", "linkedin", "wikipedia"]);
const WORD_NUMBERS: Record<string, number> = {
  zero: 0, ten: 10, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
  hundred: 100, "a hundred": 100, "one hundred": 100,
};

// Removes the wake word and politeness so patterns stay simple.
export function clean(said: string): string {
  return said
    .trim()
    .replace(/[.!?,]+$/g, "")
    .replace(/^(hey |ok |okay )?jarvis[,:]?\s*/i, "")
    .replace(/^yes,? sir[.,!?]*\s+(?=\S)/i, "") // Jarvis's own words, if the mic caught them.
    .replace(/^(please|can you|could you)\s+/i, "")
    .replace(/\s+please$/i, "")
    .trim();
}

function volumeLevel(value: string): string | null {
  if (/^\d{1,3}$/.test(value)) return value;
  const word = WORD_NUMBERS[value.toLowerCase()];
  return word === undefined ? null : String(word);
}

export function fastPath(said: string): Call | null {
  const text = clean(said);
  const lower = text.toLowerCase();
  let match: RegExpMatchArray | null;

  const ability = abilityCall(text);
  if (ability) return ability;

  if (/^(what('s| is) the time|what time is it|time|the time)$/.test(lower)) return { tool: "get_time", args: {} };
  if (/^(what('s| is) (the date|today'?s date|the day( today)?)|what day( of the week)? is (it|today)( today)?|what'?s today)$/.test(lower)) {
    return { tool: "get_time", args: { want: "date" } };
  }

  if ((match = lower.match(/^how (?:big|large) is (?:my |the )?(downloads|documents|desktop|pictures|music|videos|home)(?: folder)?$/))
    || (match = lower.match(/^how much (?:space|room|storage|disk space) (?:do|does|is) (?:my |the )?(downloads|documents|desktop|pictures|music|videos|home)(?: folder)? (?:take|taking|use|using|take up|taking up)(?: up)?$/))) {
    return { tool: "folder_info", args: { folder: match[1], want: "size" } };
  }
  if ((match = lower.match(/^(?:what'?s|what is|show(?: me)?|list)(?: what'?s)?(?: in| inside)?(?: my| the)?\s+(downloads|documents|desktop|pictures|music|videos|home)(?: folder)?$/))) {
    return { tool: "folder_info", args: { folder: match[1] } };
  }
  if (/\b(list|show|what are|which are|name)\b.*\bprojects\b/.test(lower)) return { tool: "list_projects", args: {} };

  // Saying "google" always means Brave, even for the weather.
  const wantsSearch = /^google\b/.test(lower);
  // "The weather was lovely yesterday" is talk, not a request for the forecast.
  const pastWeather = /\b(was|were|yesterday|last (night|week))\b/.test(lower) && !/^(what|how|was|will|is)\b/.test(lower);
  // "How cold is it in Paris", "will it rain tomorrow", "do I need an umbrella".
  const skyQuestion = /^(how (cold|hot|warm|chilly) (is it|will it be)|(is|will) it (going to )?(rain|snow|be (cold|hot|warm|sunny|windy|nice))|is it (raining|snowing|sunny|windy)|do i need an? (umbrella|coat|jacket))\b/.test(lower);
  if (!wantsSearch && !pastWeather && (skyQuestion || /\b(weather|forecast|temperature)\b/.test(lower)) && !/\b(code|project|app|page|api|component|add|fix|build)\b/.test(lower)) {
    const place = text.match(/\b(?:in|for|at)\s+([\p{L}][\p{L} '-]*?)(?:\s+(?:today|tomorrow|right now|now))?$/iu)?.[1];
    const args: Record<string, string> = /\btomorrow\b/.test(lower) ? { when: "tomorrow" } : {};
    if (place && !/^(the|my|this)\b/i.test(place)) args.location = place;
    return { tool: "get_weather", args };
  }
  if (/^mute( the (sound|volume|audio))?$/.test(lower)) return { tool: "set_volume", args: { level: "mute" } };
  if (/^unmute( the (sound|volume|audio))?$/.test(lower)) return { tool: "set_volume", args: { level: "unmute" } };
  if ((match = lower.match(/^(?:set |turn )?(?:the )?volume(?: up| down)?(?: to| at)? (.+?)(?: percent|%)?$/))) {
    const level = volumeLevel(match[1]);
    if (level) return { tool: "set_volume", args: { level } };
  }
  // "Turn it down to 20", "put it at 70%": with a number, "it" can only be the sound.
  if ((match = lower.match(/^(?:turn|put|set|bring)\s+(?:it|the (?:sound|music|audio))(?: up| down)?(?: to| at)? (\d{1,3}|[a-z]+(?: hundred)?)(?: percent|%)?$/))) {
    const level = volumeLevel(match[1]);
    if (level) return { tool: "set_volume", args: { level } };
  }
  if ((match = lower.match(/^(?:turn (?:it|the (?:sound|volume|music|audio)) (up|down)|(?:volume|sound) (up|down)|(louder|quieter|softer))(?: a (?:bit|little|touch))?$/))) {
    const word = match[1] ?? match[2] ?? match[3];
    return { tool: "set_volume", args: { level: word === "up" || word === "louder" ? "up" : "down" } };
  }

  if (/^(pause|stop)( the)?( music| song| video)?$/.test(lower)) return { tool: "media_control", args: { action: "pause" } };
  if (/^(play|resume)( the)?( music| song| video)?$/.test(lower)) return { tool: "media_control", args: { action: "play" } };
  if (/^(next|skip)( the)?( song| track| video)?$/.test(lower)) return { tool: "media_control", args: { action: "next" } };
  if (/^(previous|last)( song| track| video)$/.test(lower)) return { tool: "media_control", args: { action: "previous" } };

  // The word "google" means Brave. Asking anything else about the web gets a spoken answer.
  if ((match = text.match(/^(?:google|search google for|google search for)\s+(.+)$/i))) {
    return { tool: "google_search", args: { query: match[1] } };
  }
  if ((match = text.match(/^(?:search for|search|look up|find out)\s+(.+)$/i))) {
    return { tool: "web_answer", args: { question: match[1] } };
  }
  if (/\b(news|headlines|who won|score|scores|stock price|price of|exchange rate|latest)\b/.test(lower) && !/\b(code|project|app|page|api|component|add|fix|build|file|test)\b/.test(lower)) {
    return { tool: "web_answer", args: { question: text } };
  }

  if ((match = text.match(/^(?:go to|open|visit)\s+(\S+)$/i)) && WEBSITE.test(match[1])) {
    return { tool: "open_website", args: { url: match[1] } };
  }
  if ((match = lower.match(/^(?:go to|open)\s+([a-z]+)$/)) && KNOWN_SITES.has(match[1])) {
    return { tool: "open_website", args: { url: `${match[1]}.com` } };
  }

  if (/^(close|close down|close out)( the)? project$|^(we're|we are|i'm|i am) done coding$|^stop coding$/.test(lower)) {
    return { tool: "close_project", args: {} };
  }
  if ((match = text.match(/^(?:open|launch|start)\s+(?:up\s+)?(.+)$/i)) && !/\b(project|coding|session|claude)\b/i.test(match[1])) {
    return { tool: "open_app", args: { name: match[1] } };
  }
  if ((match = text.match(/^(?:close|quit|exit)\s+(.+)$/i)) && !/\b(project|window|tab)\b/i.test(match[1])) {
    return { tool: "close_app", args: { name: match[1] } };
  }
  if ((match = lower.match(/^(minimi[sz]e|maximi[sz]e|focus)\s+(?:the\s+)?(.+)$/))) {
    return { tool: "window_control", args: { action: match[1], name: match[2] } };
  }
  if ((match = lower.match(/^(?:bring|put|get|move)\s+(?:the\s+)?(.+?)(?:\s+window)?\s+(?:in front|to the front|to front|up front|forward|on top)$/))) {
    return { tool: "window_control", args: { action: "focus", name: match[1] } };
  }
  if (/\bbattery\b/.test(lower) && /^(how|what|check|battery)/.test(lower)) {
    return { tool: "system_info", args: { what: "battery" } };
  }
  if (/\b(disk|storage)\b/.test(lower) && /^(how|what|check)/.test(lower)) return { tool: "system_info", args: { what: "disk" } };
  if (/\b(internet|online|wi-?fi|network)\b/.test(lower) && /^(am i|are we|is|do i|check|what)/.test(lower)) return { tool: "system_info", args: { what: "network" } };
  return null;
}

// Plainly a coding request, so it should reach Claude without the model guessing.
const DOES = /^(add|fix|make|change|refactor|rename|update|implement|create|write|remove|debug|move|style|center)\b/i;
const CODE_THING = /\b(navbar|nav bar|button|css|html|component|function|class|bug|api|endpoint|database|schema|login|signup|settings page|page|footer|header|sidebar|modal|form|route|test|tests|module|dark mode|layout|responsive|sticky)\b/i;
// With a project open, any request to change something is for Claude.
// Something wrong with the computer itself, not with code: drivers, wifi, sound and the like.
const COMPUTER_PART = /\b(wi-?fi|internet|network|ethernet|bluetooth|sound|audio|speakers?|microphone|mic|headphones|headset|earbuds|drivers?|nvidia|amd|graphics( card| driver)?|gpu|keyboard|touchpad|trackpad|mouse|printer|webcam|camera|usb|battery|charging|charger|fan|laptop|computer|pc|ubuntu|linux|kernel|boot|booting|monitor|brightness|(my|the) (screen|display)|my (disk|drive|ram|memory|system|machine))\b/i;
const GOING_WRONG = /\b(not working|isn'?t working|aren'?t working|doesn'?t work|don'?t work|won'?t|can'?t|cannot|stopped|keeps?|broken|broke|no sound|flicker\w*|slow|lag\w*|freez\w*|crash\w*|disconnect\w*|drops?|dropping|error|errors|fail\w*|problem|issue|glitch\w*|stuck|dead|overheat\w*|hot|loud|noisy|drain\w*|missing|not (detected|showing|found|connecting|charging))\b/i;
const WANTS_FIX = /^(fix|repair|sort( out)?|troubleshoot|diagnose|look into|figure out|solve|resolve|update|upgrade|reinstall|install|set up|get)\b|\b(fix|repair|sort out|troubleshoot|look into|figure out|solve)\b/i;
const ABOUT_CODE = /\b(code|app|page|component|function|module|bug in|test|tests|css|html|api|repo|project|feature|website|site|login|signup|button|ui)\b/i;

// "Fix my wifi driver", "my laptop is slow, fix it": a job on the computer.
export const isComputerFix = (said: string) => {
  const text = clean(said);
  return COMPUTER_PART.test(text) && WANTS_FIX.test(text) && !ABOUT_CODE.test(text) && (GOING_WRONG.test(text) || /\b(drivers?|nvidia|graphics|gpu|kernel|firmware|ubuntu|linux|bluetooth|wi-?fi|sound|audio|printer|webcam|battery)\b/i.test(text));
};
// "My sound isn't working": a complaint about the computer, with no request yet.
export const isComputerComplaint = (said: string) => {
  const text = clean(said);
  return COMPUTER_PART.test(text) && GOING_WRONG.test(text) && !ABOUT_CODE.test(text) && !isComputerFix(said);
};
// "Fix it", after a complaint.
export const FIX_IT = /^(?:(?:ok|okay|alright|then|so|yes|yeah|please)[,.]?\s+)*(?:(?:try to|go ahead and|please)\s+)?(?:fix|repair|sort(?: out)?|troubleshoot|look into|deal with|solve)\s+(?:it|that|this|them)(?:\s+(?:out|for me|please|then))*$/i;

export const looksLikeCoding = (said: string, projectOpen = false) => DOES.test(clean(said)) && (projectOpen || CODE_THING.test(said));

// "Open firefox and set the volume to 40" is two commands. Only splits when every part is a
// command on its own, so "google cats and dogs" stays a single search.
export function splitCommands(said: string): string[] | null {
  const parts = clean(said).split(/\s*(?:,\s*(?:and\s+|then\s+)?|\s+and then\s+|\s+then\s+|\s+and\s+)\s*/i).filter(Boolean);
  if (parts.length < 2 || parts.length > 5) return null;
  return parts.every((part) => fastPath(part) !== null) ? parts : null;
}

// Asking about Claude's work and the project's terminals. Returns null if it isn't that.
export function linkCall(said: string): Call | null {
  const text = clean(said);
  const lower = text.toLowerCase();
  let match: RegExpMatchArray | null;
  if ((match = text.match(/^(?:in the terminal,?\s+(?:run|type)\s+(.+)|(?:run|execute|type)\s+(.+?)\s+in\s+(?:the|a|my)\s+terminal)$/i))) {
    return { tool: "terminal_run", args: { command: (match[1] ?? match[2]).trim() } };
  }
  if (/^(what('?s| is) claude (doing|up to|working on|busy with)|what is claude doing|how('?s| is) claude (getting on|coming along|doing with)|is claude (done|finished|still (working|going|at it)|busy|working)( yet)?|how far (along )?is claude|where('?s| is) claude (at|up to)|(what'?s )?claude'?s (status|progress)|status of claude)\b/.test(lower)) {
    return { tool: "claude_status", args: {} };
  }
  if (/^(how|what|am i|do i|check|show|tell me)\b/.test(lower) && (/\bclaude\b.*\b(usage|limits?|left|remaining|quota|allowance)\b|\b(usage|limits?|quota)\b.*\bclaude\b|\bhow much (claude|of my (claude|plan|limits?))\b/.test(lower))) {
    return { tool: "claude_usage", args: {} };
  }
  if (/^(what did claude (change|do|edit|modify|touch|write)|what changes did claude make|what('?s| has| have)? (been )?changed( in the (project|code))?|show me (the |what )?changes?|summari[sz]e (the )?changes|what'?s new in the (code|project))$/.test(lower)) {
    return { tool: "claude_changes", args: {} };
  }
  const aboutTerminal = /\b(terminal|console)\b/.test(lower) && /^(what|why|did|does|do|is|are|was|were|read|check|look|tell me|show|explain|any|can you see)\b/.test(lower);
  if (aboutTerminal || /^(did|have|has) (the |my )?(tests?|build|install|command|script)\b.*\b(pass|passed|fail|failed|work|worked|finish|finished|succeed|succeeded|break|broke)\b/.test(lower)) {
    return { tool: "terminal_read", args: { question: text } };
  }
  return null;
}

// "Tell Claude to add a footer": the rest is the task. Null if it doesn't start that way.
export const tellClaude = (said: string) => clean(said).match(/^(?:(?:ok|okay|alright|right|so|great|good|cool|perfect|yes|yeah|then|now|and)[,.]?\s+)*(?:tell|ask|have|get|let)\s+claude\s+(?:to\s+)?(.+)$/i)?.[1] ?? null;

// Claude's controls, by voice. Returns the action, or null if this isn't about them.
export type ClaudeAction =
  | { act: "effort"; level: string } | { act: "model"; name: string } | { act: "session" } | { act: "terminal" }
  | { act: "archive" } | { act: "hide" } | { act: "show" } | { act: "interrupt"; named: boolean };
export function claudeAction(said: string): ClaudeAction | null {
  const lower = clean(said).toLowerCase();
  if (/\b(stop|interrupt|cancel|abort|halt)\b.*\bclaude\b|\btell claude to stop\b/.test(lower)) return { act: "interrupt", named: true };
  if (/^(stop|interrupt|abort|halt)( that| it| working| now| please)*$/.test(lower)) return { act: "interrupt", named: false };
  const effort = lower.match(/\beffort\b.*?\b(x ?high|extra high|low|medium|high|maximum|max)\b/) ?? lower.match(/\b(x ?high|extra high|low|medium|high|maximum|max)\b.*\beffort\b/);
  if (effort) {
    const level = effort[1].replace(/^x ?high|^extra high/, "xhigh").replace("maximum", "max");
    return { act: "effort", level };
  }
  const model = lower.match(/\b(?:switch|change|use|set|move|go)\b.*\b(fable|opus|sonnet|haiku)\b/);
  if (model) return { act: "model", name: model[1] };
  if (/\b(new|another)\b.*\b(session|conversation)\b|\bstart a session\b/.test(lower)) return { act: "session" };
  if (/\b(new|another|second|plain|open a)\b.*\bterminal\b/.test(lower)) return { act: "terminal" };
  if (/\barchive\b/.test(lower)) return { act: "archive" };
  if (/\b(hide|minimi[sz]e)\b.*\bclaude\b/.test(lower)) return { act: "hide" };
  if (/\b(show|bring|open|back to)\b.*\bclaude\b/.test(lower)) return { act: "show" };
  return null;
}

const NUMBER_WORDS = ["one", "two", "three", "four", "five", "six"];
const ORDINALS = ["first", "second", "third", "fourth", "fifth", "sixth"];

// Works out which of Claude's suggestions was meant: "two", "the second one", or its words.
export function pickOption(said: string, options: string[]): number | null {
  const text = clean(said).toLowerCase();
  const exact = options.findIndex((option) => option.toLowerCase() === text);
  if (exact >= 0) return exact;
  const number = text.match(/\b([1-9])\b/)?.[1];
  if (number && Number(number) <= options.length) return Number(number) - 1;
  // Ordinals first, because "the second one" also contains "one".
  for (const words of [ORDINALS, NUMBER_WORDS]) {
    for (let at = 0; at < options.length; at++) {
      if (new RegExp(`\\b${words[at]}\\b`).test(text)) return at;
    }
  }
  const words = text.split(/\W+/).filter((word) => word.length >= 3);
  const scores = options.map((option) => words.filter((word) => option.toLowerCase().includes(word)).length);
  const best = Math.max(...scores);
  return best > 0 && scores.filter((score) => score === best).length === 1 ? scores.indexOf(best) : null;
}
