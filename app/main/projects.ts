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
