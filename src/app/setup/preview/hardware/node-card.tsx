"use client";

import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { nicSpeedLabel, type DiskType, type NodeInfo } from "../../wizard-state";

// `type`, not `interface` — react flow constrains node data to
// Record<string, unknown>, which only a type alias satisfies implicitly.
export type NodeCardData = {
  node: NodeInfo;
  index: number;
  // the biggest disk anywhere in the cluster — every capacity bar is drawn
  // relative to it, so bar lengths are comparable from node to node.
  maxDiskGb: number;
};

export type NodeCardNode = Node<NodeCardData, "nodeCard">;

const DISK_TONE: Record<DiskType, string> = {
  nvme: "brand",
  ssd: "accent",
  hdd: "muted",
};

function parseGb(value: string): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// decimal units, matching how drives are actually sold and specced —
// a "4tb" disk is the 4000 the visitor typed, not 3.64 TiB.
function formatCapacity(value: string): string {
  const gb = parseGb(value);
  if (gb === null) return "—";
  if (gb < 1000) return `${gb} gb`;
  const tb = gb / 1000;
  return `${Number.isInteger(tb) ? tb : tb.toFixed(1)} tb`;
}

export function NodeCard({ data }: NodeProps<NodeCardNode>) {
  const { node, index, maxDiskGb } = data;
  const cores = (Number(node.cpuCount) || 0) * (Number(node.coresPerCpu) || 0);
  const disks = [
    { name: node.bootDiskName, type: node.bootDiskType, sizeGb: node.bootDiskSizeGb, isBoot: true },
    ...node.additionalDisks.map((d) => ({ ...d, isBoot: false })),
  ];

  return (
    <div className="pc-nodecard">
      <div className="pc-nodecard__head">
        <span className="code pc-nodecard__host">{node.network.hostLabel || node.name}</span>
        <span className="meta pc-nodecard__index">node {String(index + 1).padStart(2, "0")}</span>
      </div>

      <div className="pc-nodecard__section">
        <div className="pc-nodecard__row">
          <span className="label pc-nodecard__key">cpu</span>
          <span className="body-sm pc-nodecard__value">
            {node.cpuVendor} · {node.cpuFamily}
          </span>
        </div>
        <div className="pc-nodecard__row">
          <span className="label pc-nodecard__key" />
          <span className="body-sm pc-nodecard__value pc-nodecard__value--dim">
            {node.cpuCount} × {node.coresPerCpu}c{cores > 0 ? ` = ${cores} cores` : ""}
          </span>
        </div>
        <div className="pc-nodecard__row">
          <span className="label pc-nodecard__key">ram</span>
          <span className="body-sm pc-nodecard__value">{node.ramGb ? `${node.ramGb} gb` : "—"}</span>
        </div>
      </div>

      <div className="pc-nodecard__section">
        <p className="label pc-nodecard__legend">storage</p>
        {disks.map((disk, i) => {
          const gb = parseGb(disk.sizeGb);
          const pct = gb ? Math.max(4, (gb / maxDiskGb) * 100) : 0;
          return (
            <div key={i} className="pc-nodecard__disk">
              <div className="pc-nodecard__row">
                <span className={`code pc-nodecard__diskname pc-nodecard__diskname--${DISK_TONE[disk.type]}`}>
                  {disk.isBoot ? "▰" : "▱"} {disk.name || "—"}
                </span>
                <span className="body-sm pc-nodecard__value--dim">{disk.type}</span>
                <span className="body-sm pc-nodecard__size">{formatCapacity(disk.sizeGb)}</span>
              </div>
              <div className="pc-nodecard__bar">
                <div
                  className={`pc-nodecard__barfill pc-nodecard__barfill--${DISK_TONE[disk.type]}`}
                  style={{ width: `${pct}%` }}
                />
              </div>
            </div>
          );
        })}
      </div>

      <div className="pc-nodecard__section pc-nodecard__section--nics">
        <p className="label pc-nodecard__legend">nics</p>
        {node.nics.map((nic, i) => (
          <div key={i} className="pc-nodecard__nic">
            <span className="code pc-nodecard__nicname">{nic.name}</span>
            <span className="body-sm pc-nodecard__value--dim">{nicSpeedLabel(nic.speed)}</span>
            {/* a real port: once step 2 draws a switch, its cable anchors
                here by this handle's id, no layout math required. */}
            <Handle
              type="source"
              position={Position.Right}
              id={`nic-${i}`}
              isConnectable={false}
              className="pc-nodecard__port"
            />
          </div>
        ))}
      </div>
    </div>
  );
}
