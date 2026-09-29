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

You need Activepieces 0.92.0 or later, and a platform admin account: installing a piece is a
platform-level action, in the UI and over the API alike.

There are two routes. Both end up at the same place, and which one you need depends on whether the
instance can reach the npm registry.

> 1.0.0 has not been released yet, so neither route has anything to install today. The first
> `v1.0.0` tag creates the GitHub release with the `.tgz` attached; the npm package follows once
> publishing is switched on.

### From npm

> Available once 1.0.0 is published to npm.

In the Activepieces UI, open **Platform Setup → Pieces**, click **Install Piece**, and fill the
**Install a piece** dialog in:

| Field | Value |
| --- | --- |
| **Package Type** | **NPM Registry** |
| **Piece Name** | `@oroinc/piece-orocommerce` |
| **Piece Version** | the exact version, for example `1.0.0` |

Then click **Install**.

The same thing over the API is `POST /api/v1/pieces` with `packageType` `REGISTRY`. The endpoint
takes a multipart form, which is what the UI sends:

```sh
curl -X POST https://activepieces.example.com/api/v1/pieces \
  -H "Authorization: Bearer $AP_TOKEN" \
  --form-string packageType=REGISTRY \
  --form-string scope=PLATFORM \
  --form-string pieceName=@oroinc/piece-orocommerce \
  --form-string pieceVersion=1.0.0
```

`--form-string` matters for `pieceName`: with plain `-F`, curl reads a value starting with `@` as a
file to upload.

### From the .tgz on the GitHub release

For an instance with no access to the npm registry. Every release attaches the packed piece; take
the `.tgz` from the [releases page](https://github.com/oroinc/activepieces-piece/releases).

In the same **Install a piece** dialog, set **Package Type** to **Packed Archive (.tgz)** and attach
the file under **Package Archive**. **Piece Name** and **Piece Version** still have to match what is
inside the archive.

Over the API this is the same call with `packageType` `ARCHIVE` and the file attached:

```sh
curl -X POST https://activepieces.example.com/api/v1/pieces \
  -H "Authorization: Bearer $AP_TOKEN" \
  --form-string packageType=ARCHIVE \
  --form-string scope=PLATFORM \
  --form-string pieceName=@oroinc/piece-orocommerce \
  --form-string pieceVersion=1.0.0 \
  -F pieceArchive=@oroinc-piece-orocommerce-1.0.0.tgz
```

Here the `@` in `pieceArchive` is meant literally as "upload this file", which is why that one field
uses `-F`.

### Versions and upgrading

A flow pins the exact piece version it was built with, so installing a newer version does not move
existing flows onto it. An upgrade is two steps: install the new version, then re-pin each flow that
should use it. Both versions stay installed until you remove the old one, so flows can be moved over
one at a time.

Once the piece is installed, [setting up a connection](packages/orocommerce/README.md#setting-up-a-connection)
is the next step.

## Contributing

The repository root is tooling only. Nothing at the root is published; the package that gets packed
is `packages/orocommerce`, and its `package.json` is the published manifest.

Every pull request is reviewed. `.github/CODEOWNERS` names two front-end owners and GitHub requests
a review from both; whichever of the two did not write the change is the one who reviews it.

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

### Building and testing

```sh
npm ci
npm run ap:fetch      # sparse checkout of Activepieces at the commit in .ap-pin
npm run lint
npm test              # 7 suites, 97 tests
npm run bundle        # bundles with @activepieces/cli and packs artifacts/*.tgz
npm run i18n:check    # needs the bundle: it reads the built piece for the strings it exposes
npm run verify        # checks the packed .tgz loads standalone with the expected surface
npm run metadata:check # compares the piece's surface with the committed snapshot
npm run metadata:write # rewrites that snapshot, for a change that is meant to move the surface
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

A release is one tag on main. Pushing it builds the piece from that commit and publishes the result.
Nothing is built by hand, and nothing is uploaded to a release by hand.

#### Choosing the version

`packages/orocommerce/package.json` holds the version. Bump it in the pull request that makes the
change, not at tag time:

- **major** when a flow somebody has already built can break: an action or a trigger removed or
  renamed, a new required prop, a prop whose type changed, output a flow reads that is no longer
  there.
- **minor** for a new action or trigger, or a new optional prop.
- **patch** for a fix that leaves the piece's surface as it was.

A pin bump is the case that needs a decision. Moving `.ap-pin` can change the props of the shared
HTTP action without a line of this repository changing, and `npm run metadata:write` puts that
change in the diff of the bump's own pull request. Read that diff: a changed prop type or a required
field that became optional is a major bump, a new optional prop is a minor one, and a pin bump that
leaves `metadata.snapshot.json` untouched is a patch. The snapshot tells you what moved; which bump
that deserves is still a judgement somebody has to make.

#### Cutting the release

Merge the version bump first, then tag the merge commit on main:

```sh
git checkout main && git pull
git tag v1.2.3
git push origin v1.2.3
```

The tag must be exactly `v` plus the version in `packages/orocommerce/package.json`, and the commit
it points at must be on main. `.github/workflows/release.yml` checks both before it builds anything,
so a tag pushed from a branch, or one that names a version nobody merged, fails in seconds.

It then:

1. builds the piece with the same composite action CI uses, so the tag runs lint, the test suite,
   the translation check, the check that the fetched Activepieces tree is unmodified, the checks on
   the packed artifact and the metadata snapshot;
2. writes the release notes, which record the tag, the tagged commit, the `.ap-pin` commit, the
   sha256 of the `.tgz` and the sha256 of `package/src/index.js` inside it. Those five together are
   what identifies a release: most of what ships in the artifact is inlined from Activepieces at the
   pinned commit, so the commit of this repository does not on its own say what somebody downloaded;
3. creates the GitHub release for the tag, with the `.tgz` attached and those notes. If a release
   for that tag already exists, it stops and changes nothing;
4. publishes to npm, if publishing is switched on.

`npm run release:notes` writes the same notes locally from whatever is in `artifacts/`, which is the
way to see what a release would say before cutting one.

#### Turning on npm publishing

Publishing is off. Until it is switched on, a tag produces a GitHub release with the `.tgz` attached
and nothing else, which is a complete way to ship the piece: Activepieces installs a piece from a
packed tarball.

To switch it on, in the repository settings:

- set the Actions **variable** `NPM_PUBLISH_ENABLED` to `true`;
- add the Actions **secret** `NPM_TOKEN`, an npm granular access token with publish rights on the
  `@oroinc` scope.

The publish step runs `npm publish --provenance --access public` on the exact `.tgz` the release
carries, and it asks npm for the version first: if `@oroinc/piece-orocommerce@<version>` is already
there, it skips.

The token is a first-publish measure, not the end state. npm's trusted publishing (OIDC) removes the
long-lived token, but a trusted publisher can only be configured in the settings of a package that
already exists on npm, and this package is not on npm yet
([npm docs](https://docs.npmjs.com/trusted-publishers/), [npm/cli#8544](https://github.com/npm/cli/issues/8544)).
So the first release goes out with `NPM_TOKEN`; after it lands, configure GitHub Actions as a trusted
publisher on the package page and delete the secret. Nothing in the workflow has to change for that:
with trusted publishing, npm authenticates the run through the `id-token` permission the job already
has.

#### A published version is final

A version that has been released is never rebuilt and never republished. Re-running the workflow on
an existing tag changes nothing, and moving a tag does not move what was published. If a release is
wrong, the fix is the next version.

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
.github/actions/build-piece  the build and the checks, shared by CI and the release workflow
.github/workflows/           CI on every pull request, release on every v*.*.* tag
packages/orocommerce/      the piece, and the package that is published
packages/orocommerce/metadata.snapshot.json  the surface CI holds the build to
```

## Reporting problems

Open an issue at <https://github.com/oroinc/activepieces-piece/issues> with your OroCommerce
version, the Activepieces version, and what the step returned.
