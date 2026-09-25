"use client";

import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { nicSpeedLabel } from "../../wizard-state";
import { bridgeSummaryLabel, type NodeTopology } from "./topology";

export type NetworkNodeCardData = { topology: NodeTopology };
export type NetworkNodeCardNode = Node<NetworkNodeCardData, "networkNode">;

export function NetworkNodeCard({ data }: NodeProps<NetworkNodeCardNode>) {
  const { topology } = data;
  const { node, nodeIndex, interfaces } = topology;

  return (
    <div className="pc-netcard">
      <div className="pc-netcard__head">
        <span className="code pc-netcard__host">{node.network.hostLabel || node.name}</span>
        <span className="meta pc-netcard__index">node {String(nodeIndex + 1).padStart(2, "0")}</span>
      </div>

      <div className="pc-netcard__body">
        {interfaces.map((iface) => (
          <div
            key={iface.id}
            className="pc-netcard__iface"
            style={iface.bond ? { borderColor: iface.colorVar } : undefined}
          >
            {iface.bond ? (
              <div className="pc-netcard__ifacehead">
                <span className="pc-netcard__swatch" style={{ background: iface.colorVar }} />
                <span className="code">{iface.bond.name}</span>
                <span className="body-sm pc-netcard__value--dim">{iface.bond.modeLabel}</span>
                {iface.isManagement && <span className="pc-netcard__mgmt">mgmt</span>}
              </div>
            ) : (
              iface.isManagement && (
                <div className="pc-netcard__ifacehead">
                  <span className="pc-netcard__mgmt">mgmt</span>
                </div>
              )
            )}

            <div className="pc-netcard__bridges">
              {iface.bridges.length === 0 ? (
                <p className="body-sm pc-netcard__value--dim">(unused)</p>
              ) : (
                iface.bridges.map((bridge, i) => (
                  <p
                    key={i}
                    className={`body-sm pc-netcard__bridge ${bridge.vlan.kind === "unset" ? "pc-netcard__bridge--warn" : ""}`}
                  >
                    {bridgeSummaryLabel(bridge)}
                  </p>
                ))
              )}
            </div>

            {iface.nicIndices.map((nicIndex) => {
              const nic = node.nics[nicIndex];
              if (!nic) return null;
              return (
                <div key={nicIndex} className="pc-netcard__port">
                  <span className="code pc-netcard__portname">{nic.name}</span>
                  <span className="body-sm pc-netcard__value--dim">{nicSpeedLabel(nic.speed)}</span>
                </div>
              );
            })}
          </div>
        ))}
      </div>

      {/* the actual cabling anchors, kept apart from the bridge/vlan
          breakdown above: one evenly-spaced box per physical nic, in nic
          order, matching the switch's own port strip below it box-for-box.
          same spacing on both ends means every cable is a clean, direct,
          non-crossing drop — not something computed per bridge/bond, so
          it stays true no matter how tall the info above gets. */}
      <div className="pc-netcard__portstrip">
        {topology.cables.map((cable) => (
          <div key={cable.id} className="pc-netcard__portbox" style={{ borderColor: cable.iface.colorVar }}>
            <span className="meta pc-netcard__portboxlabel">{cable.nicName}</span>
            <Handle
              type="source"
              position={Position.Bottom}
              id={`nic-${cable.nicIndex}`}
              isConnectable={false}
              className="pc-netcard__plug"
              style={{ background: cable.iface.colorVar, borderColor: cable.iface.colorVar }}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
