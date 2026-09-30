// Step 7's logic: the vms and containers the cluster runs, in the detail
// proxmox's own "create vm" and "create ct" dialogs ask for. Every choice
// a guest offers is derived from the steps before it — the storage it can
// live on (step 4), the bridges it can join (step 3), the cpu types its
// nodes can run (step 2), whether it can be highly available — and only
// combinations proxmox accepts are offered at all.

import images from "@/data/guest-images.json";
import type { Hint } from "./hints";
import { clusterCpuBaseline, cpuTypeOptions, effectiveCpuType } from "./cpu";
import { effectiveClusterStorage } from "./derive";
import {
  bootDiskLayout,
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
import {
  isValidIPv4,
  subnetDetails,
  validateHostCidr,
  validateHostLabel,
  validateIntRange,
  validateOptionalVlanTag,
} from "./validation";
import {
  bridgeKey,
  enabledStorageModes,
  isStorageLink,
  type ClusterStorage,
  type NodeInfo,
  type StoragePlan,
} from "./wizard-state";

export type GuestKind = "vm" | "container";
export type GuestIpMode = "dhcp" | "static" | "none";
export type DiskBus = "scsi" | "virtio" | "sata" | "ide";
export type DiskCache = "none" | "writethrough" | "writeback" | "directsync" | "unsafe";
export type NicModel = "virtio" | "e1000" | "rtl8139" | "vmxnet3";
export type MachineType = "q35" | "i440fx";
export type BiosType = "seabios" | "ovmf";
export type ScsiController = "virtio-scsi-single" | "virtio-scsi-pci" | "lsi" | "megasas" | "pvscsi";
export type DisplayType = "default" | "std" | "virtio" | "qxl" | "serial0" | "none";
export type OsType = "l26" | "win11" | "win10" | "other";
// a vm's part in the kubernetes cluster step 7 plans — "" for any other guest
export type K8sRole = "" | "control-plane" | "worker";

export interface GuestDisk {
  id: string;
  storage: string;
  sizeGb: string;
  // vm only
  bus: DiskBus;
  cache: DiskCache;
  discard: boolean;
  ssd: boolean;
  iothread: boolean;
  // both
  backup: boolean;
  replicate: boolean;
  // container only: "/" for the root disk, a path for a mount point
  mountPath: string;
}

export interface GuestNic {
  id: string;
  bridge: string;
  vlanTag: string;
  // vm only
  model: NicModel;
  firewall: boolean;
  // blank: proxmox generates one
  macAddress: string;
  // mb/s, blank = unlimited
  rateMbps: string;
  // blank = the bridge's
  mtu: string;
  // containers always; vms through cloud-init
  ipMode: GuestIpMode;
  ip: string;
  gateway: string;
}

export interface GuestPlan {
  // stable identity for the form — survives renames and vmid edits
  id: string;
  kind: GuestKind;
  name: string;
  vmid: string;
  image: string;
  // proxmox tags, separated by ; or spaces
  tags: string;
  notes: string;
  // the node it runs on, by index — read through effectiveGuestNode
  node: string;
  // restarted on another node if its own fails — needs storage every node reaches
  ha: boolean;
  startOnBoot: boolean;
  // blank = proxmox's defaults
  startupOrder: string;
  startupDelay: string;
  shutdownTimeout: string;
  // cpu — sockets, type and numa are vm only
  sockets: string;
  cores: string;
  // "" = the cluster's baseline (see effectiveGuestCpuType)
  cpuType: string;
  // blank = unlimited
  cpuLimit: string;
  // blank = proxmox's default weight, 100
  cpuUnits: string;
  numa: boolean;
  // gib
  memoryGb: string;
  // vm: let the balloon driver hand memory back, down to minMemoryGb
  ballooning: boolean;
  minMemoryGb: string;
  // container
  swapGb: string;
  // vm system
  osType: OsType;
  machine: MachineType;
  bios: BiosType;
  tpm: boolean;
  scsiController: ScsiController;
  qemuAgent: boolean;
  display: DisplayType;
  // container features
  unprivileged: boolean;
  nesting: boolean;
  fuse: boolean;
  keyctl: boolean;
  // root's (or the cloud-init user's) keys: step 6's
  useAccessKeys: boolean;
  // vm, cloud-init images: the login user it creates
  ciUser: string;
  // kubernetes nodes are never ha: kubernetes reschedules their pods itself
  k8sRole: K8sRole;
  disks: GuestDisk[];
  nics: GuestNic[];
}

/** the kubernetes cluster's own storage, beyond its vms' disks */
export interface KubernetesPlan {
  // persistent volumes on ceph rbd, through ceph-csi — read through effectiveCephVolumes
  cephVolumes: boolean;
  // gb set aside in ceph for them — before replication
  volumeGb: string;
}

export interface SoftwarePlan {
  guests: GuestPlan[];
  kubernetes: KubernetesPlan;
}

export function defaultKubernetesPlan(): KubernetesPlan {
  return { cephVolumes: true, volumeGb: "200" };
}

export function defaultSoftwarePlan(): SoftwarePlan {
  return { guests: [], kubernetes: defaultKubernetesPlan() };
}

/** the rbd pool ceph-csi provisions persistent volumes in — next to the vms' own */
export const K8S_VOLUME_POOL = "k8s-volumes";

// ── option lists ─────────────────────────────────────────────────────────

export const IMAGE_OPTIONS: { id: string; kind: GuestKind; label: string; cloudInit: boolean }[] = images as {
  id: string;
  kind: GuestKind;
  label: string;
  cloudInit: boolean;
}[];

export function imagesFor(kind: GuestKind) {
  return IMAGE_OPTIONS.filter((i) => i.kind === kind);
}

export function imageLabel(id: string): string {
  return IMAGE_OPTIONS.find((i) => i.id === id)?.label ?? id;
}

/** a vm image the wizard can configure through cloud-init — ip, user, keys */
export function takesCloudInit(guest: Pick<GuestPlan, "kind" | "image">): boolean {
  return guest.kind === "vm" && (IMAGE_OPTIONS.find((i) => i.id === guest.image)?.cloudInit ?? false);
}

// how many disks each bus takes (ide2 is left for the cd drive / cloud-init)
export const BUS_OPTIONS: { value: DiskBus; label: string; max: number }[] = [
  { value: "scsi", label: "scsi — the default, with discard and io threads", max: 31 },
  { value: "virtio", label: "virtio block — lean, linux guests", max: 16 },
  { value: "sata", label: "sata — for guests without virtio drivers", max: 6 },
  { value: "ide", label: "ide — legacy guests only", max: 3 },
];

export const CACHE_OPTIONS: { value: DiskCache; label: string }[] = [
  { value: "none", label: "none — the safe default" },
  { value: "writethrough", label: "write through — cached reads, safe writes" },
  { value: "writeback", label: "write back — faster writes, lost on a host crash" },
  { value: "directsync", label: "direct sync — no cache at all" },
  { value: "unsafe", label: "unsafe — ignores flushes; scratch disks only" },
];

export const NIC_MODEL_OPTIONS: { value: NicModel; label: string }[] = [
  { value: "virtio", label: "virtio — fastest, needs drivers (linux has them)" },
  { value: "e1000", label: "intel e1000 — works everywhere, slower" },
  { value: "vmxnet3", label: "vmware vmxnet3 — for images from vmware" },
  { value: "rtl8139", label: "realtek rtl8139 — very old guests" },
];

export const OS_TYPE_OPTIONS: { value: OsType; label: string }[] = [
  { value: "l26", label: "linux 6.x / 5.x / 4.x / 2.6" },
  { value: "win11", label: "windows 11 / 2022 / 2025" },
  { value: "win10", label: "windows 10 / 2016 / 2019" },
  { value: "other", label: "other" },
];

export const MACHINE_OPTIONS: { value: MachineType; label: string }[] = [
  { value: "q35", label: "q35 — pcie, the modern chipset" },
  { value: "i440fx", label: "i440fx — the classic, for older guests" },
];

export const BIOS_OPTIONS: { value: BiosType; label: string }[] = [
  { value: "seabios", label: "seabios — legacy bios" },
  { value: "ovmf", label: "ovmf — uefi (gets an efi disk)" },
];

export const SCSI_CONTROLLER_OPTIONS: { value: ScsiController; label: string }[] = [
  { value: "virtio-scsi-single", label: "virtio scsi single — one queue per disk, io threads" },
  { value: "virtio-scsi-pci", label: "virtio scsi — one controller for all disks" },
  { value: "lsi", label: "lsi 53c895a — no drivers needed" },
  { value: "megasas", label: "megaraid sas" },
  { value: "pvscsi", label: "vmware pvscsi" },
];

export const DISPLAY_OPTIONS: { value: DisplayType; label: string }[] = [
  { value: "default", label: "default" },
  { value: "std", label: "standard vga" },
  { value: "virtio", label: "virtio-gpu" },
  { value: "qxl", label: "spice (qxl)" },
  { value: "serial0", label: "serial terminal — cloud images often want this" },
  { value: "none", label: "none" },
];

/** io threads need their own queue: a virtio disk, or scsi on the single controller */
export function iothreadPossible(disk: GuestDisk, guest: GuestPlan): boolean {
  return disk.bus === "virtio" || (disk.bus === "scsi" && guest.scsiController === "virtio-scsi-single");
}

/** virtio block has no ssd emulation — it's not a physical disk type */
export function ssdPossible(disk: GuestDisk): boolean {
  return disk.bus !== "virtio";
}

// ── what the cluster offers a guest ─────────────────────────────────────

/** what the storage, network and cpu choices are read from */
export interface GuestContext {
  nodes: NodeInfo[];
  clusterStorage: ClusterStorage;
  storage: StoragePlan;
  // what the kubernetes cluster keeps in ceph — absent, nothing
  kubernetes?: KubernetesPlan;
}

export interface StorageOption {
  id: string;
  label: string;
  // every node reaches it (ceph) or holds a replica (zfs), so the guest can
  // move — the precondition for ha
  shared: boolean;
}

/** a guest's node, clamped to the nodes that exist now */
export function effectiveGuestNode(guest: GuestPlan, nodeCount: number): number {
  const n = Number(guest.node);
  return Number.isInteger(n) && n >= 0 && n < nodeCount ? n : 0;
}

/**
 * The storage a guest on this node can live on: the pools step 4 builds
 * that reach it, plus local-lvm — the installer always carves that out of
 * the boot disk (ext4, the answer file's layout).
 */
export function storageOptions(ctx: GuestContext, nodeIndex: number): StorageOption[] {
  const active = effectiveClusterStorage(ctx.clusterStorage, ctx.nodes);
  const planNodes = withEffectiveDiskRoles(ctx.nodes, enabledStorageModes(active));
  const node = planNodes[nodeIndex];
  const options: StorageOption[] = [];
  if (active.ceph) options.push({ id: ctx.storage.ceph.poolName, label: `${ctx.storage.ceph.poolName} — ceph, every node`, shared: true });
  if (active.zfs && node && disksWithRole(node, "zfs").length > 0) {
    options.push({ id: ctx.storage.zfs.poolName, label: `${ctx.storage.zfs.poolName} — zfs, replicated`, shared: true });
  }
  if (node && disksWithRole(node, "local").length > 0) {
    options.push({ id: ctx.storage.local.name, label: `${ctx.storage.local.name} — ${ctx.storage.local.kind}, this node only`, shared: false });
  }
  options.push({ id: "local-lvm", label: "local-lvm — the boot disk, this node only", shared: false });
  return options;
}

/** a disk's storage in effect: the choice if the node offers it, else the first option */
export function effectiveDiskStorage(disk: GuestDisk, guest: GuestPlan, ctx: GuestContext): StorageOption {
  const options = storageOptions(ctx, effectiveGuestNode(guest, ctx.nodes.length));
  return options.find((o) => o.id === disk.storage) ?? options[0];
}

/**
 * ha needs every disk on storage the other nodes reach, and another node
 * to move to. A kubernetes node never gets it: kubernetes already moves
 * its pods off a failed node, and a restarted copy would only rejoin late.
 */
export function haAvailable(guest: GuestPlan, ctx: GuestContext): boolean {
  if (guest.k8sRole) return false;
  return ctx.nodes.length >= 2 && guest.disks.every((d) => effectiveDiskStorage(d, guest, ctx).shared);
}

export function isKubernetesNode(guest: GuestPlan): boolean {
  return guest.k8sRole !== "";
}

/** ceph-backed persistent volumes: chosen, ceph built in step 4, and a kubernetes cluster to use them */
export function effectiveCephVolumes(guests: GuestPlan[], ctx: GuestContext): boolean {
  if (!ctx.kubernetes?.cephVolumes || !guests.some(isKubernetesNode)) return false;
  return effectiveClusterStorage(ctx.clusterStorage, ctx.nodes).ceph;
}

/** what the persistent volumes take from ceph, in gb before replication — 0 when they're not on it */
export function cephVolumeGb(guests: GuestPlan[], ctx: GuestContext): number {
  return effectiveCephVolumes(guests, ctx) ? Number(ctx.kubernetes?.volumeGb) || 0 : 0;
}

export function validateVolumeGb(value: string): string | null {
  if (!value) return "required";
  return validateIntRange(value, 1, 1_000_000);
}

/** the bridges a node offers guests: enabled, and carrying vm traffic */
function vmBridgesOn(node: NodeInfo): string[] {
  return Object.entries(node.network.bridges)
    .filter(([key, b]) => b.enabled && b.name && b.purposes.includes("vm") && !isStorageLink(node.network, key))
    .map(([, b]) => b.name);
}

/**
 * The bridges a guest can join. An ha guest can wake up on any node, so it
 * gets only the bridges every node has.
 */
export function bridgeOptions(ctx: GuestContext, nodeIndex: number, ha: boolean): string[] {
  const own = vmBridgesOn(ctx.nodes[nodeIndex] ?? ctx.nodes[0]);
  if (!ha) return [...new Set(own)];
  return [...new Set(own)].filter((name) => ctx.nodes.every((n) => vmBridgesOn(n).includes(name)));
}

/** the nodes a guest may run on: its own — or, highly available, any */
function nodesFor(guest: GuestPlan, ctx: GuestContext): NodeInfo[] {
  if (guest.ha && haAvailable(guest, ctx)) return ctx.nodes;
  return [ctx.nodes[effectiveGuestNode(guest, ctx.nodes.length)]].filter(Boolean);
}

/** the cpu types a vm can use: every node it may run on has to be able to run it */
export function guestCpuTypeOptions(guest: GuestPlan, ctx: GuestContext): string[] {
  return cpuTypeOptions(nodesFor(guest, ctx));
}

/** the cpu type in effect: the choice while it's possible, else step 2's cluster baseline */
export function effectiveGuestCpuType(guest: GuestPlan, ctx: GuestContext): string {
  return effectiveCpuType(guest.cpuType, guestCpuTypeOptions(guest, ctx), clusterCpuBaseline(ctx.nodes));
}

/**
 * Holds a guest to what its node offers after any edit: storage and
 * bridges it doesn't have are re-picked, ha drops if a disk can't follow,
 * and options a disk's bus (or the container's privilege) rules out go
 * off. Runs on the visitor's own edits only — never from an effect.
 */
export function normalizeGuest(guest: GuestPlan, ctx: GuestContext): GuestPlan {
  const nodeIndex = effectiveGuestNode(guest, ctx.nodes.length);
  const stores = storageOptions(ctx, nodeIndex);
  const disks = guest.disks.map((d) => {
    const next = { ...d, storage: stores.some((o) => o.id === d.storage) ? d.storage : stores[0].id };
    return { ...next, iothread: next.iothread && iothreadPossible(next, guest), ssd: next.ssd && ssdPossible(next) };
  });
  const withDisks = { ...guest, disks };
  const ha = guest.ha && haAvailable(withDisks, ctx);
  const bridges = bridgeOptions(ctx, nodeIndex, ha);
  const nics = guest.nics.map((n) => (bridges.includes(n.bridge) ? n : { ...n, bridge: bridges[0] ?? "" }));
  return { ...withDisks, ha, nics, keyctl: guest.keyctl && guest.unprivileged };
}

/** how many cpus a guest takes: sockets × cores for a vm */
export function guestVcpus(guest: GuestPlan): number {
  const cores = Number(guest.cores) || 0;
  return guest.kind === "vm" ? (Number(guest.sockets) || 1) * cores : cores;
}

// ── new guests ───────────────────────────────────────────────────────────

/** the lowest free vmid from 100 — proxmox's own first id */
export function nextVmid(guests: GuestPlan[], taken: string[] = []): string {
  const used = new Set([...guests.map((g) => g.vmid), ...taken]);
  let id = 100;
  while (used.has(String(id))) id++;
  return String(id);
}

/** "vm-01", "vm-02"… — the first not already taken */
export function nextGuestName(prefix: string, guests: GuestPlan[], taken: string[] = []): string {
  const used = new Set([...guests.map((g) => g.name), ...taken]);
  let n = 1;
  while (used.has(`${prefix}-${String(n).padStart(2, "0")}`)) n++;
  return `${prefix}-${String(n).padStart(2, "0")}`;
}

let idCounter = 0;
export function newId(prefix = "g"): string {
  idCounter += 1;
  return `${prefix}${Date.now().toString(36)}${idCounter.toString(36)}`;
}

/** a disk with proxmox's defaults for new ones — ssd emulation and discard on thin storage */
export function newDisk(storage: string, overrides: Partial<GuestDisk> = {}): GuestDisk {
  return {
    id: newId("d"),
    storage,
    sizeGb: "32",
    bus: "scsi",
    cache: "none",
    discard: true,
    ssd: true,
    iothread: true,
    backup: true,
    replicate: true,
    mountPath: "/",
    ...overrides,
  };
}

export function newNic(bridge: string, overrides: Partial<GuestNic> = {}): GuestNic {
  return {
    id: newId("n"),
    bridge,
    vlanTag: "",
    model: "virtio",
    firewall: true,
    macAddress: "",
    rateMbps: "",
    mtu: "",
    ipMode: "dhcp",
    ip: "",
    gateway: "",
    ...overrides,
  };
}

/** a guest with sensible defaults for its kind, on the first node */
export function newGuest(kind: GuestKind, guests: GuestPlan[], ctx: GuestContext, overrides: Partial<GuestPlan> = {}): GuestPlan {
  const nodeIndex = Number(overrides.node ?? 0);
  const storage = storageOptions(ctx, nodeIndex)[0];
  const vm = kind === "vm";
  return {
    id: newId(),
    kind,
    name: nextGuestName(vm ? "vm" : "ct", guests),
    vmid: nextVmid(guests),
    image: imagesFor(kind)[0].id,
    tags: "",
    notes: "",
    node: String(nodeIndex),
    ha: false,
    startOnBoot: true,
    startupOrder: "",
    startupDelay: "",
    shutdownTimeout: "",
    sockets: "1",
    cores: vm ? "2" : "1",
    cpuType: "",
    cpuLimit: "",
    cpuUnits: "",
    numa: false,
    memoryGb: vm ? "4" : "1",
    ballooning: true,
    minMemoryGb: vm ? "2" : "",
    swapGb: vm ? "" : "0.5",
    osType: "l26",
    machine: "q35",
    // uefi with a tpm: what current guests expect, and what secure boot
    // and measured-boot disk encryption build on
    bios: "ovmf",
    tpm: true,
    scsiController: "virtio-scsi-single",
    qemuAgent: true,
    display: "default",
    unprivileged: true,
    nesting: true,
    fuse: false,
    keyctl: false,
    useAccessKeys: true,
    ciUser: vm ? "admin" : "",
    k8sRole: "",
    disks: [newDisk(storage.id, { sizeGb: vm ? "32" : "8" })],
    nics: [newNic(bridgeOptions(ctx, nodeIndex, false)[0] ?? "")],
    ...overrides,
  };
}

// ── validation ───────────────────────────────────────────────────────────

export function validateGuestName(value: string): string | null {
  if (!value) return "required";
  return validateHostLabel(value);
}

export function validateVmid(value: string): string | null {
  return validateIntRange(value, 100, 999_999_999, { required: true });
}

export function validateSockets(value: string): string | null {
  return validateIntRange(value, 1, 4, { required: true });
}

export function validateCores(value: string): string | null {
  return validateIntRange(value, 1, 512, { required: true });
}

/** a size in gib, in quarters — "0.5" is fine, "0.3" isn't a size anyone means */
function validateQuarterGb(value: string, min: number, max: number): string | null {
  if (!/^\d+(\.\d+)?$/.test(value)) return "a number of gib, like 4 or 0.5";
  const n = Number(value);
  if (n < min || n > max) return `between ${min} and ${max} gib`;
  if (Math.round(n * 4) !== n * 4) return "in steps of 0.25 gib";
  return null;
}

export function validateMemoryGb(value: string): string | null {
  if (!value) return "required";
  return validateQuarterGb(value, 0.25, 4096);
}

/** the balloon's floor: at least 0.25 gib, never above the memory itself */
export function validateMinMemoryGb(guest: GuestPlan): string | null {
  if (guest.kind !== "vm" || !guest.ballooning) return null;
  if (!guest.minMemoryGb) return "required with ballooning";
  const base = validateQuarterGb(guest.minMemoryGb, 0.25, 4096);
  if (base) return base;
  return Number(guest.minMemoryGb) > Number(guest.memoryGb) ? "can't be more than its memory" : null;
}

export function validateSwapGb(value: string): string | null {
  if (!value) return "required — 0 for none";
  if (value === "0") return null;
  return validateQuarterGb(value, 0, 4096);
}

export function validateDiskGb(value: string): string | null {
  return validateIntRange(value, 1, 65_536, { required: true });
}

/** proxmox's tag format: letters, digits, - _ + . — separated by ; or spaces */
export function validateTags(value: string): string | null {
  const tags = value.split(/[;,\s]+/).filter(Boolean);
  const bad = tags.find((t) => !/^[a-z0-9_][a-z0-9_\-+.]*$/i.test(t));
  return bad ? `"${bad}" — tags take letters, digits and - _ + .` : null;
}

export function validateOptionalCount(value: string, max: number): string | null {
  return validateIntRange(value, 0, max);
}

/** a cpu limit: 0 (or blank) is none, otherwise up to its own cpus */
export function validateCpuLimit(guest: GuestPlan): string | null {
  if (!guest.cpuLimit) return null;
  if (!/^\d+(\.\d+)?$/.test(guest.cpuLimit)) return "a number of cpus, like 1.5";
  const n = Number(guest.cpuLimit);
  const max = guestVcpus(guest);
  return n > max ? `at most its own ${max} cpu${max === 1 ? "" : "s"}` : null;
}

/** cgroup v2 weight, proxmox's default 100 */
export function validateCpuUnits(value: string): string | null {
  return validateIntRange(value, 1, 10_000);
}

export const validateGuestVlan = validateOptionalVlanTag;

/** a unicast mac — the first octet's lowest bit is the multicast flag */
export function validateMac(value: string): string | null {
  if (!value) return null;
  if (!/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(value)) return "like bc:24:11:ab:cd:ef — or blank to have one made";
  return parseInt(value.slice(0, 2), 16) & 1 ? "that's a multicast address — the first byte must be even" : null;
}

export function validateRate(value: string): string | null {
  if (!value) return null;
  if (!/^\d+(\.\d+)?$/.test(value) || Number(value) <= 0) return "mb/s, more than 0 — or blank for no limit";
  return null;
}

export function validateMtu(value: string): string | null {
  return validateIntRange(value, 576, 65_520);
}

export function validateNicIp(nic: GuestNic): string | null {
  if (nic.ipMode !== "static") return null;
  return validateHostCidr(nic.ip);
}

/** a gateway has to sit on the interface's own network */
export function validateNicGateway(nic: GuestNic): string | null {
  if (nic.ipMode !== "static" || !nic.gateway) return null;
  if (!isValidIPv4(nic.gateway)) return "an ip address";
  const net = subnetDetails(nic.ip);
  const gw = subnetDetails(`${nic.gateway}/${net?.prefix ?? 32}`);
  return net && gw && net.network !== gw.network ? `not on ${net.network}/${net.prefix}` : null;
}

/** a container mount point: an absolute path, not the root */
export function validateMountPath(disk: GuestDisk, index: number): string | null {
  if (index === 0) return null;
  if (!disk.mountPath.startsWith("/") || disk.mountPath === "/") return "an absolute path like /data";
  return /\s/.test(disk.mountPath) ? "no spaces" : null;
}

/** a linux user name for cloud-init */
export function validateCiUser(guest: GuestPlan): string | null {
  if (!takesCloudInit(guest)) return null;
  if (!guest.ciUser) return "required — it's who you log in as";
  return /^[a-z_][a-z0-9_-]{0,31}$/.test(guest.ciUser) ? null : "lowercase letters, digits, - and _ — up to 32";
}

/** windows 11 won't install without uefi and a tpm */
export function validateOsSystem(guest: GuestPlan): string | null {
  if (guest.kind !== "vm" || guest.osType !== "win11") return null;
  if (guest.bios !== "ovmf") return "windows 11 needs uefi (ovmf)";
  return guest.tpm ? null : "windows 11 needs a tpm";
}

/** each bus holds only so many disks */
export function busProblems(guest: GuestPlan): string | null {
  if (guest.kind !== "vm") return null;
  for (const bus of BUS_OPTIONS) {
    const n = guest.disks.filter((d) => d.bus === bus.value).length;
    if (n > bus.max) return `${bus.value} holds at most ${bus.max} disks`;
  }
  return null;
}

/** the network a bridge on this node carries, as "10.0.10.0/24" — null if unknown */
export function bridgeSubnet(node: NodeInfo, bridgeName: string): string | null {
  const entry = Object.entries(node.network.bridges).find(([, b]) => b.name === bridgeName);
  if (!entry) return null;
  const [key, bridge] = entry;
  const isManagement = key === bridgeKey(node.network.managementInterfaceId, 0);
  const info = subnetDetails(isManagement ? node.network.cidr : bridge.ip);
  return info ? `${info.network}/${info.prefix}` : null;
}

// ── hints ────────────────────────────────────────────────────────────────

/** a static ip outside the bridge's network reaches nothing there */
export function nicSubnetHint(nic: GuestNic, guest: GuestPlan, ctx: GuestContext): Hint | null {
  if (nic.ipMode !== "static" || nic.vlanTag || validateHostCidr(nic.ip)) return null;
  const node = ctx.nodes[effectiveGuestNode(guest, ctx.nodes.length)];
  const subnet = node ? bridgeSubnet(node, nic.bridge) : null;
  const guestNet = subnetDetails(nic.ip);
  if (!subnet || !guestNet || `${guestNet.network}/${guestNet.prefix}` === subnet) return null;
  return {
    tone: "warning",
    glyph: "!",
    text: `${nic.ip} isn't in ${nic.bridge}'s network ${subnet} — the guest won't reach the gateway there. use an address from it, or tag the vlan it belongs to.`,
  };
}

/** more cpus than its node has: proxmox won't start it */
export function vcpuHint(guest: GuestPlan, ctx: GuestContext): Hint | null {
  const node = ctx.nodes[effectiveGuestNode(guest, ctx.nodes.length)];
  const cores = (Number(node?.cpuCount) || 0) * (Number(node?.coresPerCpu) || 0);
  const want = guestVcpus(guest);
  if (!cores || want <= cores) return null;
  return {
    tone: "warning",
    glyph: "!",
    text: `${guest.name || "this guest"} asks for ${want} cpus; its node has ${cores} cores. proxmox counts threads too, so it may still start — but it can never run faster than the node.`,
  };
}

export interface NodeLoad {
  nodeIndex: number;
  memoryGb: number;
  ramGb: number;
  cores: number;
  threads: number;
  guests: GuestPlan[];
}

/** what each node is asked to run — every guest counts on the node it's placed on */
export function nodeLoads(guests: GuestPlan[], nodes: NodeInfo[]): NodeLoad[] {
  return nodes.map((node, nodeIndex) => {
    const own = guests.filter((g) => effectiveGuestNode(g, nodes.length) === nodeIndex);
    return {
      nodeIndex,
      memoryGb: own.reduce((sum, g) => sum + (Number(g.memoryGb) || 0), 0),
      ramGb: Number(node.ramGb) || 0,
      cores: own.reduce((sum, g) => sum + guestVcpus(g), 0),
      threads: (Number(node.cpuCount) || 0) * (Number(node.coresPerCpu) || 0),
      guests: own,
    };
  });
}

/**
 * Memory is the one resource that can't be overcommitted safely: the host
 * itself needs a few gib, and ceph wants more per osd. Past the node's ram,
 * guests get killed or swapped to a crawl.
 */
export function memoryHint(load: NodeLoad, label: string): Hint | null {
  if (load.ramGb <= 0 || load.memoryGb <= 0) return null;
  if (load.memoryGb > load.ramGb) {
    return {
      tone: "danger",
      glyph: "✗",
      text: `${label}: its guests ask for ${load.memoryGb} gib of memory, but it has ${load.ramGb} gib — they won't all start. move some to another node, or give them less.`,
    };
  }
  if (load.memoryGb > load.ramGb * 0.8) {
    return {
      tone: "warning",
      glyph: "!",
      text: `${label}: its guests take ${load.memoryGb} of ${load.ramGb} gib — proxmox itself, zfs's cache and ceph need what's left, and a failover from another node has nowhere to go.`,
    };
  }
  return null;
}

/** every disk of these guests on this storage, in gb */
export function diskGbOn(guests: GuestPlan[], ctx: GuestContext, storageId: string): number {
  return guests.reduce(
    (sum, g) =>
      sum + g.disks.filter((d) => effectiveDiskStorage(d, g, ctx).id === storageId).reduce((s, d) => s + (Number(d.sizeGb) || 0), 0),
    0,
  );
}

export interface StorageUse {
  storage: string;
  usedGb: number;
  // null where the capacity isn't known up front
  capacityGb: number | null;
}

/**
 * How full each planned pool gets. Ceph is one pool for the cluster; zfs
 * and local storage are per node, so they're totalled per node and held
 * to that node's own pool.
 */
export function storageUse(guests: GuestPlan[], ctx: GuestContext): StorageUse[] {
  const active = effectiveClusterStorage(ctx.clusterStorage, ctx.nodes);
  const planNodes = withEffectiveDiskRoles(ctx.nodes, enabledStorageModes(active));
  const uses: StorageUse[] = [];

  if (active.ceph) {
    const replicas = Number(effectiveCephPlan(ctx.storage.ceph, ctx.nodes.length).replicas) || 0;
    uses.push({
      // the persistent volumes' pool shares the same osds
      storage: cephVolumeGb(guests, ctx) > 0 ? `${ctx.storage.ceph.poolName} + ${K8S_VOLUME_POOL}` : ctx.storage.ceph.poolName,
      usedGb: diskGbOn(guests, ctx, ctx.storage.ceph.poolName) + cephVolumeGb(guests, ctx),
      capacityGb: cephUsableGb(planNodes, replicas),
    });
  }
  const level = effectiveRaidLevel(ctx.storage.zfs.raidLevel, minPoolMembers(planNodes)) ?? ctx.storage.zfs.raidLevel;
  planNodes.forEach((node, i) => {
    const here = guests.filter((g) => effectiveGuestNode(g, ctx.nodes.length) === i);
    const label = node.network.hostLabel || node.name;
    if (active.zfs && disksWithRole(node, "zfs").length > 0) {
      // replication keeps every replicated guest on every node's pool
      uses.push({
        storage: `${ctx.storage.zfs.poolName} on ${label}`,
        usedGb: diskGbOn(guests, ctx, ctx.storage.zfs.poolName),
        capacityGb: zfsUsableGb(disksWithRole(node, "zfs"), level),
      });
    }
    if (disksWithRole(node, "local").length > 0) {
      const used = diskGbOn(here, ctx, ctx.storage.local.name);
      if (used > 0) uses.push({ storage: `${ctx.storage.local.name} on ${label}`, usedGb: used, capacityGb: totalGb(disksWithRole(node, "local")) });
    }
    // estimated from the installer's default carving of the boot disk
    const lvm = diskGbOn(here, ctx, "local-lvm");
    const lvmGb = bootDiskLayout(Number(node.bootDiskSizeGb) || 0, Number(node.ramGb) || 0).localLvm;
    if (lvm > 0) uses.push({ storage: `local-lvm on ${label}`, usedGb: lvm, capacityGb: lvmGb > 0 ? lvmGb : null });
  });
  return uses;
}

/** a pool its guests' disks don't fit — thin provisioning only delays it */
export function storageHint(use: StorageUse): Hint | null {
  if (use.capacityGb === null || use.usedGb <= use.capacityGb) return null;
  return {
    tone: "warning",
    glyph: "!",
    text: `${use.storage}: the disks planned on it add up to ${formatGb(use.usedGb)}, more than its ${formatGb(use.capacityGb)}. thin provisioning lets it start, but it fills up once they do.`,
  };
}

/** ha with two nodes loses quorum with either one */
export function haQuorumHint(guests: GuestPlan[], nodeCount: number): Hint | null {
  if (nodeCount !== 2 || !guests.some((g) => g.ha)) return null;
  return {
    tone: "warning",
    glyph: "!",
    text: "ha with two nodes can't tell a dead node from a cut cable — without a third vote (a qdevice) the survivor stops rather than risk running a guest twice.",
  };
}
