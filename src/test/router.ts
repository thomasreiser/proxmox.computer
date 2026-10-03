import { vi } from "vitest";

/**
 * The one router every mounted component sees under test (see the
 * next/navigation mock in ./setup.ts), so a test can assert where a
 * button sent the visitor. Reset after every test.
 */
export const router = {
  push: vi.fn(),
  replace: vi.fn(),
  refresh: vi.fn(),
  back: vi.fn(),
};
