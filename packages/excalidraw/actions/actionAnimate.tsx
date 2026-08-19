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
      usedStartIndices.add(i);
      usedEndIndices.add(bestIdx);
      pairs.push([startEl, endEls[bestIdx]]);
    }
  }

  const unmatchedStart = startEls.filter((_, i) => !usedStartIndices.has(i));
  const unmatchedEnd = endEls.filter((_, j) => !usedEndIndices.has(j));

  return { pairs, unmatchedStart, unmatchedEnd };
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
      unmatchedStart: ExcalidrawElement[];
      unmatchedEnd: ExcalidrawElement[];
      startFrame: ExcalidrawAnimationFrameElement;
      endFrame: ExcalidrawAnimationFrameElement;
    }[] = [];

    for (let i = 0; i < frames.length - 1; i++) {
      const result = matchElements(
        frameChildGroups[i],
        frameChildGroups[i + 1],
        frames[i],
        frames[i + 1],
      );
      transitions.push({
        pairs: result.pairs,
        unmatchedStart: result.unmatchedStart,
        unmatchedEnd: result.unmatchedEnd,
        startFrame: frames[i],
        endFrame: frames[i + 1],
      });
    }

    // ── Helper: position an element from a source frame onto the display frame ──
    const positionOnDisplay = (
      el: ExcalidrawElement,
      sourceFrame: ExcalidrawAnimationFrameElement,
      displayFr: { x: number; y: number; width: number; height: number },
    ): ExcalidrawElement => {
      const rx = (el.x - sourceFrame.x) / sourceFrame.width;
      const ry = (el.y - sourceFrame.y) / sourceFrame.height;
      const rw = el.width / sourceFrame.width;
      const rh = el.height / sourceFrame.height;
      return {
        ...el,
        x: displayFr.x + rx * displayFr.width,
        y: displayFr.y + ry * displayFr.height,
        width: rw * displayFr.width,
        height: rh * displayFr.height,
        frameId: null,
      } as ExcalidrawElement;
    };

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
          // Show unmatched end elements at full opacity (they've faded in)
          const fadedInEls = lastTransition.unmatchedEnd.map((el) => ({
            ...positionOnDisplay(el, lastTransition.endFrame, displayFrame),
            opacity: el.opacity,
          }));
          const hiddenOriginals = nonDeleted.map((el) => ({
            ...el,
            opacity: 0,
          }));
          app.scene.replaceAllElements([...hiddenOriginals, ...finalEls, ...fadedInEls]);
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

        // Next transition — show end frame elements at t=1 during hold
        rawProgress = 0;
        startTime = time;
        phase = "hold";

        // Display the end frame state of the just-completed transition
        const prevTransition = transitions[currentTransitionIdx - 1];
        const holdEls = prevTransition.pairs.map(([startEl, endEl]) =>
          tweenElement(startEl, endEl, prevTransition.startFrame, prevTransition.endFrame, displayFrame, 1),
        );
        const fadedInEls = prevTransition.unmatchedEnd.map((el) => ({
          ...positionOnDisplay(el, prevTransition.endFrame, displayFrame),
          opacity: el.opacity,
        }));
        const hiddenOriginals = nonDeleted.map((el) => ({
          ...el,
          opacity: 0,
        }));
        app.scene.replaceAllElements([...hiddenOriginals, ...holdEls, ...fadedInEls]);

        animationFrameId = requestAnimationFrame(animate);
        return;
      }

      const t = easeInOutCubic(rawProgress);
      const transition = transitions[currentTransitionIdx];

      // Build tweened elements (matched pairs)
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

      // Fade out unmatched start elements (present in start, absent in end)
      const fadingOutEls = transition.unmatchedStart.map((el) => ({
        ...positionOnDisplay(el, transition.startFrame, displayFrame),
        opacity: lerp(el.opacity, 0, t),
      }));

      // Fade in unmatched end elements (absent in start, present in end)
      const fadingInEls = transition.unmatchedEnd.map((el) => ({
        ...positionOnDisplay(el, transition.endFrame, displayFrame),
        opacity: lerp(0, el.opacity, t),
      }));

      // Hide all originals, show tweened + fading elements
      const hiddenOriginals = nonDeleted.map((el) => ({
        ...el,
        opacity: 0,
      }));

      app.scene.replaceAllElements([...hiddenOriginals, ...tweenedEls, ...fadingOutEls, ...fadingInEls]);
      animationFrameId = requestAnimationFrame(animate);
    };

    // Start: show ALL frame 1 elements on the display frame
    const initialPairedEls = transitions[0].pairs.map(([startEl, _endEl]) =>
      tweenElement(
        startEl,
        startEl,
        transitions[0].startFrame,
        transitions[0].startFrame,
        displayFrame,
        0,
      ),
    );
    // Also show unmatched start elements from the first transition (they exist in frame 1 but not frame 2)
    const initialUnmatchedEls = transitions[0].unmatchedStart.map((el) => ({
      ...positionOnDisplay(el, transitions[0].startFrame, displayFrame),
      opacity: el.opacity,
    }));

    const hiddenOriginals = nonDeleted.map((el) => ({
      ...el,
      opacity: 0,
    }));

    app.scene.replaceAllElements([...hiddenOriginals, ...initialPairedEls, ...initialUnmatchedEls]);
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
