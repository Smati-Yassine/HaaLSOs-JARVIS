// Jarvis himself: one glowing line that moves with what he's doing.
import gsap from "gsap";
import { useEffect, useRef } from "react";

export type Mood = "idle" | "listening" | "thinking" | "speaking";

const MOODS: Record<Mood, { energy: number; speed: number; think: number }> = {
  idle: { energy: 0.06, speed: 1, think: 0 },
  listening: { energy: 0.35, speed: 1.4, think: 0 },
  thinking: { energy: 0.16, speed: 2.4, think: 1 },
  speaking: { energy: 1, speed: 1.6, think: 0 },
};
const LAYERS = [
  { alpha: 1, freqA: 1.6, freqB: 2.3, drift: 1.1, glow: 14 },
  { alpha: 0.35, freqA: 1.1, freqB: 3.1, drift: -1.4, glow: 0 },
  { alpha: 0.16, freqA: 2.1, freqB: 1.3, drift: 0.8, glow: 0 },
];
const calm = matchMedia("(prefers-reduced-motion: reduce)").matches;

export function Line({ mood, pulse }: { mood: Mood; pulse: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const state = useRef({ ...MOODS.idle, kick: 0 });

  useEffect(() => {
    const target = MOODS[mood];
    if (calm) Object.assign(state.current, target);
    else gsap.to(state.current, { ...target, duration: 0.6, ease: "power2.out", overwrite: "auto" });
  }, [mood]);

  useEffect(() => {
    state.current.kick = 1;
  }, [pulse]);

  useEffect(() => {
    const element = canvas.current!;
    const ctx = element.getContext("2d")!;
    const parent = element.parentElement!;
    let width = 1;
    let height = 1;
    let time = 0;
    let last = performance.now();
    let frame = 0;

    const resize = () => {
      width = Math.max(1, parent.clientWidth);
      height = Math.max(1, parent.clientHeight);
      const scale = Math.min(devicePixelRatio || 1, 2);
      element.width = width * scale;
      element.height = height * scale;
      ctx.setTransform(scale, 0, 0, scale, 0, 0);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(parent);
    resize();

    const draw = (now: number) => {
      frame = requestAnimationFrame(draw);
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const s = state.current;
      time += dt * (calm ? 0.12 : 1) * s.speed;
      s.kick *= 0.9;
      const energy = Math.min(1.2, s.energy + s.kick * 0.3);

      const styles = getComputedStyle(document.documentElement);
      const ink = styles.getPropertyValue("--ink").trim();
      const glow = document.documentElement.dataset.mode === "dark" ? 1 : 0;
      ctx.fillStyle = styles.getPropertyValue("--ground").trim();
      ctx.fillRect(0, 0, width, height);

      const middle = height / 2;
      const talk = (Math.sin(time * 11) * 0.5 + Math.sin(time * 6.7) * 0.3 + Math.sin(time * 17.3) * 0.2) * 0.5 + 0.5;
      const amplitude = height * (0.012 + energy * 0.24 * (0.55 + talk * 0.45));
      for (const layer of LAYERS) {
        ctx.beginPath();
        for (let x = 0; x <= width + 3; x += 3) {
          const u = x / width;
          const envelope = Math.sin(Math.PI * Math.min(u, 1)) ** 2;
          const wave =
            Math.sin(u * layer.freqA * Math.PI * 2 + time * layer.drift * 2) * 0.6 +
            Math.sin(u * layer.freqB * Math.PI * 2 - time * layer.drift * 3) * 0.4;
          const y = middle + envelope * amplitude * wave;
          if (x === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.globalAlpha = layer.alpha;
        ctx.strokeStyle = ink;
        ctx.lineWidth = layer.glow ? 1.6 : 1;
        ctx.shadowColor = ink;
        ctx.shadowBlur = layer.glow * glow;
        ctx.stroke();
      }
      ctx.shadowBlur = 0;
      if (s.think > 0.01) {
        const amber = styles.getPropertyValue("--amber").trim();
        ctx.globalAlpha = s.think;
        ctx.fillStyle = amber;
        ctx.shadowColor = amber;
        ctx.shadowBlur = 18 * glow;
        ctx.beginPath();
        ctx.arc(width * (0.5 + 0.42 * Math.sin(time * 1.6)), middle, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
      }
      ctx.globalAlpha = 1;
    };
    frame = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, []);

  return <canvas ref={canvas} className="line" role="img" aria-label={`Jarvis is ${mood}`} />;
}
