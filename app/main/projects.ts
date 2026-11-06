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
]);

// Finds a project named anywhere in a sentence, tolerating speech mistakes.
export function projectInSentence(said: string, names: string[]): string | null {
  // "open firefox jarvis" is talking to Jarvis. "start coding jarvis" means the project.
  const aboutCode = /\b(cod(e|ing)|work(ing)?|project)\b/i.test(said);
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
  if (POINTS_BACK.test(said) && last && /\b(work|working|cod(e|ing)|start|open|begin|continue|resume)\b/i.test(said)) {
    return { project: last };
  }
  if (NO_NAME.test(said)) return { ask: true };
  return null;
}
