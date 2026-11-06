// Jarvis himself: one glowing line across the window. Above it is Jarvis, below it is Claude, and
// the message box sits on it. Whatever is running peels off it as a strand.
import gsap from "gsap";
import { useEffect, useRef } from "react";

export type Mood = "idle" | "listening" | "thinking" | "speaking";
export type Snap = "high" | "mid" | "low";
export type StrandItem = { id: string; kind: "claude" | "shell" | "timer"; active: boolean; working: boolean; asking: boolean; frac: number };

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
type Layer = (typeof LAYERS)[number];
type Strand = { item: StrandItem; group: string; depth: number; x1: number | null; x2: number; tx1: number; tx2: number; dying: boolean };
type Packet = { strand: Strand; toClaude: boolean; progress: number };

const TAU = Math.PI * 2;
const NARROW = 760; // Must match the max-width media query in styles.css.
const calm = matchMedia("(prefers-reduced-motion: reduce)").matches;

function stored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function store(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // It just won't be remembered.
  }
}

// Holds everything that moves every frame, so moving the line never re-renders the app.
export class LineEngine {
  state = { ...MOODS.idle, kick: 0 };
  span = calm ? 1 : 0;
  snap: Snap = (["high", "mid", "low"] as const).find((name) => name === stored("jarvis-line")) ?? "mid";
  moved = stored("jarvis-line-moved") === "1";
  onMoved: (() => void) | null = null;
  onSnap: ((snap: Snap) => void) | null = null;
  project = false;
  prefs = false;

  private y = 0;
  private velocity = 0;
  private dragging = false;
  private grab = 0;
  private lastPointer = { y: 0, time: 0 };
  private hot = 0;
  private reach = 430;
  private time = 0;
  private amplitude = 8;
  private width = 1;
  private height = 1;
  private boxHeight = 52;
  private boxWidth = 0;
  private decisionHeight = 0;
  private written = { y: -1, boxTop: -1, tight: false };
  private segments: [number, number][] = [[0, 1]];
  private strands = new Map<string, Strand>();
  private labels = new Map<string, HTMLElement>();
  private packets: Packet[] = [];
  private tokens = { ink: "#fff", amber: "#fb0", claude: "#d97757", mute: "#999", glow: 1 };
  private root: HTMLElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;

  get narrow() {
    return this.width < NARROW;
  }
  private get clearance() {
    return this.narrow ? this.boxHeight + 44 : this.boxHeight - 26;
  }
  private snapY(name: Snap): number {
    const high = 36 + 96 + 14 + this.clearance;
    // All the way down, only the strands of Claude's side stay in view.
    const low = Math.max(high + 80, this.height - 50);
    if (name === "high") return high;
    if (name === "low") return low;
    return Math.min(low - 40, Math.max(high + 40, this.height * 0.42));
  }
  private targetY(): number {
    const bottom = this.height - (this.narrow ? 20 : 62);
    if (this.prefs) return bottom;
    let base = this.project ? this.snapY(this.snap) : Math.max(36 + 96 + 14 + this.clearance, Math.min(this.height * 0.68, this.height - 130));
    // A question always gets enough room to be read, then the line goes back.
    if (this.decisionHeight) base = Math.max(base, Math.min(bottom, 36 + 14 + this.clearance + this.decisionHeight + 18));
    return base;
  }

  setSnap(name: Snap) {
    this.snap = name;
    store("jarvis-line", name);
    this.onSnap?.(name);
  }
  private markMoved() {
    if (this.moved) return;
    this.moved = true;
    store("jarvis-line-moved", "1");
    this.onMoved?.();
  }
  step(direction: 1 | -1) {
    const order: Snap[] = ["low", "mid", "high"];
    this.setSnap(order[Math.max(0, Math.min(2, order.indexOf(this.snap) + direction))]);
    this.markMoved();
  }
  toggle() {
    this.setSnap(this.snap === "high" ? "mid" : "high");
    this.markMoved();
  }
  beginDrag(pointerY: number, time: number) {
    if (this.prefs) return;
    this.dragging = true;
    this.grab = pointerY - this.y;
    this.velocity = 0;
    this.lastPointer = { y: this.y, time };
  }
  moveDrag(pointerY: number, time: number) {
    if (!this.dragging) return;
    const y = Math.max(this.snapY("high"), Math.min(this.snapY("low"), pointerY - this.grab));
    const elapsed = Math.max(1, time - this.lastPointer.time) / 1000;
    this.velocity = this.velocity * 0.6 + ((y - this.lastPointer.y) / elapsed) * 0.4;
    this.lastPointer = { y, time };
    this.y = y;
  }
  endDrag() {
    if (!this.dragging) return;
    this.dragging = false;
    const aim = this.y + this.velocity * 0.16;
    const nearest = (["high", "mid", "low"] as const).reduce((a, b) => (Math.abs(this.snapY(b) - aim) < Math.abs(this.snapY(a) - aim) ? b : a));
    this.setSnap(nearest);
    this.velocity = Math.max(-1800, Math.min(1800, this.velocity));
    this.markMoved();
  }

  // The window tells the line what's running. Things that stop merge back in instead of vanishing.
  sync(group: string, items: StrandItem[]) {
    const ids = new Set(items.map((item) => item.id));
    for (const strand of this.strands.values()) {
      if (strand.group === group && !ids.has(strand.item.id)) strand.dying = true;
    }
    for (const item of items) {
      const strand = this.strands.get(item.id);
      if (strand) {
        strand.item = item;
        strand.dying = false;
      } else {
        this.strands.set(item.id, { item, group, depth: 0, x1: null, x2: 0, tx1: 0, tx2: 0, dying: false });
      }
    }
  }
  label(id: string, element: HTMLElement | null) {
    if (element) this.labels.set(id, element);
    else this.labels.delete(id);
  }
  // A small light travels along the line when Jarvis and Claude pass something on.
  packet(id: string | undefined, toClaude: boolean) {
    const strand = id ? this.strands.get(id) : undefined;
    if (strand && !calm) this.packets.push({ strand, toClaude, progress: 0 });
  }
  watchBox(box: HTMLElement) {
    const observer = new ResizeObserver(() => {
      this.boxHeight = box.offsetHeight || 52;
      this.boxWidth = box.offsetWidth;
      this.written.boxTop = -1;
    });
    observer.observe(box);
    return () => observer.disconnect();
  }
  watchDecision(element: HTMLElement | null) {
    if (!element) {
      this.decisionHeight = 0;
      return () => {};
    }
    const observer = new ResizeObserver(() => (this.decisionHeight = element.offsetHeight));
    observer.observe(element);
    this.decisionHeight = element.offsetHeight;
    this.state.kick = 1;
    return () => {
      observer.disconnect();
      this.decisionHeight = 0;
    };
  }
  readTokens() {
    const styles = getComputedStyle(document.documentElement);
    const read = (name: string) => styles.getPropertyValue(`--${name}`).trim();
    this.tokens = { ink: read("ink"), amber: read("amber"), claude: read("claude"), mute: read("mute"), glow: document.documentElement.dataset.mode === "dark" ? 1 : 0 };
  }

  start(canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext("2d");
    this.root = canvas.closest(".shell");
    this.readTokens();
    const resize = () => {
      this.width = Math.max(1, innerWidth);
      this.height = Math.max(1, innerHeight);
      const scale = Math.min(devicePixelRatio || 1, 2);
      canvas.width = this.width * scale;
      canvas.height = this.height * scale;
      this.ctx!.setTransform(scale, 0, 0, scale, 0, 0);
      this.written.y = -1;
    };
    addEventListener("resize", resize);
    resize();
    if (!this.y) this.y = this.targetY();
    let frame = 0;
    let last = performance.now();
    const draw = (now: number) => {
      frame = requestAnimationFrame(draw);
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      this.draw(dt);
    };
    frame = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(frame);
      removeEventListener("resize", resize);
    };
  }

  // Everything else in the window positions itself from these two numbers.
  private writeLayout() {
    if (!this.root) return;
    const boxBottom = this.narrow ? this.y - 44 : this.y + 26;
    const boxTop = boxBottom - this.boxHeight;
    if (Math.abs(this.y - this.written.y) < 0.1 && Math.abs(boxTop - this.written.boxTop) < 0.1) return;
    this.written.y = this.y;
    this.written.boxTop = boxTop;
    this.root.style.setProperty("--ly", `${this.y}px`);
    this.root.style.setProperty("--box-top", `${boxTop}px`);
    const tight = boxTop - 50 < 170;
    if (tight !== this.written.tight) {
      this.written.tight = tight;
      this.root.dataset.room = tight ? "tight" : "wide";
    }
  }

  private layerY(x: number, segment: [number, number], layer: Layer) {
    const u = (x - segment[0]) / (segment[1] - segment[0]);
    const envelope = Math.sin(Math.PI * Math.min(u, 1)) ** 2;
    const wave =
      Math.sin(u * layer.freqA * TAU + this.time * layer.drift * 2) * 0.6 +
      Math.sin(u * layer.freqB * TAU - this.time * layer.drift * 3) * 0.4;
    return this.y + envelope * this.amplitude * wave;
  }
  private waveY(x: number) {
    const segment = this.segments.find((part) => x >= part[0] && x <= part[1]);
    return segment ? this.layerY(x, segment, LAYERS[0]) : this.y;
  }

  private placeStrands() {
    const live = [...this.strands.values()].filter((strand) => !strand.dying);
    const claudes = live.filter((strand) => strand.item.kind === "claude");
    const shells = live.filter((strand) => strand.item.kind === "shell");
    const timers = live.filter((strand) => strand.item.kind === "timer");
    // Until the box has been measured, or on a narrow window, the line is one unbroken piece.
    const whole = this.segments.length < 2;
    const leftEnd = whole ? this.width * 0.62 : this.segments[0][1] - 14;
    const rightStart = whole ? this.width * 0.62 : this.segments[1][0] + 14;
    const rightEnd = this.width - 100; // Clear of the +, minimize and close buttons.
    claudes.forEach((strand, index) => {
      const width = Math.min(190, (leftEnd - 18) / claudes.length);
      strand.tx1 = 18 + index * width;
      strand.tx2 = strand.tx1 + width - 12;
    });
    shells.forEach((strand, index) => {
      const width = Math.min(130, (rightEnd - rightStart) / shells.length);
      strand.tx1 = rightStart + index * width;
      strand.tx2 = strand.tx1 + width - 10;
    });
    const timerStart = this.narrow ? 18 : rightStart;
    const timerRoom = this.narrow ? this.width - 36 : rightEnd - rightStart;
    timers.forEach((strand, index) => {
      const width = Math.min(170, timerRoom / timers.length);
      strand.tx1 = timerStart + index * width;
      strand.tx2 = strand.tx1 + 58 + (width - 70) * Math.max(0, strand.item.frac);
    });
  }
  private strandLift(strand: Strand, x: number) {
    const edge = Math.min(x - strand.x1!, strand.x2 - x) / 40;
    if (edge <= 0) return 0;
    return edge >= 1 ? 1 : edge * edge * (3 - 2 * edge);
  }
  private drawStrand(ctx: CanvasRenderingContext2D, strand: Strand, dt: number) {
    if (strand.x1 === null) {
      strand.x1 = strand.tx1;
      strand.x2 = strand.tx2;
    }
    const ease = 1 - Math.exp(-dt * 8);
    strand.x1 += (strand.tx1 - strand.x1) * ease;
    strand.x2 += (strand.tx2 - strand.x2) * ease;
    const { item } = strand;
    // A question flips Claude's strand up through the line, onto Jarvis's side.
    const want = strand.dying ? 0 : item.kind === "timer" ? -20 : item.asking ? -24 : 18;
    strand.depth += (want - strand.depth) * (1 - Math.exp(-dt * (strand.dying ? 9 : 6)));
    const label = this.labels.get(item.id);
    if (label) {
      label.style.left = `${strand.x1 + 6}px`;
      label.style.width = `${Math.max(0, strand.x2 - strand.x1 - 12)}px`;
    }
    if (strand.x2 - strand.x1 < 4) return;
    const color = item.asking ? this.tokens.amber : item.kind === "claude" ? this.tokens.claude : item.kind === "timer" ? this.tokens.ink : this.tokens.mute;
    const tremble = item.asking ? 1.2 : item.working ? 2.4 : 0;
    const strong = item.active || item.asking;
    ctx.beginPath();
    let started = false;
    for (let x = strand.x1; x <= strand.x2 + 2; x += 3) {
      const at = Math.min(x, strand.x2);
      const lift = this.strandLift(strand, at);
      const shake = calm ? 0 : tremble * lift * Math.sin(at * 0.11 + this.time * 13);
      const y = this.waveY(at) + (strand.depth + shake) * lift;
      if (started) ctx.lineTo(at, y);
      else ctx.moveTo(at, y);
      started = true;
    }
    ctx.globalAlpha = item.kind === "timer" ? 0.75 : strong ? 1 : 0.5;
    ctx.strokeStyle = color;
    ctx.lineWidth = strong ? 1.6 : 1;
    ctx.shadowColor = color;
    ctx.shadowBlur = (strong ? 10 : 0) * this.tokens.glow;
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1;
  }
  private drawPackets(ctx: CanvasRenderingContext2D, dt: number) {
    this.packets = this.packets.filter((packet) => {
      packet.progress = Math.min(1, packet.progress + dt / 0.62);
      const p = packet.progress;
      const eased = p < 0.5 ? 2 * p * p : 1 - (-2 * p + 2) ** 2 / 2;
      const strand = packet.strand;
      if (strand.x1 === null) return false;
      const from = this.narrow ? this.width / 2 : this.segments[0][1];
      const to = (strand.x1 + strand.x2) / 2;
      const x = packet.toClaude ? from + (to - from) * eased : to + (from - to) * eased;
      ctx.fillStyle = this.tokens.ink;
      ctx.shadowColor = this.tokens.claude;
      ctx.shadowBlur = 16 * this.tokens.glow;
      ctx.beginPath();
      ctx.arc(x, this.waveY(x) + strand.depth * this.strandLift(strand, x), 2.8, 0, TAU);
      ctx.fill();
      ctx.shadowBlur = 0;
      if (p >= 1) this.state.kick = Math.max(this.state.kick, 0.5);
      return p < 1;
    });
  }

  private draw(dt: number) {
    const ctx = this.ctx!;
    const s = this.state;
    this.time += dt * (calm ? 0.12 : 1) * s.speed;
    s.kick *= 0.9;
    const wantHot = this.dragging || this.handleHover ? 1 : 0;
    this.hot += (wantHot - this.hot) * (1 - Math.exp(-dt * 12));
    this.reach += ((this.project ? 110 : this.narrow ? 300 : 430) - this.reach) * (1 - Math.exp(-dt * 3));

    if (!this.dragging) {
      const target = this.targetY();
      if (calm) {
        this.y = target;
      } else {
        // A spring, so the line settles like something with weight.
        this.velocity += ((target - this.y) * 170 - this.velocity * 24) * dt;
        this.y += this.velocity * dt;
        if (Math.abs(target - this.y) < 0.05 && Math.abs(this.velocity) < 0.5) {
          this.y = target;
          this.velocity = 0;
        }
      }
    }
    this.writeLayout();
    if (this.narrow || !this.boxWidth) {
      this.segments = [[0, this.width]];
    } else {
      const left = (this.width - this.boxWidth) / 2;
      this.segments = [[0, left], [left + this.boxWidth, this.width]];
    }
    this.placeStrands();

    ctx.clearRect(0, 0, this.width, this.height);
    const talk = (Math.sin(this.time * 11) * 0.5 + Math.sin(this.time * 6.7) * 0.3 + Math.sin(this.time * 17.3) * 0.2) * 0.5 + 0.5;
    const energy = Math.min(1.2, s.energy + s.kick * 0.3);
    this.amplitude = this.reach * (0.012 + energy * 0.24 * (0.55 + talk * 0.45));

    ctx.save();
    const half = (this.width / 2) * this.span;
    ctx.beginPath();
    ctx.rect(this.width / 2 - half, 0, half * 2, this.height);
    ctx.clip();
    for (const segment of this.segments) {
      if (segment[1] - segment[0] < 4) continue;
      for (const layer of LAYERS) {
        ctx.beginPath();
        for (let x = segment[0]; x <= segment[1]; x += 3) {
          const y = this.layerY(x, segment, layer);
          if (x === segment[0]) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.lineTo(segment[1], this.y);
        ctx.globalAlpha = layer.alpha;
        ctx.strokeStyle = this.tokens.ink;
        ctx.lineWidth = layer.glow ? 1.6 + this.hot * 0.9 : 1;
        ctx.shadowColor = this.tokens.ink;
        ctx.shadowBlur = (layer.glow ? layer.glow + this.hot * 8 : 0) * this.tokens.glow;
        ctx.stroke();
      }
    }
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1;
    for (const [id, strand] of this.strands) {
      this.drawStrand(ctx, strand, dt);
      if (strand.dying && Math.abs(strand.depth) < 0.4) this.strands.delete(id);
    }
    this.drawPackets(ctx, dt);
    if (s.think > 0.01) {
      const x = this.width * (0.5 + 0.42 * Math.sin(this.time * 1.6));
      ctx.globalAlpha = s.think;
      ctx.fillStyle = this.tokens.amber;
      ctx.shadowColor = this.tokens.amber;
      ctx.shadowBlur = 18 * this.tokens.glow;
      ctx.beginPath();
      ctx.arc(x, this.waveY(x), 4, 0, TAU);
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.globalAlpha = 1;
    }
    ctx.restore();
  }

  handleHover = false;
}

export function Line({ engine, mood, pulse, movable }: { engine: LineEngine; mood: Mood; pulse: number; movable: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const target = MOODS[mood];
    if (calm) Object.assign(engine.state, target);
    else gsap.to(engine.state, { ...target, duration: 0.6, ease: "power2.out", overwrite: "auto" });
  }, [engine, mood]);

  useEffect(() => {
    engine.state.kick = 1;
  }, [engine, pulse]);

  useEffect(() => {
    const stop = engine.start(canvas.current!);
    // On boot the line draws itself out from the middle of the window.
    if (!calm) gsap.to(engine, { span: 1, duration: 1.1, delay: 0.1, ease: "power3.out" });
    return stop;
  }, [engine]);

  return (
    <>
      <canvas ref={canvas} className="line" role="img" aria-label={`Jarvis is ${mood}`} />
      {movable && (
        <div
          className="line-handle"
          role="separator"
          aria-orientation="horizontal"
          aria-label="Move the line. Up gives Claude more room, down gives Jarvis more."
          tabIndex={0}
          onPointerEnter={() => (engine.handleHover = true)}
          onPointerLeave={() => (engine.handleHover = false)}
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId);
            engine.beginDrag(event.clientY, event.timeStamp);
          }}
          onPointerMove={(event) => engine.moveDrag(event.clientY, event.timeStamp)}
          onPointerUp={() => engine.endDrag()}
          onPointerCancel={() => engine.endDrag()}
          onDoubleClick={() => engine.toggle()}
          onKeyDown={(event) => {
            if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
            event.preventDefault();
            engine.step(event.key === "ArrowUp" ? 1 : -1);
          }}
        />
      )}
    </>
  );
}
