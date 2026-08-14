import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // These are integration tests sharing one external Firestore emulator
    // project; running files in parallel causes cross-file races (e.g. one
    // file's clearFirestore() wiping another file's in-flight data).
    fileParallelism: false,
    // Overpass is the one external source that needs no credentials, so
    // unlike Claude and Places it will happily answer a unit test from any
    // machine with a working network — which is exactly what happened once
    // we started identifying ourselves and it stopped returning 406 to
    // everything. generatePlan.checkpoint's full-generation test then blew
    // its 5s timeout on a real OSM round trip, on CI and on any developer
    // machine that isn't behind a blocking proxy. Tests don't call third
    // parties: off here, so the suite is the same everywhere.
    env: { OVERPASS_DISABLED: '1' },
  },
})
