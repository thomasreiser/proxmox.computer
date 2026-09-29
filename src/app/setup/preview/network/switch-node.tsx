"use client";

import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { NIC_PORT_LABEL } from "../../wizard-state";
import { cephCableCount, portLagLabel, portVlanDescription, portVlanLabel, type NodeTopology } from "./topology";

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
  const cephPorts = cephCableCount(topologies);

  return (
    <div className="pc-switch">
      <div className="pc-switch__head">
        <span className="code pc-switch__name">{name}</span>
        <div className="pc-switch__headmeta">
          {cephPorts > 0 && (
            <span className="meta pc-switch__ceph">
              <span className="pc-switch__cephmark" aria-hidden="true" />
              {cephPorts} ceph — keep on this one switch
            </span>
          )}
          <span className="meta pc-switch__value--dim">
            {topologies.reduce((n, t) => n + t.cables.length, 0)} ports
          </span>
        </div>
      </div>
      <div className="pc-switch__groups">
        {topologies.map((topology) => (
          <div key={topology.nodeIndex} className="pc-switch__group">
            <div className="pc-switch__ports">
              {topology.cables.map((cable) => (
                <div
                  key={cable.id}
                  className={`pc-switch__portbox${cable.iface.carriesCeph ? " pc-switch__portbox--ceph" : ""}`}
                  title={[
                    `${topology.node.name} — ${cable.nicName}`,
                    cable.nicPort ? NIC_PORT_LABEL[cable.nicPort] : "connector unknown",
                    portVlanDescription(cable.iface),
                    ...(cable.iface.bond?.lag === "lacp" ? [`lacp lag with the other ${cable.iface.bond.name} ports`] : []),
                    ...(cable.iface.bond?.lag === "static" ? [`static lag with the other ${cable.iface.bond.name} ports`] : []),
                    ...(cable.iface.carriesCeph ? ["ceph"] : []),
                  ].join(" — ")}
                >
                  {/* what the switch port must be: its connector, then how
                      its vlans are set — the two things you configure (or
                      buy) a switch port by */}
                  <span className="meta pc-switch__porttype">
                    {cable.nicPort ? NIC_PORT_LABEL[cable.nicPort] : "?"}
                  </span>
                  <span
                    className={`meta pc-switch__portvlan ${portVlanLabel(cable.iface).includes("?") ? "pc-switch__portvlan--warn" : ""}`}
                  >
                    {portVlanLabel(cable.iface)}
                  </span>
                  {/* a bond that needs the switch's help: these ports form one lag */}
                  {portLagLabel(cable.iface) && (
                    <span className="meta pc-switch__portlag">{portLagLabel(cable.iface)}</span>
                  )}
                  <Handle
                    type="target"
                    position={Position.Top}
                    id={cable.id}
                    isConnectable={false}
                    className="pc-switch__plug"
                    // anchored on the box's top edge, so the cable arrives
                    // at the port without drawing over its labels
                    style={{
                      background: cable.iface.colorVar,
                      borderColor: cable.iface.colorVar,
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
