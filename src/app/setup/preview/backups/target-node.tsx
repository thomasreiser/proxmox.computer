"use client";

import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import type { BackupTargetView, OffsiteView } from "./plan";

export type BackupTargetData = { target: BackupTargetView; nodeCount: number; offsite: boolean };
export type BackupTargetType = Node<BackupTargetData, "backupTarget">;

// Where every node's backups land. Spans the node row like the storage
// preview's pool card, with one port under each node.
export function BackupTargetNode({ data }: NodeProps<BackupTargetType>) {
  const { target, nodeCount, offsite } = data;
  return (
    <div className="pc-pool pc-pool--backup">
      <div className="pc-pool__ports">
        {Array.from({ length: nodeCount }, (_, i) => (
          <div key={i} className="pc-pool__portbox">
            <Handle
              type="target"
              position={Position.Top}
              id={`node-${i}`}
              isConnectable={false}
              className="pc-pool__plug"
              style={{ top: "50%", left: "50%", transform: "translate(-50%, -50%)" }}
            />
          </div>
        ))}
      </div>
      <div className="pc-pool__head">
        <span className="code pc-pool__name">{target.title}</span>
        <span className="meta pc-pool__kind">{target.subtitle}</span>
      </div>
      <div className="pc-pool__body">
        <div className="pc-pool__facts">
          {target.facts.map((fact) => (
            <div key={fact.key} className="pc-pool__fact">
              <span className="meta pc-pool__key">{fact.key}</span>
              <span className="code pc-pool__val">{fact.value}</span>
            </div>
          ))}
        </div>
        {target.insideCluster && !offsite && (
          <p className="meta pc-pool__warn">⚠ lives on the cluster it backs up — no copy survives losing it</p>
        )}
      </div>
      {offsite && (
        <Handle
          type="source"
          position={Position.Bottom}
          id="offsite"
          isConnectable={false}
          className="pc-pool__plug pc-pool__plug--offsite"
        />
      )}
    </div>
  );
}

export type OffsiteData = { offsite: OffsiteView };
export type OffsiteType = Node<OffsiteData, "offsite">;

// the second pbs, pulling a copy of the datastore on its own schedule
export function OffsiteNode({ data }: NodeProps<OffsiteType>) {
  return (
    <div className="pc-storcard pc-storcard--offsite">
      <Handle type="target" position={Position.Top} id="in" isConnectable={false} className="pc-offsite__plug" />
      <div className="pc-storcard__head">
        <span className="code pc-storcard__host">{data.offsite.address}</span>
        <span className="meta pc-storcard__index">off-site</span>
      </div>
      <div className="pc-storcard__link">
        <span className="meta pc-storcard__footkey">copy of</span>
        <span className="code pc-storcard__linkval">the whole datastore, synced</span>
      </div>
    </div>
  );
}
