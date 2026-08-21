import React, {
  useState,
  useRef,
  useCallback,
  useEffect,
  useMemo,
} from "react";
import type { NonDeletedExcalidrawElement } from "@excalidraw/element/types";
import type { ExcalidrawElement } from "@excalidraw/element/types";
import type { AppState, UIAppState, AppClassProperties } from "../types";
import {
  TimelineStore,
  getTimelineStore,
  type Keyframe,
} from "../animation/TimelineStore";
import {
  GsapAnimationEngine,
  getGsapEngine,
  getElementsAtTime,
} from "../animation/gsapEngine";
import { getCommonBounds } from "@excalidraw/element";
import { centerScrollOn } from "../viewport";
import { getNormalizedZoom } from "../scene";

import "./AnimationTimeline.scss";

// ─── Icons (inline SVGs, no black) ────────────────────────────────────────────

const PlayIcon = () => (
  <svg viewBox="0 0 24 24" fill="currentColor" stroke="none">
    <path d="M8 5v14l11-7z" />
  </svg>
);

const PauseIcon = () => (
  <svg viewBox="0 0 24 24" fill="currentColor" stroke="none">
    <rect x="6" y="4" width="4" height="16" rx="1" />
    <rect x="14" y="4" width="4" height="16" rx="1" />
  </svg>
);

const SkipStartIcon = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <polygon points="19 20 9 12 19 4 19 20" fill="currentColor" />
    <line x1="5" y1="19" x2="5" y2="5" />
  </svg>
);

const SkipEndIcon = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <polygon points="5 4 15 12 5 20 5 4" fill="currentColor" />
    <line x1="19" y1="5" x2="19" y2="19" />
  </svg>
);

const PlusIcon = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.5"
    strokeLinecap="round"
  >
    <line x1="12" y1="5" x2="12" y2="19" />
    <line x1="5" y1="12" x2="19" y2="12" />
  </svg>
);

const CloseIcon = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
  >
    <line x1="18" y1="6" x2="6" y2="18" />
    <line x1="6" y1="6" x2="18" y2="18" />
  </svg>
);

const DiamondIcon = () => (
  <svg viewBox="0 0 24 24" fill="currentColor" stroke="none">
    <path d="M12 2 L22 12 L12 22 L2 12 Z" />
  </svg>
);

const TrashIcon = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <polyline points="3 6 5 6 21 6" />
    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
  </svg>
);

// ─── Utilities ────────────────────────────────────────────────────────────────

const formatTime = (seconds: number): string => {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 10);
  return `${mins}:${secs.toString().padStart(2, "0")}.${ms}`;
};

// ─── Component ────────────────────────────────────────────────────────────────

interface AnimationTimelineProps {
  elements: readonly NonDeletedExcalidrawElement[];
  appState: UIAppState;
  setAppState: React.Component<any, AppState>["setState"];
  app: AppClassProperties;
}

export const AnimationTimeline = ({
  elements,
  appState,
  setAppState,
  app,
}: AnimationTimelineProps) => {
  const store = useMemo(() => getTimelineStore(), []);
  const engine = useMemo(() => getGsapEngine(), []);

  const [storeState, setStoreState] = useState(store.getState());
  const [selectedKeyframeId, setSelectedKeyframeId] = useState<
    string | null
  >(null);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    keyframeId: string;
  } | null>(null);
  const [isDraggingKeyframe, setIsDraggingKeyframe] = useState(false);
  const [isDraggingPlayhead, setIsDraggingPlayhead] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);

  const trackContainerRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const playheadDragRef = useRef(false);
  const animFrameRef = useRef<number | null>(null);
  const savedElementsRef = useRef<readonly ExcalidrawElement[] | null>(
    null,
  );
  const savedAppStateRef = useRef<Partial<AppState> | null>(null);

  // Subscribe to store updates
  useEffect(() => {
    const unsub = store.subscribe(setStoreState);
    return unsub;
  }, [store]);

  // Close context menu on outside click
  useEffect(() => {
    if (!contextMenu) return;
    const handleClick = () => setContextMenu(null);
    document.addEventListener("click", handleClick);
    return () => document.removeEventListener("click", handleClick);
  }, [contextMenu]);

  // ── Computed values ──

  const { duration, currentTime, pixelsPerSecond, activeFrameId } = storeState;
  const keyframes = store.getActiveKeyframes();
  const trackWidth = duration * pixelsPerSecond;

  // Generate ruler marks
  const rulerMarks = useMemo(() => {
    const marks: { time: number; isMajor: boolean }[] = [];
    // Determine interval based on zoom
    let interval = 1; // seconds
    if (pixelsPerSecond < 30) interval = 5;
    else if (pixelsPerSecond < 60) interval = 2;
    else if (pixelsPerSecond > 150) interval = 0.5;

    for (let t = 0; t <= duration; t += interval) {
      marks.push({ time: t, isMajor: t % (interval * 2) === 0 || interval >= 1 });
    }
    return marks;
  }, [duration, pixelsPerSecond]);

  // ── Handlers ──

  // Sync visibility with appState
  useEffect(() => {
    if (appState.openAnimationPanel !== storeState.isOpen) {
      store.setOpen(!!appState.openAnimationPanel);
    }
  }, [appState.openAnimationPanel, storeState.isOpen, store]);

  // Determine active frame ID based on selection
  useEffect(() => {
    const selectedIds = Object.keys(appState.selectedElementIds).filter(
      (id) => appState.selectedElementIds[id],
    );

    let foundFrameId: string | null = null;
    
    if (selectedIds.length > 0) {
      const firstSelected = elements.find((el) => el.id === selectedIds[0]);
      if (firstSelected) {
        if (firstSelected.type === "animationframe") {
          foundFrameId = firstSelected.id;
        } else if (firstSelected.frameId) {
          const parentFrame = elements.find((el) => el.id === firstSelected.frameId);
          if (parentFrame && parentFrame.type === "animationframe") {
            foundFrameId = parentFrame.id;
          }
        }
      }
    }

    if (foundFrameId && foundFrameId !== storeState.activeFrameId) {
      store.setActiveFrameId(foundFrameId);
    }
  }, [appState.selectedElementIds, elements, storeState.activeFrameId, store]);

  const seekToTime = useCallback((time: number) => {
    store.setCurrentTime(time);
    if (engine.isActive()) {
      engine.seek(time);
    } else {
      const interpolatedElements = getElementsAtTime(keyframes, time);
      if (interpolatedElements) {
        const sceneElements = app.scene.getElementsIncludingDeleted();
        const merged = sceneElements.map(el => {
          const interpolated = interpolatedElements.find(i => i.id === el.id);
          return interpolated || el;
        });
        const newElements = interpolatedElements.filter(i => !sceneElements.some(el => el.id === i.id));
        app.scene.replaceAllElements([...merged, ...newElements]);
      }
    }
  }, [store, engine, keyframes, app]);

  const getTimeFromMouseX = useCallback(
    (clientX: number): number => {
      if (!trackContainerRef.current) return 0;
      const rect = trackContainerRef.current.getBoundingClientRect();
      const scrollLeft = trackContainerRef.current.scrollLeft;
      const x = clientX - rect.left + scrollLeft;
      const time = x / pixelsPerSecond;
      return Math.max(0, Math.min(time, duration));
    },
    [pixelsPerSecond, duration],
  );

  const handleAddKeyframe = useCallback(() => {
    if (!activeFrameId) return;
    // Capture current canvas elements as a snapshot, only for the active frame
    const currentElements = app.scene
      .getNonDeletedElements()
      .filter((el: ExcalidrawElement) => el.frameId === activeFrameId)
      .map((el: ExcalidrawElement) => ({ ...el }));
    const kfCount = keyframes.length + 1;
    store.addKeyframe(
      currentTime,
      currentElements,
      `Scene ${kfCount}`,
    );
  }, [app, store, currentTime, keyframes.length, activeFrameId]);

  const handleRemoveKeyframe = useCallback(
    (id: string) => {
      store.removeKeyframe(id);
      if (selectedKeyframeId === id) {
        setSelectedKeyframeId(null);
      }
      setContextMenu(null);
    },
    [store, selectedKeyframeId],
  );

  const handleKeyframeClick = useCallback(
    (e: React.MouseEvent, kf: Keyframe) => {
      e.stopPropagation();
      setSelectedKeyframeId(kf.id);
      seekToTime(kf.time);
    },
    [seekToTime],
  );

  const handleKeyframeContextMenu = useCallback(
    (e: React.MouseEvent, kf: Keyframe) => {
      e.preventDefault();
      e.stopPropagation();

      // Estimated context menu dimensions (min-width: 160px, ~2 items ~80px)
      const menuWidth = 220;
      const menuHeight = 90;
      const margin = 8;

      const vw = window.innerWidth;
      const vh = window.innerHeight;

      // Clamp so the menu never overflows any edge of the viewport
      const x = Math.min(e.clientX, vw - menuWidth - margin);
      const y = Math.min(
        Math.max(e.clientY, margin),
        vh - menuHeight - margin,
      );

      setContextMenu({ x, y, keyframeId: kf.id });
    },
    [],
  );

  const handleKeyframeDragStart = useCallback(
    (e: React.MouseEvent, kf: Keyframe) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDraggingKeyframe(true);
      setSelectedKeyframeId(kf.id);

      const handleMouseMove = (moveEvent: MouseEvent) => {
        const newTime = getTimeFromMouseX(moveEvent.clientX);
        store.moveKeyframe(kf.id, newTime);
      };

      const handleMouseUp = () => {
        setIsDraggingKeyframe(false);
        document.removeEventListener("mousemove", handleMouseMove);
        document.removeEventListener("mouseup", handleMouseUp);
      };

      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
    },
    [store, getTimeFromMouseX],
  );

  const handleTrackClick = useCallback(
    (e: React.MouseEvent) => {
      if (isDraggingKeyframe) return;
      const time = getTimeFromMouseX(e.clientX);
      seekToTime(time);
    },
    [getTimeFromMouseX, isDraggingKeyframe, seekToTime],
  );

  const handlePlayheadDragStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDraggingPlayhead(true);
      playheadDragRef.current = true;

      const handleMouseMove = (moveEvent: MouseEvent) => {
        if (!playheadDragRef.current) return;
        const time = getTimeFromMouseX(moveEvent.clientX);
        seekToTime(time);
      };

      const handleMouseUp = () => {
        setIsDraggingPlayhead(false);
        playheadDragRef.current = false;
        document.removeEventListener("mousemove", handleMouseMove);
        document.removeEventListener("mouseup", handleMouseUp);
      };

      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
    },
    [store, engine, getTimeFromMouseX],
  );

  // ── Playback ──

  const handlePlay = useCallback(() => {
    if (keyframes.length < 2) {
      console.warn("Need at least 2 keyframes to animate");
      return;
    }

    if (isPlaying) {
      // Stop
      engine.pause();
      setIsPlaying(false);
      store.setPlaying(false);

      // Restore original elements
      if (savedElementsRef.current) {
        app.scene.replaceAllElements(savedElementsRef.current);
        savedElementsRef.current = null;
      }
      if (savedAppStateRef.current) {
        setAppState(savedAppStateRef.current as any);
        savedAppStateRef.current = null;
      }
      if (animFrameRef.current) {
        cancelAnimationFrame(animFrameRef.current);
        animFrameRef.current = null;
      }
      return;
    }

    // Save current state
    savedElementsRef.current = [...app.scene.getElementsIncludingDeleted()];
    savedAppStateRef.current = {
      viewModeEnabled: (appState as any).viewModeEnabled,
      scrollX: (appState as any).scrollX,
      scrollY: (appState as any).scrollY,
      zoom: (appState as any).zoom,
    };

    // Calculate viewport to focus on elements
    const allElements = keyframes.flatMap((kf: Keyframe) => kf.elementSnapshots) as ExcalidrawElement[];
    if (allElements.length > 0) {
      const bounds = getCommonBounds(allElements);
      const [minX, minY, maxX, maxY] = bounds;
      const width = maxX - minX;
      const height = maxY - minY;
      
      // Use a generous padding so the animation doesn't hug the screen edges
      const paddingX = Math.max(200, appState.width * 0.25);
      const paddingY = Math.max(200, appState.height * 0.25);

      const effectiveWidth = appState.width - paddingX * 2;
      const effectiveHeight = appState.height - paddingY * 2;

      const zoomX = effectiveWidth / Math.max(width, 1);
      const zoomY = effectiveHeight / Math.max(height, 1);
      const zoomValue = getNormalizedZoom(Math.min(zoomX, zoomY, 1));

      const centerX = minX + width / 2;
      const centerY = minY + height / 2;

      const scroll = centerScrollOn({
        scenePoint: { x: centerX, y: centerY },
        viewportDimensions: { width: appState.width, height: appState.height },
        zoom: { value: zoomValue },
        offsets: { bottom: 200 },
      });

      setAppState({
        scrollX: scroll.scrollX,
        scrollY: scroll.scrollY,
        zoom: { value: zoomValue },
      });
    }

    // Build and play
    engine.build(
      keyframes,
      (interpolatedElements, time) => {
        const sceneElements = savedElementsRef.current || app.scene.getElementsIncludingDeleted();
        const merged = sceneElements.map(el => {
          const interpolated = interpolatedElements.find(i => i.id === el.id);
          return interpolated || el;
        });
        const newElements = interpolatedElements.filter(i => !sceneElements.some(el => el.id === i.id));
        app.scene.replaceAllElements([...merged, ...newElements]);
        store.setCurrentTime(time);
      },
      () => {
        // On complete
        setIsPlaying(false);
        store.setPlaying(false);

        // Restore after a brief pause
        setTimeout(() => {
          if (savedElementsRef.current) {
            app.scene.replaceAllElements(savedElementsRef.current);
            savedElementsRef.current = null;
          }
          if (savedAppStateRef.current) {
            setAppState(savedAppStateRef.current as any);
            savedAppStateRef.current = null;
          }
        }, 500);
      },
    );

    engine.play();
    setIsPlaying(true);
    store.setPlaying(true);

    // Sync playhead with GSAP timeline
    const syncPlayhead = () => {
      if (!engine.isActive()) return;
      store.setCurrentTime(engine.getCurrentTime());
      animFrameRef.current = requestAnimationFrame(syncPlayhead);
    };
    animFrameRef.current = requestAnimationFrame(syncPlayhead);
  }, [keyframes, isPlaying, engine, store, app, appState, setAppState]);

  const handleSkipStart = useCallback(() => {
    seekToTime(0);
  }, [seekToTime]);

  const handleSkipEnd = useCallback(() => {
    const lastKf = keyframes[keyframes.length - 1];
    if (lastKf) {
      seekToTime(lastKf.time);
    }
  }, [seekToTime, keyframes]);

  const handleSpeedChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const speed = parseFloat(e.target.value);
      engine.setSpeed(speed);
    },
    [engine],
  );

  const handleDurationChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const val = parseInt(e.target.value, 10);
      if (!isNaN(val) && val > 0) {
        store.setDuration(val);
      }
    },
    [store],
  );

  const handleClose = useCallback(() => {
    store.setOpen(false);
    setAppState({ openAnimationPanel: false });
  }, [store, setAppState]);

  // ── Zoom with Ctrl+Scroll ──

  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const delta = e.deltaY > 0 ? -10 : 10;
        store.setPixelsPerSecond(pixelsPerSecond + delta);
      }
    },
    [store, pixelsPerSecond],
  );

  if (!storeState.isOpen) {
    return null;
  }

  if (!activeFrameId) {
    return (
      <div className="animation-timeline">
        <div className="animation-timeline__controls" style={{ justifyContent: 'space-between' }}>
          <div style={{ fontSize: '0.8rem', color: 'var(--color-gray-50)', fontWeight: 500, padding: '0 0.5rem' }}>
            Select an animation frame on the canvas to edit its timeline.
          </div>
          <button className="animation-timeline__close-btn" onClick={handleClose} title="Close timeline">
            <CloseIcon />
          </button>
        </div>
      </div>
    );
  }

  // ── Last keyframe time for the filled track ──
  const lastKeyframeTime =
    keyframes.length > 0 ? keyframes[keyframes.length - 1].time : 0;
  const firstKeyframeTime = keyframes.length > 0 ? keyframes[0].time : 0;

  return (
    <>
      <div className="animation-timeline" onWheel={handleWheel}>
        {/* ── Controls Bar ── */}
        <div className="animation-timeline__controls">
          <button
            className="animation-timeline__control-btn"
            onClick={handleSkipStart}
            title="Skip to start"
          >
            <SkipStartIcon />
          </button>

          <button
            className={`animation-timeline__play-btn ${isPlaying ? "animation-timeline__play-btn--playing" : ""}`}
            onClick={handlePlay}
            title={isPlaying ? "Stop" : "Play"}
          >
            {isPlaying ? <PauseIcon /> : <PlayIcon />}
          </button>

          <button
            className="animation-timeline__control-btn"
            onClick={handleSkipEnd}
            title="Skip to end"
          >
            <SkipEndIcon />
          </button>

          <div className="animation-timeline__time-display">
            {formatTime(currentTime)} / {formatTime(duration)}
          </div>

          <div className="animation-timeline__divider" />

          <button
            className="animation-timeline__add-keyframe-btn"
            onClick={handleAddKeyframe}
            title="Add keyframe at current time"
          >
            <PlusIcon />
            Keyframe
          </button>

          <div className="animation-timeline__divider" />

          <select
            className="animation-timeline__speed-select"
            defaultValue="1"
            onChange={handleSpeedChange}
            title="Playback speed"
          >
            <option value="0.25">0.25x</option>
            <option value="0.5">0.5x</option>
            <option value="1">1x</option>
            <option value="1.5">1.5x</option>
            <option value="2">2x</option>
          </select>

          <div className="animation-timeline__divider" />

          <input
            type="number"
            className="animation-timeline__duration-input"
            value={duration}
            onChange={handleDurationChange}
            min={5}
            max={600}
            title="Timeline duration (seconds)"
          />
          <span className="animation-timeline__duration-label">sec</span>

          <button
            className="animation-timeline__close-btn"
            onClick={handleClose}
            title="Close timeline"
          >
            <CloseIcon />
          </button>
        </div>

        {/* ── Ruler ── */}
        <div className="animation-timeline__ruler-container">
          <div
            className="animation-timeline__ruler"
            style={{ width: trackWidth }}
          >
            {rulerMarks.map((mark) => (
              <div
                key={mark.time}
                className="animation-timeline__ruler-mark"
                style={{ left: mark.time * pixelsPerSecond }}
              >
                <div
                  className={`animation-timeline__ruler-mark-line ${mark.isMajor ? "animation-timeline__ruler-mark-line--major" : "animation-timeline__ruler-mark-line--minor"}`}
                />
                {mark.isMajor && (
                  <span className="animation-timeline__ruler-mark-label">
                    {formatTime(mark.time)}
                  </span>
                )}
              </div>
            ))}

            {/* Ruler playhead indicator */}
            <div
              className="animation-timeline__playhead-ruler"
              style={{ left: currentTime * pixelsPerSecond }}
            />
          </div>
        </div>

        {/* ── Track ── */}
        <div
          className="animation-timeline__track-container"
          ref={trackContainerRef}
          onClick={handleTrackClick}
        >
          <div
            className="animation-timeline__track"
            ref={trackRef}
            style={
              {
                width: trackWidth,
                "--pps": `${pixelsPerSecond}px`,
              } as React.CSSProperties
            }
          >
            {/* Background grid */}
            <div className="animation-timeline__track-bg" />

            {/* Lane line */}
            <div className="animation-timeline__track-lane" />

            {/* Filled portion between first and last keyframes */}
            {keyframes.length >= 2 && (
              <div
                className="animation-timeline__track-filled"
                style={{
                  left: firstKeyframeTime * pixelsPerSecond,
                  width:
                    (lastKeyframeTime - firstKeyframeTime) *
                    pixelsPerSecond,
                }}
              />
            )}

            {/* Empty state */}
            {keyframes.length === 0 && (
              <div className="animation-timeline__empty">
                <DiamondIcon />
                <span>
                  Click &quot;+ Keyframe&quot; to capture a scene
                </span>
              </div>
            )}

            {/* Keyframe diamonds */}
            {keyframes.map((kf: Keyframe) => (
              <React.Fragment key={kf.id}>
                <div
                  className={`animation-timeline__keyframe ${selectedKeyframeId === kf.id ? "animation-timeline__keyframe--selected" : ""} ${isDraggingKeyframe ? "animation-timeline__keyframe--dragging" : ""}`}
                  style={{ left: kf.time * pixelsPerSecond }}
                  onClick={(e) => handleKeyframeClick(e, kf)}
                  onContextMenu={(e) =>
                    handleKeyframeContextMenu(e, kf)
                  }
                  onMouseDown={(e) => handleKeyframeDragStart(e, kf)}
                  title={`${kf.label || "Keyframe"} at ${formatTime(kf.time)}`}
                />
                <span
                  className="animation-timeline__keyframe-time"
                  style={{ left: kf.time * pixelsPerSecond }}
                >
                  {formatTime(kf.time)}
                </span>
                {kf.label && (
                  <span
                    className="animation-timeline__keyframe-label"
                    style={{ left: kf.time * pixelsPerSecond }}
                  >
                    {kf.label}
                  </span>
                )}
              </React.Fragment>
            ))}

            {/* Playhead */}
            <div
              className="animation-timeline__playhead"
              style={{ left: currentTime * pixelsPerSecond }}
              onMouseDown={handlePlayheadDragStart}
            />
          </div>
        </div>
      </div>

      {/* ── Context Menu ── */}
      {contextMenu && (
        <div
          className="animation-timeline__context-menu"
          style={{ top: contextMenu.y, left: contextMenu.x }}
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button
            className="animation-timeline__context-menu-item"
            onClick={(e) => {
              e.stopPropagation();
              // Update snapshot with current canvas
              const currentElements = app.scene
                .getNonDeletedElements()
                .filter((el: ExcalidrawElement) => el.frameId === activeFrameId)
                .map((el: ExcalidrawElement) => ({ ...el }));
              store.updateKeyframeSnapshot(
                contextMenu.keyframeId,
                currentElements,
              );
              setContextMenu(null);
            }}
          >
            <DiamondIcon />
            Update Snapshot
          </button>
          <button
            className="animation-timeline__context-menu-item animation-timeline__context-menu-item--danger"
            onClick={(e) => {
              e.stopPropagation();
              handleRemoveKeyframe(contextMenu.keyframeId);
            }}
          >
            <TrashIcon />
            Delete Keyframe
          </button>
        </div>
      )}
    </>
  );
};
