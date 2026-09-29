#!/usr/bin/env node
/**
 * Build the NOTICE that ships inside the packed artifact.
 *
 * Most of what the artifact contains is not written in this repository: the bundler inlines the
 * Activepieces framework and every npm package the piece reaches into one src/index.js. Every
 * licence involved so far is a notice-retention licence, so that text has to travel with the code.
 *
 * The list comes from the bundler's own metafile, and only from packages with bytesInOutput > 0.
 * A package esbuild parses but tree-shakes away completely contributes no code to the artifact, so
 * it is not distributed and its notice is not required; deepmerge-ts is the current example.
 * Reading the list off package.json instead would name dependencies that never ship and miss
 * transitive ones that do.
 *
 * Unknown licences fail the build by name. A pin bump can change what the shared HTTP action pulls
 * in without a line of this repository changing, and the point of the gate is that such a change
 * cannot arrive silently.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Licences whose obligations this file can satisfy on its own: keep the notice with the code.
// Anything else - a copyleft licence, a dual-licence expression, a package with no licence at all -
// is a decision for a person, not for the build.
const ALLOWED = new Set(['MIT', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0']);

const LICENCE_FILE = /^(licen[cs]e|copying)([.-].*)?$/i;
// Apache-2.0 section 4(d): if the work carries a NOTICE, its text has to be passed on too.
const NOTICE_FILE = /^notice([.-].*)?$/i;

const AP_PACKAGES = [
  'packages/pieces/framework',
  'packages/pieces/common',
  'packages/core/utils',
  'packages/core/piece-types',
];

const AP_LICENCE = `Copyright (c) 2020-2024 Activepieces Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

const RULE = '='.repeat(78);
const THIN = '-'.repeat(78);

/**
 * Every npm package that contributes bytes to the bundle, with where it was resolved from.
 * The metafile keys inputs by path, so the package directory is the prefix up to and including its
 * name - which also handles a nested node_modules, where the same name can resolve twice.
 */
export function bundledPackages(metafile) {
  const outputs = Object.values(metafile.outputs ?? {});
  if (outputs.length !== 1) {
    throw new Error(`Expected the bundler to produce one output, found ${outputs.length}.`);
  }

  const found = new Map();
  for (const [inputPath, info] of Object.entries(outputs[0].inputs ?? {})) {
    if (!(info.bytesInOutput > 0)) {
      continue;
    }
    const marker = inputPath.lastIndexOf('node_modules/');
    if (marker < 0) {
      continue;
    }
    const rest = inputPath.slice(marker + 'node_modules/'.length).split('/');
    const name = rest[0].startsWith('@') ? `${rest[0]}/${rest[1]}` : rest[0];
    const dir = inputPath.slice(0, marker + 'node_modules/'.length) + name;
    const seen = found.get(dir) ?? { name, dir, bytes: 0 };
    seen.bytes += info.bytesInOutput;
    found.set(dir, seen);
  }

  return [...found.values()]
    .map((pkg) => ({ ...pkg, ...describe(pkg) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function describe({ name, dir }) {
  const manifestPath = join(dir, 'package.json');
  if (!existsSync(manifestPath)) {
    throw new Error(`${name} is in the bundle but has no package.json at ${dir}.`);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const licence = typeof manifest.license === 'string' ? manifest.license : null;
  return { version: manifest.version, licence, ...licenceFiles(dir) };
}

function licenceFiles(dir) {
  const entries = readdirSync(dir);
  const licenceName = entries.find((entry) => LICENCE_FILE.test(entry));
  const noticeName = entries.find((entry) => NOTICE_FILE.test(entry));
  return {
    licenceText: licenceName ? readFileSync(join(dir, licenceName), 'utf8').trim() : null,
    licenceFile: licenceName ?? null,
    noticeText: noticeName ? readFileSync(join(dir, noticeName), 'utf8').trim() : null,
  };
}

/** Everything wrong with the set at once, so a pin bump is not fixed one package per build. */
export function unusablePackages(packages) {
  const problems = [];
  for (const pkg of packages) {
    if (!pkg.licence) {
      problems.push(`${pkg.name}@${pkg.version} declares no licence`);
    } else if (!ALLOWED.has(pkg.licence)) {
      problems.push(`${pkg.name}@${pkg.version} is ${pkg.licence}, which is not on the allow-list`);
    }
    if (!pkg.licenceText) {
      problems.push(`${pkg.name}@${pkg.version} ships no licence file to quote`);
    }
  }
  return problems;
}

/**
 * Identical texts are shared by packages from the same author, so one block can carry several
 * names. The copyright line lives inside the text, so grouping never merges two holders: two
 * packages group only when the whole text, copyright line included, is byte for byte the same.
 */
function groupByText(packages) {
  const groups = new Map();
  for (const pkg of packages) {
    const group = groups.get(pkg.licenceText) ?? [];
    group.push(pkg);
    groups.set(pkg.licenceText, group);
  }
  return [...groups.entries()].sort((a, b) => a[1][0].name.localeCompare(b[1][0].name));
}

export function buildNotice({ packages, pin, pieceName, copyright }) {
  const problems = unusablePackages(packages);
  if (problems.length > 0) {
    throw new Error(
      `The bundle contains code this repository cannot generate a notice for:\n  - ${problems.join(
        '\n  - ',
      )}\nAdd the licence to the allow-list in scripts/notices.mjs only if its terms are met by ` +
        `reproducing it here.`,
    );
  }

  const lines = [
    pieceName,
    copyright,
    '',
    'This package is one bundled file. The code below is compiled into src/index.js and is',
    'redistributed under the licences reproduced here. This file is generated at build time from',
    "the bundler's metafile and lists only code that is actually in the bundle.",
    '',
    RULE,
    'Activepieces',
    RULE,
    '',
    'The following packages are inlined into src/index.js from Activepieces upstream commit',
    pin,
    '(https://github.com/activepieces/activepieces):',
    '',
    ...AP_PACKAGES.map((name) => `  ${name}`),
    '',
    AP_LICENCE,
    '',
    RULE,
    'npm packages',
    RULE,
    '',
    ...packages.map((pkg) => `  ${pkg.name}@${pkg.version} (${pkg.licence})`),
  ];

  for (const [text, group] of groupByText(packages)) {
    lines.push(
      '',
      THIN,
      ...group.map((pkg) => `${pkg.name} ${pkg.version} - ${pkg.licence}`),
      THIN,
      '',
      text,
    );
    for (const pkg of group.filter((entry) => entry.noticeText)) {
      lines.push('', `NOTICE shipped with ${pkg.name}:`, '', pkg.noticeText);
    }
  }

  return `${lines.join('\n')}\n`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const metafilePath = process.argv[2];
  if (!metafilePath) {
    console.error('Usage: node scripts/notices.mjs <metafile.json>');
    process.exit(1);
  }
  try {
    const packages = bundledPackages(JSON.parse(readFileSync(metafilePath, 'utf8')));
    for (const pkg of packages) {
      console.log(`${pkg.name}@${pkg.version}\t${pkg.licence ?? 'NONE'}\t${pkg.bytes} bytes`);
    }
  } catch (error) {
    console.error(String(error.message ?? error));
    process.exit(1);
  }
}
