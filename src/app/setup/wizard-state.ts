// The wizard's data model and how it survives a reload — shared by the
// form itself (./page.tsx) and the per-step preview routes under
// ./preview, which render the same saved state as a diagram.

import nicSpeedsData from "@/data/nic-speeds.json";

// physical nics on one node — 8 comfortably covers even a heavily-nic'd
// homelab box without the picker (or the network preview's per-node cable
// count) needing to plan for an unbounded number.
export const MAX_NICS_PER_NODE = 8;

export type CpuVendor = "intel" | "amd";
export type DiskType = "nvme" | "ssd" | "hdd";
export type NicSpeed = "1gbe" | "2.5gbe" | "10gbe" | "25gbe" | "other";
export type WizardStepId = "hardware" | "network";

export interface NicInfo {
  speed: NicSpeed;
  name: string;
}

export interface AdditionalDisk {
  type: DiskType;
  sizeGb: string;
  name: string;
}

export interface HardwareSpec {
  cpuVendor: CpuVendor;
  cpuFamily: string;
  cpuCount: string;
  coresPerCpu: string;
  ramGb: string;
  bootDiskType: DiskType;
  bootDiskSizeGb: string;
  bootDiskName: string;
  additionalDiskCount: string;
  additionalDisks: AdditionalDisk[];
  nicCount: string;
  nics: NicInfo[];
}

export type InterfacePurpose = "vm" | "ceph" | "zfs" | "backup" | "cluster" | "other";

export interface BridgeConfig {
  enabled: boolean;
  name: string;
  purposes: InterfacePurpose[];
  // only meaningful when purposes includes "other" — the answer to "does
  // the node itself need an address here?" for that one ambiguous case.
  otherNeedsHostIp: boolean;
  // always required: a real host ip+cidr when any selected purpose needs
  // one (ceph, backups, cluster, or "other" answered yes) — this stays
  // unique per node even under "identical network setup". otherwise it's
  // just the declared vm/ct subnet, which IS shared across nodes under
  // "identical network setup" (see applyNetworkStructure) since no node
  // actually claims an address on it.
  ip: string;
  // "" for a bridge at index 0 of its interface (always untagged/native —
  // one nic or bond can only carry one untagged bridge). a bridge at
  // index 1+ shares the same physical nic/bond with a sibling, which is
  // only valid in linux if each one rides its own vlan, so this becomes
  // required and must be unique among that interface's other bridges.
  vlanTag: string;
}

// the cluster-wide decision of how vm/ct storage stays available across
// nodes — drives whether "ceph" or "zfs replication" is even offered as a
// nic purpose, and only matters once there's more than 1 node.
export type StorageHaMode = "ceph" | "zfs-replication" | "none";

export type BondMode = "active-backup" | "lacp" | "balance-alb" | "balance-rr";

export interface BondConfig {
  name: string;
  mode: BondMode;
  // indices into node.nics; a bond isn't "real" until it has 2+
  nicIndices: number[];
  // optional — tags this bond's own link at a specific vlan (802.1q),
  // instead of leaving it as a plain untagged/native link on the
  // cluster-wide "main homelab vlan". "" means "plain native link, on
  // the cluster default" — most bonds leave this blank.
  vlanTag: string;
}

export const BOND_MODE_OPTIONS: { value: BondMode; label: string; hint: string }[] = [
  {
    value: "active-backup",
    label: "active-backup",
    hint: "one link active, the other cold for failover — no switch config needed",
  },
  {
    value: "lacp",
    label: "lacp (802.3ad)",
    hint: "combines bandwidth from every link — needs lacp configured on the switch port",
  },
  {
    value: "balance-alb",
    label: "balance-alb",
    hint: "load-balances outgoing traffic across links — no switch config needed, but fewer guarantees than lacp",
  },
  {
    value: "balance-rr",
    label: "balance-rr",
    hint: "round-robins packets across every link, the only mode that speeds up a single connection — but only reliable on a direct link between two hosts, most switches mishandle it",
  },
];

export function bondModeLabel(mode: BondMode): string {
  return BOND_MODE_OPTIONS.find((o) => o.value === mode)?.label ?? mode;
}

// A bond needs 2+ member nics to actually be an interface — fewer than
// that and it's still being assembled, so it doesn't count yet.
export function validBonds(bonds: BondConfig[]): BondConfig[] {
  return bonds.filter((b) => b.nicIndices.length >= 2);
}

export interface InterfaceRef {
  id: string; // "nic-<i>" or "bond-<i>", <i> is the index in nics/bonds
  label: string;
}

// Every selectable network interface on a node: each nic not claimed by
// a (valid) bond, plus each valid bond itself. This is what "management
// interface" and "bridge" pickers choose from — a bonded nic disappears
// from the list on its own, since it's part of its bond now, not a
// standalone interface.
export function interfacesFor(nics: NicInfo[], bonds: BondConfig[]): InterfaceRef[] {
  const bonded = new Set(validBonds(bonds).flatMap((b) => b.nicIndices));
  const nicRefs: InterfaceRef[] = nics
    .map((nic, i) => ({ nic, i }))
    .filter(({ i }) => !bonded.has(i))
    .map(({ nic, i }) => ({ id: `nic-${i}`, label: `nic ${i + 1} — ${nic.name} — ${nicSpeedLabel(nic.speed)}` }));
  const bondRefs: InterfaceRef[] = bonds
    .map((b, i) => ({ b, i }))
    .filter(({ b }) => b.nicIndices.length >= 2)
    .map(({ b, i }) => ({
      id: `bond-${i}`,
      label: `${b.name} — ${b.nicIndices.map((idx) => `nic ${idx + 1} (${nics[idx]?.name ?? "?"})`).join(" + ")} (${bondModeLabel(b.mode)})`,
    }));
  return [...nicRefs, ...bondRefs];
}

// a bridge's storage key is "<interfaceId>#<index>" — index 0 is the
// interface's native/untagged bridge, 1+ are extra vlan-tagged siblings.
export function bridgeKey(interfaceId: string, index: number): string {
  return `${interfaceId}#${index}`;
}

// a single nic/bond can carry its native bridge plus this many extra,
// vlan-tagged ones stacked on top via 802.1q — 24 comfortably covers even
// a heavily-segmented homelab without inviting an unbounded list.
export const MAX_BRIDGES_PER_INTERFACE = 24;

export function bridgeCountFor(bridgeCounts: Record<string, string>, interfaceId: string): number {
  const n = parseInt(bridgeCounts[interfaceId] ?? "1", 10);
  return !Number.isNaN(n) && n >= 1 && n <= MAX_BRIDGES_PER_INTERFACE ? n : 1;
}

export interface NodeNetwork {
  // just the label, e.g. "pve01" — the domain suffix is never stored
  // per node, only ever read live from the global hostname suffix, so a
  // node's fqdn can't drift out of sync with the domain you set.
  hostLabel: string;
  cidr: string;
  bondCount: string;
  bonds: BondConfig[];
  managementInterfaceId: string;
  // how many bridges live on each interface id — default "1". only an
  // interface the visitor has explicitly grown past 1 carries more than
  // its single native bridge; every id present here has a matching entry
  // in interfaceIdsFor's output.
  bridgeCounts: Record<string, string>;
  // keyed "<interfaceId>#<index>" (see bridgeKey) — index 0 is always
  // that interface's native/untagged bridge; index 1+ are extra,
  // vlan-tagged bridges sharing the same underlying nic or bond.
  bridges: Record<string, BridgeConfig>;
}

export interface NodeInfo extends HardwareSpec {
  name: string;
  network: NodeNetwork;
}

export const nicSpeedOptions = nicSpeedsData as { value: NicSpeed; label: string; hint?: string }[];

export function nicSpeedLabel(speed: NicSpeed): string {
  return nicSpeedOptions.find((o) => o.value === speed)?.label ?? speed;
}

// bump this whenever the shape of PersistedState (or anything nested inside
// it) changes — a mismatched version is discarded wholesale rather than
// risking a crash or a half-applied state from an older save.
export const STORAGE_KEY = "proxmox-computer:setup-wizard";
export const STORAGE_VERSION = 7;

export interface PersistedState {
  version: number;
  currentStep: WizardStepId;
  nodeCount: string;
  hostnameSuffix: string;
  globalCidr: string;
  gateway: string;
  // optional — the vlan id the untagged/native segment actually rides on
  // your switch, if you've numbered it. "" means "don't know or don't
  // care", which is the common case for a flat single-vlan homelab.
  homelabVlan: string;
  nodes: NodeInfo[];
  identicalHardware: boolean;
  identicalNetwork: boolean;
  storageHaMode: StorageHaMode;
}

// deliberately not exhaustive — every individual field getting checked would
// make this as brittle as the state it's guarding. the version check above
// is the real defense against a shape change; this just catches obviously
// corrupt or hand-edited data within the same version before it ever
// reaches setState.
export function isPersistedState(value: unknown): value is PersistedState {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (v.version !== STORAGE_VERSION) return false;
  if (v.currentStep !== "hardware" && v.currentStep !== "network") return false;
  if (typeof v.nodeCount !== "string") return false;
  if (typeof v.hostnameSuffix !== "string") return false;
  if (typeof v.globalCidr !== "string") return false;
  if (typeof v.gateway !== "string") return false;
  if (typeof v.homelabVlan !== "string") return false;
  if (typeof v.identicalHardware !== "boolean") return false;
  if (typeof v.identicalNetwork !== "boolean") return false;
  if (v.storageHaMode !== "ceph" && v.storageHaMode !== "zfs-replication" && v.storageHaMode !== "none") return false;
  if (!Array.isArray(v.nodes)) return false;

  for (const node of v.nodes) {
    if (!node || typeof node !== "object") return false;
    const n = node as Record<string, unknown>;
    if (typeof n.name !== "string") return false;
    if (typeof n.cpuVendor !== "string") return false;
    if (typeof n.cpuFamily !== "string") return false;
    if (!Array.isArray(n.nics)) return false;
    if (!Array.isArray(n.additionalDisks)) return false;

    if (!n.network || typeof n.network !== "object") return false;
    const net = n.network as Record<string, unknown>;
    if (typeof net.hostLabel !== "string") return false;
    if (typeof net.cidr !== "string") return false;
    if (typeof net.managementInterfaceId !== "string") return false;
    if (!Array.isArray(net.bonds)) return false;
    if (!net.bridgeCounts || typeof net.bridgeCounts !== "object") return false;
    if (!net.bridges || typeof net.bridges !== "object") return false;
    for (const b of Object.values(net.bridges as Record<string, unknown>)) {
      if (!b || typeof b !== "object") return false;
      const bridge = b as Record<string, unknown>;
      if (typeof bridge.enabled !== "boolean") return false;
      if (typeof bridge.name !== "string") return false;
      if (!Array.isArray(bridge.purposes)) return false;
      if (typeof bridge.ip !== "string") return false;
      if (typeof bridge.vlanTag !== "string") return false;
    }
  }

  return true;
}

export function loadPersistedState(): PersistedState | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isPersistedState(parsed) ? parsed : null;
  } catch {
    // corrupt json, storage unavailable (private browsing, disabled, etc.),
    // or anything else — treat exactly like "nothing saved".
    return null;
  }
}

// a preview lives on its own route, so "continue to the next step" has to
// hand the wizard its next step through the same saved state the wizard
// restores from on mount.
export function persistCurrentStep(step: WizardStepId): void {
  try {
    const saved = loadPersistedState();
    if (!saved) return;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...saved, currentStep: step }));
  } catch {
    // storage unavailable — the wizard just reopens on its last saved step.
  }
}
