import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  // CI runs 27+ specs sequentially against one shared webServer + Firestore
  // emulator on a 2-core runner — an occasional page-load hiccup under that
  // contention shows up as a single spec blowing the 30s test timeout with
  // no code-level cause (see the countries.spec.ts flake this addresses).
  // A retry re-runs only the failed spec and is reported as "flaky" rather
  // than silently green, so a genuine regression still fails after 3 tries.
  retries: process.env.CI ? 2 : 0,
  reporter: 'list',
  globalSetup: './e2e/global-setup.ts',
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'retain-on-failure',
  },
  webServer: {
    // Offline behavior (T-09) depends on the real service worker (T-04),
    // which only exists in the production build, not the `vite dev` server.
    command: 'npm run build && npx vite preview --port 5173 --strictPort',
    url: 'http://localhost:5173',
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: process.env.PLAYWRIGHT_CHROMIUM_PATH
          ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH }
          : {},
      },
    },
  ],
})
