"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { type PersistedState } from "../../wizard-state";
import { loadPersistedState, persistCurrentStep } from "../../saved-state";
import { VaultGate } from "../../vault-gate";
import { problemsUpTo } from "../../step-checks";
import { ProblemList } from "../../problem-list";
import { nodeFqdn } from "../../answer-file";
import type { Hint } from "../../hints";
import {
  effectiveDiskStorage,
  effectiveGuestCpuType,
  guestVcpus,
  takesCloudInit,
  haQuorumHint,
  imageLabel,
  memoryHint,
  nodeLoads,
  storageHint,
  storageUse,
} from "../../software";
import { bootDiskMeter, cephMeter, localMeter, memoryMeter, zfsMeter } from "../../capacity";
import { MeterBar } from "../../meter-bar";
import { cephReachHint } from "../../kubernetes";

export default function SoftwarePreview() {
  return (
    <VaultGate mode="preview">
      <SoftwarePreviewPage />
    </VaultGate>
  );
}

function SoftwarePreviewPage() {
  const router = useRouter();
  const [saved, setSaved] = useState<PersistedState | null>(null);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    void loadPersistedState().then((state) => {
      setSaved(state);
      setHydrated(true);
    });
  }, []);

  const blocking = useMemo(() => (saved ? problemsUpTo("software", saved) : []), [saved]);
  const ctx = useMemo(
    () =>
      saved ? { nodes: saved.nodes, clusterStorage: saved.clusterStorage, storage: saved.storage, kubernetes: saved.software.kubernetes } : null,
    [saved],
  );
  const guests = useMemo(() => saved?.software.guests ?? [], [saved]);
  const loads = useMemo(() => (saved ? nodeLoads(guests, saved.nodes) : []), [saved, guests]);
  const uses = useMemo(() => (ctx ? storageUse(guests, ctx) : []), [ctx, guests]);
  const hints = saved
    ? [
        ...loads.map((l) => memoryHint(l, saved.nodes[l.nodeIndex].network.hostLabel || saved.nodes[l.nodeIndex].name)),
        ...uses.map(storageHint),
        haQuorumHint(guests, saved.nodes.length),
        ctx ? cephReachHint(guests, ctx) : null,
      ].filter((h): h is Hint => h !== null)
    : [];

  function goToInstall() {
    if (blocking.length > 0) return;
    void persistCurrentStep("install").then(() => router.push("/setup"));
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
        {/* nothing until the saved setup is decrypted — no flash of an empty preview */}
        {hydrated && (
          <div className="mx-auto flex max-w-6xl flex-col" style={{ gap: "var(--space-5)" }}>
            <div>
              <p className="meta pc-stepflow__meta"># step 7 of 8 — preview</p>
              <h2 className="h2 pc-stepflow__title">software</h2>
              <p className="body pc-stepflow__intro">
                Every vm and container, on the node it runs on — and where each
                node&apos;s memory and disks go: proxmox itself, ceph and the zfs
                cache take their share before the first guest starts. Ha guests
                move on their own when their node fails; the rest stay put.
              </p>
            </div>

            {!saved && (
              <div className="pc-canvas__empty">
                <p className="body text-ink-muted">nothing saved to preview yet.</p>
                <Link href="/setup" className="pc-btn pc-btn--primary">
                  <span className="pc-btn__bracket">[</span>
                  start at step 1
                  <span className="pc-btn__bracket">]</span>
                </Link>
              </div>
            )}

            {saved && ctx && (
              <>
                <div className="pc-summary">
                  <div className="pc-summary__cell">
                    <span className="label pc-summary__key">vms</span>
                    <span className="code pc-summary__val">{guests.filter((g) => g.kind === "vm").length || "—"}</span>
                  </div>
                  <div className="pc-summary__cell">
                    <span className="label pc-summary__key">containers</span>
                    <span className="code pc-summary__val">
                      {guests.filter((g) => g.kind === "container").length || "—"}
                    </span>
                  </div>
                  <div className="pc-summary__cell">
                    <span className="label pc-summary__key">highly available</span>
                    <span className="code pc-summary__val">{guests.filter((g) => g.ha).length || "—"}</span>
                  </div>
                  <div className="pc-summary__cell">
                    <span className="label pc-summary__key">memory</span>
                    <span className="code pc-summary__val pc-summary__val--sm">
                      {guests.reduce((s, g) => s + (Number(g.memoryGb) || 0), 0)} gib
                    </span>
                  </div>
                </div>

                {cephMeter(guests, ctx) && (
                  <section className="pc-guestnode">
                    <MeterBar meter={cephMeter(guests, ctx)!} unit="gb" />
                  </section>
                )}

                <div className="pc-guestgrid">
                  {loads.map((load) => {
                    const node = saved.nodes[load.nodeIndex];
                    const over = load.ramGb > 0 && load.memoryGb > load.ramGb;
                    return (
                      <section key={load.nodeIndex} className="pc-guestnode">
                        <div className="pc-guestnode__head">
                          <span className="code pc-guestnode__host">{nodeFqdn(node, saved.hostnameSuffix)}</span>
                          <span className={`meta ${over ? "pc-access__missing" : "text-ink-muted"}`}>
                            {load.memoryGb} / {load.ramGb || "?"} gib · {load.cores} / {load.threads || "?"} cores
                          </span>
                        </div>
                        <div className="pc-guestnode__meters">
                          <MeterBar meter={memoryMeter(load.nodeIndex, guests, ctx)} unit="gib" />
                          <MeterBar meter={bootDiskMeter(load.nodeIndex, guests, ctx)} unit="gb" />
                          {zfsMeter(load.nodeIndex, guests, ctx) && (
                            <MeterBar meter={zfsMeter(load.nodeIndex, guests, ctx)!} unit="gb" />
                          )}
                          {localMeter(load.nodeIndex, guests, ctx) && (
                            <MeterBar meter={localMeter(load.nodeIndex, guests, ctx)!} unit="gb" />
                          )}
                        </div>
                        {load.guests.length === 0 ? (
                          <p className="body-sm pc-field__hint">no guests</p>
                        ) : (
                          <ul className="pc-guestlist">
                            {load.guests.map((g) => (
                              <li key={g.id} className="pc-guestlist__item">
                                <div className="pc-guestlist__top">
                                  <span className="code pc-guestlist__name">
                                    {g.vmid} {g.name}
                                  </span>
                                  <span className="meta text-ink-muted">
                                    {g.kind === "vm" ? "vm" : "ct"}
                                    {g.ha ? " · ha" : ""}
                                  </span>
                                </div>
                                <p className="meta pc-guestlist__detail">
                                  {imageLabel(g.image)} · {guestVcpus(g)} cpu{guestVcpus(g) === 1 ? "" : "s"}
                                  {g.kind === "vm" ? ` (${effectiveGuestCpuType(g, ctx)})` : ""} · {g.memoryGb} gib
                                </p>
                                {g.disks.map((d) => (
                                  <p key={d.id} className="meta pc-guestlist__detail">
                                    {g.kind === "vm" ? d.bus : d.mountPath} · {d.sizeGb} gb on {effectiveDiskStorage(d, g, ctx).id}
                                  </p>
                                ))}
                                {g.nics.map((n) => (
                                  <p key={n.id} className="meta pc-guestlist__detail">
                                    {n.bridge}
                                    {n.vlanTag ? ` vlan ${n.vlanTag}` : ""}
                                    {g.kind === "container" || takesCloudInit(g) ? ` · ${n.ipMode === "static" ? n.ip : n.ipMode}` : ""}
                                  </p>
                                ))}
                              </li>
                            ))}
                          </ul>
                        )}
                      </section>
                    );
                  })}
                </div>

                {hints.map((hint, i) => (
                  <div key={i} className={`pc-callout pc-callout--${hint.tone}`}>
                    <span className="code pc-callout__glyph">{hint.glyph}</span>
                    <div className="pc-callout__body">
                      <p className="body-sm pc-callout__text">{hint.text}</p>
                    </div>
                  </div>
                ))}
              </>
            )}

            {saved && <ProblemList problems={blocking} step="software" />}
            <div className="pc-stepflow__nav">
              <Link href="/setup" className="pc-btn pc-btn--ghost">
                ← back to software
              </Link>
              <button
                type="button"
                className="pc-btn pc-btn--primary"
                onClick={goToInstall}
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
