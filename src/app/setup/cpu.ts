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
