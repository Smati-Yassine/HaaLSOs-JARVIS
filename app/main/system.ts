// Daily-use helpers: checking that everything Jarvis needs is present, and starting at login.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { OLLAMA, SMALL_MODEL } from "./ollama.ts";
import { PROJECTS_ROOT } from "./projects.ts";
import { IMAGE } from "./web.ts";
import { listWindows } from "./windows.ts";

const run = promisify(execFile);
const HOME = join(homedir(), ".Jarvis");

// Returns problems in plain words. An empty list means all is well.
export async function healthCheck(voiceFolder: string): Promise<string[]> {
  const problems: string[] = [];
  try {
    const response = await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(3000) });
    const { models } = (await response.json()) as { models: { name: string }[] };
    if (!models.some((model) => model.name === SMALL_MODEL)) problems.push(`the Ollama model is missing, so run: ollama pull ${SMALL_MODEL}`);
  } catch {
    problems.push("Ollama isn't running, so I can only do simple commands");
  }
  const voice = [
    join(voiceFolder, ".venv", "bin", "python"),
    join(HOME, "models", "kokoro", "kokoro-v1.0.onnx"),
    join(HOME, "models", "openwakeword", "hey_jarvis_v0.1.onnx"),
  ];
  if (!voice.every(existsSync)) problems.push("some voice files are missing, so I can't listen or speak");
  await run("docker", ["image", "inspect", IMAGE]).catch(() => problems.push("my web search isn't set up, so I can't read web answers aloud"));
  await run("bash", ["-lc", "command -v claude"]).catch(() => problems.push("I can't find Claude Code, so coding won't work"));
  await listWindows().catch(() => problems.push("the Window Control extension isn't active, so I can't minimize or maximize windows"));
  if (!existsSync(PROJECTS_ROOT)) problems.push(`I can't find your projects folder at ${PROJECTS_ROOT}`);
  return problems;
}

const AUTOSTART = join(homedir(), ".config", "autostart", "jarvis.desktop");
const MENU_ENTRY = join(homedir(), ".local", "share", "applications", "jarvis.desktop");

export const startsAtLogin = () => existsSync(AUTOSTART);

// Returns the new state. Needs the app menu entry, because that's what login starts.
export function setStartAtLogin(enabled: boolean): boolean {
  if (!enabled) {
    rmSync(AUTOSTART, { force: true });
    return false;
  }
  if (!existsSync(MENU_ENTRY)) return false;
  mkdirSync(join(homedir(), ".config", "autostart"), { recursive: true });
  writeFileSync(AUTOSTART, readFileSync(MENU_ENTRY));
  return true;
}
