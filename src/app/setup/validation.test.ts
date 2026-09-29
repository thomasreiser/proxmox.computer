import { describe, expect, it } from "vitest";
import {
  isValidIPv4,
  parseIpv4,
  subnetDetails,
  validateCidr,
  validateFriendlyName,
  validateHostCidr,
  hostCidrMeaning,
  validateHostLabel,
  validateHostnameSuffix,
  validateIntRange,
  validateInterfaceName,
  validateIp,
  validateNetwork,
  validateOptionalVlanTag,
  validateUniqueName,
  validateVlanTag,
} from "./validation";

describe("isValidIPv4", () => {
  it.each(["0.0.0.0", "10.0.0.1", "255.255.255.255", "192.168.1.100"])("accepts %s", (ip) => {
    expect(isValidIPv4(ip)).toBe(true);
  });

  it.each([
    ["256.0.0.1", "octet over 255"],
    ["10.0.0", "only three octets"],
    ["10.0.0.1.5", "five octets"],
    ["10.0.0.-1", "negative octet"],
    ["10.0.0.a", "non-numeric octet"],
    ["10.0.0.1 ", "trailing space"],
    ["", "empty"],
  ])("rejects %s (%s)", (ip) => {
    expect(isValidIPv4(ip)).toBe(false);
  });

  // 1-3 digits only, so a zero-padded octet that some parsers read as
  // octal is accepted here as its plain decimal value — worth pinning so
  // a future regex change doesn't silently alter what "010" means.
  it("accepts zero-padded octets as decimal", () => {
    expect(isValidIPv4("010.0.0.1")).toBe(true);
    expect(parseIpv4("010.0.0.1")).toEqual([10, 0, 0, 1]);
  });

  it("returns null from parseIpv4 for anything it rejects", () => {
    expect(parseIpv4("nope")).toBeNull();
  });
});

describe("subnetDetails", () => {
  it("derives a /24 correctly", () => {
    expect(subnetDetails("10.0.20.37/24")).toEqual({
      network: "10.0.20.0",
      netmask: "255.255.255.0",
      prefix: 24,
      broadcast: "10.0.20.255",
      firstHost: "10.0.20.1",
      lastHost: "10.0.20.254",
      usableHosts: 254,
    });
  });

  it("derives a non-byte-aligned prefix", () => {
    expect(subnetDetails("192.168.1.130/26")).toMatchObject({
      network: "192.168.1.128",
      netmask: "255.255.255.192",
      broadcast: "192.168.1.191",
      firstHost: "192.168.1.129",
      lastHost: "192.168.1.190",
      usableHosts: 62,
    });
  });

  // RFC 3021: on a /31 both addresses are usable, and neither is set
  // aside as network or broadcast.
  it("treats a /31 as a two-host point-to-point link", () => {
    expect(subnetDetails("10.0.0.4/31")).toMatchObject({
      network: "10.0.0.4",
      firstHost: "10.0.0.4",
      lastHost: "10.0.0.5",
      usableHosts: 2,
    });
  });

  it("treats a /32 as a single host", () => {
    expect(subnetDetails("10.0.0.7/32")).toMatchObject({
      firstHost: "10.0.0.7",
      lastHost: "10.0.0.7",
      usableHosts: 1,
    });
  });

  // the high bit makes the naive (ip & mask) signed in js — this is the
  // case that catches a missing >>> 0.
  it("handles addresses above 127.x without sign overflow", () => {
    expect(subnetDetails("192.168.1.1/24")?.network).toBe("192.168.1.0");
    expect(subnetDetails("255.255.255.255/32")?.network).toBe("255.255.255.255");
  });

  it("handles a /0", () => {
    expect(subnetDetails("10.0.0.1/0")).toMatchObject({
      network: "0.0.0.0",
      netmask: "0.0.0.0",
      broadcast: "255.255.255.255",
    });
  });

  it.each(["not-an-ip/24", "10.0.0.1/33", "10.0.0.1", "10.0.0.1/"])("returns null for %s", (cidr) => {
    expect(subnetDetails(cidr)).toBeNull();
  });
});

describe("validateCidr", () => {
  it("treats empty as not-yet-answered rather than invalid", () => {
    expect(validateCidr("")).toBeNull();
  });

  it("accepts a well-formed cidr", () => {
    expect(validateCidr("10.0.0.1/24")).toBeNull();
  });

  it.each(["10.0.0.1", "10.0.0.1/33", "10.0.0.1/abc", "300.0.0.1/24"])("rejects %s", (value) => {
    expect(validateCidr(value)).toMatch(/not a valid cidr/);
  });
});

describe("validateHostCidr", () => {
  it("requires a value", () => {
    expect(validateHostCidr("")).toBe("enter this node's address here");
  });

  it("accepts a real host address", () => {
    expect(validateHostCidr("10.0.20.11/24")).toBeNull();
  });

  // the two mistakes worth catching: typing the subnet you were given
  // instead of an address on it, or grabbing the last address in it.
  it("rejects the network address and names a usable one", () => {
    expect(validateHostCidr("10.0.20.0/24")).toBe("that's the network address, not a host — try 10.0.20.1/24");
  });

  it("rejects the broadcast address and names a usable one", () => {
    expect(validateHostCidr("10.0.20.255/24")).toBe("that's the broadcast address, not a host — try 10.0.20.254/24");
  });

  it("allows both addresses of a /31, which has neither", () => {
    expect(validateHostCidr("10.0.0.4/31")).toBeNull();
    expect(validateHostCidr("10.0.0.5/31")).toBeNull();
  });

  it("allows a /32", () => {
    expect(validateHostCidr("10.0.0.7/32")).toBeNull();
  });

  it("falls through to the cidr message for malformed input", () => {
    expect(validateHostCidr("garbage")).toMatch(/not a valid cidr/);
  });
});

describe("validateNetwork", () => {
  // the inverse of validateHostCidr: here the network's own address is
  // exactly what's wanted, since no host claims an address on this bridge.
  it("accepts the network address", () => {
    expect(validateNetwork("10.0.20.0/24")).toBeNull();
  });

  it("requires a value", () => {
    expect(validateNetwork("")).toBe("pick the subnet this bridge's vms/cts should use");
  });
});

describe("validateIp", () => {
  it("allows empty", () => {
    expect(validateIp("")).toBeNull();
  });

  it("accepts a bare ip and rejects a cidr", () => {
    expect(validateIp("10.0.0.1")).toBeNull();
    expect(validateIp("10.0.0.1/24")).toMatch(/not a valid ip/);
  });
});

describe("validateHostnameSuffix", () => {
  it("allows empty — the domain is optional", () => {
    expect(validateHostnameSuffix("")).toBeNull();
  });

  it.each(["homelab.lan", "lab.example.com", "a", "x-y.z"])("accepts %s", (v) => {
    expect(validateHostnameSuffix(v)).toBeNull();
  });

  it.each(["-lab.lan", "lab-.lan", "lab..lan", "lab .lan"])("rejects %s", (v) => {
    expect(validateHostnameSuffix(v)).toMatch(/not a valid domain/);
  });
});

describe("validateHostLabel", () => {
  it("allows empty", () => {
    expect(validateHostLabel("")).toBeNull();
  });

  it("accepts a plain label", () => {
    expect(validateHostLabel("pve01")).toBeNull();
    expect(validateHostLabel("pve-01")).toBeNull();
  });

  // proxmox's cluster tooling wants lowercase, so this is rejected rather
  // than quietly folded.
  it("rejects uppercase before anything else", () => {
    expect(validateHostLabel("PVE01")).toBe("lowercase only");
  });

  it("rejects a leading or trailing hyphen", () => {
    expect(validateHostLabel("-pve")).toMatch(/can't start or end with a hyphen/);
    expect(validateHostLabel("pve-")).toMatch(/can't start or end with a hyphen/);
  });

  it("caps at 63 characters (RFC 1123)", () => {
    expect(validateHostLabel("a".repeat(63))).toBeNull();
    expect(validateHostLabel("a".repeat(64))).toBe("63 characters max");
  });

  it("rejects a dotted fqdn — this is one label, not a domain", () => {
    expect(validateHostLabel("pve01.lab.lan")).toMatch(/letters, numbers and hyphens only/);
  });
});

describe("validateInterfaceName", () => {
  it("requires a value", () => {
    expect(validateInterfaceName("")).toBe("can't be empty");
  });

  // IFNAMSIZ leaves 15 usable characters; a 16th is silently truncated by
  // the kernel, which is worse than refusing it here.
  it("caps at the 15-character linux limit", () => {
    expect(validateInterfaceName("a".repeat(15))).toBeNull();
    expect(validateInterfaceName("a".repeat(16))).toBe("15 characters max (linux interface name limit)");
  });

  it("accepts the charset linux and udev both tolerate", () => {
    expect(validateInterfaceName("vmbr0")).toBeNull();
    expect(validateInterfaceName("ceph_bond-1")).toBeNull();
  });

  it.each(["vmbr 0", "vmbr/0", "vmbr.0", "vmbr@0"])("rejects %s", (v) => {
    expect(validateInterfaceName(v)).toBe("letters, numbers, hyphens and underscores only");
  });
});

describe("validateFriendlyName", () => {
  it("requires a value and caps at 32", () => {
    expect(validateFriendlyName("")).toBe("can't be empty");
    expect(validateFriendlyName("a".repeat(32))).toBeNull();
    expect(validateFriendlyName("a".repeat(33))).toBe("32 characters max");
  });
});

describe("validateUniqueName", () => {
  // the list includes the field's own value, so "appears once" is unique.
  it("accepts a name that appears once in its namespace", () => {
    expect(validateUniqueName("boot", ["boot", "storage-1"])).toBeNull();
  });

  it("flags a name that appears twice", () => {
    expect(validateUniqueName("boot", ["boot", "boot"])).toMatch(/used more than once/);
  });

  it("ignores an empty value", () => {
    expect(validateUniqueName("", ["", ""])).toBeNull();
  });
});

describe("validateIntRange", () => {
  it("allows empty unless required", () => {
    expect(validateIntRange("", 1, 8)).toBeNull();
    expect(validateIntRange("", 1, 8, { required: true })).toBe("1-8");
  });

  it("accepts the inclusive bounds", () => {
    expect(validateIntRange("1", 1, 8)).toBeNull();
    expect(validateIntRange("8", 1, 8)).toBeNull();
  });

  it("rejects out of range and non-integers", () => {
    expect(validateIntRange("9", 1, 8)).toBe("must be between 1 and 8");
    expect(validateIntRange("1.5", 1, 8)).toBe("whole numbers only");
    expect(validateIntRange("-3", 1, 8)).toBe("must be between 1 and 8");
  });
});

describe("validateVlanTag", () => {
  // an extra bridge shares a nic with a sibling, which linux only allows
  // when each is tagged — so blank is an error here, unlike the optional
  // cluster-wide vlan.
  it("requires a tag", () => {
    expect(validateVlanTag("", [])).toBe("every extra bridge on the same nic/bond needs its own vlan tag");
  });

  it("accepts the 802.1q range", () => {
    expect(validateVlanTag("1", [])).toBeNull();
    expect(validateVlanTag("4094", [])).toBeNull();
  });

  it("rejects 0 and 4095, which 802.1q reserves", () => {
    expect(validateVlanTag("0", [])).toBe("must be between 1 and 4094");
    expect(validateVlanTag("4095", [])).toBe("must be between 1 and 4094");
  });

  it("rejects a tag already used by a sibling on the same interface", () => {
    expect(validateVlanTag("20", ["20"])).toMatch(/already used by another bridge/);
    expect(validateVlanTag("20", ["30"])).toBeNull();
  });
});

describe("validateOptionalVlanTag", () => {
  it("allows empty — most flat homelabs never number their main vlan", () => {
    expect(validateOptionalVlanTag("")).toBeNull();
  });

  it("still range-checks a value that is given", () => {
    expect(validateOptionalVlanTag("4094")).toBeNull();
    expect(validateOptionalVlanTag("4095")).toBe("must be between 1 and 4094");
    expect(validateOptionalVlanTag("x")).toBe("whole numbers only");
  });
});

describe("hostCidrMeaning", () => {
  it("reads the prefix as the size of the node's network", () => {
    expect(hostCidrMeaning("10.0.10.11/24")).toEqual({
      text: "10.0.10.11 is this node's address in the 10.0.10.0/24 network",
      warn: false,
    });
    expect(hostCidrMeaning("172.16.4.9/16")?.text).toContain("172.16.0.0/16");
  });

  // a /32 leaves the node alone on its link, with no route anywhere
  it("flags a /32", () => {
    expect(hostCidrMeaning("10.0.10.11/32")).toEqual({ text: expect.stringMatching(/alone on its network/), warn: true });
  });

  // /31 is a real two-host point-to-point link — nothing to flag
  it("leaves a /31 alone", () => {
    expect(hostCidrMeaning("10.0.10.10/31")?.warn).toBe(false);
  });

  it("says nothing about a value that isn't a valid host address", () => {
    expect(hostCidrMeaning("")).toBeNull();
    expect(hostCidrMeaning("10.0.10.0/24")).toBeNull();
    expect(hostCidrMeaning("nonsense")).toBeNull();
  });
});
