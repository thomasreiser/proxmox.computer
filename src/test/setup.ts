import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";
import { router } from "./router";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
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
