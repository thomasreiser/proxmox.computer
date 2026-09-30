// Where each node's memory and each pool's space goes, as meters: what
// proxmox itself, ceph and zfs take before a single guest runs, what the
// guests take, and what's left. Estimates from each project's documented
// defaults — the point is the shape (and the overcommit), not the last gib.

import { effectiveClusterStorage } from "./derive";
import { K8S_VOLUME_POOL, cephVolumeGb, diskGbOn, effectiveGuestNode, type GuestContext, type GuestPlan } from "./software";
import { bootDiskLayout, disksWithRole, effectiveCephPlan, effectiveRaidLevel, minPoolMembers, totalGb, withEffectiveDiskRoles, zfsUsableGb } from "./storage";
import { enabledStorageModes, type NodeInfo } from "./wizard-state";

/** what a segment is — and so its color (see .pc-meter__seg--*) */
export type MeterTone = "host" | "ceph" | "zfs" | "guests";

export interface MeterSegment {
  key: string;
  label: string;
  gb: number;
  tone: MeterTone;
}

export interface Meter {
  title: string;
  // what there is: ram, or a pool's raw space
  totalGb: number;
  segments: MeterSegment[];
  // total minus the segments — 0 when overcommitted
  freeGb: number;
  // how far the segments go past the total — 0 when they fit
  overGb: number;
  // a line to stay under, as a fraction of the total — ceph and zfs slow
  // down (and ceph stops writing) as a pool fills
  marker: { at: number; label: string } | null;
  note: string;
  // the same in what a guest's disk actually costs: ceph stores each disk
  // once per replica and zfs keeps redundancy, so "5 tb raw free" can be
  // 1.7 tb of room — what step 7's compact meters show
  room: { freeGb: number; totalGb: number; overGb: number };
}

function meter(
  title: string,
  totalGb: number,
  segments: MeterSegment[],
  note: string,
  marker: Meter["marker"] = null,
  room?: { totalGb: number; usedGb: number },
): Meter {
  const used = segments.reduce((s, seg) => s + seg.gb, 0);
  const freeGb = Math.max(0, totalGb - used);
  const overGb = Math.max(0, used - totalGb);
  return {
    title,
    totalGb,
    segments: segments.filter((s) => s.gb > 0),
    freeGb,
    overGb,
    marker,
    note,
    room: room
      ? {
          totalGb: room.totalGb,
          freeGb: Math.max(0, room.totalGb - room.usedGb),
          overGb: Math.max(0, room.usedGb - room.totalGb),
        }
      : { totalGb, freeGb, overGb },
  };
}

// ── memory ───────────────────────────────────────────────────────────────

// proxmox's own floor for the host: os, pve services, corosync
export const HOST_MEMORY_GB = 2;
// ceph's osd_memory_target default, per osd
export const CEPH_OSD_MEMORY_GB = 4;
// a monitor + manager pair; proxmox's own advice is three monitors
export const CEPH_MON_MEMORY_GB = 1;

/**
 * The zfs cache (arc): proxmox's installer caps it at 10% of ram, at most
 * 16 gib. It gives memory back under pressure — but not instantly, which
 * is why it's counted rather than treated as free.
 */
export function zfsArcGb(ramGb: number): number {
  return Math.min(ramGb * 0.1, 16);
}

function hasZfs(node: NodeInfo, ctx: GuestContext, zfsActive: boolean): boolean {
  const zfsPool = zfsActive && disksWithRole(node, "zfs").length > 0;
  const localZfs = ctx.storage.local.kind === "zfs" && disksWithRole(node, "local").length > 0;
  return zfsPool || localZfs;
}

export function memoryMeter(nodeIndex: number, guests: GuestPlan[], ctx: GuestContext): Meter {
  const active = effectiveClusterStorage(ctx.clusterStorage, ctx.nodes);
  const planNodes = withEffectiveDiskRoles(ctx.nodes, enabledStorageModes(active));
  const node = planNodes[nodeIndex];
  const ramGb = Number(node.ramGb) || 0;
  const osds = active.ceph ? disksWithRole(node, "ceph").length : 0;
  const cephGb = active.ceph ? osds * CEPH_OSD_MEMORY_GB + (nodeIndex < 3 ? CEPH_MON_MEMORY_GB : 0) : 0;
  const arcGb = hasZfs(node, ctx, active.zfs) ? zfsArcGb(ramGb) : 0;
  const guestGb = guests
    .filter((g) => effectiveGuestNode(g, ctx.nodes.length) === nodeIndex)
    .reduce((s, g) => s + (Number(g.memoryGb) || 0), 0);
  return meter(
    "memory",
    ramGb,
    [
      { key: "host", label: "proxmox", gb: HOST_MEMORY_GB, tone: "host" },
      { key: "ceph", label: `ceph — ${osds} osd${osds === 1 ? "" : "s"}${nodeIndex < 3 ? " + monitor" : ""}`, gb: cephGb, tone: "ceph" },
      { key: "zfs", label: "zfs cache (arc)", gb: arcGb, tone: "zfs" },
      { key: "guests", label: "guests", gb: guestGb, tone: "guests" },
    ],
    "estimated: proxmox ~2 gib, ceph 4 gib per osd, zfs cache up to 10% of ram",
  );
}

// ── disks ────────────────────────────────────────────────────────────────


export function bootDiskMeter(nodeIndex: number, guests: GuestPlan[], ctx: GuestContext): Meter {
  const node = ctx.nodes[nodeIndex];
  const bootGb = Number(node.bootDiskSizeGb) || 0;
  const layout = bootDiskLayout(bootGb, Number(node.ramGb) || 0);
  const here = guests.filter((g) => effectiveGuestNode(g, ctx.nodes.length) === nodeIndex);
  return meter(
    "boot disk",
    bootGb,
    [
      { key: "root", label: "proxmox — root, isos, templates", gb: layout.root, tone: "host" },
      { key: "swap", label: "swap", gb: layout.swap, tone: "host" },
      { key: "reserved", label: "kept free by the installer", gb: layout.reserved, tone: "host" },
      { key: "guests", label: "guests on local-lvm", gb: diskGbOn(here, ctx, "local-lvm"), tone: "guests" },
    ],
    `estimated from the installer's defaults — local-lvm gets about ${Math.round(layout.localLvm)} gb`,
    null,
    // guests only ever get local-lvm, not the whole disk
    { totalGb: layout.localLvm, usedGb: diskGbOn(here, ctx, "local-lvm") },
  );
}

const KEEP_BELOW = { at: 0.8, label: "keep below 80%" };

/** the cluster's one ceph pool, over its raw osd space */
export function cephMeter(guests: GuestPlan[], ctx: GuestContext): Meter | null {
  const active = effectiveClusterStorage(ctx.clusterStorage, ctx.nodes);
  if (!active.ceph) return null;
  const planNodes = withEffectiveDiskRoles(ctx.nodes, enabledStorageModes(active));
  const raw = planNodes.reduce((s, n) => s + totalGb(disksWithRole(n, "ceph")), 0);
  const replicas = Number(effectiveCephPlan(ctx.storage.ceph, ctx.nodes.length).replicas) || 1;
  const disks = diskGbOn(guests, ctx, ctx.storage.ceph.poolName);
  // kubernetes' persistent volumes live in their own pool on the same osds
  const volumes = cephVolumeGb(guests, ctx);
  const data = disks + volumes;
  return meter(
    `ceph pool ${ctx.storage.ceph.poolName}`,
    raw,
    [
      { key: "guests", label: "guest disks", gb: disks, tone: "guests" },
      { key: "volumes", label: `kubernetes volumes (${K8S_VOLUME_POOL})`, gb: volumes, tone: "guests" },
      { key: "replicas", label: `their ${replicas - 1} extra ${replicas - 1 === 1 ? "copy" : "copies"}`, gb: data * (replicas - 1), tone: "ceph" },
    ],
    `every write is stored ${replicas}×, so ${Math.round(raw / replicas)} gb of it is usable — ceph stops writing at 95%`,
    KEEP_BELOW,
    { totalGb: raw / replicas, usedGb: data },
  );
}

/**
 * One node's zfs pool, over its raw disks. Replication keeps every
 * replicated guest on every node's pool, so each holds all of them.
 */
export function zfsMeter(nodeIndex: number, guests: GuestPlan[], ctx: GuestContext): Meter | null {
  const active = effectiveClusterStorage(ctx.clusterStorage, ctx.nodes);
  if (!active.zfs) return null;
  const planNodes = withEffectiveDiskRoles(ctx.nodes, enabledStorageModes(active));
  const disks = disksWithRole(planNodes[nodeIndex], "zfs");
  if (disks.length === 0) return null;
  const level = effectiveRaidLevel(ctx.storage.zfs.raidLevel, minPoolMembers(planNodes)) ?? ctx.storage.zfs.raidLevel;
  const raw = totalGb(disks);
  const usable = zfsUsableGb(disks, level);
  return meter(
    `zfs pool ${ctx.storage.zfs.poolName}`,
    raw,
    [
      { key: "redundancy", label: `${level} redundancy`, gb: raw - usable, tone: "zfs" },
      { key: "guests", label: "guest disks, all replicated", gb: diskGbOn(guests, ctx, ctx.storage.zfs.poolName), tone: "guests" },
    ],
    `${Math.round(usable)} gb usable — zfs slows down past 80% full`,
    { at: (raw - usable + usable * 0.8) / (raw || 1), label: "keep below 80%" },
    { totalGb: usable, usedGb: diskGbOn(guests, ctx, ctx.storage.zfs.poolName) },
  );
}

/** one node's local pool — its own disks, no copies elsewhere */
export function localMeter(nodeIndex: number, guests: GuestPlan[], ctx: GuestContext): Meter | null {
  const active = effectiveClusterStorage(ctx.clusterStorage, ctx.nodes);
  const planNodes = withEffectiveDiskRoles(ctx.nodes, enabledStorageModes(active));
  const disks = disksWithRole(planNodes[nodeIndex], "local");
  if (disks.length === 0) return null;
  const here = guests.filter((g) => effectiveGuestNode(g, ctx.nodes.length) === nodeIndex);
  return meter(
    `local pool ${ctx.storage.local.name}`,
    totalGb(disks),
    [{ key: "guests", label: "guest disks", gb: diskGbOn(here, ctx, ctx.storage.local.name), tone: "guests" }],
    `${ctx.storage.local.kind} on this node's own disks`,
  );
}
