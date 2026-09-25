"use client";

import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import type { NodeTopology } from "./topology";

export type SwitchNodeData = { name: string; topologies: NodeTopology[] };
export type SwitchNodeType = Node<SwitchNodeData, "switch">;

// the switch's port ids match a cable's id exactly (see topology.ts) — no
// separate numbering scheme, so a cable's two ends are always trivially
// the same string. each group's width/gap is hardcoded in globals.css to
// match CARD_WIDTH/GAP in page.tsx, so a group always sits directly under
// the node card it belongs to and cables run close to straight down.
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
                <div key={cable.id} className="pc-switch__port" title={`${topology.node.name} — ${cable.nicName}`}>
                  <Handle
                    type="target"
                    position={Position.Top}
                    id={cable.id}
                    isConnectable={false}
                    className="pc-switch__plug"
                    style={cable.iface.bond ? { background: cable.iface.colorVar, borderColor: cable.iface.colorVar } : undefined}
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
