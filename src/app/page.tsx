import Link from "next/link";
import wizardSteps from "@/data/wizard-steps.json";

const topics = [
  { asks: "your hardware", get: "the exact install steps" },
  { asks: "network interfaces", get: "a bridge/vlan config that works" },
  { asks: "storage — zfs, disks, or ceph", get: "a ready-to-use layout" },
  { asks: "backups", get: "a pbs config, already running" },
  { asks: "software to run", get: "the vms/containers set up — say, a kubernetes cluster" },
];

const activeStepId = "hardware";

export default function Home() {
  return (
    <div className="pc-root flex min-h-full flex-col">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-4xl items-center justify-between px-6 py-5">
          <Link href="/" className="flex items-center gap-2.5">
            <span className="code flex h-7 w-7 items-center justify-center bg-accent font-bold text-on-accent">
              {">"}
            </span>
            <span className="text-[15px] font-semibold tracking-tight">
              proxmox<span className="text-accent">.computer</span>
            </span>
          </Link>
          <a href="https://github.com" className="meta text-ink-muted transition-colors hover:text-ink">
            github
          </a>
        </div>
      </header>

      <main className="flex-1">
        {/* Hero */}
        <section>
          <div className="mx-auto max-w-4xl px-6 pt-20 pb-16">
            <h1 className="h1 mt-6 text-balance">
              Answer a few questions. Get a working homelab.
            </h1>

            <p className="body mt-5 max-w-lg text-ink-muted">
              Tell proxmox.computer about your nodes, network and storage once,
              and it hands back the exact commands and config to run. You run
              them; nothing here logs into your servers.
            </p>

            <div className="mt-8 flex flex-wrap items-center gap-5">
              <Link href="/setup" className="pc-btn pc-btn--primary">
                <span className="pc-btn__bracket">[</span>
                start the setup
                <span className="pc-btn__bracket">]</span>
              </Link>
              <a href="#asks" className="pc-btn pc-btn--ghost">
                see what it asks →
              </a>
            </div>
          </div>
        </section>

        {/* No company */}
        <section className="border-t border-border">
          <div className="mx-auto max-w-4xl px-6 py-16">
            <div className="pc-callout pc-callout--info">
              <span className="code pc-callout__glyph">#</span>
              <div className="pc-callout__body">
                <p className="body pc-callout__title">all local toolset</p>
                <p className="body pc-callout__text text-ink-muted">
                  No cloud storage, no account, no login. proxmox.computer
                  generates commands — it doesn&apos;t run them. You copy,
                  you paste, you stay in control of your own machines.
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* What it asks */}
        <section id="asks" className="border-t border-border">
          <div className="mx-auto max-w-4xl px-6 py-16">
            <h2 className="label text-brand">what it asks about</h2>

            <div className="mt-6">
              <div className="pc-steps">
                {wizardSteps.map((s, i) => (
                  <div key={s.id} className={`pc-step ${s.id === activeStepId ? "pc-step--active" : ""}`}>
                    <div className="pc-step__marker">{s.id === activeStepId ? "01" : String(i + 1).padStart(2, "0")}</div>
                    <span className="label pc-step__label">{s.label}</span>
                    {i < wizardSteps.length - 1 && <div className="pc-step__connector" />}
                  </div>
                ))}
              </div>
            </div>

            <div className="pc-table-wrap mt-8">
              <table className="pc-table">
                <thead>
                  <tr>
                    <th>asks about</th>
                    <th>you get</th>
                  </tr>
                </thead>
                <tbody>
                  {topics.map((t) => (
                    <tr key={t.asks}>
                      <td className="body-sm">{t.asks}</td>
                      <td className="body-sm text-ink-muted">{t.get}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="mt-10">
              <Link href="/setup" className="pc-btn pc-btn--primary">
                <span className="pc-btn__bracket">[</span>
                start the setup
                <span className="pc-btn__bracket">]</span>
              </Link>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-border">
        <div className="mx-auto flex max-w-4xl flex-col items-center gap-1 px-6 py-8 text-center">
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
