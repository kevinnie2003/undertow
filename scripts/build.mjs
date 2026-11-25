// Bundles the Node entry points and the browser client with esbuild.
import { build } from 'esbuild';
import { cpSync, mkdirSync } from 'node:fs';

const nodeOnly = process.argv.includes('--node-only');

const node = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  sourcemap: true,
  packages: 'external',
  logLevel: 'warning',
};

await Promise.all([
  build({ ...node, entryPoints: ['src/sim/cli.ts'], outfile: 'dist/sim.js' }),
  build({ ...node, entryPoints: ['src/server/server.ts'], outfile: 'dist/server.js' }),
  ...(nodeOnly
    ? []
    : [
        build({
          bundle: true,
          platform: 'browser',
          format: 'esm',
          target: 'es2020',
          sourcemap: true,
          minify: true,
          entryPoints: ['src/web/main.ts'],
          outfile: 'dist/web/app.js',
          logLevel: 'warning',
        }),
      ]),
]);

if (!nodeOnly) {
  mkdirSync('dist/web', { recursive: true });
  cpSync('src/web/index.html', 'dist/web/index.html');
  cpSync('src/web/style.css', 'dist/web/style.css');
}
console.log('build ok');
