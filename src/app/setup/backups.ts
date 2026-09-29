// Step 4's logic: where backups go, how long they're kept, and the advice
// worth giving before someone relies on a backup plan that wouldn't
// survive the failure it's meant for.

import type { Hint } from "./hints";
import { effectiveClusterStorage } from "./derive";
import {
  cephUsableGb,
  disksWithRole,
  effectiveCephPlan,
  effectiveRaidLevel,
  formatGb,
  minPoolMembers,
  totalGb,
  withEffectiveDiskRoles,
  zfsUsableGb,
} from "./storage";
import { isValidIPv4, validateIntRange } from "./validation";
import {
  enabledStorageModes,
  type BackupPlan,
  type BackupTarget,
  type ClusterStorage,
  type NodeInfo,
  type StoragePlan,
} from "./wizard-state";

export const BACKUP_TARGET_OPTIONS: { value: BackupTarget; label: string; hint: string }[] = [
  {
    value: "pbs-external",
    label: "proxmox backup server, on its own machine (recommended)",
    hint: "deduplicated, incremental backups on hardware that doesn't fail with the cluster — an old pc with a big disk is plenty",
  },
  {
    value: "pbs-vm",
    label: "proxmox backup server, as a vm in this cluster",
    hint: "all of pbs's features without another machine — but the backups live on the hardware they're meant to protect",
  },
  {
    value: "nfs",
    label: "a network share (nfs)",
    hint: "plain full backups to a nas — simple, but every run copies everything and there's no deduplication",
  },
  {
    value: "none",
    label: "no backups",
    hint: "nothing is backed up — a deleted vm or a failed pool is gone for good",
  },
];

export function backupTargetLabel(target: BackupTarget): string {
  return BACKUP_TARGET_OPTIONS.find((o) => o.value === target)?.label ?? target;
}

/** pbs brings verification, encryption and sync; nfs and none don't */
export function usesPbs(target: BackupTarget): boolean {
  return target === "pbs-external" || target === "pbs-vm";
}

// the common homelab baseline: a few recent restore points, a week of
// dailies, a month of weeklies, half a year of monthlies
export function defaultBackupPlan(): BackupPlan {
  return {
    target: "pbs-external",
    pbsAddress: "",
    datastore: "backups",
    nfsServer: "",
    nfsExport: "",
    schedule: "02:00",
    keepLast: "3",
    keepDaily: "7",
    keepWeekly: "4",
    keepMonthly: "6",
    encrypt: false,
    verify: true,
    offsite: false,
    offsiteAddress: "",
  };
}

export const RETENTION_FIELDS: { key: "keepLast" | "keepDaily" | "keepWeekly" | "keepMonthly"; label: string; hint: string }[] = [
  { key: "keepLast", label: "keep last", hint: "the most recent backups, whatever their age" },
  { key: "keepDaily", label: "keep daily", hint: "one per day, going back this many days" },
  { key: "keepWeekly", label: "keep weekly", hint: "one per week, going back this many weeks" },
  { key: "keepMonthly", label: "keep monthly", hint: "one per month, going back this many months" },
];

/**
 * The most backups kept per guest. Pbs and vzdump keep a backup if *any*
 * rule wants it, so rules overlap (today's backup is also the latest
 * daily) — this is the upper bound, which is what disk planning needs.
 */
export function maxBackupsKept(plan: BackupPlan): number {
  return RETENTION_FIELDS.reduce((sum, f) => sum + (Number(plan[f.key]) || 0), 0);
}

/** how far back the oldest kept backup reaches, in words */
export function retentionReach(plan: BackupPlan): string {
  const months = Number(plan.keepMonthly) || 0;
  const weeks = Number(plan.keepWeekly) || 0;
  const days = Number(plan.keepDaily) || 0;
  if (months > 0) return `about ${months} month${months === 1 ? "" : "s"}`;
  if (weeks > 0) return `about ${weeks} week${weeks === 1 ? "" : "s"}`;
  if (days > 0) return `about ${days} day${days === 1 ? "" : "s"}`;
  return "only the latest few runs";
}

// ── validation ───────────────────────────────────────────────────────────

/** a 24h "HH:MM" start time, as pbs and vzdump schedules take it */
export function validateScheduleTime(value: string): string | null {
  if (!value) return "required";
  const m = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return "a 24h time like 02:00";
  return null;
}

/** an ip address or a dns name — where the backup server answers */
export function validateHostAddress(value: string): string | null {
  if (!value) return "required";
  if (isValidIPv4(value)) return null;
  const label = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i;
  const labels = value.split(".");
  // all-numeric dotted input is a mistyped ip, not a hostname
  if (labels.every((l) => /^\d+$/.test(l))) return "not a valid ip address";
  if (value.length > 253 || !labels.every((l) => label.test(l))) return "an ip address or a hostname like pbs.homelab.lan";
  return null;
}

/** an absolute path on the nfs server */
export function validateExportPath(value: string): string | null {
  if (!value) return "required";
  if (!value.startsWith("/")) return "an absolute path, like /volume1/proxmox";
  if (/\s/.test(value)) return "no spaces";
  return null;
}

export function validateRetention(value: string): string | null {
  return validateIntRange(value, 0, 1000, { required: true });
}

// ── hints ────────────────────────────────────────────────────────────────

/** the one big warning: nothing is backed up */
export function noBackupHint(target: BackupTarget): Hint | null {
  if (target !== "none") return null;
  return {
    tone: "danger",
    glyph: "✗",
    text: "no backups means a deleted vm, a bad upgrade or a failed pool is gone for good. ceph and zfs replication keep guests running through a failure — they copy mistakes and corruption to every node just as faithfully, so they aren't backups.",
  };
}

/** backups living on the hardware they protect */
export function sameHardwareHint(target: BackupTarget, offsite: boolean): Hint | null {
  if (target !== "pbs-vm") return null;
  return {
    tone: "warning",
    glyph: "!",
    text: offsite
      ? "pbs runs inside the cluster it backs up — fine while the off-site copy below exists, since that's what survives losing the cluster."
      : "pbs runs inside the cluster it backs up, so whatever takes the cluster down — a fire, a failed pool, a bad upgrade — takes the backups with it. turn on an off-site copy below, or move pbs to its own machine.",
  };
}

/** the 3-2-1 rule: at least one copy somewhere else */
export function offsiteHint(target: BackupTarget, offsite: boolean): Hint | null {
  if (target === "none" || offsite || target === "pbs-vm") return null;
  return {
    tone: "info",
    glyph: "#",
    text: usesPbs(target)
      ? "the 3-2-1 rule asks for one copy off-site. pbs can sync its datastore to a second pbs elsewhere — a friend's place, a cheap vps — on its own schedule."
      : "the 3-2-1 rule asks for one copy off-site. a nas can usually replicate its share somewhere else on its own — worth setting up there.",
  };
}

/** encryption keys have to live somewhere the cluster isn't */
export function encryptionHint(plan: BackupPlan): Hint | null {
  if (!usesPbs(plan.target) || !plan.encrypt) return null;
  return {
    tone: "info",
    glyph: "#",
    text: "backups are encrypted before they leave each node. keep a copy of the key somewhere off the cluster — a password manager, a printout — because without it an encrypted backup can't be restored, by anyone.",
  };
}

/** retention that keeps nothing isn't a backup plan */
export function retentionHint(plan: BackupPlan): Hint | null {
  if (plan.target === "none") return null;
  const kept = maxBackupsKept(plan);
  if (kept > 0) return null;
  return {
    tone: "danger",
    glyph: "✗",
    text: "every retention count is 0, so each backup would be deleted as soon as it's made. keep at least one.",
  };
}

/** step 2 asked which nics carry backup traffic */
export function backupNicHint(nodes: NodeInfo[], target: BackupTarget): Hint | null {
  if (target === "none" || target === "pbs-vm") return null;
  const without = nodes.filter(
    (n) => !Object.values(n.network.bridges).some((b) => b.enabled && b.purposes.includes("backup")),
  );
  if (without.length === 0) return null;
  const names = without.length === nodes.length ? "any node" : without.map((n) => n.network.hostLabel || n.name).join(", ");
  return {
    tone: "info",
    glyph: "#",
    text: `no nic on ${names} is set up for backups in step 2, so backup traffic shares the management link. fine for a small cluster — a nightly full run can crowd out the web ui, though.`,
  };
}

// ── size ─────────────────────────────────────────────────────────────────

/**
 * The most guest data the planned storage can hold, in gb — what one full
 * backup of every guest reaches once every pool is full. Read through the
 * same effective values step 3 shows:
 * - ceph counts once, after replicas: it's one pool however many nodes;
 * - zfs replication counts one node's pool (the largest): replication
 *   keeps the same guests on every node, so they're backed up once;
 * - local disks count on every node, since each holds different guests.
 * The boot disk isn't counted — the installer owns it.
 */
export function maxGuestDataGb(nodes: NodeInfo[], chosen: ClusterStorage, storage: StoragePlan): number {
  const active = effectiveClusterStorage(chosen, nodes);
  const planNodes = withEffectiveDiskRoles(nodes, enabledStorageModes(active));
  const ceph = active.ceph ? cephUsableGb(planNodes, Number(effectiveCephPlan(storage.ceph, nodes.length).replicas) || 0) : 0;
  let zfs = 0;
  if (active.zfs) {
    const level = effectiveRaidLevel(storage.zfs.raidLevel, minPoolMembers(planNodes)) ?? storage.zfs.raidLevel;
    zfs = Math.max(0, ...planNodes.map((n) => zfsUsableGb(disksWithRole(n, "zfs"), level)));
  }
  const local = planNodes.reduce((sum, n) => sum + totalGb(disksWithRole(n, "local")), 0);
  return ceph + zfs + local;
}

/**
 * How big backups can get if the cluster's storage fills up — the number
 * to size a backup target against. Worst case, before compression: pbs
 * stores one full copy and then only changes, an nfs share a full copy
 * per kept backup.
 */
export function backupSizeHint(maxGb: number, plan: BackupPlan): Hint | null {
  if (plan.target === "none" || maxGb <= 0) return null;
  const full = formatGb(maxGb);
  if (usesPbs(plan.target)) {
    return {
      tone: "info",
      glyph: "#",
      text: `if the cluster's storage fills up, one full backup of every guest is up to ${full} — before compression. pbs deduplicates: the first run stores up to ${full}, later runs only what changed since, so size the datastore for ${full} plus room for the changes your retention keeps.`,
    };
  }
  const kept = maxBackupsKept(plan);
  return {
    tone: "info",
    glyph: "#",
    text: `if the cluster's storage fills up, one full backup of every guest is up to ${full} — before compression. an nfs share keeps a full copy per backup, so ${kept} kept backups can reach ${formatGb(maxGb * kept)}.`,
  };
}
