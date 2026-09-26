#!/usr/bin/env tsx
/**
 * Build the Conduct Radio plugin: `plugins/conduct-radio/`.
 *
 *   npm run build
 *
 * A plugin installed from a marketplace is a copy of files from git — there is
 * no `npm install` — so everything it runs is prebuilt here and committed:
 *
 *   server/radio.mjs      the server, Node built-ins only
 *   server/radio-ctl.mjs  start / stop / status, what the skill runs
 *   app/index.html        the page
 *   app/bundle.js         the page's script
 *   LICENSE               MIT, Parse Studios — installs copy only this folder
 *
 * `test/plugin.test.ts` rebuilds in memory and fails if these are stale, so a
 * change to `src/` or `app/` can't ship without a rebuild.
 */
import { build, type BuildOptions } from 'esbuild';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoDir = resolve(fileURLToPath(new URL('..', import.meta.url)));
export const pluginDir = join(repoDir, 'plugins', 'conduct-radio');

const node: BuildOptions = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  // Only the repo's dev path imports esbuild, lazily; the plugin always passes --app.
  external: ['esbuild'],
  legalComments: 'none',
  write: false,
};

/** Files copied as-is: `[source in the repo, path in the plugin]`. */
export const COPIED: ReadonlyArray<readonly [string, string]> = [
  ['app/index.html', 'app/index.html'],
  ['LICENSE', 'LICENSE'],
];

/** Every built file, as `[path relative to the plugin, contents]`. */
export async function buildPlugin(): Promise<Array<[string, string]>> {
  const [server, ctl, page] = await Promise.all([
    build({ ...node, entryPoints: [join(repoDir, 'scripts', 'radio.ts')] }),
    build({ ...node, entryPoints: [join(repoDir, 'scripts', 'radio-ctl.ts')] }),
    build({
      entryPoints: [join(repoDir, 'app', 'main.ts')],
      bundle: true,
      platform: 'browser',
      format: 'esm',
      target: 'es2022',
      minify: true,
      legalComments: 'none',
      write: false,
    }),
  ]);
  const banner = '// Built by scripts/build-plugin.ts — edit the sources, then `npm run build`.\n';
  // esbuild keeps the source's shebang (`tsx`, for the repo). A shebang is only
  // legal on line 1, so it's replaced with a `node` one and the banner goes after.
  const script = (text: string): string => `#!/usr/bin/env node\n${banner}${text.replace(/^#!.*\n/, '')}`;
  return [
    ['server/radio.mjs', script(server.outputFiles![0]!.text)],
    ['server/radio-ctl.mjs', script(ctl.outputFiles![0]!.text)],
    ['app/bundle.js', banner + page.outputFiles[0]!.text],
  ];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = await buildPlugin();
  for (const [path, text] of files) {
    const target = join(pluginDir, path);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, text);
    console.log(`  ${path.padEnd(22)} ${(text.length / 1024).toFixed(0)}kb`);
  }
  for (const [from, to] of COPIED) {
    copyFileSync(join(repoDir, from), join(pluginDir, to));
    console.log(`  ${to.padEnd(22)} copied`);
  }
  console.log(`Built ${pluginDir}`);
}
