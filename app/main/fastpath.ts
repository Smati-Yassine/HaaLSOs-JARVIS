// Plain commands that never need the AI model, so they answer in milliseconds.
// Anything ambiguous returns null and goes to the model instead.

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

  if (/^(what('s| is) the time|what time is it|time|the time)$/.test(lower)) return { tool: "get_time", args: {} };
  if (/^(what('s| is) (the date|today'?s date)|what day is it)$/.test(lower)) {
    return { tool: "get_time", args: { want: "date" } };
  }

  if ((match = lower.match(/^how (?:big|large) is (?:my |the )?(downloads|documents|desktop|pictures|music|videos|home)(?: folder)?$/))) {
    return { tool: "folder_info", args: { folder: match[1], want: "size" } };
  }
  if ((match = lower.match(/^(?:what'?s|what is|show(?: me)?|list)(?: what'?s)?(?: in| inside)?(?: my| the)?\s+(downloads|documents|desktop|pictures|music|videos|home)(?: folder)?$/))) {
    return { tool: "folder_info", args: { folder: match[1] } };
  }
  if (/\b(list|show|what are|which are|name)\b.*\bprojects\b/.test(lower)) return { tool: "list_projects", args: {} };

  // Saying "google" always means Brave, even for the weather.
  const wantsSearch = /^google\b/.test(lower);
  if (!wantsSearch && /\b(weather|forecast|temperature)\b/.test(lower) && !/\b(code|project|app|page|api|component|add|fix|build)\b/.test(lower)) {
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
export const looksLikeCoding = (said: string, projectOpen = false) => DOES.test(clean(said)) && (projectOpen || CODE_THING.test(said));

// "Open firefox and set the volume to 40" is two commands. Only splits when every part is a
// command on its own, so "google cats and dogs" stays a single search.
export function splitCommands(said: string): string[] | null {
  const parts = clean(said).split(/\s*(?:,\s*(?:and\s+|then\s+)?|\s+and then\s+|\s+then\s+|\s+and\s+)\s*/i).filter(Boolean);
  if (parts.length < 2 || parts.length > 5) return null;
  return parts.every((part) => fastPath(part) !== null) ? parts : null;
}

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
