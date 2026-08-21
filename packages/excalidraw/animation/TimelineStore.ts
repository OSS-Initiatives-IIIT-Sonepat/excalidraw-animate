import { nanoid } from "nanoid";
import type { ExcalidrawElement } from "@excalidraw/element/types";

// ─── Keyframe Data Model ──────────────────────────────────────────────────────

export interface Keyframe {
  id: string;
  /** Time position in seconds (freeform, no snapping) */
  time: number;
  /** Deep snapshot of all canvas elements at this keyframe */
  elementSnapshots: readonly ExcalidrawElement[];
  /** Optional user label */
  label?: string;
  /** GSAP easing for the transition FROM this keyframe to the next */
  easing: string;
}

export interface TimelineState {
  keyframes: Keyframe[];
  /** Total duration in seconds (default 60, user-adjustable) */
  duration: number;
  /** Current playhead position in seconds */
  currentTime: number;
  /** Whether the timeline is currently playing */
  isPlaying: boolean;
  /** Timeline zoom level (pixels per second) */
  pixelsPerSecond: number;
  /** Scroll offset in pixels (for horizontal scrolling) */
  scrollOffset: number;
  /** Whether the timeline panel is open */
  isOpen: boolean;
}

// ─── Default State ────────────────────────────────────────────────────────────

const DEFAULT_PIXELS_PER_SECOND = 80;
const DEFAULT_DURATION = 60; // 60 seconds default
const MIN_DURATION = 5;
const MAX_DURATION = 600; // 10 minutes max

export const createDefaultTimelineState = (): TimelineState => ({
  keyframes: [],
  duration: DEFAULT_DURATION,
  currentTime: 0,
  isPlaying: false,
  pixelsPerSecond: DEFAULT_PIXELS_PER_SECOND,
  scrollOffset: 0,
  isOpen: false,
});

// ─── Timeline Store ───────────────────────────────────────────────────────────

export class TimelineStore {
  private state: TimelineState;
  private listeners: Set<(state: TimelineState) => void> = new Set();

  constructor(initialState?: Partial<TimelineState>) {
    this.state = { ...createDefaultTimelineState(), ...initialState };
  }

  getState(): TimelineState {
    return this.state;
  }

  subscribe(listener: (state: TimelineState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify() {
    const state = this.state;
    this.listeners.forEach((listener) => listener(state));
  }

  private setState(updates: Partial<TimelineState>) {
    this.state = { ...this.state, ...updates };
    this.notify();
  }

  // ── Keyframe Operations ──

  addKeyframe(
    time: number,
    elements: readonly ExcalidrawElement[],
    label?: string,
    easing: string = "power2.inOut",
  ): Keyframe {
    // Deep clone elements to create a snapshot
    const snapshot = elements.map((el) => ({ ...el }));
    const keyframe: Keyframe = {
      id: nanoid(),
      time: Math.max(0, Math.min(time, this.state.duration)),
      elementSnapshots: snapshot,
      label,
      easing,
    };

    const keyframes = [...this.state.keyframes, keyframe].sort(
      (a, b) => a.time - b.time,
    );
    this.setState({ keyframes });
    return keyframe;
  }

  removeKeyframe(id: string) {
    const keyframes = this.state.keyframes.filter((kf) => kf.id !== id);
    this.setState({ keyframes });
  }

  moveKeyframe(id: string, newTime: number) {
    const clampedTime = Math.max(0, Math.min(newTime, this.state.duration));
    const keyframes = this.state.keyframes
      .map((kf) => (kf.id === id ? { ...kf, time: clampedTime } : kf))
      .sort((a, b) => a.time - b.time);
    this.setState({ keyframes });
  }

  updateKeyframeLabel(id: string, label: string) {
    const keyframes = this.state.keyframes.map((kf) =>
      kf.id === id ? { ...kf, label } : kf,
    );
    this.setState({ keyframes });
  }

  updateKeyframeEasing(id: string, easing: string) {
    const keyframes = this.state.keyframes.map((kf) =>
      kf.id === id ? { ...kf, easing } : kf,
    );
    this.setState({ keyframes });
  }

  updateKeyframeSnapshot(
    id: string,
    elements: readonly ExcalidrawElement[],
  ) {
    const snapshot = elements.map((el) => ({ ...el }));
    const keyframes = this.state.keyframes.map((kf) =>
      kf.id === id ? { ...kf, elementSnapshots: snapshot } : kf,
    );
    this.setState({ keyframes });
  }

  /**
   * Get the two keyframes that surround the given time.
   * Returns [before, after] or [only, null] if at the edge.
   */
  getSurroundingKeyframes(
    time: number,
  ): [Keyframe | null, Keyframe | null] {
    const { keyframes } = this.state;
    if (keyframes.length === 0) return [null, null];

    let before: Keyframe | null = null;
    let after: Keyframe | null = null;

    for (const kf of keyframes) {
      if (kf.time <= time) {
        before = kf;
      } else if (kf.time > time && !after) {
        after = kf;
      }
    }

    return [before, after];
  }

  // ── Playback Controls ──

  setCurrentTime(time: number) {
    this.setState({
      currentTime: Math.max(0, Math.min(time, this.state.duration)),
    });
  }

  setPlaying(isPlaying: boolean) {
    this.setState({ isPlaying });
  }

  togglePlaying() {
    this.setState({ isPlaying: !this.state.isPlaying });
  }

  // ── Timeline Configuration ──

  setDuration(duration: number) {
    const clamped = Math.max(MIN_DURATION, Math.min(duration, MAX_DURATION));
    this.setState({ duration: clamped });
  }

  setPixelsPerSecond(pps: number) {
    this.setState({ pixelsPerSecond: Math.max(20, Math.min(pps, 400)) });
  }

  setScrollOffset(offset: number) {
    this.setState({ scrollOffset: Math.max(0, offset) });
  }

  setOpen(isOpen: boolean) {
    this.setState({ isOpen });
  }

  toggleOpen() {
    this.setState({ isOpen: !this.state.isOpen });
  }

  // ── Utilities ──

  /** Convert a time value to a pixel position */
  timeToPixels(time: number): number {
    return time * this.state.pixelsPerSecond;
  }

  /** Convert a pixel position to a time value */
  pixelsToTime(pixels: number): number {
    return pixels / this.state.pixelsPerSecond;
  }

  /** Get the total width of the timeline track in pixels */
  getTrackWidth(): number {
    return this.state.duration * this.state.pixelsPerSecond;
  }

  /** Reset the timeline to default state */
  reset() {
    this.setState(createDefaultTimelineState());
  }

  /** Clear all keyframes but keep configuration */
  clearKeyframes() {
    this.setState({ keyframes: [], currentTime: 0, isPlaying: false });
  }
}

// ─── Singleton Instance ───────────────────────────────────────────────────────

let timelineStoreInstance: TimelineStore | null = null;

export const getTimelineStore = (): TimelineStore => {
  if (!timelineStoreInstance) {
    timelineStoreInstance = new TimelineStore();
  }
  return timelineStoreInstance;
};

export const resetTimelineStore = () => {
  timelineStoreInstance = null;
};
