import { defineConfig } from 'tsup'

export default defineConfig({
  entry: { index: 'index.ts', client: 'client.tsx' },
  format: ['esm'],
  platform: 'browser',
  target: 'es2022',
  outDir: 'lib',
  clean: true,
  bundle: true,
  splitting: false,
  sourcemap: true,
  dts: true,
  external: ['react'],
  esbuildOptions(options) {
    options.jsx = 'transform'
    options.jsxFactory = 'h'
    options.jsxFragment = 'React.Fragment'
  },
})
