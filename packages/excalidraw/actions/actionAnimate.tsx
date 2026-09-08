import { register } from "./register";
import { getNonDeletedElements, CaptureUpdateAction } from "@excalidraw/element";
import type { ExcalidrawElement, ExcalidrawAnimationFrameElement } from "@excalidraw/element/types";
import { createIcon } from "../components/icons";
import { centerScrollOn } from "../viewport";
import { getNormalizedZoom } from "../scene";
import type { AppState } from "../types";
import { getTimelineStore } from "../animation/TimelineStore";
import { getGsapEngine } from "../animation/gsapEngine";

export const playIcon = createIcon(
  <g strokeWidth="1.5" stroke="currentColor" fill="none" strokeLinecap="round" strokeLinejoin="round">
    <path stroke="none" d="M0 0h24v24H0z" fill="none"/>
    <path d="M7 4v16l13 -8z" fill="currentColor" stroke="none" />
  </g>,
  { width: 24, height: 24 },
);

const getViewportForFrame = (
  frame: ExcalidrawAnimationFrameElement,
  appState: AppState,
): { scrollX: number; scrollY: number; zoom: AppState["zoom"] } => {
  // Use a generous padding so the frame doesn't hug the screen edges
  const paddingX = Math.max(200, appState.width * 0.25);
  const paddingY = Math.max(200, appState.height * 0.25);

  const effectiveWidth = appState.width - paddingX * 2;
  const effectiveHeight = appState.height - paddingY * 2;

  const zoomX = effectiveWidth / frame.width;
  const zoomY = effectiveHeight / frame.height;
  
  // Cap the zoom to 1 so small frames don't blow up too much
  const zoomValue = getNormalizedZoom(Math.min(zoomX, zoomY, 1));

  const centerX = frame.x + frame.width / 2;
  const centerY = frame.y + frame.height / 2;

  const scroll = centerScrollOn({
    scenePoint: { x: centerX, y: centerY },
    viewportDimensions: { width: appState.width, height: appState.height },
    zoom: { value: zoomValue },
    offsets: { bottom: 200 },
  });

  return {
    scrollX: scroll.scrollX,
    scrollY: scroll.scrollY,
    zoom: { value: zoomValue },
  };
};

// ─── Animation state ──────────────────────────────────────────────────────────
let savedElements: readonly ExcalidrawElement[] | null = null;
let savedAppState: Partial<AppState> | null = null;
let isAnimating = false;

export const actionAnimate = register({
  name: "animateFrames",
  label: "Animate Frames",
  icon: playIcon,
  trackEvent: { category: "menu" },
  perform: (elements, appState, _, app) => {
    const store = getTimelineStore();
    const engine = getGsapEngine();

    // ── Stop existing animation & restore scene ──
    if (isAnimating) {
      isAnimating = false;
      engine.destroy();
      if (savedElements && savedAppState) {
        app.scene.replaceAllElements(savedElements);
        savedElements = null;
        const restoreState = savedAppState;
        savedAppState = null;
        return {
          appState: {
            ...appState,
            ...restoreState,
          },
          captureUpdate: CaptureUpdateAction.EVENTUALLY,
        };
      }
      return { appState, captureUpdate: CaptureUpdateAction.EVENTUALLY };
    }

    // ── Check for timeline keyframes first ──
    let activeKeyframes = store.getActiveKeyframes();
    if (activeKeyframes.length >= 2) {
      // Use GSAP timeline-based animation
      savedElements = [...elements];
      savedAppState = {
        scrollX: appState.scrollX,
        scrollY: appState.scrollY,
        zoom: appState.zoom,
        frameRendering: appState.frameRendering,
        viewModeEnabled: appState.viewModeEnabled,
      };

      isAnimating = true;

      engine.build(
        activeKeyframes,
        (interpolatedElements, time) => {
          const sceneElements = savedElements || app.scene.getElementsIncludingDeleted();
          const merged = sceneElements.map(el => {
            const interpolated = interpolatedElements.find(i => i.id === el.id);
            return interpolated || el;
          });
          const newElements = interpolatedElements.filter(i => !sceneElements.some(el => el.id === i.id));
          app.scene.replaceAllElements([...merged, ...newElements]);
          store.setCurrentTime(time);
        },
        () => {
          // On complete - restore
          isAnimating = false;
          setTimeout(() => {
            if (savedElements && savedAppState) {
              app.scene.replaceAllElements(savedElements);
              app.setAppState(savedAppState as any);
              savedElements = null;
              savedAppState = null;
            }
          }, 1000);
        },
      );

      engine.play();

      return {
        appState: {
          ...appState,
          frameRendering: {
            ...appState.frameRendering,
            enabled: false,
          },
        },
        captureUpdate: CaptureUpdateAction.EVENTUALLY,
      };
    }

    // ── Fallback: use animation frame elements (legacy) ──
    const nonDeleted = getNonDeletedElements(elements);
    const frames = (
      nonDeleted.filter((el) => el.type === "animationframe") as ExcalidrawAnimationFrameElement[]
    ).sort((a, b) => a.frameIndex - b.frameIndex);

    if (frames.length < 2) {
      console.warn("Need at least 2 animation frames or 2 timeline keyframes to animate.");
      return { appState, captureUpdate: CaptureUpdateAction.EVENTUALLY };
    }

    // Auto-create keyframes from animation frames for the GSAP engine
    const frameChildGroups: ExcalidrawElement[][] = frames.map((frame) =>
      nonDeleted.filter((el) => el.frameId === frame.id),
    );

    // Clear existing keyframes and auto-generate from frames
    store.setActiveFrameId("legacy-playback");
    store.clearKeyframes();
    frames.forEach((frame, index) => {
      const time = index * 2; // 2 seconds between each frame
      store.addKeyframe(time, frameChildGroups[index], frame.name || `Frame ${index + 1}`);
    });

    // Save state and start animation
    savedElements = [...elements];
    savedAppState = {
      scrollX: appState.scrollX,
      scrollY: appState.scrollY,
      zoom: appState.zoom,
      frameRendering: appState.frameRendering,
      viewModeEnabled: appState.viewModeEnabled,
    };

    isAnimating = true;

    const updatedKeyframes = store.getActiveKeyframes();
    engine.build(
      updatedKeyframes,
      (interpolatedElements, time) => {
        const sceneElements = savedElements || app.scene.getElementsIncludingDeleted();
        const merged = sceneElements.map(el => {
          const interpolated = interpolatedElements.find(i => i.id === el.id);
          return interpolated || el;
        });
        const newElements = interpolatedElements.filter(i => !sceneElements.some(el => el.id === i.id));
        app.scene.replaceAllElements([...merged, ...newElements]);
        store.setCurrentTime(time);
      },
      () => {
        isAnimating = false;
        setTimeout(() => {
          if (savedElements && savedAppState) {
            app.scene.replaceAllElements(savedElements);
            app.setAppState(savedAppState as any);
            savedElements = null;
            savedAppState = null;
          }
        }, 1000);
      },
    );

    engine.play();

    // Zoom to first frame
    const displayFrame = frames[0];
    const viewport = getViewportForFrame(displayFrame, appState);

    return {
      appState: {
        ...appState,
        scrollX: viewport.scrollX,
        scrollY: viewport.scrollY,
        zoom: viewport.zoom,
        frameRendering: {
          ...appState.frameRendering,
          enabled: false,
        },
      },
      captureUpdate: CaptureUpdateAction.EVENTUALLY,
    };
  },
});
