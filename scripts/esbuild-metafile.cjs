/**
 * Preloaded into the Activepieces CLI process so the bundle's own esbuild metafile can be read.
 *
 * The notice file has to list exactly what is inside the artifact, and the only thing that knows
 * that is the bundler. The CLI builds a metafile already - it uses one for its size report - but
 * does not write it anywhere, and it exposes no hook, so this wraps esbuild.build on the way past
 * and writes the metafile of the last pass to AP_METAFILE_OUT. bundlePiece can run esbuild more
 * than once (it re-runs after externalising an unsafe package, and again if an inline-everything
 * build blows the size cap); the last pass is the one that produced the output on disk, so each
 * write overwrites the previous one.
 *
 * esbuild exports `build` as a non-configurable getter, so the module object cannot be patched in
 * place. A copy is handed back instead.
 */
const Module = require('node:module');
const { writeFileSync } = require('node:fs');

const out = process.env.AP_METAFILE_OUT;
const originalLoad = Module._load;

Module._load = function load(request) {
  const loaded = originalLoad.apply(this, arguments);
  if (request !== 'esbuild' || !out || !loaded || typeof loaded.build !== 'function') {
    return loaded;
  }

  const copy = {};
  for (const key of Object.getOwnPropertyNames(loaded)) {
    copy[key] = loaded[key];
  }

  const originalBuild = loaded.build;
  copy.build = async function build(...args) {
    const result = await originalBuild.apply(loaded, args);
    if (result && result.metafile) {
      writeFileSync(out, JSON.stringify(result.metafile));
    }
    return result;
  };

  return copy;
};
