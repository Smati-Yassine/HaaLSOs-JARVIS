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

  if ((match = text.match(/^(?:google|search google for|search for|look up)\s+(.+)$/i))) {
    return { tool: "google_search", args: { query: match[1] } };
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
  return null;
}
