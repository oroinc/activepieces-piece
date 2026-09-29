# Maintainers

Who looks after this repository, how to build it, and how a release is cut.

## The team

The piece is maintained by the Flextra team:

| Name | GitHub |
| --- | --- |
| Mikhail Yahorau | [@mikhail-yahorau](https://github.com/mikhail-yahorau) |
| Illia Senko | [@IlyaSenko](https://github.com/IlyaSenko) |

## Review

`.github/CODEOWNERS` owns every path in the repository:

```
* @mikhail-yahorau @IlyaSenko
```

GitHub requests a review from both accounts on every pull request. Whichever of the two did not
write the change is the one who reviews it. There is no front-end team handle in the organisation to
name instead; if one is created, replace the CODEOWNERS line with the team.

## Building and testing locally

Node 20 or later.

```sh
npm ci
npm run ap:fetch       # sparse checkout of Activepieces at the commit in .ap-pin
npm run lint
npm run bundle         # bundles with @activepieces/cli and packs artifacts/*.tgz
npm run ap:check-clean # asserts the fetched upstream tree is untouched
npm test               # 7 suites, 97 tests
npm run i18n:check     # needs the bundle: it reads the built piece for the strings it exposes
npm run verify         # checks the packed .tgz loads standalone with the expected surface
npm run metadata:check # compares the piece's surface with the committed snapshot
```

That is the same order `.github/actions/build-piece` runs, and both CI and the release workflow use
that action, so a tag is built and checked exactly the way a pull request is. `npm run bundle`
fetches first if `.ap-src` is missing or at the wrong commit, so it is safe to run on its own.

The build fetches Activepieces because the piece is compiled against
`@activepieces/pieces-framework` and `@activepieces/pieces-common`, whose npm copies lag a long way
behind the engine. `README.md` explains the fetch, the pin in `.ap-pin` and how to bump it;
`packages/orocommerce/INTERNALS.md` explains the piece's own code.

## How a release happens

Nothing is built by hand and nothing is uploaded to a release by hand. A release is one tag on
`main`.

1. **Bump the version** in `packages/orocommerce/package.json`, in the pull request that makes the
   change, not at tag time. The rule is semantic versioning: **major** when a flow somebody has
   already built can break (an action or trigger removed or renamed, a new required prop, a prop
   whose type changed, output a flow reads that is no longer there), **minor** for a new action,
   trigger or optional prop, **patch** for a fix that leaves the piece's surface as it was.
2. **Add the CHANGELOG entry in the same pull request as the bump**, in
   `packages/orocommerce/CHANGELOG.md`: a `## <version>` heading at the top, `* ` bullets, newest
   first, with the Jira key inline where there is one.
3. **Merge**, then tag the merge commit on `main`:

   ```sh
   git checkout main && git pull
   git tag -a v1.2.3 -m "1.2.3"
   git push origin v1.2.3
   ```

   The tag must be exactly `v` plus the version in `packages/orocommerce/package.json`, and the
   commit it points at must be on `main`. `.github/workflows/release.yml` checks both before it
   builds anything, so a tag pushed from a branch, or one naming a version nobody merged, fails in
   seconds.
4. **The release workflow** then builds the piece with the same composite action CI uses, writes the
   release notes (the tag, the tagged commit, the `.ap-pin` commit, the sha256 of the `.tgz` and the
   sha256 of `package/src/index.js` inside it), creates the GitHub Release with the `.tgz` attached,
   and publishes to npm if publishing is switched on. If a release for that tag already exists it
   stops and changes nothing.

`npm run release:notes` writes the same notes locally from whatever is in `artifacts/`, which is the
way to see what a release would say before cutting one.

**A published version is final.** A version that has been released is never rebuilt and never
republished. Re-running the workflow on an existing tag changes nothing, and moving a tag does not
move what was published. If a release is wrong, the fix is the next version.

## Who can publish

Publishing to npm is done by CI, not from a laptop. It is off until somebody turns it on.

- **npm.** Publishing needs rights on the `@oroinc` scope on npmjs.com. The maintainers of the
  `@oroinc` scope grant them; nobody publishes this package from a personal account.
- **Turning it on.** Set the Actions variable `NPM_PUBLISH_ENABLED` to `true` and add the Actions
  secret `NPM_TOKEN`, an npm granular access token with publish rights on the `@oroinc` scope. Until
  then a tag produces a GitHub Release with the `.tgz` attached and nothing else, which is a complete
  way to ship the piece.
- **Trusted publishing.** The token is a first-publish measure, not the end state. npm's trusted
  publishing (OIDC) removes the long-lived token, but a trusted publisher can only be configured on a
  package that already exists on npm. After the first release lands, configure GitHub Actions as a
  trusted publisher on the package page and delete the secret. Nothing in the workflow has to change:
  the job already has the `id-token` permission npm authenticates through.

The token and the variable live in the repository settings. Neither belongs in a file here, and
nothing in this repository needs an internal host or a credential to build.
