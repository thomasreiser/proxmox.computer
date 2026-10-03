import { describe, expect, it } from "vitest";
import { layout } from "./cabling";
import { buildStorageOverview } from "./plan";
import { defaultStoragePlan } from "../../derive";
import { cluster, disks } from "../../test-fixtures";

const both = () =>
  buildStorageOverview(
    cluster(3, { additionalDisks: disks({ role: "ceph" }, { role: "zfs" }, { role: "zfs" }) }),
    defaultStoragePlan(),
    { ceph: true, zfs: true },
    "",
  );

describe("storage preview layout", () => {
  it("cables every contributing node to each pool it feeds", () => {
    const { edges } = layout(both());
    expect(edges.filter((e) => e.target === "pool-ceph")).toHaveLength(3);
    expect(edges.filter((e) => e.target === "pool-zfs")).toHaveLength(3);
  });

  // the zfs cables have to get past the full-width ceph card: they run
  // behind it (a lower zIndex than the card) rather than over its content
  it("runs the zfs cables behind the ceph card when both are on", () => {
    const { nodes, edges } = layout(both());
    const cephCard = nodes.find((n) => n.id === "pool-ceph");
    const zfsEdge = edges.find((e) => e.target === "pool-zfs");
    expect(zfsEdge?.zIndex).toBeLessThan(cephCard?.zIndex ?? 0);
  });

  it("draws the zfs cables on top when there's no ceph card to pass", () => {
    const overview = buildStorageOverview(cluster(2, { additionalDisks: disks(1000, 1000) }), defaultStoragePlan(), { ceph: false, zfs: true }, "");
    expect(layout(overview).edges.every((e) => (e.zIndex ?? 0) >= 1000)).toBe(true);
  });

  it("leaves the ceph and zfs cables on separate anchors", () => {
    const { edges } = layout(both());
    expect(new Set(edges.map((e) => e.sourceHandle))).toEqual(new Set(["pool", "zfs"]));
  });

  // replication is a scheduled copy, not a live link
  it("dashes the zfs cables and not the ceph ones", () => {
    const { edges } = layout(both());
    expect(edges.filter((e) => e.target === "pool-zfs").every((e) => e.style?.strokeDasharray)).toBe(true);
    expect(edges.filter((e) => e.target === "pool-ceph").some((e) => e.style?.strokeDasharray)).toBe(false);
  });

  it("draws no cable from a node that contributes nothing", () => {
    const overview = buildStorageOverview(
      cluster(2, { additionalDisks: disks({ role: "local" }, { role: "local" }) }),
      defaultStoragePlan(),
      { ceph: false, zfs: true },
      "",
    );
    expect(layout(overview).edges).toEqual([]);
  });
});
