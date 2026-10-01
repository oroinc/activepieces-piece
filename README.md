# OroCommerce piece for Activepieces

This repository holds the OroCommerce [Activepieces](https://www.activepieces.com/) piece and the
tooling that builds it. The piece connects flows to the OroCommerce back-office JSON:API: it creates
and updates customers, customer users, back-office users, orders and invoices, and starts flows from
OroCommerce webhooks.

| | |
| --- | --- |
| Published package | [`@oroinc/piece-orocommerce`](https://www.npmjs.com/package/@oroinc/piece-orocommerce) |
| Actions | 11 |
| Triggers | 1 (`oro-webhook-event`) |
| Supported Activepieces | 0.92.0 and later |

## Install

Installing a piece is a platform admin action, on an instance running Activepieces 0.92.0 or later.

### From npm

Sign in as a platform admin, open **Platform Setup → Pieces**, and click **Install Piece**. In the
**Install a piece** dialog:

| Field | Value |
| --- | --- |
| **Package Type** | **NPM Registry** |
| **Piece Name** | `@oroinc/piece-orocommerce` |
| **Piece Version** | the exact version, for example `1.0.0` |

Then click **Install**.

### The .tgz on each release

Every [release](https://github.com/oroinc/activepieces-piece/releases) attaches the packed piece as
a `.tgz` and records its sha256 in the release notes. It is the same artifact that gets published,
so that checksum is how anyone can confirm that what npm serves is what Oro released.

Whether it can be uploaded instead depends on the edition. In the **Install a piece** dialog,
**Package Type → Packed Archive (.tgz)** is disabled unless the instance runs an edition above
Community and its platform plan allows managing pieces - in upstream Activepieces (at `.ap-pin`),
the dialog disables that option on `!isEnabled || !privatePiecesEnabled`, and
`packages/server/api/src/app/flags/flag.service.ts` sets `PRIVATE_PIECES_ENABLED` to
`getEdition() !== ApEdition.COMMUNITY`. On Community Edition the option stays greyed out, so install
from npm there.

### Versions and upgrading

A flow pins the exact piece version it was built with, so installing a newer version does not move
existing flows onto it. An upgrade is two steps: install the new version, then update each flow's
step to it. Both versions stay installed until you remove the old one, so flows can be moved over
one at a time.

Once the piece is installed, [setting up a connection](packages/orocommerce/README.md#setting-up-a-connection)
is the next step.

## Contributing

The repository root is tooling only. Nothing at the root is published; the package that gets packed
is `packages/orocommerce`, and its `package.json` is the published manifest.

Every pull request is reviewed. `.github/CODEOWNERS` names two front-end owners and GitHub requests
a review from both; whichever of the two did not write the change is the one who reviews it.

Build, test and release: [MAINTAINERS.md](MAINTAINERS.md). Code notes:
[packages/orocommerce/ARCHITECTURE.md](packages/orocommerce/ARCHITECTURE.md).

### Why the build fetches Activepieces

The piece is compiled against `@activepieces/pieces-framework` and `@activepieces/pieces-common`.
The copies of those on npm lag a long way behind the engine, so the framework has to come from
source. Cloning all of Activepieces costs about 2.7 GB, and the bundler only ever reaches four
packages, so `scripts/fetch-ap.mjs` takes a sparse, blobless checkout of exactly those four
(`packages/pieces/framework`, `packages/pieces/common`, `packages/core/utils`,
`packages/core/piece-types`) at one pinned commit. That is roughly 9 MB and takes a few seconds.

The checkout lands in `.ap-src/`, which is git-ignored. `node_modules` stays at the repository root,
outside that tree.

The upstream packages fetched at `.ap-pin` are used exactly as upstream published them: nothing in
this repository patches, forks or writes into `.ap-src`, apart from the copy of the piece that
`scripts/bundle.mjs` stages at `packages/pieces/community/orocommerce` so the CLI can resolve the
workspace. That matters because the framework and the common package are inlined into the artifact,
so an edit there would ship in the piece without appearing in any diff of this repository, and a
cached tree would carry it from one build to the next. `npm run ap:check-clean` fails when the tree is
at the wrong commit or when `git status` reports anything other than that staged copy, and CI runs it
after every bundle. If a script here ever writes into the tree, fix the script rather than the check.

### The pin

`.ap-pin` holds one full 40-character upstream commit sha:

```
ac16617326f0d25e0eb6a9bc50eb20271b9b1dcc
```

It must be a sha. Not a tag, not a version string, and never `git describe`. Upstream's root
`package.json` keeps a version string until the next release bump, so the same string names several
different trees, and a fork carries no upstream release tags for `git describe` to find. Two trees
that both call themselves 0.88.1 shipped different versions of `core-utils` and `core-piece-types`.

The pin above is the commit upstream tagged `0.92.0`.

#### Bumping it

Raise the bump as **its own pull request**, changing `.ap-pin` and nothing else, so that the effect
on the artifact is visible on its own.

Maintainers set the pin to the upstream commit of the Activepieces version Oro runs, and never below
0.92.0, which is the oldest version this piece supports. Whatever the source, what lands in `.ap-pin`
is always a full upstream commit sha.

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

### Releasing

See [MAINTAINERS.md](MAINTAINERS.md#release).

### Layout

```
.ap-pin                    the pinned upstream commit
.eslintrc.base.json        lint rules the piece extends
tsconfig.base.json         compiler options the piece extends
scripts/fetch-ap.mjs       sparse blobless checkout into .ap-src
scripts/bundle.mjs         stage, bundle with the CLI, copy back, npm pack
scripts/verify-artifact.mjs  checks on the packed .tgz
scripts/metadata-snapshot.mjs  compares the built surface with the committed snapshot
scripts/check-ap-clean.mjs   asserts .ap-src is unmodified at the pinned commit
scripts/release-notes.mjs    the release identity written into the release notes
scripts/notices.mjs          builds the NOTICE that ships in the package
scripts/esbuild-metafile.cjs  makes the bundler hand back its metafile
scripts/dev-ap.mjs         runs the piece in a local Activepieces dev server, in .ap-dev
LICENSE                    the licence, copied into the package at build time
MAINTAINERS.md             maintainers, build, release
.github/actions/build-piece  the build and the checks, shared by CI and the release workflow
.github/workflows/           CI on every pull request, release on every v*.*.* tag
packages/orocommerce/      the piece, and the package that is published
packages/orocommerce/README.md   the npm page; the only document that ships
packages/orocommerce/CHANGELOG.md  what changed in each version
packages/orocommerce/ARCHITECTURE.md  how the piece is built and why
packages/orocommerce/metadata.snapshot.json  the surface CI holds the build to
```

## Licence

The piece is MIT; see [LICENSE](LICENSE).

Most of what the published artifact contains is not written here. The bundler inlines the
Activepieces framework and every npm package the piece reaches into a single `src/index.js`, and
every licence involved requires its notice to travel with the code, so the packed `.tgz` carries a
`NOTICE` listing each of them with its full licence text.

That file is generated on every build from the bundler's own metafile, counting only packages that
contribute code to the bundle, so it describes the artifact rather than the dependency list. There
is no copy in the repository, because there is nothing to generate it from until a build has run.
`npm run bundle` writes it, `npm run verify` fails if it is missing or does not name everything
bundled, and a package under a licence the generator has no rule for fails the build by name rather
than shipping unattributed.

## Reporting problems

Open an issue at <https://github.com/oroinc/activepieces-piece/issues> with your OroCommerce
version, the Activepieces version, and what the step returned.
