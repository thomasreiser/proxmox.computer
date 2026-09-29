"use client";

import Link from "next/link";
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
import { loadPersistedState, type PersistedState } from "../../wizard-state";
import { backupTargetLabel, maxBackupsKept, retentionReach } from "../../backups";
import { problemsUpTo } from "../../step-checks";
import { ProblemList } from "../../problem-list";
import { answerFileName, buildAnswerToml, tomlDataUrl, DISK_PLACEHOLDER, type AnswerContext } from "../../answer-file";
import { buildBackupOverview, type BackupOverview } from "./plan";
import { BackupNodeCard } from "./node-card";
import { BackupTargetNode, OffsiteNode } from "./target-node";
import { GAP, layout } from "./cabling";

const nodeTypes = { backupNode: BackupNodeCard, backupTarget: BackupTargetNode, offsite: OffsiteNode };

function BackupCanvas({ overview, hydrated, hasSaved }: { overview: BackupOverview; hydrated: boolean; hasSaved: boolean }) {
  const { nodes, edges } = useMemo(() => layout(overview), [overview]);
  const { fitView, setNodes } = useReactFlow();
  const initialized = useNodesInitialized();

  // same as the storage preview: the target goes under the tallest
  // measured node card, the off-site copy under the target
  useEffect(() => {
    if (!initialized) return;
    setNodes((current) => {
      const cards = current.filter((n) => n.type === "backupNode");
      if (cards.length === 0) return current;
      let y = Math.max(...cards.map((n) => n.position.y + (n.measured?.height ?? 0))) + GAP;
      const yById = new Map<string, number>();
      for (const id of ["target", "offsite"]) {
        const card = current.find((n) => n.id === id);
        if (!card) continue;
        yById.set(id, y);
        y += (card.measured?.height ?? 0) + GAP;
      }
      return current.map((n) => (yById.has(n.id) ? { ...n, position: { ...n.position, y: yById.get(n.id)! } } : n));
    });
    requestAnimationFrame(() => fitView({ padding: 0.14 }));
  }, [initialized, setNodes, fitView]);

  return (
    <div className="pc-canvas pc-canvas--backups">
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

// Steps 1–4 are everything an install needs, so the answer files can be
// had here, before step 5 exists. Each is a data: link — no server, and
// nothing leaves the browser.
function AnswerFiles({ state, ctx, blocked }: { state: PersistedState; ctx: AnswerContext; blocked: boolean }) {
  const nodes = state.nodes;
  return (
    <section className="flex flex-col border border-border bg-surface-100 p-5" style={{ gap: "var(--space-3)" }}>
      <p className="label text-ink-muted">ready to install — or keep going</p>
      <p className="body-sm text-ink-muted">
        Steps 1–4 are everything an install needs, so you can stop here: take
        one <span className="code">answer.toml</span> per node, bake it into
        the proxmox iso, and each node installs itself, reachable at the
        address from step 2. Or carry on to step 5 and pick the software to
        run on the cluster — that step is optional, and you can add it later
        (it isn&apos;t built yet).
      </p>
      <p className="body-sm text-ink-muted">
        Before you build an iso, open its file and do the two things it
        can&apos;t: add a root password, and replace{" "}
        <span className="code">{DISK_PLACEHOLDER}</span> with the boot disk —
        the wizard never names a device, and the installer wipes whatever it
        points at, so until you change it the install stops instead of
        guessing. Every file also carries the whole setup: to change anything
        later, pick &quot;adjust a setup&quot; on the start page and hand it
        any one of them.
      </p>
      {blocked && <p className="body-sm pc-field__hint">fix the problems listed below first</p>}
      <div className="flex flex-wrap" style={{ gap: "var(--space-2)" }}>
        {nodes.map((node, i) => {
          const fileName = answerFileName(node);
          return blocked ? (
            <button key={i} type="button" className="pc-btn" disabled>
              <span className="pc-btn__bracket">[</span>
              {fileName}
              <span className="pc-btn__bracket">]</span>
            </button>
          ) : (
            <a key={i} className="pc-btn" href={tomlDataUrl(buildAnswerToml(node, ctx, state))} download={fileName}>
              <span className="pc-btn__bracket">[</span>
              {fileName}
              <span className="pc-btn__bracket">]</span>
            </a>
          );
        })}
      </div>
    </section>
  );
}

export default function BackupsPreview() {
  const [saved, setSaved] = useState<PersistedState | null>(null);
  const [hydrated, setHydrated] = useState(false);
  // the browser's own timezone and locale seed the answer files' keyboard,
  // country and timezone — read after mount, like the save, so the static
  // prerender never disagrees with the client
  const [browser, setBrowser] = useState({ timezone: "UTC", locale: "en-US" });

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    setSaved(loadPersistedState());
    setBrowser({
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
      locale: navigator.language || "en-US",
    });
    setHydrated(true);
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

  const overview = useMemo(
    () =>
      saved
        ? buildBackupOverview(saved.nodes, saved.backups, saved.hostnameSuffix)
        : { nodes: [], target: null, offsite: null },
    [saved],
  );
  const blocking = useMemo(() => (saved ? problemsUpTo("backups", saved) : []), [saved]);
  const shared = overview.nodes.filter((n) => !n.link.dedicated).length;

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
            <p className="meta pc-stepflow__meta"># step 4 of 5 — preview</p>
            <h2 className="h2 pc-stepflow__title">backups</h2>
            <p className="body pc-stepflow__intro">
              Where every node&apos;s backups go. A solid cyan cable runs over
              the link step 2 set aside for backups; a dashed one shares the
              management link. With an off-site copy, the dashed pink line
              below the target is pbs&apos;s sync job pulling the whole
              datastore somewhere else.
            </p>
          </div>

          {hydrated && saved && overview.nodes.length > 0 && (
            <div className="pc-summary">
              <div className="pc-summary__cell">
                <span className="label pc-summary__key">nodes</span>
                <span className="code pc-summary__val">{overview.nodes.length}</span>
              </div>
              <div className="pc-summary__cell">
                <span className="label pc-summary__key">target</span>
                <span className="code pc-summary__val pc-summary__val--sm">
                  {overview.target ? overview.target.subtitle : "none"}
                </span>
              </div>
              {overview.target && (
                <>
                  <div className="pc-summary__cell">
                    <span className="label pc-summary__key">kept per guest</span>
                    <span className="code pc-summary__val">{maxBackupsKept(saved.backups)}</span>
                  </div>
                  <div className="pc-summary__cell">
                    <span className="label pc-summary__key">reaches back</span>
                    <span className="code pc-summary__val pc-summary__val--sm">{retentionReach(saved.backups)}</span>
                  </div>
                  <div className="pc-summary__cell">
                    <span className="label pc-summary__key">off-site</span>
                    <span className="code pc-summary__val pc-summary__val--sm">{overview.offsite ? "yes" : "no"}</span>
                  </div>
                </>
              )}
            </div>
          )}

          <ReactFlowProvider>
            <BackupCanvas overview={overview} hydrated={hydrated} hasSaved={!!saved} />
          </ReactFlowProvider>

          {hydrated && saved && !overview.target && (
            <div className="pc-callout pc-callout--danger">
              <span className="code pc-callout__glyph">✗</span>
              <div className="pc-callout__body">
                <p className="body pc-callout__title">no backups — nothing to cable</p>
                <p className="body pc-callout__text text-ink-muted">
                  You chose &quot;{backupTargetLabel("none")}&quot;. Ceph and zfs
                  replication survive a failed node, not a deleted vm or a
                  bad upgrade. Go back to step 4 to pick a target.
                </p>
              </div>
            </div>
          )}

          {hydrated && saved && overview.target && shared > 0 && (
            <div className="pc-callout pc-callout--info">
              <span className="code pc-callout__glyph">#</span>
              <div className="pc-callout__body">
                <p className="body pc-callout__text text-ink-muted">
                  {shared === overview.nodes.length ? "Every node" : `${shared} of ${overview.nodes.length} nodes`}{" "}
                  send backups over the management link — the dashed cables. A
                  bridge with the &quot;backups&quot; purpose in step 2 moves them
                  off it.
                </p>
              </div>
            </div>
          )}

          {hydrated && saved && overview.nodes.length > 0 && (
            <AnswerFiles
              state={saved}
              ctx={{ hostnameSuffix: saved.hostnameSuffix, gateway: saved.gateway, dns: saved.dns, ...browser }}
              blocked={blocking.length > 0}
            />
          )}

          {hydrated && saved && <ProblemList problems={blocking} step="backups" />}
          <div className="pc-stepflow__nav">
            <Link href="/setup" className="pc-btn pc-btn--ghost">
              ← back to backups
            </Link>
            <button type="button" className="pc-btn" disabled title="step 5 isn't built yet">
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
