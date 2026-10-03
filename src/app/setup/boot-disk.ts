// Step 8's one question: each node's boot disk, by the name lsblk gives it.
//
// It's the single exception to "intent, never device identity", and a
// narrow one: asked last, only once the visitor has booted the machine and
// looked (the install guide's step 2), and never guessed. A node without a
// valid name keeps the placeholder its answer file can't match, so the
// installer stops instead of wiping the wrong disk.

import type { DiskType, InstallPlan, PersistedState } from "./wizard-state";

export function defaultInstallPlan(): InstallPlan {
  return { bootDisk: "", bootDisks: [] };
}

// whole disks as lsblk names them: sata/sas/ide, virtio, xen, nvme, sd cards
const WHOLE_DISK = /^(sd[a-z]+|hd[a-z]+|vd[a-z]+|xvd[a-z]+|nvme\d+n\d+|mmcblk\d+)$/;
// …and their partitions, which the installer can't install onto
const PARTITION = /^((sd|hd|vd|xvd)[a-z]+\d+|(nvme\d+n\d+|mmcblk\d+)p\d+)$/;

/** a boot disk name, as typed — null when valid, or not answered yet */
export function validateBootDiskName(value: string): string | null {
  const name = value.trim();
  if (!name) return null;
  if (name.startsWith("/dev/")) return "just the name lsblk prints, without /dev/ — e.g. sda or nvme0n1";
  if (PARTITION.test(name)) return "that's a partition — give the whole disk, e.g. sda or nvme0n1";
  if (!WHOLE_DISK.test(name)) return "not a disk name lsblk prints — e.g. sda or nvme0n1";
  return null;
}

type BootDiskState = Pick<PersistedState, "identicalHardware" | "install">;

/** node i's boot disk as typed: the shared one while the hardware is identical, its own otherwise */
export function bootDiskFor(state: BootDiskState, i: number): string {
  return (state.identicalHardware ? state.install.bootDisk : (state.install.bootDisks[i] ?? "")).trim();
}

/** what goes into node i's answer file — null while it has no valid name */
export function answerBootDisk(state: BootDiskState, i: number): string | null {
  const name = bootDiskFor(state, i);
  return name && !validateBootDiskName(name) ? name : null;
}

/** the plan with node i's own boot disk set — the list padded so it lines up with the nodes */
export function withNodeBootDisk(plan: InstallPlan, i: number, value: string): InstallPlan {
  const length = Math.max(plan.bootDisks.length, i + 1);
  return { ...plan, bootDisks: Array.from({ length }, (_, j) => (j === i ? value : (plan.bootDisks[j] ?? ""))) };
}

/**
 * A valid name that doesn't fit the disk type declared in step 2 — the
 * likeliest sign of having noted the wrong disk. Advice only: a raid
 * controller or an adapter can make either look like the other.
 */
export function bootDiskTypeHint(name: string, type: DiskType): string | null {
  const n = name.trim();
  if (!n || validateBootDiskName(n)) return null;
  if (type === "nvme" && /^(sd|hd)/.test(n)) {
    return `step 2 says this boot disk is nvme, but ${n} is a sata/sas name — nvme disks are listed as nvme0n1, nvme1n1…`;
  }
  if (type !== "nvme" && n.startsWith("nvme")) return `step 2 says this boot disk is an ${type}, but ${n} is an nvme disk`;
  return null;
}
