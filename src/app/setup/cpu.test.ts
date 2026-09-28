import { describe, expect, it } from "vitest";
import {
  DEFAULT_CPU_FAMILY,
  cpuFamilies,
  cpuVendorOptions,
  defaultCoresFor,
  familiesByDate,
  nativeEntryFor,
  qemuTypeFor,
  stripMitigationSuffix,
} from "./cpu";

describe("the catalogue itself", () => {
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
  it("resolves every catalogued family to a non-empty type", () => {
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

  it("returns undefined for a type that isn't in the catalogue", () => {
    expect(nativeEntryFor("intel", "NotAType")).toBeUndefined();
  });
});

describe("defaultCoresFor", () => {
  it("suggests a positive core count for every catalogued family", () => {
    for (const vendor of ["intel", "amd"] as const) {
      for (const family of cpuFamilies.architectures[vendor]) {
        expect(defaultCoresFor(vendor, family.name)).toBeGreaterThan(0);
      }
    }
  });
});
