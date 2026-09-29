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
npm test               # the vitest suites
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
`packages/orocommerce/ARCHITECTURE.md` explains how the piece itself is built.

## How a release happens

A release is one tag on `main`. Nothing is built by hand and nothing is uploaded to a release by
hand: the artifact a release carries is always the one the workflow built from the tagged commit.
Handing that artifact to npm is a separate step, and for 1.0.0 it is done once by hand - see
[Who can publish](#who-can-publish).

1. **Bump the version** in `packages/orocommerce/package.json`, in the pull request that makes the
   change, not at tag time. The rule is semantic versioning: **major** when a flow somebody has
   already built can break (an action or trigger removed or renamed, a new required prop, a prop
   whose type changed, output a flow reads that is no longer there), **minor** for a new action,
   trigger or optional prop, **patch** for a fix that leaves the piece's surface as it was.

   A pin bump is the case that needs a decision, because moving `.ap-pin` can change the props of
   the shared HTTP action with no line of this repository changing.
   `packages/orocommerce/metadata.snapshot.json` is what tells you: run `npm run metadata:write` in
   the bump's own pull request and read the diff. A changed prop type or a required field that
   became optional is a major bump, a new optional prop is a minor one, and a bump that leaves the
   snapshot untouched is a patch. The snapshot says what moved; which bump that deserves is still a
   judgement somebody has to make.
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

**A published version is final.** Published means on npm. A version that reached npm is never
rebuilt and never republished: npm serves that tarball for good, re-running the workflow on an
existing tag changes nothing, and moving a tag does not move what npm already has. If a published
version is wrong, the fix is the next version.

A GitHub Release is not that. A release of a version that never reached npm may be deleted and cut
again, because nothing downstream depends on it yet. That has been done once, for 1.0.0, to add the
README to the packed artifact. Once a version is on npm, its GitHub Release is left alone too - the
sha256 in its notes is what anyone checks the npm tarball against.

## Who can publish

Publishing needs rights on the `@oroinc` scope on npmjs.com, which the maintainers of that scope
grant. **No npm token is stored in this repository**, and none is ever added to it.

### 1.0.0, published once by hand

The first version is published by an `@oroinc` npm maintainer - Valerii Yustyniuk - from a laptop,
because the package has to exist on npm before anything else can be configured against it.

What he publishes is the `.tgz` attached to the GitHub Release for the tag, downloaded from that
release and checked against the sha256 in the release notes first. It is never rebuilt: a rebuild
produces a different artifact from the one the release records, and then the checksum in the notes
describes nothing anybody can verify.

### Then, trusted publishing

Once 1.0.0 is on npm, he configures trusted publishing on the package page, so that later versions
need no credential at all:

| Setting | Value |
| --- | --- |
| Publisher | GitHub Actions |
| Repository | `oroinc/activepieces-piece` |
| Workflow | `release.yml` |
| Tokens | disallow, if the option is available |

and adds Mikhail Yahorau and Illia Senko as maintainers of the package.

### From the next version, CI publishes

After that, a repository admin sets the Actions variable `NPM_PUBLISH_ENABLED` to `true` and a tag
publishes to npm with provenance, authenticated through the `id-token` permission the release job
already has. Until that variable is set, a tag produces a GitHub Release with the `.tgz` attached
and nothing else, which is a complete way to ship the piece.

**Open prerequisite.** Trusted publishing needs npm 11.5.1 or later on the runner, and
`release.yml` sets up Node 20, which carries npm 10. That has to be fixed before the variable is
turned on. It is deliberately not changed in the pull request that added this file, so the change
lands where it can be reviewed on its own.

Nothing in this repository needs a credential or an internal host to build.
