import React, { useState } from "react";
import { ExcalidrawAnimationFrameElement, NonDeletedExcalidrawElement, NonDeleted } from "@excalidraw/element/types";
import { AppState, UIAppState, AppClassProperties } from "../types";
import { t } from "../i18n";
import { mutateElement } from "@excalidraw/element";

import "./AnimationFramesPanel.scss";

// Simple close icon SVG
const CloseIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="18" y1="6" x2="6" y2="18"></line>
    <line x1="6" y1="6" x2="18" y2="18"></line>
  </svg>
);

const DragHandleIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="16" height="16">
    <line x1="8" y1="6" x2="16" y2="6"></line>
    <line x1="8" y1="12" x2="16" y2="12"></line>
    <line x1="8" y1="18" x2="16" y2="18"></line>
  </svg>
);

interface AnimationFramesPanelProps {
  elements: readonly NonDeletedExcalidrawElement[];
  appState: UIAppState;
  setAppState: React.Component<any, AppState>["setState"];
  app: AppClassProperties;
}

export const AnimationFramesPanel = ({
  elements,
  appState,
  setAppState,
  app,
}: AnimationFramesPanelProps) => {
  const [draggedElementId, setDraggedElementId] = useState<string | null>(null);
  const [dragOverElementId, setDragOverElementId] = useState<string | null>(null);
  const [dragOverPosition, setDragOverPosition] = useState<"top" | "bottom" | null>(null);

  const frames = elements
    .filter((el) => el.type === "animationframe")
    .map((el) => el as NonDeletedExcalidrawElement & { name: string | null; frameIndex: number })
    .sort((a, b) => a.frameIndex - b.frameIndex);

  if (!appState.openAnimationPanel) {
    return null;
  }

  const handleDragStart = (e: React.DragEvent, id: string) => {
    setDraggedElementId(id);
    e.dataTransfer.effectAllowed = "move";
  };

  const handleDragOver = (e: React.DragEvent, id: string) => {
    e.preventDefault();
    if (draggedElementId === id) return;

    setDragOverElementId(id);
    
    // Determine if we're dragging over the top or bottom half of the element
    const rect = (e.target as HTMLElement).getBoundingClientRect();
    const y = e.clientY - rect.top;
    if (y < rect.height / 2) {
      setDragOverPosition("top");
    } else {
      setDragOverPosition("bottom");
    }
  };

  const handleDragLeave = (e: React.DragEvent) => {
    setDragOverElementId(null);
    setDragOverPosition(null);
  };

  const handleDrop = (e: React.DragEvent, targetId: string) => {
    e.preventDefault();
    if (!draggedElementId || draggedElementId === targetId || !dragOverPosition) {
      setDraggedElementId(null);
      setDragOverElementId(null);
      setDragOverPosition(null);
      return;
    }

    const draggedIdx = frames.findIndex((f) => f.id === draggedElementId);
    const targetIdx = frames.findIndex((f) => f.id === targetId);

    if (draggedIdx === -1 || targetIdx === -1) return;

    const newFrames = [...frames];
    const [draggedFrame] = newFrames.splice(draggedIdx, 1);
    
    // Calculate new index
    let insertIdx = targetIdx;
    if (draggedIdx < targetIdx) {
      insertIdx = dragOverPosition === "top" ? targetIdx - 1 : targetIdx;
    } else {
      insertIdx = dragOverPosition === "top" ? targetIdx : targetIdx + 1;
    }

    newFrames.splice(insertIdx, 0, draggedFrame);

    // Update frameIndex for all frames
    newFrames.forEach((frame, index) => {
      if (frame.frameIndex !== index + 1) {
        mutateElement(frame as any, app.scene.getNonDeletedElementsMap(), {
          frameIndex: index + 1,
        } as any);
      }
    });

    app.scene.triggerUpdate();

    setDraggedElementId(null);
    setDragOverElementId(null);
    setDragOverPosition(null);
  };

  const handleDragEnd = () => {
    setDraggedElementId(null);
    setDragOverElementId(null);
    setDragOverPosition(null);
  };

  return (
    <div className="animation-frames-panel">
      <div className="animation-frames-panel-header">
        <span>Animation Frames</span>
        <button 
          className="close-button" 
          onClick={() => setAppState({ openAnimationPanel: false })}
          title="Close Panel"
        >
          <CloseIcon />
        </button>
      </div>
      <div className="animation-frames-panel-list">
        {frames.length === 0 ? (
          <div style={{ padding: "1rem", textAlign: "center", color: "var(--text-primary-color)", opacity: 0.6 }}>
            No animation frames found.
          </div>
        ) : (
          frames.map((frame, index) => (
            <div
              key={frame.id}
              className={`animation-frames-panel-item ${
                draggedElementId === frame.id ? "dragging" : ""
              } ${
                dragOverElementId === frame.id 
                  ? `drag-over-${dragOverPosition}` 
                  : ""
              }`}
              draggable
              onDragStart={(e) => handleDragStart(e, frame.id)}
              onDragOver={(e) => handleDragOver(e, frame.id)}
              onDragLeave={handleDragLeave}
              onDrop={(e) => handleDrop(e, frame.id)}
              onDragEnd={handleDragEnd}
              onClick={() => {
                // Optionally highlight the frame on click
                setAppState({
                  selectedElementIds: { [frame.id]: true },
                });
              }}
            >
              <div className="animation-frames-panel-item-content">
                <div className="animation-frames-panel-item-name">
                  {frame.name || `Frame ${index + 1}`}
                </div>
                <div className="animation-frames-panel-item-number">
                  Order: {frame.frameIndex}
                </div>
              </div>
              <div className="animation-frames-panel-item-handle">
                <DragHandleIcon />
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
};
