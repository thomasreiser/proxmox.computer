// Step 8's install guide: everything in it that's computed from the setup —
// how to recognise each node's boot disk, the commands that build its iso,
// and where it answers once installed. The copy around it is
// install-guide.tsx.
//
// Reference: https://pve.proxmox.com/wiki/Automated_Installation

import { PROXMOX_ISO_FILE, answerFileName, nodeFqdn } from "./answer-file";
import { answerBootDisk } from "./boot-disk";
import type { DiskType, NodeInfo, PersistedState } from "./wizard-state";

/** the download page, for the release notes and other architectures */
export const PROXMOX_DOWNLOADS_URL = "https://www.proxmox.com/en/downloads/proxmox-virtual-environment/iso";
export const AUTO_INSTALL_DOCS_URL = "https://pve.proxmox.com/wiki/Automated_Installation";

/** the installer iso the answer files are written for — every command below uses this name */
export const ISO_FILE = PROXMOX_ISO_FILE;
export const ISO_URL = `https://enterprise.proxmox.com/iso/${PROXMOX_ISO_FILE}`;
/** as published in https://enterprise.proxmox.com/iso/SHA256SUMS */
export const ISO_SHA256 = "4e88fe416df9b527624a175f24c9aa07c714d3332afb1ee3dbf3879573ef2c6c";

/** checks the download against ISO_SHA256: prints "OK", or fails */
export function checksumCommand(tool: "sha256sum" | "shasum"): string {
  const check = tool === "sha256sum" ? "sha256sum -c" : "shasum -a 256 -c";
  return `echo "${ISO_SHA256}  ${ISO_FILE}" | ${check}`;
}

/** the web ui's port on every proxmox node */
export const WEB_UI_PORT = 8006;

/** how a disk of this type shows up in lsblk's columns */
export function diskTypeClue(type: DiskType): string {
  switch (type) {
    case "nvme":
      return "NAME starts with nvme (nvme0n1, nvme1n1…), TRAN nvme";
    case "ssd":
      return "NAME sd… (sda, sdb…), TRAN sata or sas, ROTA 0";
    case "hdd":
      return "NAME sd… (sda, sdb…), TRAN sata or sas, ROTA 1 — it spins";
  }
}

/** a name lsblk would give a disk of this type — for the guide's examples only */
export function exampleDiskName(type: DiskType): string {
  return type === "nvme" ? "nvme0n1" : "sda";
}

/**
 * The size lsblk prints for a disk sold as `sizeGb` gb. Disks are sold in
 * decimal gigabytes, lsblk counts binary ones, so a "512 gb" disk is listed
 * as about 477G and a "2000 gb" one as 1.8T. null while no size is set.
 */
export function lsblkSize(sizeGb: string): string | null {
  const gb = Number(sizeGb);
  if (!sizeGb.trim() || !Number.isFinite(gb) || gb <= 0) return null;
  const gib = (gb * 1e9) / 2 ** 30;
  return gib >= 1024 ? `${(gib / 1024).toFixed(1)}T` : `${Math.round(gib)}G`;
}

/**
 * The node's other disks that look just like its boot disk in lsblk: same
 * type, same size. With any, type and size don't single the boot disk out,
 * and the serial (or the model) has to.
 */
export function bootDiskLookalikes(node: NodeInfo): number {
  return node.additionalDisks.filter((d) => d.type === node.bootDiskType && d.sizeGb.trim() !== "" && Number(d.sizeGb) === Number(node.bootDiskSizeGb))
    .length;
}

/** the iso prepare-iso writes for this node — named after it, like its answer file */
export function nodeIsoName(node: NodeInfo): string {
  return answerFileName(node).replace(/^answer-/, "proxmox-ve-").replace(/\.toml$/, ".iso");
}

export function validateCommand(node: NodeInfo): string {
  return `proxmox-auto-install-assistant validate-answer ${answerFileName(node)}`;
}

/**
 * Bakes the node's answer file into a copy of the iso (`--fetch-from iso`):
 * one iso per node, which boots straight into that node's install.
 */
export function prepareIsoCommand(node: NodeInfo): string {
  return `proxmox-auto-install-assistant prepare-iso ${ISO_FILE} --fetch-from iso --answer-file ${answerFileName(node)} --output ${nodeIsoName(node)}`;
}

/** the node's web ui, at the address from step 3 — null while it has none */
export function webUiUrl(node: NodeInfo): string | null {
  const ip = node.network.cidr.split("/")[0].trim();
  if (!ip) return null;
  return ip.includes(":") ? `https://[${ip}]:${WEB_UI_PORT}` : `https://${ip}:${WEB_UI_PORT}`;
}

export interface NodeInstall {
  fqdn: string;
  answerFile: string;
  iso: string;
  bootDisk: {
    type: DiskType;
    sizeGb: string;
    lsblkSize: string | null;
    clue: string;
    lookalikes: number;
    // the name its answer file carries — null while it has none (the placeholder)
    name: string | null;
  };
  validate: string;
  prepareIso: string;
  webUi: string | null;
}

/** one row of the guide per node, in the order the nodes were declared */
export function nodeInstalls(state: Pick<PersistedState, "nodes" | "hostnameSuffix" | "identicalHardware" | "install">): NodeInstall[] {
  return state.nodes.map((node, i) => ({
    fqdn: nodeFqdn(node, state.hostnameSuffix),
    answerFile: answerFileName(node),
    iso: nodeIsoName(node),
    bootDisk: {
      type: node.bootDiskType,
      sizeGb: node.bootDiskSizeGb,
      lsblkSize: lsblkSize(node.bootDiskSizeGb),
      clue: diskTypeClue(node.bootDiskType),
      lookalikes: bootDiskLookalikes(node),
      name: answerBootDisk(state, i),
    },
    validate: validateCommand(node),
    prepareIso: prepareIsoCommand(node),
    webUi: webUiUrl(node),
  }));
}
