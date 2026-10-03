"use client";

// Step 7's kubernetes cluster: the planner that asks for control planes,
// workers and their placement before any vm is made, and — once they're
// planned — where the cluster keeps its persistent volumes.

import { Check, CheckedTextField, Select } from "./form-fields";
import type { Hint } from "./hints";
import {
  CONTROL_PLANE_CHOICES,
  effectiveK8sPlacement,
  k8sLayoutHints,
  placeK8s,
  separatePossible,
  slotsByNode,
  workerChoices,
  type K8sLayout,
  type K8sPlacement,
} from "./kubernetes";
import {
  K8S_VOLUME_POOL,
  isKubernetesNode,
  validateVolumeGb,
  type GuestPlan,
  type KubernetesPlan,
} from "./software";
import type { NodeInfo } from "./wizard-state";

function Callout({ hint }: { hint: Hint }) {
  return (
    <div className={`pc-callout pc-callout--${hint.tone}`}>
      <span className="code pc-callout__glyph">{hint.glyph}</span>
      <div className="pc-callout__body">
        <p className="body-sm pc-callout__text">{hint.text}</p>
      </div>
    </div>
  );
}

const CONTROL_PLANE_LABELS: Record<number, string> = {
  1: "1 — no redundancy",
  3: "3 — survives losing one",
  5: "5 — survives losing two",
};

const PLACEMENT_LABELS: Record<K8sPlacement, string> = {
  shared: "side by side — control planes and workers share the nodes",
  separate: "separate — control planes on nodes of their own, workers on the rest",
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function KubernetesPlanner({
  layout,
  nodes,
  planned,
  onChange,
  onApply,
  onCancel,
}: {
  layout: K8sLayout;
  nodes: NodeInfo[];
  // kubernetes vms already in the plan — applying replaces them
  planned: number;
  onChange: (layout: K8sLayout) => void;
  onApply: () => void;
  onCancel: () => void;
}) {
  const n = nodes.length;
  const placement = effectiveK8sPlacement(layout, n);
  const perNode = slotsByNode(placeK8s(layout, n), n);
  const total = layout.controlPlanes + layout.workers;
  return (
    <div className="pc-roomleft" role="group" aria-label="kubernetes cluster">
      <p className="label text-ink-muted">kubernetes cluster</p>
      <p className="body-sm pc-field__hint">
        talos vms, never highly available — kubernetes moves pods off a failed node itself — so their disks go on
        node-local storage, they run on the host&apos;s own cpu type, and data that has to outlive a node goes in
        persistent volumes.
      </p>
      <Select
        id="k8s-control-planes"
        label="control planes"
        hint="they run etcd, which needs a majority to take changes"
        value={String(layout.controlPlanes)}
        options={CONTROL_PLANE_CHOICES.map((c) => ({ value: String(c), label: CONTROL_PLANE_LABELS[c] }))}
        onChange={(v) => onChange({ ...layout, controlPlanes: Number(v) })}
      />
      <Select
        id="k8s-workers"
        label="workers"
        hint="where your pods run"
        value={String(layout.workers)}
        options={workerChoices(n).map((w) => ({ value: String(w), label: w === 0 ? "0 — pods on the control planes" : String(w) }))}
        onChange={(v) => onChange({ ...layout, workers: Number(v) })}
      />
      <fieldset className="pc-radio-group" style={{ border: 0, margin: 0, padding: 0 }}>
        <legend className="label pc-radio-group__legend">placement</legend>
        {(["shared", "separate"] as const)
          .filter((p) => p === "shared" || separatePossible(layout, n))
          .map((p) => (
            <label key={p} className="pc-radio">
              <input type="radio" name="k8s-placement" checked={placement === p} onChange={() => onChange({ ...layout, placement: p })} />
              <span className="pc-radio__box" />
              <span className="code pc-radio__label">{PLACEMENT_LABELS[p]}</span>
            </label>
          ))}
        {!separatePossible(layout, n) && (
          <span className="body-sm pc-field__hint">
            separate nodes need more nodes than control planes, and at least one worker
          </span>
        )}
      </fieldset>
      <ul className="body-sm" aria-label="kubernetes placement">
        {nodes.map((node, i) => (
          <li key={i}>
            <span className="code">{node.network.hostLabel || node.name}</span>
            {": "}
            {[
              perNode[i].controlPlanes > 0 && plural(perNode[i].controlPlanes, "control plane"),
              perNode[i].workers > 0 && plural(perNode[i].workers, "worker"),
            ]
              .filter(Boolean)
              .join(" · ") || "nothing"}
          </li>
        ))}
      </ul>
      {k8sLayoutHints(layout, n).map((hint, i) => (
        <Callout key={i} hint={hint} />
      ))}
      <div className="flex flex-wrap" style={{ gap: "var(--space-2)" }}>
        <button type="button" className="pc-btn pc-btn--primary" onClick={onApply}>
          <span className="pc-btn__bracket">[</span>
          {planned > 0 ? `replace the ${plural(planned, "kubernetes vm")} with ${total}` : `add ${plural(total, "vm")}`}
          <span className="pc-btn__bracket">]</span>
        </button>
        <button type="button" className="pc-btn" onClick={onCancel}>
          <span className="pc-btn__bracket">[</span>
          cancel
          <span className="pc-btn__bracket">]</span>
        </button>
      </div>
    </div>
  );
}

export function KubernetesStorage({
  guests,
  cephBuilt,
  plan,
  onChange,
}: {
  guests: GuestPlan[];
  // step 4 builds ceph (in effect)
  cephBuilt: boolean;
  plan: KubernetesPlan;
  onChange: (patch: Partial<KubernetesPlan>) => void;
}) {
  const k8s = guests.filter(isKubernetesNode);
  if (k8s.length === 0) return null;
  const cps = k8s.filter((g) => g.k8sRole === "control-plane").length;
  return (
    <div className="pc-roomleft" role="group" aria-label="kubernetes storage">
      <p className="label text-ink-muted">
        kubernetes — {plural(cps, "control plane")}, {plural(k8s.length - cps, "worker")}
      </p>
      {cephBuilt ? (
        <>
          <Check
            label="persistent volumes on ceph"
            hint={`ceph-csi makes rbd volumes in a pool of their own, ${K8S_VOLUME_POOL}, on the same osds — they follow a pod to any node`}
            checked={plan.cephVolumes}
            onChange={(cephVolumes) => onChange({ cephVolumes })}
          />
          {plan.cephVolumes && (
            <CheckedTextField
              id="k8s-volume-gb"
              label="space for volumes (gb)"
              hint="set aside in ceph for them, before its replicas — counted in the room left"
              value={plan.volumeGb}
              validate={validateVolumeGb}
              onChange={(volumeGb) => onChange({ volumeGb })}
            />
          )}
        </>
      ) : (
        <p className="body-sm pc-field__hint">
          no ceph in step 4 — persistent volumes need storage inside kubernetes, such as longhorn or local-path on each vm.
        </p>
      )}
    </div>
  );
}
