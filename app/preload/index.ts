// The only things the window is allowed to ask of the rest of the app.
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("jarvis", {
  ask: (said: string) => ipcRenderer.invoke("jarvis:ask", said),
  warmUp: () => ipcRenderer.invoke("jarvis:warm-up"),
  welcome: (text: string) => ipcRenderer.invoke("jarvis:welcome", text),
  setTheme: (mode: "dark" | "light") => ipcRenderer.invoke("theme:set", mode),
  setMuted: (muted: boolean) => ipcRenderer.invoke("voice:mute", muted),
  voiceAvailable: () => ipcRenderer.invoke("voice:available"),
  onEvent: (listener: (event: Record<string, unknown>) => void) => {
    const handler = (_event: unknown, payload: Record<string, unknown>) => listener(payload);
    ipcRenderer.on("jarvis:event", handler);
    return () => ipcRenderer.removeListener("jarvis:event", handler);
  },
});
