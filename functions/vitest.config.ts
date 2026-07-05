import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // These are integration tests sharing one external Firestore emulator
    // project; running files in parallel causes cross-file races (e.g. one
    // file's clearFirestore() wiping another file's in-flight data).
    fileParallelism: false,
  },
})
