# Maintainers

Flextra team:

| Name | GitHub |
| --- | --- |
| Mikhail Yahorau | [@mikhail-yahorau](https://github.com/mikhail-yahorau) |
| Illia Senko | [@IlyaSenko](https://github.com/IlyaSenko) |

Every pull request is reviewed by the one who did not write it (`.github/CODEOWNERS`).

## Build and test

Node 20 or later. CI runs everything below on Node 20 and on Node 24, the version the Activepieces
image runs.

```sh
npm ci
npm run lint
npm run bundle          # fetches Activepieces at .ap-pin, bundles, packs artifacts/*.tgz
npm run ap:check-clean
npm test
npm run i18n:check      # after bundle
npm run verify          # checks the packed .tgz
npm run metadata:check  # compares the piece's surface with metadata.snapshot.json
```

`npm run metadata:write` and `npm run i18n:write --prefix packages/orocommerce` regenerate the
snapshot and the English translation source.
Run them only for a change that is meant to move them, and review the diff.

## Local development

Runs the piece inside a real Activepieces, with no Docker and no image rebuild.

Prerequisites, all checked before anything is downloaded: Node 22.15+ or 24 (Activepieces accepts
nothing else), bun 1.3.14 or newer, deno on PATH, and ports 3000 and 4200 free. deno can come from
Homebrew, the official installer or `npm install -g deno`; for the npm one, Activepieces skips the
shim on PATH and uses the binary the package downloaded under `npm root -g`. With no deno on PATH at
all, Activepieces would run `npm install -g deno` itself, so the script stops first.

```sh
npm run dev:ap
```

The first run clones Activepieces at `.ap-pin` into git-ignored `.ap-dev/` and installs it: 1 to 15
minutes depending on the network, and ~3 GB. Later runs reuse that checkout and are serving in about
half a minute. Open http://localhost:4200 and sign in as `dev@ap.com` / `12345678` (seeded dev user,
not a secret).

Both servers listen on all network interfaces (the API on `::`, the web app on `0.0.0.0:4200`,
which proxies `/api`), and upstream commits the JWT secret in `.env.dev`, so anyone on the same
network can sign in as platform admin. Use it only on a trusted network, and never connect it to
customer or production Oro instances.

Then edit `packages/orocommerce/src` as usual. Every save is mirrored into the checkout and rebuilt
there, so a changed label or a changed return value shows up in about 10 seconds with no restart.
The copy is one-way: only this repository is ever committed to. Restart `dev:ap` after changing
`package.json` (new dependencies need `bun install`) or a tsconfig.

Your own environment variables go in `.env.dev.local` at the repository root (git-ignored, one
`KEY=value` per line), not in the checkout's `.env.dev`. Every run rebuilds that file in three
layers: the checkout's committed `.env.dev`, then `AP_DEV_PIECES` and `AP_REUSE_SANDBOX`, which the
script always sets, then `.env.dev.local` on top. So `.env.dev.local` holds only your overrides,
deleting a line from it brings the committed value back on the next run, and edits made directly in
the generated file are lost. A `.env.dev` edited by hand (or left by an older version of the script)
is rebuilt too, after one warning that names the keys it drops, so they can be moved to
`.env.dev.local`. A line for `AP_DEV_PIECES` or `AP_REUSE_SANDBOX` in `.env.dev.local` is ignored
with a warning. Shell exports do not work: turbo strips every variable its
`globalPassThroughEnv` does not list, apart from system ones such as `PATH`. The few it lists pass
through, and one of them exported in the shell wins over the file. Restart after editing.

To run another Activepieces, such as a fork or a branch, add to `.env.dev.local`:

```sh
DEV_AP_REPO=https://github.com/<org>/<repo>.git
DEV_AP_REF=<commit, tag or branch>
```

`DEV_AP_REF` alone takes that ref of upstream; `DEV_AP_REPO` without `DEV_AP_REF` is an error. A
commit has to be the full sha, and a name has to be a plain tag or branch name: a refspec (a `:` or
a leading `+`) is refused. Each source gets its own folder, `.ap-dev-<hash>/` (12 hex digits of
a sha256 of repo and ref), with its own install of ~3 GB and its own dev database, while `.ap-dev/`
stays upstream at `.ap-pin`. A local path (one starting with `/`, `./` or `../`, or any value
without a colon) is resolved against the repository root first, so `../activepieces` is a sibling
of this repository. Otherwise the hash takes the repository string as written, so `.../repo` and
`.../repo.git` are two folders and two installs. `DEV_AP_REF` set to the `.ap-pin` sha, with no
`DEV_AP_REPO` or with upstream's URL, is the default source and uses `.ap-dev/`. The first run
fetches only that commit; later runs reuse the folder without fetching, so a branch stays where it
was until you `--reset` it. A first fetch that was interrupted is redone on the next run. A ref
without a `.env.dev` at its root is refused and its fresh checkout deleted again. A private
repository uses your own git credentials (an SSH key or a credential helper); the script never
prompts for or stores a token. A commit other than `.ap-pin` gets a warning, since the Node and bun
checks and the piece are only proven against the pin. A ref that already has a piece folder named
`orocommerce` under `packages/pieces/` other than `packages/pieces/custom/` (an old fork branch, for
example) is refused, and the checkout is kept.

- `npm run dev:ap -- --reset` deletes the current source's folder after you type `yes`: the checkout,
  its `.env.dev`, and the dev database with the flows and connections made in it. It lists the other
  `.ap-dev*` folders with their size and leaves them alone. `.env.dev.local` is kept. A
  `.env.dev.local` or `.ap-pin` the script cannot read is reported without stopping the reset,
  which then offers `.ap-dev/` or, for a source named in `.env.dev.local`, that source's folder.

## Upgrading Activepieces

When moving `.ap-pin`, check the Node version of the Activepieces image the pin belongs to
(`Dockerfile` in the fetched tree) and make sure `undici` in `packages/orocommerce/package.json` is
still a major that Node's own `fetch` accepts a dispatcher from - 6 and 7 are, 8 is not on any Node
released so far, and a refused dispatcher silently turns certificate verification off.
`test/tls-verification.test.ts` proves the pairing with a real request, and CI runs the suite on both
Node 20 and Node 24, so a mismatch fails the build rather than the first flow.

## Release

1. In the pull request with the change, bump the version in `packages/orocommerce/package.json`
   (semver).
   - major: a flow someone already built can break (action, trigger or prop removed or renamed, new
     required prop, changed prop type);
   - minor: new action, trigger or optional prop;
   - patch: anything else.
   For an `.ap-pin` bump, the `metadata:write` diff decides.
2. Merge, then tag the merge commit on `main`:

```sh
   git checkout main && git pull
   git tag -a v1.2.3 -m "1.2.3"
   git push origin v1.2.3
```

3. `release.yml` builds and checks the tag, and creates the GitHub Release with the `.tgz` and its
   sha256. It publishes to npm only when the Actions variable `NPM_PUBLISH_ENABLED` is `true`.

A version on npm is never rebuilt or republished; fix it with the next version.

## npm publishing

- 1.0.0 is published once by hand by a maintainer of the `@oroinc` npm scope, from the release
  `.tgz` after checking its sha256.
- After that, trusted publishing is set up on the package (GitHub Actions,
  `oroinc/activepieces-piece`, `release.yml`), and CI publishes later versions. No npm token is
  stored in this repository.
- Before enabling `NPM_PUBLISH_ENABLED`: `release.yml` needs npm 11.5.1+ (it uses Node 20 / npm 10
  today).
