"use client";

import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import type { ClusterPoolView } from "./plan";

// every node's cable lands in the port under it. ceph's cables leave each
// node card from the middle, zfs's from three quarters across, so with
// both pools on the zfs cables never run over the ceph ones.
export const PORT_X: Record<ClusterPoolView["kind"], string> = { ceph: "50%", zfs: "75%" };

export type PoolNodeData = { pool: ClusterPoolView };
export type PoolNodeType = Node<PoolNodeData, "pool">;

// The one card every node's disks add up to. Under ceph that's literal —
// there is a single pool spread across the cluster. Under zfs replication
// it's one pool *per node* that all hold the same guests, so the card
// names the shared layout rather than pretending the capacity adds up.
export function PoolNode({ data }: NodeProps<PoolNodeType>) {
  const { pool } = data;
  const incomplete = pool.contributing < pool.nodeCount;

  return (
    <div className={`pc-pool pc-pool--${pool.kind === "ceph" ? "ceph" : "zfs"}`}>
      {/* one target per node along the card's top edge, in the same order
          as the cards above, so every cable is a short straight drop that
          ends at the pool — never one drawn across its content. */}
      <div className="pc-pool__ports">
        {Array.from({ length: pool.nodeCount }, (_, i) => (
          <div key={i} className="pc-pool__portbox">
            <Handle
              type="target"
              position={Position.Top}
              id={`node-${i}`}
              isConnectable={false}
              className="pc-pool__plug"
              style={{ top: "50%", left: PORT_X[pool.kind], transform: "translate(-50%, -50%)" }}
            />
          </div>
        ))}
      </div>
      <div className="pc-pool__head">
        <span className="code pc-pool__name">{pool.name || "(unnamed)"}</span>
        <span className="meta pc-pool__kind">{pool.kind === "ceph" ? "ceph pool" : "zfs + replication"}</span>
      </div>

      <div className="pc-pool__body">
        <div className="pc-pool__headline">
          <span className="label pc-pool__key">usable</span>
          <span className="code pc-pool__usable">{pool.usable}</span>
          <span className="meta pc-pool__raw">of {pool.raw} raw</span>
        </div>

        <div className="pc-pool__facts">
          {pool.facts.map((fact) => (
            <div key={fact.key} className="pc-pool__fact">
              <span className="meta pc-pool__key">{fact.key}</span>
              <span className="code pc-pool__val">{fact.value}</span>
            </div>
          ))}
        </div>

        {incomplete && (
          <p className="meta pc-pool__warn">
            ⚠ only {pool.contributing} of {pool.nodeCount} nodes contribute a disk
          </p>
        )}
      </div>
    </div>
  );
}
