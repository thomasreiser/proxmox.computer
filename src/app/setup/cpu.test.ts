import { describe, expect, it } from "vitest";
import {
  DEFAULT_CPU_FAMILY,
  clusterCpuBaseline,
  cpuFamilies,
  cpuTypeOptions,
  cpuVendorOptions,
  defaultCoresFor,
  effectiveCpuType,
  familiesByDate,
  hostCpuKey,
  nativeEntryFor,
  qemuTypeFor,
  stripMitigationSuffix,
} from "./cpu";

const intel = (cpuFamily: string) => ({ cpuVendor: "intel" as const, cpuFamily });
const amd = (cpuFamily: string) => ({ cpuVendor: "amd" as const, cpuFamily });

describe("a guest's cpu type", () => {
  // real chip names resolve to the qemu family the data lists hosts under
  it("keys a host by its native qemu type, without mitigation suffixes", () => {
    expect(hostCpuKey(intel("Skylake-Server"))).toBe("Skylake-Server");
    expect(hostCpuKey(intel("Alder Lake"))).toBe("Skylake-Client");
    expect(hostCpuKey(amd("Zen 3 (Ryzen 5000)"))).toBe("EPYC-Milan");
  });

  it("offers only what the host can run", () => {
    const options = cpuTypeOptions([intel("Skylake-Server")]);
    expect(options).toContain("Skylake-Server-noTSX-IBRS");
    expect(options).toContain("x86-64-v4");
    expect(options).not.toContain("Icelake-Server");
    expect(options).not.toContain("EPYC-Rome");
  });

  // alder lake dropped avx-512
  it("leaves out x86-64-v4 where the cpu lacks it", () => {
    expect(cpuTypeOptions([intel("Alder Lake")])).not.toContain("x86-64-v4");
    expect(cpuTypeOptions([intel("Alder Lake")])).toContain("x86-64-v3");
  });

  it("offers across several hosts only what all of them run", () => {
    const options = cpuTypeOptions([intel("Skylake-Server"), intel("Icelake-Server")]);
    expect(options).toContain("Skylake-Server");
    expect(options).not.toContain("Icelake-Server");
  });

  // passthrough can't move to a different cpu
  it("offers host and max only while every host is the same cpu", () => {
    expect(cpuTypeOptions([intel("Skylake-Server"), intel("Skylake-Server")])).toContain("host");
    // two names, one qemu type: still the same cpu to a guest
    expect(cpuTypeOptions([intel("Alder Lake"), intel("Raptor Lake")])).toContain("host");
    expect(cpuTypeOptions([intel("Skylake-Server"), intel("Icelake-Server")])).not.toContain("host");
    expect(cpuTypeOptions([intel("Skylake-Server"), intel("Icelake-Server")])).not.toContain("max");
  });

  it("orders generic types first, then the hosts' own vendor by launch, the other vendor after", () => {
    const options = cpuTypeOptions([amd("EPYC-Rome")]);
    expect(options.slice(0, 2)).toEqual(["x86-64-v2-AES", "x86-64-v2"]);
    expect(options.indexOf("EPYC")).toBeLessThan(options.indexOf("EPYC-Rome"));
    expect(options.indexOf("EPYC-Rome")).toBeLessThan(options.indexOf("Conroe"));
    expect(options.at(-1)).toBe("max");
  });

  it("shares only generic and old cross-vendor models between intel and amd", () => {
    const options = cpuTypeOptions([intel("Skylake-Server"), amd("EPYC-Rome")]);
    expect(options).toContain("x86-64-v2-AES");
    expect(options.some((t) => t.startsWith("Skylake") || t.startsWith("EPYC"))).toBe(false);
  });

  it("offers the generic types when there's no host to judge", () => {
    expect(cpuTypeOptions([])[0]).toBe("x86-64-v2-AES");
  });

  // what cpuHintFor recommends: the oldest cpu, so every node runs it
  it("takes the oldest node's cpu as the cluster's baseline", () => {
    expect(clusterCpuBaseline([intel("Icelake-Server"), intel("Skylake-Server")])).toBe("Skylake-Server-noTSX-IBRS");
    expect(clusterCpuBaseline([amd("Zen 4 (Ryzen 7000)"), amd("EPYC-Rome")])).toBe("EPYC-Rome");
  });

  it("falls back to proxmox's generic default across vendors", () => {
    expect(clusterCpuBaseline([intel("Skylake-Server"), amd("EPYC-Rome")])).toBe("x86-64-v2-AES");
    expect(clusterCpuBaseline([])).toBe("x86-64-v2-AES");
  });

  it("keeps a choice while it's possible, else the baseline, else the widest", () => {
    expect(effectiveCpuType("host", ["x86-64-v2-AES", "host"], "x86-64-v2-AES")).toBe("host");
    expect(effectiveCpuType("host", ["x86-64-v2-AES"], "x86-64-v2-AES")).toBe("x86-64-v2-AES");
    expect(effectiveCpuType("", ["kvm64", "Haswell"], "Haswell")).toBe("Haswell");
    expect(effectiveCpuType("", ["kvm64"], "Haswell")).toBe("kvm64");
  });
});

describe("the catalog itself", () => {
  it("offers both vendors", () => {
    expect(cpuVendorOptions.map((v) => v.value).sort()).toEqual(["amd", "intel"]);
  });

  it("has a default family that exists in each vendor's list", () => {
    for (const vendor of ["intel", "amd"] as const) {
      const names = cpuFamilies.architectures[vendor].map((f) => f.name);
      expect(names).toContain(DEFAULT_CPU_FAMILY[vendor]);
    }
  });

  it("orders families oldest first, which is what the migration hint relies on", () => {
    for (const vendor of ["intel", "amd"] as const) {
      const years = familiesByDate(vendor).map((f) => f.from);
      expect(years).toEqual([...years].sort((a, b) => a - b));
    }
  });
});

describe("qemuTypeFor", () => {
  it("resolves every cataloged family to a non-empty type", () => {
    for (const vendor of ["intel", "amd"] as const) {
      for (const family of cpuFamilies.architectures[vendor]) {
        expect(qemuTypeFor(vendor, family.name)).toBeTruthy();
      }
    }
  });

  // an unknown name has to resolve to something rather than undefined —
  // a saved state can name a family a later build dropped.
  it("falls back for a family it doesn't know", () => {
    expect(qemuTypeFor("intel", "TotallyMadeUpLake")).toBeTruthy();
  });
});

describe("stripMitigationSuffix", () => {
  // "-IBRS"/"-IBPB" variants are the same silicon with microcode
  // mitigations — they must fold together or every cluster would look
  // mixed-generation.
  it("folds a mitigation variant back to its base type", () => {
    expect(stripMitigationSuffix("Skylake-Client-IBRS")).toBe("Skylake-Client");
    expect(stripMitigationSuffix("EPYC-IBPB")).toBe("EPYC");
  });

  it("leaves a plain type alone", () => {
    expect(stripMitigationSuffix("Nehalem")).toBe("Nehalem");
  });
});

describe("nativeEntryFor", () => {
  it("finds the family a resolved qemu type came from", () => {
    const type = qemuTypeFor("intel", DEFAULT_CPU_FAMILY.intel);
    expect(nativeEntryFor("intel", type)).toBeDefined();
  });

  it("returns undefined for a type that isn't in the catalog", () => {
    expect(nativeEntryFor("intel", "NotAType")).toBeUndefined();
  });
});

describe("defaultCoresFor", () => {
  it("suggests a positive core count for every cataloged family", () => {
    for (const vendor of ["intel", "amd"] as const) {
      for (const family of cpuFamilies.architectures[vendor]) {
        expect(defaultCoresFor(vendor, family.name)).toBeGreaterThan(0);
      }
    }
  });
});
