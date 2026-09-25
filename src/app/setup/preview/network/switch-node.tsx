"use client";

import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import type { NodeTopology } from "./topology";

export type SwitchNodeData = { name: string; topologies: NodeTopology[] };
export type SwitchNodeType = Node<SwitchNodeData, "switch">;

// the switch's port ids match a cable's id exactly (see topology.ts) — no
// separate numbering scheme, so a cable's two ends are always trivially
// the same string. each group is exactly CARD_WIDTH wide (see page.tsx),
// laid out as a same-column-count css grid as the node card's own port
// strip above it — equal-width columns in the same nic order on both
// ends is what keeps every cable a straight, non-crossing drop, not
// anything computed per cable.
export function SwitchNode({ data }: NodeProps<SwitchNodeType>) {
  const { name, topologies } = data;

  return (
    <div className="pc-switch">
      <div className="pc-switch__head">
        <span className="code pc-switch__name">{name}</span>
        <span className="meta pc-switch__value--dim">
          {topologies.reduce((n, t) => n + t.cables.length, 0)} ports
        </span>
      </div>
      <div className="pc-switch__groups">
        {topologies.map((topology) => (
          <div key={topology.nodeIndex} className="pc-switch__group">
            <div className="pc-switch__ports">
              {topology.cables.map((cable) => (
                <div key={cable.id} className="pc-switch__portbox" title={`${topology.node.name} — ${cable.nicName}`}>
                  <Handle
                    type="target"
                    position={Position.Top}
                    id={cable.id}
                    isConnectable={false}
                    className="pc-switch__plug"
                    // Position.Top's default css straddles the box's
                    // border (half in, half out) — pull it to the box's
                    // actual center so the cable reads as plugged into
                    // the port, not just touching its top edge.
                    style={{
                      background: cable.iface.colorVar,
                      borderColor: cable.iface.colorVar,
                      top: "50%",
                      transform: "translate(-50%, -50%)",
                    }}
                  />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
