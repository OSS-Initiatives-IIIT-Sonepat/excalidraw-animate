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
// ─── Audio Data Model ────────────────────────────────────────────────────────

export interface AudioClip {
  id: string;
  /** Name shown in timeline */
  name: string;
  /** Temporary URL pointing to uploaded audio file */
  audioUrl: string;
  /** Original duration of the audio in seconds */
  sourceDuration: number;
  /** Position of the clip on the timeline in seconds */
  startTime: number;
  /** Clip volume from 0 to 1 */
  volume: number;
  /** Whether this individual clip is muted */
  muted: boolean;
}

export interface AudioTrack {
  id: string;
  /** Name shown on the timeline track */
  name: string;
  /** Audio clips inside this track */
  clips: AudioClip[];
  /** Whether the entire track is muted */
  muted: boolean;
}

export interface TimelineState {
  keyframesByFrame: Record<string, Keyframe[]>;
  audioTracksByFrame: Record<string, AudioTrack[]>;
  activeFrameId: string | null;
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
  keyframesByFrame: {},
  audioTracksByFrame: {},
  activeFrameId: null,
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

  setActiveFrameId(frameId: string | null) {
    if (this.state.activeFrameId !== frameId) {
      this.setState({
        activeFrameId: frameId,
        currentTime: 0,
        isPlaying: false,
      });
    }
  }

  getActiveKeyframes(): Keyframe[] {
    if (!this.state.activeFrameId) return [];
    return this.state.keyframesByFrame[this.state.activeFrameId] || [];
  }

  private setActiveKeyframes(keyframes: Keyframe[]) {
    if (!this.state.activeFrameId) return;
    this.setState({
      keyframesByFrame: {
        ...this.state.keyframesByFrame,
        [this.state.activeFrameId]: keyframes,
      },
    });
  }

  addKeyframe(
    time: number,
    elements: readonly ExcalidrawElement[],
    label?: string,
    easing: string = "power2.inOut",
  ): Keyframe | null {
    if (!this.state.activeFrameId) return null;

    // Deep clone elements to create a snapshot
    const snapshot = elements.map((el) => ({ ...el }));
    const keyframe: Keyframe = {
      id: nanoid(),
      time: Math.max(0, Math.min(time, this.state.duration)),
      elementSnapshots: snapshot,
      label,
      easing,
    };

    const currentKeyframes = this.getActiveKeyframes();
    const keyframes = [...currentKeyframes, keyframe].sort(
      (a, b) => a.time - b.time,
    );
    this.setActiveKeyframes(keyframes);
    return keyframe;
  }

  removeKeyframe(id: string) {
    const keyframes = this.getActiveKeyframes().filter((kf) => kf.id !== id);
    this.setActiveKeyframes(keyframes);
  }

  moveKeyframe(id: string, newTime: number) {
    const clampedTime = Math.max(0, Math.min(newTime, this.state.duration));
    const keyframes = this.getActiveKeyframes()
      .map((kf) => (kf.id === id ? { ...kf, time: clampedTime } : kf))
      .sort((a, b) => a.time - b.time);
    this.setActiveKeyframes(keyframes);
  }

  updateKeyframeLabel(id: string, label: string) {
    const keyframes = this.getActiveKeyframes().map((kf) =>
      kf.id === id ? { ...kf, label } : kf,
    );
    this.setActiveKeyframes(keyframes);
  }

  updateKeyframeEasing(id: string, easing: string) {
    const keyframes = this.getActiveKeyframes().map((kf) =>
      kf.id === id ? { ...kf, easing } : kf,
    );
    this.setActiveKeyframes(keyframes);
  }

  updateKeyframeSnapshot(id: string, elements: readonly ExcalidrawElement[]) {
    const snapshot = elements.map((el) => ({ ...el }));
    const keyframes = this.getActiveKeyframes().map((kf) =>
      kf.id === id ? { ...kf, elementSnapshots: snapshot } : kf,
    );
    this.setActiveKeyframes(keyframes);
  }

  /**
   * Get the two keyframes that surround the given time.
   * Returns [before, after] or [only, null] if at the edge.
   */
  getSurroundingKeyframes(time: number): [Keyframe | null, Keyframe | null] {
    const keyframes = this.getActiveKeyframes();
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

  // ── Audio Track Operations ───────────────────────────────────────────────────

  getActiveAudioTracks(): AudioTrack[] {
    if (!this.state.activeFrameId) {
      return [];
    }

    return this.state.audioTracksByFrame[this.state.activeFrameId] || [];
  }

  private setActiveAudioTracks(tracks: AudioTrack[]) {
    if (!this.state.activeFrameId) {
      return;
    }

    this.setState({
      audioTracksByFrame: {
        ...this.state.audioTracksByFrame,

        [this.state.activeFrameId]: tracks,
      },
    });
  }
  addAudioTrack(name: string = "Audio"): AudioTrack | null {
    if (!this.state.activeFrameId) {
      return null;
    }

    const track: AudioTrack = {
      id: nanoid(),
      name,
      clips: [],
      muted: false,
    };

    const tracks = [...this.getActiveAudioTracks(), track];

    this.setActiveAudioTracks(tracks);

    return track;
  }
  addAudioClip(
    trackId: string,
    clipData: Omit<AudioClip, "id">,
  ): AudioClip | null {
    const tracks = this.getActiveAudioTracks();

    const trackExists = tracks.some((track) => track.id === trackId);

    if (!trackExists) {
      return null;
    }

    const newClip: AudioClip = {
      id: nanoid(),
      ...clipData,
    };

    const updatedTracks = tracks.map((track) => {
      if (track.id !== trackId) {
        return track;
      }

      return {
        ...track,

        clips: [...track.clips, newClip],
      };
    });

    this.setActiveAudioTracks(updatedTracks);

    return newClip;
  }

  moveAudioClip(trackId: string, clipId: string, newStartTime: number) {
    const tracks = this.getActiveAudioTracks();
    const updatedTracks = tracks.map((track) => {
      if (track.id !== trackId) return track;
      return {
        ...track,
        clips: track.clips.map((clip) => {
          if (clip.id !== clipId) return clip;
          const clamped = Math.max(
            0,
            Math.min(newStartTime, this.state.duration - clip.sourceDuration),
          );
          return { ...clip, startTime: clamped };
        }),
      };
    });
    this.setActiveAudioTracks(updatedTracks);
  }

  resizeAudioClip(
    trackId: string,
    clipId: string,
    newStartTime: number,
    newDuration: number,
  ) {
    const MIN_CLIP_DURATION = 0.1;
    const tracks = this.getActiveAudioTracks();
    const updatedTracks = tracks.map((track) => {
      if (track.id !== trackId) return track;
      return {
        ...track,
        clips: track.clips.map((clip) => {
          if (clip.id !== clipId) return clip;
          const clampedDuration = Math.max(MIN_CLIP_DURATION, newDuration);
          const clampedStart = Math.max(0, newStartTime);
          const finalDuration = Math.min(
            clampedDuration,
            this.state.duration - clampedStart,
          );
          return {
            ...clip,
            startTime: clampedStart,
            sourceDuration: finalDuration,
          };
        }),
      };
    });
    this.setActiveAudioTracks(updatedTracks);
  }

  removeAudioClip(trackId: string, clipId: string) {
    let tracks = this.getActiveAudioTracks().map((track) => {
      if (track.id !== trackId) return track;
      return {
        ...track,
        clips: track.clips.filter((clip) => clip.id !== clipId),
      };
    });
    // Remove empty tracks
    tracks = tracks.filter((track) => track.clips.length > 0);
    this.setActiveAudioTracks(tracks);
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
    this.setState({ keyframesByFrame: {}, currentTime: 0, isPlaying: false });
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
