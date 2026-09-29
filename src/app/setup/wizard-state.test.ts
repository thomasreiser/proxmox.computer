import { describe, expect, it, vi } from "vitest";
import {
  MAX_BRIDGES_PER_INTERFACE,
  STORAGE_VERSION,
  NIC_PORT_LABEL,
  STORAGE_KEY,
  bridgeCountFor,
  bridgeKey,
  bondModeLabel,
  effectivePort,
  interfacesFor,
  isFastNic,
  interfaceNameFor,
  isPersistedState,
  isStorageLink,
  isStoragePurpose,
  linkSpeedLabel,
  isSlowNic,
  loadPersistedState,
  needsHostIpForPurposes,
  nicIndicesForInterface,
  nicSpeedLabel,
  nicSpeedsForInterface,
  persistCurrentStep,
  replacePersistedState,
  portChoices,
  portHint,
  validBonds,
  type PersistedState,
} from "./wizard-state";
import { bond, bridge, cluster, nics } from "./test-fixtures";
import { defaultBackupPlan } from "./backups";
import { defaultStoragePlan } from "./derive";

function persisted(overrides: Partial<PersistedState> = {}): PersistedState {
  return {
    version: STORAGE_VERSION,
    currentStep: "network",
    nodeCount: "3",
    hostnameSuffix: "lab.lan",
    globalCidr: "10.0.0.0/24",
    gateway: "10.0.0.1",
    dns: "10.0.0.1",
    homelabVlan: "",
    nodes: cluster(3),
    identicalHardware: true,
    identicalNetwork: false,
    clusterStorage: { ceph: true, zfs: false },
    storage: defaultStoragePlan(),
    backups: defaultBackupPlan(),
    identicalStorage: false,
    ...overrides,
  };
}

describe("nic speed classification", () => {
  it("treats 10gbe and above as fast enough for ceph", () => {
    expect(isFastNic("10gbe")).toBe(true);
    expect(isFastNic("25gbe")).toBe(true);
  });

  it("treats everything below 10gbe as slow", () => {
    expect(isSlowNic("1gbe")).toBe(true);
    expect(isSlowNic("2.5gbe")).toBe(true);
  });

  // "other" deliberately answers false to both: an unknown nic can't earn
  // a warning, and can't clear one either.
  it("treats an unknown speed as neither", () => {
    expect(isFastNic("other")).toBe(false);
    expect(isSlowNic("other")).toBe(false);
  });

  it("labels every speed it knows", () => {
    expect(nicSpeedLabel("2.5gbe")).toBe("2.5 gbe");
    expect(nicSpeedLabel("25gbe")).toBe("25 gbe+");
  });
});

describe("nic connectors", () => {
  it.each([
    ["1gbe", ["rj45", "sfp"]],
    ["2.5gbe", ["rj45"]],
    ["10gbe", ["sfp+", "rj45"]],
    ["25gbe", ["sfp28", "qsfp28"]],
    ["other", []],
  ] as const)("offers the connectors a %s nic comes with", (speed, expected) => {
    expect(portChoices(speed)).toEqual(expected);
  });

  it("defaults to the usual connector for the speed", () => {
    expect(effectivePort({ speed: "10gbe", port: "" })).toBe("sfp+");
    expect(effectivePort({ speed: "1gbe", port: "" })).toBe("rj45");
  });

  it("keeps a choice that fits the speed", () => {
    expect(effectivePort({ speed: "10gbe", port: "rj45" })).toBe("rj45");
  });

  // a choice made at one speed doesn't carry into a speed it can't be
  it("falls back when the speed changes under a choice that no longer fits", () => {
    expect(effectivePort({ speed: "10gbe", port: "sfp" })).toBe("sfp+");
    expect(effectivePort({ speed: "2.5gbe", port: "sfp+" })).toBe("rj45");
  });

  it("knows nothing about an unknown speed", () => {
    expect(effectivePort({ speed: "other", port: "sfp+" })).toBeNull();
  });

  it("explains every connector it offers", () => {
    for (const speed of ["1gbe", "2.5gbe", "10gbe", "25gbe"] as const) {
      for (const port of portChoices(speed)) {
        expect(portHint(speed, port).length).toBeGreaterThan(10);
        expect(NIC_PORT_LABEL[port]).toBeTruthy();
      }
    }
  });

  it("tells 10g copper and 10g sfp+ apart", () => {
    expect(portHint("10gbe", "rj45")).toMatch(/10gbase-t/);
    expect(portHint("10gbe", "sfp+")).toMatch(/dac/);
  });
});

describe("interfacesFor", () => {
  it("lists each nic when nothing is bonded", () => {
    expect(interfacesFor(nics("1gbe", "1gbe"), []).map((i) => i.id)).toEqual(["nic-0", "nic-1"]);
  });

  // a bonded nic stops being selectable on its own — it's part of the
  // bond now, and offering both would let you bridge the same wire twice.
  it("hides nics claimed by a valid bond and offers the bond instead", () => {
    const refs = interfacesFor(nics("1gbe", "1gbe", "10gbe"), [bond({ nicIndices: [0, 1] })]);
    expect(refs.map((i) => i.id)).toEqual(["nic-2", "bond-0"]);
  });

  // one nic isn't a bond yet — it's a bond mid-assembly, so its member
  // must stay selectable or the nic would vanish entirely.
  it("ignores a bond with fewer than 2 members", () => {
    const refs = interfacesFor(nics("1gbe", "1gbe"), [bond({ nicIndices: [0] })]);
    expect(refs.map((i) => i.id)).toEqual(["nic-0", "nic-1"]);
  });

  it("labels a bond with its members and mode", () => {
    const [ref] = interfacesFor(nics("1gbe", "1gbe"), [bond({ name: "bond0", mode: "lacp" })]);
    expect(ref.label).toContain("bond0");
    expect(ref.label).toContain("lacp (802.3ad)");
  });

  it("labels a plain nic with its name and speed", () => {
    expect(interfacesFor(nics("10gbe"), [])[0].label).toBe("nic 1 — nic-1 — 10 gbe");
  });
});

describe("validBonds", () => {
  it("keeps only bonds with 2+ members", () => {
    expect(validBonds([bond({ nicIndices: [0, 1] }), bond({ nicIndices: [2] })])).toHaveLength(1);
  });
});

describe("nicIndicesForInterface / nicSpeedsForInterface", () => {
  it("resolves a plain nic id to its own index", () => {
    expect(nicIndicesForInterface("nic-3", [])).toEqual([3]);
  });

  it("resolves a bond id to its members", () => {
    expect(nicIndicesForInterface("bond-0", [bond({ nicIndices: [2, 3] })])).toEqual([2, 3]);
  });

  // a bond can be deleted while a bridge still references it, between an
  // edit and its resync — that has to be empty, not a crash.
  it("returns nothing for a bond that no longer exists", () => {
    expect(nicIndicesForInterface("bond-9", [])).toEqual([]);
  });

  it("maps to speeds in member order", () => {
    const speeds = nicSpeedsForInterface("bond-0", nics("1gbe", "10gbe", "25gbe"), [bond({ nicIndices: [2, 1] })]);
    expect(speeds).toEqual(["25gbe", "10gbe"]);
  });

  it("drops indices past the end of the nic list", () => {
    expect(nicSpeedsForInterface("nic-5", nics("1gbe"), [])).toEqual([]);
  });
});

describe("needsHostIpForPurposes", () => {
  it("says no for a pure vm/ct switch", () => {
    expect(needsHostIpForPurposes(["vm"], false)).toBe(false);
  });

  it.each(["ceph", "zfs", "backup", "cluster"] as const)("says yes for %s", (purpose) => {
    expect(needsHostIpForPurposes([purpose], false)).toBe(true);
  });

  // "other" is the one ambiguous purpose, so the visitor answers it and
  // that answer is what decides.
  it("defers to the visitor's answer for 'other'", () => {
    expect(needsHostIpForPurposes(["other"], true)).toBe(true);
    expect(needsHostIpForPurposes(["other"], false)).toBe(false);
  });

  // one purpose needing an address is enough for the whole bridge.
  it("says yes if any purpose needs one", () => {
    expect(needsHostIpForPurposes(["vm", "cluster"], false)).toBe(true);
  });
});

describe("bridgeKey / bridgeCountFor", () => {
  it("builds a stable composite key", () => {
    expect(bridgeKey("bond-0", 2)).toBe("bond-0#2");
  });

  it("defaults to a single bridge per interface", () => {
    expect(bridgeCountFor({}, "nic-0")).toBe(1);
  });

  it("reads a stored count", () => {
    expect(bridgeCountFor({ "nic-0": "4" }, "nic-0")).toBe(4);
  });

  // a corrupt or out-of-range stored value falls back rather than
  // rendering a negative or absurd number of bridge cards.
  it.each(["0", "-1", "abc", "", String(MAX_BRIDGES_PER_INTERFACE + 1)])("falls back to 1 for %s", (raw) => {
    expect(bridgeCountFor({ "nic-0": raw }, "nic-0")).toBe(1);
  });

  it("accepts the documented maximum", () => {
    expect(bridgeCountFor({ "nic-0": String(MAX_BRIDGES_PER_INTERFACE) }, "nic-0")).toBe(MAX_BRIDGES_PER_INTERFACE);
  });
});

describe("bondModeLabel", () => {
  it("expands a known mode and passes through an unknown one", () => {
    expect(bondModeLabel("lacp")).toBe("lacp (802.3ad)");
    // @ts-expect-error — guarding the fallback against a mode from an
    // older save that this build no longer knows about
    expect(bondModeLabel("balance-xor")).toBe("balance-xor");
  });
});

describe("isPersistedState", () => {
  it("accepts a state this build wrote", () => {
    expect(isPersistedState(persisted())).toBe(true);
  });

  // the version check is the real defense: a shape change from an older
  // build is discarded wholesale rather than half-applied.
  it("rejects a state from another version", () => {
    expect(isPersistedState({ ...persisted(), version: STORAGE_VERSION - 1 })).toBe(false);
  });

  it.each([null, undefined, 42, "state", []])("rejects non-object %s", (value) => {
    expect(isPersistedState(value)).toBe(false);
  });

  it("accepts every step this build can reopen on", () => {
    for (const step of ["hardware", "network", "storage", "backups"] as const) {
      expect(isPersistedState(persisted({ currentStep: step }))).toBe(true);
    }
  });

  it.each([
    ["currentStep", "install"],
    ["dns", undefined],
    ["dns", 53],
    ["backups", null],
    ["backups", { ...defaultBackupPlan(), target: "s3" }],
    ["backups", { ...defaultBackupPlan(), keepDaily: 7 }],
    ["backups", { ...defaultBackupPlan(), offsite: "no" }],
    ["nodeCount", 3],
    ["globalCidr", null],
    ["identicalNetwork", "yes"],
    ["clusterStorage", "ceph"],
    ["clusterStorage", { ceph: "yes", zfs: false }],
    ["nodes", {}],
    ["identicalStorage", "yes"],
    ["storage", null],
  ])("rejects a bad %s", (key, value) => {
    expect(isPersistedState({ ...persisted(), [key]: value })).toBe(false);
  });

  it("rejects a storage plan missing one of its sections", () => {
    const state = persisted();
    // @ts-expect-error — deliberately corrupting a saved plan
    delete state.storage.ceph;
    expect(isPersistedState(state)).toBe(false);
  });

  it("rejects a node missing its network", () => {
    const state = persisted();
    // @ts-expect-error — deliberately corrupting a saved node
    delete state.nodes[0].network;
    expect(isPersistedState(state)).toBe(false);
  });

  // a save from before connectors existed has nics without a port
  it("rejects a nic without a connector field", () => {
    const state = persisted();
    // @ts-expect-error — deliberately corrupting a saved nic
    delete state.nodes[0].nics[0].port;
    expect(isPersistedState(state)).toBe(false);
  });

  it("rejects a bridge with the wrong shape", () => {
    const state = persisted();
    // @ts-expect-error — deliberately corrupting a saved bridge
    state.nodes[0].network.bridges["nic-0#0"] = { enabled: "yes" };
    expect(isPersistedState(state)).toBe(false);
  });
});

describe("loadPersistedState", () => {
  it("returns null when nothing is saved", () => {
    expect(loadPersistedState()).toBeNull();
  });

  it("round-trips a state it wrote", () => {
    const state = persisted();
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    expect(loadPersistedState()).toEqual(state);
  });

  // corrupt json and a stale shape are the same outcome to the caller:
  // "nothing usable saved", never a crash on mount.
  it("returns null for unparseable json", () => {
    window.localStorage.setItem(STORAGE_KEY, "{not json");
    expect(loadPersistedState()).toBeNull();
  });

  it("returns null for a state from another version", () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...persisted(), version: 1 }));
    expect(loadPersistedState()).toBeNull();
  });
});

describe("persistCurrentStep", () => {
  it("updates only the step, leaving the rest of the save alone", () => {
    const state = persisted({ currentStep: "hardware" });
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    persistCurrentStep("network");
    expect(loadPersistedState()).toEqual({ ...state, currentStep: "network" });
  });

  // called from a preview route, which can be opened with nothing saved —
  // it must not create a partial state out of nowhere.
  it("does nothing when there's no save to update", () => {
    persistCurrentStep("network");
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
  });
});

describe("when storage itself fails", () => {
  // private browsing, a full quota, or storage disabled outright: the
  // wizard must carry on, not throw on mount or on a step hand-off.
  it("treats unreadable storage as nothing saved", () => {
    const spy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    try {
      expect(loadPersistedState()).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  it("swallows a failed write during a step hand-off", () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(persisted()));
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    try {
      expect(() => persistCurrentStep("storage")).not.toThrow();
    } finally {
      spy.mockRestore();
    }
    // the save it couldn't update is left exactly as it was
    expect(loadPersistedState()?.currentStep).toBe("network");
  });
});

describe("storage links", () => {
  it("knows ceph and zfs are storage purposes", () => {
    expect(isStoragePurpose("ceph")).toBe(true);
    expect(isStoragePurpose("zfs")).toBe(true);
    for (const p of ["vm", "backup", "cluster", "other"] as const) expect(isStoragePurpose(p)).toBe(false);
  });

  const net = (purposes: NonNullable<Parameters<typeof bridge>[0]>["purposes"], key = "nic-1#0") => ({
    managementInterfaceId: "nic-0",
    bridges: { "nic-0#0": bridge(), [key]: bridge({ purposes }) },
  });

  it("makes ceph or zfs off the management interface a storage link", () => {
    expect(isStorageLink(net(["ceph"]), "nic-1#0")).toBe(true);
    expect(isStorageLink(net(["zfs"]), "nic-1#0")).toBe(true);
    expect(isStorageLink(net(["ceph"], "bond-0#0"), "bond-0#0")).toBe(true);
  });

  it("leaves bridges bridges", () => {
    expect(isStorageLink(net(["vm", "backup"]), "nic-1#0")).toBe(false);
    // the management interface keeps its bridge, storage or not
    expect(isStorageLink({ managementInterfaceId: "nic-0", bridges: { "nic-0#0": bridge({ purposes: ["ceph"] }) } }, "nic-0#0")).toBe(false);
    // only an interface's native slot can be one
    expect(isStorageLink(net(["ceph"], "nic-1#1"), "nic-1#1")).toBe(false);
    expect(isStorageLink(net(["ceph"]), "nic-2#0")).toBe(false);
  });

  it("names an interface by its bond or nic", () => {
    const n = nics("10gbe", "10gbe");
    n[1].name = "storage";
    expect(interfaceNameFor("nic-1", n, [])).toBe("storage");
    expect(interfaceNameFor("bond-0", n, [bond({ name: "bond7", nicIndices: [0, 1] })])).toBe("bond7");
    // an id that no longer resolves falls back to itself
    expect(interfaceNameFor("bond-3", n, [])).toBe("bond-3");
  });
});

describe("replacePersistedState", () => {
  it("saves a setup the wizard will load", () => {
    const state = persisted({ currentStep: "storage" });
    expect(replacePersistedState(state)).toBe(true);
    expect(loadPersistedState()).toEqual(state);
  });

  it("reports storage being unavailable", () => {
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    expect(replacePersistedState(persisted())).toBe(false);
    spy.mockRestore();
  });
});

describe("linkSpeedLabel", () => {
  it("words one nic, an even bond and a mixed one", () => {
    expect(linkSpeedLabel(["10gbe"])).toBe("10 gbe");
    expect(linkSpeedLabel(["10gbe", "10gbe"])).toBe("2 × 10 gbe");
    expect(linkSpeedLabel(["10gbe", "1gbe"])).toBe("10 gbe + 1 gbe");
  });

  it("is empty with nothing behind the interface", () => {
    expect(linkSpeedLabel([])).toBe("");
  });
});
