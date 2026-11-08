// Jarvis himself: one glowing line, drawn on the top edge of the message box. It shows what he is
// doing from the corner of your eye: breathing while idle, a pulse travelling along it while he
// thinks, a waveform while he speaks, and amber while he waits on you. It never moves for you.
import { useEffect, useRef } from "react";

export type Mood = "idle" | "thinking" | "speaking";

const calm = matchMedia("(prefers-reduced-motion: reduce)").matches;

type Colors = { ink: string; amber: string; glow: string };
function readColors(): Colors {
  const style = getComputedStyle(document.documentElement);
  return {
    ink: style.getPropertyValue("--ink").trim() || "#fff",
    amber: style.getPropertyValue("--amber").trim() || "#ffb02e",
    glow: style.getPropertyValue("--glow").trim() || "rgba(255,255,255,0.55)",
  };
}

function draw(canvas: HTMLCanvasElement, mood: Mood, asking: boolean, colors: Colors, t: number) {
  const ratio = Math.min(2, devicePixelRatio || 1);
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (!w || !h) return;
  if (canvas.width !== Math.round(w * ratio) || canvas.height !== Math.round(h * ratio)) {
    canvas.width = Math.round(w * ratio);
    canvas.height = Math.round(h * ratio);
  }
  const g = canvas.getContext("2d");
  if (!g) return;
  g.setTransform(ratio, 0, 0, ratio, 0, 0);
  g.clearRect(0, 0, w, h);
  const mid = h / 2;
  const color = asking ? colors.amber : colors.ink;
  const fade = g.createLinearGradient(0, 0, w, 0);
  fade.addColorStop(0, "transparent");
  fade.addColorStop(0.12, color);
  fade.addColorStop(0.88, color);
  fade.addColorStop(1, "transparent");

  let amp = 0;
  let freq = 0;
  let speed = 0;
  if (asking) {
    amp = h * 0.06 * (0.6 + 0.4 * Math.sin(t * 3));
    freq = 0.012;
    speed = 1.4;
  } else if (mood === "speaking") {
    amp = h * 0.34;
    freq = 0.028;
    speed = 4;
  }

  g.lineWidth = 1.6;
  g.strokeStyle = fade;
  g.shadowColor = asking ? colors.amber : colors.glow;
  g.shadowBlur = mood === "idle" && !asking ? 6 + 4 * Math.sin(t * 1.4) : 12;
  g.beginPath();
  for (let x = 0; x <= w; x += 2) {
    const envelope = Math.sin(Math.PI * (x / w)) ** 2;
    let y = 0;
    if (amp) {
      const voice = mood === "speaking" && !asking ? 0.55 + 0.45 * Math.sin(t * 2.3 + Math.sin(t * 0.9) * 2) : 1;
      y = amp * envelope * voice * (Math.sin(x * freq + t * speed) * 0.6 + Math.sin(x * freq * 2.3 - t * speed * 1.3) * 0.3 + Math.sin(x * freq * 5.1 + t * speed * 0.7) * 0.15);
    }
    if (x === 0) g.moveTo(x, mid + y);
    else g.lineTo(x, mid + y);
  }
  g.stroke();

  if (mood === "thinking" && !asking) {
    const at = (((t * 0.55) % 1.3) - 0.15) * w;
    const reach = w * 0.12;
    const pulse = g.createRadialGradient(at, mid, 0, at, mid, reach);
    pulse.addColorStop(0, colors.ink);
    pulse.addColorStop(1, "transparent");
    g.shadowBlur = 16;
    g.strokeStyle = pulse;
    g.lineWidth = 2.6;
    g.beginPath();
    g.moveTo(Math.max(0, at - reach), mid);
    g.lineTo(Math.min(w, at + reach), mid);
    g.stroke();
  }
}

export function VoiceLine({ mood, asking, mode }: { mood: Mood; asking: boolean; mode: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const state = useRef({ mood, asking, colors: readColors() });
  state.current.mood = mood;
  state.current.asking = asking;

  // The colors come from the theme, so they're read again whenever it changes.
  useEffect(() => {
    state.current.colors = readColors();
    if (calm && canvas.current) draw(canvas.current, state.current.mood, state.current.asking, state.current.colors, 0);
  }, [mode]);

  useEffect(() => {
    if (calm) {
      if (canvas.current) draw(canvas.current, mood, asking, state.current.colors, 0);
      return;
    }
    let frame = 0;
    const tick = (ms: number) => {
      const element = canvas.current;
      if (element && element.offsetParent !== null) draw(element, state.current.mood, state.current.asking, state.current.colors, ms / 1000);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
    // In calm mode the line is redrawn only when what it shows changes.
  }, [calm ? `${mood}${asking}` : ""]);

  return <canvas className="line" ref={canvas} aria-hidden="true" />;
}
