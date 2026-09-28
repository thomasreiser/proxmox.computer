/**
 * Integration tests for the three preview routes. Each renders the real
 * page from a saved state — the way a visitor arrives from the wizard —
 * and checks what's drawn and where "next" hands off to.
 *
 * React Flow does mount its node cards in jsdom (unmeasured, but in the
 * DOM), so card content is asserted directly. Geometry — straight cables,
 * card alignment — can't be checked here and needs a real browser.
 */
import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import HardwarePreview from "./hardware/page";
import NetworkPreview from "./network/page";
import StoragePreview from "./storage/page";
import { STORAGE_KEY, loadPersistedState, type PersistedState } from "../wizard-state";
import { bond, bridge, cluster, disks, network, nics, persistedState } from "../test-fixtures";
import { router } from "@/test/router";

function save(state: PersistedState) {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

/** the summary strip's value for a given key, e.g. "osds" → "3" */
function summaryValue(key: RegExp): string {
  const keyEl = screen.getAllByText(key).find((el) => el.classList.contains("pc-summary__key"));
  if (!keyEl) throw new Error(`no summary cell ${key}`);
  return keyEl.parentElement?.querySelector(".pc-summary__val")?.textContent ?? "";
}

// nodes whose ceph traffic runs over nic-1 at the given speed
function cephCluster(speed: "1gbe" | "10gbe" = "10gbe") {
  return cluster(3, {
    nics: nics("1gbe", speed),
    additionalDisks: disks(1000),
    network: network({
      bridgeCounts: { "nic-0": "1", "nic-1": "1" },
      bridges: {
        "nic-0#0": bridge({ name: "vmbr0" }),
        "nic-1#0": bridge({ name: "vmbr1", purposes: ["ceph"], ip: "10.0.20.11/24" }),
      },
    }),
  });
}

describe.each([
  ["hardware", HardwarePreview],
  ["network", NetworkPreview],
  ["storage", StoragePreview],
] as const)("%s preview with nothing saved", (_name, Preview) => {
  it("offers a way back to step 1 instead of an empty diagram", async () => {
    render(<Preview />);
    expect(await screen.findByText(/nothing saved to preview yet/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /start at step 1/i })).toHaveAttribute("href", "/setup");
  });

  // a save from another build is discarded, not half-rendered
  it("treats a save from another version as nothing saved", async () => {
    save({ ...persistedState(), version: 1 });
    render(<Preview />);
    expect(await screen.findByText(/nothing saved to preview yet/i)).toBeInTheDocument();
  });
});

describe("hardware preview", () => {
  it("draws a card per node and totals the cluster", async () => {
    save(persistedState({ currentStep: "hardware", nodes: cluster(3, { additionalDisks: disks(1000) }) }));
    render(<HardwarePreview />);
    expect(await screen.findByText("# step 1 of 5 — preview")).toBeInTheDocument();
    expect(summaryValue(/^nodes$/i)).toBe("3");
    for (const name of ["pve01", "pve02", "pve03"]) expect(screen.getByText(name)).toBeInTheDocument();
  });

  // more than one grid row: every card is drawn, and there's no minimap —
  // the canvas is fitted to all of them, so it only ever showed a gray box
  it("draws every node of a cluster bigger than one row", async () => {
    save(persistedState({ currentStep: "hardware", nodeCount: "6", nodes: cluster(6) }));
    render(<HardwarePreview />);
    await screen.findByText("# step 1 of 5 — preview");
    expect(document.querySelectorAll(".pc-nodecard")).toHaveLength(6);
    expect(document.querySelector(".react-flow__minimap")).toBeNull();
  });

  // the page can be opened by url, so "next" applies the wizard's gate
  it("won't hand off while step 1 has problems, and lists them", async () => {
    const user = userEvent.setup();
    save(persistedState({ currentStep: "hardware", nodes: cluster(2, { ramGb: "" }), nodeCount: "2" }));
    render(<HardwarePreview />);
    const next = await screen.findByRole("button", { name: /next/i });
    expect(next).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent(/memory \(gb\)/i);
    await user.click(next);
    expect(router.push).not.toHaveBeenCalled();
    expect(loadPersistedState()?.currentStep).toBe("hardware");
  });

  it("hands off to the network step", async () => {
    const user = userEvent.setup();
    save(persistedState({ currentStep: "hardware" }));
    render(<HardwarePreview />);
    await user.click(await screen.findByRole("button", { name: /next/i }));
    expect(loadPersistedState()?.currentStep).toBe("network");
    expect(router.push).toHaveBeenCalledWith("/setup");
  });
});

describe("network preview", () => {
  it("counts nodes and physical links", async () => {
    save(persistedState({ currentStep: "network", nodes: cephCluster() }));
    render(<NetworkPreview />);
    expect(await screen.findByText("# step 2 of 5 — preview")).toBeInTheDocument();
    expect(summaryValue(/^nodes$/i)).toBe("3");
    expect(summaryValue(/^physical links$/i)).toBe("6");
  });

  it("counts bonds", async () => {
    const nodes = cluster(2, {
      nics: nics("1gbe", "1gbe", "1gbe"),
      network: network({
        bonds: [bond({ nicIndices: [1, 2] })],
        bridgeCounts: { "nic-0": "1", "bond-0": "1" },
        bridges: { "nic-0#0": bridge(), "bond-0#0": bridge({ name: "vmbr1" }) },
      }),
    });
    save(persistedState({ currentStep: "network", nodes }));
    render(<NetworkPreview />);
    await screen.findByText("# step 2 of 5 — preview");
    expect(summaryValue(/^bonds$/i)).toBe("2");
  });

  // the one physical-layout rule the diagram can state: every ceph port on
  // one switch
  it("counts the ceph links and says they belong on one switch", async () => {
    save(persistedState({ currentStep: "network", nodes: cephCluster() }));
    render(<NetworkPreview />);
    await screen.findByText("# step 2 of 5 — preview");
    expect(summaryValue(/^ceph links$/i)).toBe("3");
    expect(screen.getByText(/all 3 ceph links belong on the same physical switch/i)).toBeInTheDocument();
    expect(screen.getByText(/3 ceph — keep on this one switch/i)).toBeInTheDocument();
  });

  it("says nothing about ceph placement when no link carries ceph", async () => {
    save(persistedState({ currentStep: "network", clusterStorage: { ceph: false, zfs: false } }));
    render(<NetworkPreview />);
    await screen.findByText("# step 2 of 5 — preview");
    expect(summaryValue(/^ceph links$/i)).toBe("—");
    expect(screen.queryByText(/belong on the same physical switch/i)).not.toBeInTheDocument();
  });

  it("shows the cluster-wide addressing", async () => {
    save(persistedState({ currentStep: "network" }));
    render(<NetworkPreview />);
    await screen.findByText("# step 2 of 5 — preview");
    expect(summaryValue(/^gateway$/i)).toBe("10.0.10.1");
    expect(summaryValue(/^domain$/i)).toBe("lab.lan");
    expect(summaryValue(/^native vlan$/i)).toBe("untagged");
  });

  // what you'd configure (or buy) a switch port by: connector and vlans
  it("labels every switch port with its connector and vlan config", async () => {
    const nodes = cluster(1, {
      nics: nics({ speed: "1gbe" }, { speed: "10gbe" }, { speed: "10gbe", port: "rj45" }),
      network: network({
        bridgeCounts: { "nic-0": "1", "nic-1": "2", "nic-2": "1" },
        bridges: {
          "nic-0#0": bridge({ name: "vmbr0" }),
          "nic-1#0": bridge({ name: "vmbr1" }),
          "nic-1#1": bridge({ name: "vmbr2", vlanTag: "40" }),
          "nic-2#0": bridge({ name: "vmbr3" }),
        },
      }),
    });
    save(persistedState({ currentStep: "network", nodes, homelabVlan: "5", clusterStorage: { ceph: false, zfs: false } }));
    render(<NetworkPreview />);
    await screen.findByText("# step 2 of 5 — preview");
    const ports = [...document.querySelectorAll(".pc-switch__portbox")];
    const read = (sel: string) => ports.map((p) => p.querySelector(sel)?.textContent);
    expect(read(".pc-switch__porttype")).toEqual(["rj45", "sfp+", "rj45"]);
    expect(read(".pc-switch__portvlan")).toEqual(["u5", "u5 t40", "u5"]);
    expect(ports[1].getAttribute("title")).toMatch(/untagged: vlan 5 · tagged: vlan 40/);
  });

  it("flags a switch port whose tagged vlan isn't set yet", async () => {
    const nodes = cluster(1, {
      network: network({
        bridgeCounts: { "nic-0": "2" },
        bridges: { "nic-0#0": bridge(), "nic-0#1": bridge({ name: "vmbr1", vlanTag: "" }) },
      }),
    });
    save(persistedState({ currentStep: "network", nodes, clusterStorage: { ceph: false, zfs: false } }));
    render(<NetworkPreview />);
    await screen.findByText("# step 2 of 5 — preview");
    const vlan = document.querySelector(".pc-switch__portvlan") as HTMLElement;
    expect(vlan).toHaveTextContent("u t?");
    expect(vlan).toHaveClass("pc-switch__portvlan--warn");
  });

  it("won't hand off while step 2 has problems", async () => {
    save(persistedState({ currentStep: "network", gateway: "" }));
    render(<NetworkPreview />);
    expect(await screen.findByRole("button", { name: /next/i })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent(/gateway/i);
  });

  it("hands off to the storage step", async () => {
    const user = userEvent.setup();
    save(persistedState({ currentStep: "network" }));
    render(<NetworkPreview />);
    await user.click(await screen.findByRole("button", { name: /next/i }));
    expect(loadPersistedState()?.currentStep).toBe("storage");
    expect(router.push).toHaveBeenCalledWith("/setup");
  });
});

describe("storage preview", () => {
  it("draws every node's disks and the pool they feed", async () => {
    save(persistedState({ nodes: cephCluster() }));
    render(<StoragePreview />);
    expect(await screen.findByText("# step 3 of 5 — preview")).toBeInTheDocument();
    expect(summaryValue(/^osds$/i)).toBe("3");
    expect(summaryValue(/^ceph usable$/i)).toBe("1.0 tb");
    const pool = document.querySelector(".pc-pool") as HTMLElement;
    expect(within(pool).getByText("ceph-vm")).toBeInTheDocument();
    expect(within(pool).getByText(/of 3\.0 tb raw/)).toBeInTheDocument();
  });

  it("shows each node's ceph link speed", async () => {
    save(persistedState({ nodes: cephCluster("10gbe") }));
    render(<StoragePreview />);
    await screen.findByText("# step 3 of 5 — preview");
    expect(screen.getAllByText("ceph link")).toHaveLength(3);
    expect(screen.getAllByText("10 gbe")).toHaveLength(3);
  });

  it("flags a ceph link below 10 gbe", async () => {
    save(persistedState({ nodes: cephCluster("1gbe") }));
    render(<StoragePreview />);
    await screen.findByText("# step 3 of 5 — preview");
    const slow = screen.getAllByText(/1 gbe/).filter((el) => el.classList.contains("pc-storcard__linkval"));
    expect(slow).toHaveLength(3);
    expect(slow[0]).toHaveClass("pc-storcard__linkval--warn");
    // the ⚠ comes with its reason, not on its own
    expect(screen.getAllByText(/ceph waits on this link for every write/i)).toHaveLength(3);
  });

  // a save from a bigger cluster can hold more replicas than this one can
  // place — the diagram has to show what's actually in effect
  it("quotes the replica count actually in effect", async () => {
    const state = persistedState({ nodes: cephCluster().slice(0, 2), nodeCount: "2" });
    state.storage.ceph = { ...state.storage.ceph, replicas: "3", minReplicas: "3" };
    save(state);
    render(<StoragePreview />);
    await screen.findByText("# step 3 of 5 — preview");
    expect(screen.getByText("2× (min 2)")).toBeInTheDocument();
  });

  it("warns on the pool when a node contributes nothing", async () => {
    const nodes = cephCluster();
    // two disks, both left out — a sole disk would be forced into ceph
    nodes[2].additionalDisks = disks({ role: "unused" }, { role: "unused" });
    save(persistedState({ nodes }));
    render(<StoragePreview />);
    await screen.findByText("# step 3 of 5 — preview");
    expect(screen.getByText(/only 2 of 3 nodes contribute a disk/i)).toBeInTheDocument();
  });

  it("describes the replicated zfs pool under zfs", async () => {
    save(persistedState({ clusterStorage: { ceph: false, zfs: true }, nodes: cluster(3, { additionalDisks: disks(1000, 1000) }) }));
    render(<StoragePreview />);
    await screen.findByText("# step 3 of 5 — preview");
    expect(screen.getByText("zfs + replication")).toBeInTheDocument();
    expect(screen.getByText("mirror per node")).toBeInTheDocument();
    expect(summaryValue(/^zfs disks$/i)).toBe("6");
  });

  // ceph as the main storage, zfs replication alongside: both pools cabled
  // to every node, each built from its own disks
  it("draws both pools when ceph and zfs are both on", async () => {
    const nodes = cephCluster().map((n) => ({
      ...n,
      additionalDisks: disks({ role: "ceph", sizeGb: "2000" }, { role: "zfs" }, { role: "zfs" }),
    }));
    save(persistedState({ nodes, clusterStorage: { ceph: true, zfs: true } }));
    render(<StoragePreview />);
    await screen.findByText("# step 3 of 5 — preview");
    const pools = [...document.querySelectorAll(".pc-pool")];
    expect(pools).toHaveLength(2);
    expect(pools[0]).toHaveTextContent("ceph pool");
    expect(pools[1]).toHaveTextContent("zfs + replication");
    // both pools take a cable from every node
    expect(pools[0].querySelectorAll(".pc-pool__portbox")).toHaveLength(3);
    expect(pools[1].querySelectorAll(".pc-pool__portbox")).toHaveLength(3);
    expect(summaryValue(/^osds$/i)).toBe("3");
    expect(summaryValue(/^zfs disks$/i)).toBe("6");
    expect(screen.getAllByText("zfs pool")).toHaveLength(3);
  });

  it("draws no pool and says why without cluster storage", async () => {
    save(persistedState({ clusterStorage: { ceph: false, zfs: false } }));
    render(<StoragePreview />);
    await screen.findByText("# step 3 of 5 — preview");
    expect(document.querySelector(".pc-pool")).toBeNull();
    expect(screen.getByText(/no shared pool — every node is an island/i)).toBeInTheDocument();
  });

  // same rule as the wizard: no local disks, no local pool
  it("shows the local pool only when a disk is marked local", async () => {
    save(persistedState({ nodes: cephCluster() }));
    const { unmount } = render(<StoragePreview />);
    await screen.findByText("# step 3 of 5 — preview");
    expect(screen.queryByText(/local-zfs/)).not.toBeInTheDocument();
    unmount();

    const nodes = cluster(3, { additionalDisks: disks(1000, { role: "local" }) });
    save(persistedState({ nodes }));
    render(<StoragePreview />);
    await screen.findByText("# step 3 of 5 — preview");
    expect(screen.getByText(/local-zfs \(zfs\)/)).toBeInTheDocument();
    expect(summaryValue(/^local disks$/i)).toBe("3");
  });

  // steps 4–5 don't exist yet, so there's nowhere to hand off to
  it("keeps next disabled until step 4 exists", async () => {
    save(persistedState());
    render(<StoragePreview />);
    expect(await screen.findByRole("button", { name: /next/i })).toBeDisabled();
  });
});
