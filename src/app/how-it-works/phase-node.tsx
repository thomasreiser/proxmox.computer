"use client";

import { Fragment } from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { sideLabel, type PhaseSide, type PhaseSpec } from "./pipeline";

export type PhaseNodeData = { phase: PhaseSpec };
export type PhaseNodeType = Node<PhaseNodeData, "phase">;

export type LaneNodeData = { label: string; hint: string; side: PhaseSide; width: number; height: number };
export type LaneNodeType = Node<LaneNodeData, "lane">;

// every card carries a target and a source handle on all four sides, so
// an edge can pick the pair that keeps its route short — the alternative
// (one top/bottom pair per card) forces the two lane-crossing handoffs
// into long diagonal detours past cards they have nothing to do with.
// they're invisible: these are logical flows, and the arrowheads already
// say where a line starts and ends. (a physical cable in the network
// preview draws a real plug, because there the port IS the point.)
const SIDES = [
  { key: "t", position: Position.Top },
  { key: "r", position: Position.Right },
  { key: "b", position: Position.Bottom },
  { key: "l", position: Position.Left },
] as const;

export function PhaseNode({ data }: NodeProps<PhaseNodeType>) {
  const { phase } = data;

  return (
    <div className={`pc-phase pc-phase--${phase.side}`}>
      {SIDES.map(({ key, position }) => (
        <Fragment key={key}>
          <Handle type="target" position={position} id={`${key}-in`} isConnectable={false} className="pc-phase__anchor" />
          <Handle type="source" position={position} id={`${key}-out`} isConnectable={false} className="pc-phase__anchor" />
        </Fragment>
      ))}

      <div className="pc-phase__head">
        <span className="pc-phase__step">{phase.step}</span>
        <span className="meta pc-phase__where">{sideLabel(phase.side)}</span>
      </div>
      <div className="pc-phase__body">
        <p className="h3 pc-phase__title">{phase.title}</p>
        <p className="meta pc-phase__tagline">{phase.tagline}</p>
        <ul className="pc-phase__list">
          {phase.bullets.map((bullet) => (
            <li key={bullet} className="meta pc-phase__item">
              <span className="pc-phase__marker">›</span>
              <span>{bullet}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

// the two columns behind the cards — the whole diagram's argument is that
// a phase belongs to exactly one of these, so the split is drawn as real
// territory rather than left to the cards' own coloring.
export function LaneNode({ data }: NodeProps<LaneNodeType>) {
  const { label, hint, side, width, height } = data;

  return (
    <div className={`pc-lane pc-lane--${side}`} style={{ width, height }}>
      <div className="pc-lane__head">
        <span className="label pc-lane__label">{label}</span>
        <span className="meta pc-lane__hint">{hint}</span>
      </div>
    </div>
  );
}
