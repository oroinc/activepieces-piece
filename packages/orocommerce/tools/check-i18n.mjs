import { readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_FILE = 'translation.json';
const MAX_KEY_LENGTH_FOR_CORWDIN = 512;
const RUNTIME_LOCALES = new Set([
  'nl',
  'en',
  'de',
  'fr',
  'es',
  'ja',
  'zh',
  'pt',
  'ar',
  'zh-TW',
]);

const PATHS_TO_VALUES_TO_TRANSLATE = [
  'description',
  'auth.username.displayName',
  'auth.username.description',
  'auth.password.displayName',
  'auth.password.description',
  'auth.props.*.displayName',
  'auth.props.*.description',
  'auth.props.*.options.options.*.label',
  'auth.description',
  'actions.*.displayName',
  'actions.*.description',
  'actions.*.props.*.displayName',
  'actions.*.props.*.description',
  'actions.*.props.*.options.options.*.label',
  'triggers.*.displayName',
  'triggers.*.description',
  'triggers.*.props.*.displayName',
  'triggers.*.props.*.description',
  'triggers.*.props.*.options.options.*.label',
];

function getPropertyValue(object, path) {
  const parsedKeys = path.split('.');
  if (parsedKeys[0] === '*') {
    return Object.values(object ?? {})
      .map((item) => getPropertyValue(item, parsedKeys.slice(1).join('.')))
      .filter(Boolean)
      .flat();
  }
  const nextObject = (object ?? {})[parsedKeys[0]];
  if (nextObject && parsedKeys.length > 1) {
    return getPropertyValue(nextObject, parsedKeys.slice(1).join('.'));
  }
  return nextObject;
}

function collectTranslatableStrings({ piece }) {
  const translation = {};
  for (const path of PATHS_TO_VALUES_TO_TRANSLATE) {
    const value = getPropertyValue(piece, path);
    if (!value) {
      continue;
    }
    if (typeof value === 'string') {
      translation[value.slice(0, MAX_KEY_LENGTH_FOR_CORWDIN)] = value;
    } else if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === 'string') {
          translation[item.slice(0, MAX_KEY_LENGTH_FOR_CORWDIN)] = item;
        }
      }
    }
  }
  return translation;
}

async function loadPiece({ modulePath }) {
  if (!existsSync(modulePath)) {
    throw new Error(
      `Built piece not found at ${modulePath}. Run "npm run build" (or pass --bundle=<path>) before checking i18n.`
    );
  }
  const module = await import(pathToFileURL(modulePath).href);
  for (const exported of Object.values(module)) {
    if (
      exported !== null &&
      exported !== undefined &&
      exported.constructor?.name === 'Piece'
    ) {
      return {
        description: exported.description,
        auth: exported.auth,
        actions: exported._actions,
        triggers: exported._triggers,
      };
    }
  }
  throw new Error(`No exported Piece found in ${modulePath}.`);
}

async function readJson({ filePath }) {
  const content = await readFile(filePath, 'utf8');
  const parsed = JSON.parse(content);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${filePath} must contain a JSON object.`);
  }
  return parsed;
}

async function writeJson({ filePath, value }) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function listLocaleFiles({ i18nDir }) {
  const entries = await readdir(i18nDir);
  return entries
    .filter((entry) => entry.endsWith('.json') && entry !== SOURCE_FILE)
    .sort();
}

function difference({ from, without }) {
  return [...from].filter((key) => !without.has(key));
}

function reportList({ label, keys, limit = 10 }) {
  const shown = keys.slice(0, limit);
  const suffix = keys.length > limit ? ` (+${keys.length - limit} more)` : '';
  return `${label} (${keys.length}):\n${shown.map((key) => `    - ${key}`).join('\n')}${suffix}`;
}

async function run() {
  const args = process.argv.slice(2);
  const option = (name, fallback) => {
    const hit = args.find((arg) => arg.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : fallback;
  };
  const write = args.includes('--write');
  const strictUntranslated = args.includes('--strict-untranslated');
  const modulePath = resolve(
    option('bundle', join(PACKAGE_ROOT, 'dist', 'src', 'index.js'))
  );
  const i18nDir = resolve(option('i18n-dir', join(PACKAGE_ROOT, 'src', 'i18n')));

  const piece = await loadPiece({ modulePath });
  const expected = collectTranslatableStrings({ piece });
  const expectedKeys = new Set(Object.keys(expected));

  const errors = [];
  const warnings = [];

  const sourcePath = join(i18nDir, SOURCE_FILE);
  if (write) {
    await writeJson({ filePath: sourcePath, value: expected });
    console.log(`wrote ${expectedKeys.size} keys to src/i18n/${SOURCE_FILE}`);
  }

  const source = await readJson({ filePath: sourcePath });
  const sourceKeys = new Set(Object.keys(source));

  const missingFromSource = difference({ from: expectedKeys, without: sourceKeys });
  const staleInSource = difference({ from: sourceKeys, without: expectedKeys });

  if (missingFromSource.length > 0) {
    errors.push(
      `src/i18n/${SOURCE_FILE} is missing keys the piece exposes. ${reportList({ label: 'Missing', keys: missingFromSource })}`
    );
  }
  if (staleInSource.length > 0) {
    errors.push(
      `src/i18n/${SOURCE_FILE} has keys the piece no longer exposes. ${reportList({ label: 'Stale', keys: staleInSource })}`
    );
  }
  for (const [key, value] of Object.entries(source)) {
    if (typeof value !== 'string' || value.trim().length === 0) {
      errors.push(`src/i18n/${SOURCE_FILE} has an empty value for "${key}".`);
    }
  }

  for (const file of await listLocaleFiles({ i18nDir })) {
    const locale = file.replace(/\.json$/, '');
    const localePath = join(i18nDir, file);
    const existing = await readJson({ filePath: localePath });

    if (!RUNTIME_LOCALES.has(locale)) {
      warnings.push(
        `src/i18n/${file} is never loaded: "${locale}" is not one of the locales Activepieces supports (${[...RUNTIME_LOCALES].join(', ')}).`
      );
    }

    if (write) {
      const reconciled = {};
      for (const key of expectedKeys) {
        reconciled[key] = existing[key] ?? expected[key];
      }
      await writeJson({ filePath: localePath, value: reconciled });
      const added = difference({ from: expectedKeys, without: new Set(Object.keys(existing)) }).length;
      const removed = difference({ from: new Set(Object.keys(existing)), without: expectedKeys }).length;
      console.log(`reconciled src/i18n/${file}: +${added} seeded, -${removed} stale`);
      continue;
    }

    const localeKeys = new Set(Object.keys(existing));
    const missing = difference({ from: expectedKeys, without: localeKeys });
    const stale = difference({ from: localeKeys, without: expectedKeys });

    if (missing.length > 0) {
      errors.push(
        `src/i18n/${file} is missing keys present in ${SOURCE_FILE}. ${reportList({ label: 'Missing', keys: missing })}`
      );
    }
    if (stale.length > 0) {
      errors.push(
        `src/i18n/${file} has keys absent from ${SOURCE_FILE}. ${reportList({ label: 'Stale', keys: stale })}`
      );
    }

    const untranslated = [];
    for (const [key, value] of Object.entries(existing)) {
      if (typeof value !== 'string' || value.trim().length === 0) {
        errors.push(`src/i18n/${file} has an empty value for "${key}".`);
      } else if (expectedKeys.has(key) && value === expected[key]) {
        untranslated.push(key);
      }
    }
    if (untranslated.length > 0) {
      const message = `src/i18n/${file} repeats the English source verbatim. ${reportList({ label: 'Untranslated', keys: untranslated })}`;
      if (strictUntranslated) {
        errors.push(message);
      } else {
        warnings.push(message);
      }
    }
  }

  for (const warning of warnings) {
    console.warn(`warning: ${warning}`);
  }

  if (errors.length > 0) {
    for (const error of errors) {
      console.error(`error: ${error}`);
    }
    console.error(
      `\ni18n check failed with ${errors.length} error(s). Regenerate with "npm run cli pieces generate-translation-file orocommerce" or "npm run i18n:write", then translate the seeded keys.`
    );
    process.exit(1);
  }

  console.log(
    `i18n check passed: ${expectedKeys.size} keys across ${SOURCE_FILE} and ${(await listLocaleFiles({ i18nDir })).length} locale file(s).`
  );
}

run().catch((error) => {
  console.error(`error: ${error.message}`);
  process.exit(1);
});
