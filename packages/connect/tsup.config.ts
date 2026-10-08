import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  // ink/react/@napi-rs/keyring are runtime deps; leave them external (native
  // .node bindings cannot be bundled). tsup externalizes `dependencies` by
  // default — listed here for clarity/robustness.
  external: ['ink', 'react', '@napi-rs/keyring'],
});
