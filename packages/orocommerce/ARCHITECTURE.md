# OroCommerce piece architecture

How the piece is built and why, and the invariants that break if they are ignored. It is for anyone
changing the code under `src/`, and is not part of the published package, which carries only
`README.md`, `LICENSE` and `NOTICE`.

Keep comments in the code short; longer explanations live here. The code keeps section markers and
a handful of short why-comments, and anything longer belongs in a section below - read the relevant
one before changing anything under `src/`. Most of them exist because of a bug that is easy to
reintroduce.

Who maintains this repository, how to build and test it, and how a release is cut are in
[MAINTAINERS.md](../../MAINTAINERS.md).

## How it talks to Oro

Two endpoints, both derived from the connection (`src/lib/common/auth.ts`):

- `POST {serverUrl}/oauth2-token` - OAuth2 **client credentials**, form-encoded.
- `{serverUrl}/{adminPrefix}/api/...` - the back-office JSON:API, bearer token.

Everything funnels through `oroApiCall()` in `src/lib/common/client.ts`, which builds the URL, sets
`Content-Type: application/vnd.api+json`, attaches the token, and normalises errors. The only
exception is `Custom API Call` (see *Headers*).

`oroApiCall` wraps failures into a readable `Error` via `formatError`. Pass
`throwOriginalError: true` when the caller needs the `HttpError` to inspect a status code - the
trigger's `onDisable` does that to swallow 401/403/404 on an already-deleted webhook.

Connection `validate` performs `GET regions/US-CA`. A connection whose client cannot read
`regions` is reported invalid even if the credentials are correct.

| Where | What |
| --- | --- |
| `src/lib/common/client.ts` | token cache, request pipeline, error formatting, env overrides |
| `src/lib/common/props.ts` | every shared dropdown + the paging loader |
| `src/lib/common/jsonapi/` | flat ⇄ JSON:API conversion (`serialize` / `deserialize`) plus the `body-utils.ts` helpers the create/update actions assemble bodies with |
| `test/jsonapi-roundtrip.test.ts` | the round-trip contract described below |

## The flat shape (read this first)

`Unserialize JSON:API Response` flattens a JSON:API document into a plain object so the
Activepieces data selector can show `customer.name` instead of hunting through `included`.
`Serialize JSON:API Request` turns that flat object back into a valid request body. The two must
round-trip losslessly, and the flat shape is ambiguous - a relationship and an attribute can look
identical once nesting is gone. Hence markers.

`deserialize` writes `_type` onto every value that came from a relationship, and uses two sentinels
for the cases where there is no related record to carry a marker:

```json
{ "_type": null, "id": null }   // NULL_RELATIONSHIP - a to-one relationship whose data is null
{ "_emptyToMany": true }        // EMPTY_TO_MANY   - a to-many relationship whose data is []
```

Without them, `null` is indistinguishable from a null *attribute* and `[]` from an attribute that
is an empty array. `serialize` would then classify the field as an attribute, Oro would receive an
unknown attribute name, and the request would fail with a 400 - silently converting a relationship
into garbage on a fetch → modify → write flow.

The sentinels are plain JSON objects on purpose. A flat object crosses step boundaries as JSON, so
anything not survivable by `JSON.parse(JSON.stringify(x))` - `undefined`, a `Symbol`, a class
instance - cannot be used as a marker. The `Object.freeze` on the constants only guards the module's
own copies; the values a flow sees are ordinary parsed objects.

### Classification rules in `splitFlat`

For each key (`_type` and `id` are consumed as the resource identity, never emitted as attributes):

1. `{_type: null, ...}` → relationship, `data: null`.
2. `{_emptyToMany: true}` → relationship, `data: []`.
3. An array → relationship **only if every element** is linkage-like; otherwise the whole array is
   an attribute. An array that mixes linkages with plain values **throws**, naming the property and
   the index of the first offender - guessing either way would corrupt data, and the flat shape has
   no way to express "some of these are relationships".
4. Otherwise linkage-like → to-one relationship.
5. Otherwise → attribute (including plain objects and arrays of plain values).

Linkage-like means a `_type: string` marker, or a raw `{type, id}` pair so hand-written bodies work
too. A `_type`-marked value carrying more than `_type`/`id` is *hoisted*: it becomes a linkage in
`relationships` and a full resource in `included`.

The `relationships` prop of the Serialize action wins over anything detected in `attributes`, and a
name listed there is never also emitted as an attribute.

## Token cache

`src/lib/common/client.ts` keeps a module-level `Map` of tokens, keyed on a SHA-256 of
**resolved server URL + client id + client secret**.

The secret must stay in the key. It was omitted once, and two connections pointing at the same
server with the same client id but different secrets collided: the connection with the *wrong*
secret got a cache hit, borrowed the other connection's token, and `validate` cheerfully approved
it. Any field that can change which credentials a request actually uses belongs in the key.

Also in there, and easy to break:

- **Expiry skew** - the entry expires 30s before Oro says it does, so a token is never used in the
  last moments of its life.
- **401 → invalidate → retry once.** `invalidateAccessToken` only evicts if the cached token is
  still the one that just failed, so a parallel refresh is not thrown away.
- **In-flight coalescing.** Concurrent callers with the same key await one shared promise from
  `inFlightTokenRequests` instead of each hammering `/oauth2-token`.

## Headers

Every action except `Custom API Call` goes through `oroApiCall`, where later wins:

```
Content-Type: application/vnd.api+json   (built in)
  → User-Agent: oroinc-piece-orocommerce/<version>   (built in)
  → connection "Default HTTP Headers"
  → internal-infrastructure User-Agent
  → the step's Additional Headers
```

`mergeHeaders` matches names whatever their case, so a later set wins even when it spells a name
differently. The token request gets the User-Agent those sets end with, and none of their other
headers.

`Authorization` is not one of them. The shared client applies the request's `authentication` first
and then spreads the request headers over it, so a header named `Authorization` used to win the merge
and replace the bearer token. `client.ts` drops it, case-insensitively, from the connection headers,
from the step's headers and once more from the merged set.

`Custom API Call` is built from the shared `createCustomApiCallAction` (`packages/pieces/common`
in upstream Activepieces, at `.ap-pin`), which merges `{...stepHeaders, ...authMappingResult}` -
the step's own headers land *first*, so whatever `authMapping` returns would normally beat them.
That is why `authMapping` in `src/lib/actions/api-call.ts` re-applies
`toHeaderRecord({ value: propsValue['headers'] })` after the connection headers: it restores the
same precedence as above. `mergeHeaders` keeps the step's spelling of each name it sets, so
upstream's first spread and this one land on the same key.
`propsValue` is the second argument `createCustomApiCallAction` hands to `authMapping`; without
using it the step's headers would silently lose to the connection's. `Authorization` is appended
last and always wins.

`api-call.ts` also replaces the action's `run` and `test` with a wrapper that answers a 401 by
dropping the cached token and trying once more, which is what `oroApiCall` does for every other
action. Everything else about the action - its name, its props, its metadata - is upstream's and is
left alone, because those props are the piece's public surface and `metadata.snapshot.json` pins
them.

## Certificate verification

Upstream's `FetchHttpClient.sendRequest` opens by setting `NODE_TLS_REJECT_UNAUTHORIZED` to `'0'`.
The piece bundles that client, so without intervention every request it makes skips certificate
checks - and, because the variable is process-wide and pieces share a worker, so does everything
running beside it.

Two things put it back, and both are needed:

- `scripts/bundle.mjs` removes the assignment from the built bundle. It requires exactly one match
  and fails the build otherwise, so an upstream rewording stops the release rather than quietly
  restoring the opt-out. `.ap-src` is never patched; `ap:check-clean` would catch that.
- `src/lib/common/tls.ts` wraps the shared client so every request carries an undici dispatcher with
  `rejectUnauthorized: true`. An explicit value on the socket is read instead of the environment
  variable, which is the only way to hold when *another* piece has already set it to `'0'`.

The wrapper is what reaches `Custom API Call`: `createCustomApiCallAction` builds its request
internally and calls `sendRequest` with no options, so there is no argument to pass a dispatcher
through.

An explicit dispatcher replaces the one Node installs for its own proxy switch, so the piece follows
that switch itself. With `NODE_USE_ENV_PROXY=1` (or `--use-env-proxy`) the dispatcher is an
`EnvHttpProxyAgent`, so `http_proxy`, `https_proxy` and `no_proxy` (lower case first) apply, as they
do for Node's `fetch`; otherwise it is a plain `Agent`. Both the switch and the proxy URLs are read
when `tls.ts` loads. Through a CONNECT proxy undici ignores
`connect` and starts TLS with the server from `requestTls`, so the TLS options are given in both;
without `requestTls` a proxied request would follow `NODE_TLS_REJECT_UNAUTHORIZED` again.
`test/proxy.test.ts` runs the artifact behind a local proxy.

`undici` is pinned to `7.30.0` and bundled into the artifact, since the Activepieces image has no
resolvable `undici` of its own. The version needs care, though not version matching: undici 6 and 7
are both accepted by Node 20, 22 and 24, whichever of the two those Node versions bundle themselves.
undici 8 is not. It reworked the handler interface, so a dispatcher built by it is refused with
`UND_ERR_INVALID_ARG` by every Node released so far, and the piece would lose certificate
verification on the first request a flow makes. `test/tls-verification.test.ts` sends a real request
through the global `fetch` rather than comparing versions, and CI runs the suite on Node 20 and on
Node 24, so a mismatch fails the build.

## Dropdowns and paging

All shared dropdowns are built from `loadDropdownOptions` in `src/lib/common/props.ts`, in two
paging modes:

- **default** - one page (`page[size]=50` from `fetchCollection`). Used together with
  `refreshOnSearch: true` and a `filter[searchQuery]` expression, so anything not on the first page
  is still reachable by typing.
- **`exhaustive: true`** - walks pages of 100 until a short page arrives, capped at 20 pages
  (2 000 records).

The rule: **a prop with no server-side search must page exhaustively.** An option the user cannot
see does not exist to them, and for the multi-select "(replaces all existing …)" props an unseen
option is worse than missing - it means a role or business unit gets silently dropped from the
record on save. Enum-ish lists (statuses, units, regions) and every multi-select therefore use
`exhaustive`. Countries are the one hand-rolled exception: a single `page[size]=300` request covers
the whole ISO list, filtered client-side.

Overflow is surfaced, not hidden: on hitting the 20-page cap the loader returns the options it has
plus a placeholder - `Showing the first N records only - more exist but are not listed`. Load
failures return a disabled dropdown with a "check the connection and its permissions" placeholder
rather than throwing, so one broken prop does not break the whole step.

## Multi-selects deliberately have no `refreshOnSearch`

Do not add it. In upstream Activepieces (at `.ap-pin`),
`packages/web/src/components/custom/multi-select-piece-property.tsx` addresses selections as
**indices into the current options array**: it renders items with
`value: String(index)` and maps a change back with `options[Number(index)].value`. Selected indices
are resolved against `[...cachedOptions, ...options]`, while writes read `options` alone.

With server-side search the options array is replaced on every keystroke, so indices held by the
form start pointing at different records - the user searches, and their existing selection quietly
becomes a different role. This is a limitation of shared web code, not a preference here; fixing it
means fixing the component to address selections by value.

Single-value dropdowns are unaffected (`SearchableSelect` stores the value itself), which is why
they do use `refreshOnSearch: true`.

## Update actions replace to-many relationships

A JSON:API `PATCH` of a to-many relationship is a **full replace**, not a merge. So the roles,
groups, business-units and organizations props on the update actions overwrite the entire list -
which is why they are multi-selects labelled "(replaces all existing …)" and why their descriptions
tell the user to include everything the record should keep. Sending one role removes the others.

## Creating related records in one request

`create-order` and `create-customer-user` build addresses and line items as entries in `included`
with a made-up local id (`li_1`, `cu_addr_1`, `billing_address`) and reference that id from
`relationships`. That is Oro's extension for creating related resources alongside the primary one;
the temporary id is only a link target within the request and is replaced by the real id in the
response. `meta: { update: true }` is the *other* Oro convention - updating an existing related
record - and is not used here.

`sanitizeJsonApiBody` in `client.ts` drops an empty `included: []` and any empty
`attributes: {}` / `relationships: {}` object from `data` before sending, so action code can build
those containers unconditionally without emitting empty ones on the wire.

## Webhook deliveries are verified against the raw body

Oro signs the exact bytes it sends: `hash_hmac('sha256', rawBody, secret)`, hex, in the
`Webhook-Signature` header. Verification therefore covers `context.payload.rawBody`, never a
re-serialized `context.payload.body` - JSON round-tripping reorders keys and the digest would never
match.

Verification runs only when this trigger has a secret stored. Oro sends no signature header when a
webhook has no secret, so header presence is never trusted: a stored entry without a secret means
"keep running unverified".

`onEnable` deletes the webhook it just created when storing the secret fails - a live webhook whose
secret is unrecoverable would have every delivery discarded - and drops a leftover registration
before creating a replacement, because republishing a flow runs `onEnable` without `onDisable`.

A rejected delivery returns `[]` with a `console.warn`: no run is created and Oro still gets its
200, so a wrong secret looks like silence. If a signed trigger goes quiet, check the worker logs for
"webhook delivery discarded".

## Local development

The toolchain lives at the repository root, and so do the commands: see
[Build and test](../../MAINTAINERS.md#build-and-test) in MAINTAINERS.md. `.github/workflows/ci.yml`
runs exactly that sequence on every pull request and on every push to `main`. The root README
explains [the fetch](../../README.md#why-the-build-fetches-activepieces) and
[the pin and how to bump it](../../README.md#the-pin).

`test/jsonapi-roundtrip.test.ts` guards the serialize/deserialize contract above,
`test/line-items.test.ts` guards line-item validation, `test/body-utils.test.ts` guards the
request-body helpers, `test/action-guards.test.ts` guards the checks that stop an action calling Oro
with unusable input, and `test/i18n.test.ts` runs the i18n gate below.

## The i18n gate

The piece ships English only. `src/i18n/translation.json` is the English source Activepieces reads
its strings from; there are no per-locale files, and `i18n:check` fails if one appears, because
Activepieces would load it as a translation.

```bash
npm run bundle && npm run i18n:write --prefix packages/orocommerce   # regenerates translation.json
```

`i18n:write` is the only generator this repository has, and it needs the built piece, so run the
build first. Activepieces' own CLI has a `pieces generate-translation-file` command, but it finds a
piece by looking under `<cwd>/packages/pieces`, a layout that exists only inside the fetched upstream
tree, so it cannot be pointed at `packages/orocommerce` from here. `i18n:write` walks the same
metadata paths and truncates keys the same way.

`npm run i18n:check` (`tools/check-i18n.mjs`) fails when the source drifts from the piece, and
`test/i18n.test.ts` runs it as part of the suite, so `npm test` covers it. It imports the **built**
piece from `dist/` and only checks that the file exists, never that it is current, so run
`npm run bundle` before it. It walks the same 19 metadata paths as
`pieceTranslation.pathsToValuesToTranslate` in `packages/pieces/framework/src/lib/i18n.ts` in
upstream Activepieces (at `.ap-pin`), and truncates keys at 512 characters exactly as the official
generator does. It fails on keys missing from or stale in `translation.json`, on empty values, and on
any other file in `src/i18n`.

Translations were dropped before the first release. German, French and Dutch were about half English
copy, and Polish and Ukrainian could not be loaded at all: `pieceTranslation.initializeI18n` iterates
`LocalesEnum` (`packages/core/utils/src/lib/locale.ts` in upstream Activepieces, at `.ap-pin`), which
has neither. Half-translated files that shipped as finished were worse than none. Adding locales back
means adding the files and translating every key in them.

## Passwords are step inputs, and step inputs are not secrets

Two actions take a password: `create-user` and `create-customer-user`. Oro exposes the field on
create only - a PATCH carrying it is refused as an extra field - so the update actions do not offer
it. Their values are ordinary step inputs - rendered in clear text in the builder, persisted in the
flow version, and stored in step inputs. Run-log input truncation
(`AP_FLOW_RUN_LOG_INPUT_TRUNCATE_THRESHOLD_KB`, 2 KB) does not help; a password is far under the
threshold. The prop descriptions point at a secret store, which is the only mitigation available
today. `update-user` can still change username, email and auth status in one call, so it can lock an
existing user out of their account.

There is no `Property.SecretText` to switch to. `SecretTextProperty` exists, but only as a
`PieceAuthProperty` reachable through `PieceAuth.SecretText`, and it is deliberately absent from the
`InputProperty` union that `createAction`'s `props` must satisfy - so it cannot be used as a step
input without a cast, and it carries auth-only concerns (`validate`, `getConnectionIdentifier`) that
make no sense on a step.

Everything *downstream* of the authoring API already supports it: the builder renders
`PropertyType.SECRET_TEXT` with `type='password'`
(`packages/web/src/app/builder/piece-properties/properties-utils.tsx` in upstream Activepieces, at
`.ap-pin`), `piecePropertiesUtils.buildSchema` validates it as a string, and the web form seeds it
with `''`. Only the factory and the union entry are missing. Adding them is a framework change
worth proposing on its own merits for every piece - not something to smuggle in here.

Note that it would fix only the *display*. A step-level `SECRET_TEXT` value is still persisted
verbatim in the flow version, so removing passwords from flow storage altogether needs a
connection-based design, not a prop type.

## Internal-infrastructure escape hatch

The connection has an `isInternalInfrastructure` checkbox. When it is on, and only then, the piece
reads three environment variables, on every request:

- `ORO_SERVER_URL` (`client.ts`) - replaces the connection's Server URL. It applies to **both** the
  token endpoint and the API base URL, and it is what the token cache key hashes, so flipping it
  does not reuse a token minted for the old host.
- `ORO_SERVER_USER_AGENT` (`client.ts`) - replaces the `User-Agent` of the token request and of
  every API request, the default and the connection's alike.
- `ORO_SERVER_VERIFY_TLS` (`tls.ts`) - overrides the connection's Verify TLS certificate:
  `false`/`0`/`no`/`off` or `true`/`1`/`yes`/`on`, trimmed, in any case. Any other value verifies
  and is reported once per process. It only picks between the same two agents, so the proxy path
  and the Custom API Call scope are unchanged.

All three are ignored when the checkbox is off or the variable is empty. The `adminPrefix`, client
id and client secret always come from the connection.
`test/two-connections.test.ts` runs an internal and an external connection side by side in one
process of the artifact, behind a local proxy with the internal host in `NO_PROXY`.

## Gotchas

- `loadDropdownOptions` derives the sparse-fieldset param as `fields[resourceUri.slice(1)]`, which
  assumes `resourceUri` starts with `/`. Pass `'/customers'`, not `'customers'`, or you get
  `fields[ustomers]` and a silently ignored fieldset.
- `Serialize JSON:API Request` accepts a single-resource document and unwraps it, but **rejects a
  collection** (`data` is an array) with an explanatory error. Loop first.
- Props created inside `Property.DynamicProperties` never reach piece metadata, so the line-item
  field labels in `create-order.ts` and `create-invoice.ts` are absent from `translation.json` and
  could not be translated even if locales came back. Moving those props out of `DynamicProperties`
  into a plain `Property.Array` is the only fix, and it is a separate decision.
- **An untouched `Property.Checkbox` arrives as `false`, not `undefined`, so no update action may use
  one.** The builder seeds an unset checkbox with `property.defaultValue ?? false`
  (`packages/web/src/features/pieces/utils/form-utils.tsx` in upstream Activepieces, at `.ap-pin`)
  and persists it into the step input, and
  `checkboxProcessor` passes `false` through - it is the one property type whose "empty" form value is
  not normalised to `undefined` the way `textProcessor` and `numberProcessor` normalise theirs. A
  checkbox therefore cannot say "leave this alone": a checkbox on `update-user` or
  `update-customer-user` would send `enabled: false` on every call and disable the account it was
  only asked to rename, and `assertUpdateNotEmpty` could never fire for it. Those flags are
  `booleanUpdateDropdown` in `src/lib/common/props.ts` - a three-state `Property.StaticDropdown`
  defaulting to *Leave unchanged*, as in
  `campaign-monitor/src/lib/actions/update-subscriber-details.ts` in upstream Activepieces (at
  `.ap-pin`) - read back with `readBooleanUpdate`. Give any new boolean on an update action the same
  treatment. A `defaultValue` is not a fix: `true` would unconditionally *enable* instead. Create
  actions keep their checkboxes, where an unchecked box and `false` mean the same thing. Note that a
  hand-written `propsValue` in `test/action-guards.test.ts` does not reproduce the builder's `false` -
  a case that stands in for a saved step has to pass it explicitly.

- **The invoice attachment is sent as `application/pdf`, so `create-invoice` checks that it is one.**
  Oro takes a file's type from the `mimeType` in the request and does not sniff the content: a PNG
  attached to *Invoice PDF* was accepted and stored with extension `png` and mime type
  `application/pdf`, which every consumer that trusts the type then serves as a broken PDF.
  `readPdfContent` rejects anything whose first bytes are not `%PDF-` before the request is built.
- Line-item input is validated through `lineItemUtils` (`src/lib/common/line-items.ts`), not bare
  `Number()`. `Number(undefined)` is `NaN` and `JSON.stringify` serialises `NaN` as `null`, so an
  unvalidated missing quantity used to reach Oro as `null` with no error. Route any new line-item
  field through the helper.
