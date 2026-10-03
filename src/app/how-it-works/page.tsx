import type { Metadata } from "next";
import Link from "next/link";
import { PHASES, sideLabel } from "./pipeline";
import { RepoTree, type TreeEntry } from "./repo-tree";
import { PipelineCanvas } from "./pipeline-canvas";

export const metadata: Metadata = {
  title: "how it works — proxmox.computer",
  description:
    "How proxmox.computer turns a few answers into a working proxmox cluster: declare intent in the browser, discover identity on the machines, bind the two, and get an ansible repo you own — including the rolling-upgrade play.",
};

// the bands site.yml runs in, and the ordering constraint that puts each
// one where it is — the table is the whole argument for why this is a
// pipeline rather than a pile of scripts.
const PHASE_ORDER = [
  {
    tag: "preflight",
    does: "reachability, pve version, assert every mac and disk serial still matches",
    why: "never mutates anything — it refuses to continue if the hardware moved since you bound it",
  },
  {
    tag: "base",
    does: "repos, apt upgrade, packages, chrony, ssh keys",
    why: "clocks first: corosync and ceph both fall apart on skew, and every later band assumes they agree",
  },
  {
    tag: "network",
    does: "rename nics by mac, write /etc/network/interfaces, bonds, bridges, vlans",
    why: "has to precede the cluster — corosync binds to a link that doesn't exist yet",
  },
  {
    tag: "cluster",
    does: "create the cluster on the first node, join the rest",
    why: "joining isn't idempotent by nature, so it's guarded on pvecm status rather than re-run blindly",
  },
  {
    tag: "storage",
    does: "zfs pools by-id, then ceph mons and mgrs, then osds",
    why: "osds need both the cluster and the ceph network already up",
  },
  {
    tag: "backups",
    does: "pbs datastore, jobs, retention",
    why: "needs somewhere to write, so it waits for storage",
  },
  {
    tag: "workloads",
    does: "templates, vms and containers, the kubernetes cluster",
    why: "last — everything here assumes a healthy cluster underneath",
  },
];

// what step 05 hands back, drawn by <RepoTree/>. the two marked entries
// are the ones the surrounding paragraph calls out.
const REPO_TREE: TreeEntry = {
  name: "homelab/",
  children: [
    { name: "README.md", note: "the commands, in order, copy-pasteable" },
    { name: "answer/pve01.toml", note: "unattended-install answer files (phase 02)" },
    { name: "inventory/hosts.yml" },
    { name: "group_vars/all.yml", note: "domain, gateway, vlan, ha mode, ceph" },
    {
      name: "host_vars/",
      children: [
        { name: "pve01.yml", note: "generated — bound macs, by-id paths, bridges" },
        { name: "pve01.local.yml", note: "yours — never regenerated, wins on merge", marked: true },
      ],
    },
    { name: "site.yml", note: "the seven bands below" },
    { name: "upgrade.yml", note: "rolling, health-gated, one node at a time" },
    { name: "roles/", note: "vendored and pinned" },
    { name: ".wizard/state.json", note: "drop this back on the site to change anything", marked: true },
  ],
};

const LEGEND = [
  { kind: "handoff", label: "a file you carry across", hint: "the only thing that ever crosses between the two halves" },
  { kind: "step", label: "the next phase", hint: "same side of the line, nothing moves" },
  { kind: "loop", label: "the return path", hint: "what makes this a cycle instead of a one-shot generator" },
];

export default function HowItWorks() {
  return (
    <div className="pc-root flex min-h-full flex-col">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-5">
          <Link href="/" className="flex items-center gap-2.5">
            <span className="code flex h-7 w-7 items-center justify-center bg-accent font-bold text-on-accent">
              {">"}
            </span>
            <span className="text-[15px] font-semibold tracking-tight">
              proxmox<span className="text-accent">.computer</span>
            </span>
          </Link>
          <Link href="/setup" className="meta text-ink-muted transition-colors hover:text-ink">
            start the setup →
          </Link>
        </div>
      </header>

      <main className="flex-1">
        {/* Hero */}
        <section>
          <div className="mx-auto max-w-5xl px-6 pt-16 pb-10">
            <p className="meta text-ink-muted"># how it works</p>
            <h1 className="h1 mt-4 text-balance">
              From a few answers to a cluster that stays configured.
            </h1>
            <p className="body mt-5 max-w-2xl text-ink-muted">
              The wizard isn&apos;t a generator that hands you a wall of
              commands and wishes you luck. It produces an ansible repo that
              you own, that runs against your own machines, and that you can
              re-run every time something changes — including six months
              later, when you add a fourth node.
            </p>
          </div>
        </section>

        {/* The step roster — every "step 05" on this page resolves here */}
        <section className="border-t border-border">
          <div className="mx-auto max-w-5xl px-6 py-14">
            <h2 className="label text-brand">the seven steps, once — then by number</h2>
            <p className="body mt-4 max-w-2xl text-ink-muted">
              The rest of this page refers to these by number, and the diagram
              further down lays them out as a flow. Four of them are the
              wizard; three are things you run yourself. They interleave,
              which is why there&apos;s one sequence rather than two.
            </p>

            {/* the margin lives on a wrapper, not on .pc-roster itself:
                globals.css is unlayered, so its `margin: 0` would beat a
                tailwind `mt-*` utility (which sits in a cascade layer). */}
            <div className="mt-8">
              <ol className="pc-roster">
                {PHASES.map((phase) => (
                  <li key={phase.id} className="pc-roster__item">
                    <span className={`pc-roster__cell pc-roster__cell--step pc-roster__step--${phase.side}`}>
                      {phase.step}
                    </span>
                    <span className="pc-roster__cell pc-roster__cell--title">{phase.title}</span>
                    <span className={`meta pc-roster__cell pc-roster__cell--where pc-roster__where--${phase.side}`}>
                      {sideLabel(phase.side)}
                    </span>
                    <span className="body-sm pc-roster__cell pc-roster__cell--what">{phase.tagline}</span>
                  </li>
                ))}
              </ol>
            </div>

            <p className="body mt-6 max-w-2xl text-ink-muted">
              Only three files ever cross between the two columns, and you
              carry each one yourself:{" "}
              <span className="code">answer.toml</span> and{" "}
              <span className="code">homelab.zip</span> out to the machines,{" "}
              <span className="code">inventory.json</span> back.
            </p>
          </div>
        </section>

        {/* The one rule */}
        <section className="border-t border-border">
          <div className="mx-auto max-w-5xl px-6 py-14">
            <h2 className="label text-brand">the one rule underneath all of it</h2>
            <div className="pc-callout pc-callout--success mt-6">
              <span className="code pc-callout__glyph">!</span>
              <div className="pc-callout__body">
                <p className="body pc-callout__title">
                  The wizard never names a device. Ansible never invents intent.
                </p>
                <p className="body pc-callout__text text-ink-muted">
                  You tell the browser what you <em>want</em> — a two-port
                  lacp bond for vm traffic, a mirrored nvme pool, ceph on the
                  10gbe pair. Your machines report what they <em>are</em> —
                  macs, <span className="code">/dev/disk/by-id</span> paths,
                  serials. Those are different kinds of fact, discovered at
                  different times, and step 04 is the single place they meet.
                </p>
              </div>
            </div>
            <p className="body mt-6 max-w-2xl text-ink-muted">
              This matters because the identifiers you could type into a form
              are exactly the unstable ones.{" "}
              <span className="code">enp3s0</span> comes from the pci path, so
              it moves when the card does.{" "}
              <span className="code">/dev/sda</span> is assignment order, not
              an identity at all. Asking you to transcribe either into a web
              form would mean a typo can wipe the wrong disk.
            </p>
            <p className="body mt-4 max-w-2xl text-ink-muted">
              One exception, because the installer needs it before anything
              else runs: the boot disk. The wizard&apos;s last step asks for
              it only after you&apos;ve booted that machine and read the name
              off <span className="code">lsblk</span>, takes nothing but a
              whole disk, warns when the name doesn&apos;t fit the disk type
              you declared, and leaves a node you skip unable to install
              rather than guessing.
            </p>
          </div>
        </section>

        {/* The pipeline diagram */}
        <section className="border-t border-border">
          <div className="mx-auto max-w-5xl px-6 py-14">
            <h2 className="label text-brand">the shape of it</h2>
            <p className="body mt-4 max-w-2xl text-ink-muted">
              Seven phases, two lanes. The left lane never touches your
              hardware; the right lane is every command you run yourself.
              Drag a card, or pan the canvas.
            </p>

            <div className="mt-8">
              <PipelineCanvas />
            </div>

            <div className="pc-legend mt-4">
              {LEGEND.map((item) => (
                <div key={item.kind} className="pc-legend__item">
                  <span className={`pc-legend__line pc-legend__line--${item.kind}`} aria-hidden="true" />
                  <div className="pc-legend__text">
                    <span className="meta pc-legend__label">{item.label}</span>
                    <span className="meta pc-legend__hint">{item.hint}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* What comes out */}
        <section className="border-t border-border">
          <div className="mx-auto max-w-5xl px-6 py-14">
            <h2 className="label text-brand">what step 05 actually hands you</h2>
            <p className="body mt-4 max-w-2xl text-ink-muted">
              A directory you can <span className="code">git init</span> and
              keep. Two details in here do most of the work:{" "}
              <span className="code">.wizard/state.json</span>, which is what
              makes the pipeline a loop, and{" "}
              <span className="code">*.local.yml</span>, which is where your
              own edits live so regenerating can never clobber them.
            </p>

            <div className="pc-terminal mt-6">
              <div className="pc-terminal__bar">
                <span className="meta pc-terminal__host">homelab.zip</span>
                <span className="meta pc-terminal__status">unpacked</span>
              </div>
              <div className="pc-terminal__body">
                <RepoTree root={REPO_TREE} />
              </div>
            </div>
          </div>
        </section>

        {/* Phase order */}
        <section className="border-t border-border">
          <div className="mx-auto max-w-5xl px-6 py-14">
            <h2 className="label text-brand">inside site.yml — the order is load-bearing</h2>
            <p className="body mt-4 max-w-2xl text-ink-muted">
              Every band is tagged, so{" "}
              <span className="code">--tags network</span> re-runs exactly one
              of them. Every band is idempotent, so running the whole thing
              again is a no-op — which is what makes{" "}
              <span className="code">--check</span> a drift report rather than
              a dry run you have to interpret.
            </p>

            <div className="pc-table-wrap pc-table-wrap--wrap mt-6">
              <table className="pc-table pc-table--wrap">
                <thead>
                  <tr>
                    <th>tag</th>
                    <th>does</th>
                    <th>why it sits here</th>
                  </tr>
                </thead>
                <tbody>
                  {PHASE_ORDER.map((band) => (
                    <tr key={band.tag}>
                      <td className="code text-brand">{band.tag}</td>
                      <td className="body-sm">{band.does}</td>
                      <td className="body-sm text-ink-muted">{band.why}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>

        {/* The dangerous bands */}
        <section className="border-t border-border">
          <div className="mx-auto max-w-5xl px-6 py-14">
            <h2 className="label text-brand">the two bands that can actually hurt you</h2>

            <div className="mt-6 flex flex-col" style={{ gap: "var(--space-4)" }}>
              <div className="pc-callout pc-callout--warning">
                <span className="code pc-callout__glyph">⚠</span>
                <div className="pc-callout__body">
                  <p className="body pc-callout__title">
                    network reconfigures the link you&apos;re connected over
                  </p>
                  <p className="body pc-callout__text text-ink-muted">
                    So it never applies without a dead man&apos;s switch. The
                    old config is copied, a timer is armed to restore it in
                    five minutes, and only then does{" "}
                    <span className="code">ifreload -a</span> run. Reconnect
                    and the timer is canceled; get it wrong and the node
                    heals itself while you go make coffee — instead of you
                    driving to wherever it lives.
                  </p>
                </div>
              </div>

              <div className="pc-callout pc-callout--danger">
                <span className="code pc-callout__glyph">✗</span>
                <div className="pc-callout__body">
                  <p className="body pc-callout__title">
                    storage creates osds, and creating an osd wipes a disk
                  </p>
                  <p className="body pc-callout__text text-ink-muted">
                    Three gates, every time: the device is addressed by its{" "}
                    <span className="code">by-id</span> path and never{" "}
                    <span className="code">/dev/sdX</span>; the play asserts
                    the serial at that path still matches the one you
                    confirmed in step 04; and the boot disk sits in an
                    exclusion list every destructive task consults. Wiping the
                    wrong disk is the one failure here that loses data you
                    can&apos;t get back.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Day two */}
        <section className="border-t border-border">
          <div className="mx-auto max-w-5xl px-6 py-14">
            <h2 className="label text-brand">day two, which is where this earns its keep</h2>
            <p className="body mt-4 max-w-2xl text-ink-muted">
              Anyone can get a cluster running once. The reason to have a repo
              is the eighteen months after that.
            </p>

            <div className="mt-8 flex flex-col" style={{ gap: "var(--space-6)" }}>
              <div>
                <p className="h3">drift, for free</p>
                <p className="body mt-2 max-w-2xl text-ink-muted">
                  Because every band is idempotent,{" "}
                  <span className="code">--check --diff</span> is a list of
                  every change someone made by hand in the web ui and forgot
                  about. Put it on a weekly cron and it&apos;s an audit log.
                </p>
                <div className="pc-cmdline mt-3">
                  <span className="code pc-cmdline__prompt">$</span>
                  <span className="code pc-cmdline__text">ansible-playbook site.yml --check --diff</span>
                </div>
              </div>

              <div>
                <p className="h3">rolling minor upgrades</p>
                <p className="body mt-2 max-w-2xl text-ink-muted">
                  <span className="code">upgrade.yml</span> runs at{" "}
                  <span className="code">serial: 1</span> and refuses to start
                  the next node until health comes back green — the loop most
                  people otherwise do by hand at one in the morning.
                </p>
                <div className="pc-terminal mt-3">
                  <div className="pc-terminal__bar">
                    <span className="meta pc-terminal__host">upgrade.yml — per node</span>
                    <span className="meta pc-terminal__status">serial: 1</span>
                  </div>
                  <div className="pc-terminal__body">
                    <pre className="code pc-terminal__out">{`wait for HEALTH_OK  →  set noout  →  node into maintenance
     (guests migrate off)  →  apt dist-upgrade  →  reboot
  →  wait for the node  →  leave maintenance  →  unset noout
  →  wait for HEALTH_OK  →  only now, the next node`}</pre>
                  </div>
                </div>
              </div>

              <div>
                <p className="h3">major upgrades stay human</p>
                <p className="body mt-2 max-w-2xl text-ink-muted">
                  The playbook runs the official pre-upgrade checker, collects
                  what it says, prints it — and stops. A major version jump is
                  not something to automate end to end, and pretending
                  otherwise would make the rest of this less trustworthy, not
                  more.
                </p>
              </div>

              <div>
                <p className="h3">adding a node is the same pipeline</p>
                <p className="body mt-2 max-w-2xl text-ink-muted">
                  Drop <span className="code">wizard.json</span> back on the
                  site, change the node count from three to four, regenerate,
                  and diff. Run the new host through{" "}
                  <span className="code">
                    --limit pve04 --tags preflight,base,network
                  </span>
                  , then the join play. No new concepts — you&apos;ve just
                  gone round the loop again.
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* CTA */}
        <section className="border-t border-border">
          <div className="mx-auto max-w-5xl px-6 py-14">
            <div className="flex flex-wrap items-center gap-5">
              <Link href="/setup" className="pc-btn pc-btn--primary">
                <span className="pc-btn__bracket">[</span>
                start at step 01
                <span className="pc-btn__bracket">]</span>
              </Link>
              <Link href="/" className="pc-btn pc-btn--ghost">
                ← back to the front page
              </Link>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-border">
        <div className="mx-auto flex max-w-5xl flex-col items-center gap-1 px-6 py-8 text-center">
          <span className="text-sm font-semibold tracking-tight">
            proxmox<span className="text-accent">.computer</span>
          </span>
          <span className="meta text-ink-muted">
            an independent, community-run project — not a company. not
            affiliated with proxmox server solutions gmbh.
          </span>
        </div>
      </footer>
    </div>
  );
}
