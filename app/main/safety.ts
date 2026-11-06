// Decides how much confirmation a shell command needs. This is plain code on purpose:
// the AI model never gets a say in whether its own command is safe.

export type Level = "run" | "say-back" | "confirm";

const READ_ONLY = new Set([
  "ls", "pwd", "whoami", "uname", "uptime", "free", "df", "du", "date", "which", "wc", "hostname", "lscpu",
]);
// Anything that could chain, redirect or substitute commands.
const SHELL_SYNTAX = /[;&|<>`$(){}\\\n]/;
const DANGEROUS = [
  /\bsudo\b/, /\bsu\b/, /\bdoas\b/, /\bpkexec\b/,
  /\brm\b/, /\brmdir\b/, /\bshred\b/, /\bunlink\b/, /\btruncate\b/, /\bfind\b.*-delete/,
  /\bmkfs/, /\bdd\b/, /\bfdisk\b/, /\bparted\b/, /\bwipefs\b/, /\bmount\b/, /\bumount\b/,
  /\bchmod\b/, /\bchown\b/, /\bpasswd\b/, /\busermod\b/, /\buserdel\b/,
  /\bsystemctl\b/, /\bshutdown\b/, /\breboot\b/, /\bpoweroff\b/, /\bgrub/,
  /\bcurl\b.*\|/, /\bwget\b.*\|/, /\bbase64\b.*\|/,
  /(^|\s)\/(etc|boot|usr|bin|sbin|lib|var|sys|proc)\b/,
  /\bgit\s+(push|reset|clean)\b/,
  />/,
];

export function classify(command: string): Level {
  const text = command.trim();
  if (!text) return "confirm";
  if (DANGEROUS.some((rule) => rule.test(text))) return "confirm";
  if (!SHELL_SYNTAX.test(text) && READ_ONLY.has(text.split(/\s+/)[0])) return "run";
  return "say-back";
}

// A clear yes is required for dangerous commands; "yes" alone is enough for the rest.
export function isApproval(answer: string, level: Level): boolean {
  // "Yes, sir." is the most natural way to say yes to Jarvis.
  const text = answer.trim().toLowerCase().replace(/[.!]+$/, "").replace(/,? sir$/, "");
  if (level === "confirm") return /^(yes,? )?(confirm|do it|proceed)( it)?$/.test(text);
  return /^(yes|yeah|yep|ok|okay|sure|go ahead|do it|confirm|proceed)$/.test(text);
}

// A plain "yes" to something that needs "confirm" should ask again, not count as a no.
export const isPlainYes = (answer: string) => /^(yes|yeah|yep|ok|okay|sure|go ahead)(,? sir)?[.!]?$/i.test(answer.trim());

// Claude writing a file with ">" is normal work. Writes to system folders are still caught.
export const classifyForClaude = (command: string): Level => classify(command.replace(/>/g, " "));
