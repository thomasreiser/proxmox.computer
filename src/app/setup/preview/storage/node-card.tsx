"use client";

import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { ROLE_COLOR, roleLabel, type NodeStorageView } from "./plan";
import { PORT_X } from "./pool-node";
import { formatGb } from "../../storage";

export type StorageNodeData = { view: NodeStorageView };
export type StorageNodeType = Node<StorageNodeData, "storageNode">;

// One node's disks, in the order step 2 declared them, each stamped with
// the role step 4 gave it. The boot disk sits apart at the top: it's the
// one disk the visitor never assigns, and mixing it into the list would
// invite the idea that it could be handed to a pool.
export function StorageNodeCard({ data }: NodeProps<StorageNodeType>) {
  const { view } = data;

  return (
    <div className="pc-storcard">
      <div className="pc-storcard__head">
        <span className="code pc-storcard__host">{view.fqdn}</span>
        <span className="meta pc-storcard__index">node {String(view.nodeIndex + 1).padStart(2, "0")}</span>
      </div>

      <div className="pc-storcard__body">
        <div className="pc-storcard__disk pc-storcard__disk--boot">
          <span className="pc-storcard__swatch" style={{ background: ROLE_COLOR.boot }} />
          <span className="code pc-storcard__diskname">{view.boot.name}</span>
          <span className="meta pc-storcard__disktype">{view.boot.type}</span>
          <span className="code pc-storcard__disksize">{formatGb(view.boot.sizeGb)}</span>
          <span className="meta pc-storcard__diskrole">boot</span>
        </div>

        {view.disks.length === 0 ? (
          <p className="body-sm pc-storcard__empty">no disks beyond boot</p>
        ) : (
          view.disks.map((disk, i) => (
            <div key={i} className={`pc-storcard__disk pc-storcard__disk--${disk.role}`}>
              <span className="pc-storcard__swatch" style={{ background: ROLE_COLOR[disk.role] }} />
              <span className="code pc-storcard__diskname">{disk.name || `disk ${i + 1}`}</span>
              <span className="meta pc-storcard__disktype">{disk.type}</span>
              <span className="code pc-storcard__disksize">{formatGb(disk.sizeGb)}</span>
              <span className="meta pc-storcard__diskrole" style={{ color: ROLE_COLOR[disk.role] }}>
                {roleLabel(disk.role)}
              </span>
            </div>
          ))
        )}
      </div>

      {view.storageLinks.map((link) => (
        <div key={link.key} className="pc-storcard__link pc-storcard__link--stacked">
          <div className="pc-storcard__linkrow">
            <span className="meta pc-storcard__footkey">{link.key}</span>
            <span className={`code pc-storcard__linkval ${link.warn ? "pc-storcard__linkval--warn" : ""}`}>
              {link.warn && "⚠ "}
              {link.label}
            </span>
          </div>
          {/* a ⚠ on its own says nothing — the reason sits right under it */}
          {link.reason && <p className="meta pc-storcard__linkreason">{link.reason}</p>}
        </div>
      ))}

      {/* this node's own zfs pool — it stays on the node and is replicated,
          so unlike ceph it gets a line here rather than a cable out */}
      {view.zfsDisks.length > 0 && (
        <div className="pc-storcard__link">
          <span className="meta pc-storcard__footkey">zfs pool</span>
          <span className="code pc-storcard__zfsval">
            {diskCount(view.zfsDisks.length)} · {formatGb(view.zfsUsableGb)} usable
          </span>
        </div>
      )}

      {/* the zfs cable's anchor, on the card's own bottom edge — set off
          from the ceph cable's so the two never overlap */}
      {view.zfsDisks.length > 0 && (
        <Handle
          type="source"
          position={Position.Bottom}
          id="zfs"
          isConnectable={false}
          className="pc-storcard__plug pc-storcard__plug--zfs"
          style={{ left: PORT_X.zfs }}
        />
      )}

      {/* one anchor per node, at the bottom edge: the cable stands for
          "this node contributes to the ceph pool", not for any single disk
          — drawing one per osd would bury the cards in lines. */}
      {view.cephDisks.length > 0 && (
        <div className="pc-storcard__foot">
          <span className="meta pc-storcard__footkey">to the ceph pool</span>
          <span className="code pc-storcard__footval">
            {diskCount(view.cephDisks.length)} · {formatGb(view.cephRawGb)}
          </span>
          <Handle
            type="source"
            position={Position.Bottom}
            id="pool"
            isConnectable={false}
            className="pc-storcard__plug"
          />
        </div>
      )}
    </div>
  );
}

function diskCount(n: number): string {
  return `${n} ${n === 1 ? "disk" : "disks"}`;
}
