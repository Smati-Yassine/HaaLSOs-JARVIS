// Finds a project folder from a spoken name. Speech recognition often mangles
// project names ("Luminal" for luminelle), so matching has to tolerate that.
import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const PROJECTS_ROOT = process.env.JARVIS_PROJECTS_ROOT || join(homedir(), "Documents", "Projects");

const squash = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, "");

function distance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) {
      next[j] = Math.min(next[j - 1] + 1, row[j] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    row = next;
  }
  return row[b.length];
}

export function listProjects(root = PROJECTS_ROOT): string[] {
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name);
}

export function findProject(spoken: string, names: string[]): string | null {
  const want = squash(spoken.replace(/\b(project|the|my)\b/gi, ""));
  if (!want) return null;
  let best: string | null = null;
  let bestScore = Infinity;
  for (const name of names) {
    const have = squash(name);
    if (have === want) return name;
    // "jarvis" should find "HaaLSO's JARVIS".
    const score = have.includes(want) && want.length >= 4 ? 0.5 : distance(want, have);
    if (score < bestScore) {
      bestScore = score;
      best = name;
    }
  }
  if (best === null) return null;
  const longest = Math.max(want.length, squash(best).length);
  return bestScore <= Math.max(1, Math.floor(longest * 0.34)) ? best : null;
}

const COMMON_WORDS = new Set([
  "project", "projects", "coding", "code", "work", "working", "start", "open", "begin", "with", "this", "that",
  "please", "claude", "folder", "lets", "time", "today", "file", "files", "page", "website", "site",
  // Words about the computer itself, which once matched a project: "port 8888" opened "portfolio".
  "port", "ports", "server", "process", "space", "disk", "drive", "music", "video", "videos", "photo", "photos",
  "picture", "pictures", "downloads", "documents", "desktop", "network", "terminal", "window", "screen", "using",
]);

// Finds a project named anywhere in a sentence, tolerating speech mistakes.
export function projectInSentence(said: string, names: string[]): string | null {
  // "open firefox jarvis" is talking to Jarvis. "start coding jarvis" means the project.
  // "How are you jarvis, I want a new project" is only talking to him, so the name has to sit
  // right next to the work.
  const aboutCode = /\b(cod(e|ing)|work(ing)?|project|on|in)\s+((on|in|with)\s+)?(the\s+|my\s+)?jarvis\b|\bjarvis('?s)?\s+(project|code|repo|folder)\b/i.test(said);
  const words = said.toLowerCase().replace(/[^a-z0-9' -]/g, " ").split(/\s+/).filter((word) => word && (aboutCode || word !== "jarvis"));
  for (let size = 3; size >= 1; size--) {
    for (let at = 0; at + size <= words.length; at++) {
      const piece = words.slice(at, at + size);
      if (size === 1 && (piece[0].length < 4 || COMMON_WORDS.has(piece[0].replace(/'/g, "")))) continue;
      if (size > 1 && piece.some((word) => COMMON_WORDS.has(word.replace(/'/g, "")) || word === "my" || word === "the" || word === "on")) continue;
      const name = findProject(piece.join(" "), names);
      if (name) return name;
    }
  }
  return null;
}

const WANTS_WORK = /\b(work|working|cod(e|ing)|start|open|begin|continue|resume|switch|jump|load|get into|go (in)?to)\b/i;
const IS_A_TASK = /\b(add|fix|change|make|refactor|write|delete|remove|test|build|rename|update|create|explain)\b/i;
const NOT_A_PROJECT = /\b(website|web site|tab|browser|youtube|google)\b/i;
const NO_NAME = /\b(time to (work|code)|time for work|let'?s (start )?(work|code|coding)|start (working|coding)|begin (working|coding)|back to work)\b/i;
const POINTS_BACK = /\b(it|that|this|that one|this one|the same one)\b/i;

export type ProjectIntent = { project: string } | { ask: true } | null;

// Decides if a sentence means "open a project", using plain rules rather than the model.
export function projectIntent(said: string, names: string[], last: string | null): ProjectIntent {
  if (IS_A_TASK.test(said) || NOT_A_PROJECT.test(said)) return null;
  const named = projectInSentence(said, names);
  if (named && (WANTS_WORK.test(said) || /\bproject\b/i.test(said))) return { project: named };
  if (!WANTS_WORK.test(said)) return null;
  // "Let's work on it" points back. In a long message, "it" and "code" are just ordinary words.
  if (said.split(/\s+/).length <= 6 && POINTS_BACK.test(said) && last && /\b(work|working|cod(e|ing)|start|open|begin|continue|resume)\b/i.test(said)) {
    return { project: last };
  }
  if (NO_NAME.test(said)) return { ask: true };
  return null;
}

// "claude" opens Claude in the home folder, and "claude luminelle" opens that project. Anything
// else after the word isn't a shortcut: "claude is great" is just a sentence.
export function claudeShortcut(said: string, names: string[]): { home: true } | { project: string } | null {
  const match = said.match(/^(?:(?:open|start|launch|run)\s+)?claude(?:\s+code)?(?:\s+(?:(?:in|on|for|at|with)\s+)?(.+))?$/i);
  if (!match) return null;
  const rest = match[1]?.trim();
  if (!rest || /^(~|home|(my |the )?home folder)$/i.test(rest)) return { home: true };
  const project = rest.split(/\s+/).length <= 4 ? findProject(rest, names) : null;
  return project ? { project } : null;
}

// A folder name that's safe to create: no slashes, no dots at the front, nothing odd.
export const validProjectName = (name: string) => /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,60}$/u.test(name) && !name.includes("..");

// "I wish to start a new project called Quje". The name is null if none was given.
export function newProjectRequest(said: string): { name: string | null } | null {
  if (!/\bnew\s+(?:[\p{L}-]+\s+)?project\b|\b(create|make|begin)\s+(?:a\s+)?project\b/iu.test(said)) return null;
  if (/\b(page|section|card|button|folder in|tab|menu|modal|form|list of)\b/i.test(said)) return null;
  const tail = said.match(/\b(?:called|named|name it|call it|titled)\s+(.+)$/i)?.[1] ?? said.match(/\bproject\s+(?!for\b|about\b|to\b|with\b)(\S+(?:\s+\S+){0,2})$/i)?.[1] ?? null;
  const name = tail?.replace(/^["']|["'.,!?]+$/g, "").replace(/\s+please$/i, "").trim() ?? null;
  return { name: name || null };
}
