// The only things the window is allowed to ask of the rest of the app.
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("jarvis", {
  ask: (said: string) => ipcRenderer.invoke("jarvis:ask", said),
  warmUp: () => ipcRenderer.invoke("jarvis:warm-up"),
  setTheme: (mode: "dark" | "light") => ipcRenderer.invoke("theme:set", mode),
});
