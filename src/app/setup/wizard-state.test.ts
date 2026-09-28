import { describe, expect, it } from "vitest";
import {
  MAX_BRIDGES_PER_INTERFACE,
  STORAGE_VERSION,
  STORAGE_KEY,
  bridgeCountFor,
  bridgeKey,
  bondModeLabel,
  interfacesFor,
  isFastNic,
  isPersistedState,
  isSlowNic,
  loadPersistedState,
  needsHostIpForPurposes,
  nicIndicesForInterface,
  nicSpeedLabel,
  nicSpeedsForInterface,
  persistCurrentStep,
  validBonds,
  type PersistedState,
} from "./wizard-state";
import { bond, cluster, nics } from "./test-fixtures";

function persisted(overrides: Partial<PersistedState> = {}): PersistedState {
  return {
    version: STORAGE_VERSION,
    currentStep: "network",
    nodeCount: "3",
    hostnameSuffix: "lab.lan",
    globalCidr: "10.0.0.0/24",
    gateway: "10.0.0.1",
    homelabVlan: "",
    nodes: cluster(3),
    identicalHardware: true,
    identicalNetwork: false,
    storageHaMode: "ceph",
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

  // the version check is the real defence: a shape change from an older
  // build is discarded wholesale rather than half-applied.
  it("rejects a state from another version", () => {
    expect(isPersistedState({ ...persisted(), version: STORAGE_VERSION - 1 })).toBe(false);
  });

  it.each([null, undefined, 42, "state", []])("rejects non-object %s", (value) => {
    expect(isPersistedState(value)).toBe(false);
  });

  it.each([
    ["currentStep", "storage"],
    ["nodeCount", 3],
    ["globalCidr", null],
    ["identicalNetwork", "yes"],
    ["storageHaMode", "raid"],
    ["nodes", {}],
  ])("rejects a bad %s", (key, value) => {
    expect(isPersistedState({ ...persisted(), [key]: value })).toBe(false);
  });

  it("rejects a node missing its network", () => {
    const state = persisted();
    // @ts-expect-error — deliberately corrupting a saved node
    delete state.nodes[0].network;
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
