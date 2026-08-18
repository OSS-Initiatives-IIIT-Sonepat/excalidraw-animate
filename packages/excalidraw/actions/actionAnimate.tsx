import { register } from "./register";
import { getNonDeletedElements, getCommonBounds, CaptureUpdateAction } from "@excalidraw/element";
import type { ExcalidrawElement, ExcalidrawAnimationFrameElement } from "@excalidraw/element/types";
import { createIcon } from "../components/icons";
import { centerScrollOn } from "../viewport";
import { getNormalizedZoom } from "../scene";
import type { AppState } from "../types";

export const playIcon = createIcon(
  <g strokeWidth="1.5" stroke="currentColor" fill="none" strokeLinecap="round" strokeLinejoin="round">
    <path stroke="none" d="M0 0h24v24H0z" fill="none"/>
    <path d="M7 4v16l13 -8z" fill="currentColor" stroke="none" />
  </g>,
  { width: 24, height: 24 },
);

// Easing function
const easeInOutCubic = (t: number): number => {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
};

// Lerp a number
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

// Lerp a hex color
const lerpColor = (colorA: string, colorB: string, t: number): string => {
  if (colorA === colorB) return colorA;
  if (colorA === "transparent" || colorB === "transparent") {
    return t < 0.5 ? colorA : colorB;
  }
  try {
    const parseHex = (c: string) => {
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
    };
    const a = parseHex(colorA);
    const b = parseHex(colorB);
    const r = Math.round(lerp(a[0], b[0], t));
    const g = Math.round(lerp(a[1], b[1], t));
    const bl = Math.round(lerp(a[2], b[2], t));
    return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${bl.toString(16).padStart(2, "0")}`;
  } catch {
    return t < 0.5 ? colorA : colorB;
  }
};

/**
 * Get an element's position relative to its frame.
 */
const getRelativePos = (
  el: ExcalidrawElement,
  frame: ExcalidrawAnimationFrameElement,
) => ({
  rx: el.x - frame.x,
  ry: el.y - frame.y,
  rw: el.width / frame.width,
  rh: el.height / frame.height,
});

/**
 * Match elements between two frames. Uses type + relative position similarity.
 * Returns pairs of [startEl, endEl].
 */
const matchElements = (
  startEls: ExcalidrawElement[],
  endEls: ExcalidrawElement[],
  startFrame: ExcalidrawAnimationFrameElement,
  endFrame: ExcalidrawAnimationFrameElement,
): [ExcalidrawElement, ExcalidrawElement][] => {
  const pairs: [ExcalidrawElement, ExcalidrawElement][] = [];
  const usedEndIndices = new Set<number>();

  for (const startEl of startEls) {
    const startRel = getRelativePos(startEl, startFrame);
    let bestIdx = -1;
    let bestScore = Infinity;

    for (let j = 0; j < endEls.length; j++) {
      if (usedEndIndices.has(j)) continue;
      const endEl = endEls[j];

      // Type must match
      if (startEl.type !== endEl.type) continue;

      // Score by relative position similarity
      const endRel = getRelativePos(endEl, endFrame);
      const dx = startRel.rx / startFrame.width - endRel.rx / endFrame.width;
      const dy = startRel.ry / startFrame.height - endRel.ry / endFrame.height;
      const dw = startRel.rw - endRel.rw;
      const dh = startRel.rh - endRel.rh;
      const score = dx * dx + dy * dy + dw * dw + dh * dh;

      if (score < bestScore) {
        bestScore = score;
        bestIdx = j;
      }
    }

    if (bestIdx !== -1) {
      usedEndIndices.add(bestIdx);
      pairs.push([startEl, endEls[bestIdx]]);
    }
  }

  return pairs;
};

/**
 * Tween a single element between two states. 
 * Coordinates are remapped: start element is expressed relative to startFrame,
 * then that relative position is interpolated toward end element's relative
 * position in endFrame, and finally placed relative to startFrame (which is
 * our display frame during the presentation).
 */
const tweenElement = (
  startEl: ExcalidrawElement,
  endEl: ExcalidrawElement,
  startFrame: ExcalidrawAnimationFrameElement,
  endFrame: ExcalidrawAnimationFrameElement,
  displayFrame: { x: number; y: number; width: number; height: number },
  t: number,
): ExcalidrawElement => {
  // Relative positions within their respective frames (normalized 0-1)
  const sx = (startEl.x - startFrame.x) / startFrame.width;
  const sy = (startEl.y - startFrame.y) / startFrame.height;
  const sw = startEl.width / startFrame.width;
  const sh = startEl.height / startFrame.height;

  const ex = (endEl.x - endFrame.x) / endFrame.width;
  const ey = (endEl.y - endFrame.y) / endFrame.height;
  const ew = endEl.width / endFrame.width;
  const eh = endEl.height / endFrame.height;

  // Interpolate in normalized space
  const ix = lerp(sx, ex, t);
  const iy = lerp(sy, ey, t);
  const iw = lerp(sw, ew, t);
  const ih = lerp(sh, eh, t);

  // Map back to display frame coordinates
  return {
    ...startEl,
    x: displayFrame.x + ix * displayFrame.width,
    y: displayFrame.y + iy * displayFrame.height,
    width: iw * displayFrame.width,
    height: ih * displayFrame.height,
    angle: lerp(startEl.angle as number, endEl.angle as number, t) as ExcalidrawElement["angle"],
    opacity: lerp(startEl.opacity, endEl.opacity, t),
    backgroundColor: lerpColor(startEl.backgroundColor, endEl.backgroundColor, t),
    strokeColor: lerpColor(startEl.strokeColor, endEl.strokeColor, t),
    frameId: null, // detach from frame for display
  } as ExcalidrawElement;
};

/**
 * Compute the zoom & scroll to fit a frame into the viewport.
 */
const getViewportForFrame = (
  frame: ExcalidrawAnimationFrameElement,
  appState: AppState,
  padding = 40,
): { scrollX: number; scrollY: number; zoom: AppState["zoom"] } => {
  const effectiveWidth = appState.width - padding * 2;
  const effectiveHeight = appState.height - padding * 2;

  const zoomX = effectiveWidth / frame.width;
  const zoomY = effectiveHeight / frame.height;
  const zoomValue = getNormalizedZoom(Math.min(zoomX, zoomY, 1));

  const centerX = frame.x + frame.width / 2;
  const centerY = frame.y + frame.height / 2;

  const scroll = centerScrollOn({
    scenePoint: { x: centerX, y: centerY },
    viewportDimensions: { width: appState.width, height: appState.height },
    zoom: { value: zoomValue },
  });

  return {
    scrollX: scroll.scrollX,
    scrollY: scroll.scrollY,
    zoom: { value: zoomValue },
  };
};

// ─── Animation state ──────────────────────────────────────────────────────────
let animationFrameId: number | null = null;
let isAnimating = false;
let savedElements: readonly ExcalidrawElement[] | null = null;
let savedAppState: Partial<AppState> | null = null;

const stopAnimation = () => {
  isAnimating = false;
  if (animationFrameId) {
    cancelAnimationFrame(animationFrameId);
    animationFrameId = null;
  }
};

export const actionAnimate = register({
  name: "animateFrames",
  label: "Animate Frames",
  icon: playIcon,
  trackEvent: { category: "menu" },
  perform: (elements, appState, _, app) => {
    // ── Stop existing animation & restore scene ──
    if (isAnimating) {
      stopAnimation();
      if (savedElements && savedAppState) {
        app.scene.replaceAllElements(savedElements);
        return {
          appState: {
            ...appState,
            ...savedAppState,
          },
          captureUpdate: CaptureUpdateAction.EVENTUALLY,
        };
      }
      return { appState, captureUpdate: CaptureUpdateAction.EVENTUALLY };
    }

    // ── Gather frames ──
    const nonDeleted = getNonDeletedElements(elements);
    const frames = (
      nonDeleted.filter((el) => el.type === "animationframe") as ExcalidrawAnimationFrameElement[]
    ).sort((a, b) => a.frameIndex - b.frameIndex);

    if (frames.length < 2) {
      console.warn("Need at least 2 animation frames to animate. Create animation frames and arrange them.");
      return { appState, captureUpdate: CaptureUpdateAction.EVENTUALLY };
    }

    // ── Save current state for restoration ──
    savedElements = [...elements];
    savedAppState = {
      scrollX: appState.scrollX,
      scrollY: appState.scrollY,
      zoom: appState.zoom,
      frameRendering: appState.frameRendering,
      viewModeEnabled: appState.viewModeEnabled,
    };

    // ── Pre-compute frame element groups ──
    const frameChildGroups: ExcalidrawElement[][] = frames.map((frame) =>
      nonDeleted.filter((el) => el.frameId === frame.id),
    );

    // ── Pre-compute matched element pairs for each transition ──
    const transitions: {
      pairs: [ExcalidrawElement, ExcalidrawElement][];
      startFrame: ExcalidrawAnimationFrameElement;
      endFrame: ExcalidrawAnimationFrameElement;
    }[] = [];

    for (let i = 0; i < frames.length - 1; i++) {
      transitions.push({
        pairs: matchElements(
          frameChildGroups[i],
          frameChildGroups[i + 1],
          frames[i],
          frames[i + 1],
        ),
        startFrame: frames[i],
        endFrame: frames[i + 1],
      });
    }

    // ── Use the first frame as the "display" frame ──
    const displayFrame = frames[0];

    // ── Zoom viewport to fit the display frame ──
    const viewport = getViewportForFrame(displayFrame, appState);

    // ── Animation loop ──
    isAnimating = true;
    const TRANSITION_DURATION = 1200; // ms per transition
    const HOLD_DURATION = 600; // ms to hold on each keyframe
    let currentTransitionIdx = 0;
    let startTime = performance.now();
    let phase: "hold" | "transition" = "hold"; // start by showing frame 1

    const animate = (time: number) => {
      if (!isAnimating) return;

      const elapsed = time - startTime;

      if (phase === "hold") {
        // Show the current frame's elements statically
        if (elapsed >= HOLD_DURATION) {
          // Move to transition phase
          phase = "transition";
          startTime = time;
        }
        animationFrameId = requestAnimationFrame(animate);
        return;
      }

      // phase === "transition"
      let rawProgress = elapsed / TRANSITION_DURATION;

      if (rawProgress >= 1) {
        // Transition complete
        currentTransitionIdx++;
        if (currentTransitionIdx >= transitions.length) {
          // All transitions done — hold on last frame briefly, then stop
          stopAnimation();
          // Show final frame
          const lastTransition = transitions[transitions.length - 1];
          const finalEls = lastTransition.pairs.map(([startEl, endEl]) =>
            tweenElement(startEl, endEl, lastTransition.startFrame, lastTransition.endFrame, displayFrame, 1),
          );
          const hiddenOriginals = nonDeleted.map((el) => ({
            ...el,
            opacity: 0,
          }));
          app.scene.replaceAllElements([...hiddenOriginals, ...finalEls]);
          // Auto-restore after a brief pause
          setTimeout(() => {
            if (savedElements && savedAppState) {
              app.scene.replaceAllElements(savedElements);
              app.setAppState(savedAppState as any);
              savedElements = null;
              savedAppState = null;
            }
          }, 1500);
          return;
        }

        // Next transition
        rawProgress = 0;
        startTime = time;
        phase = "hold";
        animationFrameId = requestAnimationFrame(animate);
        return;
      }

      const t = easeInOutCubic(rawProgress);
      const transition = transitions[currentTransitionIdx];

      // Build tweened elements
      const tweenedEls = transition.pairs.map(([startEl, endEl]) =>
        tweenElement(
          startEl,
          endEl,
          transition.startFrame,
          transition.endFrame,
          displayFrame,
          t,
        ),
      );

      // Hide all originals, show only tweened elements
      const hiddenOriginals = nonDeleted.map((el) => ({
        ...el,
        opacity: 0,
      }));

      app.scene.replaceAllElements([...hiddenOriginals, ...tweenedEls]);
      animationFrameId = requestAnimationFrame(animate);
    };

    // Start: show frame 1 elements on the display frame
    const initialEls = transitions[0].pairs.map(([startEl, _endEl]) =>
      tweenElement(
        startEl,
        startEl,
        transitions[0].startFrame,
        transitions[0].startFrame,
        displayFrame,
        0,
      ),
    );

    const hiddenOriginals = nonDeleted.map((el) => ({
      ...el,
      opacity: 0,
    }));

    app.scene.replaceAllElements([...hiddenOriginals, ...initialEls]);
    animationFrameId = requestAnimationFrame(animate);

    return {
      appState: {
        ...appState,
        scrollX: viewport.scrollX,
        scrollY: viewport.scrollY,
        zoom: viewport.zoom,
        // Disable frame rendering outlines during animation
        frameRendering: {
          ...appState.frameRendering,
          enabled: false,
        },
      },
      captureUpdate: CaptureUpdateAction.EVENTUALLY,
    };
  },
});
