# proxmox.computer — agent guide

A static, client-only Next.js app (`output: "export"`, `trailingSlash: true`). There is no server, no API routes, no account: all state lives in the visitor's `localStorage`. Never add anything that needs a runtime server or sends user data anywhere.

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
```

All three of `npm test`, `npx tsc --noEmit` and `npm run lint` must be clean before work is called done. Report failures as they are; don't stop at "should pass".

## Layout

```
src/app/setup/
  page.tsx          the wizard — React components and state only
  wizard-state.ts   data model, PersistedState, load/persist, STORAGE_VERSION
  validation.ts     field validators: pure, return null | message
  derive.ts         defaults, address derivation, conflicts, cross-node sync
  hints.ts          advisories (Hint = { tone, glyph, text }); never block progress
  storage.ts        step 3 logic: disk roles, capacity maths, storage hints
  cpu.ts            cpu family catalog and qemu type resolution
  test-fixtures.ts  node(), cluster(), nics(), disks(), bridge(), bond(), network(),
                    persistedState() — a complete valid save
  wizard-test-helpers.tsx  renderAtNetworkStep / renderAtStorageStep, waitForSave,
                    addSpareDisk / addTwoSpareDisks, clusterStorage — shared by the
                    wizard integration tests
  preview/<step>/   one React Flow diagram per step; a pure builder
                    (topology.ts / plan.ts) plus components that only render
src/app/how-it-works/   explainer page; pipeline.ts is its diagram data
src/data/               static json (steps, cpu families, nic speeds)
src/test/setup.ts       jsdom polyfills, next/navigation mock, localStorage reset
src/test/router.ts      the router spy every component sees — assert router.push(...)
```

**Reserved file names.** Inside `src/app/`, `page`, `layout`, `loading`, `error`, `not-found`, `template`, `route` and `default` (any extension) are Next.js route files. Never name a helper module one of them: a `layout.ts` next to a preview page silently becomes that route's layout. Page files export only their default component plus Next's own named exports (`metadata`, …), so put anything else in its own module.

**Rule: logic doesn't live in components.** Anything computable from state goes in a pure module (`validation`, `derive`, `hints`, `storage`, or a preview builder) and is unit-tested there. `page.tsx` wires state to UI and nothing more. Don't add non-component exports to `page.tsx`.

## Wizard invariants

- **Persistence.** `PersistedState` is saved with a debounced (300 ms) autosave and validated by `isPersistedState` on load. **Any change to the shape of `PersistedState` or anything nested in it must bump `STORAGE_VERSION`** and extend `isPersistedState`. A mismatched version is discarded wholesale, never migrated or half-applied.
- **Hydration.** `localStorage` is only read after mount (`hydrated` flag). Never read it during render, and never let the autosave run before hydration.
- **Step hand-off.** No step advances directly. Each step's "preview" button routes to `/setup/preview/<step>`; that page's "next" calls `persistCurrentStep(next)` then `router.push("/setup")`, and the wizard restores on the new step. New steps follow the same pattern: add the id to `WizardStepId`, `wizard-steps.json` and `isPersistedState`.
- **Identical-across-nodes modes** (`identicalHardware`, `identicalNetwork`, `identicalStorage`) copy *structure* only. Per-node identity (hostname, host IPs, disk sizes/names) is never overwritten.
- **Effective vs chosen.** Several choices are stored as the visitor made them and *read* through an effective-value function that clamps them to what the current nodes and disks allow, without discarding the choice. Always read the effective one:
  - `clusterStorage` → `effectiveClusterStorage()`. Ceph and zfs are independent switches, and both at once need 2 spare disks per node. When only one fits, ceph wins.
  - disk roles → `withEffectiveDiskRoles()`. `""` means unchosen; that and a role that's no longer offered both resolve to the first enabled mode, or `local`.
  - ceph replicas → `effectiveCephPlan()`; the zfs layout → `effectiveRaidLevel()`; a NIC's connector → `effectivePort()`.
  - Never write a clamped value back from an effect. The wizard starts at one node, so a write-back clamp permanently destroys defaults and choices.
- **Don't allow invalid input where the valid set is known.** Offer only valid options (e.g. `replicaChoices(nodeCount)`) instead of accepting any value and warning afterwards. Hints are for choices that are valid but unwise.
- **Effects must not loop.** An effect that calls `setNodes` re-runs whenever its dependencies change, so it needs reference-stable dependencies (memoize arrays on their primitive inputs, not on a freshly built object), and a transform that returns the *same* array when nothing changed (see `withoutPurposes`). Getting either wrong renders forever, which in tests shows up as a suite that hangs rather than fails.
- **Intent, never device identity.** The wizard records roles, speeds and sizes. It never asks for `enp3s0`, `/dev/sdX` or MACs. Those come from the machines in a later phase (see `/how-it-works`).
- Validators return `null` when valid, and an empty value is usually "not answered yet" rather than an error. Hints advise and never block.

## Testing

Vitest + Testing Library + jsdom. Tests sit next to their source as `*.test.ts(x)`.

**Unit tests** cover every exported function in the pure modules: the happy path, the boundaries (0, 1, max, max+1), and each hint's quiet case as well as its firing case. Build inputs with `test-fixtures.ts` so each test states only the fields it cares about. When the model gains a field, update the fixtures first.

**Integration tests** drive the real UI: `setup/page.test.tsx` (step flow, persistence, advisories), `setup/wizard-editing.test.tsx` (every editable control), `setup/preview/previews.test.tsx` (each preview route from a saved state, and its hand-off), and page tests for `how-it-works` and the landing page. Put a new test in the file whose job it matches, and use the shared helpers rather than re-deriving them. There's no mocked component state and no reaching into internals. Patterns that are known to matter:

- Reach step N the way the app does, with `renderAtNetworkStep()` / `renderAtStorageStep()`: fill the earlier steps in, call `persistCurrentStep`, remount. There's no in-page "continue" button to click.
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