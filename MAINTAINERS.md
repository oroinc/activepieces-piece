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

`npm run metadata:write` and `npm run i18n:write` regenerate the snapshot and the English
translation source.
Run them only for a change that is meant to move them, and review the diff.

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
