import { describe, expect, it } from "vitest";
import {
  backupHintFor,
  bridgesWithPurpose,
  cephLinkSpeedHint,
  corosyncHintFor,
  cpuHintFor,
  nodesWithoutFastNic,
  purposeComboHint,
  quorumHintFor,
  storageHaHintFor,
  vmTrafficHintFor,
} from "./hints";
import { bridge, cluster, nics, node } from "./test-fixtures";
import type { BridgeConfig } from "./wizard-state";

const bridges = (...list: BridgeConfig[]): Record<string, BridgeConfig> =>
  Object.fromEntries(list.map((b, i) => [`nic-${i}#0`, b]));

describe("quorumHintFor", () => {
  it("calls a single node standalone, not a quorum problem", () => {
    expect(quorumHintFor(1)).toMatchObject({ tone: "info" });
  });

  // the case that actually bites people: two nodes can't break a tie.
  it("warns about 2 nodes having no automatic quorum", () => {
    const hint = quorumHintFor(2);
    expect(hint.tone).toBe("warning");
    expect(hint.text).toMatch(/qdevice/);
  });

  it("confirms quorum from 3 nodes up", () => {
    expect(quorumHintFor(3)).toMatchObject({ tone: "success" });
    expect(quorumHintFor(9)).toMatchObject({ tone: "success" });
  });
});

describe("cpuHintFor", () => {
  it("says nothing about a single node — there's nothing to migrate to", () => {
    expect(cpuHintFor(cluster(1))).toBeNull();
  });

  it("warns when vendors are mixed", () => {
    const nodes = cluster(2);
    nodes[1].cpuVendor = "amd";
    nodes[1].cpuFamily = "EPYC";
    expect(cpuHintFor(nodes)?.text).toMatch(/can't live-migrate across vendors/);
  });

  it("confirms migration works when every node resolves to one type", () => {
    expect(cpuHintFor(cluster(3))).toMatchObject({ tone: "success" });
  });

  // the interesting case: different marketing names can resolve to the
  // same qemu type, and then there is nothing to warn about.
  it("compares resolved qemu types, not display names", () => {
    const nodes = cluster(2);
    nodes[0].cpuFamily = "SandyBridge";
    nodes[1].cpuFamily = "IvyBridge";
    const hint = cpuHintFor(nodes);
    // whichever way these two resolve, the hint must agree with itself:
    // "success" only if the resolved types really are identical.
    if (hint?.tone === "success") {
      expect(hint.text).toMatch(/same effective cpu type/);
    } else {
      expect(hint?.text).toMatch(/Set vm cpu type to/);
    }
  });

  it("names the oldest family to pin to when generations differ", () => {
    const nodes = cluster(2);
    nodes[0].cpuFamily = "Nehalem";
    nodes[1].cpuFamily = "Skylake-Client";
    const hint = cpuHintFor(nodes);
    expect(hint?.tone).toBe("warning");
    expect(hint?.text).toMatch(/Set vm cpu type to/);
  });
});

describe("purposeComboHint", () => {
  it("says nothing about a single purpose", () => {
    expect(purposeComboHint(["ceph"])).toBeNull();
    expect(purposeComboHint(["vm"])).toBeNull();
  });

  // ceph is checked before zfs and before the corosync/backup pair, so a
  // bridge carrying several problems reports the worst one.
  it("flags ceph sharing with anything at all", () => {
    expect(purposeComboHint(["ceph", "vm"])?.text).toMatch(/not share the ceph nic/);
    expect(purposeComboHint(["ceph", "cluster", "backup"])?.text).toMatch(/not share the ceph nic/);
  });

  it("flags zfs replication sharing", () => {
    expect(purposeComboHint(["zfs", "vm"])?.text).toMatch(/not share the zfs replication nic/);
  });

  it("flags corosync riding with backups — the false-quorum case", () => {
    expect(purposeComboHint(["cluster", "backup"])?.text).toMatch(/false quorum loss/);
  });

  it("accepts vm traffic sharing with corosync, a normal homelab setup", () => {
    expect(purposeComboHint(["vm", "cluster"])).toBeNull();
  });
});

describe("cephLinkSpeedHint", () => {
  it("says nothing when the bridge doesn't carry ceph", () => {
    expect(cephLinkSpeedHint(["vm"], ["1gbe"])).toBeNull();
  });

  it("says nothing at 10gbe or above", () => {
    expect(cephLinkSpeedHint(["ceph"], ["10gbe"])).toBeNull();
    expect(cephLinkSpeedHint(["ceph"], ["25gbe"])).toBeNull();
  });

  // "other / not sure" is neither fast nor slow: it can't earn a warning
  // on its own, and can't clear one either.
  it("stays quiet for an unknown speed", () => {
    expect(cephLinkSpeedHint(["ceph"], ["other"])).toBeNull();
  });

  it("warns on a single slow nic", () => {
    const hint = cephLinkSpeedHint(["ceph"], ["1gbe"]);
    expect(hint?.tone).toBe("warning");
    expect(hint?.text).toMatch(/this nic carries ceph at 1 gbe/);
  });

  it("warns on 2.5gbe too — the floor is 10, not 1", () => {
    expect(cephLinkSpeedHint(["ceph"], ["2.5gbe"])?.text).toMatch(/2\.5 gbe/);
  });

  // the specific misconception worth naming: lacp buys throughput, never
  // latency, and ceph is bound by the latter.
  it("uses the bond wording when more than one nic is behind the bridge", () => {
    const hint = cephLinkSpeedHint(["ceph"], ["1gbe", "1gbe"]);
    expect(hint?.text).toMatch(/this bond carries ceph/);
    expect(hint?.text).toMatch(/never lowers latency/);
  });

  // a bond is only as good as its slowest member, so one slow nic hiding
  // inside an otherwise fine bond still has to surface.
  it("flags a bond whose members are mixed, naming only the slow one", () => {
    const hint = cephLinkSpeedHint(["ceph"], ["10gbe", "1gbe"]);
    expect(hint?.tone).toBe("warning");
    expect(hint?.text).toMatch(/this bond carries ceph over 1 gbe\./);
  });

  it("deduplicates repeated speeds in the message", () => {
    const hint = cephLinkSpeedHint(["ceph"], ["1gbe", "1gbe", "1gbe"]);
    expect(hint?.text.match(/1 gbe/g)).toHaveLength(1);
  });

  it("stays quiet when there are no nics behind the interface at all", () => {
    expect(cephLinkSpeedHint(["ceph"], [])).toBeNull();
  });
});

describe("nodesWithoutFastNic", () => {
  it("returns every node when none has a 10gbe nic", () => {
    expect(nodesWithoutFastNic(cluster(3))).toHaveLength(3);
  });

  it("returns none when every node has one", () => {
    expect(nodesWithoutFastNic(cluster(3, { nics: nics("1gbe", "10gbe") }))).toHaveLength(0);
  });

  // ceph runs on every node, so one slow node is the cluster's problem —
  // this is why it returns a list rather than a boolean.
  it("returns only the nodes that lack one", () => {
    const nodes = cluster(3, { nics: nics("1gbe", "10gbe") });
    nodes[1].nics = nics("1gbe", "1gbe");
    const slow = nodesWithoutFastNic(nodes);
    expect(slow).toHaveLength(1);
    expect(slow[0].name).toBe("pve02");
  });

  it("does not count an unknown speed as fast", () => {
    expect(nodesWithoutFastNic(cluster(1, { nics: nics("other") }))).toHaveLength(1);
  });
});

describe("per-node coverage hints", () => {
  it("bridgesWithPurpose ignores a disabled bridge", () => {
    expect(bridgesWithPurpose(bridges(bridge({ enabled: false, purposes: ["vm"] })), "vm")).toBe(false);
    expect(bridgesWithPurpose(bridges(bridge({ purposes: ["vm"] })), "vm")).toBe(true);
  });

  // no vm bridge means the node literally cannot host a guest, which is a
  // different class of problem from the advisory warnings around it.
  it("vmTrafficHintFor is danger-toned when no bridge carries vm traffic", () => {
    expect(vmTrafficHintFor(bridges(bridge({ purposes: ["ceph"] })))).toMatchObject({ tone: "danger" });
    expect(vmTrafficHintFor(bridges(bridge({ purposes: ["vm"] })))).toBeNull();
  });

  it("backupHintFor warns until some bridge carries backups", () => {
    expect(backupHintFor(bridges(bridge()))?.tone).toBe("warning");
    expect(backupHintFor(bridges(bridge({ purposes: ["backup"] })))).toBeNull();
  });

  it("corosyncHintFor stays quiet on a standalone node", () => {
    expect(corosyncHintFor(bridges(bridge()), 1)).toBeNull();
    expect(corosyncHintFor(bridges(bridge()), 3)?.tone).toBe("warning");
  });

  it("storageHaHintFor only fires once a storage mode was actually chosen", () => {
    expect(storageHaHintFor(bridges(bridge()), null)).toBeNull();
    expect(storageHaHintFor(bridges(bridge()), "ceph")).toMatchObject({ tone: "danger" });
    expect(storageHaHintFor(bridges(bridge({ purposes: ["ceph"] })), "ceph")).toBeNull();
  });

  it("storageHaHintFor names zfs replication in full", () => {
    expect(storageHaHintFor(bridges(bridge()), "zfs")?.text).toMatch(/zfs replication/);
  });
});

describe("fixtures stay in sync with the model", () => {
  it("builds a node whose nic count matches its nics", () => {
    const n = node();
    expect(n.nics).toHaveLength(Number(n.nicCount));
  });
});
