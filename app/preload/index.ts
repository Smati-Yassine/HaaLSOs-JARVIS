// The only things the window is allowed to ask of the rest of the app.
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("jarvis", {
  ask: (said: string) => ipcRenderer.invoke("jarvis:ask", said),
  warmUp: () => ipcRenderer.invoke("jarvis:warm-up"),
  welcome: (text: string) => ipcRenderer.invoke("jarvis:welcome", text),
  setTheme: (mode: "dark" | "light") => ipcRenderer.invoke("theme:set", mode),
  setMuted: (muted: boolean) => ipcRenderer.invoke("voice:mute", muted),
  voiceAvailable: () => ipcRenderer.invoke("voice:available"),
  health: () => ipcRenderer.invoke("jarvis:health"),
  getAutostart: () => ipcRenderer.invoke("autostart:get"),
  setAutostart: (enabled: boolean) => ipcRenderer.invoke("autostart:set", enabled),
  minimize: () => ipcRenderer.send("window:minimize"),
  toggleMaximize: () => ipcRenderer.send("window:toggle-maximize"),
  close: () => ipcRenderer.send("window:close"),
  onEvent: (listener: (event: Record<string, unknown>) => void) => {
    const handler = (_event: unknown, payload: Record<string, unknown>) => listener(payload);
    ipcRenderer.on("jarvis:event", handler);
    return () => ipcRenderer.removeListener("jarvis:event", handler);
  },
});

const send = (channel: string, ...args: unknown[]) => ipcRenderer.send(channel, ...args);

contextBridge.exposeInMainWorld("claude", {
  snapshot: () => ipcRenderer.invoke("claude:snapshot"),
  buffer: (id: string) => ipcRenderer.invoke("claude:buffer", id),
  write: (id: string, data: string) => send("claude:write", id, data),
  resize: (id: string, cols: number, rows: number) => send("claude:resize", id, cols, rows),
  select: (id: string) => send("claude:select", id),
  archive: (id: string) => send("claude:archive", id),
  restore: (id: string) => send("claude:restore", id),
  newSession: () => send("claude:new-session"),
  newTerminal: () => send("claude:new-terminal"),
  setModel: (id: string, model: string) => send("claude:model", id, model),
  setEffort: (id: string, effort: string) => send("claude:effort", id, effort),
  closeProject: () => send("claude:close-project"),
  onChange: (listener: (snapshot: unknown) => void) => {
    const handler = (_event: unknown, snapshot: unknown) => listener(snapshot);
    ipcRenderer.on("claude:changed", handler);
    return () => ipcRenderer.removeListener("claude:changed", handler);
  },
  onData: (listener: (id: string, data: string) => void) => {
    const handler = (_event: unknown, id: string, data: string) => listener(id, data);
    ipcRenderer.on("claude:data", handler);
    return () => ipcRenderer.removeListener("claude:data", handler);
  },
});
