# proxmox.computer — agent guide

A static, client-only Next.js app (`output: "export"`, `trailingSlash: true`). There is no server, no API routes, no account: all state lives in the visitor's `localStorage`, encrypted with a passphrase they choose. Never add anything that needs a runtime server or sends user data anywhere.

## Priorities, in order

1. **Wizard stability.** The setup wizard (`src/app/setup/`) is the product. A change that breaks restoring a saved state, advancing a step, or rendering a preview is a release blocker, whatever else it improves.
2. **Tests with every change.** See "Every change ships with tests" below. It is not optional and there are no exceptions.
3. Everything else.

## Every change ships with tests

**Each change you make comes with tests in the same piece of work.** This applies to features, fixes, copy changes that alter a hint's trigger, refactors and "tiny" tweaks alike. Work without tests is not done.

- **New or changed logic** (anything in a pure module: `validation`, `derive`, `hints`, `storage`, `cpu`, a preview builder): add or update **unit tests** covering the happy path, the boundaries, and, for a hint, both the case where it fires and the case where it stays quiet.
- **New or changed wizard behavior** (anything a visitor can see or do in `page.tsx` or a preview): add or update **integration tests** in `page.test.tsx` that drive it through the UI.
- **A bug fix** starts with a test that reproduces the bug and fails, then the fix that makes it pass. Keep the test; it's what stops the bug coming back.
- **Removing a feature** removes its tests too, and adds a test that it's gone if a visitor could still expect it (e.g. "doesn't ask where isos live").
- **A test that fails intermittently is a failing test.** Fix the cause (usually timing: wait on a condition, never a fixed sleep) rather than rerunning until green.
- When a test fails, decide whether the test or the code is wrong before changing either. Don't edit an assertion just to make it pass.

Before calling work done, run `npm test`, `npx tsc --noEmit` and `npm run lint` and report the actual results.

## Commands

```
npm test          # vitest run — all unit + integration tests
npm run test:watch
npx tsc --noEmit  # typecheck (includes test files)
npm run lint
npx vitest run --coverage   # find untested code; new code should not lower coverage
npm run dev       # don't kill a dev server you didn't start — the user may be running one
cd tofu && tofu fmt -recursive && tofu init -backend=false && tofu validate && tofu test
                  # infra changes: same for tofu/bootstrap; tests plan against mocked providers
```

**The site is served with a strict CSP** (`tofu/cloudfront.tf`): `connect-src 'self'`, nothing loaded from another origin. A change that adds an external font, script or request is blocked in production even though it works in `npm run dev`; it has to go into the CSP too, or better, not be added.

All three of `npm test`, `npx tsc --noEmit` and `npm run lint` must be clean before work is called done. Report failures as they are; don't stop at "should pass".

## Layout

```
src/app/setup/
  page.tsx          the wizard — React components and state only
  wizard-state.ts   data model, PersistedState, STEP_VERSIONS / STEP_SECTIONS (which
                    fields each step saves, and its shape check), STORAGE_VERSION
  saved-state.ts    load/save/persistCurrentStep; restoreSaved() keeps a save up to its
                    first stale step and starts that step and the rest over; freshState()
  validation.ts     field validators: pure, return null | message
  derive.ts         defaults, address derivation, conflicts, cross-node sync
  hints.ts          advisories (Hint = { tone, glyph, text }); never block progress
  location.ts       step 1 logic: country, keyboard, timezone — options, browser detection
  storage.ts        step 4 logic: disk roles, capacity maths, storage hints
  backups.ts        step 5 logic: targets, retention, validators, backup hints
  access.ts         step 6 logic: ssh key parsing/validation, root passwords, oidc, hints
  software.ts       step 7 logic: guests (vms/containers) in proxmox's create-dialog detail
                    — disks and nics as lists, the storage/bridges/cpu types/ha each node
                    offers them, normalizeGuest() re-checking every edit, capacity hints;
                    images (and which take cloud-init) in src/data/guest-images.json
  kubernetes.ts     step 7's kubernetes planner: control planes / workers / placement
                    (shared or separate nodes) → talos vms marked with a k8sRole — never
                    ha, disks node-local, cpu type host; persistent volumes on ceph
                    (ceph-csi) through effectiveCephVolumes(); drawn by kubernetes-panel.tsx
  guest-card.tsx    step 7's per-guest editor: essentials open, proxmox's "advanced"
                    options in collapsed sections
  form-fields.tsx   fields the steps share (CidrField, CheckedTextField, Select, Check) and
                    RevealErrorsContext — kept out of page.tsx so other modules can use them
  answer-files-panel.tsx  step 8's downloads (async: hashes + sealed setup)
  boot-disk.ts      step 8's one question: each node's boot disk by its lsblk name (one
                    while identicalHardware), validateBootDiskName, bootDiskFor(),
                    answerBootDisk() — what the answer file gets, or null (placeholder)
  install.ts        step 8's install guide logic: proxmox ve 9.2 iso + sha256, lsblk
                    clues per node, validate/prepare-iso commands, web ui urls
  install-guide.tsx step 8's six-part guide: iso → find disk → name it → download →
                    build iso → boot
  capacity.ts       memory / disk meters per node and pool: proxmox, ceph, zfs overhead
                    (documented defaults, labeled as estimates) + guests; drawn by
                    meter-bar.tsx in --meter-* colors (palette-validated) — full in the
                    step 7 preview, `compact` (room left, in guest terms) in the form
  step-checks.ts    per-step blocking problems; problemsUpTo(step) gates every hand-off
  vault.ts          the encrypted store: PBKDF2 → AES-GCM envelopes, the in-memory session key
  vault-gate.tsx    the passphrase prompt (create / unlock / start over) in front of every page
  password-hash.ts  sha-512-crypt ($6$) on WebCrypto, for root-password-hashed
  cpu.ts            cpu family catalog and qemu type resolution; cpuTypeOptions() — the
                    guest cpu types every given host can run (cpu_types in the data), and
                    clusterCpuBaseline(), the default a guest follows
  answer-file.ts    each node's answer.toml for the unattended installer (proxmox ve 9.2);
                    names only the boot disk typed in step 8, else CHANGE-ME; root password only as a $6$
                    hash; embeds the sealed setup as one comment line, which
                    readAnswerToml() + openAnswerSetup() read back; src/app/open-setup.tsx
                    reopens it after asking for the file's passphrase
  test-fixtures.ts  node(), cluster(), nics(), disks(), bridge(), bond(), network(),
                    backupPlan(), accessPlan(), persistedState() — a complete valid save;
                    ED25519_KEY / RSA_KEY are real public keys
  wizard-test-helpers.tsx  renderAtHardwareStep (a fresh wizard opens on location) /
                    renderAtNetworkStep / renderAtStorageStep /
                    renderAtBackupsStep (slow; prefer restoring a save), waitForSave,
                    addSpareDisk / addTwoSpareDisks, clusterStorage — shared by the
                    wizard integration tests
  preview/<step>/   one React Flow diagram per step; a pure builder
                    (topology.ts / plan.ts) plus components that only render
src/app/how-it-works/   explainer page; pipeline.ts is its diagram data
src/data/               static json (steps, cpu families, nic speeds)
src/test/setup.ts       jsdom polyfills, next/navigation mock, localStorage reset
src/test/router.ts      the router spy every component sees — assert router.push(...)
tofu/                   the hosting: private S3 + CloudFront (https, security headers, csp)
                        + Cloudflare dns; bootstrap/ makes the state bucket and deploy role.
                        functions/viewer-request.js maps /route/ → /route/index.html.
                        see tofu/README.md
.github/workflows/deploy.yml  test + build on every push/pr; apply, upload, invalidate on main
```

**Reserved file names.** Inside `src/app/`, `page`, `layout`, `loading`, `error`, `not-found`, `template`, `route` and `default` (any extension) are Next.js route files. Never name a helper module one of them: a `layout.ts` next to a preview page silently becomes that route's layout. Page files export only their default component plus Next's own named exports (`metadata`, …), so put anything else in its own module.

**Rule: logic doesn't live in components.** Anything computable from state goes in a pure module (`validation`, `derive`, `hints`, `storage`, or a preview builder) and is unit-tested there. `page.tsx` wires state to UI and nothing more. Don't add non-component exports to `page.tsx`.

## Wizard invariants

- **Encryption at rest.** The state holds root passwords and an OIDC secret, so it is never stored in the clear: `savePersistedState` / `loadPersistedState` / `persistCurrentStep` go through `vault.ts` and are async. The key is derived from the visitor's passphrase and lives in memory only (it survives client-side navigation, not a reload). Every page that reads the state sits behind `<VaultGate>`. Answer files carry the same sealed envelope, never a plain state, and root passwords only as `$6$` hashes. Never log, render or embed a secret anywhere but its own field.
- **Persistence.** `PersistedState` is saved with a debounced (300 ms) autosave and restored by `restoreSaved` on load. **Every step has its own version in `STEP_VERSIONS`: any change to the shape of what a step saves must bump that step's version** and extend its check in `STEP_SECTIONS` (the comment above it says which fields belong to which step — disk roles are step 4's, each node's network step 3's). On load, a save is kept up to its first step with another version (or a failed check); that step and every later one start over from `freshState()`, the visitor is sent back to it and told so. Nothing is migrated or half-applied within a step. `STORAGE_VERSION` covers only the save's layout (which fields belong to which step): bump it when that changes, and a save is discarded wholesale.
- **Hydration.** `localStorage` is only read after mount (`hydrated` flag). Never read it during render, and never let the autosave run before hydration.
- **Step hand-off.** No step advances directly. Each step's "preview" button routes to `/setup/preview/<step>`; that page's "next" awaits `persistCurrentStep(next)`, then calls `router.push("/setup")`, and the wizard restores on the new step. New steps follow the same pattern: add the id to `WizardStepId`, `wizard-steps.json`, `isPersistedState` and `STEP_ORDER`. Three exceptions, all through the same `problemsUpTo` gate (`tryNext`): step 1, location, has nothing to draw, so its "next" goes straight to hardware; step 7, software, is optional, so with no guests it shows "skip" to step 8 instead of "preview"; step 8, install, is the end — no preview: it asks each node's boot disk and offers the answer-file downloads once steps 1–8 have no problems. Copy refers to steps by number ("add a disk in step 2"), so inserting a step means renumbering those too.
- **Identical-across-nodes modes** (`identicalHardware`, `identicalNetwork`, `identicalStorage`) copy *structure* only. Per-node identity (hostname, host IPs, disk sizes/names) is never overwritten.
- **Effective vs chosen.** Several choices are stored as the visitor made them and *read* through an effective-value function that clamps them to what the current nodes and disks allow, without discarding the choice. Always read the effective one:
  - `clusterStorage` → `effectiveClusterStorage()`. Ceph and zfs are independent switches, and both at once need 2 spare disks per node. When only one fits, ceph wins.
  - disk roles → `withEffectiveDiskRoles()`. `""` means unchosen; that and a role that's no longer offered both resolve to the first enabled mode, or `local`.
  - ceph replicas → `effectiveCephPlan()`; the zfs layout → `effectiveRaidLevel()`; a NIC's connector → `effectivePort()`.
  - Never write a clamped value back from an effect. The wizard starts at one node, so a write-back clamp permanently destroys defaults and choices.
- **Ceph and zfs traffic never get a bridge.** On any interface but management, ceph/zfs make the interface's native slot a *storage link* (`isStorageLink`): the host IP goes directly on the NIC or bond, it carries only storage purposes, and it has no extra VLAN bridges. The slot still lives in `bridges` (its `name` is kept for switching back but never used or name-checked). `enforceStorageLinks()` holds a network to these rules after every bridge edit. The management bridge may still share ceph/zfs, since it exists for the web UI anyway.
- **Static IPs carry their network's prefix** (`10.0.10.11/24`: address .11 in the 10.0.10.0/24 network), exactly as Proxmox and `/etc/network/interfaces` write it. Never propose /32: it leaves the node alone on its link, with no route to its gateway or its peers. `hostCidrMeaning()` spells the value out under every static-IP field and flags a /32.
- **Don't allow invalid input where the valid set is known.** Offer only valid options (e.g. `replicaChoices(nodeCount)`) instead of accepting any value and warning afterwards. Hints are for choices that are valid but unwise.
- **Effects must not loop.** An effect that calls `setNodes` re-runs whenever its dependencies change, so it needs reference-stable dependencies (memoize arrays on their primitive inputs, not on a freshly built object), and a transform that returns the *same* array when nothing changed (see `withoutPurposes`). Getting either wrong renders forever, which in tests shows up as a suite that hangs rather than fails.
- **Intent, never device identity.** The wizard records roles, speeds and sizes. It never asks for `enp3s0`, `/dev/sdX` or MACs. Those come from the machines in a later phase (see `/how-it-works`). The one exception is step 8's boot disk (`boot-disk.ts`), because the installer needs it first: asked last, after the guide has the visitor read it off `lsblk` on that machine; only whole-disk names accepted; a mismatch with the declared disk type warns; left empty, the file keeps `CHANGE-ME` so the install stops rather than guesses. Don't widen the exception.
- Validators return `null` when valid, and an empty value is usually "not answered yet" rather than an error. Hints advise and never block.

## Testing

Vitest + Testing Library + jsdom. Tests sit next to their source as `*.test.ts(x)`.

**Unit tests** cover every exported function in the pure modules: the happy path, the boundaries (0, 1, max, max+1), and each hint's quiet case as well as its firing case. Build inputs with `test-fixtures.ts` so each test states only the fields it cares about. When the model gains a field, update the fixtures first.

**Integration tests** drive the real UI: `setup/page.test.tsx` (step flow, persistence, advisories), `setup/wizard-editing.test.tsx` (every editable control), `setup/preview/previews.test.tsx` (each preview route from a saved state, and its hand-off), and page tests for `how-it-works` and the landing page. Put a new test in the file whose job it matches, and use the shared helpers rather than re-deriving them. There's no mocked component state and no reaching into internals. Patterns that are known to matter:

- Reach step N the way the app does, with `renderAtNetworkStep()` / `renderAtStorageStep()`: fill the earlier steps in, call `persistCurrentStep`, remount. There's no in-page "continue" button to click. To start at a later step, `await savePersistedState(persistedState({ currentStep: ... }))` and render.
- **Every test starts unlocked** (`src/test/setup.ts` starts a vault session with a cheap KDF). Tests of the passphrase prompt call `lock()` first. Never write `localStorage` directly to plant a state: it has to be sealed, so use `savePersistedState` (from `saved-state.ts`), and read with `await saved()` / `loadPersistedState()`. To plant an older build's save, give it a `stepVersions` with one step lowered.
- Wait for the debounced save with `waitForSave(predicate)`. Before a hand-off, wait for localStorage to *change*: a "some state exists" check passes instantly and hands off a stale state.
- Prefer `getByRole(..., { name })` with an anchored regex (`/^ceph osd/`). Labels contain hint text, so unanchored names collide (for example, "zfs with replication" appears inside the ceph warning).
- Per-node UI renders once per node. Use `getAll*` and assert the count, or scope with `within(...)`.
- Clicking re-renders, so re-query elements after each click rather than iterating over a stale list.
- Ceph/zfs options only appear once every node has a disk beyond boot: use `addSpareDisk`.
- Radio/checkbox labels that contain extra elements (such as a ⚠ span) split their text nodes. Assert with `toHaveTextContent` on the label, not `getByText`.
- Number fields that must stay valid (bridge and bond counts) use `useDraftCount`: typing shows a draft, only valid values commit, and leaving an invalid draft snaps back. Test count fields by clearing and retyping — that's how the "12 bridges" bug was found.

React Flow does mount its node cards in jsdom (unmeasured), so card *content* is testable: render the preview route from `persistedState()` and assert what's drawn. Geometry (straight cables, alignment) isn't, so check those in a real browser. Test preview logic itself through its pure builder (`topology.ts`, `plan.ts`, `pipeline.ts`).

When checking the app in a browser, never overwrite the visitor's saved state without backing it up first: copy it to a separate key, load test data, and restore it afterwards.

## UI conventions

- Styling uses the `pc-` BEM classes in `src/app/globals.css`, on CSS custom-property tokens that have light and dark values. Use tokens, never raw colors. Check both themes.
- `globals.css` is unlayered, so its rules beat Tailwind utilities. Don't put `mt-*` on an element whose `pc-` class sets `margin`; wrap it in a `div` instead.
- React Flow previews: node cards and their counterpart port rows share a width/gap contract (`--netcard-*`, `--storcard-*` in CSS mirrored by `CARD_WIDTH`/`GAP` constants), which keeps cables straight. Change both sides together. Card heights are unknown until measured, so re-fit or re-position after `useNodesInitialized()`.
- Don't use box-drawing characters for trees or lines. They misalign across the monospace fallback fonts, so draw with CSS borders (see `how-it-works/repo-tree.tsx`).
- Links use `/setup`-style paths without a trailing slash; `trailingSlash` adds it at export.
- Copy is lowercase, terse, and explains *why* in the hint rather than only stating the rule.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->