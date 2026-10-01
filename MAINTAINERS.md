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
`KEY=value` per line), not in `.ap-dev/.env.dev`. Every run copies its lines into `.ap-dev/.env.dev`,
where they replace upstream's value for the same key, and `--reset` keeps the file. Deleting a line
does not bring upstream's value back; `git -C .ap-dev checkout -- .env.dev` does, on the next run.
Shell exports do not work: turbo strips every variable its `globalPassThroughEnv` does not list,
apart from system ones such as `PATH`. The few it lists pass through, and one of them exported in
the shell wins over the file. Restart after editing. The script always sets `AP_DEV_PIECES` and
`AP_REUSE_SANDBOX`, and ignores a line for either in `.env.dev.local`.

- `npm run dev:ap -- --reset` deletes `.ap-dev/` after you type `yes`: the checkout, its `.env.dev`,
  and the dev database with the flows and connections made in it. `.env.dev.local` is kept.

## Upgrading Activepieces

When moving `.ap-pin`, check the Node version of the Activepieces image the pin belongs to
(`Dockerfile` in the fetched tree) and make sure `undici` in `packages/orocommerce/package.json` is
still a major that Node's own `fetch` accepts a dispatcher from - 6 and 7 are, 8 is not on any Node
released so far, and a refused dispatcher silently turns certificate verification off.
`test/tls-verification.test.ts` proves the pairing with a real request, and CI runs the suite on both
Node 20 and Node 24, so a mismatch fails the build rather than the first flow.

## Release

1. In the pull request with the change, bump the version in `packages/orocommerce/package.json`
   (semver) and add a `## <version>` entry to `packages/orocommerce/CHANGELOG.md`.
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
