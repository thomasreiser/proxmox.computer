import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";
import { router } from "./router";
import { lock, setKdfIterationsForTests, startSession } from "../app/setup/vault";

// the saved state is encrypted (see vault.ts). 600k pbkdf2 rounds per key
// would add seconds to every test that unlocks, so tests derive cheaply —
// the rounds live in each envelope, so the real code path is unchanged.
setKdfIterationsForTests(1000);

// every test starts unlocked, as a visitor is once past the passphrase
// prompt; tests of the prompt itself lock() first
beforeEach(async () => {
  await startSession("test passphrase");
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  lock();
  for (const fn of Object.values(router)) fn.mockReset();
});

// jsdom implements neither, and both are required by code under test:
// @xyflow/react measures every node through ResizeObserver, and the
// wizard's preview routes call scrollTo on navigation.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
window.scrollTo = vi.fn();

// @xyflow/react reads a node's zoom off its css transform through
// DOMMatrixReadOnly, which jsdom lacks — the stand-in its own testing
// guide recommends: only the scale (m22) is ever read.
globalThis.DOMMatrixReadOnly ??= class {
  m22: number;
  constructor(transform?: string) {
    const scale = transform?.match(/scale\(([0-9.]+)\)/)?.[1];
    this.m22 = scale !== undefined ? Number(scale) : 1;
  }
} as unknown as typeof DOMMatrixReadOnly;

// next/navigation's router only exists inside the app runtime; the wizard
// calls router.push to hand off to a preview route, so a stub is enough to
// let that path run (and be asserted on) under test.
vi.mock("next/navigation", async () => {
  const { router } = await import("./router");
  return {
    useRouter: () => router,
    usePathname: () => "/setup",
    useSearchParams: () => new URLSearchParams(),
  };
});
