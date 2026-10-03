"use client";

import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import type { BackupNodeView } from "./plan";

export type BackupNodeData = { view: BackupNodeView };
export type BackupNodeType = Node<BackupNodeData, "backupNode">;

// One node and the link its backups leave over. Deliberately small: the
// earlier previews already showed its hardware, network and disks.
export function BackupNodeCard({ data }: NodeProps<BackupNodeType>) {
  const { view } = data;
  return (
    <div className="pc-storcard">
      <div className="pc-storcard__head">
        <span className="code pc-storcard__host">{view.fqdn}</span>
        <span className="meta pc-storcard__index">node {String(view.nodeIndex + 1).padStart(2, "0")}</span>
      </div>
      <div className="pc-storcard__link pc-storcard__link--stacked">
        <div className="pc-storcard__linkrow">
          <span className="meta pc-storcard__footkey">backups via</span>
          <span className="code pc-storcard__linkval">{view.link.label}</span>
        </div>
        {view.link.speed && (
          <div className="pc-storcard__linkrow">
            <span className="meta pc-storcard__footkey">link speed</span>
            <span className="code pc-storcard__linkval">{view.link.speed}</span>
          </div>
        )}
        {!view.link.dedicated && (
          <p className="meta pc-storcard__linkreason">no backup link in step 3 — shares management</p>
        )}
      </div>
      <Handle
        type="source"
        position={Position.Bottom}
        id="backup"
        isConnectable={false}
        className="pc-storcard__plug pc-storcard__plug--backup"
      />
    </div>
  );
}
