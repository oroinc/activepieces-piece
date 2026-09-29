# OroCommerce piece for Activepieces

This repository holds the OroCommerce [Activepieces](https://www.activepieces.com/) piece and the
tooling that builds it. The piece connects flows to the OroCommerce back-office JSON:API: it creates
and updates customers, customer users, back-office users, orders and invoices, and starts flows from
OroCommerce webhooks.

| | |
| --- | --- |
| Published package | `packages/orocommerce` |
| Actions | 11 |
| Triggers | 1 (`oro-webhook-event`) |
| Supported Activepieces | 0.92.0 and later |

The repository root is tooling only. Nothing at the root is published; the package that gets packed
is `packages/orocommerce`, and its `package.json` is the published manifest.

## Why the build fetches Activepieces

The piece is compiled against `@activepieces/pieces-framework` and `@activepieces/pieces-common`.
The copies of those on npm lag a long way behind the engine, so the framework has to come from
source. Cloning all of Activepieces costs about 2.7 GB, and the bundler only ever reaches four
packages, so `scripts/fetch-ap.mjs` takes a sparse, blobless checkout of exactly those four
(`packages/pieces/framework`, `packages/pieces/common`, `packages/core/utils`,
`packages/core/piece-types`) at one pinned commit. That is roughly 9 MB and takes a few seconds.

The checkout lands in `.ap-src/`, which is git-ignored. `node_modules` stays at the repository root,
outside that tree.

Nothing in this repository writes into `.ap-src`, apart from the copy of the piece that
`scripts/bundle.mjs` stages at `packages/pieces/community/orocommerce` so the CLI can resolve the
workspace. That matters because the framework and the common package are inlined into the artifact,
so an edit there would ship in the piece without appearing in any diff of this repository, and a
cached tree would carry it from one build to the next. `npm run ap:check-clean` fails when the tree is
at the wrong commit or when `git status` reports anything other than that staged copy, and CI runs it
after every bundle. If a script here ever writes into the tree, fix the script rather than the check.

## Building and testing

```sh
npm ci
npm run ap:fetch      # sparse checkout of Activepieces at the commit in .ap-pin
npm run lint
npm test              # 7 suites, 97 tests
npm run bundle        # bundles with @activepieces/cli and packs artifacts/*.tgz
npm run i18n:check    # needs the bundle: it reads the built piece for the strings it exposes
npm run verify        # checks the packed .tgz loads standalone with the expected surface
npm run metadata:check # compares the piece's surface with the committed snapshot
npm run ap:check-clean # asserts the fetched upstream tree is untouched
```

`npm run bundle` fetches first if `.ap-src` is missing or is at the wrong commit, so it is safe to
run on its own.

The bundle is produced by the official Activepieces CLI, pinned exactly in the root
`devDependencies`. The piece is staged into the fetched tree at
`packages/pieces/community/orocommerce` before bundling, because the CLI resolves `@activepieces/*`
through the workspace aliases of the repository it finds by walking up from the piece, and that has
to be the Activepieces tree. Only `package.json` and `src/` are staged; the output is copied back to
`packages/orocommerce/dist` and packed from there.

## The pin

`.ap-pin` holds one full 40-character upstream commit sha:

```
ac16617326f0d25e0eb6a9bc50eb20271b9b1dcc
```

It must be a sha. Not a tag, not a version string, and never `git describe`. Upstream's root
`package.json` keeps a version string until the next release bump, so the same string names several
different trees, and a fork carries no upstream release tags for `git describe` to find. Two trees
that both call themselves 0.88.1 shipped different versions of `core-utils` and `core-piece-types`.

### Bumping it

Raise the bump as **its own pull request**, changing `.ap-pin` and nothing else, so that the effect
on the artifact is visible on its own.

The pin should be the upstream commit the Oro Activepieces image is built from. Derive it from the
embedding branch rather than from a version string: take the second parent of the last `origin/main`
sync merge reachable from the branch the image is based on. That is the upstream commit whose
framework the running engine actually has.

Expect a bump to change the artifact. The framework and the common package are inlined into the
bundle, so their contents move its size and its hash, and a changed label in the shared HTTP action
changes the translation keys the piece exposes.

A bump can also change what the piece exposes to flows without a line of this repository changing,
because the shared HTTP action and all of its props come from `@activepieces/pieces-common`. The move
to 0.92.0 did exactly that: seven props of the custom API call action changed type, label or required
flag. `packages/orocommerce/metadata.snapshot.json` records the piece's surface and CI fails when the
build no longer matches it, so run `npm run metadata:write` in the bump's own pull request and read
what lands in the diff. Treat a changed property type or a required field becoming optional as a
change to flows people have already built.

## Layout

```
.ap-pin                    the pinned upstream commit
.eslintrc.base.json        lint rules the piece extends
tsconfig.base.json         compiler options the piece extends
scripts/fetch-ap.mjs       sparse blobless checkout into .ap-src
scripts/bundle.mjs         stage, bundle with the CLI, copy back, npm pack
scripts/verify-artifact.mjs  checks on the packed .tgz
scripts/metadata-snapshot.mjs  compares the built surface with the committed snapshot
scripts/check-ap-clean.mjs   asserts .ap-src is unmodified at the pinned commit
packages/orocommerce/      the piece, and the package that is published
packages/orocommerce/metadata.snapshot.json  the surface CI holds the build to
```

## Reporting problems

Open an issue at <https://github.com/oroinc/activepieces-piece/issues> with your OroCommerce
version, the Activepieces version, and what the step returned.
