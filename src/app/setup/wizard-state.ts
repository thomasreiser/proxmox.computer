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
export type WizardStepId = "location" | "hardware" | "network" | "storage" | "backups" | "access" | "software" | "install";

// The physical connector — what the switch port has to match. Speed alone
// doesn't settle it: 10 gbe is either sfp+ or rj45 (10gbase-t), which need
// different switch ports and different cabling.
export type NicPort = "rj45" | "sfp" | "sfp+" | "sfp28" | "qsfp28";

export interface NicInfo {
  speed: NicSpeed;
  name: string;
  // the visitor's choice, or "" when they haven't made one — read it
  // through effectivePort(), which falls back to the usual connector for
  // the speed (see portChoices)
  port: NicPort | "";
}

// What one disk beyond the boot disk is actually for. This lives on the
// disk rather than in a parallel array on the node, so adding or removing
// a disk back in step 2 can't shift every later disk's plan by one.
//   "ceph"   — handed to ceph whole, as one osd
//   "zfs"    — a member of this node's replicated zfs pool
//   "local"  — this node's own storage, replicated nowhere
//   "unused" — declared in step 2, deliberately left out of every pool
export type DiskRole = "ceph" | "zfs" | "local" | "unused";

export interface AdditionalDisk {
  type: DiskType;
  sizeGb: string;
  name: string;
  // the visitor's choice, or "" when they haven't made one — read it
  // through effectiveDiskRole() (storage.ts), which falls back to a role
  // that fits the cluster storage actually enabled
  role: DiskRole | "";
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

// whether the node itself claims an address on a bridge serving this
// purpose: true = always, false = never (a pure vm/ct switch), null =
// "other", which is ambiguous enough that the visitor answers it per
// bridge (BridgeConfig.otherNeedsHostIp). this lives here rather than
// beside the form's purpose copy because it decides what a bridge's `ip`
// field actually holds — the node's own address, or just the subnet the
// bridge switches for its guests — and the preview has to read that field
// the same way the form wrote it.
export const PURPOSE_NEEDS_HOST_IP: Record<InterfacePurpose, boolean | null> = {
  vm: false,
  ceph: true,
  zfs: true,
  backup: true,
  cluster: true,
  other: null,
};

// a real nic/bridge often earns its keep serving more than one purpose at
// once (vm traffic + corosync is a completely normal homelab setup), so
// one purpose needing a host address is enough for the whole bridge to.
export function needsHostIpForPurposes(purposes: InterfacePurpose[], otherNeedsHostIp: boolean): boolean {
  return purposes.some((p) => PURPOSE_NEEDS_HOST_IP[p] ?? otherNeedsHostIp);
}

// How a zfs pool's member disks are arranged. Only a single vdev is
// modeled: a homelab node's spare bays are few enough that a second vdev
// is rare, and supporting one would mean asking which disks go in which
// vdev — a question this wizard has no good way to ask.
export type ZfsRaidLevel = "mirror" | "raidz1" | "raidz2" | "stripe";

// what a node's "local" disks become
export type LocalStorageKind = "zfs" | "lvm-thin" | "directory";

export interface CephPlan {
  poolName: string;
  // ceph's `size`: how many copies of every object exist across the
  // cluster. 3 is the default every ceph doc assumes.
  replicas: string;
  // ceph's `min_size`: how many copies must be writable before the pool
  // accepts a write at all. 2 stays writable through one host being down
  // while still refusing writes when only a single copy survives.
  minReplicas: string;
}

export interface ZfsPlan {
  poolName: string;
  raidLevel: ZfsRaidLevel;
  // minutes between replication runs. this is exactly the window of
  // writes a failover can lose, which is the whole trade zfs replication
  // makes against ceph.
  replicationMinutes: string;
}

export interface LocalPlan {
  kind: LocalStorageKind;
  name: string;
}

// Step 4's cluster-wide answers. Which disks take part is decided per
// node (see AdditionalDisk.role); everything here is one decision for the
// whole cluster.
// Where the cluster's guests are backed up to.
//   "pbs-external" — a proxmox backup server on its own machine
//   "pbs-vm"       — a proxmox backup server running as a vm in this cluster
//   "nfs"          — plain vzdump archives on a network share
//   "none"         — no backups at all
export type BackupTarget = "pbs-external" | "pbs-vm" | "nfs" | "none";

// Step 5's answers. Every field is kept whatever the target, so switching
// target and back doesn't lose what was typed — each target only reads
// the fields it needs (see backups.ts).
export interface BackupPlan {
  target: BackupTarget;
  // pbs: the server's address, and the datastore that holds the backups
  pbsAddress: string;
  datastore: string;
  // nfs: the server and the exported path
  nfsServer: string;
  nfsExport: string;
  // daily start time, "HH:MM" in 24h
  schedule: string;
  // pbs/vzdump retention: how many of each kind of backup to keep
  keepLast: string;
  keepDaily: string;
  keepWeekly: string;
  keepMonthly: string;
  // pbs only
  encrypt: boolean;
  verify: boolean;
  offsite: boolean;
  offsiteAddress: string;
}

export interface StoragePlan {
  ceph: CephPlan;
  zfs: ZfsPlan;
  local: LocalPlan;
}

// The cluster-wide storage that keeps guests available across nodes.
// Ceph and zfs replication are independent switches, not alternatives: a
// cluster can run both — ceph as the main ha storage, say, with zfs
// replication alongside for backups. Neither is a legitimate answer too.
// Each drives whether its nic purpose is offered, and only matters once
// there's more than 1 node.
export type StorageMode = "ceph" | "zfs";

export interface ClusterStorage {
  ceph: boolean;
  zfs: boolean;
}

/** the enabled modes, ceph first — the order everything lists them in */
export function enabledStorageModes(cs: ClusterStorage): StorageMode[] {
  return (["ceph", "zfs"] as const).filter((m) => cs[m]);
}

// ceph and zfs replication are host-to-host storage traffic: no vm ever
// joins them, so they never get a bridge of their own. on any interface
// but the management one they're a *storage link* instead — the node's
// address sits directly on the nic or bond (see isStorageLink).
export function isStoragePurpose(purpose: InterfacePurpose): boolean {
  return purpose === "ceph" || purpose === "zfs";
}

/**
 * Whether this bridge slot is really a storage link: the native slot of a
 * non-management interface, carrying ceph and/or zfs. Its address goes on
 * the nic or bond itself — there's no vmbr, so its `name` is kept (for
 * switching back) but never used, and the interface carries nothing else.
 * The management interface is the exception: its bridge exists for the
 * web ui anyway, so ceph or zfs there just shares it.
 */
export function isStorageLink(network: Pick<NodeNetwork, "managementInterfaceId" | "bridges">, key: string): boolean {
  const [interfaceId, index] = key.split("#");
  const bridge = network.bridges[key];
  return index === "0" && interfaceId !== network.managementInterfaceId && !!bridge && bridge.purposes.some(isStoragePurpose);
}

/** the name an interface id goes by — its bond's name, or its nic's */
export function interfaceNameFor(interfaceId: string, nics: NicInfo[], bonds: BondConfig[]): string {
  if (interfaceId.startsWith("bond-")) return bonds[Number(interfaceId.slice("bond-".length))]?.name || interfaceId;
  return nics[Number(interfaceId.slice("nic-".length))]?.name || interfaceId;
}

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

export const NIC_PORT_LABEL: Record<NicPort, string> = {
  rj45: "rj45",
  sfp: "sfp",
  "sfp+": "sfp+",
  sfp28: "sfp28",
  qsfp28: "qsfp28",
};

/** why a connector matters, for the one-line hint beside the choice */
export function portHint(speed: NicSpeed, port: NicPort): string {
  if (speed === "10gbe" && port === "sfp+") return "a dac cable or fiber module — the usual homelab 10g choice, cool and cheap to cable";
  if (speed === "10gbe" && port === "rj45") return "10gbase-t over copper — plain cat6a, but runs hot and needs rj45 10g switch ports";
  if (port === "rj45") return "the usual copper port — any switch takes it";
  if (port === "sfp") return "a 1g fiber or copper module in an sfp cage";
  if (port === "sfp28") return "a 25g dac or fiber module";
  return "a 4-lane cage, split into several ports with a breakout cable";
}

/**
 * The connectors a nic of this speed actually comes with, most common
 * first — the first entry is the default. A speed with one connector is
 * never asked about; "other / not sure" isn't either, since someone unsure
 * of the speed won't know the connector.
 */
export function portChoices(speed: NicSpeed): NicPort[] {
  switch (speed) {
    case "1gbe":
      return ["rj45", "sfp"];
    case "2.5gbe":
      return ["rj45"];
    case "10gbe":
      return ["sfp+", "rj45"];
    case "25gbe":
      return ["sfp28", "qsfp28"];
    case "other":
      return [];
  }
}

/**
 * The connector in effect: the visitor's choice when it fits the speed,
 * otherwise the usual one for that speed, or null when the speed is
 * unknown. Read-side only — a choice made at one speed is kept, and comes
 * back if the speed returns to one it fits.
 */
export function effectivePort(nic: Pick<NicInfo, "speed" | "port">): NicPort | null {
  const choices = portChoices(nic.speed);
  if (nic.port && choices.includes(nic.port)) return nic.port;
  return choices[0] ?? null;
}

// Ceph's practical floor is 10gbe. Below it a single osd backfill
// saturates the link, and because every write is replicated before it's
// acknowledged, that shows up as cluster-wide vm disk stalls rather than
// as "storage is a bit slow". "other" is deliberately neither fast nor
// slow: an unknown nic can't earn a warning, and can't clear one either.
export function isFastNic(speed: NicSpeed): boolean {
  return speed === "10gbe" || speed === "25gbe";
}

export function isSlowNic(speed: NicSpeed): boolean {
  return speed === "1gbe" || speed === "2.5gbe";
}

// which physical nics sit behind one interface id — the bond's members, or
// the single nic it names. shared by the wizard (which needs the speeds
// behind a bridge) and the preview's topology builder.
export function nicIndicesForInterface(interfaceId: string, bonds: BondConfig[]): number[] {
  if (interfaceId.startsWith("bond-")) {
    const index = Number(interfaceId.slice("bond-".length));
    return bonds[index]?.nicIndices ?? [];
  }
  return [Number(interfaceId.slice("nic-".length))];
}

// the speeds behind an interface, in member order — [] when the id names a
// bond that no longer exists, or a nic index that's been trimmed away.
export function nicSpeedsForInterface(interfaceId: string, nics: NicInfo[], bonds: BondConfig[]): NicSpeed[] {
  return nicIndicesForInterface(interfaceId, bonds)
    .map((i) => nics[i]?.speed)
    .filter((s): s is NicSpeed => s !== undefined);
}

/**
 * The speed behind an interface, in words: "10 gbe" for one nic, "2 × 10
 * gbe" for a bond of equal members, "10 gbe + 1 gbe" for a mixed one —
 * "" when nothing's behind it. Shared by the previews' link rows.
 */
export function linkSpeedLabel(speeds: NicSpeed[]): string {
  const distinct = [...new Set(speeds)];
  if (speeds.length > 1 && distinct.length === 1) return `${speeds.length} × ${nicSpeedLabel(distinct[0])}`;
  return speeds.map(nicSpeedLabel).join(" + ");
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

import type { LocationPlan } from "./location";
import type { SoftwarePlan } from "./software";
export { STORAGE_KEY } from "./vault";

// the steps whose answers are saved — every one, step 8's boot disks included
export type SavedStepId = WizardStepId;
export const SAVED_STEPS: SavedStepId[] = ["location", "hardware", "network", "storage", "backups", "access", "software", "install"];

// One version per step. Bump a step's whenever the shape of what it saves
// changes (see STEP_SECTIONS for which fields those are). A save is kept up
// to the first step whose version or shape doesn't match; that step and
// every one after it start over, since each builds on the ones before —
// never migrated, never half-applied (see restoreSaved in saved-state.ts).
export const STEP_VERSIONS: Record<SavedStepId, number> = {
  location: 1,
  hardware: 1,
  network: 1,
  storage: 1,
  backups: 1,
  access: 1,
  software: 1,
  install: 1,
};

// The layout of the save itself: which fields belong to which step, and
// stepVersions. Bump it only when that changes — it discards a save wholesale.
export const STORAGE_VERSION = 20;

// Step 6: who gets in, and how. The one step that holds secrets — which
// is why the whole saved state is encrypted (see vault.ts).
export type OidcUsernameClaim = "subject" | "username" | "email";

export interface OidcPlan {
  enabled: boolean;
  // the proxmox realm id people pick at login, e.g. "oidc"
  realm: string;
  issuerUrl: string;
  clientId: string;
  // optional — a public client has none. a secret.
  clientSecret: string;
  usernameClaim: OidcUsernameClaim;
  // create a proxmox user on first login (with no permissions until granted)
  autocreate: boolean;
  // preselect this realm on the login screen
  isDefault: boolean;
}

export interface AccessPlan {
  // one or more ssh public keys, one per line — root on every node
  sshKeys: string;
  // ssh takes keys only; the web ui and console still take the password
  disablePasswordSsh: boolean;
  // per node, by index — secrets. read past the end as "" (see rootPasswordFor)
  rootPasswords: string[];
  oidc: OidcPlan;
}

// Step 8: each node's boot disk, by the name lsblk gives it — the one
// device the wizard names, and only once the visitor has looked at the
// machine (see boot-disk.ts). Read through bootDiskFor().
export interface InstallPlan {
  // every node's, while the hardware is identical
  bootDisk: string;
  // per node, by index, otherwise — read past the end as ""
  bootDisks: string[];
}

export interface PersistedState {
  version: number;
  // the STEP_VERSIONS each step was saved under
  stepVersions: Record<SavedStepId, number>;
  currentStep: WizardStepId;
  location: LocationPlan;
  nodeCount: string;
  hostnameSuffix: string;
  globalCidr: string;
  gateway: string;
  // the dns server every node resolves through — starts as the gateway
  dns: string;
  // optional — the vlan id the untagged/native segment actually rides on
  // your switch, if you've numbered it. "" means "don't know or don't
  // care", which is the common case for a flat single-vlan homelab.
  homelabVlan: string;
  nodes: NodeInfo[];
  identicalHardware: boolean;
  identicalNetwork: boolean;
  clusterStorage: ClusterStorage;
  storage: StoragePlan;
  // keeps every node's disk roles in step — the same bargain
  // identicalNetwork strikes for bridges
  identicalStorage: boolean;
  backups: BackupPlan;
  access: AccessPlan;
  software: SoftwarePlan;
  install: InstallPlan;
}

function isSoftwarePlan(value: unknown): value is SoftwarePlan {
  if (!value || typeof value !== "object") return false;
  const guests = (value as Record<string, unknown>).guests;
  if (!Array.isArray(guests)) return false;
  const k8s = (value as Record<string, unknown>).kubernetes as Record<string, unknown> | undefined;
  if (!k8s || typeof k8s !== "object" || typeof k8s.cephVolumes !== "boolean" || typeof k8s.volumeGb !== "string") return false;
  const fields = (o: Record<string, unknown>, strings: string[], booleans: string[]) =>
    strings.every((k) => typeof o[k] === "string") && booleans.every((k) => typeof o[k] === "boolean");
  return guests.every((g) => {
    if (!g || typeof g !== "object") return false;
    const guest = g as Record<string, unknown>;
    if (!["vm", "container"].includes(guest.kind as string)) return false;
    if (!["", "control-plane", "worker"].includes(guest.k8sRole as string)) return false;
    if (
      !fields(
        guest,
        ["id", "name", "vmid", "image", "tags", "notes", "node", "startupOrder", "startupDelay", "shutdownTimeout", "sockets", "cores",
          "cpuType", "cpuLimit", "cpuUnits", "memoryGb", "minMemoryGb", "swapGb", "osType", "machine", "bios", "scsiController",
          "display", "ciUser"],
        ["ha", "startOnBoot", "numa", "ballooning", "tpm", "qemuAgent", "unprivileged", "nesting", "fuse", "keyctl", "useAccessKeys"],
      )
    ) {
      return false;
    }
    if (!Array.isArray(guest.disks) || !Array.isArray(guest.nics)) return false;
    const diskOk = (d: unknown) =>
      !!d && typeof d === "object" &&
      fields(d as Record<string, unknown>, ["id", "storage", "sizeGb", "bus", "cache", "mountPath"], ["discard", "ssd", "iothread", "backup", "replicate"]);
    const nicOk = (n: unknown) =>
      !!n && typeof n === "object" &&
      ["dhcp", "static", "none"].includes((n as Record<string, unknown>).ipMode as string) &&
      fields(n as Record<string, unknown>, ["id", "bridge", "vlanTag", "model", "macAddress", "rateMbps", "mtu", "ip", "gateway"], ["firewall"]);
    return guest.disks.every(diskOk) && guest.nics.every(nicOk);
  });
}

function isAccessPlan(value: unknown): value is AccessPlan {
  if (!value || typeof value !== "object") return false;
  const a = value as Record<string, unknown>;
  if (typeof a.sshKeys !== "string" || typeof a.disablePasswordSsh !== "boolean") return false;
  if (!Array.isArray(a.rootPasswords) || !a.rootPasswords.every((p) => typeof p === "string")) return false;
  if (!a.oidc || typeof a.oidc !== "object") return false;
  const o = a.oidc as Record<string, unknown>;
  for (const key of ["realm", "issuerUrl", "clientId", "clientSecret"]) if (typeof o[key] !== "string") return false;
  for (const key of ["enabled", "autocreate", "isDefault"]) if (typeof o[key] !== "boolean") return false;
  return ["subject", "username", "email"].includes(o.usernameClaim as string);
}

// Which fields each step saves. Disk roles are step 4's although they sit on
// step 2's disks, and each node's network is step 3's.
//   location — location
//   hardware — nodeCount, identicalHardware, nodes (all but network and disk roles)
//   network  — hostnameSuffix, globalCidr, gateway, dns, homelabVlan,
//              identicalNetwork, every node's network
//   storage  — clusterStorage, storage, identicalStorage, every disk's role
//   backups, access, software, install — their own plan
//
// Each check is deliberately not exhaustive — every individual field getting
// checked would make it as brittle as the state it's guarding. The step
// versions are the real defense against a shape change; these catch
// obviously corrupt or hand-edited data before it ever reaches setState.
// A check may rely on the steps before it having passed.
type Loose = Record<string, unknown>;
const isObject = (value: unknown): value is Loose => !!value && typeof value === "object";
const strings = (o: Loose, keys: string[]) => keys.every((k) => typeof o[k] === "string");
const booleans = (o: Loose, keys: string[]) => keys.every((k) => typeof o[k] === "boolean");
const nodesOf = (v: Loose) => v.nodes as Loose[];

export const STEP_SECTIONS: Record<SavedStepId, (v: Loose) => boolean> = {
  location: (v) => isObject(v.location) && strings(v.location, ["country", "keyboard", "timezone"]),

  hardware: (v) =>
    typeof v.nodeCount === "string" &&
    typeof v.identicalHardware === "boolean" &&
    Array.isArray(v.nodes) &&
    v.nodes.every(
      (n) =>
        isObject(n) &&
        strings(n, ["name", "cpuVendor", "cpuFamily"]) &&
        Array.isArray(n.nics) &&
        n.nics.every((nic) => isObject(nic) && strings(nic, ["speed", "port"])) &&
        Array.isArray(n.additionalDisks) &&
        n.additionalDisks.every((d) => isObject(d) && strings(d, ["type", "sizeGb", "name"])),
    ),

  network: (v) =>
    strings(v, ["hostnameSuffix", "globalCidr", "gateway", "dns", "homelabVlan"]) &&
    typeof v.identicalNetwork === "boolean" &&
    nodesOf(v).every((n) => {
      const net = n.network;
      if (!isObject(net) || !strings(net, ["hostLabel", "cidr", "managementInterfaceId"])) return false;
      if (!Array.isArray(net.bonds) || !isObject(net.bridgeCounts) || !isObject(net.bridges)) return false;
      return Object.values(net.bridges).every(
        (b) => isObject(b) && booleans(b, ["enabled"]) && strings(b, ["name", "ip", "vlanTag"]) && Array.isArray(b.purposes),
      );
    }),

  storage: (v) =>
    typeof v.identicalStorage === "boolean" &&
    isObject(v.storage) &&
    ["ceph", "zfs", "local"].every((section) => isObject((v.storage as Loose)[section])) &&
    isObject(v.clusterStorage) &&
    booleans(v.clusterStorage, ["ceph", "zfs"]) &&
    nodesOf(v).every((n) =>
      (n.additionalDisks as Loose[]).every((d) => ["", "ceph", "zfs", "local", "unused"].includes(d.role as string)),
    ),

  backups: (v) =>
    isObject(v.backups) &&
    ["pbs-external", "pbs-vm", "nfs", "none"].includes(v.backups.target as string) &&
    strings(v.backups, ["pbsAddress", "datastore", "nfsServer", "nfsExport", "schedule", "keepLast", "keepDaily", "keepWeekly", "keepMonthly", "offsiteAddress"]) &&
    booleans(v.backups, ["encrypt", "verify", "offsite"]),

  access: (v) => isAccessPlan(v.access),

  software: (v) => isSoftwarePlan(v.software),

  install: (v) =>
    isObject(v.install) &&
    typeof v.install.bootDisk === "string" &&
    Array.isArray(v.install.bootDisks) &&
    v.install.bootDisks.every((d) => typeof d === "string"),
};

const ALL_STEPS: WizardStepId[] = SAVED_STEPS;

/** a save in this build's layout: the layout version, and a step to reopen on — its steps unchecked */
export function isSaveLayout(value: unknown): value is Loose {
  return isObject(value) && value.version === STORAGE_VERSION && ALL_STEPS.includes(value.currentStep as WizardStepId);
}

/** the first step a save can't be kept from: another version, or not the shape it should be — null if all hold */
export function firstStaleStep(value: object): SavedStepId | null {
  const v = value as Loose;
  const versions = isObject(v.stepVersions) ? v.stepVersions : {};
  return SAVED_STEPS.find((step) => versions[step] !== STEP_VERSIONS[step] || !STEP_SECTIONS[step](v)) ?? null;
}

/** a save this build takes exactly as it is — every step current and well-formed */
export function isPersistedState(value: unknown): value is PersistedState {
  return isSaveLayout(value) && firstStaleStep(value) === null;
}
