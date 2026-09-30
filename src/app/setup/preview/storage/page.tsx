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
import { type PersistedState } from "../../wizard-state";
import { loadPersistedState, persistCurrentStep } from "../../saved-state";
import { VaultGate } from "../../vault-gate";
import { problemsUpTo } from "../../step-checks";
import { ProblemList } from "../../problem-list";
import { effectiveClusterStorage } from "../../derive";
import { buildStorageOverview, type StorageOverview } from "./plan";
import { StorageNodeCard } from "./node-card";
import { PoolNode } from "./pool-node";
import { GAP, layout } from "./cabling";

const nodeTypes = { storageNode: StorageNodeCard, pool: PoolNode };

function StorageCanvas({ overview, hydrated, hasSaved }: { overview: StorageOverview; hydrated: boolean; hasSaved: boolean }) {
  const { nodes, edges } = useMemo(() => layout(overview), [overview]);
  const { fitView, setNodes } = useReactFlow();
  const initialized = useNodesInitialized();

  // a card's height depends on how many disks the node has, so the pool's
  // position (and the initial fit) can only be right once react flow has
  // measured the cards for real.
  useEffect(() => {
    if (!initialized) return;
    setNodes((current) => {
      const cards = current.filter((n) => n.type === "storageNode");
      if (cards.length === 0) return current;
      // each pool card goes below the tallest node card, or below the pool
      // card above it — the ceph pool first, then zfs
      let y = Math.max(...cards.map((n) => n.position.y + (n.measured?.height ?? 0))) + GAP;
      const yById = new Map<string, number>();
      for (const id of ["pool-ceph", "pool-zfs"]) {
        const pool = current.find((n) => n.id === id);
        if (!pool) continue;
        yById.set(id, y);
        y += (pool.measured?.height ?? 0) + GAP;
      }
      return current.map((n) => (yById.has(n.id) ? { ...n, position: { ...n.position, y: yById.get(n.id)! } } : n));
    });
    requestAnimationFrame(() => fitView({ padding: 0.14 }));
  }, [initialized, setNodes, fitView]);

  return (
    <div className="pc-canvas pc-canvas--storage">
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
          key={JSON.stringify(nodes.map((n) => n.id))}
          defaultNodes={nodes}
          defaultEdges={edges}
          nodeTypes={nodeTypes}
          fitView
          fitViewOptions={{ padding: 0.14 }}
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
        </ReactFlow>
      )}
    </div>
  );
}

export default function StoragePreview() {
  return (
    <VaultGate mode="preview">
      <StoragePreviewPage />
    </VaultGate>
  );
}

function StoragePreviewPage() {
  const router = useRouter();
  const [saved, setSaved] = useState<PersistedState | null>(null);
  const [hydrated, setHydrated] = useState(false);

   
  useEffect(() => {
    void loadPersistedState().then((state) => {
      setSaved(state);
      setHydrated(true);
    });
  }, []);
   

  const overview = useMemo(
    () =>
      saved
        ? buildStorageOverview(
            saved.nodes,
            saved.storage,
            effectiveClusterStorage(saved.clusterStorage, saved.nodes),
            saved.hostnameSuffix,
          )
        : { nodes: [], ceph: null, zfs: null, localKindLabel: "zfs", localName: "" },
    [saved],
  );

  // same gate as the wizard's own "preview": nothing past a step with problems
  const blocking = useMemo(() => (saved ? problemsUpTo("storage", saved) : []), [saved]);
  const goToBackups = () => {
    if (blocking.length > 0) return;
    // the hand-off is saved (encrypted) before the wizard reads it back
    void persistCurrentStep("backups").then(() => router.push("/setup"));
  };

  const totalOsds = overview.nodes.reduce((n, v) => n + v.cephDisks.length, 0);
  const totalZfsDisks = overview.nodes.reduce((n, v) => n + v.zfsDisks.length, 0);
  const totalLocalDisks = overview.nodes.reduce((n, v) => n + v.localDisks.length, 0);
  const totalUnused = overview.nodes.reduce(
    (n, v) => n + v.disks.filter((d) => d.role === "unused").length,
    0,
  );

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
        {/* nothing until the saved setup is decrypted — no flash of an empty preview */}
        {hydrated && (
          <div className="mx-auto flex max-w-6xl flex-col" style={{ gap: "var(--space-5)" }}>
            <div>
              <p className="meta pc-stepflow__meta"># step 4 of 8 — preview</p>
              <h2 className="h2 pc-stepflow__title">storage</h2>
              <p className="body pc-stepflow__intro">
                Every disk in the cluster, colored by what it does. Green disks
                are ceph osds, cabled into the shared pool below; purple ones
                build each node&apos;s own zfs pool, and the dashed purple lines
                are its replication to the others (passing behind the ceph
                pool when both are on); blue ones stay local. The boot disk is never
                assigned — the proxmox installer already owns it.
              </p>
            </div>

            {hydrated && saved && overview.nodes.length > 0 && (
              <div className="pc-summary">
                <div className="pc-summary__cell">
                  <span className="label pc-summary__key">nodes</span>
                  <span className="code pc-summary__val">{overview.nodes.length}</span>
                </div>
                {overview.ceph && (
                  <div className="pc-summary__cell">
                    <span className="label pc-summary__key">osds</span>
                    <span className="code pc-summary__val">{totalOsds || "—"}</span>
                  </div>
                )}
                {overview.zfs && (
                  <div className="pc-summary__cell">
                    <span className="label pc-summary__key">zfs disks</span>
                    <span className="code pc-summary__val">{totalZfsDisks || "—"}</span>
                  </div>
                )}
                <div className="pc-summary__cell">
                  <span className="label pc-summary__key">local disks</span>
                  <span className="code pc-summary__val">{totalLocalDisks || "—"}</span>
                </div>
                <div className="pc-summary__cell">
                  <span className="label pc-summary__key">unused</span>
                  <span className="code pc-summary__val">{totalUnused || "—"}</span>
                </div>
                {overview.ceph && (
                  <div className="pc-summary__cell">
                    <span className="label pc-summary__key">ceph usable</span>
                    <span className="code pc-summary__val pc-summary__val--sm">{overview.ceph.usable}</span>
                  </div>
                )}
                {overview.zfs && (
                  <div className="pc-summary__cell">
                    <span className="label pc-summary__key">zfs usable</span>
                    <span className="code pc-summary__val pc-summary__val--sm">{overview.zfs.usable}</span>
                  </div>
                )}
              </div>
            )}

            <ReactFlowProvider>
              <StorageCanvas overview={overview} hydrated={hydrated} hasSaved={!!saved} />
            </ReactFlowProvider>

            {hydrated && saved && !overview.ceph && !overview.zfs && (
              <div className="pc-callout pc-callout--info">
                <span className="code pc-callout__glyph">#</span>
                <div className="pc-callout__body">
                  <p className="body pc-callout__title">no shared pool — every node is an island</p>
                  <p className="body pc-callout__text text-ink-muted">
                    Neither ceph nor zfs replication is on, so nothing is drawn
                    below the nodes. A guest lives on whichever node holds its
                    disk and doesn&apos;t survive that node going down. Go back
                    to step 3 to tick one.
                  </p>
                </div>
              </div>
            )}

            {/* same rule as the wizard: no local disks, no local pool */}
            {hydrated && saved && totalLocalDisks > 0 && (
              <div className="pc-summary">
                <div className="pc-summary__cell">
                  <span className="label pc-summary__key">local storage</span>
                  <span className="code pc-summary__val pc-summary__val--sm">
                    {overview.localName || "—"} ({overview.localKindLabel})
                  </span>
                </div>
              </div>
            )}

            {hydrated && saved && <ProblemList problems={blocking} step="storage" />}
            <div className="pc-stepflow__nav">
              <Link href="/setup" className="pc-btn pc-btn--ghost">
                ← back to storage
              </Link>
              <button
                type="button"
                className="pc-btn pc-btn--primary"
                onClick={goToBackups}
                disabled={blocking.length > 0}
                title={blocking.length > 0 ? "fix the problems listed above first" : undefined}
              >
                <span className="pc-btn__bracket">[</span>
                next
                <span className="pc-btn__bracket">]</span>
              </button>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
