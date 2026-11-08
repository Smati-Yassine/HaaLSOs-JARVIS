// Small jobs on the computer, like "install VLC", without opening a whole Claude Code session.
// Claude (the quick model, no tools) proposes one command, plain code checks it, he approves it,
// and Jarvis runs it. Anything bigger, or anything Claude isn't sure of, still goes to a full session.
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { promisify } from "node:util";

import { classify, type Level } from "./safety.ts";

const run = promisify(execFile);

// What the computer is, so the command fits it. Read once.
let facts: string | null = null;
export function systemFacts(): string {
  if (facts) return facts;
  let name = "Linux";
  try {
    name = readFileSync("/etc/os-release", "utf8").match(/^PRETTY_NAME="?([^"\n]+)/m)?.[1] ?? name;
  } catch {
    // Not every system has the file.
  }
  const managers = ["apt", "snap", "flatpak"].filter((tool) => existsSync(`/usr/bin/${tool}`));
  facts = `${name} with GNOME, home folder ${homedir()}, package managers: ${managers.join(", ") || "none found"}.`;
  return facts;
}

export const PLANNER = `You turn a request about his Linux computer into exactly one shell command that Jarvis, his voice \
assistant, will show him and run after he approves it. Reply with exactly one line and nothing else: either \
COMMAND: <the command> or CLAUDE when the job needs several steps, needs to look at files before deciding, edits \
configuration, could lose data, or you're unsure. The command runs in bash from his home folder with no terminal, so \
it can't ask questions. Never write sudo. Prefer a command that needs no admin rights: looking at ports, processes, \
files and settings almost never does. Only when root is truly required, put pkexec in front (it shows a password \
dialog). Add -y where a tool would ask. For \
installing a program, prefer apt for command-line tools and for programs Ubuntu packages well, snap for desktop apps \
usually shipped as snaps (Spotify, Discord, Slack and the like), and flatpak from flathub only if he says flatpak. \
Never pipe downloads into a shell, never delete anything in his home folder, never touch boot or disks.`;

// "COMMAND: pkexec apt install -y vlc" becomes the command. Null means hand it to a full session.
export function parsePlan(reply: string | null): string | null {
  const line = reply?.trim().split("\n").find((part) => part.trim())?.trim() ?? "";
  const command = line.match(/^COMMAND:\s*`?(.+?)`?\s*$/)?.[1]?.trim();
  if (!command || /^CLAUDE\b/.test(line) || command.includes("\n") || command.length > 300) return null;
  return command;
}

// An install of named packages and nothing else. These ask a plain "shall I install" instead of a
// warning: everything else keeps the usual safety rules, where pkexec always needs a firm confirm.
const INSTALL = /^(?:pkexec\s+)?(?:(?:apt|apt-get)\s+install\s+-y\s+((?:[a-z0-9][a-z0-9.+-]*\s*)+)|snap\s+install\s+([a-z0-9][a-z0-9-]*)(?:\s+--classic)?|flatpak\s+install\s+-y\s+(?:flathub\s+)?([A-Za-z0-9][A-Za-z0-9._-]*))$/;

// Installing needs root, and with no terminal for a password only pkexec can get it.
export const withPkexec = (command: string) => /^(apt|apt-get|snap|flatpak)\s+install\b/.test(command.trim()) ? `pkexec ${command.trim()}` : command.trim();

export type Plan = { command: string; level: Level; install: string[] | null; manager: "apt" | "snap" | "flatpak" | null };

export function judge(command: string): Plan {
  const match = command.trim().match(INSTALL);
  if (!match) return { command, level: classify(command), install: null, manager: null };
  const install = (match[1] ?? match[2] ?? match[3]).trim().split(/\s+/);
  const manager = match[1] ? "apt" : match[2] ? "snap" : "flatpak";
  return { command, level: "say-back", install, manager };
}

// A package Claude named has to really exist, or the install would only fail after he approved it.
export async function packagesExist(plan: Plan): Promise<boolean> {
  if (!plan.install) return true;
  const check = async (name: string) => {
    if (plan.manager === "apt") return run("apt-cache", ["show", name], { timeout: 10_000 }).then(() => true, () => false);
    if (plan.manager === "snap") return run("snap", ["info", name], { timeout: 15_000 }).then(() => true, () => false);
    return run("flatpak", ["remote-info", "flathub", name], { timeout: 15_000 }).then(() => true, () => false);
  };
  return (await Promise.all(plan.install.map(check))).every(Boolean);
}

// What he's asked before it runs.
export function approvalTitle(plan: Plan): string | undefined {
  if (plan.install) return `Shall I install ${plan.install.join(" and ")}${plan.manager === "apt" ? "" : ` from ${plan.manager}`}?`;
  return undefined;
}

// What he's told when it's done.
export function doneMessage(plan: Plan, result: { ok: boolean; say: string }): string {
  if (!result.ok) return `${result.say} Say claude and I'll have Claude look into it in your home folder.`;
  if (plan.install) return `${plan.install.join(" and ")} ${plan.install.length === 1 ? "is" : "are"} installed, sir.`;
  return result.say.startsWith("Done") ? result.say : `Done, sir. ${result.say}`;
}
