"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  useNodesInitialized,
  useReactFlow,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { problemsUpTo } from "../../step-checks";
import { ProblemList } from "../../problem-list";
import { loadPersistedState, persistCurrentStep, type NodeInfo, type PersistedState } from "../../wizard-state";
import { NodeCard, type NodeCardNode } from "./node-card";
import { gridColumns, gridRowYs } from "./grid";

const nodeTypes = { nodeCard: NodeCard };

const CARD_WIDTH = 300;
const GAP = 56;

// react flow needs a position before it can measure the real card, so
// the first frame is laid out from an estimate. it's corrected as soon as
// the cards are measured (see HardwareCanvas) — the estimate alone let a
// taller-than-expected card run under the row below it.
function estimateHeight(node: NodeInfo): number {
  return 150 + (1 + node.additionalDisks.length) * 42 + node.nics.length * 26;
}

function diskSizes(node: NodeInfo): number[] {
  return [Number(node.bootDiskSizeGb) || 0, ...node.additionalDisks.map((d) => Number(d.sizeGb) || 0)];
}

function layoutNodes(nodes: NodeInfo[]): NodeCardNode[] {
  const cols = gridColumns(nodes.length);
  const ys = gridRowYs(nodes.map(estimateHeight), cols, GAP);
  const maxDiskGb = Math.max(1, ...nodes.flatMap(diskSizes));
  return nodes.map((node, i) => ({
    id: `node-${i}`,
    type: "nodeCard" as const,
    position: { x: (i % cols) * (CARD_WIDTH + GAP), y: ys[i] },
    data: { node, index: i, maxDiskGb },
  }));
}

// the canvas, inside a ReactFlowProvider so it can re-place the rows once
// the real card heights are known
function HardwareCanvas({ nodes }: { nodes: NodeCardNode[] }) {
  const { setNodes, fitView } = useReactFlow();
  const initialized = useNodesInitialized();

  useEffect(() => {
    if (!initialized) return;
    setNodes((current) => {
      const ordered = [...current].sort((a, b) => Number(a.id.slice(5)) - Number(b.id.slice(5)));
      const ys = gridRowYs(
        ordered.map((n) => n.measured?.height ?? 0),
        gridColumns(ordered.length),
        GAP,
      );
      const yById = new Map(ordered.map((n, i) => [n.id, ys[i]]));
      return current.map((n) => ({ ...n, position: { ...n.position, y: yById.get(n.id) ?? n.position.y } }));
    });
    requestAnimationFrame(() => fitView({ padding: 0.18 }));
  }, [initialized, setNodes, fitView]);

  return (
    <ReactFlow
      // a new saved layout (different node count) needs a fresh flow —
      // defaultNodes is only read once
      key={nodes.length}
      defaultNodes={nodes}
      nodeTypes={nodeTypes}
      fitView
      fitViewOptions={{ padding: 0.18 }}
      minZoom={0.2}
      maxZoom={1.6}
      nodesConnectable={false}
      edgesFocusable={false}
      proOptions={{ hideAttribution: true }}
      // the canvas sits inside a normally-scrolling page, so the wheel has
      // to keep scrolling it — zoom is on the controls and on pinch instead.
      zoomOnScroll={false}
      preventScrolling={false}
    >
      <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
      <Controls showInteractive={false} />
    </ReactFlow>
  );
}

function sum(values: number[]): number {
  return values.reduce((total, v) => total + v, 0);
}

function formatTb(gb: number): string {
  if (gb <= 0) return "—";
  if (gb < 1000) return `${gb} gb`;
  const tb = gb / 1000;
  return `${Number.isInteger(tb) ? tb : tb.toFixed(1)} tb`;
}

export default function HardwarePreview() {
  const router = useRouter();
  // localStorage doesn't exist during ssr, so the saved config can only be
  // read post-mount — the canvas stays empty until then.
  const [saved, setSaved] = useState<PersistedState | null>(null);
  const [hydrated, setHydrated] = useState(false);

  // reading localStorage during render would desync the client from the
  // server html, so it has to happen post-mount — the same trade the
  // wizard itself makes, and what the set-state-in-effect rule's general
  // advice doesn't cover.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    setSaved(loadPersistedState());
    setHydrated(true);
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

  const flowNodes = useMemo(() => (saved ? layoutNodes(saved.nodes) : []), [saved]);
  const totals = useMemo(() => {
    const nodes = saved?.nodes ?? [];
    return {
      count: nodes.length,
      cores: sum(nodes.map((n) => (Number(n.cpuCount) || 0) * (Number(n.coresPerCpu) || 0))),
      ramGb: sum(nodes.map((n) => Number(n.ramGb) || 0)),
      storageGb: sum(nodes.flatMap(diskSizes)),
    };
  }, [saved]);

  // the same gate the wizard's preview button applies: this page can be
  // opened by url, so "next" can't assume the step behind it is complete
  const blocking = useMemo(() => (saved ? problemsUpTo("hardware", saved) : []), [saved]);

  function goToNetwork() {
    if (blocking.length > 0) return;
    persistCurrentStep("network");
    router.push("/setup");
  }

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
            <p className="meta pc-stepflow__meta"># step 1 of 5 — preview</p>
            <h2 className="h2 pc-stepflow__title">hardware</h2>
            <p className="body pc-stepflow__intro">
              Every node you described, drawn to scale. Check the disks and nics
              look right before moving on — step 2 wires these same nics into
              bridges and bonds.
            </p>
          </div>

          {hydrated && saved && totals.count > 0 && (
            <div className="pc-summary">
              <div className="pc-summary__cell">
                <span className="label pc-summary__key">nodes</span>
                <span className="code pc-summary__val">{totals.count}</span>
              </div>
              <div className="pc-summary__cell">
                <span className="label pc-summary__key">total cores</span>
                <span className="code pc-summary__val">{totals.cores || "—"}</span>
              </div>
              <div className="pc-summary__cell">
                <span className="label pc-summary__key">total memory</span>
                <span className="code pc-summary__val">{totals.ramGb ? `${totals.ramGb} gb` : "—"}</span>
              </div>
              <div className="pc-summary__cell">
                <span className="label pc-summary__key">raw storage</span>
                <span className="code pc-summary__val">{formatTb(totals.storageGb)}</span>
              </div>
            </div>
          )}

          <div className="pc-canvas">
            {hydrated && !saved && (
              <div className="pc-canvas__empty">
                <p className="body text-ink-muted">nothing saved to preview yet.</p>
                <Link href="/setup" className="pc-btn pc-btn--primary">
                  <span className="pc-btn__bracket">[</span>
                  start at step 1
                  <span className="pc-btn__bracket">]</span>
                </Link>
              </div>
            )}
            {saved && (
              // no minimap: the canvas is always fitted to every card, so
              // it only ever showed a gray box
              <ReactFlowProvider>
                <HardwareCanvas nodes={flowNodes} />
              </ReactFlowProvider>
            )}
          </div>

          {hydrated && saved && <ProblemList problems={blocking} step="hardware" />}
          <div className="pc-stepflow__nav">
            <Link href="/setup" className="pc-btn pc-btn--ghost">
              ← back to hardware
            </Link>
            <button
              type="button"
              className="pc-btn pc-btn--primary"
              onClick={goToNetwork}
              disabled={blocking.length > 0}
              title={blocking.length > 0 ? "fix the problems listed above first" : undefined}
            >
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
