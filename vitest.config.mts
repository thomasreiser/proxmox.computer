import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// No @vitejs/plugin-react here on purpose: next 16 brings its own
// (rolldown-based) vite, vitest bundles a different one, and passing a
// plugin typed against one into the other is a type error with no runtime
// meaning. Esbuild picks the jsx transform up from tsconfig's
// `"jsx": "react-jsx"` on its own, which is all these tests need — there's
// no fast refresh to wire up in a test run.
export default defineConfig({
  resolve: {
    // mirrors the "@/*" path alias in tsconfig.json — vitest doesn't read
    // tsconfig paths on its own, so the two have to be kept in step.
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    globals: true,
    // the integration tests reach step 4 the way a visitor does, through
    // steps 1–3 and two hand-offs, and each wait in them may take up to
    // SAVE_TIMEOUT (5s, wizard-test-helpers.tsx). vitest's default of 5s for
    // the whole test is less than one of those waits, so under a full
    // parallel run they timed out while the app was working. 20s fits the
    // helpers' budget and still fails a render loop or a hang.
    testTimeout: 20_000,
    // tofu/functions holds the CloudFront Function the site is served through
    include: ["src/**/*.test.{ts,tsx}", "tofu/**/*.test.ts"],
  },
});
