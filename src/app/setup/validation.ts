// Field-level validation for the wizard's inputs, and the ipv4/cidr
// arithmetic the rest of the setup step builds on. Every function here is
// pure and returns either null (valid) or the message to show — kept out
// of ./page.tsx so the rules can be tested directly rather than only
// through the form that renders them.

export function isValidIPv4(ip: string): boolean {
  const parts = ip.split(".");
  if (parts.length !== 4) return false;
  return parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) >= 0 && Number(p) <= 255);
}

export function parseIpv4(ip: string): number[] | null {
  if (!isValidIPv4(ip)) return null;
  return ip.split(".").map(Number);
}

export function validateCidr(value: string): string | null {
  if (!value) return null;
  const [ip, prefix] = value.split("/");
  if (!ip || !prefix || !isValidIPv4(ip) || !/^\d{1,2}$/.test(prefix) || Number(prefix) > 32) {
    return "not a valid cidr — try 10.0.10.11/24";
  }
  return null;
}

export interface SubnetInfo {
  network: string;
  netmask: string;
  prefix: number;
  broadcast: string;
  firstHost: string;
  lastHost: string;
  usableHosts: number;
}

export function subnetDetails(cidr: string): SubnetInfo | null {
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

export function validateIp(value: string): string | null {
  if (!value) return null;
  if (!isValidIPv4(value)) return "not a valid ip — try 10.0.10.1";
  return null;
}

// For purposes that need a real host address (ceph, backups, cluster
// sync, or "other" answered yes) — required, and catches the common
// mistake of typing the network's own address instead of a host on it.
export function validateHostCidr(value: string): string | null {
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

/**
 * What a valid static ip means, spelled out under the field: the prefix is
 * the size of the node's network, not a network of its own. A /32 leaves
 * the node alone on its link — no route to its gateway or its peers — so
 * it's flagged. Null for anything validateHostCidr would reject.
 */
export function hostCidrMeaning(value: string): { text: string; warn: boolean } | null {
  if (!value || validateHostCidr(value)) return null;
  const info = subnetDetails(value);
  if (!info) return null;
  const [ip] = value.split("/");
  if (info.prefix === 32) {
    return {
      text: "/32 puts this node alone on its network — it can't reach the gateway or the other nodes. use the network's prefix, e.g. /24",
      warn: true,
    };
  }
  return { text: `${ip} is this node's address in the ${info.network}/${info.prefix} network`, warn: false };
}

// for a bridge that's a pure vm/ct switch — the host itself never gets an
// address here, but the visitor should still commit to a subnet up front
// so vm/ct addressing has something to follow later. unlike
// validateHostCidr, the network's own address (10.0.20.0/24) IS the
// correct value here, not a mistake to flag.
export function validateNetwork(value: string): string | null {
  if (!value) return "pick the subnet this bridge's vms/cts should use";
  return validateCidr(value);
}

export function validateHostnameSuffix(value: string): string | null {
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
export function validateHostLabel(value: string): string | null {
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
export function validateInterfaceName(value: string): string | null {
  if (!value) return "can't be empty";
  if (value.length > 15) return "15 characters max (linux interface name limit)";
  if (!/^[a-zA-Z0-9_-]+$/.test(value)) return "letters, numbers, hyphens and underscores only";
  return null;
}

// nic/disk friendly names aren't passed to a literal syscall, but they're
// meant to double as proxmox-style identifiers in later steps — the same
// safe charset avoids a name that's fine here but breaks once it's
// actually used as one.
export function validateFriendlyName(value: string): string | null {
  if (!value) return "can't be empty";
  if (value.length > 32) return "32 characters max";
  if (!/^[a-zA-Z0-9_-]+$/.test(value)) return "letters, numbers, hyphens and underscores only";
  return null;
}

// checked against the other names in the SAME namespace only (see
// NodeNames) — a disk and a nic can happily share a name. a straight
// count across that list, rather than tracking each field's own identity,
// flags every field holding the colliding value symmetrically.
export function validateUniqueName(value: string, sameKindNames: string[]): string | null {
  if (!value) return null;
  return sameKindNames.filter((n) => n === value).length > 1
    ? "used more than once on this node — names must be unique"
    : null;
}

export function validateIntRange(value: string, min: number, max: number, opts?: { required?: boolean }): string | null {
  if (!value) return opts?.required ? `${min}-${max}` : null;
  if (!/^-?\d+$/.test(value)) return "whole numbers only";
  const n = Number(value);
  if (n < min || n > max) return `must be between ${min} and ${max}`;
  return null;
}

// only called for a bridge that isn't index 0 of its interface — those
// share a physical nic/bond with a sibling bridge, which linux only
// allows when each one is tagged with its own vlan.
export function validateVlanTag(value: string, siblingTags: string[]): string | null {
  if (!value) return "every extra bridge on the same nic/bond needs its own vlan tag";
  if (!/^\d+$/.test(value)) return "whole numbers only";
  const n = Number(value);
  if (n < 1 || n > 4094) return "must be between 1 and 4094";
  if (siblingTags.includes(value)) return "already used by another bridge on this interface — each needs a unique vlan";
  return null;
}

// unlike a bridge's own vlan tag, the homelab's main vlan is purely
// informational — most flat single-vlan homelabs don't number their
// "main" network at all, so empty is a perfectly normal answer, not an
// error to fix.
export function validateOptionalVlanTag(value: string): string | null {
  if (!value) return null;
  if (!/^\d+$/.test(value)) return "whole numbers only";
  const n = Number(value);
  if (n < 1 || n > 4094) return "must be between 1 and 4094";
  return null;
}

/**
 * Makes an otherwise-optional validator required: blank is "required",
 * anything else is up to `validate`. Several validators here treat blank
 * as "not answered yet" (validateCidr, validateIp, validateHostLabel) —
 * right while typing, wrong for a field the next step can't do without.
 */
export function required(value: string, validate: (value: string) => string | null): string | null {
  if (!value.trim()) return "required";
  return validate(value);
}
