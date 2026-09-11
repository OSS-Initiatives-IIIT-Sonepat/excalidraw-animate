import gsap from "gsap";
import type { ExcalidrawElement } from "@excalidraw/element/types";
import type { Keyframe } from "./TimelineStore";

// ─── Element Matching (ported from actionAnimate) ─────────────────────────────

/**
 * Match elements between two snapshots by type + relative position similarity.
 */
export const matchSnapshotElements = (
  startEls: readonly ExcalidrawElement[],
  endEls: readonly ExcalidrawElement[],
): {
  pairs: [ExcalidrawElement, ExcalidrawElement][];
  unmatchedStart: ExcalidrawElement[];
  unmatchedEnd: ExcalidrawElement[];
} => {
  const pairs: [ExcalidrawElement, ExcalidrawElement][] = [];

  // ── Pass 1: match by stable id ──────────────────────────────────────────
  // The common case is editing the *same* elements between keyframes, not
  // swapping them out. Without this, two elements of the same type with
  // similar bounding boxes (e.g. two arrows) can get cross-matched to each
  // other by the geometric pass below, and each ends up morphing toward
  // the wrong shape entirely instead of just not moving.
  const usedStartIds = new Set<string>();
  const usedEndIds = new Set<string>();
  const endById = new Map(endEls.map((el) => [el.id, el]));

  for (const startEl of startEls) {
    const endEl = endById.get(startEl.id);
    if (endEl && endEl.type === startEl.type) {
      pairs.push([startEl, endEl]);
      usedStartIds.add(startEl.id);
      usedEndIds.add(endEl.id);
    }
  }

  // ── Pass 2: geometric nearest-neighbor for genuine leftovers ────────────
  // Only elements whose id truly doesn't exist on the other side (deleted,
  // or newly drawn) — the Magic-Move-style diffing case.
  const remainingStart = startEls.filter((el) => !usedStartIds.has(el.id));
  const remainingEnd = endEls.filter((el) => !usedEndIds.has(el.id));
  const usedEndIndices = new Set<number>();

  for (const startEl of remainingStart) {
    let bestIdx = -1;
    let bestScore = Infinity;

    for (let j = 0; j < remainingEnd.length; j++) {
      if (usedEndIndices.has(j)) continue;
      const endEl = remainingEnd[j];

      // Type must match
      if (startEl.type !== endEl.type) continue;

      // Score by position similarity
      const dx = startEl.x - endEl.x;
      const dy = startEl.y - endEl.y;
      const dw = startEl.width - endEl.width;
      const dh = startEl.height - endEl.height;
      const score = dx * dx + dy * dy + dw * dw + dh * dh;

      if (score < bestScore) {
        bestScore = score;
        bestIdx = j;
      }
    }

    if (bestIdx !== -1) {
      usedEndIndices.add(bestIdx);
      pairs.push([startEl, remainingEnd[bestIdx]]);
    }
  }

  const matchedStartIds = new Set(pairs.map(([s]) => s.id));
  const matchedEndIds = new Set(pairs.map(([, e]) => e.id));

  const unmatchedStart = startEls.filter(
    (el) => !matchedStartIds.has(el.id),
  ) as ExcalidrawElement[];
  const unmatchedEnd = endEls.filter(
    (el) => !matchedEndIds.has(el.id),
  ) as ExcalidrawElement[];

  return { pairs, unmatchedStart, unmatchedEnd };
};

// ─── Color Interpolation ──────────────────────────────────────────────────────

const parseHexColor = (
  c: string,
): [number, number, number] | null => {
  if (!c || c === "transparent") return null;
  try {
    const hex = c.replace("#", "");
    if (hex.length === 3) {
      return [
        parseInt(hex[0] + hex[0], 16),
        parseInt(hex[1] + hex[1], 16),
        parseInt(hex[2] + hex[2], 16),
      ];
    }
    return [
      parseInt(hex.substring(0, 2), 16),
      parseInt(hex.substring(2, 4), 16),
      parseInt(hex.substring(4, 6), 16),
    ];
  } catch {
    return null;
  }
};

const lerpColor = (
  colorA: string,
  colorB: string,
  t: number,
): string => {
  if (colorA === colorB) return colorA;
  const a = parseHexColor(colorA);
  const b = parseHexColor(colorB);
  if (!a || !b) return t < 0.5 ? colorA : colorB;

  const r = Math.round(a[0] + (b[0] - a[0]) * t);
  const g = Math.round(a[1] + (b[1] - a[1]) * t);
  const bl = Math.round(a[2] + (b[2] - a[2]) * t);
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${bl.toString(16).padStart(2, "0")}`;
};

// ─── Element Interpolation ────────────────────────────────────────────────────

const getPointAtT = (points: readonly [number, number][], t: number): [number, number] => {
  if (points.length === 0) return [0, 0];
  if (points.length === 1) return points[0];
  if (t <= 0) return points[0];
  if (t >= 1) return points[points.length - 1];

  const dists = [0];
  for (let i = 1; i < points.length; i++) {
    const dx = points[i][0] - points[i - 1][0];
    const dy = points[i][1] - points[i - 1][1];
    dists.push(dists[i - 1] + Math.hypot(dx, dy));
  }

  const totalDist = dists[dists.length - 1];
  if (totalDist === 0) return points[0];

  const targetDist = t * totalDist;
  for (let i = 1; i < dists.length; i++) {
    if (targetDist <= dists[i]) {
      const segmentDist = dists[i] - dists[i - 1];
      const segmentT = segmentDist === 0 ? 0 : (targetDist - dists[i - 1]) / segmentDist;
      const p1 = points[i - 1];
      const p2 = points[i];
      return [
        p1[0] + (p2[0] - p1[0]) * segmentT,
        p1[1] + (p2[1] - p1[1]) * segmentT,
      ];
    }
  }
  return points[points.length - 1];
};

/**
 * Interpolate a single element between two states.
 */
const interpolateElement = (
  startEl: ExcalidrawElement,
  endEl: ExcalidrawElement,
  t: number,
): ExcalidrawElement => {
  const lerp = (a: number, b: number) => a + (b - a) * t;

  const baseEl = {
    ...startEl,
    x: lerp(startEl.x, endEl.x),
    y: lerp(startEl.y, endEl.y),
    angle: lerp(
      startEl.angle as number,
      endEl.angle as number,
    ) as ExcalidrawElement["angle"],
    opacity: lerp(startEl.opacity, endEl.opacity),
    backgroundColor: lerpColor(
      startEl.backgroundColor,
      endEl.backgroundColor,
      t,
    ),
    strokeColor: lerpColor(startEl.strokeColor, endEl.strokeColor, t),
  };

  if (startEl.type === "arrow" || startEl.type === "line") {
    const sEl = startEl as any;
    const eEl = endEl as any;
    const startPoints = sEl.points || [[0, 0]];
    const endPoints = eEl.points || [[0, 0]];

    const N = Math.max(startPoints.length, endPoints.length);
    const newPoints: [number, number][] = [];

    if (N < 2) {
      const p1 = startPoints[0] || [0, 0];
      const p2 = endPoints[0] || [0, 0];
      newPoints.push([lerp(p1[0], p2[0]), lerp(p1[1], p2[1])]);
    } else {
      for (let i = 0; i < N; i++) {
        const ptT = i / (N - 1);
        const p1 = getPointAtT(startPoints, ptT);
        const p2 = getPointAtT(endPoints, ptT);
        newPoints.push([lerp(p1[0], p2[0]), lerp(p1[1], p2[1])]);
      }
    }

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const pt of newPoints) {
      if (pt[0] < minX) minX = pt[0];
      if (pt[1] < minY) minY = pt[1];
      if (pt[0] > maxX) maxX = pt[0];
      if (pt[1] > maxY) maxY = pt[1];
    }

    const width = minX === Infinity ? 0 : maxX - minX;
    const height = minY === Infinity ? 0 : maxY - minY;

    return {
      ...baseEl,
      type: startEl.type,
      width,
      height,
      points: newPoints,
      startBinding: eEl.startBinding ?? null,
      endBinding: eEl.endBinding ?? null,
    } as any;
  }

  return {
    ...baseEl,
    width: lerp(startEl.width, endEl.width),
    height: lerp(startEl.height, endEl.height),
  } as ExcalidrawElement;
};

// ─── GSAP Animation Engine ────────────────────────────────────────────────────

export type OnFrameCallback = (
  elements: ExcalidrawElement[],
  time: number,
) => void;

export type OnCompleteCallback = () => void;

export class GsapAnimationEngine {
  private timeline: gsap.core.Timeline | null = null;
  private onFrame: OnFrameCallback | null = null;
  private onComplete: OnCompleteCallback | null = null;
  private progressProxy = { progress: 0 };
  private speed = 1;

  /**
   * Build a GSAP timeline from sorted keyframes.
   */
  build(
    keyframes: Keyframe[],
    onFrame: OnFrameCallback,
    onComplete?: OnCompleteCallback,
  ) {
    this.destroy();

    if (keyframes.length < 2) {
      console.warn("Need at least 2 keyframes to animate");
      return;
    }

    this.onFrame = onFrame;
    this.onComplete = onComplete || null;

    // Sort keyframes by time
    const sorted = [...keyframes].sort((a, b) => a.time - b.time);

    // Create the master timeline
    this.timeline = gsap.timeline({
      paused: true,
      onComplete: () => {
        this.onComplete?.();
      },
    });
    this.timeline.timeScale(this.speed);

    // For each pair of consecutive keyframes, create a tween segment
    for (let i = 0; i < sorted.length - 1; i++) {
      const startKf = sorted[i];
      const endKf = sorted[i + 1];
      const segmentDuration = endKf.time - startKf.time;

      if (segmentDuration <= 0) continue;

      const segmentProxy = { t: 0 };

      this.timeline.to(
        segmentProxy,
        {
          t: 1,
          duration: segmentDuration,
          ease: startKf.easing || "power2.inOut",
          onUpdate: () => {
            const elements = this.interpolateKeyframes(
              startKf,
              endKf,
              segmentProxy.t,
            );
            const currentTime =
              startKf.time + segmentProxy.t * segmentDuration;
            this.onFrame?.(elements, currentTime);
          },
        },
        startKf.time, // position on the timeline
      );
    }

    // Show the first keyframe immediately
    if (sorted.length > 0) {
      this.onFrame(
        sorted[0].elementSnapshots as ExcalidrawElement[],
        sorted[0].time,
      );
    }
  }

  /**
   * Interpolate between two keyframes at progress t (0-1).
   */
  private interpolateKeyframes(
    startKf: Keyframe,
    endKf: Keyframe,
    t: number,
  ): ExcalidrawElement[] {
    return interpolateKeyframesRaw(startKf, endKf, t);
  }

  // ── Playback Controls ──

  play() {
    this.timeline?.play();
  }

  pause() {
    this.timeline?.pause();
  }

  togglePlayPause() {
    if (!this.timeline) return;
    if (this.timeline.isActive()) {
      this.timeline.pause();
    } else {
      this.timeline.play();
    }
  }

  /**
   * Seek to a specific time in seconds.
   */
  seek(time: number) {
    this.timeline?.seek(time);
  }

  /**
   * Get the total duration of the built timeline.
   */
  getDuration(): number {
    return this.timeline?.duration() || 0;
  }

  /**
   * Get the current playback time.
   */
  getCurrentTime(): number {
    return this.timeline?.time() || 0;
  }

  isActive(): boolean {
    return this.timeline?.isActive() || false;
  }

  isPaused(): boolean {
    return this.timeline?.paused() || true;
  }

  /**
   * Set playback speed (1 = normal, 0.5 = half, 2 = double).
   */
  setSpeed(speed: number) {
    this.speed = speed;
    this.timeline?.timeScale(speed);
  }

  /**
   * Restart from the beginning.
   */
  restart() {
    this.timeline?.restart();
  }

  /**
   * Destroy the timeline and clean up.
   */
  destroy() {
    if (this.timeline) {
      this.timeline.kill();
      this.timeline = null;
    }
    this.onFrame = null;
    this.onComplete = null;
    this.progressProxy = { progress: 0 };
  }
}

// ─── Utility ──────────────────────────────────────────────────────────────────

export const interpolateKeyframesRaw = (
  startKf: Keyframe,
  endKf: Keyframe,
  t: number,
): ExcalidrawElement[] => {
  const { pairs, unmatchedStart, unmatchedEnd } =
    matchSnapshotElements(
      startKf.elementSnapshots,
      endKf.elementSnapshots,
    );

  // Interpolate matched pairs
  const interpolated = pairs.map(([startEl, endEl]) =>
    interpolateElement(startEl, endEl, t),
  );

  // Fade out unmatched start elements
  const fadingOut = unmatchedStart.map((el) => ({
    ...el,
    opacity: el.opacity * (1 - t),
  })) as ExcalidrawElement[];

  // Fade in unmatched end elements
  const fadingIn = unmatchedEnd.map((el) => ({
    ...el,
    opacity: el.opacity * t,
  })) as ExcalidrawElement[];

  return [...interpolated, ...fadingOut, ...fadingIn];
};

export const getElementsAtTime = (keyframes: Keyframe[], time: number): ExcalidrawElement[] | null => {
  if (keyframes.length === 0) return null;
  if (keyframes.length === 1) return keyframes[0].elementSnapshots.map(el => ({ ...el })) as ExcalidrawElement[];
  
  const sorted = [...keyframes].sort((a, b) => a.time - b.time);
  if (time <= sorted[0].time) return sorted[0].elementSnapshots.map(el => ({ ...el })) as ExcalidrawElement[];
  if (time >= sorted[sorted.length - 1].time) return sorted[sorted.length - 1].elementSnapshots.map(el => ({ ...el })) as ExcalidrawElement[];
  
  for (let i = 0; i < sorted.length - 1; i++) {
    const startKf = sorted[i];
    const endKf = sorted[i + 1];
    if (time >= startKf.time && time < endKf.time) {
      const segmentDuration = endKf.time - startKf.time;
      let t = (time - startKf.time) / segmentDuration;
      
      const ease = gsap.parseEase(startKf.easing || "power2.inOut");
      if (ease) {
        t = ease(t);
      }
      
      return interpolateKeyframesRaw(startKf, endKf, t);
    }
  }
  return null;
};

// ─── Singleton ────────────────────────────────────────────────────────────────

let engineInstance: GsapAnimationEngine | null = null;

export const getGsapEngine = (): GsapAnimationEngine => {
  if (!engineInstance) {
    engineInstance = new GsapAnimationEngine();
  }
  return engineInstance;
};