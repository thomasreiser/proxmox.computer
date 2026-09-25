"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Edge,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { loadPersistedState, type PersistedState } from "../../wizard-state";
import { buildClusterTopology, distinctVlanTags, type NodeTopology } from "./topology";
import { NetworkNodeCard, type NetworkNodeCardNode } from "./node-card";
import { SwitchNode, type SwitchNodeType } from "./switch-node";

const nodeTypes = { networkNode: NetworkNodeCard, switch: SwitchNode };

const CARD_WIDTH = 320;
const GAP = 64;
const SWITCH_NAME = "switch-01";

// only a rough placeholder for the very first paint, before react flow has
// measured any card's actual rendered height — the effect in NetworkCanvas
// below slides the switch to the real position immediately after, so
// precision here doesn't matter. it only exists so the first frame isn't
// wildly wrong (a card can now be quite tall: one interface may list up to
// MAX_BRIDGES_PER_INTERFACE bridges).
function estimateHeight(topology: NodeTopology): number {
  let h = 90;
  for (const iface of topology.interfaces) {
    const bridgeLines = Math.max(1, iface.bridges.length);
    h += 24 + (iface.bond ? 30 : 0) + bridgeLines * 22 + iface.nicIndices.length * 28;
  }
  return h;
}

function layout(topologies: NodeTopology[]): { nodes: (NetworkNodeCardNode | SwitchNodeType)[]; edges: Edge[] } {
  const nodeCards: NetworkNodeCardNode[] = topologies.map((topology) => ({
    id: `node-${topology.nodeIndex}`,
    type: "networkNode" as const,
    position: { x: topology.nodeIndex * (CARD_WIDTH + GAP), y: 0 },
    data: { topology },
  }));

  const tallest = Math.max(...topologies.map(estimateHeight), 160);
  const switchCard: SwitchNodeType = {
    id: "switch",
    type: "switch" as const,
    position: { x: 0, y: tallest + GAP },
    data: { name: SWITCH_NAME, topologies },
  };

  const edges: Edge[] = topologies.flatMap((topology) =>
    topology.cables.map((cable) => {
      const isFirstInGroup = cable.iface.nicIndices[0] === cable.nicIndex;
      return {
        id: cable.id,
        source: `node-${topology.nodeIndex}`,
        sourceHandle: `nic-${cable.nicIndex}`,
        target: "switch",
        targetHandle: cable.id,
        type: "smoothstep",
        // the card above already lists every bridge/vlan this interface
        // carries — repeating that whole list on the cable too (once per
        // bonded member) is what made this unreadable. the bond's name,
        // once per group, is the one thing worth a cable label: it's
        // short, and it names the grouping the color is already showing.
        label: isFirstInGroup ? cable.iface.bond?.name : undefined,
        style: { stroke: cable.iface.colorVar, strokeWidth: cable.iface.bond ? 2 : 1.5 },
      };
    }),
  );

  return { nodes: [...nodeCards, switchCard], edges };
}

function countDistinctVlans(topologies: NodeTopology[]): number {
  const vlans = new Set<number>();
  for (const t of topologies) {
    for (const iface of t.interfaces) {
      for (const tag of distinctVlanTags(iface)) vlans.add(tag);
    }
  }
  return vlans.size;
}

function countBonds(topologies: NodeTopology[]): number {
  return topologies.reduce((n, t) => n + t.interfaces.filter((i) => i.bond).length, 0);
}

function isNetworkNodeCard(node: NetworkNodeCardNode | SwitchNodeType): node is NetworkNodeCardNode {
  return node.type === "networkNode";
}

// the canvas itself, mounted inside a ReactFlowProvider so it can call the
// imperative fitView below — needed because a card's real height is
// unknowable until react flow has actually rendered and measured it, so
// the switch's position (set from a rough guess in layout()) gets
// corrected exactly once real measurements land, and the initial fitView
// (which only ever runs once, on mount) has to be re-triggered to match.
function NetworkCanvas({
  topologies,
  hydrated,
  hasSaved,
}: {
  topologies: NodeTopology[];
  hydrated: boolean;
  hasSaved: boolean;
}) {
  const initialLayout = useMemo(() => layout(topologies), [topologies]);
  const [flowNodes, setFlowNodes, onNodesChange] = useNodesState(initialLayout.nodes);
  const [flowEdges, setFlowEdges, onEdgesChange] = useEdgesState(initialLayout.edges);
  const { fitView } = useReactFlow();

  // topologies changed (different save loaded, homelab vlan edited, ...) —
  // rebuild from scratch rather than trying to diff the old layout.
  useEffect(() => {
    setFlowNodes(initialLayout.nodes);
    setFlowEdges(initialLayout.edges);
  }, [initialLayout, setFlowNodes, setFlowEdges]);

  // once every node card has been measured, slide the switch to sit right
  // below the tallest one — this is what actually keeps the cables
  // visible, regardless of how tall a card's bridge list grows.
  useEffect(() => {
    const cards = flowNodes.filter(isNetworkNodeCard);
    if (cards.length === 0 || !cards.every((n) => typeof n.measured?.height === "number")) return;
    const desiredY = Math.max(...cards.map((n) => n.position.y + (n.measured?.height ?? 0))) + GAP;
    const switchNode = flowNodes.find((n) => n.id === "switch");
    if (!switchNode || switchNode.position.y === desiredY) return;
    setFlowNodes((nodes) => nodes.map((n) => (n.id === "switch" ? { ...n, position: { ...n.position, y: desiredY } } : n)));
    // let the new position actually apply to the dom before refitting —
    // fitView only runs once on mount otherwise, against the old guess.
    requestAnimationFrame(() => fitView({ padding: 0.18 }));
  }, [flowNodes, setFlowNodes, fitView]);

  return (
    <div className="pc-canvas pc-canvas--tall">
      {hydrated && !hasSaved && (
        <div className="pc-canvas__empty">
          <p className="body text-ink-muted">nothing saved to preview yet.</p>
          <Link href="/setup" className="pc-btn pc-btn--primary">
            <span className="pc-btn__bracket">[</span>
            start at step 1
            <span className="pc-btn__bracket">]</span>
          </Link>
        </div>
      )}
      {hasSaved && (
        <ReactFlow
          nodes={flowNodes}
          edges={flowEdges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          nodeTypes={nodeTypes}
          fitView
          fitViewOptions={{ padding: 0.18 }}
          minZoom={0.15}
          maxZoom={1.6}
          nodesConnectable={false}
          edgesFocusable={false}
          zoomOnScroll={false}
          preventScrolling={false}
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
          <Controls showInteractive={false} />
          {flowNodes.length > 6 && <MiniMap pannable zoomable />}
        </ReactFlow>
      )}
    </div>
  );
}

export default function NetworkPreview() {
  const [saved, setSaved] = useState<PersistedState | null>(null);
  const [hydrated, setHydrated] = useState(false);

  // reading localStorage during render would desync the client from the
  // server html, so it has to happen post-mount — same trade the wizard
  // itself makes (and the hardware preview repeats).
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    setSaved(loadPersistedState());
    setHydrated(true);
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

  const homelabVlan = saved?.homelabVlan ? Number(saved.homelabVlan) || null : null;
  const topologies = useMemo(
    () => (saved ? buildClusterTopology(saved.nodes, homelabVlan) : []),
    [saved, homelabVlan],
  );
  const totalCables = topologies.reduce((n, t) => n + t.cables.length, 0);

  return (
    <div className="pc-root flex min-h-full flex-col">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
          <Link href="/" className="flex items-center gap-2.5">
            <span className="code flex h-7 w-7 items-center justify-center bg-accent font-bold text-on-accent">
              {">"}
            </span>
            <span className="text-[15px] font-semibold tracking-tight">
              proxmox<span className="text-accent">.computer</span>
            </span>
          </Link>
          <Link href="/setup" className="meta text-ink-muted transition-colors hover:text-ink">
            ← back to setup
          </Link>
        </div>
      </header>

      <main className="flex-1 px-6 py-12">
        <div className="mx-auto flex max-w-6xl flex-col" style={{ gap: "var(--space-5)" }}>
          <div>
            <p className="meta pc-stepflow__meta"># step 2 of 5 — preview</p>
            <h2 className="h2 pc-stepflow__title">network</h2>
            <p className="body pc-stepflow__intro">
              Every nic, cabled to {SWITCH_NAME}. Matching colors mean the same
              bond — every member still gets its own cable. Each node card
              lists the bridges and vlans its interfaces actually carry.
            </p>
          </div>

          {hydrated && saved && topologies.length > 0 && (
            <div className="pc-summary">
              <div className="pc-summary__cell">
                <span className="label pc-summary__key">nodes</span>
                <span className="code pc-summary__val">{topologies.length}</span>
              </div>
              <div className="pc-summary__cell">
                <span className="label pc-summary__key">physical links</span>
                <span className="code pc-summary__val">{totalCables}</span>
              </div>
              <div className="pc-summary__cell">
                <span className="label pc-summary__key">bonds</span>
                <span className="code pc-summary__val">{countBonds(topologies) || "—"}</span>
              </div>
              <div className="pc-summary__cell">
                <span className="label pc-summary__key">vlans in use</span>
                <span className="code pc-summary__val">{countDistinctVlans(topologies) || "—"}</span>
              </div>
            </div>
          )}

          <ReactFlowProvider>
            <NetworkCanvas topologies={topologies} hydrated={hydrated} hasSaved={!!saved} />
          </ReactFlowProvider>

          <div className="pc-stepflow__nav">
            <Link href="/setup" className="pc-btn pc-btn--ghost">
              ← back to network
            </Link>
            <button type="button" className="pc-btn" disabled title="steps 3–5 aren't built yet">
              <span className="pc-btn__bracket">[</span>
              next
              <span className="pc-btn__bracket">]</span>
            </button>
          </div>
        </div>
      </main>
    </div>
  );
}
