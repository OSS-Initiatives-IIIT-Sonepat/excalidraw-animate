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
  const usedStartIndices = new Set<number>();
  const usedEndIndices = new Set<number>();

  for (let i = 0; i < startEls.length; i++) {
    const startEl = startEls[i];
    let bestIdx = -1;
    let bestScore = Infinity;

    for (let j = 0; j < endEls.length; j++) {
      if (usedEndIndices.has(j)) continue;
      const endEl = endEls[j];

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
      usedStartIndices.add(i);
      usedEndIndices.add(bestIdx);
      pairs.push([startEl, endEls[bestIdx]]);
    }
  }

  const unmatchedStart = startEls.filter(
    (_, i) => !usedStartIndices.has(i),
  ) as ExcalidrawElement[];
  const unmatchedEnd = endEls.filter(
    (_, j) => !usedEndIndices.has(j),
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

/**
 * Interpolate a single element between two states.
 */
const interpolateElement = (
  startEl: ExcalidrawElement,
  endEl: ExcalidrawElement,
  t: number,
): ExcalidrawElement => {
  const lerp = (a: number, b: number) => a + (b - a) * t;

  return {
    ...startEl,
    x: lerp(startEl.x, endEl.x),
    y: lerp(startEl.y, endEl.y),
    width: lerp(startEl.width, endEl.width),
    height: lerp(startEl.height, endEl.height),
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

// ─── Singleton ────────────────────────────────────────────────────────────────

let engineInstance: GsapAnimationEngine | null = null;

export const getGsapEngine = (): GsapAnimationEngine => {
  if (!engineInstance) {
    engineInstance = new GsapAnimationEngine();
  }
  return engineInstance;
};
