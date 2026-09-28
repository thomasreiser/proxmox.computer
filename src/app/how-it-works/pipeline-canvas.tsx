"use client";

import { useEffect } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  ReactFlow,
  ReactFlowProvider,
  useNodesInitialized,
  useReactFlow,
  type Edge,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  CARD_WIDTH,
  FLOW_STROKE,
  FLOWS,
  LANE_PAD,
  LANE_TOP,
  LANE_WIDTH,
  LANE_X,
  LANES,
  PHASES,
} from "./pipeline";
import { LaneNode, PhaseNode, type LaneNodeType, type PhaseNodeType } from "./phase-node";

const nodeTypes = { phase: PhaseNode, lane: LaneNode };

function buildNodes(): (PhaseNodeType | LaneNodeType)[] {
  const lanes: LaneNodeType[] = LANES.map((lane) => ({
    id: `lane-${lane.side}`,
    type: "lane" as const,
    position: { x: LANE_X[lane.side] - LANE_PAD, y: LANE_TOP },
    data: { label: lane.label, hint: lane.hint, side: lane.side, width: LANE_WIDTH, height: lane.height },
    // the lanes are scenery, not content: dragging one would shear the
    // whole diagram away from the cards it's supposed to contain.
    draggable: false,
    selectable: false,
    zIndex: -1,
  }));

  const cards: PhaseNodeType[] = PHASES.map((phase) => ({
    id: phase.id,
    type: "phase" as const,
    position: phase.position,
    data: { phase },
    style: { width: CARD_WIDTH },
  }));

  // lanes first so they're behind even before zIndex is considered
  return [...lanes, ...cards];
}

function buildEdges(): Edge[] {
  return FLOWS.map((flow) => {
    const stroke = FLOW_STROKE[flow.kind];
    return {
      id: flow.id,
      source: flow.from,
      sourceHandle: flow.fromHandle,
      target: flow.to,
      targetHandle: flow.toHandle,
      type: "smoothstep",
      // the loop travels back outside the left lane rather than grazing its
      // border, so its offset has to beat LANE_PAD; every other edge only
      // needs enough room to leave its card cleanly before turning.
      pathOptions: flow.kind === "loop" ? { borderRadius: 12, offset: 90 } : { borderRadius: 8, offset: 24 },
      label: flow.carries || undefined,
      labelShowBg: true,
      labelBgPadding: [6, 3] as [number, number],
      style: {
        stroke,
        strokeWidth: flow.kind === "step" ? 1.5 : 2,
        strokeDasharray: flow.kind === "loop" ? "6 4" : undefined,
      },
      markerEnd: { type: MarkerType.ArrowClosed, width: 18, height: 18, color: stroke },
      // above the lane scenery and above the cards, so a line that has to
      // travel past a card still reads as one continuous run.
      zIndex: 5,
    };
  });
}

// nothing here derives from props or state — unlike the previews, which
// rebuild from whatever the visitor has saved — so both are built once at
// module scope and the component just renders them.
const NODES = buildNodes();
const EDGES = buildEdges();

function Canvas() {
  const { fitView } = useReactFlow();
  // a card's real height depends on how its bullets wrap, so react flow's
  // own on-mount fitView measures against placeholder heights and fits to
  // bounds that are too short — which clipped the return loop, the one
  // edge that travels below the last card. this refits exactly once, the
  // moment every node reports a measured size.
  const initialized = useNodesInitialized();
  useEffect(() => {
    if (initialized) fitView({ padding: 0.1 });
  }, [initialized, fitView]);

  return (
    <div className="pc-canvas pc-canvas--pipeline">
      <ReactFlow
        defaultNodes={NODES}
        defaultEdges={EDGES}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.1 }}
        minZoom={0.1}
        maxZoom={1.4}
        nodesConnectable={false}
        edgesFocusable={false}
        // the diagram is taller than the viewport it sits in, so scrolling
        // over it has to keep scrolling the page — panning is by drag.
        zoomOnScroll={false}
        preventScrolling={false}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}

export function PipelineCanvas() {
  return (
    <ReactFlowProvider>
      <Canvas />
    </ReactFlowProvider>
  );
}
