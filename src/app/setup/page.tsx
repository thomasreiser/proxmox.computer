"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import wizardSteps from "@/data/wizard-steps.json";
import nicSpeedsData from "@/data/nic-speeds.json";
import cpuVendorsData from "@/data/cpu-vendors.json";
import cpuFamiliesData from "@/data/cpu-families.json";

type CpuVendor = "intel" | "amd";
type DiskType = "nvme" | "ssd" | "hdd";
type NicSpeed = "1gbe" | "2.5gbe" | "10gbe" | "25gbe" | "other";
type WizardStepId = "hardware" | "network";

interface NicInfo {
  speed: NicSpeed;
  name: string;
}

interface AdditionalDisk {
  type: DiskType;
  sizeGb: string;
  name: string;
}

interface HardwareSpec {
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

const DISK_NAME_PRESETS = ["boot", "vm-storage", "backup", "iso", "storage-1", "storage-2", "ceph-osd-1", "ceph-osd-2"];
const NIC_NAME_PRESETS = ["onboard", "lan", "wan", "management", "storage", "cluster", "vmotion", "corosync"];

function defaultNicName(index: number): string {
  return `nic-${index + 1}`;
}

function defaultAdditionalDisk(index: number): AdditionalDisk {
  return { type: "hdd", sizeGb: "", name: `storage-${index + 1}` };
}

type InterfacePurpose = "vm" | "ceph" | "zfs" | "backup" | "cluster" | "other";

interface PurposeInfo {
  value: InterfacePurpose;
  label: string;
  // true = this purpose always needs a real host address; false = never
  // (pure vm/ct switch); null = "other" — ask the visitor directly.
  needsHostIp: boolean | null;
  hint: string;
}

const INTERFACE_PURPOSE_OPTIONS: PurposeInfo[] = [
  {
    value: "vm",
    label: "vm / container traffic",
    needsHostIp: false,
    hint: "a pure switch — vms and cts get their own ips, the host doesn't need one here",
  },
  {
    value: "ceph",
    label: "ceph / storage traffic",
    needsHostIp: true,
    hint: "the host's ceph client (and osds, if this node runs any) need a real address here",
  },
  {
    value: "zfs",
    label: "zfs replication traffic",
    needsHostIp: true,
    hint: "the host needs an address here for zfs send/receive replication to the other nodes",
  },
  {
    value: "backup",
    label: "backups",
    needsHostIp: true,
    hint: "the host needs an address here to reach the backup target",
  },
  {
    value: "cluster",
    label: "cluster sync (corosync)",
    needsHostIp: true,
    hint: "the host needs an address here for corosync ring traffic",
  },
  {
    value: "other",
    label: "other",
    needsHostIp: null,
    hint: "pick whether the node itself needs an address here",
  },
];

function purposeInfoFor(purpose: InterfacePurpose): PurposeInfo {
  return INTERFACE_PURPOSE_OPTIONS.find((p) => p.value === purpose) ?? INTERFACE_PURPOSE_OPTIONS[0];
}

// a real nic/bridge often earns its keep serving more than one purpose at
// once (vm traffic + corosync is a completely normal homelab setup) — so
// this is a set, not a single choice. it's still enforced to be non-empty
// in the UI (there's always at least one reason a bridge exists).
function needsHostIpForPurposes(purposes: InterfacePurpose[], otherNeedsHostIp: boolean): boolean {
  return purposes.some((p) => purposeInfoFor(p).needsHostIp ?? otherNeedsHostIp);
}

// combines the "why" from every selected purpose that actually requires a
// host address, so the field hint reflects all of them, not just one.
function requiredIpHintFor(purposes: InterfacePurpose[], otherNeedsHostIp: boolean): string {
  return purposes
    .map((p) => purposeInfoFor(p))
    .filter((info) => info.needsHostIp === true || (info.needsHostIp === null && otherNeedsHostIp))
    .map((info) => info.hint)
    .join("; ");
}

interface BridgeConfig {
  enabled: boolean;
  name: string;
  purposes: InterfacePurpose[];
  // only meaningful when purposes includes "other" — the answer to "does
  // the node itself need an address here?" for that one ambiguous case.
  otherNeedsHostIp: boolean;
  // a required host ip+cidr when any selected purpose needs one (ceph,
  // backups, cluster, or "other" answered yes); an optional bare
  // network/cidr — just documenting the intended vm subnet — otherwise.
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
// nic purpose below, and only matters once there's more than 1 node.
type StorageHaMode = "ceph" | "zfs-replication" | "none";

interface StorageHaInfo {
  value: StorageHaMode;
  label: string;
  hint: string;
}

const STORAGE_HA_OPTIONS: StorageHaInfo[] = [
  {
    value: "ceph",
    label: "ceph (recommended)",
    hint: "distributed storage built into proxmox — vm disks live on every node, live-migrate freely, survive a node going down",
  },
  {
    value: "zfs-replication",
    label: "zfs with replication",
    hint: "local zfs storage per node, periodically synced to the others — cheaper and simpler than ceph, but replication is scheduled, not instant, so a failover can lose a few minutes of writes",
  },
  {
    value: "none",
    label: "no ha / sync",
    hint: "each node's storage is its own island — simplest setup, but a vm doesn't survive its node going down",
  },
];

// the cluster's effective disk budget for ceph/zfs is set by its worst-
// equipped node, not any average or sum — 2 nodes with 4 disks and 1 with
// only 1 still means "1 disk" everywhere, since every node needs to pull
// the same minimal setup.
function minAdditionalDisks(nodes: NodeInfo[]): number {
  if (nodes.length === 0) return 0;
  return Math.min(...nodes.map((n) => n.additionalDisks.length));
}

// both ceph (osds) and a replicated zfs pool want storage dedicated to
// them, not the boot/root disk doing double duty — so either is only
// offered once every node has at least one disk beyond its boot disk.
function clusterStorageDisksAvailable(nodes: NodeInfo[]): boolean {
  return minAdditionalDisks(nodes) >= 1;
}

// the mode that should currently be in effect for cluster storage — falls
// back to "none" if the visitor's actual choice (ceph or zfs) needs disks
// that aren't there, without discarding that choice below: add the disks
// back and it re-selects itself.
function effectiveStorageHaMode(mode: StorageHaMode, nodes: NodeInfo[]): StorageHaMode {
  if (nodes.length < 2) return "none";
  if (mode !== "none" && !clusterStorageDisksAvailable(nodes)) return "none";
  return mode;
}

function activeStoragePurpose(mode: StorageHaMode): InterfacePurpose | null {
  if (mode === "ceph") return "ceph";
  if (mode === "zfs-replication") return "zfs";
  return null;
}

type BondMode = "active-backup" | "lacp" | "balance-alb" | "balance-rr";

interface BondConfig {
  name: string;
  mode: BondMode;
  // indices into node.nics; a bond isn't "real" until it has 2+
  nicIndices: number[];
}

const BOND_MODE_OPTIONS: { value: BondMode; label: string; hint: string }[] = [
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

function bondModeLabel(mode: BondMode): string {
  return BOND_MODE_OPTIONS.find((o) => o.value === mode)?.label ?? mode;
}

function defaultBondName(index: number): string {
  return `bond${index}`;
}

// A bond needs 2+ member nics to actually be an interface — fewer than
// that and it's still being assembled, so it doesn't count yet.
function validBonds(bonds: BondConfig[]): BondConfig[] {
  return bonds.filter((b) => b.nicIndices.length >= 2);
}

interface InterfaceRef {
  id: string; // "nic-<i>" or "bond-<i>", <i> is the index in nics/bonds
  label: string;
}

// Every selectable network interface on a node: each nic not claimed by
// a (valid) bond, plus each valid bond itself. This is what "management
// interface" and "bridge" pickers choose from — a bonded nic disappears
// from the list on its own, since it's part of its bond now, not a
// standalone interface.
function interfacesFor(nics: NicInfo[], bonds: BondConfig[]): InterfaceRef[] {
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

// Same as interfacesFor, but only the ids — used for resync bookkeeping
// where we don't have (or need) real NicInfo, just the count.
function interfaceIdsFor(nicCount: number, bonds: BondConfig[]): string[] {
  const usable = bonds.map((b, i) => ({ b, i })).filter(({ b }) => b.nicIndices.length >= 2);
  const bonded = new Set(usable.flatMap(({ b }) => b.nicIndices));
  const nicIds = Array.from({ length: nicCount }, (_, i) => i)
    .filter((i) => !bonded.has(i))
    .map((i) => `nic-${i}`);
  const bondIds = usable.map(({ i }) => `bond-${i}`);
  return [...nicIds, ...bondIds];
}

// a bridge's storage key is "<interfaceId>#<index>" — index 0 is the
// interface's native/untagged bridge, 1+ are extra vlan-tagged siblings.
function bridgeKey(interfaceId: string, index: number): string {
  return `${interfaceId}#${index}`;
}

function bridgeCountFor(bridgeCounts: Record<string, string>, interfaceId: string): number {
  const n = parseInt(bridgeCounts[interfaceId] ?? "1", 10);
  return !Number.isNaN(n) && n >= 1 && n <= 4 ? n : 1;
}

// every other vlan tag already in use on the same interface's bridges —
// used to catch two siblings accidentally claiming the same vlan.
function siblingVlanTagsFor(
  bridges: Record<string, BridgeConfig>,
  count: number,
  interfaceId: string,
  excludeIndex: number,
): string[] {
  const tags: string[] = [];
  for (let idx = 0; idx < count; idx++) {
    if (idx === excludeIndex) continue;
    const tag = bridges[bridgeKey(interfaceId, idx)]?.vlanTag;
    if (tag) tags.push(tag);
  }
  return tags;
}

interface NodeNetwork {
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

interface NodeInfo extends HardwareSpec {
  name: string;
  network: NodeNetwork;
}

// every non-empty name field on a node — boot/additional disk friendly
// names, nic friendly names, bond names, bridge names — flattened into
// one list for validateUniqueName to check for collisions across all of
// them at once, not just within each field's own category.
function collectNodeNames(node: NodeInfo): string[] {
  const names: string[] = [];
  if (node.bootDiskName) names.push(node.bootDiskName);
  for (const d of node.additionalDisks) if (d.name) names.push(d.name);
  for (const n of node.nics) if (n.name) names.push(n.name);
  for (const b of node.network.bonds) if (b.name) names.push(b.name);
  for (const b of Object.values(node.network.bridges)) if (b.name) names.push(b.name);
  return names;
}

const nicSpeedOptions = nicSpeedsData as { value: NicSpeed; label: string; hint?: string }[];
const cpuVendorOptions = cpuVendorsData as { value: CpuVendor; label: string }[];

function nicSpeedLabel(speed: NicSpeed): string {
  return nicSpeedOptions.find((o) => o.value === speed)?.label ?? speed;
}

interface CpuFamily {
  name: string;
  qemuType: string;
  from: number;
  to: number | null;
  defaultCores: number;
  note?: string;
}

interface CpuFamiliesData {
  architectures: Record<CpuVendor, CpuFamily[]>;
  cpu_types: Record<string, Record<CpuVendor, string[]>>;
}

const cpuFamilies = cpuFamiliesData as CpuFamiliesData;

function familiesByDate(vendor: CpuVendor): CpuFamily[] {
  return [...cpuFamilies.architectures[vendor]].sort((a, b) => a.from - b.from);
}

// Some display names (real chip generations, e.g. "Alder Lake") have no
// dedicated qemu cpu model — they map to the closest native qemu type.
// Resolve to that native type before comparing nodes for compatibility.
function qemuTypeFor(vendor: CpuVendor, familyName: string): string {
  const entry = cpuFamilies.architectures[vendor].find((f) => f.name === familyName);
  return entry?.qemuType ?? familyName;
}

// qemuType values carry security-mitigation suffixes (-noTSX, -IBRS,
// -IBPB) that don't represent a later hardware generation — just a
// different feature-flag preset for the same silicon. Strip them to find
// the entry that actually carries this generation's real launch dates.
function stripMitigationSuffix(qemuType: string): string {
  return qemuType.replace(/-(noTSX-IBRS|noTSX|IBRS|IBPB)$/, "");
}

function nativeEntryFor(vendor: CpuVendor, qemuType: string): CpuFamily | undefined {
  const base = stripMitigationSuffix(qemuType);
  return cpuFamilies.architectures[vendor].find((f) => f.name === base);
}

// A rough, "better than nothing" per-cpu core-count guess for a family —
// real SKUs in any given generation range widely, so this is only a
// sane starting point the visitor is expected to correct.
function defaultCoresFor(vendor: CpuVendor, familyName: string): number {
  const entry = cpuFamilies.architectures[vendor].find((f) => f.name === familyName);
  return entry?.defaultCores ?? 4;
}

// A common, broadly-compatible baseline per vendor — not the newest chip,
// but one whose migration target list (cpu_types[x]) still covers most
// hardware someone is likely to add to the cluster later.
const DEFAULT_CPU_FAMILY: Record<CpuVendor, string> = {
  intel: "Skylake-Server",
  amd: "EPYC-Rome",
};

function defaultHardware(): HardwareSpec {
  return {
    cpuVendor: "intel",
    cpuFamily: DEFAULT_CPU_FAMILY.intel,
    cpuCount: "1",
    coresPerCpu: String(defaultCoresFor("intel", DEFAULT_CPU_FAMILY.intel)),
    ramGb: "",
    bootDiskType: "nvme",
    bootDiskSizeGb: "",
    bootDiskName: "boot",
    additionalDiskCount: "0",
    additionalDisks: [],
    nicCount: "2",
    nics: [
      { speed: "1gbe", name: defaultNicName(0) },
      { speed: "1gbe", name: defaultNicName(1) },
    ],
  };
}

function isValidIPv4(ip: string): boolean {
  const parts = ip.split(".");
  if (parts.length !== 4) return false;
  return parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) >= 0 && Number(p) <= 255);
}

function parseIpv4(ip: string): number[] | null {
  if (!isValidIPv4(ip)) return null;
  return ip.split(".").map(Number);
}

function validateCidr(value: string): string | null {
  if (!value) return null;
  const [ip, prefix] = value.split("/");
  if (!ip || !prefix || !isValidIPv4(ip) || !/^\d{1,2}$/.test(prefix) || Number(prefix) > 32) {
    return "not a valid cidr — try 10.0.10.11/24";
  }
  return null;
}

interface SubnetInfo {
  network: string;
  netmask: string;
  prefix: number;
  broadcast: string;
  firstHost: string;
  lastHost: string;
  usableHosts: number;
}

function subnetDetails(cidr: string): SubnetInfo | null {
  const [ip, prefixStr] = cidr.split("/");
  const octets = parseIpv4(ip ?? "");
  const prefix = Number(prefixStr);
  if (!octets || !prefixStr || Number.isNaN(prefix) || prefix < 0 || prefix > 32) return null;

  const toUint = (a: number, b: number, c: number, d: number) => ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
  const toIp = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");

  const ipNum = toUint(octets[0], octets[1], octets[2], octets[3]);
  const maskNum = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const networkNum = (ipNum & maskNum) >>> 0;
  const broadcastNum = (networkNum | (~maskNum >>> 0)) >>> 0;

  let firstHostNum = networkNum;
  let lastHostNum = broadcastNum;
  let usableHosts: number;
  if (prefix >= 31) {
    // /31 is a point-to-point link (RFC 3021, both addresses usable);
    // /32 is a single host — neither has a separate network/broadcast.
    usableHosts = prefix === 32 ? 1 : 2;
  } else {
    firstHostNum = networkNum + 1;
    lastHostNum = broadcastNum - 1;
    usableHosts = Math.max(0, lastHostNum - firstHostNum + 1);
  }

  return {
    network: toIp(networkNum),
    netmask: toIp(maskNum),
    prefix,
    broadcast: toIp(broadcastNum),
    firstHost: toIp(firstHostNum),
    lastHost: toIp(lastHostNum),
    usableHosts,
  };
}

function validateIp(value: string): string | null {
  if (!value) return null;
  if (!isValidIPv4(value)) return "not a valid ip — try 10.0.10.1";
  return null;
}

// For purposes that need a real host address (ceph, backups, cluster
// sync, or "other" answered yes) — required, and catches the common
// mistake of typing the network's own address instead of a host on it.
function validateHostCidr(value: string): string | null {
  if (!value) return "enter this node's address here";
  const basic = validateCidr(value);
  if (basic) return basic;
  const [ip] = value.split("/");
  const info = subnetDetails(value);
  // /31 and /32 have no address set aside as "the network" or "the
  // broadcast" distinct from a usable host — every address is a host.
  if (info && info.prefix < 31 && ip === info.network) {
    return `that's the network address, not a host — try ${info.firstHost}/${info.prefix}`;
  }
  if (info && info.prefix < 31 && ip === info.broadcast) {
    return `that's the broadcast address, not a host — try ${info.lastHost}/${info.prefix}`;
  }
  return null;
}

function validateHostnameSuffix(value: string): string | null {
  if (!value) return null;
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i.test(value)) {
    return "not a valid domain — try homelab.lan";
  }
  return null;
}

// shared by node names and the per-node hostname label — proxmox/linux
// hostnames are a single dns label (RFC 1123): lowercase letters, digits
// and hyphens, can't start or end with a hyphen, 63 chars max. proxmox's
// own cluster tooling additionally requires lowercase, so that's enforced
// here too rather than silently folding case.
function validateHostLabel(value: string): string | null {
  if (!value) return null;
  if (/[A-Z]/.test(value)) return "lowercase only";
  if (value.length > 63) return "63 characters max";
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(value)) {
    return "letters, numbers and hyphens only — can't start or end with a hyphen";
  }
  return null;
}

// linux network interface names (bridges, bonds) are capped at 15 visible
// characters (IFNAMSIZ) and the kernel rejects whitespace and "/" outright
// — restricting to letters, digits, underscore and hyphen sidesteps every
// other edge case (shell quoting, sysfs paths, udev matching) too.
function validateInterfaceName(value: string): string | null {
  if (!value) return "can't be empty";
  if (value.length > 15) return "15 characters max (linux interface name limit)";
  if (!/^[a-zA-Z0-9_-]+$/.test(value)) return "letters, numbers, hyphens and underscores only";
  return null;
}

// nic/disk friendly names aren't passed to a literal syscall, but they're
// meant to double as proxmox-style identifiers in later steps — the same
// safe charset avoids a name that's fine here but breaks once it's
// actually used as one.
function validateFriendlyName(value: string): string | null {
  if (!value) return "can't be empty";
  if (value.length > 32) return "32 characters max";
  if (!/^[a-zA-Z0-9_-]+$/.test(value)) return "letters, numbers, hyphens and underscores only";
  return null;
}

// every name on a node — disk/nic friendly names, bond names, bridge
// names — shares one namespace: none of them should collide with any
// other, disk with nic, bond with bridge, or otherwise. a straight count
// across the combined list (rather than tracking each field's own
// identity) flags every field with a colliding value symmetrically.
function validateUniqueName(value: string, allNames: string[]): string | null {
  if (!value) return null;
  return allNames.filter((n) => n === value).length > 1
    ? "used more than once on this node — names must be unique"
    : null;
}

function validateIntRange(value: string, min: number, max: number, opts?: { required?: boolean }): string | null {
  if (!value) return opts?.required ? `${min}-${max}` : null;
  if (!/^-?\d+$/.test(value)) return "whole numbers only";
  const n = Number(value);
  if (n < min || n > max) return `must be between ${min} and ${max}`;
  return null;
}

// only called for a bridge that isn't index 0 of its interface — those
// share a physical nic/bond with a sibling bridge, which linux only
// allows when each one is tagged with its own vlan.
function validateVlanTag(value: string, siblingTags: string[]): string | null {
  if (!value) return "every extra bridge on the same nic/bond needs its own vlan tag";
  if (!/^\d+$/.test(value)) return "whole numbers only";
  const n = Number(value);
  if (n < 1 || n > 4094) return "must be between 1 and 4094";
  if (siblingTags.includes(value)) return "already used by another bridge on this interface — each needs a unique vlan";
  return null;
}

// A text field for anything in ip or ip/prefix notation, with a small
// toggle beside the input that expands a subnet breakdown (network,
// broadcast, usable range, host count) — collapsed by default so it
// doesn't clutter the form until someone actually wants it.
function CidrField({
  id,
  label,
  value,
  onChange,
  hint,
  error,
  placeholder,
  defaultPrefix = 24,
  required = false,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint: string;
  error: string | null;
  placeholder?: string;
  // if the visitor types a bare ip with no /prefix, we fill one in on
  // blur rather than leave it as a technically-different address. /32
  // would be the "literal" reading of a bare ip, but it means "no other
  // host shares this subnet" — wrong for a LAN-connected management ip
  // or bridge, so default to the real subnet size instead.
  defaultPrefix?: number;
  required?: boolean;
}) {
  const [showDetails, setShowDetails] = useState(false);
  // an empty field's placeholder is just an example, not a value it
  // already has — flagging it "required" in red before the visitor has
  // ever touched it reads as "this is already wrong," when really
  // nothing's been entered yet. hold off on error styling until they've
  // actually left the field once.
  const [touched, setTouched] = useState(false);
  const info = subnetDetails(value);
  const showError = touched && error;

  function handleBlur() {
    setTouched(true);
    if (isValidIPv4(value)) onChange(`${value}/${defaultPrefix}`);
  }

  return (
    <div className={`pc-field ${showError ? "pc-field--error" : ""}`}>
      <label className="label pc-field__label" htmlFor={id}>
        {label}
        {required && <span className="pc-field__required"> *</span>}
      </label>
      <div className="pc-field__control">
        <span className="code pc-field__bracket">#</span>
        <input
          id={id}
          className="pc-field__input code"
          type="text"
          placeholder={placeholder ? `e.g. ${placeholder}` : undefined}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onBlur={handleBlur}
        />
        <button
          type="button"
          className="pc-cmdline__copy"
          disabled={!info}
          onClick={() => setShowDetails((s) => !s)}
          title={info ? "show subnet details" : "enter a valid ip/prefix to see subnet details"}
        >
          i
        </button>
      </div>
      <span className="body-sm pc-field__hint">{showError ? error : hint}</span>
      {showDetails && info && (
        <div className="pc-table-wrap">
          <table className="pc-table">
            <tbody>
              <tr>
                <td className="body-sm">network</td>
                <td className="body-sm pc-table__num">{info.network}</td>
              </tr>
              <tr>
                <td className="body-sm">netmask</td>
                <td className="body-sm pc-table__num">
                  {info.netmask} (/{info.prefix})
                </td>
              </tr>
              <tr>
                <td className="body-sm">usable range</td>
                <td className="body-sm pc-table__num">
                  {info.firstHost} – {info.lastHost}
                </td>
              </tr>
              <tr>
                <td className="body-sm">broadcast</td>
                <td className="body-sm pc-table__num">{info.broadcast}</td>
              </tr>
              <tr>
                <td className="body-sm">usable hosts</td>
                <td className="body-sm pc-table__num">{info.usableHosts}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// Rough per-node defaults, derived from the global cidr — starts at .11
// so .1-.10 stay free for the gateway and other fixed infra.
function deriveNodeCidr(globalCidr: string, nodeIndex: number): string {
  const [ip, prefix] = globalCidr.split("/");
  const octets = parseIpv4(ip ?? "");
  if (!octets) return "";
  octets[3] = Math.min(254, 11 + nodeIndex);
  return `${octets.join(".")}/${prefix || "24"}`;
}

function deriveGateway(globalCidr: string): string {
  const [ip] = globalCidr.split("/");
  const octets = parseIpv4(ip ?? "");
  if (!octets) return "";
  octets[3] = 1;
  return octets.join(".");
}

// example placeholder text for a secondary bridge's network field — same
// base as the homelab cidr, but a different third octet, so it reads as
// "a different network from management" rather than a copy of it.
function deriveExampleSubnet(
  globalCidr: string,
  thirdOctetOffset: number,
  hostOctet: number = 11,
): { network: string; host: string } | null {
  const [ip, prefix] = globalCidr.split("/");
  const octets = parseIpv4(ip ?? "");
  if (!octets) return null;
  const shifted = [...octets];
  shifted[2] = (shifted[2] + thirdOctetOffset) % 256;
  const p = prefix || "24";
  return {
    network: `${shifted[0]}.${shifted[1]}.${shifted[2]}.0/${p}`,
    host: `${shifted[0]}.${shifted[1]}.${shifted[2]}.${Math.min(254, Math.max(1, hostOctet))}/${p}`,
  };
}

// every bridge that needs an example ip/network placeholder, in a stable
// order — used to give each one a distinct subnet offset (10, 20, 30...)
// so two bridges on the same node never suggest the same placeholder.
// excludes the management interface's own bridge, which has its own
// dedicated "static ip" field instead.
function addressableBridgeKeys(node: NodeInfo): string[] {
  const interfaces = interfacesFor(node.nics, node.network.bonds);
  const mgmtKey = bridgeKey(node.network.managementInterfaceId, 0);
  const keys: string[] = [];
  for (const iface of interfaces) {
    const count = bridgeCountFor(node.network.bridgeCounts, iface.id);
    for (let idx = 0; idx < count; idx++) {
      const key = bridgeKey(iface.id, idx);
      if (key !== mgmtKey) keys.push(key);
    }
  }
  return keys;
}

// a distinct example subnet for one bridge's ip placeholder — offset by
// its position among this node's other addressable bridges (so no two
// bridges on one node ever suggest the same subnet) and its host
// suggestion offset by the node's own index (so the same bridge position
// on different nodes doesn't suggest the exact same address either).
function derivePlaceholderSubnet(
  globalCidr: string,
  position: number,
  nodeIndex: number,
): { network: string; host: string } | null {
  return deriveExampleSubnet(globalCidr, 10 + position * 10, 11 + nodeIndex);
}

// every subnet already claimed on this node by a real, typed-in value —
// the management ip and every bridge's own ip/network field. placeholders
// steer clear of these, so a suggested default can never coincide with a
// subnet the visitor already assigned to a sibling bridge by hand (the
// position-based offset above only avoids collisions between OTHER
// placeholders — it has no idea what's actually been typed anywhere).
function usedNetworksForNode(node: NodeInfo): Set<string> {
  const used = new Set<string>();
  const mgmtInfo = subnetDetails(node.network.cidr);
  if (mgmtInfo) used.add(mgmtInfo.network);
  for (const bridge of Object.values(node.network.bridges)) {
    const info = subnetDetails(bridge.ip);
    if (info) used.add(info.network);
  }
  return used;
}

// derivePlaceholderSubnet's guess, nudged further along (30, 40, 50...
// more third-octet shift) past any subnet this node has already actually
// claimed, so an accepted suggestion is always genuinely free.
function nonCollidingPlaceholderSubnet(
  node: NodeInfo,
  globalCidr: string,
  basePosition: number,
  nodeIndex: number,
): { network: string; host: string } | null {
  const used = usedNetworksForNode(node);
  for (let step = 0; step < 25; step++) {
    const candidate = derivePlaceholderSubnet(globalCidr, basePosition + step, nodeIndex);
    if (!candidate) return null;
    if (!used.has(candidate.network.split("/")[0])) return candidate;
  }
  return derivePlaceholderSubnet(globalCidr, basePosition, nodeIndex);
}

type PlaceholderSubnet = { network: string; host: string };

// an ip's network address at a GIVEN prefix, ignoring whatever prefix the
// value itself was typed with. a bare host route like a /32 has no
// meaningful "network" of its own (subnetDetails would just return the ip
// itself) — what we actually want is "the /lanPrefix block this address
// would sit in if it were on a normal subnet", so every /32 for the same
// purpose (corosync, backup, ceph...) normalizes to the same bucket
// regardless of the exact prefix each one happened to be typed with.
function networkAtPrefix(ip: string, prefix: number): string | null {
  const octets = parseIpv4(ip);
  if (!octets) return null;
  const toUint = (a: number, b: number, c: number, d: number) => ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
  const toIp = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
  const maskNum = prefix <= 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return toIp((toUint(octets[0], octets[1], octets[2], octets[3]) & maskNum) >>> 0);
}

// the /lanPrefix block an earlier node already gave this exact bridge (by
// key) — a corosync/backup/ceph-style bridge only works when every node
// sits on the identical network, so once any node has a real address for
// it, every other node's placeholder for the same bridge must reuse that
// block instead of recomputing its own independent guess (which drifts
// the moment that node deviates from the suggested default — e.g. packing
// several purposes into one /24 as individual /32 host routes).
function referenceNetworkForBridge(nodes: NodeInfo[], key: string, prefix: number): string | null {
  for (const n of nodes) {
    const [ip] = (n.network.bridges[key]?.ip ?? "").split("/");
    const net = ip ? networkAtPrefix(ip, prefix) : null;
    if (net) return net;
  }
  return null;
}

// the next free host address in a /lanPrefix block, skipping the network/
// broadcast ends (assumed /24-sized, same simplification the rest of this
// file's placeholder logic already makes) and anything already reserved.
function nextFreeHostInNetwork(networkAddress: string, reserved: Set<string>): string {
  const [a, b, c] = networkAddress.split(".").map(Number);
  for (let host = 1; host <= 254; host++) {
    const candidate = `${a}.${b}.${c}.${host}`;
    if (candidate !== networkAddress && !reserved.has(candidate)) return candidate;
  }
  return `${a}.${b}.${c}.1`;
}

// one pass over every node's every bridge, computing a placeholder for
// anything left empty. a bridge whose key already has a real address on
// some node reuses that node's /lanPrefix block, handing out the next
// free host in it; everything else falls back to
// nonCollidingPlaceholderSubnet's own per-node position offset. host
// addresses are reserved as they're handed out — real values first, then
// placeholders in node/bridge order — so no two empty fields anywhere in
// the cluster, sharing a block or not, ever suggest the same address.
function buildPlaceholderTable(nodes: NodeInfo[], globalCidr: string): Map<string, PlaceholderSubnet> {
  const prefix = subnetDetails(globalCidr)?.prefix ?? 24;
  const table = new Map<string, PlaceholderSubnet>();
  const reservedByNetwork = new Map<string, Set<string>>();
  const reserve = (networkAddress: string, host: string) => {
    let set = reservedByNetwork.get(networkAddress);
    if (!set) {
      set = new Set();
      reservedByNetwork.set(networkAddress, set);
    }
    set.add(host);
  };

  for (const n of nodes) {
    const [mgmtIp] = n.network.cidr.split("/");
    const mgmtNet = mgmtIp ? networkAtPrefix(mgmtIp, prefix) : null;
    if (mgmtNet) reserve(mgmtNet, mgmtIp);
    for (const bridge of Object.values(n.network.bridges)) {
      const [ip] = bridge.ip.split("/");
      const net = ip ? networkAtPrefix(ip, prefix) : null;
      if (net) reserve(net, ip);
    }
  }

  nodes.forEach((n, nodeIndex) => {
    addressableBridgeKeys(n).forEach((key, position) => {
      const bridge = n.network.bridges[key];
      if (!bridge || !bridge.enabled || bridge.ip) return;
      const reference = referenceNetworkForBridge(nodes, key, prefix);
      if (reference) {
        // a "network (optional)" field never shows a host suggestion, so
        // only reserve one when this bridge actually needs a real address
        // — otherwise it'd burn a host no field displays, pushing every
        // later bridge's suggestion further out than it needs to be.
        const needsHost = needsHostIpForPurposes(bridge.purposes, bridge.otherNeedsHostIp);
        const host = needsHost ? nextFreeHostInNetwork(reference, reservedByNetwork.get(reference) ?? new Set<string>()) : "";
        if (needsHost) reserve(reference, host);
        table.set(`${nodeIndex}#${key}`, {
          network: `${reference}/${prefix}`,
          host: `${host || reference}/${prefix}`,
        });
        return;
      }
      const subnet = nonCollidingPlaceholderSubnet(n, globalCidr, position, nodeIndex);
      if (subnet) {
        const info = subnetDetails(subnet.host);
        if (info) reserve(info.network, subnet.host.split("/")[0]);
        table.set(`${nodeIndex}#${key}`, subnet);
      }
    });
  });

  return table;
}

// an ip/cidr value's address range as [start, end] uint32s — lets two
// values of different prefixes (a /32 host route and a /24 network, say)
// be checked for overlap correctly, not just string-compared.
function cidrRange(value: string): { start: number; end: number } | null {
  const info = subnetDetails(value);
  if (!info) return null;
  const octets = parseIpv4(info.network);
  if (!octets) return null;
  const start = ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0;
  const hostBits = 32 - info.prefix;
  const size = hostBits <= 0 ? 0 : hostBits >= 32 ? 0xffffffff : 2 ** hostBits - 1;
  return { start, end: (start + size) >>> 0 };
}

function rangesOverlap(a: { start: number; end: number }, b: { start: number; end: number }): boolean {
  return a.start <= b.end && b.start <= a.end;
}

interface AddressClaim {
  nodeIndex: number;
  key: string;
  label: string;
  ip: string;
  range: { start: number; end: number };
}

// every real (non-empty, valid) address claim across the whole cluster —
// the management ip and every bridge's own ip/network field, on every
// node. used to check for exact duplicates and same-node overlaps below.
function collectAddressClaims(nodes: NodeInfo[]): AddressClaim[] {
  const claims: AddressClaim[] = [];
  nodes.forEach((n, nodeIndex) => {
    const [mgmtIp] = n.network.cidr.split("/");
    const mgmtRange = cidrRange(n.network.cidr);
    if (mgmtIp && mgmtRange) claims.push({ nodeIndex, key: "mgmt", label: "static ip", ip: mgmtIp, range: mgmtRange });
    for (const [key, bridge] of Object.entries(n.network.bridges)) {
      const [ip] = bridge.ip.split("/");
      const range = cidrRange(bridge.ip);
      if (ip && range) claims.push({ nodeIndex, key, label: bridge.name, ip, range });
    }
  });
  return claims;
}

// flags two kinds of real (not placeholder) address problems:
//  1. the exact same address claimed twice, anywhere in the cluster — two
//     interfaces can never share one host ip, full stop.
//  2. two of the SAME node's own claims whose ranges overlap — one sitting
//     inside the other's declared network, say — because a single node
//     can't cleanly route between two interfaces both claiming the same
//     address space. sharing a subnet ACROSS different nodes for the same
//     bridge (corosync, backup, ceph...) is by design and left alone.
function buildAddressConflicts(nodes: NodeInfo[]): Map<string, string> {
  const conflicts = new Map<string, string>();
  const claims = collectAddressClaims(nodes);
  const nodeLabel = (i: number) => nodes[i]?.network.hostLabel || `node ${i + 1}`;
  const setIfAbsent = (claimKey: string, message: string) => {
    if (!conflicts.has(claimKey)) conflicts.set(claimKey, message);
  };

  for (let i = 0; i < claims.length; i++) {
    for (let j = i + 1; j < claims.length; j++) {
      const a = claims[i];
      const b = claims[j];
      if (a.ip === b.ip) {
        const onOtherNode = a.nodeIndex !== b.nodeIndex;
        setIfAbsent(
          `${a.nodeIndex}#${a.key}`,
          `same address as ${b.label}${onOtherNode ? ` on ${nodeLabel(b.nodeIndex)}` : ""} — every interface needs its own`,
        );
        setIfAbsent(
          `${b.nodeIndex}#${b.key}`,
          `same address as ${a.label}${onOtherNode ? ` on ${nodeLabel(a.nodeIndex)}` : ""} — every interface needs its own`,
        );
        continue;
      }
      if (a.nodeIndex !== b.nodeIndex) continue;
      if (rangesOverlap(a.range, b.range)) {
        setIfAbsent(`${a.nodeIndex}#${a.key}`, `overlaps ${b.label}'s network — give it its own, non-overlapping range`);
        setIfAbsent(`${b.nodeIndex}#${b.key}`, `overlaps ${a.label}'s network — give it its own, non-overlapping range`);
      }
    }
  }

  return conflicts;
}

// vmbr0 is always the management bridge, by convention. Every other
// interface defaults to bridged too (vmbr1, vmbr2, ...) and defaults to
// "vm traffic" purpose — an unused interface does nothing for a wizard
// whose whole point is "get a working homelab with minimal back-and-
// forth", so bridging what's there is the useful default.
// numbers every bridge slot (management #0 gets vmbr0; everything else —
// including a second/third bridge on the same interface — is numbered in
// order) and defaults index 0 of each interface to untagged, index 1+ to
// an empty (still-to-fill-in) vlan tag.
function defaultBridgesForIds(
  ids: string[],
  managementInterfaceId: string,
  bridgeCounts: Record<string, string>,
): Record<string, BridgeConfig> {
  let seq = 0;
  const result: Record<string, BridgeConfig> = {};
  for (const id of ids) {
    const count = bridgeCountFor(bridgeCounts, id);
    for (let index = 0; index < count; index++) {
      const key = bridgeKey(id, index);
      const name = id === managementInterfaceId && index === 0 ? "vmbr0" : `vmbr${++seq}`;
      result[key] = { enabled: true, name, purposes: ["vm"], otherNeedsHostIp: false, ip: "", vlanTag: "" };
    }
  }
  return result;
}

function defaultNodeNetwork(nodeName: string, nicCount: number, globalCidr: string, nodeIndex: number): NodeNetwork {
  const ids = interfaceIdsFor(nicCount, []);
  const mgmt = ids[0] ?? "nic-0";
  const bridgeCounts = Object.fromEntries(ids.map((id) => [id, "1"]));
  return {
    hostLabel: nodeName,
    cidr: deriveNodeCidr(globalCidr, nodeIndex),
    bondCount: "0",
    bonds: [],
    managementInterfaceId: mgmt,
    bridgeCounts,
    bridges: defaultBridgesForIds(ids, mgmt, bridgeCounts),
  };
}

function defaultNode(index: number, globalCidr: string): NodeInfo {
  const name = `pve0${index + 1}`;
  const hardware = defaultHardware();
  return {
    name,
    ...hardware,
    network: defaultNodeNetwork(name, hardware.nics.length, globalCidr, index),
  };
}

function resizeArray<T>(arr: T[], length: number, make: (i: number) => T): T[] {
  if (length === arr.length) return arr;
  if (length < arr.length) return arr.slice(0, length);
  return [...arr, ...Array.from({ length: length - arr.length }, (_, i) => make(arr.length + i))];
}

// Keep a node's network config consistent after its nic count, bonds, or
// management interface change — drop bond members that no longer exist,
// reclamp the management interface, and regenerate bridge defaults for
// the resulting interface set. This intentionally regenerates bridges
// from scratch on every structural change (same policy the rest of this
// wizard already uses for hardware changes) rather than trying to
// preserve customizations across a change to what interfaces even exist.
function resyncNetworkForNics(
  network: NodeNetwork,
  nicCount: number,
  opts?: { managementInterfaceId?: string; bonds?: BondConfig[] },
): NodeNetwork {
  const bonds = (opts?.bonds ?? network.bonds).map((b) => ({
    ...b,
    nicIndices: b.nicIndices.filter((idx) => idx < nicCount),
  }));
  const ids = interfaceIdsFor(nicCount, bonds);
  const requested = opts?.managementInterfaceId ?? network.managementInterfaceId;
  const mgmt = ids.includes(requested) ? requested : (ids[0] ?? "nic-0");
  // carries forward how many bridges each surviving interface id had;
  // an id that's new (or didn't exist before) starts at 1.
  const bridgeCounts = Object.fromEntries(ids.map((id) => [id, network.bridgeCounts[id] ?? "1"]));
  return {
    ...network,
    bonds,
    bondCount: String(bonds.length),
    managementInterfaceId: mgmt,
    bridgeCounts,
    bridges: defaultBridgesForIds(ids, mgmt, bridgeCounts),
  };
}

// copies just the *structural* shape of one node's network onto every
// node — bond composition/mode/names, which interface is management, and
// each bridge's purposes/enabled/name/otherNeedsHostIp. hostLabel, cidr
// and every bridge's own ip are never touched here; those stay unique per
// node even when "identical network setup" is on.
function applyNetworkStructure(nodes: NodeInfo[], template: NodeNetwork): NodeInfo[] {
  return nodes.map((node) => {
    const resynced = resyncNetworkForNics(node.network, node.nics.length, {
      managementInterfaceId: template.managementInterfaceId,
      bonds: template.bonds.map((b) => ({ ...b })),
    });
    // resyncNetworkForNics only carries forward this node's own prior
    // bridge counts — re-derive from the template's instead (for
    // whichever interface ids this node actually has), so an extra
    // bridge set up on the template node gets created here too.
    const ids = Object.keys(resynced.bridgeCounts);
    const bridgeCounts = Object.fromEntries(ids.map((id) => [id, template.bridgeCounts[id] ?? "1"]));
    const bridges = Object.fromEntries(
      Object.entries(defaultBridgesForIds(ids, resynced.managementInterfaceId, bridgeCounts)).map(([key, bridge]) => {
        const t = template.bridges[key];
        return [
          key,
          t
            ? {
                ...bridge,
                purposes: [...t.purposes],
                enabled: t.enabled,
                name: t.name,
                otherNeedsHostIp: t.otherNeedsHostIp,
                vlanTag: t.vlanTag,
              }
            : bridge,
        ];
      }),
    );
    return { ...node, network: { ...resynced, bridgeCounts, bridges } };
  });
}

// strips any of the given purposes from every bridge on every node —
// used when something upstream (node count dropping below 2, switching
// the storage/ha decision, zfs losing its disks) makes a purpose no
// longer offered, so state doesn't silently keep a selection the ui has
// no way left to show or edit.
function withoutPurposes(nodes: NodeInfo[], toStrip: InterfacePurpose[]): NodeInfo[] {
  if (toStrip.length === 0) return nodes;
  return nodes.map((node) => {
    let changed = false;
    const nextBridges: Record<string, BridgeConfig> = {};
    for (const [id, bridge] of Object.entries(node.network.bridges)) {
      if (!bridge.purposes.some((p) => toStrip.includes(p))) {
        nextBridges[id] = bridge;
        continue;
      }
      changed = true;
      const purposes = bridge.purposes.filter((p) => !toStrip.includes(p));
      nextBridges[id] = { ...bridge, purposes: purposes.length > 0 ? purposes : ["vm"] };
    }
    return changed ? { ...node, network: { ...node.network, bridges: nextBridges } } : node;
  });
}

// the lowest-numbered vmbrN not already in use — for naming a freshly
// added bridge without colliding with any existing one.
function nextVmbrName(bridges: Record<string, BridgeConfig>): string {
  const used = new Set(
    Object.values(bridges)
      .map((b) => /^vmbr(\d+)$/.exec(b.name)?.[1])
      .filter((n): n is string => n !== undefined)
      .map(Number),
  );
  let n = 0;
  while (used.has(n)) n++;
  return `vmbr${n}`;
}

interface Hint {
  tone: "info" | "success" | "warning" | "danger";
  glyph: string;
  text: string;
}

function quorumHintFor(nodeCountValue: number): Hint {
  if (nodeCountValue <= 1) {
    return { tone: "info", glyph: "#", text: "1 node runs standalone — no cluster, so quorum doesn't apply." };
  }
  if (nodeCountValue === 2) {
    return {
      tone: "warning",
      glyph: "!",
      text: "2 nodes doesn't get automatic quorum. Add a qdevice on a third machine, or plan on a real 3rd node.",
    };
  }
  return { tone: "success", glyph: "✓", text: `${nodeCountValue} nodes gets automatic quorum.` };
}

function cpuHintFor(nodes: NodeInfo[]): Hint | null {
  if (nodes.length < 2) return null;

  const vendors = new Set(nodes.map((n) => n.cpuVendor));
  if (vendors.size > 1) {
    return {
      tone: "warning",
      glyph: "!",
      text: "Nodes mix intel and amd cpus. Most vm cpu types can't live-migrate across vendors — pin those vms to matching-vendor nodes, or use a generic baseline like qemu64 if you need full mobility.",
    };
  }

  const vendor = nodes[0].cpuVendor;
  // Different display names can still be the same effective cpu — "Alder
  // Lake" and "Rocket Lake" both resolve to the qemu type Icelake-Client —
  // so compare on the resolved type, not the raw selection.
  const resolvedTypes = Array.from(new Set(nodes.map((n) => qemuTypeFor(n.cpuVendor, n.cpuFamily))));
  if (resolvedTypes.length === 1) {
    return {
      tone: "success",
      glyph: "✓",
      text: `All ${nodes.length} nodes resolve to the same effective cpu type (${resolvedTypes[0]}) — live migration works everywhere.`,
    };
  }

  const dated = resolvedTypes
    .map((t) => nativeEntryFor(vendor, t))
    .filter((f): f is CpuFamily => Boolean(f))
    .sort((a, b) => a.from - b.from);
  const oldest = dated[0];
  const newest = dated[dated.length - 1];
  return {
    tone: "warning",
    glyph: "!",
    text: `Effective cpu types range from ${oldest.name} (${oldest.from}) to ${newest.name} (${newest.from}). Set vm cpu type to ${oldest.name} so vms can migrate to every node.`,
  };
}

// not every combination of purposes on one bridge makes sense — ceph in
// particular wants a dedicated, uncontended link, so flag it the moment
// it's sharing with anything else rather than silently accepting it.
function purposeComboHint(purposes: InterfacePurpose[]): Hint | null {
  if (purposes.length < 2) return null;
  if (purposes.includes("ceph")) {
    return {
      tone: "warning",
      glyph: "!",
      text: "it's recommended to not share the ceph nic with any other service — no corosync, no vm traffic, no backups. ceph is latency- and bandwidth-sensitive, and contention here shows up as cluster-wide storage slowdowns.",
    };
  }
  if (purposes.includes("zfs")) {
    return {
      tone: "warning",
      glyph: "!",
      text: "it's recommended to not share the zfs replication nic with any other service — a replication job can saturate the link and delay whatever else depends on it.",
    };
  }
  if (purposes.includes("cluster") && purposes.includes("backup")) {
    return {
      tone: "warning",
      glyph: "!",
      text: "corosync is latency-sensitive — a large backup transfer saturating this same link can delay corosync heartbeats enough to trigger a false quorum loss.",
    };
  }
  return null;
}

function bridgesWithPurpose(bridges: Record<string, BridgeConfig>, purpose: InterfacePurpose): boolean {
  return Object.values(bridges).some((b) => b.enabled && b.purposes.includes(purpose));
}

// without a vm/ct bridge this node literally can't host anything — that's
// a hard problem, not a style preference, so it gets the strongest tone.
function vmTrafficHintFor(bridges: Record<string, BridgeConfig>): Hint | null {
  if (bridgesWithPurpose(bridges, "vm")) return null;
  return {
    tone: "danger",
    glyph: "✗",
    text: "no nic on this node is set up for vm/container traffic — it won't be able to host any vms or cts until one is.",
  };
}

function backupHintFor(bridges: Record<string, BridgeConfig>): Hint | null {
  if (bridgesWithPurpose(bridges, "backup")) return null;
  return {
    tone: "warning",
    glyph: "!",
    text: "no nic on this node is set up for backups — decide how it'll reach a backup target (e.g. pbs) before it goes into production.",
  };
}

// corosync only matters once there's a cluster to sync — a single
// standalone node has nothing to warn about here.
function corosyncHintFor(bridges: Record<string, BridgeConfig>, nodeCount: number): Hint | null {
  if (nodeCount < 2) return null;
  if (bridgesWithPurpose(bridges, "cluster")) return null;
  return {
    tone: "warning",
    glyph: "!",
    text: "no nic on this node is set up for cluster sync (corosync) — it'll fall back to riding on the management bridge, which works but gives corosync no isolation from vm traffic.",
  };
}

// enforces the storage/ha decision made at the top of this step — whichever
// of ceph/zfs was chosen needs an actual nic carrying it on every node, or
// the decision is meaningless.
function storageHaHintFor(bridges: Record<string, BridgeConfig>, storagePurpose: InterfacePurpose | null): Hint | null {
  if (storagePurpose === null) return null;
  if (bridgesWithPurpose(bridges, storagePurpose)) return null;
  const label = storagePurpose === "ceph" ? "ceph" : "zfs replication";
  return {
    tone: "danger",
    glyph: "✗",
    text: `you chose ${label} for cluster storage above, but no nic on this node is set up for ${label} traffic — pick one below.`,
  };
}

function DiskTypeRadioGroup({
  name,
  legend,
  value,
  onChange,
  hddHint,
}: {
  name: string;
  legend: string;
  value: DiskType;
  onChange: (type: DiskType) => void;
  hddHint?: string;
}) {
  return (
    <fieldset className="pc-radio-group" style={{ border: 0, margin: 0, padding: 0 }}>
      <legend className="label pc-radio-group__legend">{legend}</legend>
      <label className="pc-radio">
        <input type="radio" name={name} checked={value === "nvme"} onChange={() => onChange("nvme")} />
        <span className="pc-radio__box" />
        <span className="code pc-radio__label">nvme</span>
      </label>
      <label className="pc-radio">
        <input type="radio" name={name} checked={value === "ssd"} onChange={() => onChange("ssd")} />
        <span className="pc-radio__box" />
        <span className="code pc-radio__label">sata ssd</span>
      </label>
      <label className="pc-radio">
        <input type="radio" name={name} checked={value === "hdd"} onChange={() => onChange("hdd")} />
        <span className="pc-radio__box" />
        {hddHint ? (
          <span>
            <span className="code pc-radio__label">hdd</span>
            <span className="body-sm pc-checkbox__hint">{hddHint}</span>
          </span>
        ) : (
          <span className="code pc-radio__label">hdd</span>
        )}
      </label>
    </fieldset>
  );
}

function HardwareFields({
  keyPrefix,
  values,
  allNames,
  onChange,
  onNicCountChange,
  onNicChange,
  onAdditionalDiskCountChange,
  onAdditionalDiskChange,
}: {
  keyPrefix: string;
  values: HardwareSpec;
  // every name already in use on this node (disks, nics, bonds, bridges)
  // — including this node's own current values — so a field can tell
  // whether ITS value collides with anything else, itself included.
  allNames: string[];
  onChange: (patch: Partial<HardwareSpec>) => void;
  onNicCountChange: (value: string) => void;
  onNicChange: (nicIndex: number, patch: Partial<NicInfo>) => void;
  onAdditionalDiskCountChange: (value: string) => void;
  onAdditionalDiskChange: (diskIndex: number, patch: Partial<AdditionalDisk>) => void;
}) {
  const selectedFamily = familiesByDate(values.cpuVendor).find((f) => f.name === values.cpuFamily);
  const cpuCountError = validateIntRange(values.cpuCount, 1, 8, { required: true });
  const coresPerCpuError = validateIntRange(values.coresPerCpu, 1, 256, { required: true });
  const ramGbError = validateIntRange(values.ramGb, 1, 16384, { required: true });
  const bootDiskSizeError = validateIntRange(values.bootDiskSizeGb, 8, 1048576, { required: true });
  const bootDiskNameError = validateFriendlyName(values.bootDiskName) ?? validateUniqueName(values.bootDiskName, allNames);
  const additionalDiskCountError = validateIntRange(values.additionalDiskCount, 0, 12);
  const nicCountError = validateIntRange(values.nicCount, 1, 8, { required: true });
  // bootDiskSizeGb and each additional disk's sizeGb start out empty and
  // are now required — flagging that red before the visitor has typed
  // anything would repeat the same "already wrong" confusion CidrField
  // had, so hold off on error styling until each field's been left once.
  const [sizeTouched, setSizeTouched] = useState<Record<string, boolean>>({});
  const markSizeTouched = (field: string) => setSizeTouched((t) => ({ ...t, [field]: true }));
  const showRamGbError = sizeTouched.ram && ramGbError;
  const showBootDiskSizeError = sizeTouched.boot && bootDiskSizeError;

  return (
    <>
      <fieldset className="pc-radio-group" style={{ border: 0, margin: 0, padding: 0 }}>
        <legend className="label pc-radio-group__legend">cpu vendor</legend>
        {cpuVendorOptions.map((opt) => (
          <label key={opt.value} className="pc-radio">
            <input
              type="radio"
              name={`cpu-${keyPrefix}`}
              checked={values.cpuVendor === opt.value}
              onChange={() =>
                onChange({
                  cpuVendor: opt.value,
                  cpuFamily: DEFAULT_CPU_FAMILY[opt.value],
                  coresPerCpu: String(defaultCoresFor(opt.value, DEFAULT_CPU_FAMILY[opt.value])),
                })
              }
            />
            <span className="pc-radio__box" />
            <span className="code pc-radio__label">{opt.label}</span>
          </label>
        ))}
      </fieldset>

      <div className="pc-field">
        <label className="label pc-field__label" htmlFor={`cpufamily-${keyPrefix}`}>
          cpu family
        </label>
        <div className="pc-field__control">
          <span className="code pc-field__bracket">--cpu</span>
          <select
            id={`cpufamily-${keyPrefix}`}
            className="pc-field__input code"
            value={values.cpuFamily}
            onChange={(e) =>
              onChange({
                cpuFamily: e.target.value,
                coresPerCpu: String(defaultCoresFor(values.cpuVendor, e.target.value)),
              })
            }
          >
            {familiesByDate(values.cpuVendor).map((fam) => (
              <option key={fam.name} value={fam.name}>
                {fam.name} ({fam.from}–{fam.to ?? "now"})
              </option>
            ))}
          </select>
        </div>
        <span className="body-sm pc-field__hint">
          {selectedFamily && selectedFamily.qemuType !== selectedFamily.name
            ? `${selectedFamily.note ? selectedFamily.note + " — " : ""}uses qemu type "${selectedFamily.qemuType}"`
            : "the physical cpu generation in this node — used to keep live migration working across the cluster"}
        </span>
      </div>

      <div className={`pc-field ${cpuCountError ? "pc-field--error" : ""}`}>
        <label className="label pc-field__label" htmlFor={`cpucount-${keyPrefix}`}>
          number of cpus
          <span className="pc-field__required"> *</span>
        </label>
        <div className="pc-field__control">
          <input
            id={`cpucount-${keyPrefix}`}
            className="pc-field__input code"
            type="number"
            min={1}
            max={8}
            value={values.cpuCount}
            onChange={(e) => onChange({ cpuCount: e.target.value })}
          />
        </div>
        <span className="body-sm pc-field__hint">
          {cpuCountError ?? "physical sockets — almost always 1 for a homelab node"}
        </span>
      </div>

      <div className={`pc-field ${coresPerCpuError ? "pc-field--error" : ""}`}>
        <label className="label pc-field__label" htmlFor={`corespercpu-${keyPrefix}`}>
          cores per cpu
          <span className="pc-field__required"> *</span>
        </label>
        <div className="pc-field__control">
          <input
            id={`corespercpu-${keyPrefix}`}
            className="pc-field__input code"
            type="number"
            min={1}
            value={values.coresPerCpu}
            onChange={(e) => onChange({ coresPerCpu: e.target.value })}
          />
        </div>
        <span className="body-sm pc-field__hint">
          {coresPerCpuError ??
            `rough default for ${selectedFamily?.name ?? "this family"} — check your actual spec sheet and correct it`}
        </span>
      </div>

      <div className={`pc-field ${showRamGbError ? "pc-field--error" : ""}`}>
        <label className="label pc-field__label" htmlFor={`ram-${keyPrefix}`}>
          memory (gb)
          <span className="pc-field__required"> *</span>
        </label>
        <div className="pc-field__control">
          <input
            id={`ram-${keyPrefix}`}
            className="pc-field__input code"
            type="number"
            min={1}
            placeholder="e.g. 64"
            value={values.ramGb}
            onChange={(e) => onChange({ ramGb: e.target.value })}
            onBlur={() => markSizeTouched("ram")}
          />
        </div>
        <span className="body-sm pc-field__hint">{showRamGbError ? ramGbError : "total installed memory"}</span>
      </div>

      <DiskTypeRadioGroup
        name={`boot-${keyPrefix}`}
        legend="boot disk type"
        value={values.bootDiskType}
        onChange={(type) => onChange({ bootDiskType: type })}
        hddHint="works, but installs and updates will be slower"
      />

      <div className={`pc-field ${showBootDiskSizeError ? "pc-field--error" : ""}`}>
        <label className="label pc-field__label" htmlFor={`bootsize-${keyPrefix}`}>
          boot disk size (gb)
          <span className="pc-field__required"> *</span>
        </label>
        <div className="pc-field__control">
          <input
            id={`bootsize-${keyPrefix}`}
            className="pc-field__input code"
            type="number"
            min={8}
            placeholder="e.g. 256"
            value={values.bootDiskSizeGb}
            onChange={(e) => onChange({ bootDiskSizeGb: e.target.value })}
            onBlur={() => markSizeTouched("boot")}
          />
        </div>
        <span className="body-sm pc-field__hint">
          {showBootDiskSizeError ? bootDiskSizeError : "just the proxmox install disk — storage pool disks come later"}
        </span>
      </div>

      <div className={`pc-field ${bootDiskNameError ? "pc-field--error" : ""}`}>
        <label className="label pc-field__label" htmlFor={`bootname-${keyPrefix}`}>
          boot disk friendly name
          <span className="pc-field__required"> *</span>
        </label>
        <div className="pc-field__control">
          <span className="code pc-field__bracket">$</span>
          <input
            id={`bootname-${keyPrefix}`}
            className="pc-field__input code"
            type="text"
            list={`disk-presets-${keyPrefix}`}
            value={values.bootDiskName}
            onChange={(e) => onChange({ bootDiskName: e.target.value })}
          />
        </div>
        <span className="body-sm pc-field__hint">
          {bootDiskNameError ?? "how this disk is labeled in later steps, instead of the raw device path"}
        </span>
      </div>

      <div className={`pc-field ${additionalDiskCountError ? "pc-field--error" : ""}`}>
        <label className="label pc-field__label" htmlFor={`extradiskcount-${keyPrefix}`}>
          number of additional disks
        </label>
        <div className="pc-field__control">
          <input
            id={`extradiskcount-${keyPrefix}`}
            className="pc-field__input code"
            type="number"
            min={0}
            max={12}
            value={values.additionalDiskCount}
            onChange={(e) => onAdditionalDiskCountChange(e.target.value)}
            onBlur={() => {
              if (!values.additionalDiskCount) onAdditionalDiskCountChange("0");
            }}
          />
        </div>
        <span className="body-sm pc-field__hint">
          {additionalDiskCountError ?? "disks beyond the boot disk — for a zfs/ceph storage pool later — 0 if none"}
        </span>
      </div>

      {values.additionalDisks.map((disk, j) => {
        const diskSizeError = validateIntRange(disk.sizeGb, 1, 1048576, { required: true });
        const showDiskSizeError = sizeTouched[`disk-${j}`] && diskSizeError;
        const diskNameError = validateFriendlyName(disk.name) ?? validateUniqueName(disk.name, allNames);
        return (
          <div key={j} className="flex flex-col" style={{ gap: "var(--space-3)" }}>
            <p className="label text-ink-muted">additional disk {j + 1}</p>
            <DiskTypeRadioGroup
              name={`extradisktype-${keyPrefix}-${j}`}
              legend="disk type"
              value={disk.type}
              onChange={(type) => onAdditionalDiskChange(j, { type })}
            />
            <div className={`pc-field ${showDiskSizeError ? "pc-field--error" : ""}`}>
              <label className="label pc-field__label" htmlFor={`extradisksize-${keyPrefix}-${j}`}>
                size (gb)
                <span className="pc-field__required"> *</span>
              </label>
              <div className="pc-field__control">
                <input
                  id={`extradisksize-${keyPrefix}-${j}`}
                  className="pc-field__input code"
                  type="number"
                  min={1}
                  placeholder="e.g. 2000"
                  value={disk.sizeGb}
                  onChange={(e) => onAdditionalDiskChange(j, { sizeGb: e.target.value })}
                  onBlur={() => markSizeTouched(`disk-${j}`)}
                />
              </div>
              <span className="body-sm pc-field__hint">
                {showDiskSizeError ? diskSizeError : "raw size — actual usable space depends on the storage layout you pick later"}
              </span>
            </div>
            <div className={`pc-field ${diskNameError ? "pc-field--error" : ""}`}>
              <label className="label pc-field__label" htmlFor={`extradiskname-${keyPrefix}-${j}`}>
                friendly name
                <span className="pc-field__required"> *</span>
              </label>
              <div className="pc-field__control">
                <span className="code pc-field__bracket">$</span>
                <input
                  id={`extradiskname-${keyPrefix}-${j}`}
                  className="pc-field__input code"
                  type="text"
                  list={`disk-presets-${keyPrefix}`}
                  value={disk.name}
                  onChange={(e) => onAdditionalDiskChange(j, { name: e.target.value })}
                />
              </div>
              <span className="body-sm pc-field__hint">
                {diskNameError ?? "how this disk is labeled in later steps, instead of the raw device path"}
              </span>
            </div>
          </div>
        );
      })}
      <datalist id={`disk-presets-${keyPrefix}`}>
        {DISK_NAME_PRESETS.map((preset) => (
          <option key={preset} value={preset} />
        ))}
      </datalist>

      <div className={`pc-field ${nicCountError ? "pc-field--error" : ""}`}>
        <label className="label pc-field__label" htmlFor={`niccount-${keyPrefix}`}>
          number of nics
          <span className="pc-field__required"> *</span>
        </label>
        <div className="pc-field__control">
          <input
            id={`niccount-${keyPrefix}`}
            className="pc-field__input code"
            type="number"
            min={1}
            max={8}
            value={values.nicCount}
            onChange={(e) => onNicCountChange(e.target.value)}
          />
        </div>
        <span className="body-sm pc-field__hint">{nicCountError ?? "physical network ports on this node"}</span>
      </div>

      {values.nics.map((nic, j) => {
        // unlike disk names (which map to a storage id — zfs/lvm/proxmox
        // all tolerate 32+ chars), a nic's friendly name is exactly the
        // kind of label that ends up as a real `ip link` rename or a
        // udev .link Name= — so it's held to the actual linux ifname
        // limit, not the looser storage-id one.
        const nicNameError = validateInterfaceName(nic.name) ?? validateUniqueName(nic.name, allNames);
        return (
          <div key={j} className="flex flex-col" style={{ gap: "var(--space-3)" }}>
            <p className="label text-ink-muted">nic {j + 1}</p>
            <fieldset className="pc-radio-group" style={{ border: 0, margin: 0, padding: 0 }}>
              <legend className="label pc-radio-group__legend">speed</legend>
              {nicSpeedOptions.map((opt) => (
                <label key={opt.value} className="pc-radio">
                  <input
                    type="radio"
                    name={`nic-${keyPrefix}-${j}`}
                    checked={nic.speed === opt.value}
                    onChange={() => onNicChange(j, { speed: opt.value })}
                  />
                  <span className="pc-radio__box" />
                  {opt.hint ? (
                    <span>
                      <span className="code pc-radio__label">{opt.label}</span>
                      <span className="body-sm pc-checkbox__hint">{opt.hint}</span>
                    </span>
                  ) : (
                    <span className="code pc-radio__label">{opt.label}</span>
                  )}
                </label>
              ))}
            </fieldset>
            <div className={`pc-field ${nicNameError ? "pc-field--error" : ""}`}>
              <label className="label pc-field__label" htmlFor={`nicname-${keyPrefix}-${j}`}>
                friendly name
                <span className="pc-field__required"> *</span>
              </label>
              <div className="pc-field__control">
                <span className="code pc-field__bracket">$</span>
                <input
                  id={`nicname-${keyPrefix}-${j}`}
                  className="pc-field__input code"
                  type="text"
                  list={`nic-presets-${keyPrefix}`}
                  value={nic.name}
                  onChange={(e) => onNicChange(j, { name: e.target.value })}
                />
              </div>
              <span className="body-sm pc-field__hint">
                {nicNameError ?? "used to label this nic in later steps — rename to match its role"}
              </span>
            </div>
          </div>
        );
      })}
      <datalist id={`nic-presets-${keyPrefix}`}>
        {NIC_NAME_PRESETS.map((preset) => (
          <option key={preset} value={preset} />
        ))}
      </datalist>
    </>
  );
}

function BondFields({
  keyPrefix,
  node,
  onBondCountChange,
  onToggleBondNic,
  onUpdateBondMeta,
}: {
  keyPrefix: string;
  node: NodeInfo;
  onBondCountChange: (value: string) => void;
  onToggleBondNic: (bondIndex: number, nicIndex: number, checked: boolean) => void;
  onUpdateBondMeta: (bondIndex: number, patch: Partial<Pick<BondConfig, "name" | "mode">>) => void;
}) {
  const bondCountError = validateIntRange(node.network.bondCount, 0, 4, { required: true });
  const allNames = collectNodeNames(node);

  return (
    <>
      <div className={`pc-field ${bondCountError ? "pc-field--error" : ""}`}>
        <label className="label pc-field__label" htmlFor={`bondcount-${keyPrefix}`}>
          number of bonds
          <span className="pc-field__required"> *</span>
        </label>
        <div className="pc-field__control">
          <input
            id={`bondcount-${keyPrefix}`}
            className="pc-field__input code"
            type="number"
            min={0}
            max={4}
            value={node.network.bondCount}
            onChange={(e) => onBondCountChange(e.target.value)}
          />
        </div>
        <span className="body-sm pc-field__hint">
          {bondCountError ??
            "combine 2+ nics into one logical link for redundancy or more bandwidth — 0 if you don't need any"}
        </span>
      </div>

      {node.network.bonds.map((bond, bi) => {
        const bondNameError = validateInterfaceName(bond.name) ?? validateUniqueName(bond.name, allNames);
        return (
        <div
          key={bi}
          className="flex flex-col border border-border bg-surface-100 p-5"
          style={{ gap: "var(--space-3)" }}
        >
          <p className="label text-ink-muted">bond {bi + 1}</p>

          <fieldset className="pc-radio-group" style={{ border: 0, margin: 0, padding: 0 }}>
            <legend className="label pc-radio-group__legend">nics in this bond</legend>
            {node.nics.map((nic, ni) => {
              const claimedByOtherBond = node.network.bonds.some((b, bj) => bj !== bi && b.nicIndices.includes(ni));
              if (claimedByOtherBond) return null;
              return (
                <label key={ni} className="pc-checkbox">
                  <input
                    type="checkbox"
                    checked={bond.nicIndices.includes(ni)}
                    onChange={(e) => onToggleBondNic(bi, ni, e.target.checked)}
                  />
                  <span className="pc-checkbox__box" />
                  <span className="code pc-checkbox__label">
                    nic {ni + 1} — {nic.name} — {nicSpeedLabel(nic.speed)}
                  </span>
                </label>
              );
            })}
          </fieldset>
          {bond.nicIndices.length < 2 && (
            <p className="body-sm pc-field__hint">select at least 2 nics to make this a real bond</p>
          )}

          <fieldset className="pc-radio-group" style={{ border: 0, margin: 0, padding: 0 }}>
            <legend className="label pc-radio-group__legend">bond mode</legend>
            {BOND_MODE_OPTIONS.map((opt) => (
              <label key={opt.value} className="pc-radio">
                <input
                  type="radio"
                  name={`bondmode-${keyPrefix}-${bi}`}
                  checked={bond.mode === opt.value}
                  onChange={() => onUpdateBondMeta(bi, { mode: opt.value })}
                />
                <span className="pc-radio__box" />
                <span>
                  <span className="code pc-radio__label">{opt.label}</span>
                  <span className="body-sm pc-checkbox__hint">{opt.hint}</span>
                </span>
              </label>
            ))}
          </fieldset>

          <div className={`pc-field ${bondNameError ? "pc-field--error" : ""}`}>
            <label className="label pc-field__label" htmlFor={`bondname-${keyPrefix}-${bi}`}>
              bond name
              <span className="pc-field__required"> *</span>
            </label>
            <div className="pc-field__control">
              <span className="code pc-field__bracket">$</span>
              <input
                id={`bondname-${keyPrefix}-${bi}`}
                className="pc-field__input code"
                type="text"
                value={bond.name}
                onChange={(e) => onUpdateBondMeta(bi, { name: e.target.value })}
              />
            </div>
            <span className="body-sm pc-field__hint">
              {bondNameError ?? "the linux bonding interface name — appears below as its own interface"}
            </span>
          </div>
        </div>
        );
      })}
    </>
  );
}

// a bridge at index 1+ of some interface — sharing a nic/bond with a
// sibling bridge only works in linux if each one is vlan-tagged, so this
// always shows a vlan field and never the "bridge this interface" toggle
// (its existence is already opt-in via the interface's bridge count).
// `address`, when given, also renders this bridge's own ip field — used
// by the combined (not-"identical network") NetworkFields; omitted by
// NetworkStructureFields, which leaves every ip field to
// NetworkAddressFields instead.
function ExtraBridgeCard({
  keyPrefix,
  bridgeId,
  heading,
  bridge,
  siblingVlanTags,
  allNames,
  purposeOptions,
  storagePurpose,
  storagePurposeMissingHint,
  onBridgeChange,
  address,
  conflictError,
}: {
  keyPrefix: string;
  bridgeId: string;
  heading: string;
  bridge: BridgeConfig;
  siblingVlanTags: string[];
  allNames: string[];
  purposeOptions: PurposeInfo[];
  storagePurpose: InterfacePurpose | null;
  storagePurposeMissingHint: ReactNode;
  onBridgeChange: (bridgeId: string, patch: Partial<BridgeConfig>) => void;
  address?: { lanPrefix: number; secondarySubnet: { host: string; network: string } | null };
  // a real address problem for this bridge (see buildAddressConflicts) —
  // omitted by NetworkStructureFields, which has no per-node addresses to
  // check yet.
  conflictError?: string | null;
}) {
  const bridgeNameError = validateInterfaceName(bridge.name) ?? validateUniqueName(bridge.name, allNames);
  const comboHint = purposeComboHint(bridge.purposes);
  const vlanError = validateVlanTag(bridge.vlanTag, siblingVlanTags);
  const needsHostIp = needsHostIpForPurposes(bridge.purposes, bridge.otherNeedsHostIp);
  const ipError = (needsHostIp ? validateHostCidr(bridge.ip) : validateCidr(bridge.ip)) ?? conflictError ?? null;
  // the vlan tag starts empty on a freshly-added extra bridge — same
  // "don't flag it red before the visitor has touched it" reasoning as
  // CidrField and the disk-size fields in HardwareFields.
  const [vlanTouched, setVlanTouched] = useState(false);
  const showVlanError = vlanTouched && vlanError;

  return (
    <div className="flex flex-col border border-border bg-surface-100 p-5" style={{ gap: "var(--space-3)" }}>
      <p className="label text-ink-muted">{heading}</p>
      <div className={`pc-field ${showVlanError ? "pc-field--error" : ""}`}>
        <label className="label pc-field__label" htmlFor={`vlan-${keyPrefix}-${bridgeId}`}>
          vlan tag
          <span className="pc-field__required"> *</span>
        </label>
        <div className="pc-field__control">
          <span className="code pc-field__bracket">#</span>
          <input
            id={`vlan-${keyPrefix}-${bridgeId}`}
            className="pc-field__input code"
            type="number"
            min={1}
            max={4094}
            value={bridge.vlanTag}
            onChange={(e) => onBridgeChange(bridgeId, { vlanTag: e.target.value })}
            onBlur={() => setVlanTouched(true)}
          />
        </div>
        <span className="body-sm pc-field__hint">
          {showVlanError
            ? vlanError
            : "separates this bridge's traffic from its sibling(s) sharing the same nic/bond — must match a vlan configured on your switch"}
        </span>
      </div>

      <fieldset className="pc-radio-group" style={{ border: 0, margin: 0, padding: 0 }}>
        <legend className="label pc-radio-group__legend">used for (pick as many as apply)</legend>
        {purposeOptions.map((opt) => {
          const checked = bridge.purposes.includes(opt.value);
          const isLastOne = checked && bridge.purposes.length === 1;
          return (
            <label key={opt.value} className="pc-checkbox">
              <input
                type="checkbox"
                checked={checked}
                disabled={isLastOne}
                onChange={(e) => {
                  const nextPurposes = e.target.checked
                    ? [...bridge.purposes, opt.value]
                    : bridge.purposes.filter((p) => p !== opt.value);
                  if (nextPurposes.length === 0) return;
                  onBridgeChange(bridgeId, { purposes: nextPurposes });
                }}
              />
              <span className="pc-checkbox__box" />
              <span>
                <span className="code pc-checkbox__label">{opt.label}</span>
                <span className="body-sm pc-checkbox__hint">{opt.hint}</span>
              </span>
            </label>
          );
        })}
        {storagePurpose === null && storagePurposeMissingHint}
      </fieldset>

      {comboHint && (
        <div className={`pc-callout pc-callout--${comboHint.tone}`}>
          <span className="code pc-callout__glyph">{comboHint.glyph}</span>
          <div className="pc-callout__body">
            <p className="body-sm pc-callout__text">{comboHint.text}</p>
          </div>
        </div>
      )}

      {bridge.purposes.includes("other") && (
        <fieldset className="pc-radio-group" style={{ border: 0, margin: 0, padding: 0 }}>
          <legend className="label pc-radio-group__legend">does this node need an address here?</legend>
          <label className="pc-radio">
            <input
              type="radio"
              name={`otherip-${keyPrefix}-${bridgeId}`}
              checked={bridge.otherNeedsHostIp}
              onChange={() => onBridgeChange(bridgeId, { otherNeedsHostIp: true })}
            />
            <span className="pc-radio__box" />
            <span className="code pc-radio__label">yes — give it a static ip</span>
          </label>
          <label className="pc-radio">
            <input
              type="radio"
              name={`otherip-${keyPrefix}-${bridgeId}`}
              checked={!bridge.otherNeedsHostIp}
              onChange={() => onBridgeChange(bridgeId, { otherNeedsHostIp: false })}
            />
            <span className="pc-radio__box" />
            <span className="code pc-radio__label">no — it&apos;s just a switch for vms</span>
          </label>
        </fieldset>
      )}

      <div className={`pc-field ${bridgeNameError ? "pc-field--error" : ""}`}>
        <label className="label pc-field__label" htmlFor={`bridge-${keyPrefix}-${bridgeId}`}>
          bridge name
          <span className="pc-field__required"> *</span>
        </label>
        <div className="pc-field__control">
          <span className="code pc-field__bracket">$</span>
          <input
            id={`bridge-${keyPrefix}-${bridgeId}`}
            className="pc-field__input code"
            type="text"
            value={bridge.name}
            onChange={(e) => onBridgeChange(bridgeId, { name: e.target.value })}
          />
        </div>
        <span className="body-sm pc-field__hint">
          {bridgeNameError ?? "shown in the proxmox ui and used in vm/ct network config"}
        </span>
      </div>

      {address && (
        <CidrField
          id={`bridgeip-${keyPrefix}-${bridgeId}`}
          label={needsHostIp ? "static ip for this node" : "network (optional)"}
          value={bridge.ip}
          onChange={(value) => onBridgeChange(bridgeId, { ip: value })}
          placeholder={
            needsHostIp
              ? (address.secondarySubnet?.host ?? "10.0.20.11/24")
              : (address.secondarySubnet?.network ?? "10.0.20.0/24")
          }
          error={ipError}
          hint={
            needsHostIp
              ? requiredIpHintFor(bridge.purposes, bridge.otherNeedsHostIp)
              : "the subnet vms/cts on this bridge should use — purely informational, the host won't have an address here"
          }
          defaultPrefix={address.lanPrefix}
          required={needsHostIp}
        />
      )}
    </div>
  );
}

// a "number of bridges on this interface" count field — 1 is just that
// interface's native bridge (today's default); raise it to add vlan-
// tagged siblings sharing the same underlying nic or bond.
function BridgeCountField({
  keyPrefix,
  interfaceId,
  count,
  onBridgeCountChange,
}: {
  keyPrefix: string;
  interfaceId: string;
  count: string;
  onBridgeCountChange: (interfaceId: string, value: string) => void;
}) {
  const error = validateIntRange(count, 1, 4, { required: true });
  return (
    <div className={`pc-field ${error ? "pc-field--error" : ""}`}>
      <label className="label pc-field__label" htmlFor={`bridgecount-${keyPrefix}-${interfaceId}`}>
        bridges on this interface
        <span className="pc-field__required"> *</span>
      </label>
      <div className="pc-field__control">
        <input
          id={`bridgecount-${keyPrefix}-${interfaceId}`}
          className="pc-field__input code"
          type="number"
          min={1}
          max={4}
          value={count}
          onChange={(e) => onBridgeCountChange(interfaceId, e.target.value)}
        />
      </div>
      <span className="body-sm pc-field__hint">
        {error ??
          "1 = just this interface's own bridge — raise it to split off extra, vlan-tagged bridges sharing the same nic/bond"}
      </span>
    </div>
  );
}

// everything about a node's network EXCEPT addresses: bonds, which
// interface is management, and every bridge's purposes/enabled/name.
// used as a single shared block when "identical network setup" is on,
// instead of repeating it per node — hostname and every ip address still
// come from NetworkAddressFields, always rendered per node.
function NetworkStructureFields({
  keyPrefix,
  node,
  nodeCount,
  storageHaMode,
  storagePurpose,
  onBondCountChange,
  onToggleBondNic,
  onUpdateBondMeta,
  onManagementInterfaceChange,
  onBridgeChange,
  onBridgeCountChange,
}: {
  keyPrefix: string;
  node: NodeInfo;
  nodeCount: number;
  storageHaMode: StorageHaMode;
  storagePurpose: InterfacePurpose | null;
  onBondCountChange: (value: string) => void;
  onToggleBondNic: (bondIndex: number, nicIndex: number, checked: boolean) => void;
  onUpdateBondMeta: (bondIndex: number, patch: Partial<Pick<BondConfig, "name" | "mode">>) => void;
  onManagementInterfaceChange: (interfaceId: string) => void;
  onBridgeChange: (bridgeId: string, patch: Partial<BridgeConfig>) => void;
  onBridgeCountChange: (interfaceId: string, value: string) => void;
}) {
  const interfaces = interfacesFor(node.nics, node.network.bonds);
  const allNames = collectNodeNames(node);
  const mgmtBridgeKey = bridgeKey(node.network.managementInterfaceId, 0);
  const managementBridge = node.network.bridges[mgmtBridgeKey];
  const managementBridgeNameError =
    validateInterfaceName(managementBridge?.name || "vmbr0") ??
    validateUniqueName(managementBridge?.name || "vmbr0", allNames);
  const purposeOptions = INTERFACE_PURPOSE_OPTIONS.filter(
    (opt) => (opt.value !== "ceph" && opt.value !== "zfs") || opt.value === storagePurpose,
  );
  const managementComboHint = purposeComboHint(managementBridge?.purposes ?? []);
  const vmTrafficHint = vmTrafficHintFor(node.network.bridges);
  const backupHint = backupHintFor(node.network.bridges);
  const corosyncHint = corosyncHintFor(node.network.bridges, nodeCount);
  const storageHaHint = storageHaHintFor(node.network.bridges, storagePurpose);
  const storagePurposeMissingHint = (
    <p className="body-sm pc-field__hint">
      {nodeCount < 2
        ? "ceph and zfs replication need at least 2 nodes for real redundancy — add another node to unlock a cluster storage option here"
        : storageHaMode === "none"
          ? 'you chose "no ha / sync" above — pick ceph or zfs with replication there to unlock a matching nic purpose here'
          : "ceph and zfs replication both need at least 1 disk beyond the boot disk on every node — add one in step 1, or the choice above falls back to \"no ha / sync\" until then"}
    </p>
  );

  return (
    <>
      <BondFields
        keyPrefix={keyPrefix}
        node={node}
        onBondCountChange={onBondCountChange}
        onToggleBondNic={onToggleBondNic}
        onUpdateBondMeta={onUpdateBondMeta}
      />

      <div className="flex flex-col border border-border bg-surface-100 p-5" style={{ gap: "var(--space-3)" }}>
        <p className="label text-ink-muted">management</p>
        <fieldset className="pc-radio-group" style={{ border: 0, margin: 0, padding: 0 }}>
          <legend className="label pc-radio-group__legend">interface</legend>
          {interfaces.map((iface) => (
            <label key={iface.id} className="pc-radio">
              <input
                type="radio"
                name={`mgmtnic-${keyPrefix}`}
                checked={node.network.managementInterfaceId === iface.id}
                onChange={() => onManagementInterfaceChange(iface.id)}
              />
              <span className="pc-radio__box" />
              <span className="code pc-radio__label">{iface.label}</span>
            </label>
          ))}
        </fieldset>
        <div className={`pc-field ${managementBridgeNameError ? "pc-field--error" : ""}`}>
          <label className="label pc-field__label" htmlFor={`mgmtbridge-${keyPrefix}`}>
            bridge name
            <span className="pc-field__required"> *</span>
          </label>
          <div className="pc-field__control">
            <span className="code pc-field__bracket">$</span>
            <input
              id={`mgmtbridge-${keyPrefix}`}
              className="pc-field__input code"
              type="text"
              value={managementBridge?.name ?? "vmbr0"}
              onChange={(e) => onBridgeChange(mgmtBridgeKey, { name: e.target.value })}
            />
          </div>
          <span className="body-sm pc-field__hint">
            {managementBridgeNameError ??
              "carries the management ip and, by default, vm traffic too — vmbr0 is the proxmox convention, but you can rename it"}
          </span>
        </div>

        {managementBridge && (
          <>
            <fieldset className="pc-radio-group" style={{ border: 0, margin: 0, padding: 0 }}>
              <legend className="label pc-radio-group__legend">also used for (pick as many as apply, or none)</legend>
              {purposeOptions
                .filter((opt) => opt.value !== "other")
                .map((opt) => {
                  const checked = managementBridge.purposes.includes(opt.value);
                  return (
                    <label key={opt.value} className="pc-checkbox">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(e) => {
                          const nextPurposes = e.target.checked
                            ? [...managementBridge.purposes, opt.value]
                            : managementBridge.purposes.filter((p) => p !== opt.value);
                          onBridgeChange(mgmtBridgeKey, { purposes: nextPurposes });
                        }}
                      />
                      <span className="pc-checkbox__box" />
                      <span>
                        <span className="code pc-checkbox__label">{opt.label}</span>
                        <span className="body-sm pc-checkbox__hint">{opt.hint}</span>
                      </span>
                    </label>
                  );
                })}
              {managementBridge.purposes.length === 0 && (
                <p className="body-sm pc-field__hint">
                  nothing checked — this bridge carries only the management ip above, no vm/container/backup/corosync
                  traffic
                </p>
              )}
              {storagePurpose === null && storagePurposeMissingHint}
            </fieldset>

            {managementComboHint && (
              <div className={`pc-callout pc-callout--${managementComboHint.tone}`}>
                <span className="code pc-callout__glyph">{managementComboHint.glyph}</span>
                <div className="pc-callout__body">
                  <p className="body-sm pc-callout__text">{managementComboHint.text}</p>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {interfaces.map((iface) => {
        const isManagement = iface.id === node.network.managementInterfaceId;
        const count = bridgeCountFor(node.network.bridgeCounts, iface.id);
        const bridge = node.network.bridges[bridgeKey(iface.id, 0)];

        return (
          <div key={iface.id} className="flex flex-col" style={{ gap: "var(--space-3)" }}>
            {!isManagement &&
              bridge &&
              (() => {
                const bridgeNameError = validateInterfaceName(bridge.name) ?? validateUniqueName(bridge.name, allNames);
                const comboHint = purposeComboHint(bridge.purposes);
                const key0 = bridgeKey(iface.id, 0);
                return (
                  <div className="flex flex-col border border-border bg-surface-100 p-5" style={{ gap: "var(--space-3)" }}>
                    <p className="label text-ink-muted">{iface.label}</p>
                    <label className="pc-checkbox">
                      <input
                        type="checkbox"
                        checked={bridge.enabled}
                        onChange={(e) => onBridgeChange(key0, { enabled: e.target.checked })}
                      />
                      <span className="pc-checkbox__box" />
                      <span>
                        <span className="code pc-checkbox__label">bridge this interface</span>
                        <span className="body-sm pc-checkbox__hint">
                          a linux bridge on it — leave unchecked to keep it unused for now
                        </span>
                      </span>
                    </label>
                    {bridge.enabled && (
                      <>
                        <fieldset className="pc-radio-group" style={{ border: 0, margin: 0, padding: 0 }}>
                          <legend className="label pc-radio-group__legend">used for (pick as many as apply)</legend>
                          {purposeOptions.map((opt) => {
                            const checked = bridge.purposes.includes(opt.value);
                            const isLastOne = checked && bridge.purposes.length === 1;
                            return (
                              <label key={opt.value} className="pc-checkbox">
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  disabled={isLastOne}
                                  onChange={(e) => {
                                    const nextPurposes = e.target.checked
                                      ? [...bridge.purposes, opt.value]
                                      : bridge.purposes.filter((p) => p !== opt.value);
                                    if (nextPurposes.length === 0) return;
                                    onBridgeChange(key0, { purposes: nextPurposes });
                                  }}
                                />
                                <span className="pc-checkbox__box" />
                                <span>
                                  <span className="code pc-checkbox__label">{opt.label}</span>
                                  <span className="body-sm pc-checkbox__hint">{opt.hint}</span>
                                </span>
                              </label>
                            );
                          })}
                          {storagePurpose === null && storagePurposeMissingHint}
                        </fieldset>

                        {comboHint && (
                          <div className={`pc-callout pc-callout--${comboHint.tone}`}>
                            <span className="code pc-callout__glyph">{comboHint.glyph}</span>
                            <div className="pc-callout__body">
                              <p className="body-sm pc-callout__text">{comboHint.text}</p>
                            </div>
                          </div>
                        )}

                        {bridge.purposes.includes("other") && (
                          <fieldset className="pc-radio-group" style={{ border: 0, margin: 0, padding: 0 }}>
                            <legend className="label pc-radio-group__legend">does this node need an address here?</legend>
                            <label className="pc-radio">
                              <input
                                type="radio"
                                name={`otherip-${keyPrefix}-${key0}`}
                                checked={bridge.otherNeedsHostIp}
                                onChange={() => onBridgeChange(key0, { otherNeedsHostIp: true })}
                              />
                              <span className="pc-radio__box" />
                              <span className="code pc-radio__label">yes — give it a static ip</span>
                            </label>
                            <label className="pc-radio">
                              <input
                                type="radio"
                                name={`otherip-${keyPrefix}-${key0}`}
                                checked={!bridge.otherNeedsHostIp}
                                onChange={() => onBridgeChange(key0, { otherNeedsHostIp: false })}
                              />
                              <span className="pc-radio__box" />
                              <span className="code pc-radio__label">no — it&apos;s just a switch for vms</span>
                            </label>
                          </fieldset>
                        )}

                        <div className={`pc-field ${bridgeNameError ? "pc-field--error" : ""}`}>
                          <label className="label pc-field__label" htmlFor={`bridge-${keyPrefix}-${key0}`}>
                            bridge name
                            <span className="pc-field__required"> *</span>
                          </label>
                          <div className="pc-field__control">
                            <span className="code pc-field__bracket">$</span>
                            <input
                              id={`bridge-${keyPrefix}-${key0}`}
                              className="pc-field__input code"
                              type="text"
                              value={bridge.name}
                              onChange={(e) => onBridgeChange(key0, { name: e.target.value })}
                            />
                          </div>
                          <span className="body-sm pc-field__hint">
                            {bridgeNameError ?? "shown in the proxmox ui and used in vm/ct network config"}
                          </span>
                        </div>
                      </>
                    )}
                  </div>
                );
              })()}

            <BridgeCountField
              keyPrefix={keyPrefix}
              interfaceId={iface.id}
              count={node.network.bridgeCounts[iface.id] ?? "1"}
              onBridgeCountChange={onBridgeCountChange}
            />

            {Array.from({ length: Math.max(0, count - 1) }, (_, k) => k + 1).map((index) => {
              const extraKey = bridgeKey(iface.id, index);
              const extraBridge = node.network.bridges[extraKey];
              if (!extraBridge) return null;
              return (
                <ExtraBridgeCard
                  key={extraKey}
                  keyPrefix={keyPrefix}
                  bridgeId={extraKey}
                  heading={`${iface.label} — extra bridge (${extraBridge.name})`}
                  bridge={extraBridge}
                  siblingVlanTags={siblingVlanTagsFor(node.network.bridges, count, iface.id, index)}
                  allNames={allNames}
                  purposeOptions={purposeOptions}
                  storagePurpose={storagePurpose}
                  storagePurposeMissingHint={storagePurposeMissingHint}
                  onBridgeChange={onBridgeChange}
                />
              );
            })}
          </div>
        );
      })}

      {[vmTrafficHint, storageHaHint, backupHint, corosyncHint]
        .filter((hint): hint is Hint => hint !== null)
        .map((hint, i) => (
          <div key={i} className={`pc-callout pc-callout--${hint.tone}`}>
            <span className="code pc-callout__glyph">{hint.glyph}</span>
            <div className="pc-callout__body">
              <p className="body-sm pc-callout__text">{hint.text}</p>
            </div>
          </div>
        ))}
    </>
  );
}

// the part of a node's network that MUST stay unique even when "identical
// network setup" is on: hostname, the management ip, and each enabled
// bridge's own ip. rendered per node always — NetworkStructureFields
// covers everything else.
function NetworkAddressFields({
  keyPrefix,
  node,
  nodeIndex,
  hostnameSuffix,
  lanPrefix,
  globalCidr,
  placeholders,
  conflicts,
  onChange,
  onBridgeChange,
}: {
  keyPrefix: string;
  node: NodeInfo;
  // this node's position in the nodes list — every placeholder below is
  // offset by it, so the same bridge on a different node never suggests
  // the exact same address.
  nodeIndex: number;
  hostnameSuffix: string;
  lanPrefix: number;
  globalCidr: string;
  // one cluster-wide pass of ip/network suggestions (see
  // buildPlaceholderTable) — keeps a shared-purpose bridge's placeholder
  // consistent with whatever an earlier node already committed for it.
  placeholders: Map<string, PlaceholderSubnet>;
  // real address problems (see buildAddressConflicts) — an exact ip
  // reused anywhere, or two of this node's own claims overlapping.
  conflicts: Map<string, string>;
  onChange: (patch: Partial<NodeNetwork>) => void;
  onBridgeChange: (bridgeId: string, patch: Partial<BridgeConfig>) => void;
}) {
  const hostLabelError = validateHostLabel(node.network.hostLabel);
  const cidrError = validateCidr(node.network.cidr) ?? conflicts.get(`${nodeIndex}#mgmt`) ?? null;
  const mgmtBridgeKey = bridgeKey(node.network.managementInterfaceId, 0);
  const managementBridgeName = node.network.bridges[mgmtBridgeKey]?.name || "vmbr0";
  const managementCidrPlaceholder = deriveNodeCidr(globalCidr, nodeIndex) || "10.0.10.11/24";
  // every bridge except the management interface's own index-0 bridge —
  // that one's address is the "static ip" field above, not a field here.
  const addressableBridges = addressableBridgeKeys(node);

  return (
    <>
      <div className={`pc-field ${hostLabelError ? "pc-field--error" : ""}`}>
        <label className="label pc-field__label" htmlFor={`hostname-${keyPrefix}`}>
          hostname (fqdn)
        </label>
        <div className="pc-field__control">
          <span className="code pc-field__bracket">$</span>
          <input
            id={`hostname-${keyPrefix}`}
            className="pc-field__input code"
            type="text"
            style={{ flex: "0 1 auto", width: `${Math.max(node.network.hostLabel.length, 6)}ch` }}
            value={node.network.hostLabel}
            onChange={(e) => onChange({ hostLabel: e.target.value })}
          />
          <span className="code" style={{ color: "var(--ink-dim)", flex: "none" }}>
            {hostnameSuffix ? `.${hostnameSuffix}` : ""}
          </span>
        </div>
        <span className="body-sm pc-field__hint">
          {hostLabelError ?? "the domain suffix is fixed to what you set above — only this part is editable"}
        </span>
      </div>

      <CidrField
        id={`nodecidr-${keyPrefix}`}
        label="static ip"
        value={node.network.cidr}
        onChange={(value) => onChange({ cidr: value })}
        placeholder={managementCidrPlaceholder}
        error={cidrError}
        hint={`for the web ui and ssh — assigned to the ${managementBridgeName} bridge, not the raw nic or bond`}
        defaultPrefix={lanPrefix}
      />

      {addressableBridges.map((key, position) => {
        const bridge = node.network.bridges[key];
        if (!bridge || !bridge.enabled) return null;
        const needsHostIp = needsHostIpForPurposes(bridge.purposes, bridge.otherNeedsHostIp);
        const ipError =
          (needsHostIp ? validateHostCidr(bridge.ip) : validateCidr(bridge.ip)) ?? conflicts.get(`${nodeIndex}#${key}`) ?? null;
        const subnet = placeholders.get(`${nodeIndex}#${key}`) ?? nonCollidingPlaceholderSubnet(node, globalCidr, position, nodeIndex);
        return (
          <CidrField
            key={key}
            id={`bridgeip-${keyPrefix}-${key}`}
            label={`${bridge.name} — ${needsHostIp ? "static ip for this node" : "network (optional)"}`}
            value={bridge.ip}
            onChange={(value) => onBridgeChange(key, { ip: value })}
            placeholder={needsHostIp ? (subnet?.host ?? "10.0.20.11/24") : (subnet?.network ?? "10.0.20.0/24")}
            error={ipError}
            hint={
              needsHostIp
                ? requiredIpHintFor(bridge.purposes, bridge.otherNeedsHostIp)
                : "the subnet vms/cts on this bridge should use — purely informational, the host won't have an address here"
            }
            defaultPrefix={lanPrefix}
            required={needsHostIp}
          />
        );
      })}
    </>
  );
}

function NetworkFields({
  keyPrefix,
  node,
  nodeIndex,
  hostnameSuffix,
  lanPrefix,
  globalCidr,
  nodeCount,
  storageHaMode,
  storagePurpose,
  placeholders,
  conflicts,
  onChange,
  onBondCountChange,
  onToggleBondNic,
  onUpdateBondMeta,
  onManagementInterfaceChange,
  onBridgeChange,
  onBridgeCountChange,
}: {
  keyPrefix: string;
  node: NodeInfo;
  // this node's position in the nodes list — every ip placeholder below
  // is offset by it, so the same bridge on a different node never
  // suggests the exact same address.
  nodeIndex: number;
  hostnameSuffix: string;
  lanPrefix: number;
  // the homelab cidr set at the top of this step — used only to keep
  // example placeholder text in the fields below relevant to what the
  // visitor actually typed, instead of an unrelated hardcoded example.
  globalCidr: string;
  // drives the corosync warning below (only a cluster of 2+ has corosync
  // to worry about).
  nodeCount: number;
  // the visitor's raw choice above, before any disk-availability fallback
  // — only used to word the "why isn't ceph/zfs offered" hint correctly.
  storageHaMode: StorageHaMode;
  // the one storage purpose ("ceph" | "zfs" | null) the storage/ha
  // decision at the top of this step currently allows — drives which of
  // ceph/zfs (if either) is offered as a nic purpose, and is enforced
  // below via storageHaHintFor.
  storagePurpose: InterfacePurpose | null;
  // one cluster-wide pass of ip/network suggestions (see
  // buildPlaceholderTable) — keeps a shared-purpose bridge's placeholder
  // consistent with whatever an earlier node already committed for it.
  placeholders: Map<string, PlaceholderSubnet>;
  // real address problems (see buildAddressConflicts) — an exact ip
  // reused anywhere, or two of this node's own claims overlapping.
  conflicts: Map<string, string>;
  onChange: (patch: Partial<NodeNetwork>) => void;
  onBondCountChange: (value: string) => void;
  onToggleBondNic: (bondIndex: number, nicIndex: number, checked: boolean) => void;
  onUpdateBondMeta: (bondIndex: number, patch: Partial<Pick<BondConfig, "name" | "mode">>) => void;
  onManagementInterfaceChange: (interfaceId: string) => void;
  onBridgeChange: (bridgeId: string, patch: Partial<BridgeConfig>) => void;
  onBridgeCountChange: (interfaceId: string, value: string) => void;
}) {
  const hostLabelError = validateHostLabel(node.network.hostLabel);
  const cidrError = validateCidr(node.network.cidr) ?? conflicts.get(`${nodeIndex}#mgmt`) ?? null;
  const interfaces = interfacesFor(node.nics, node.network.bonds);
  const allNames = collectNodeNames(node);
  const mgmtBridgeKey = bridgeKey(node.network.managementInterfaceId, 0);
  const managementBridge = node.network.bridges[mgmtBridgeKey];
  const managementBridgeName = managementBridge?.name || "vmbr0";
  const managementBridgeNameError =
    validateInterfaceName(managementBridgeName) ?? validateUniqueName(managementBridgeName, allNames);
  const purposeOptions = INTERFACE_PURPOSE_OPTIONS.filter(
    (opt) => (opt.value !== "ceph" && opt.value !== "zfs") || opt.value === storagePurpose,
  );
  const managementComboHint = purposeComboHint(managementBridge?.purposes ?? []);
  const managementCidrPlaceholder = deriveNodeCidr(globalCidr, nodeIndex) || "10.0.10.11/24";
  const addressKeys = addressableBridgeKeys(node);
  const vmTrafficHint = vmTrafficHintFor(node.network.bridges);
  const backupHint = backupHintFor(node.network.bridges);
  const corosyncHint = corosyncHintFor(node.network.bridges, nodeCount);
  const storageHaHint = storageHaHintFor(node.network.bridges, storagePurpose);
  const storagePurposeMissingHint = (
    <p className="body-sm pc-field__hint">
      {nodeCount < 2
        ? "ceph and zfs replication need at least 2 nodes for real redundancy — add another node to unlock a cluster storage option here"
        : storageHaMode === "none"
          ? 'you chose "no ha / sync" above — pick ceph or zfs with replication there to unlock a matching nic purpose here'
          : "ceph and zfs replication both need at least 1 disk beyond the boot disk on every node — add one in step 1, or the choice above falls back to \"no ha / sync\" until then"}
    </p>
  );

  return (
    <>
      <div className={`pc-field ${hostLabelError ? "pc-field--error" : ""}`}>
        <label className="label pc-field__label" htmlFor={`hostname-${keyPrefix}`}>
          hostname (fqdn)
        </label>
        <div className="pc-field__control">
          <span className="code pc-field__bracket">$</span>
          <input
            id={`hostname-${keyPrefix}`}
            className="pc-field__input code"
            type="text"
            style={{ flex: "0 1 auto", width: `${Math.max(node.network.hostLabel.length, 6)}ch` }}
            value={node.network.hostLabel}
            onChange={(e) => onChange({ hostLabel: e.target.value })}
          />
          <span className="code" style={{ color: "var(--ink-dim)", flex: "none" }}>
            {hostnameSuffix ? `.${hostnameSuffix}` : ""}
          </span>
        </div>
        <span className="body-sm pc-field__hint">
          {hostLabelError ?? "the domain suffix is fixed to what you set above — only this part is editable"}
        </span>
      </div>

      <BondFields
        keyPrefix={keyPrefix}
        node={node}
        onBondCountChange={onBondCountChange}
        onToggleBondNic={onToggleBondNic}
        onUpdateBondMeta={onUpdateBondMeta}
      />

      <div className="flex flex-col border border-border bg-surface-100 p-5" style={{ gap: "var(--space-3)" }}>
        <p className="label text-ink-muted">management</p>
        <CidrField
          id={`nodecidr-${keyPrefix}`}
          label="static ip"
          value={node.network.cidr}
          onChange={(value) => onChange({ cidr: value })}
          placeholder={managementCidrPlaceholder}
          error={cidrError}
          hint={`for the web ui and ssh — assigned to the ${managementBridgeName} bridge below, not the raw nic or bond`}
          defaultPrefix={lanPrefix}
        />
        <fieldset className="pc-radio-group" style={{ border: 0, margin: 0, padding: 0 }}>
          <legend className="label pc-radio-group__legend">interface</legend>
          {interfaces.map((iface) => (
            <label key={iface.id} className="pc-radio">
              <input
                type="radio"
                name={`mgmtnic-${keyPrefix}`}
                checked={node.network.managementInterfaceId === iface.id}
                onChange={() => onManagementInterfaceChange(iface.id)}
              />
              <span className="pc-radio__box" />
              <span className="code pc-radio__label">{iface.label}</span>
            </label>
          ))}
        </fieldset>
        <div className={`pc-field ${managementBridgeNameError ? "pc-field--error" : ""}`}>
          <label className="label pc-field__label" htmlFor={`mgmtbridge-${keyPrefix}`}>
            bridge name
            <span className="pc-field__required"> *</span>
          </label>
          <div className="pc-field__control">
            <span className="code pc-field__bracket">$</span>
            <input
              id={`mgmtbridge-${keyPrefix}`}
              className="pc-field__input code"
              type="text"
              value={managementBridge?.name ?? "vmbr0"}
              onChange={(e) => onBridgeChange(mgmtBridgeKey, { name: e.target.value })}
            />
          </div>
          <span className="body-sm pc-field__hint">
            {managementBridgeNameError ??
              "carries the management ip above and, by default, vm traffic too — vmbr0 is the proxmox convention, but you can rename it"}
          </span>
        </div>

        {managementBridge && (
          <>
            <fieldset className="pc-radio-group" style={{ border: 0, margin: 0, padding: 0 }}>
              <legend className="label pc-radio-group__legend">also used for (pick as many as apply, or none)</legend>
              {purposeOptions
                .filter((opt) => opt.value !== "other")
                .map((opt) => {
                  const checked = managementBridge.purposes.includes(opt.value);
                  return (
                    <label key={opt.value} className="pc-checkbox">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(e) => {
                          const nextPurposes = e.target.checked
                            ? [...managementBridge.purposes, opt.value]
                            : managementBridge.purposes.filter((p) => p !== opt.value);
                          onBridgeChange(mgmtBridgeKey, { purposes: nextPurposes });
                        }}
                      />
                      <span className="pc-checkbox__box" />
                      <span>
                        <span className="code pc-checkbox__label">{opt.label}</span>
                        <span className="body-sm pc-checkbox__hint">{opt.hint}</span>
                      </span>
                    </label>
                  );
                })}
              {managementBridge.purposes.length === 0 && (
                <p className="body-sm pc-field__hint">
                  nothing checked — this bridge carries only the management ip above, no vm/container/backup/corosync
                  traffic
                </p>
              )}
              {storagePurpose === null && storagePurposeMissingHint}
            </fieldset>

            {managementComboHint && (
              <div className={`pc-callout pc-callout--${managementComboHint.tone}`}>
                <span className="code pc-callout__glyph">{managementComboHint.glyph}</span>
                <div className="pc-callout__body">
                  <p className="body-sm pc-callout__text">{managementComboHint.text}</p>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {interfaces.map((iface) => {
        const isManagement = iface.id === node.network.managementInterfaceId;
        const count = bridgeCountFor(node.network.bridgeCounts, iface.id);
        const bridge = node.network.bridges[bridgeKey(iface.id, 0)];

        return (
          <div key={iface.id} className="flex flex-col" style={{ gap: "var(--space-3)" }}>
            {!isManagement &&
              bridge &&
              (() => {
                const needsHostIp = needsHostIpForPurposes(bridge.purposes, bridge.otherNeedsHostIp);
                const key0 = bridgeKey(iface.id, 0);
                const ipError =
                  (needsHostIp ? validateHostCidr(bridge.ip) : validateCidr(bridge.ip)) ??
                  conflicts.get(`${nodeIndex}#${key0}`) ??
                  null;
                const bridgeNameError = validateInterfaceName(bridge.name) ?? validateUniqueName(bridge.name, allNames);
                const comboHint = purposeComboHint(bridge.purposes);
                return (
                  <div className="flex flex-col border border-border bg-surface-100 p-5" style={{ gap: "var(--space-3)" }}>
                    <p className="label text-ink-muted">{iface.label}</p>
                    <label className="pc-checkbox">
                      <input
                        type="checkbox"
                        checked={bridge.enabled}
                        onChange={(e) => onBridgeChange(key0, { enabled: e.target.checked })}
                      />
                      <span className="pc-checkbox__box" />
                      <span>
                        <span className="code pc-checkbox__label">bridge this interface</span>
                        <span className="body-sm pc-checkbox__hint">
                          a linux bridge on it — leave unchecked to keep it unused for now
                        </span>
                      </span>
                    </label>
                    {bridge.enabled && (
                      <>
                        <fieldset className="pc-radio-group" style={{ border: 0, margin: 0, padding: 0 }}>
                          <legend className="label pc-radio-group__legend">used for (pick as many as apply)</legend>
                          {purposeOptions.map((opt) => {
                            const checked = bridge.purposes.includes(opt.value);
                            const isLastOne = checked && bridge.purposes.length === 1;
                            return (
                              <label key={opt.value} className="pc-checkbox">
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  disabled={isLastOne}
                                  onChange={(e) => {
                                    const nextPurposes = e.target.checked
                                      ? [...bridge.purposes, opt.value]
                                      : bridge.purposes.filter((p) => p !== opt.value);
                                    if (nextPurposes.length === 0) return;
                                    onBridgeChange(key0, { purposes: nextPurposes });
                                  }}
                                />
                                <span className="pc-checkbox__box" />
                                <span>
                                  <span className="code pc-checkbox__label">{opt.label}</span>
                                  <span className="body-sm pc-checkbox__hint">{opt.hint}</span>
                                </span>
                              </label>
                            );
                          })}
                          {storagePurpose === null && storagePurposeMissingHint}
                        </fieldset>

                        {comboHint && (
                          <div className={`pc-callout pc-callout--${comboHint.tone}`}>
                            <span className="code pc-callout__glyph">{comboHint.glyph}</span>
                            <div className="pc-callout__body">
                              <p className="body-sm pc-callout__text">{comboHint.text}</p>
                            </div>
                          </div>
                        )}

                        {bridge.purposes.includes("other") && (
                          <fieldset className="pc-radio-group" style={{ border: 0, margin: 0, padding: 0 }}>
                            <legend className="label pc-radio-group__legend">does this node need an address here?</legend>
                            <label className="pc-radio">
                              <input
                                type="radio"
                                name={`otherip-${keyPrefix}-${key0}`}
                                checked={bridge.otherNeedsHostIp}
                                onChange={() => onBridgeChange(key0, { otherNeedsHostIp: true })}
                              />
                              <span className="pc-radio__box" />
                              <span className="code pc-radio__label">yes — give it a static ip</span>
                            </label>
                            <label className="pc-radio">
                              <input
                                type="radio"
                                name={`otherip-${keyPrefix}-${key0}`}
                                checked={!bridge.otherNeedsHostIp}
                                onChange={() => onBridgeChange(key0, { otherNeedsHostIp: false })}
                              />
                              <span className="pc-radio__box" />
                              <span className="code pc-radio__label">no — it&apos;s just a switch for vms</span>
                            </label>
                          </fieldset>
                        )}

                        <div className={`pc-field ${bridgeNameError ? "pc-field--error" : ""}`}>
                          <label className="label pc-field__label" htmlFor={`bridge-${keyPrefix}-${key0}`}>
                            bridge name
                            <span className="pc-field__required"> *</span>
                          </label>
                          <div className="pc-field__control">
                            <span className="code pc-field__bracket">$</span>
                            <input
                              id={`bridge-${keyPrefix}-${key0}`}
                              className="pc-field__input code"
                              type="text"
                              value={bridge.name}
                              onChange={(e) => onBridgeChange(key0, { name: e.target.value })}
                            />
                          </div>
                          <span className="body-sm pc-field__hint">
                            {bridgeNameError ?? "shown in the proxmox ui and used in vm/ct network config"}
                          </span>
                        </div>

                        <CidrField
                          id={`bridgeip-${keyPrefix}-${key0}`}
                          label={needsHostIp ? "static ip for this node" : "network (optional)"}
                          value={bridge.ip}
                          onChange={(value) => onBridgeChange(key0, { ip: value })}
                          placeholder={(() => {
                            const subnet =
                              placeholders.get(`${nodeIndex}#${key0}`) ??
                              nonCollidingPlaceholderSubnet(node, globalCidr, addressKeys.indexOf(key0), nodeIndex);
                            return needsHostIp ? (subnet?.host ?? "10.0.20.11/24") : (subnet?.network ?? "10.0.20.0/24");
                          })()}
                          error={ipError}
                          hint={
                            needsHostIp
                              ? requiredIpHintFor(bridge.purposes, bridge.otherNeedsHostIp)
                              : "the subnet vms/cts on this bridge should use — purely informational, the host won't have an address here"
                          }
                          defaultPrefix={lanPrefix}
                          required={needsHostIp}
                        />
                      </>
                    )}
                  </div>
                );
              })()}

            <BridgeCountField
              keyPrefix={keyPrefix}
              interfaceId={iface.id}
              count={node.network.bridgeCounts[iface.id] ?? "1"}
              onBridgeCountChange={onBridgeCountChange}
            />

            {Array.from({ length: Math.max(0, count - 1) }, (_, k) => k + 1).map((index) => {
              const extraKey = bridgeKey(iface.id, index);
              const extraBridge = node.network.bridges[extraKey];
              if (!extraBridge) return null;
              return (
                <ExtraBridgeCard
                  key={extraKey}
                  keyPrefix={keyPrefix}
                  bridgeId={extraKey}
                  heading={`${iface.label} — extra bridge (${extraBridge.name})`}
                  bridge={extraBridge}
                  siblingVlanTags={siblingVlanTagsFor(node.network.bridges, count, iface.id, index)}
                  allNames={allNames}
                  purposeOptions={purposeOptions}
                  storagePurpose={storagePurpose}
                  storagePurposeMissingHint={storagePurposeMissingHint}
                  onBridgeChange={onBridgeChange}
                  address={{
                    lanPrefix,
                    secondarySubnet:
                      placeholders.get(`${nodeIndex}#${extraKey}`) ??
                      nonCollidingPlaceholderSubnet(node, globalCidr, addressKeys.indexOf(extraKey), nodeIndex),
                  }}
                  conflictError={conflicts.get(`${nodeIndex}#${extraKey}`) ?? null}
                />
              );
            })}
          </div>
        );
      })}

      {[vmTrafficHint, storageHaHint, backupHint, corosyncHint]
        .filter((hint): hint is Hint => hint !== null)
        .map((hint, i) => (
          <div key={i} className={`pc-callout pc-callout--${hint.tone}`}>
            <span className="code pc-callout__glyph">{hint.glyph}</span>
            <div className="pc-callout__body">
              <p className="body-sm pc-callout__text">{hint.text}</p>
            </div>
          </div>
        ))}
    </>
  );
}

// bump this whenever the shape of PersistedState (or anything nested inside
// it) changes — a mismatched version is discarded wholesale rather than
// risking a crash or a half-applied state from an older save.
const STORAGE_KEY = "proxmox-computer:setup-wizard";
const STORAGE_VERSION = 5;

interface PersistedState {
  version: number;
  currentStep: WizardStepId;
  nodeCount: string;
  hostnameSuffix: string;
  globalCidr: string;
  gateway: string;
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
function isPersistedState(value: unknown): value is PersistedState {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (v.version !== STORAGE_VERSION) return false;
  if (v.currentStep !== "hardware" && v.currentStep !== "network") return false;
  if (typeof v.nodeCount !== "string") return false;
  if (typeof v.hostnameSuffix !== "string") return false;
  if (typeof v.globalCidr !== "string") return false;
  if (typeof v.gateway !== "string") return false;
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

function loadPersistedState(): PersistedState | null {
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

export default function Setup() {
  const [currentStep, setCurrentStep] = useState<WizardStepId>("hardware");
  const [nodeCount, setNodeCount] = useState("1");
  const [hostnameSuffix, setHostnameSuffix] = useState("homelab.lan");
  const [globalCidr, setGlobalCidr] = useState("10.0.10.0/24");
  const [gateway, setGateway] = useState(() => deriveGateway("10.0.10.0/24"));
  const [nodes, setNodes] = useState<NodeInfo[]>([defaultNode(0, "10.0.10.0/24")]);
  const [identicalHardware, setIdenticalHardware] = useState(false);
  const [identicalNetwork, setIdenticalNetwork] = useState(false);
  const [storageHaMode, setStorageHaMode] = useState<StorageHaMode>("ceph");
  // gates the save effect below so it never fires with the initial default
  // state before the restore attempt (which may replace that state) has
  // actually run — otherwise a freshly-loaded save could get clobbered by
  // defaults on the very first render.
  const [hydrated, setHydrated] = useState(false);

  // restore-on-mount: only ever applied if it passes isPersistedState in
  // full; anything else (missing key, bad json, wrong shape, future schema
  // change) silently leaves the clean defaults already in state untouched.
  // localStorage doesn't exist during ssr, so this has to run post-mount —
  // reading it during render would desync client output from the server
  // html. that's exactly what useEffect is for here, so the set-state-in-
  // effect rule's general advice doesn't apply to this specific case.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    const saved = loadPersistedState();
    if (saved) {
      setCurrentStep(saved.currentStep);
      setNodeCount(saved.nodeCount);
      setHostnameSuffix(saved.hostnameSuffix);
      setGlobalCidr(saved.globalCidr);
      setGateway(saved.gateway);
      setNodes(saved.nodes);
      setIdenticalHardware(saved.identicalHardware);
      setIdenticalNetwork(saved.identicalNetwork);
      setStorageHaMode(saved.storageHaMode);
    }
    setHydrated(true);
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

  // debounced autosave — only once hydrated, so this never overwrites a
  // save with the pre-restore defaults.
  useEffect(() => {
    if (!hydrated) return;
    const handle = setTimeout(() => {
      try {
        const payload: PersistedState = {
          version: STORAGE_VERSION,
          currentStep,
          nodeCount,
          hostnameSuffix,
          globalCidr,
          gateway,
          nodes,
          identicalHardware,
          identicalNetwork,
          storageHaMode,
        };
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
      } catch {
        // storage full, disabled, or unavailable — just skip persisting.
      }
    }, 300);
    return () => clearTimeout(handle);
  }, [
    hydrated,
    currentStep,
    nodeCount,
    hostnameSuffix,
    globalCidr,
    gateway,
    nodes,
    identicalHardware,
    identicalNetwork,
    storageHaMode,
  ]);

  const quorumHint = useMemo(() => quorumHintFor(nodes.length), [nodes.length]);
  const cpuHint = useMemo(() => cpuHintFor(nodes), [nodes]);
  const stepIndex = wizardSteps.findIndex((s) => s.id === currentStep);
  // the real subnet size for this homelab — used to fill in a sane
  // /prefix when a visitor types a bare ip with none, instead of /32.
  const lanPrefix = subnetDetails(globalCidr)?.prefix ?? 24;
  // one cluster-wide pass of ip/network suggestions for the network step
  // — recomputed whenever any node's network changes, so a shared-purpose
  // bridge's placeholder always reflects whatever an earlier node already
  // committed for it (see buildPlaceholderTable).
  const networkPlaceholders = useMemo(() => buildPlaceholderTable(nodes, globalCidr), [nodes, globalCidr]);
  // real (not placeholder) address problems: an exact ip reused anywhere,
  // or two of one node's own bridges/management ip whose ranges overlap.
  const addressConflicts = useMemo(() => buildAddressConflicts(nodes), [nodes]);
  const minDisks = useMemo(() => minAdditionalDisks(nodes), [nodes]);
  const clusterStorageAvailable = minDisks >= 1;
  const effectiveMode = useMemo(() => effectiveStorageHaMode(storageHaMode, nodes), [storageHaMode, nodes]);
  const storagePurpose = activeStoragePurpose(effectiveMode);

  // whenever the node count or the effective storage/ha decision changes
  // (including zfs silently losing its disks), drop any bridge purpose
  // that's no longer offered rather than leave it stuck in state with no
  // ui left to show or edit it. gated on hydrated for the same reason the
  // autosave effect is — otherwise this would run against the pre-restore
  // defaults and clobber whatever the restore is about to set.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!hydrated) return;
    const disallowed = (["ceph", "zfs"] as InterfacePurpose[]).filter((p) => p !== storagePurpose);
    setNodes((prev) => withoutPurposes(prev, disallowed));
  }, [hydrated, storagePurpose]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // every step switch (next/back, or the hydration restore landing on
  // whatever step was left off at) should start the visitor at the top of
  // that step's card, not wherever the previous step happened to be
  // scrolled to.
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [currentStep]);

  function handleNodeCountChange(value: string) {
    setNodeCount(value);
    const n = parseInt(value, 10);
    if (!Number.isNaN(n) && n >= 1 && n <= 16) {
      setNodes((prev) => resizeArray(prev, n, (i) => defaultNode(i, globalCidr)));
    }
  }

  function handleIdenticalHardwareChange(checked: boolean) {
    setIdenticalHardware(checked);
    if (checked) {
      setNodes((prev) => {
        if (prev.length === 0) return prev;
        const template = prev[0];
        return prev.map((node) => ({
          ...node,
          cpuVendor: template.cpuVendor,
          cpuFamily: template.cpuFamily,
          cpuCount: template.cpuCount,
          coresPerCpu: template.coresPerCpu,
          ramGb: template.ramGb,
          bootDiskType: template.bootDiskType,
          bootDiskSizeGb: template.bootDiskSizeGb,
          bootDiskName: template.bootDiskName,
          additionalDiskCount: template.additionalDiskCount,
          additionalDisks: template.additionalDisks.map((d) => ({ ...d })),
          nicCount: template.nicCount,
          nics: template.nics.map((n) => ({ ...n })),
          network: resyncNetworkForNics(node.network, template.nics.length),
        }));
      });
    }
  }

  function handleIdenticalNetworkChange(checked: boolean) {
    setIdenticalNetwork(checked);
    if (checked) {
      setNodes((prev) => (prev.length === 0 ? prev : applyNetworkStructure(prev, prev[0].network)));
    }
  }

  function updateNode(index: number, patch: Partial<NodeInfo>) {
    setNodes((prev) =>
      prev.map((node, i) => {
        if (i !== index) return node;
        const next = { ...node, ...patch };
        // node name feeds the hostname label default — keep it in sync
        // unless the visitor already typed a label of their own (in
        // which case leave their edit alone).
        if (patch.name && node.network.hostLabel === node.name) {
          next.network = { ...next.network, hostLabel: patch.name };
        }
        return next;
      }),
    );
  }

  function handleNicCountChange(index: number, value: string) {
    const n = parseInt(value, 10);
    setNodes((prev) =>
      prev.map((node, i) => {
        if (i !== index) return node;
        const clamped = !Number.isNaN(n) && n >= 1 && n <= 8 ? n : node.nics.length;
        return {
          ...node,
          nicCount: value,
          nics: resizeArray(node.nics, clamped, (idx) => ({ speed: "1gbe" as NicSpeed, name: defaultNicName(idx) })),
          network: resyncNetworkForNics(node.network, clamped),
        };
      }),
    );
  }

  function updateNic(nodeIndex: number, nicIndex: number, patch: Partial<NicInfo>) {
    setNodes((prev) =>
      prev.map((node, i) =>
        i !== nodeIndex
          ? node
          : { ...node, nics: node.nics.map((nic, j) => (j === nicIndex ? { ...nic, ...patch } : nic)) },
      ),
    );
  }

  function handleAdditionalDiskCountChange(nodeIndex: number, value: string) {
    const n = parseInt(value, 10);
    setNodes((prev) =>
      prev.map((node, i) => {
        if (i !== nodeIndex) return node;
        const clamped = !Number.isNaN(n) && n >= 0 && n <= 12 ? n : node.additionalDisks.length;
        return {
          ...node,
          additionalDiskCount: value,
          additionalDisks: resizeArray(node.additionalDisks, clamped, (idx) => defaultAdditionalDisk(idx)),
        };
      }),
    );
  }

  function updateAdditionalDisk(nodeIndex: number, diskIndex: number, patch: Partial<AdditionalDisk>) {
    setNodes((prev) =>
      prev.map((node, i) =>
        i !== nodeIndex
          ? node
          : {
              ...node,
              additionalDisks: node.additionalDisks.map((d, j) => (j === diskIndex ? { ...d, ...patch } : d)),
            },
      ),
    );
  }

  function updateAllNodesHardware(patch: Partial<HardwareSpec>) {
    setNodes((prev) => prev.map((node) => ({ ...node, ...patch })));
  }

  function updateAllNodesNicCount(value: string) {
    const n = parseInt(value, 10);
    setNodes((prev) =>
      prev.map((node) => {
        const clamped = !Number.isNaN(n) && n >= 1 && n <= 8 ? n : node.nics.length;
        return {
          ...node,
          nicCount: value,
          nics: resizeArray(node.nics, clamped, (idx) => ({ speed: "1gbe" as NicSpeed, name: defaultNicName(idx) })),
          network: resyncNetworkForNics(node.network, clamped),
        };
      }),
    );
  }

  function updateAllNodesNic(nicIndex: number, patch: Partial<NicInfo>) {
    setNodes((prev) =>
      prev.map((node) => ({
        ...node,
        nics: node.nics.map((nic, j) => (j === nicIndex ? { ...nic, ...patch } : nic)),
      })),
    );
  }

  function updateAllNodesAdditionalDiskCount(value: string) {
    const n = parseInt(value, 10);
    setNodes((prev) =>
      prev.map((node) => {
        const clamped = !Number.isNaN(n) && n >= 0 && n <= 12 ? n : node.additionalDisks.length;
        return {
          ...node,
          additionalDiskCount: value,
          additionalDisks: resizeArray(node.additionalDisks, clamped, (idx) => defaultAdditionalDisk(idx)),
        };
      }),
    );
  }

  function updateAllNodesAdditionalDisk(diskIndex: number, patch: Partial<AdditionalDisk>) {
    setNodes((prev) =>
      prev.map((node) => ({
        ...node,
        additionalDisks: node.additionalDisks.map((d, j) => (j === diskIndex ? { ...d, ...patch } : d)),
      })),
    );
  }

  function handleGlobalCidrChange(value: string) {
    setGlobalCidr(value);
    setGateway(deriveGateway(value));
    setNodes((prev) =>
      prev.map((node, i) => ({
        ...node,
        network: { ...node.network, cidr: deriveNodeCidr(value, i) },
      })),
    );
  }

  function updateNodeNetwork(index: number, patch: Partial<NodeNetwork>) {
    setNodes((prev) =>
      prev.map((node, i) => (i === index ? { ...node, network: { ...node.network, ...patch } } : node)),
    );
  }

  // when "identical network setup" is on, every structural change below
  // (bonds, management interface, bridge purposes/enabled/name) is mirrored
  // onto every node right after it's applied to the one actually edited —
  // hostLabel/cidr/bridge-ip never go through this path, so those stay
  // unique regardless.
  function propagateIfIdentical(updated: NodeInfo[], sourceIndex: number): NodeInfo[] {
    return identicalNetwork ? applyNetworkStructure(updated, updated[sourceIndex].network) : updated;
  }

  function setManagementInterface(index: number, interfaceId: string) {
    setNodes((prev) => {
      const updated = prev.map((node, i) =>
        i === index
          ? { ...node, network: resyncNetworkForNics(node.network, node.nics.length, { managementInterfaceId: interfaceId }) }
          : node,
      );
      return propagateIfIdentical(updated, index);
    });
  }

  function updateBridge(index: number, interfaceId: string, patch: Partial<BridgeConfig>) {
    setNodes((prev) => {
      const updated = prev.map((node, i) =>
        i === index
          ? {
              ...node,
              network: {
                ...node.network,
                bridges: {
                  ...node.network.bridges,
                  [interfaceId]: { ...node.network.bridges[interfaceId], ...patch },
                },
              },
            }
          : node,
      );
      // ip is always this node's own address — never propagate it, even
      // when nodes are otherwise kept structurally identical.
      const isStructural = "purposes" in patch || "enabled" in patch || "name" in patch || "otherNeedsHostIp" in patch;
      return isStructural ? propagateIfIdentical(updated, index) : updated;
    });
  }

  // resizes just ONE interface's bridge count — deliberately narrower
  // than the resyncNetworkForNics-based handlers below: growing/shrinking
  // one interface's bridge count doesn't invalidate what any other
  // interface's bridges are configured as, so only this interface's own
  // slots are touched.
  function updateBridgeCount(index: number, interfaceId: string, value: string) {
    setNodes((prev) => {
      const updated = prev.map((node, i) => {
        if (i !== index) return node;
        const n = parseInt(value, 10);
        const clamped = !Number.isNaN(n) && n >= 1 && n <= 4 ? n : bridgeCountFor(node.network.bridgeCounts, interfaceId);
        const bridges = { ...node.network.bridges };
        for (let idx = 0; idx < 8; idx++) {
          const key = bridgeKey(interfaceId, idx);
          if (idx < clamped && !bridges[key]) {
            bridges[key] = {
              enabled: true,
              name: nextVmbrName(bridges),
              purposes: ["vm"],
              otherNeedsHostIp: false,
              ip: "",
              vlanTag: "",
            };
          } else if (idx >= clamped && bridges[key]) {
            delete bridges[key];
          }
        }
        return {
          ...node,
          network: {
            ...node.network,
            bridgeCounts: { ...node.network.bridgeCounts, [interfaceId]: String(clamped) },
            bridges,
          },
        };
      });
      return propagateIfIdentical(updated, index);
    });
  }

  function handleBondCountChange(index: number, value: string) {
    const n = parseInt(value, 10);
    setNodes((prev) => {
      const updated = prev.map((node, i) => {
        if (i !== index) return node;
        const clamped = !Number.isNaN(n) && n >= 0 && n <= 4 ? n : node.network.bonds.length;
        const bonds = resizeArray(node.network.bonds, clamped, (idx) => ({
          name: defaultBondName(idx),
          mode: "active-backup" as BondMode,
          nicIndices: [],
        }));
        return { ...node, network: resyncNetworkForNics(node.network, node.nics.length, { bonds }) };
      });
      return propagateIfIdentical(updated, index);
    });
  }

  function toggleBondNic(index: number, bondIndex: number, nicIndex: number, checked: boolean) {
    setNodes((prev) => {
      const updated = prev.map((node, i) => {
        if (i !== index) return node;
        const bonds = node.network.bonds.map((b, j) => {
          if (j !== bondIndex) return b;
          const nicIndices = checked
            ? [...b.nicIndices, nicIndex].sort((a, b2) => a - b2)
            : b.nicIndices.filter((idx) => idx !== nicIndex);
          return { ...b, nicIndices };
        });
        return { ...node, network: resyncNetworkForNics(node.network, node.nics.length, { bonds }) };
      });
      return propagateIfIdentical(updated, index);
    });
  }

  function updateBondMeta(index: number, bondIndex: number, patch: Partial<Pick<BondConfig, "name" | "mode">>) {
    setNodes((prev) => {
      const updated = prev.map((node, i) => {
        if (i !== index) return node;
        // name/mode never change which interfaces exist, so patch bonds
        // directly rather than going through the full resync — that
        // would otherwise wipe out bridge customizations for no reason.
        const bonds = node.network.bonds.map((b, j) => (j === bondIndex ? { ...b, ...patch } : b));
        return { ...node, network: { ...node.network, bonds } };
      });
      return propagateIfIdentical(updated, index);
    });
  }

  const nodeCountError = validateIntRange(nodeCount, 1, 16, { required: true });
  const hostnameSuffixError = validateHostnameSuffix(hostnameSuffix);
  const globalCidrError = validateCidr(globalCidr);
  const gatewayError = validateIp(gateway);

  return (
    <div className="pc-root flex min-h-full flex-col">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-4xl items-center justify-between px-6 py-5">
          <Link href="/" className="flex items-center gap-2.5">
            <span className="code flex h-7 w-7 items-center justify-center bg-accent font-bold text-on-accent">
              {">"}
            </span>
            <span className="text-[15px] font-semibold tracking-tight">
              proxmox<span className="text-accent">.computer</span>
            </span>
          </Link>
          <Link href="/" className="meta text-ink-muted transition-colors hover:text-ink">
            ← back
          </Link>
        </div>
      </header>

      <main className="flex-1 px-6 py-12">
        <div className="pc-stepflow mx-auto">
          <div className="pc-stepflow__head">
            <div className="pc-steps">
              {wizardSteps.map((s, i) => (
                <div
                  key={s.id}
                  className={`pc-step ${i === stepIndex ? "pc-step--active" : i < stepIndex ? "pc-step--done" : ""}`}
                >
                  <div className="pc-step__marker">{i < stepIndex ? "✓" : String(i + 1).padStart(2, "0")}</div>
                  <span className="label pc-step__label">{s.label}</span>
                  {i < wizardSteps.length - 1 && <div className="pc-step__connector" />}
                </div>
              ))}
            </div>
          </div>

          {currentStep === "hardware" && (
            <div className="pc-stepflow__card">
              <p className="meta pc-stepflow__meta"># step 1 of 5</p>
              <h2 className="h2 pc-stepflow__title">hardware</h2>
              <p className="body pc-stepflow__intro">
                Tell us about every node. proxmox.computer uses this to plan
                networking, storage and cluster quorum in the next steps.
              </p>

              <div className="pc-stepflow__fields">
                <div className={`pc-field ${nodeCountError ? "pc-field--error" : ""}`}>
                  <label className="label pc-field__label" htmlFor="node-count">
                    number of nodes
                    <span className="pc-field__required"> *</span>
                  </label>
                  <div className="pc-field__control">
                    <input
                      id="node-count"
                      className="pc-field__input code"
                      type="number"
                      min={1}
                      max={16}
                      value={nodeCount}
                      onChange={(e) => handleNodeCountChange(e.target.value)}
                    />
                  </div>
                  <span className="body-sm pc-field__hint">{nodeCountError ?? "1–16 physical hosts"}</span>
                </div>

                <div className={`pc-callout pc-callout--${quorumHint.tone}`}>
                  <span className="code pc-callout__glyph">{quorumHint.glyph}</span>
                  <div className="pc-callout__body">
                    <p className="body pc-callout__text">{quorumHint.text}</p>
                  </div>
                </div>

                {nodes.length > 1 && (
                  <label className="pc-checkbox">
                    <input
                      type="checkbox"
                      checked={identicalHardware}
                      onChange={(e) => handleIdenticalHardwareChange(e.target.checked)}
                    />
                    <span className="pc-checkbox__box" />
                    <span>
                      <span className="code pc-checkbox__label">identical hardware across all nodes</span>
                      <span className="body-sm pc-checkbox__hint">fill in the specs once below, applied to every node</span>
                    </span>
                  </label>
                )}

                {identicalHardware && nodes.length > 1 && (
                  <div
                    className="flex flex-col border border-border bg-surface-100 p-5"
                    style={{ gap: "var(--space-5)" }}
                  >
                    <p className="label text-ink-muted">hardware — all nodes</p>
                    <HardwareFields
                      keyPrefix="shared"
                      values={nodes[0]}
                      allNames={collectNodeNames(nodes[0])}
                      onChange={updateAllNodesHardware}
                      onNicCountChange={updateAllNodesNicCount}
                      onNicChange={updateAllNodesNic}
                      onAdditionalDiskCountChange={updateAllNodesAdditionalDiskCount}
                      onAdditionalDiskChange={updateAllNodesAdditionalDisk}
                    />
                  </div>
                )}

                {nodes.map((node, i) => {
                  const nameError = validateHostLabel(node.name);

                  return (
                    <div
                      key={i}
                      className="flex flex-col border border-border bg-surface-100 p-5"
                      style={{ gap: "var(--space-5)" }}
                    >
                      <p className="label text-ink-muted">node {String(i + 1).padStart(2, "0")}</p>

                      <div className={`pc-field ${nameError ? "pc-field--error" : ""}`}>
                        <label className="label pc-field__label" htmlFor={`name-${i}`}>
                          node name
                        </label>
                        <div className="pc-field__control">
                          <span className="code pc-field__bracket">$</span>
                          <input
                            id={`name-${i}`}
                            className="pc-field__input code"
                            type="text"
                            value={node.name}
                            onChange={(e) => updateNode(i, { name: e.target.value })}
                          />
                        </div>
                        <span className="body-sm pc-field__hint">
                          {nameError ?? "short, lowercase — used across the cluster and in pvecm status"}
                        </span>
                      </div>

                      {(!identicalHardware || nodes.length <= 1) && (
                        <HardwareFields
                          keyPrefix={`node-${i}`}
                          values={node}
                          allNames={collectNodeNames(node)}
                          onChange={(patch) => updateNode(i, patch)}
                          onNicCountChange={(value) => handleNicCountChange(i, value)}
                          onNicChange={(nicIndex, patch) => updateNic(i, nicIndex, patch)}
                          onAdditionalDiskCountChange={(value) => handleAdditionalDiskCountChange(i, value)}
                          onAdditionalDiskChange={(diskIndex, patch) => updateAdditionalDisk(i, diskIndex, patch)}
                        />
                      )}
                    </div>
                  );
                })}

                {cpuHint && (
                  <div className={`pc-callout pc-callout--${cpuHint.tone}`}>
                    <span className="code pc-callout__glyph">{cpuHint.glyph}</span>
                    <div className="pc-callout__body">
                      <p className="body pc-callout__text">{cpuHint.text}</p>
                    </div>
                  </div>
                )}
              </div>

              <div className="pc-stepflow__nav">
                <Link href="/" className="pc-btn pc-btn--ghost">
                  ← back to overview
                </Link>
                <button type="button" className="pc-btn pc-btn--primary" onClick={() => setCurrentStep("network")}>
                  <span className="pc-btn__bracket">[</span>
                  next
                  <span className="pc-btn__bracket">]</span>
                </button>
              </div>
            </div>
          )}

          {currentStep === "network" && (
            <div className="pc-stepflow__card">
              <p className="meta pc-stepflow__meta"># step 2 of 5</p>
              <h2 className="h2 pc-stepflow__title">network</h2>
              <p className="body pc-stepflow__intro">
                Set the domain and address range for your homelab.
                proxmox.computer uses these to generate a hostname, ip and
                bridge layout for every node below.
              </p>

              <div className="pc-stepflow__fields">
                <div className={`pc-field ${hostnameSuffixError ? "pc-field--error" : ""}`}>
                  <label className="label pc-field__label" htmlFor="hostname-suffix">
                    hostname suffix
                  </label>
                  <div className="pc-field__control">
                    <span className="code pc-field__bracket">$</span>
                    <input
                      id="hostname-suffix"
                      className="pc-field__input code"
                      type="text"
                      placeholder="e.g. homelab.lan"
                      value={hostnameSuffix}
                      onChange={(e) => setHostnameSuffix(e.target.value)}
                    />
                  </div>
                  <span className="body-sm pc-field__hint">
                    {hostnameSuffixError ?? "appended to every node name to form its fqdn, e.g. pve01.homelab.lan"}
                  </span>
                </div>

                <CidrField
                  id="global-cidr"
                  label="homelab cidr"
                  value={globalCidr}
                  onChange={handleGlobalCidrChange}
                  placeholder="10.0.10.0/24"
                  error={globalCidrError}
                  hint="the network your nodes live on — used to generate each node's management ip"
                />

                <div className={`pc-field ${gatewayError ? "pc-field--error" : ""}`}>
                  <label className="label pc-field__label" htmlFor="gateway">
                    gateway
                  </label>
                  <div className="pc-field__control">
                    <span className="code pc-field__bracket">#</span>
                    <input
                      id="gateway"
                      className="pc-field__input code"
                      type="text"
                      placeholder={`e.g. ${deriveGateway(globalCidr) || "10.0.10.1"}`}
                      value={gateway}
                      onChange={(e) => setGateway(e.target.value)}
                    />
                  </div>
                  <span className="body-sm pc-field__hint">
                    {gatewayError ?? "default route for every node — usually your router or firewall"}
                  </span>
                </div>

                {nodes.length > 1 && (
                  <label className="pc-checkbox">
                    <input
                      type="checkbox"
                      checked={identicalNetwork}
                      onChange={(e) => handleIdenticalNetworkChange(e.target.checked)}
                    />
                    <span className="pc-checkbox__box" />
                    <span>
                      <span className="code pc-checkbox__label">identical network setup across all nodes</span>
                      <span className="body-sm pc-checkbox__hint">
                        keeps bonds, the management interface choice, and every bridge&apos;s purpose/name in sync — each
                        node still gets its own hostname and ip addresses
                      </span>
                    </span>
                  </label>
                )}

                {nodes.length > 1 && (
                  <fieldset className="pc-radio-group" style={{ border: 0, margin: 0, padding: 0 }}>
                    <legend className="label pc-radio-group__legend">cluster storage</legend>
                    {STORAGE_HA_OPTIONS.filter((opt) => opt.value === "none" || clusterStorageAvailable).map((opt) => (
                      <label key={opt.value} className="pc-radio">
                        <input
                          type="radio"
                          name="storage-ha-mode"
                          checked={effectiveMode === opt.value}
                          onChange={() => setStorageHaMode(opt.value)}
                        />
                        <span className="pc-radio__box" />
                        <span>
                          <span className="code pc-radio__label">{opt.label}</span>
                          <span className="body-sm pc-checkbox__hint">{opt.hint}</span>
                        </span>
                      </label>
                    ))}
                    {!clusterStorageAvailable && (
                      <p className="body-sm pc-field__hint">
                        ceph and zfs replication both need at least 1 disk beyond the boot disk on every node — your worst-equipped node currently has {minDisks}, so it sets the limit for the whole cluster. add one in step 1 to unlock either option here
                      </p>
                    )}
                  </fieldset>
                )}

                <div className="pc-callout pc-callout--info">
                  <span className="code pc-callout__glyph">#</span>
                  <div className="pc-callout__body">
                    <p className="body pc-callout__text">
                      Proxmox bridges the management nic as vmbr0 by
                      default — that&apos;s the interface both the web ui
                      and vms reach the network through. Nics doing the
                      same job for redundancy or more bandwidth want
                      bonding — combine them into a bond below, then bridge
                      the bond, rather than bridging each nic separately.
                      Nics or bonds doing genuinely different jobs (say,
                      ceph vs. a separate vm vlan) each get their own
                      bridge below, and each one asks what it&apos;s for —
                      that decides whether it needs a static ip or just a
                      network.
                    </p>
                  </div>
                </div>

                {identicalNetwork && nodes.length > 1 && (
                  <div
                    className="flex flex-col border border-border bg-surface-100 p-5"
                    style={{ gap: "var(--space-5)" }}
                  >
                    <p className="label text-ink-muted">network structure — all nodes</p>
                    <NetworkStructureFields
                      keyPrefix="shared"
                      node={nodes[0]}
                      nodeCount={nodes.length}
                      storageHaMode={storageHaMode}
                      storagePurpose={storagePurpose}
                      onBondCountChange={(value) => handleBondCountChange(0, value)}
                      onToggleBondNic={(bondIndex, nicIndex, checked) => toggleBondNic(0, bondIndex, nicIndex, checked)}
                      onUpdateBondMeta={(bondIndex, patch) => updateBondMeta(0, bondIndex, patch)}
                      onManagementInterfaceChange={(interfaceId) => setManagementInterface(0, interfaceId)}
                      onBridgeChange={(bridgeId, patch) => updateBridge(0, bridgeId, patch)}
                      onBridgeCountChange={(interfaceId, value) => updateBridgeCount(0, interfaceId, value)}
                    />
                  </div>
                )}

                {nodes.map((node, i) => (
                  <div
                    key={i}
                    className="flex flex-col border border-border bg-surface-100 p-5"
                    style={{ gap: "var(--space-5)" }}
                  >
                    <p className="label text-ink-muted">
                      node {String(i + 1).padStart(2, "0")} — {node.name}
                    </p>
                    {identicalNetwork && nodes.length > 1 ? (
                      <NetworkAddressFields
                        keyPrefix={`node-${i}`}
                        node={node}
                        nodeIndex={i}
                        hostnameSuffix={hostnameSuffix}
                        lanPrefix={lanPrefix}
                        globalCidr={globalCidr}
                        placeholders={networkPlaceholders}
                        conflicts={addressConflicts}
                        onChange={(patch) => updateNodeNetwork(i, patch)}
                        onBridgeChange={(bridgeId, patch) => updateBridge(i, bridgeId, patch)}
                      />
                    ) : (
                      <NetworkFields
                        keyPrefix={`node-${i}`}
                        node={node}
                        nodeIndex={i}
                        hostnameSuffix={hostnameSuffix}
                        lanPrefix={lanPrefix}
                        globalCidr={globalCidr}
                        nodeCount={nodes.length}
                        storageHaMode={storageHaMode}
                        storagePurpose={storagePurpose}
                        placeholders={networkPlaceholders}
                        conflicts={addressConflicts}
                        onChange={(patch) => updateNodeNetwork(i, patch)}
                        onBondCountChange={(value) => handleBondCountChange(i, value)}
                        onToggleBondNic={(bondIndex, nicIndex, checked) => toggleBondNic(i, bondIndex, nicIndex, checked)}
                        onUpdateBondMeta={(bondIndex, patch) => updateBondMeta(i, bondIndex, patch)}
                        onManagementInterfaceChange={(interfaceId) => setManagementInterface(i, interfaceId)}
                        onBridgeChange={(bridgeId, patch) => updateBridge(i, bridgeId, patch)}
                        onBridgeCountChange={(interfaceId, value) => updateBridgeCount(i, interfaceId, value)}
                      />
                    )}
                  </div>
                ))}
              </div>

              <div className="pc-stepflow__nav">
                <button type="button" className="pc-btn" onClick={() => setCurrentStep("hardware")}>
                  <span className="pc-btn__bracket">[</span>
                  back
                  <span className="pc-btn__bracket">]</span>
                </button>
                <button type="button" className="pc-btn" disabled title="steps 3–5 aren't built yet">
                  <span className="pc-btn__bracket">[</span>
                  next
                  <span className="pc-btn__bracket">]</span>
                </button>
              </div>
            </div>
          )}

          <p className="meta mt-3 text-ink-muted">
            steps 3–5 — storage, backups, install software — aren&apos;t built yet.
          </p>
        </div>
      </main>
    </div>
  );
}
