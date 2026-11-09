import { build } from 'esbuild'
await build({ entryPoints: [new URL('../src/client-ui.js', import.meta.url).pathname],
  outfile: new URL('../dist/client-ui.js', import.meta.url).pathname,
  bundle: true, format: 'iife', platform: 'browser', target: 'chrome120',
  loader: { '.css': 'text' }, minify: true,
})
