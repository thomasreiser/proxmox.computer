import { describe, expect, it } from "vitest";
import {
  freshState,
  loadPersistedState,
  loadSaved,
  restoreSaved,
  savePersistedState,
  startOverFrom,
  startedOverNotice,
} from "./saved-state";
import { defaultBackupPlan } from "./backups";
import { defaultAccessPlan } from "./access";
import { defaultSoftwarePlan, newGuest } from "./software";
import { defaultStoragePlan } from "./derive";
import { accessPlan, backupPlan, cluster, disks, installPlan, persistedState, softwarePlan } from "./test-fixtures";
import { defaultInstallPlan } from "./boot-disk";
import { STEP_VERSIONS, STORAGE_VERSION, isPersistedState, type PersistedState, type SavedStepId } from "./wizard-state";

// a complete save, with something of the visitor's own in every step
const complete = (overrides: Partial<PersistedState> = {}) => {
  const nodes = cluster(3, { additionalDisks: disks({ role: "ceph" }) });
  const ctx = { nodes, clusterStorage: { ceph: true, zfs: false }, storage: defaultStoragePlan() };
  return persistedState({
    currentStep: "software",
    location: { country: "de", keyboard: "de", timezone: "Europe/Berlin" },
    nodes,
    hostnameSuffix: "lab.lan",
    identicalStorage: true,
    backups: backupPlan({ keepDaily: "14" }),
    access: accessPlan(),
    software: softwarePlan([newGuest("vm", [], ctx, { name: "web" })]),
    ...overrides,
  });
};

/** the save as an older build would have written it, with this step at another version */
const withStale = (state: PersistedState, step: SavedStepId) => ({
  ...state,
  stepVersions: { ...STEP_VERSIONS, [step]: STEP_VERSIONS[step] - 1 },
});

describe("freshState", () => {
  it("is a complete, current save", () => {
    expect(isPersistedState(freshState())).toBe(true);
    expect(freshState()).toMatchObject({ currentStep: "location", nodeCount: "1", nodes: [expect.objectContaining({ name: "pve01" })] });
  });
});

describe("restoreSaved", () => {
  it("keeps a current save whole", () => {
    const state = complete();
    expect(restoreSaved(state)).toEqual({ state, startedOverFrom: null });
  });

  it("isn't a save in another layout, or with nowhere to reopen", () => {
    expect(restoreSaved(null)).toBeNull();
    expect(restoreSaved("state")).toBeNull();
    expect(restoreSaved({ ...complete(), version: STORAGE_VERSION - 1 })).toBeNull();
    expect(restoreSaved({ ...complete(), currentStep: "deploy" })).toBeNull();
  });

  // the case this exists for: step 5 changed, so 1–4 stay
  it("keeps the steps before a changed one, and starts it and the rest over", () => {
    const saved = complete();
    const restored = restoreSaved(withStale(saved, "backups"))!;
    expect(restored.startedOverFrom).toBe("backups");
    const { state } = restored;
    expect(state.location).toEqual(saved.location);
    expect(state.nodes).toEqual(saved.nodes);
    expect(state.hostnameSuffix).toBe("lab.lan");
    expect(state.identicalStorage).toBe(true);
    expect(state.backups).toEqual(defaultBackupPlan());
    expect(state.access).toEqual(defaultAccessPlan());
    expect(state.software).toEqual(defaultSoftwarePlan());
    // saved under this build's versions from here on
    expect(state.stepVersions).toEqual(STEP_VERSIONS);
    expect(isPersistedState(state)).toBe(true);
  });

  it("treats a step that's not the shape it should be like a changed one", () => {
    const restored = restoreSaved({ ...complete(), access: { ...accessPlan(), rootPasswords: "hunter2" } })!;
    expect(restored.startedOverFrom).toBe("access");
    expect(restored.state.backups.keepDaily).toBe("14");
    expect(restored.state.access).toEqual(defaultAccessPlan());
  });

  it("starts everything over from the first changed step, when several have", () => {
    const state = { ...complete(), stepVersions: { ...STEP_VERSIONS, network: 0, software: 0 } };
    expect(restoreSaved(state)?.startedOverFrom).toBe("network");
  });

  it("starts every step over without step versions at all", () => {
    const unversioned: Partial<PersistedState> = complete();
    delete unversioned.stepVersions;
    expect(restoreSaved(unversioned)?.startedOverFrom).toBe("location");
  });

  it("moves the visitor back to the changed step, never forward", () => {
    expect(restoreSaved(withStale(complete({ currentStep: "install" }), "access"))?.state.currentStep).toBe("access");
    expect(restoreSaved(withStale(complete({ currentStep: "network" }), "access"))?.state.currentStep).toBe("network");
    expect(restoreSaved(withStale(complete({ currentStep: "access" }), "access"))?.state.currentStep).toBe("access");
  });
});

// step 8 started saving its boot disks in a later build than steps 1–7
describe("a save from before step 8 saved anything", () => {
  const older = (saved: Partial<PersistedState>) => {
    const copy = { ...saved };
    delete copy.install;
    const { install: _install, ...versions } = STEP_VERSIONS;
    void _install;
    return { ...copy, stepVersions: versions };
  };

  it("keeps steps 1–7, and starts step 8 with no boot disks", () => {
    const saved = complete({ currentStep: "install" });
    const restored = restoreSaved(older(saved))!;
    expect(restored.startedOverFrom).toBe("install");
    expect(restored.state.software).toEqual(saved.software);
    expect(restored.state.access).toEqual(saved.access);
    expect(restored.state.install).toEqual(defaultInstallPlan());
    expect(restored.state.currentStep).toBe("install");
    expect(isPersistedState(restored.state)).toBe(true);
  });

  it("tells the visitor only step 8 starts over", () => {
    expect(startedOverNotice("install")).toBe(
      "step 8, install, has changed since this setup was saved — it and the steps after it start over. steps 1–7 are kept.",
    );
  });
});

describe("step 8's boot disks", () => {
  it("are kept with a current save", () => {
    const saved = complete({ install: installPlan({ bootDisks: ["nvme0n1", "sda", ""] }) });
    expect(restoreSaved(saved)?.state.install.bootDisks).toEqual(["nvme0n1", "sda", ""]);
  });

  it("start over when an earlier step does", () => {
    const saved = complete({ install: installPlan({ bootDisk: "sda" }) });
    expect(restoreSaved(withStale(saved, "software"))?.state.install).toEqual(defaultInstallPlan());
  });

  it("start over when they're not the shape they should be", () => {
    const restored = restoreSaved({ ...complete(), install: { bootDisk: "sda", bootDisks: "sda" } })!;
    expect(restored.startedOverFrom).toBe("install");
    expect(restored.state.install).toEqual(defaultInstallPlan());
  });
});

// steps 2–4 share the nodes: each keeps its own part of them
describe("startOverFrom, on the nodes", () => {
  it("keeps the hardware and gives each node a fresh network when step 3 changed", () => {
    const saved = complete();
    const state = startOverFrom(saved, "network");
    expect(state.nodes.map((n) => n.name)).toEqual(["pve01", "pve02", "pve03"]);
    expect(state.nodes[1].ramGb).toBe(saved.nodes[1].ramGb);
    expect(state.nodes[1].network).toMatchObject({ hostLabel: "pve02", cidr: "10.0.10.12/24" });
    expect(state.hostnameSuffix).toBe(freshState().hostnameSuffix);
    // step 4 builds on step 3, so the disk roles go too
    expect(state.nodes[0].additionalDisks[0].role).toBe("");
    expect(isPersistedState(state)).toBe(true);
  });

  it("keeps the networks and forgets only the disk roles when step 4 changed", () => {
    const saved = complete();
    const state = startOverFrom(saved, "storage");
    expect(state.nodes.map((n) => n.network)).toEqual(saved.nodes.map((n) => n.network));
    expect(state.nodes[0].additionalDisks).toEqual([{ ...saved.nodes[0].additionalDisks[0], role: "" }]);
    expect(state.identicalStorage).toBe(false);
  });

  it("goes back to a single fresh node when step 2 changed", () => {
    const state = startOverFrom(complete(), "hardware");
    expect(state.nodes).toEqual(freshState().nodes);
    expect(state.nodeCount).toBe("1");
    expect(state.location.country).toBe("de");
  });

  it("keeps nothing but the step to reopen on when step 1 changed", () => {
    const state = startOverFrom(complete({ currentStep: "backups" }), "location");
    expect(state).toEqual(freshState());
  });
});

describe("startedOverNotice", () => {
  it("names the changed step and what's kept", () => {
    expect(startedOverNotice("backups")).toBe(
      "step 5, backups, has changed since this setup was saved — it and the steps after it start over. steps 1–4 are kept.",
    );
    expect(startedOverNotice("hardware")).toMatch(/step 2, hardware.* step 1 is kept\.$/);
    expect(startedOverNotice("location")).toMatch(/start over\.$/);
  });
});

describe("loading a save", () => {
  it("reads back what was saved", async () => {
    const state = complete();
    await savePersistedState(state);
    expect(await loadSaved()).toEqual({ state, startedOverFrom: null });
    expect(await loadPersistedState()).toEqual(state);
  });

  it("reads back an older build's save as far as it can", async () => {
    await savePersistedState(withStale(complete(), "software"));
    const restored = await loadSaved();
    expect(restored?.startedOverFrom).toBe("software");
    expect(restored?.state.software.guests).toEqual([]);
    expect(restored?.state.backups.keepDaily).toBe("14");
  });

  it("is empty with nothing saved", async () => {
    expect(await loadSaved()).toBeNull();
  });
});
