// Step 4's logic: which disks can play which role, what the resulting
// pools actually hold, and the advice worth giving before someone builds
// a layout they'll have to destroy to change.
//
// Capacity here is deliberately raw — the size of the vdev or pool as zfs
// and ceph report it, before compression wins anything back or the full
// ratio takes some away. Quoting a "real" number would mean guessing at a
// workload this wizard hasn't asked about.

import {
  type AdditionalDisk,
  type CephPlan,
  type DiskRole,
  type DiskType,
  type LocalStorageKind,
  type NodeInfo,
  type StorageMode,
  type ZfsRaidLevel,
} from "./wizard-state";
import type { Hint } from "./hints";

export interface DiskRoleInfo {
  value: DiskRole;
  label: string;
  hint: string;
}

const ROLE_INFO: Record<DiskRole, DiskRoleInfo> = {
  ceph: {
    value: "ceph",
    label: "ceph osd",
    hint: "handed to ceph whole — it becomes one osd, and its contents are replicated to the other nodes",
  },
  zfs: {
    value: "zfs",
    label: "zfs pool member",
    hint: "joins this node's zfs pool, which is replicated to the other nodes on a schedule",
  },
  local: {
    value: "local",
    label: "local storage",
    hint: "this node's own vm/ct storage — fast, but a guest on it doesn't survive the node going down",
  },
  unused: {
    value: "unused",
    label: "leave unused",
    hint: "declared in step 2 but left out of every pool — proxmox won't touch it",
  },
};

/**
 * A node's only spare disk, with exactly one cluster storage mode on,
 * has to go to that mode — left out, the node would contribute nothing to
 * the storage chosen in step 3. With both modes on every node has two
 * disks or more (see effectiveClusterStorage), so nothing is forced.
 */
export function soleDiskMode(modes: StorageMode[], diskCount: number): StorageMode | null {
  return modes.length === 1 && diskCount === 1 ? modes[0] : null;
}

/**
 * The roles a disk can take: one per enabled cluster storage mode, then
 * local and unused — or just the one mode for a sole disk.
 */
export function diskRoleOptions(modes: StorageMode[], diskCount = Infinity): DiskRoleInfo[] {
  const sole = soleDiskMode(modes, diskCount);
  if (sole) return [ROLE_INFO[sole]];
  return [...modes.map((m) => ROLE_INFO[m]), ROLE_INFO.local, ROLE_INFO.unused];
}

export function diskRoleLabel(role: DiskRole): string {
  return ROLE_INFO[role].label;
}

/**
 * The role a disk actually plays: the visitor's choice when it's one of
 * the roles on offer, otherwise the first enabled cluster storage mode
 * (ceph before zfs), otherwise local storage.
 *
 * Read-side only — the choice is kept, so re-enabling zfs brings a disk
 * marked "zfs" straight back. This is also what makes a new disk (role
 * "") land in the cluster storage: someone adding a disk beyond boot is
 * almost always adding it for the storage they picked.
 */
export function effectiveDiskRole(disk: AdditionalDisk, modes: StorageMode[], diskCount: number): DiskRole {
  const offered = diskRoleOptions(modes, diskCount).map((o) => o.value);
  if (disk.role && offered.includes(disk.role)) return disk.role;
  return modes[0] ?? "local";
}

/**
 * Every node with its disks' roles replaced by the effective ones. Every
 * role-based rule below (capacity, pool membership, layout choices) reads
 * this view, so they all agree on what each disk is doing.
 */
export function withEffectiveDiskRoles(nodes: NodeInfo[], modes: StorageMode[]): NodeInfo[] {
  return nodes.map((node) => ({
    ...node,
    additionalDisks: node.additionalDisks.map((disk) => ({
      ...disk,
      role: effectiveDiskRole(disk, modes, node.additionalDisks.length),
    })),
  }));
}

/**
 * Nodes that couldn't build a redundant zfs pool: fewer than two disks
 * left for zfs means the only possible layout is a one-disk stripe, so one
 * failed disk loses that node's whole pool. Replication still has a copy
 * on the other nodes, but only as of its last run. `reserved` is how many
 * disks per node something else claims first — 1 when ceph is on too.
 */
export function nodesWithoutZfsRedundancy(nodes: NodeInfo[], reserved = 0): NodeInfo[] {
  return nodes.filter((n) => n.additionalDisks.length - reserved < 2);
}

export function hasLocalDisks(nodes: NodeInfo[]): boolean {
  return nodes.some((n) => disksWithRole(n, "local").length > 0);
}

export const ZFS_RAID_OPTIONS: { value: ZfsRaidLevel; label: string; minDisks: number; hint: string }[] = [
  {
    value: "mirror",
    label: "mirror",
    minDisks: 2,
    hint: "every disk holds the same data — survives losing all but one, and rebuilds fastest",
  },
  {
    value: "raidz1",
    label: "raidz1",
    minDisks: 3,
    hint: "one disk's worth of parity — survives one failure, and more capacity than a mirror",
  },
  {
    value: "raidz2",
    label: "raidz2",
    minDisks: 4,
    hint: "two disks' worth of parity — survives two failures, including a second one during a rebuild",
  },
  {
    value: "stripe",
    label: "stripe",
    minDisks: 1,
    hint: "no redundancy at all — losing any one disk loses the whole pool",
  },
];

export function zfsRaidInfo(level: ZfsRaidLevel) {
  return ZFS_RAID_OPTIONS.find((o) => o.value === level) ?? ZFS_RAID_OPTIONS[0];
}

export const LOCAL_STORAGE_OPTIONS: { value: LocalStorageKind; label: string; hint: string }[] = [
  {
    value: "zfs",
    label: "zfs",
    hint: "snapshots, checksums and thin provisioning — the default choice unless you're short on ram",
  },
  {
    value: "lvm-thin",
    label: "lvm-thin",
    hint: "thin provisioning and snapshots with a much smaller memory footprint, but no checksums",
  },
  {
    value: "directory",
    label: "directory",
    hint: "a plain filesystem holding disk images as files — simplest, and the only one that takes qcow2",
  },
];

export function disksWithRole(node: NodeInfo, role: DiskRole): AdditionalDisk[] {
  return node.additionalDisks.filter((d) => d.role === role);
}

export function diskSizeGb(disk: AdditionalDisk): number {
  return Number(disk.sizeGb) || 0;
}

export function totalGb(disks: AdditionalDisk[]): number {
  return disks.reduce((sum, d) => sum + diskSizeGb(d), 0);
}

/**
 * Usable capacity of one vdev, in GB.
 *
 * zfs sizes a vdev by its *smallest* member, so an odd disk out doesn't
 * add what its label says — which is the single most surprising thing
 * about mixing sizes, and why the mixed-size hint below exists.
 */
export function zfsUsableGb(disks: AdditionalDisk[], level: ZfsRaidLevel): number {
  const sizes = disks.map(diskSizeGb).filter((n) => n > 0);
  if (sizes.length === 0) return 0;
  if (level === "stripe") return sizes.reduce((a, b) => a + b, 0);
  const smallest = Math.min(...sizes);
  if (level === "mirror") return smallest;
  const parity = level === "raidz2" ? 2 : 1;
  return Math.max(0, sizes.length - parity) * smallest;
}

/**
 * Usable capacity of the ceph pool, in GB: every osd in the cluster
 * divided by the replica count. With the default host failure domain this
 * is also bounded by what would still fit if a whole node went away, but
 * that's a resilience question rather than a capacity one — cephFullNodeLossGb
 * below answers it separately rather than quietly deflating this number.
 */
export function cephUsableGb(nodes: NodeInfo[], replicas: number): number {
  if (replicas <= 0) return 0;
  const raw = nodes.reduce((sum, n) => sum + totalGb(disksWithRole(n, "ceph")), 0);
  return raw / replicas;
}

/** raw osd capacity left once the largest single node is gone */
export function cephRawWithoutLargestNodeGb(nodes: NodeInfo[]): number {
  const perNode = nodes.map((n) => totalGb(disksWithRole(n, "ceph")));
  const raw = perNode.reduce((a, b) => a + b, 0);
  return raw - Math.max(0, ...perNode);
}

/**
 * Sizes are entered as the gb printed on the drive, which is decimal
 * (a "1000 gb" nvme is 10^12 bytes), so the step up to tb is ×1000 too.
 * Dividing by 1024 here once turned 3000 gb into "2.9 tb" — a tib figure
 * under a tb label, next to gb figures that weren't converted at all.
 */
export function formatGb(gb: number): string {
  if (gb <= 0) return "—";
  if (gb >= 1000) return `${(gb / 1000).toFixed(gb >= 10000 ? 0 : 1)} tb`;
  return `${Math.round(gb)} gb`;
}

/** how many nodes contribute at least one disk to the given mode */
export function nodesContributing(nodes: NodeInfo[], mode: StorageMode): number {
  return nodes.filter((n) => disksWithRole(n, mode).length > 0).length;
}

// ── hints ────────────────────────────────────────────────────────────────

/** an enabled storage mode needs disks assigned to it, on every node */
export function poolMembershipHint(nodes: NodeInfo[], mode: StorageMode): Hint | null {
  const contributing = nodesContributing(nodes, mode);
  const label = mode === "ceph" ? "ceph" : "the replicated zfs pool";
  if (contributing === 0) {
    return {
      tone: "danger",
      glyph: "✗",
      text: `no disk anywhere in the cluster is assigned to ${label} — pick at least one on every node, or go back and untick it in step 3.`,
    };
  }
  if (contributing < nodes.length) {
    const missing = nodes.length - contributing;
    return {
      tone: "danger",
      glyph: "✗",
      text: `${missing} of ${nodes.length} nodes contribute no disk to ${label}. ${
        mode === "ceph"
          ? "a node with no osd stores none of the cluster's data, so it can't take over a guest's disk when another node fails — which is the entire reason for running ceph."
          : "replication has nowhere to land on those nodes, so a guest can't fail over to them."
      }`,
    };
  }
  return null;
}

// ceph's own ceiling on `size`; a homelab never gets near it, but it keeps
// the picker short on a 16-node cluster.
export const MAX_CEPH_REPLICAS = 10;

// The floor for both size and min_size. A single replica means every
// object exists exactly once, and a min_size of 1 keeps accepting writes
// that exist in exactly one place — either one throws away the redundancy
// ceph is chosen for, and min_size 1 is the setting most often behind a
// homelab ceph cluster losing data. So neither is offered at all.
export const MIN_CEPH_REPLICAS = 2;

function range(from: number, to: number): number[] {
  return Array.from({ length: Math.max(0, to - from + 1) }, (_, i) => from + i);
}

/**
 * The replica counts that can actually be placed. Ceph's default failure
 * domain is the host, so it never puts two copies of an object on one
 * node — more replicas than nodes would leave the pool degraded from the
 * day it's created. Ceph itself needs at least 2 nodes, so the list is
 * never empty where it's shown.
 */
export function replicaChoices(nodeCount: number): number[] {
  const max = Math.max(MIN_CEPH_REPLICAS, Math.min(nodeCount, MAX_CEPH_REPLICAS));
  return range(MIN_CEPH_REPLICAS, max);
}

/** min_size above size could never be satisfied, so it tops out at size */
export function minReplicaChoices(replicas: number): number[] {
  return range(MIN_CEPH_REPLICAS, Math.max(MIN_CEPH_REPLICAS, replicas));
}

/**
 * The replica counts actually in effect: the visitor's choice, pulled
 * inside replicaChoices / minReplicaChoices for the current node count.
 *
 * Read-side only, like effectiveStorageHaMode — the stored choice is never
 * overwritten. The wizard starts at one node, so writing a clamped value
 * back would turn ceph's default of 3 into the floor before the visitor
 * ever reached step 3, and it would never come back. Kept as the choice
 * instead, it re-applies itself as soon as there are nodes enough.
 * Returns the same object when nothing needs clamping.
 */
export function effectiveCephPlan(plan: CephPlan, nodeCount: number): CephPlan {
  const sizes = replicaChoices(nodeCount);
  const maxSize = sizes[sizes.length - 1];
  const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi);
  // Number("") is 0, a perfectly good integer — so a blank has to be ruled
  // out explicitly, or it would clamp to the floor instead of falling back
  // to ceph's default
  const parse = (raw: string) => (raw.trim() !== "" && Number.isInteger(Number(raw)) ? Number(raw) : null);
  const rawSize = parse(plan.replicas);
  const size = rawSize !== null ? clamp(rawSize, MIN_CEPH_REPLICAS, maxSize) : Math.min(3, maxSize);
  const rawMin = parse(plan.minReplicas);
  const min = rawMin !== null ? clamp(rawMin, MIN_CEPH_REPLICAS, size) : MIN_CEPH_REPLICAS;
  if (String(size) === plan.replicas && String(min) === plan.minReplicas) return plan;
  return { ...plan, replicas: String(size), minReplicas: String(min) };
}

/**
 * Advice on replica counts that are valid but unwise. Invalid ones — more
 * replicas than nodes, min_size above size, anything below 2 — can't be
 * picked at all, so they're not this function's concern.
 */
export function cephReplicaHint(nodeCount: number, replicas: number): Hint | null {
  if (replicas < 3 && nodeCount >= 3) {
    return {
      tone: "warning",
      glyph: "!",
      text: `${replicas} replicas on a ${nodeCount}-node cluster gives up more than it saves. with 2 copies, a disk failing while the other copy is being read is data loss, and ceph has no third copy to arbitrate which one is correct. 3 is the default for good reason.`,
    };
  }
  return null;
}

/**
 * The fewest pool disks on any node that contributes to the pool. The
 * layout is one cluster-wide setting but every node builds its own pool
 * from its own disks, so the thinnest node decides what's buildable. A
 * node with no pool disk at all is left out here — poolMembershipHint
 * already flags it — and 0 means no node contributes anything.
 */
export function minPoolMembers(nodes: NodeInfo[]): number {
  const counts = nodes.map((n) => disksWithRole(n, "zfs").length).filter((c) => c > 0);
  return counts.length > 0 ? Math.min(...counts) : 0;
}

/** the layouts every node can actually build — nothing else is offered */
export function raidLevelChoices(memberCount: number): ZfsRaidLevel[] {
  return ZFS_RAID_OPTIONS.filter((o) => memberCount >= o.minDisks && memberCount > 0).map((o) => o.value);
}

/**
 * The layout in effect: the visitor's choice when every node can build
 * it, otherwise a mirror, otherwise a stripe — null when no node has a
 * pool disk at all. Read-side only, like effectiveCephPlan: the choice is
 * kept, so adding disks back brings raidz2 back.
 */
export function effectiveRaidLevel(chosen: ZfsRaidLevel, memberCount: number): ZfsRaidLevel | null {
  const choices = raidLevelChoices(memberCount);
  if (choices.includes(chosen)) return chosen;
  if (choices.includes("mirror")) return "mirror";
  return choices[0] ?? null;
}

/**
 * The one layout worth a word: a stripe has no redundancy. A layout that
 * needs more disks than a node has can't be picked (see raidLevelChoices),
 * so that isn't this function's concern.
 */
export function zfsLayoutHint(memberCount: number, level: ZfsRaidLevel): Hint | null {
  if (memberCount === 0 || level !== "stripe") return null;
  return {
    tone: "warning",
    glyph: "!",
    text: "a stripe has no redundancy — losing any single disk destroys the whole pool on that node. replication to the other nodes still gets you the guests back, but only as of the last run, so the window you set below is what you'd lose.",
  };
}

/** zfs sizes a vdev by its smallest member, so mixed sizes waste capacity */
export function mixedDiskSizeHint(disks: AdditionalDisk[], level: ZfsRaidLevel): Hint | null {
  if (level === "stripe" || disks.length < 2) return null;
  const sizes = disks.map(diskSizeGb).filter((n) => n > 0);
  if (sizes.length < 2) return null;
  const smallest = Math.min(...sizes);
  const largest = Math.max(...sizes);
  if (smallest === largest) return null;
  const wasted = sizes.reduce((sum, s) => sum + (s - smallest), 0);
  return {
    tone: "warning",
    glyph: "!",
    text: `these disks aren't the same size, and zfs sizes a vdev by its smallest member — about ${formatGb(wasted)} across the larger disks would sit unused. a separate pool for the odd sizes usually beats absorbing the loss.`,
  };
}

/** spinning disks behind ceph is the classic homelab disappointment */
export function cephDiskTypeHint(nodes: NodeInfo[]): Hint | null {
  const types = new Set<DiskType>();
  for (const node of nodes) for (const disk of disksWithRole(node, "ceph")) types.add(disk.type);
  if (!types.has("hdd")) return null;
  return {
    tone: "warning",
    glyph: "!",
    text: "one or more osds are on spinning disks. ceph acknowledges a write only once every replica has it, so each write pays for the slowest disk's seek — on hdds that lands somewhere around a few hundred iops for the whole pool, which guests feel as general sluggishness rather than as slow storage. an ssd or nvme for the db/wal recovers much of it if the bulk capacity has to stay spinning.",
  };
}

/** the replication window is exactly the data a failover can lose */
export function replicationWindowHint(minutes: number): Hint | null {
  if (!Number.isFinite(minutes) || minutes <= 0) return null;
  if (minutes <= 5) {
    return {
      tone: "info",
      glyph: "#",
      text: `replicating every ${minutes} minutes keeps the loss window small, but each run reads the changed blocks on every replicated guest — on spinning disks or a busy node, runs this frequent can overlap and queue up.`,
    };
  }
  if (minutes >= 60) {
    return {
      tone: "warning",
      glyph: "!",
      text: `a ${formatMinutes(minutes)} window means a node failing right before a run loses up to ${formatMinutes(minutes)} of writes on every guest it was hosting. that's the trade zfs replication makes against ceph — worth being deliberate about rather than inheriting.`,
    };
  }
  return null;
}

export function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = minutes / 60;
  return `${Number.isInteger(hours) ? hours : hours.toFixed(1)} hour${hours === 1 ? "" : "s"}`;
}

// ── validation ───────────────────────────────────────────────────────────

/**
 * Proxmox storage ids and zfs pool names overlap in what they allow;
 * this takes the stricter reading of both. A leading digit is rejected
 * because zfs reserves names that could be read as a pool id.
 */
export function validatePoolName(value: string): string | null {
  if (!value) return "can't be empty";
  if (value.length > 32) return "32 characters max";
  if (!/^[a-z][a-z0-9_-]*$/.test(value)) {
    return "start with a lowercase letter, then letters, numbers, hyphens or underscores";
  }
  // zfs refuses these outright — better to say so than to have `zpool
  // create` fail on a name the wizard suggested.
  if (["log", "mirror", "raidz", "raidz1", "raidz2", "raidz3", "spare", "cache"].includes(value)) {
    return `"${value}" is reserved by zfs — pick another name`;
  }
  return null;
}

/**
 * How the installer carves the boot disk (ext4 on lvm, its defaults): a
 * root filesystem of a quarter of the disk up to 96 gb, swap the size of
 * ram between 4 and 8 gb, an eighth kept free up to 16 gb — and the rest
 * becomes local-lvm, the thin pool guests can live on.
 */
export function bootDiskLayout(bootGb: number, ramGb: number) {
  const root = Math.min(bootGb / 4, 96);
  const swap = Math.min(Math.max(ramGb || 8, 4), 8);
  const reserved = Math.min(bootGb / 8, 16);
  return { root, swap, reserved, localLvm: Math.max(0, bootGb - root - swap - reserved) };
}
