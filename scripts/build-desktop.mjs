import { build } from 'esbuild';

await build({
  entryPoints: { main: 'src/app/main/main.ts', preload: 'src/app/preload/preload.ts' },
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'cjs',
  outdir: 'dist/desktop',
  outExtension: { '.js': '.cjs' },
  external: ['electron', 'better-sqlite3-multiple-ciphers'],
});
