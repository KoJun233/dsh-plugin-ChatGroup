import { rm } from 'node:fs/promises'

// Removed source modules must not survive in a subsequent package build.
await rm(new URL('../dist/', import.meta.url), { recursive: true, force: true })
