// Step 7's kubernetes planner: how many control planes and workers, and
// how they spread across the proxmox nodes. The visitor picks the counts
// and the placement first; only then are the vms made — as ordinary guests
// they can edit afterwards, marked with their role.
//
// Kubernetes nodes are never ha (kubernetes moves pods off a failed node
// itself), so their own disks go on node-local storage — etcd wants that
// low write latency anyway — and they take the host's own cpu, since they
// never move to another. The data that has to survive a node goes
// in persistent volumes on ceph, through ceph-csi.

import type { Hint } from "./hints";
import { subnetDetails } from "./validation";
import {
  effectiveCephVolumes,
  effectiveGuestNode,
  isKubernetesNode,
  newGuest,
  nextGuestName,
  storageOptions,
  type GuestContext,
  type GuestPlan,
  type K8sRole,
} from "./software";
import { bridgeKey, isStorageLink } from "./wizard-state";

export type K8sPlacement = "shared" | "separate";
export type K8sNodeRole = Exclude<K8sRole, "">;

export interface K8sLayout {
  controlPlanes: number;
  workers: number;
  // shared: control planes and workers side by side on every node;
  // separate: control planes on nodes of their own, workers on the rest
  placement: K8sPlacement;
}

// etcd needs a majority: an even count tolerates no more failures than
// the odd one below it, so only odd counts are offered
export const CONTROL_PLANE_CHOICES = [1, 3, 5];

// from this many nodes the control planes get nodes of their own — three
// of them still leaves three nodes for workers
export const SEPARATE_FROM_NODES = 6;

// talos' recommended sizes: control planes are light, workers carry the pods
export const K8S_SIZES: Record<K8sNodeRole, { cores: string; memoryGb: string; diskGb: string }> = {
  "control-plane": { cores: "2", memoryGb: "4", diskGb: "32" },
  worker: { cores: "4", memoryGb: "8", diskGb: "64" },
};

const PREFIX: Record<K8sNodeRole, string> = { "control-plane": "k8s-cp", worker: "k8s-worker" };

/**
 * The proposal for this many nodes: up to five, one control plane and one
 * worker on each (three control planes from three nodes, one below);
 * from six, three control planes on nodes of their own and a worker on
 * every other node.
 */
export function defaultK8sLayout(nodeCount: number): K8sLayout {
  const n = Math.max(nodeCount, 1);
  if (n >= SEPARATE_FROM_NODES) return { controlPlanes: 3, workers: n - 3, placement: "separate" };
  return { controlPlanes: n >= 3 ? 3 : 1, workers: n, placement: "shared" };
}

/** worker counts to offer: none (pods on the control planes) up to three per node */
export function workerChoices(nodeCount: number): number[] {
  const max = Math.max(3 * Math.max(nodeCount, 1), 6);
  return Array.from({ length: max + 1 }, (_, i) => i);
}

/** separate needs a node for every control plane and at least one left for workers */
export function separatePossible(layout: K8sLayout, nodeCount: number): boolean {
  return layout.workers > 0 && nodeCount > layout.controlPlanes;
}

export function effectiveK8sPlacement(layout: K8sLayout, nodeCount: number): K8sPlacement {
  return layout.placement === "separate" && separatePossible(layout, nodeCount) ? "separate" : "shared";
}

export interface K8sSlot {
  role: K8sNodeRole;
  node: number;
}

/**
 * Where each vm goes: every vm to the least-loaded node it may use (the
 * lowest index on a tie), control planes first — so they land on distinct
 * nodes whenever there are enough.
 */
export function placeK8s(layout: K8sLayout, nodeCount: number): K8sSlot[] {
  const n = Math.max(nodeCount, 1);
  const all = Array.from({ length: n }, (_, i) => i);
  const separate = effectiveK8sPlacement(layout, n) === "separate";
  const cpNodes = separate ? all.slice(0, layout.controlPlanes) : all;
  const workerNodes = separate ? all.slice(layout.controlPlanes) : all;
  const load = new Array<number>(n).fill(0);
  const pick = (candidates: number[]) => {
    const best = candidates.reduce((a, b) => (load[b] < load[a] ? b : a));
    load[best]++;
    return best;
  };
  return [
    ...Array.from({ length: layout.controlPlanes }, () => ({ role: "control-plane" as const, node: pick(cpNodes) })),
    ...Array.from({ length: layout.workers }, () => ({ role: "worker" as const, node: pick(workerNodes) })),
  ];
}

/** per node, how many of each role it runs */
export function slotsByNode(slots: K8sSlot[], nodeCount: number): { controlPlanes: number; workers: number }[] {
  return Array.from({ length: Math.max(nodeCount, 1) }, (_, i) => ({
    controlPlanes: slots.filter((s) => s.node === i && s.role === "control-plane").length,
    workers: slots.filter((s) => s.node === i && s.role === "worker").length,
  }));
}

/** the node-local storage a kubernetes vm's disk goes on — its node's last option is always local-lvm */
function localStorageOn(ctx: GuestContext, node: number): string {
  const options = storageOptions(ctx, node);
  return (options.find((o) => !o.shared) ?? options[options.length - 1]).id;
}

/** the vms for this layout, named and numbered after the guests that stay */
export function k8sGuests(layout: K8sLayout, others: GuestPlan[], ctx: GuestContext): GuestPlan[] {
  const added: GuestPlan[] = [];
  for (const { role, node } of placeK8s(layout, ctx.nodes.length)) {
    const all = [...others, ...added];
    const size = K8S_SIZES[role];
    const guest = newGuest("vm", all, ctx, {
      name: nextGuestName(PREFIX[role], all),
      image: "talos",
      tags: `k8s;${role}`,
      node: String(node),
      cores: size.cores,
      memoryGb: size.memoryGb,
      // talos needs all of its memory — the balloon would only get in its way
      ballooning: false,
      // never ha, so it never has to move to a different cpu: pass the
      // node's own through (read through effectiveGuestCpuType as usual)
      cpuType: "host",
      k8sRole: role,
    });
    guest.disks = guest.disks.map((d) => ({ ...d, sizeGb: size.diskGb, storage: localStorageOn(ctx, node) }));
    added.push(guest);
  }
  return added;
}

/** the guests with the kubernetes vms swapped for this layout's — everything else stays as it is */
export function applyK8sLayout(layout: K8sLayout, guests: GuestPlan[], ctx: GuestContext): GuestPlan[] {
  const others = guests.filter((g) => !isKubernetesNode(g));
  return [...others, ...k8sGuests(layout, others, ctx)];
}

/** the layout the planned vms have now — the planner reopens on it */
export function currentK8sLayout(guests: GuestPlan[], nodeCount: number): K8sLayout {
  const k8s = guests.filter(isKubernetesNode);
  if (k8s.length === 0) return defaultK8sLayout(nodeCount);
  const nodeOf = (g: GuestPlan) => effectiveGuestNode(g, nodeCount);
  const cps = k8s.filter((g) => g.k8sRole === "control-plane");
  const workers = k8s.filter((g) => g.k8sRole === "worker");
  const cpNodes = new Set(cps.map(nodeOf));
  const mixed = workers.some((g) => cpNodes.has(nodeOf(g)));
  const controlPlanes = CONTROL_PLANE_CHOICES.includes(cps.length) ? cps.length : defaultK8sLayout(nodeCount).controlPlanes;
  return { controlPlanes, workers: workers.length, placement: mixed || workers.length === 0 ? "shared" : "separate" };
}

// ── hints ────────────────────────────────────────────────────────────────

export function k8sLayoutHints(layout: K8sLayout, nodeCount: number): Hint[] {
  const hints: Hint[] = [];
  if (layout.controlPlanes > nodeCount) {
    hints.push({
      tone: "warning",
      glyph: "!",
      text: `${layout.controlPlanes} control planes on ${nodeCount} node${nodeCount === 1 ? "" : "s"}: some share a node, and losing that node takes etcd below its majority — the cluster stops taking changes. fewer control planes lose nothing here.`,
    });
  } else if (layout.controlPlanes === 1 && nodeCount >= 3) {
    hints.push({
      tone: "info",
      glyph: "#",
      text: "one control plane: if its node goes down, running pods carry on but nothing can be scheduled or changed until it's back. three survive losing one.",
    });
  }
  if (layout.workers === 0) {
    hints.push({
      tone: "info",
      glyph: "#",
      text: "no workers — pods run on the control planes. talos allows that with cluster.allowSchedulingOnControlPlanes.",
    });
  }
  return hints;
}

/**
 * ceph-csi talks to ceph's monitors directly, on ceph's own network. A
 * kubernetes vm reaches it only with a nic on the bridge that carries it
 * — and a dedicated ceph link has no bridge at all.
 */
export function cephReachHint(guests: GuestPlan[], ctx: GuestContext): Hint | null {
  if (!effectiveCephVolumes(guests, ctx)) return null;
  for (const guest of guests.filter(isKubernetesNode)) {
    const node = ctx.nodes[effectiveGuestNode(guest, ctx.nodes.length)];
    const entry = Object.entries(node.network.bridges).find(([, b]) => b.enabled && b.purposes.includes("ceph"));
    if (!entry) continue;
    const [key, bridge] = entry;
    const management = key === bridgeKey(node.network.managementInterfaceId, 0);
    const info = subnetDetails(management ? node.network.cidr : bridge.ip);
    const subnet = info ? `${info.network}/${info.prefix}` : "ceph's network";
    if (isStorageLink(node.network, key)) {
      return {
        tone: "warning",
        glyph: "!",
        text: `ceph runs on its own link (${subnet}) with no bridge, so the kubernetes vms can't join it — ceph-csi reaches the monitors only if your router routes between their network and ${subnet}.`,
      };
    }
    if (!guest.nics.some((n) => n.bridge === bridge.name)) {
      return {
        tone: "warning",
        glyph: "!",
        text: `${guest.name}: ceph-csi reaches the monitors on ${subnet}, which the vm has no nic on — add one on ${bridge.name}, or route between the two networks.`,
      };
    }
  }
  return null;
}
