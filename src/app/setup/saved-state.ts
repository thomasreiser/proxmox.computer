// The saved setup: reading it back, step by step, and writing it. Each step
// carries its own version (STEP_VERSIONS in wizard-state.ts), so a build that
// changes step 5 keeps steps 1–4 of a save and starts 5 onwards over — later
// steps build on earlier ones, so none after a stale step is kept either.
//
// Lives apart from wizard-state.ts because starting a step over needs every
// step's defaults, and those modules import wizard-state themselves.

import { defaultAccessPlan } from "./access";
import { defaultBackupPlan } from "./backups";
import { defaultNode, defaultNodeNetwork, defaultStoragePlan, deriveGateway } from "./derive";
import { defaultLocation } from "./location";
import { defaultSoftwarePlan } from "./software";
import { readStored, writeStored } from "./vault";
import {
  SAVED_STEPS,
  STEP_VERSIONS,
  STORAGE_VERSION,
  firstStaleStep,
  isSaveLayout,
  type NodeInfo,
  type PersistedState,
  type SavedStepId,
  type WizardStepId,
} from "./wizard-state";

const DEFAULT_CIDR = "10.0.10.0/24";

/** a setup nobody has touched — what the wizard opens on, and what a stale step starts over from */
export function freshState(): PersistedState {
  return {
    version: STORAGE_VERSION,
    stepVersions: { ...STEP_VERSIONS },
    currentStep: "location",
    location: defaultLocation(),
    nodeCount: "1",
    hostnameSuffix: "homelab.lan",
    globalCidr: DEFAULT_CIDR,
    gateway: deriveGateway(DEFAULT_CIDR),
    dns: deriveGateway(DEFAULT_CIDR),
    homelabVlan: "",
    nodes: [defaultNode(0, DEFAULT_CIDR)],
    identicalHardware: false,
    identicalNetwork: false,
    clusterStorage: { ceph: true, zfs: false },
    storage: defaultStoragePlan(),
    identicalStorage: false,
    backups: defaultBackupPlan(),
    access: defaultAccessPlan(),
    software: defaultSoftwarePlan(),
  };
}

const ORDER: WizardStepId[] = [...SAVED_STEPS, "install"];
const before = (a: WizardStepId, b: WizardStepId) => ORDER.indexOf(a) < ORDER.indexOf(b);

/**
 * The save with `from` and every step after it back at their defaults.
 * Every step before `from` has passed its check, so it's read as it is.
 */
export function startOverFrom(saved: PersistedState, from: SavedStepId): PersistedState {
  const fresh = freshState();
  const keep = (step: SavedStepId) => before(step, from);
  const network = keep("network");
  const globalCidr = network ? saved.globalCidr : fresh.globalCidr;
  const nodes: NodeInfo[] = keep("hardware")
    ? saved.nodes.map((node, i) => ({
        ...node,
        network: network ? node.network : defaultNodeNetwork(node.name, node.nics.length, globalCidr, i),
        additionalDisks: keep("storage") ? node.additionalDisks : node.additionalDisks.map((d) => ({ ...d, role: "" as const })),
      }))
    : fresh.nodes;
  return {
    ...fresh,
    // the visitor can't be further along than the first step that's changed
    currentStep: before(saved.currentStep, from) ? saved.currentStep : from,
    location: keep("location") ? saved.location : fresh.location,
    ...(keep("hardware") && { nodeCount: saved.nodeCount, identicalHardware: saved.identicalHardware }),
    nodes,
    ...(network && {
      hostnameSuffix: saved.hostnameSuffix,
      globalCidr: saved.globalCidr,
      gateway: saved.gateway,
      dns: saved.dns,
      homelabVlan: saved.homelabVlan,
      identicalNetwork: saved.identicalNetwork,
    }),
    ...(keep("storage") && {
      clusterStorage: saved.clusterStorage,
      storage: saved.storage,
      identicalStorage: saved.identicalStorage,
    }),
    backups: keep("backups") ? saved.backups : fresh.backups,
    access: keep("access") ? saved.access : fresh.access,
    software: keep("software") ? saved.software : fresh.software,
  };
}

export interface Restored {
  state: PersistedState;
  // the first step that started over — null when the save was kept whole
  startedOverFrom: SavedStepId | null;
}

/**
 * A save read back as far as this build can take it: whole when every
 * step is current, from the first stale step on at defaults otherwise.
 * Null when it's not a save in this build's layout at all.
 */
export function restoreSaved(value: unknown): Restored | null {
  if (!isSaveLayout(value)) return null;
  const stale = firstStaleStep(value);
  // past the check: every step before `stale` has the shape it should
  const saved = value as unknown as PersistedState;
  if (!stale) return { state: saved, startedOverFrom: null };
  return { state: startOverFrom(saved, stale), startedOverFrom: stale };
}

/** what the visitor is told when a save came back only in part */
export function startedOverNotice(from: SavedStepId): string {
  const n = SAVED_STEPS.indexOf(from) + 1;
  const kept = n === 1 ? "" : n === 2 ? " step 1 is kept." : ` steps 1–${n - 1} are kept.`;
  return `step ${n}, ${from}, has changed since this setup was saved — it and the steps after it start over.${kept}`;
}

// The saved state lives encrypted (see vault.ts): reading and writing it
// needs the session key, so these are async, and they quietly do nothing
// while the vault is locked — the pages ask to unlock first.

/** the saved setup, decrypted and restored — null if nothing's saved, locked, or from another layout */
export async function loadSaved(): Promise<Restored | null> {
  return restoreSaved(await readStored());
}

/** the saved setup, as far as this build can take it */
export async function loadPersistedState(): Promise<PersistedState | null> {
  return (await loadSaved())?.state ?? null;
}

/** encrypts and saves the setup — false if locked or storage refuses */
export async function savePersistedState(state: PersistedState): Promise<boolean> {
  return writeStored(state);
}

/** moves the saved setup to another step — how a preview hands off to the next */
export async function persistCurrentStep(step: WizardStepId): Promise<void> {
  const saved = await loadPersistedState();
  if (saved) await savePersistedState({ ...saved, currentStep: step });
}
