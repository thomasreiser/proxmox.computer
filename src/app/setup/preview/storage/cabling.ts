// Where the storage preview's cards go and which cables join them. Kept
// out of page.tsx — a page file only exports its page — and pure, so the
// cabling rules are tested directly (cabling.test.ts). Not layout.ts: that
// name is reserved in the app directory for a route layout.

import { MarkerType, type Edge } from "@xyflow/react";
import type { StorageOverview } from "./plan";
import type { StorageNodeType } from "./node-card";
import type { PoolNodeType } from "./pool-node";

// mirrors --storcard-w / --storcard-gap in globals.css — the pool's port
// boxes are laid out from the same two numbers, which is what keeps every
// cable a straight drop. change one, change the other.
export const CARD_WIDTH = 320;
export const GAP = 56;

// under the node row: the ceph pool, then the zfs replication pool —
// whichever exist, in that order. both are cabled to every node that
// contributes to them; with both on, the zfs cables run behind the ceph
// card on their way down (see the zIndex notes in layout()).
function poolCards(overview: StorageOverview): PoolNodeType[] {
  const cards: PoolNodeType[] = [];
  if (overview.ceph) {
    // above the zfs cables, so they pass behind it rather than over it
    cards.push({ id: "pool-ceph", type: "pool" as const, position: { x: 0, y: 0 }, data: { pool: overview.ceph }, zIndex: 20 });
  }
  if (overview.zfs) {
    cards.push({ id: "pool-zfs", type: "pool" as const, position: { x: 0, y: 0 }, data: { pool: overview.zfs } });
  }
  return cards;
}

export function layout(overview: StorageOverview): { nodes: (StorageNodeType | PoolNodeType)[]; edges: Edge[] } {
  const cards: StorageNodeType[] = overview.nodes.map((view) => ({
    id: `node-${view.nodeIndex}`,
    type: "storageNode" as const,
    position: { x: view.nodeIndex * (CARD_WIDTH + GAP), y: 0 },
    data: { view },
  }));

  // a rough first guess only — the effect below stacks the pool cards
  // under the real card heights once react flow has measured them.
  const estimated = 180 + Math.max(...overview.nodes.map((n) => n.disks.length + 1), 1) * 30;
  const pools = poolCards(overview).map((card, i) => ({
    ...card,
    position: { x: 0, y: estimated + GAP + i * (220 + GAP) },
  }));

  const cephEdges: Edge[] = overview.ceph
    ? overview.nodes
        .filter((view) => view.cephDisks.length > 0)
        .map((view) => ({
          id: `pool-${view.nodeIndex}`,
          source: `node-${view.nodeIndex}`,
          sourceHandle: "pool",
          target: "pool-ceph",
          targetHandle: `node-${view.nodeIndex}`,
          // both ends sit in matching grids, so the two anchors already
          // share an x and a straight line is the honest shortest path
          type: "straight",
          style: { stroke: "var(--brand)", strokeWidth: 2 },
          markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16, color: "var(--brand)" },
          // same reason as the network preview: an edge has to paint above
          // the pool card, which it deliberately travels into to reach a port.
          zIndex: 1000,
        }))
    : [];

  // zfs: each node's own pool, replicated to the others — dashed, since
  // replication is a scheduled copy rather than a live link. with ceph on
  // too these pass *behind* the ceph card (zIndex 10 < its 20) instead of
  // over its contents, and reappear below it at the zfs card.
  const zfsEdges: Edge[] = overview.zfs
    ? overview.nodes
        .filter((view) => view.zfsDisks.length > 0)
        .map((view) => ({
          id: `zfs-${view.nodeIndex}`,
          source: `node-${view.nodeIndex}`,
          sourceHandle: "zfs",
          target: "pool-zfs",
          targetHandle: `node-${view.nodeIndex}`,
          type: "straight",
          style: { stroke: "var(--cable-b)", strokeWidth: 2, strokeDasharray: "6 4" },
          markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16, color: "var(--cable-b)" },
          zIndex: overview.ceph ? 10 : 1000,
        }))
    : [];

  return { nodes: [...cards, ...pools], edges: [...cephEdges, ...zfsEdges] };
}

