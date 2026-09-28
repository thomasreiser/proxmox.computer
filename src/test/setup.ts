import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
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

// next/navigation's router only exists inside the app runtime; the wizard
// calls router.push to hand off to a preview route, so a stub is enough to
// let that path run (and be asserted on) under test.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
  usePathname: () => "/setup",
  useSearchParams: () => new URLSearchParams(),
}));
