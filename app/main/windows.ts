// Controls real windows through the Window Control GNOME extension, because Wayland
// doesn't let normal programs touch other programs' windows.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const PATH = "/org/gnome/Shell/Extensions/WindowControl";
const IFACE = "org.gnome.Shell.Extensions.WindowControl";

export type WindowInfo = { id: number; title: string; wm_class: string; wm_class_instance?: string; is_overlay?: boolean };
export const NOT_INSTALLED = "NOT_INSTALLED";

// Spoken names that don't match a window's own name.
const WINDOW_ALIASES: Record<string, string[]> = {
  terminal: ["ptyxis", "terminal", "kgx"],
  browser: ["brave", "firefox"],
  "vs code": ["code"],
  vscode: ["code"],
  "visual studio code": ["code"],
  files: ["nautilus"],
  "file manager": ["nautilus"],
};

// gdbus prints the JSON as a quoted text value, like ('[...]',).
export function decodeReply(output: string): string {
  const body = output.trim().replace(/^\(/, "").replace(/,?\)$/, "").trim();
  const quote = body[0];
  if (quote !== "'" && quote !== '"') return body;
  return body
    .slice(1, -1)
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\(['"\\])/g, "$1");
}

async function call(method: string, ...args: string[]): Promise<string> {
  try {
    const { stdout } = await run("gdbus", [
      "call", "--session", "--dest", "org.gnome.Shell", "--object-path", PATH, "--method", `${IFACE}.${method}`, ...args,
    ], { timeout: 4000 });
    return stdout;
  } catch (error) {
    if (/UnknownMethod|No such interface|does not exist|UnknownObject/i.test(String(error))) throw new Error(NOT_INSTALLED);
    throw error;
  }
}

export async function listWindows(): Promise<WindowInfo[]> {
  const list = JSON.parse(decodeReply(await call("ListDetailed"))) as WindowInfo[];
  return list.filter((window) => !window.is_overlay);
}

// Picks the best window for a spoken name: exact app first, then a title match.
export function pickWindow(spoken: string, windows: WindowInfo[]): WindowInfo | null {
  const want = spoken.trim().toLowerCase().replace(/\s+window$/, "");
  if (!want) return null;
  const names = WINDOW_ALIASES[want] ?? [want];
  const classes = (window: WindowInfo) => `${window.wm_class} ${window.wm_class_instance ?? ""}`.toLowerCase();
  return (
    windows.find((window) => names.some((name) => window.wm_class.toLowerCase() === name)) ??
    windows.find((window) => names.some((name) => classes(window).includes(name))) ??
    windows.find((window) => want.length >= 3 && window.title.toLowerCase().includes(want)) ??
    null
  );
}

const ACTIONS: Record<string, string> = {
  minimize: "Minimize", minimise: "Minimize", maximize: "Maximize", maximise: "Maximize",
  focus: "Activate", restore: "Unminimize", unmaximize: "Unmaximize", close: "Close",
};

export const knownAction = (action: string) => ACTIONS[action.toLowerCase()] !== undefined;

export async function controlWindow(window: WindowInfo, action: string): Promise<boolean> {
  return (await call(ACTIONS[action.toLowerCase()], String(window.id))).includes("true");
}
