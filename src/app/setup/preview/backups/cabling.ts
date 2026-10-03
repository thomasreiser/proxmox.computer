// Where the backups preview's cards go and which cables join them. Pure,
// like the storage preview's cabling.ts, so the rules are tested directly.

import { MarkerType, type Edge } from "@xyflow/react";
import type { BackupOverview } from "./plan";
import type { BackupNodeType } from "./node-card";
import type { BackupTargetType, OffsiteType } from "./target-node";

// the storage preview's numbers (and its --storcard-* css): the target
// card's port boxes use the same grid, which keeps every cable straight
export const CARD_WIDTH = 320;
export const GAP = 56;

/** the node row's full width — the target card spans it */
export function rowWidth(nodeCount: number): number {
  return Math.max(nodeCount, 1) * CARD_WIDTH + Math.max(nodeCount - 1, 0) * GAP;
}

/** the off-site card sits centered under the target, where its cable drops */
export function offsiteX(nodeCount: number): number {
  return (rowWidth(nodeCount) - CARD_WIDTH) / 2;
}

export function layout(overview: BackupOverview): {
  nodes: (BackupNodeType | BackupTargetType | OffsiteType)[];
  edges: Edge[];
} {
  const cards: BackupNodeType[] = overview.nodes.map((view) => ({
    id: `node-${view.nodeIndex}`,
    type: "backupNode" as const,
    position: { x: view.nodeIndex * (CARD_WIDTH + GAP), y: 0 },
    data: { view },
  }));
  if (!overview.target) return { nodes: cards, edges: [] };

  // rough first guesses — the page restacks under the measured heights
  const target: BackupTargetType = {
    id: "target",
    type: "backupTarget" as const,
    position: { x: 0, y: 140 + GAP },
    data: { target: overview.target, nodeCount: overview.nodes.length, offsite: !!overview.offsite },
  };

  // every node sends its own backups — solid over a dedicated backup
  // link, dashed where they share the management link
  const edges: Edge[] = overview.nodes.map((view) => ({
    id: `backup-${view.nodeIndex}`,
    source: `node-${view.nodeIndex}`,
    sourceHandle: "backup",
    target: "target",
    targetHandle: `node-${view.nodeIndex}`,
    type: "straight",
    style: {
      stroke: "var(--cable-d)",
      strokeWidth: 2,
      ...(view.link.dedicated ? {} : { strokeDasharray: "6 4" }),
    },
    markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16, color: "var(--cable-d)" },
    zIndex: 1000,
  }));

  if (!overview.offsite) return { nodes: [...cards, target], edges };

  const offsite: OffsiteType = {
    id: "offsite",
    type: "offsite" as const,
    position: { x: offsiteX(overview.nodes.length), y: 140 + GAP + 220 + GAP },
    data: { offsite: overview.offsite },
  };
  // pbs's sync job: a scheduled pull, so dashed like zfs replication
  edges.push({
    id: "offsite-sync",
    source: "target",
    sourceHandle: "offsite",
    target: "offsite",
    targetHandle: "in",
    type: "straight",
    style: { stroke: "var(--cable-c)", strokeWidth: 2, strokeDasharray: "6 4" },
    markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16, color: "var(--cable-c)" },
    zIndex: 1000,
  });
  return { nodes: [...cards, target, offsite], edges };
}
