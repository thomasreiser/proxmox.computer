// The cpu-family catalog and the questions the wizard asks of it: what
// qemu type a display name resolves to, and which families share one. Live
// migration only works between nodes whose *resolved* type matches, so the
// resolution step — not the pretty name — is what every check downstream
// actually compares (see cpuHintFor in ./hints.ts).

import cpuVendorsData from "@/data/cpu-vendors.json";
import cpuFamiliesData from "@/data/cpu-families.json";
import type { CpuVendor } from "./wizard-state";

export const cpuVendorOptions = cpuVendorsData as { value: CpuVendor; label: string }[];

export interface CpuFamily {
  name: string;
  qemuType: string;
  from: number;
  to: number | null;
  defaultCores: number;
  note?: string;
}

export interface CpuFamiliesData {
  architectures: Record<CpuVendor, CpuFamily[]>;
  cpu_types: Record<string, Record<CpuVendor, string[]>>;
}

export const cpuFamilies = cpuFamiliesData as CpuFamiliesData;

export function familiesByDate(vendor: CpuVendor): CpuFamily[] {
  return [...cpuFamilies.architectures[vendor]].sort((a, b) => a.from - b.from);
}

// Some display names (real chip generations, e.g. "Alder Lake") have no
// dedicated qemu cpu model — they map to the closest native qemu type.
// Resolve to that native type before comparing nodes for compatibility.
export function qemuTypeFor(vendor: CpuVendor, familyName: string): string {
  const entry = cpuFamilies.architectures[vendor].find((f) => f.name === familyName);
  return entry?.qemuType ?? familyName;
}

// qemuType values carry security-mitigation suffixes (-noTSX, -IBRS,
// -IBPB) that don't represent a later hardware generation — just a
// different feature-flag preset for the same silicon. Strip them to find
// the entry that actually carries this generation's real launch dates.
export function stripMitigationSuffix(qemuType: string): string {
  return qemuType.replace(/-(noTSX-IBRS|noTSX|IBRS|IBPB)$/, "");
}

export function nativeEntryFor(vendor: CpuVendor, qemuType: string): CpuFamily | undefined {
  const base = stripMitigationSuffix(qemuType);
  return cpuFamilies.architectures[vendor].find((f) => f.name === base);
}

// A rough, "better than nothing" per-cpu core-count guess for a family —
// real SKUs in any given generation range widely, so this is only a
// sane starting point the visitor is expected to correct.
export function defaultCoresFor(vendor: CpuVendor, familyName: string): number {
  const entry = cpuFamilies.architectures[vendor].find((f) => f.name === familyName);
  return entry?.defaultCores ?? 4;
}

// A common, broadly-compatible baseline per vendor — not the newest chip,
// but one whose migration target list (cpu_types[x]) still covers most
// hardware someone is likely to add to the cluster later.
export const DEFAULT_CPU_FAMILY: Record<CpuVendor, string> = {
  intel: "Skylake-Server",
  amd: "EPYC-Rome",
};

// ── a guest's cpu type ───────────────────────────────────────────────────
// cpu_types[type][vendor] lists the host families that can run a guest
// of that type (keyed by the family's native qemu type, mitigation suffix
// stripped). That's the whole of "technically possible": a guest type is
// offered only where every node it may run on is on that list.

interface CpuHost {
  cpuVendor: CpuVendor;
  cpuFamily: string;
}

/** the key cpu_types lists a host under */
export function hostCpuKey(host: CpuHost): string {
  return stripMitigationSuffix(qemuTypeFor(host.cpuVendor, host.cpuFamily));
}

// vendor-neutral models, the widest-reaching first; x86-64-v2-AES is what
// proxmox itself picks for a new vm
export const GENERIC_CPU_TYPES = ["x86-64-v2-AES", "x86-64-v2", "x86-64-v3", "x86-64-v4", "kvm64", "qemu64"];
// the host's own cpu, passed straight through — fastest, but a guest on it
// can only move to a node with the very same cpu
export const PASSTHROUGH_CPU_TYPES = ["host", "max"];

const launched = (type: string, vendor: CpuVendor): number => {
  const base = stripMitigationSuffix(type).replace(/-v\d+$/, "");
  return cpuFamilies.architectures[vendor].find((f) => f.name === base)?.from ?? 0;
};

/**
 * The cpu types every one of these hosts can run: generic ones first,
 * then the vendor's own models oldest first, passthrough last — and
 * passthrough only while the hosts are all the same cpu.
 */
export function cpuTypeOptions(hosts: CpuHost[]): string[] {
  if (hosts.length === 0) return [...GENERIC_CPU_TYPES];
  const runnable = Object.keys(cpuFamilies.cpu_types).filter((type) =>
    hosts.every((h) => (cpuFamilies.cpu_types[type]?.[h.cpuVendor] ?? []).includes(hostCpuKey(h))),
  );
  const sameCpu = new Set(hosts.map((h) => `${h.cpuVendor}:${qemuTypeFor(h.cpuVendor, h.cpuFamily)}`)).size === 1;
  const vendor = hosts[0].cpuVendor;
  // the hosts' own vendor's models first, by launch; the other vendor's
  // (the old ones every x86 cpu still runs) after them
  const other: CpuVendor = vendor === "intel" ? "amd" : "intel";
  const rank = (t: string) => launched(t, vendor) || 10_000 + launched(t, other);
  const models = runnable
    .filter((t) => !GENERIC_CPU_TYPES.includes(t) && !PASSTHROUGH_CPU_TYPES.includes(t))
    .sort((a, b) => rank(a) - rank(b));
  return [
    ...GENERIC_CPU_TYPES.filter((t) => runnable.includes(t)),
    ...models,
    ...(sameCpu ? PASSTHROUGH_CPU_TYPES.filter((t) => runnable.includes(t)) : []),
  ];
}

/**
 * The type the hardware step works out for the cluster: the oldest cpu
 * among the nodes, so a guest can migrate to any of them — the same one
 * cpuHintFor recommends. Mixed vendors share no model; the generic
 * baseline is all they have in common.
 */
export function clusterCpuBaseline(hosts: CpuHost[]): string {
  if (hosts.length === 0 || new Set(hosts.map((h) => h.cpuVendor)).size > 1) return "x86-64-v2-AES";
  const vendor = hosts[0].cpuVendor;
  const types = [...new Set(hosts.map((h) => qemuTypeFor(vendor, h.cpuFamily)))];
  return types.sort((a, b) => launched(a, vendor) - launched(b, vendor))[0];
}

/** the choice while it's still possible, else the baseline, else the widest option */
export function effectiveCpuType(chosen: string, options: string[], baseline: string): string {
  if (chosen && options.includes(chosen)) return chosen;
  if (options.includes(baseline)) return baseline;
  return options[0] ?? "x86-64-v2-AES";
}
