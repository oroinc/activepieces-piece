# OroCommerce piece

Automate [OroCommerce](https://oroinc.com/orocommerce/) from Activepieces: create and update
customers, storefront and back-office users, orders and invoices, and start flows from OroCommerce
webhook events. Everything runs against the OroCommerce back-office JSON:API.

## Setting up a connection

The piece authenticates with **OAuth 2.0 Client Credentials**. Create the credentials in Oro first:

1. Log in to your OroCommerce admin panel.
2. Go to **System → User Management → OAuth Applications**.
3. Click **Create OAuth Application**:
   - **Application Name** — anything descriptive, e.g. `Activepieces Integration`.
   - **Grants** — select **Client Credentials**.
   - **Redirect URIs** — leave empty, the Client Credentials flow does not use them.
4. Save, then copy the **Client ID** and **Client Secret**.

Then add the connection in Activepieces:

| Field | Value |
| --- | --- |
| **Server URL** | Base URL of your instance, e.g. `https://your-store.com` |
| **Admin Prefix** | Admin panel prefix, usually `admin` |
| **Client ID** / **Client Secret** | From the OAuth application above |
| **Default HTTP Headers** | Optional JSON object sent with every request of this piece |
| **Internal infrastructure** | Leave off unless you run Oro's own hosted infrastructure |

Activepieces verifies the connection with `GET regions/US-CA`. If the OAuth application's user
cannot read `regions`, the connection is reported invalid even when the credentials are correct —
grant that permission or the check will keep failing.

## Actions

| Action | What it does |
| --- | --- |
| **Create Customer** / **Update Customer** | The customer (company) record |
| **Create Customer User** / **Update Customer User** | Storefront accounts, with addresses |
| **Create User** / **Update User** | Back-office users, roles, groups and business units |
| **Create Order** | An order with line items and billing/shipping addresses |
| **Create Invoice** | An invoice with line items and an optional PDF attachment |
| **Custom API Call** | Any other OroCommerce JSON:API endpoint |
| **Serialize JSON:API Request** / **Unserialize JSON:API Response** | Convert between a flat object and a JSON:API document |

Update actions change only the fields you fill in, and refuse to run when nothing is filled in
rather than sending an empty request that reports success. Note that a JSON:API `PATCH` of a
to-many relationship is a **full replace** — see *Update actions replace to-many relationships*.

## Trigger

**Oro Webhook Event** — starts a flow when the selected OroCommerce webhook topic fires. The topic
dropdown lists only the topics your connection can read. Enabling the trigger registers the webhook
in Oro; disabling it removes the registration.

**Sign webhook deliveries** is on by default. Enabling the trigger then generates a secret, hands it
to Oro at registration, and every later delivery must carry a matching `Webhook-Signature` header or
it is discarded without starting a run. This needs **OroCommerce 6.1 or newer** — older versions
reject the secret and the registration fails, so turn the checkbox off for them. With signing off,
anyone who learns the webhook URL can start the flow with a payload of their choosing.

The secret cannot be read back or changed after registration. To rotate it, disable and re-enable
the trigger, which deletes the old webhook and registers a new one.

## Reporting issues

Open an issue at <https://github.com/oroinc/activepieces/issues> with your OroCommerce version, the
action or trigger involved, and the error text from the run log. Do not paste client secrets,
tokens or customer data.

---

The rest of this file is for contributors. The repository bans code comments; this piece keeps
section markers and a handful of short why-comments anyway, and everything longer lives here — read
the relevant section before changing anything under `src/`. Most of them exist because of a bug that
is easy to reintroduce.

## How it talks to Oro

Two endpoints, both derived from the connection (`src/lib/common/auth.ts`):

- `POST {serverUrl}/oauth2-token` — OAuth2 **client credentials**, form-encoded.
- `{serverUrl}/{adminPrefix}/api/...` — the back-office JSON:API, bearer token.

Everything funnels through `oroApiCall()` in `src/lib/common/client.ts`, which builds the URL, sets
`Content-Type: application/vnd.api+json`, attaches the token, and normalises errors. The only
exception is `Custom API Call` (see *Headers*).

`oroApiCall` wraps failures into a readable `Error` via `formatError`. Pass
`throwOriginalError: true` when the caller needs the `HttpError` to inspect a status code — the
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
round-trip losslessly, and the flat shape is ambiguous — a relationship and an attribute can look
identical once nesting is gone. Hence markers.

`deserialize` writes `_type` onto every value that came from a relationship, and uses two sentinels
for the cases where there is no related record to carry a marker:

```json
{ "_type": null, "id": null }   // NULL_RELATIONSHIP — a to-one relationship whose data is null
{ "_emptyToMany": true }        // EMPTY_TO_MANY   — a to-many relationship whose data is []
```

Without them, `null` is indistinguishable from a null *attribute* and `[]` from an attribute that
is an empty array. `serialize` would then classify the field as an attribute, Oro would receive an
unknown attribute name, and the request would fail with a 400 — silently converting a relationship
into garbage on a fetch → modify → write flow.

The sentinels are plain JSON objects on purpose. A flat object crosses step boundaries as JSON, so
anything not survivable by `JSON.parse(JSON.stringify(x))` — `undefined`, a `Symbol`, a class
instance — cannot be used as a marker. The `Object.freeze` on the constants only guards the module's
own copies; the values a flow sees are ordinary parsed objects.

### Classification rules in `splitFlat`

For each key (`_type` and `id` are consumed as the resource identity, never emitted as attributes):

1. `{_type: null, ...}` → relationship, `data: null`.
2. `{_emptyToMany: true}` → relationship, `data: []`.
3. An array → relationship **only if every element** is linkage-like; otherwise the whole array is
   an attribute. An array that mixes linkages with plain values **throws**, naming the property and
   the index of the first offender — guessing either way would corrupt data, and the flat shape has
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

- **Expiry skew** — the entry expires 30s before Oro says it does, so a token is never used in the
  last moments of its life.
- **401 → invalidate → retry once.** `invalidateAccessToken` only evicts if the cached token is
  still the one that just failed, so a parallel refresh is not thrown away.
- **In-flight coalescing.** Concurrent callers with the same key await one shared promise from
  `inFlightTokenRequests` instead of each hammering `/oauth2-token`.

## Headers

Every action except `Custom API Call` goes through `oroApiCall`, where later wins:

```
Content-Type: application/vnd.api+json   (built in)
  → connection "Default HTTP Headers"
  → internal-infrastructure User-Agent
  → the step's Additional Headers
```

`Authorization` is passed separately as the request's `authentication` and cannot be overridden from
any of those.

`Custom API Call` is built from the shared `createCustomApiCallAction` (`packages/pieces/common`),
which merges `{...stepHeaders, ...authMappingResult}` — the step's own headers land *first*, so
whatever `authMapping` returns would normally beat them. That is why `authMapping` in
`src/lib/actions/api-call.ts` re-applies `toHeaderRecord({ value: propsValue['headers'] })` after
the connection headers: it restores the same precedence as above. `propsValue` is the second
argument `createCustomApiCallAction` hands to `authMapping`; without using it the step's headers
would silently lose to the connection's. `Authorization` is appended last and always wins.

## Dropdowns and paging

All shared dropdowns are built from `loadDropdownOptions` in `src/lib/common/props.ts`, in two
paging modes:

- **default** — one page (`page[size]=50` from `fetchCollection`). Used together with
  `refreshOnSearch: true` and a `filter[searchQuery]` expression, so anything not on the first page
  is still reachable by typing.
- **`exhaustive: true`** — walks pages of 100 until a short page arrives, capped at 20 pages
  (2 000 records).

The rule: **a prop with no server-side search must page exhaustively.** An option the user cannot
see does not exist to them, and for the multi-select "(replaces all existing …)" props an unseen
option is worse than missing — it means a role or business unit gets silently dropped from the
record on save. Enum-ish lists (statuses, units, regions) and every multi-select therefore use
`exhaustive`. Countries are the one hand-rolled exception: a single `page[size]=300` request covers
the whole ISO list, filtered client-side.

Overflow is surfaced, not hidden: on hitting the 20-page cap the loader returns the options it has
plus a placeholder — `Showing the first N records only - more exist but are not listed`. Load
failures return a disabled dropdown with a "check the connection and its permissions" placeholder
rather than throwing, so one broken prop does not break the whole step.

## Multi-selects deliberately have no `refreshOnSearch`

Do not add it. `packages/web/src/components/custom/multi-select-piece-property.tsx` addresses
selections as **indices into the current options array**: it renders items with
`value: String(index)` and maps a change back with `options[Number(index)].value`. Selected indices
are resolved against `[...cachedOptions, ...options]`, while writes read `options` alone.

With server-side search the options array is replaced on every keystroke, so indices held by the
form start pointing at different records — the user searches, and their existing selection quietly
becomes a different role. This is a limitation of shared web code, not a preference here; fixing it
means fixing the component to address selections by value.

Single-value dropdowns are unaffected (`SearchableSelect` stores the value itself), which is why
they do use `refreshOnSearch: true`.

## Update actions replace to-many relationships

A JSON:API `PATCH` of a to-many relationship is a **full replace**, not a merge. So the roles,
groups, business-units and organizations props on the update actions overwrite the entire list —
which is why they are multi-selects labelled "(replaces all existing …)" and why their descriptions
tell the user to include everything the record should keep. Sending one role removes the others.

## Creating related records in one request

`create-order` and `create-customer-user` build addresses and line items as entries in `included`
with a made-up local id (`li_1`, `cu_addr_1`, `billing_address`) and reference that id from
`relationships`. That is Oro's extension for creating related resources alongside the primary one;
the temporary id is only a link target within the request and is replaced by the real id in the
response. `meta: { update: true }` is the *other* Oro convention — updating an existing related
record — and is not used here.

`sanitizeJsonApiBody` in `client.ts` drops an empty `included: []` and any empty
`attributes: {}` / `relationships: {}` object from `data` before sending, so action code can build
those containers unconditionally without emitting empty ones on the wire.

## Webhook deliveries are verified against the raw body

Oro signs the exact bytes it sends: `hash_hmac('sha256', rawBody, secret)`, hex, in the
`Webhook-Signature` header. `run` therefore verifies `context.payload.rawBody`, never a
re-serialized `context.payload.body` — JSON round-tripping reorders keys and changes whitespace, and
the digest would never match.

Verification keys off *the trigger having stored a secret*, not off the header being present. Oro
sends no signature at all when a webhook has no secret configured, so trusting header presence would
let an attacker skip verification by omitting the header. A store entry written before this feature
existed has no `secret`, and that absence means "keep running unverified" — no migration, no version
field.

`onEnable` creates the Oro webhook before it can store the secret, so a failing `store.put` would
otherwise leave a live webhook whose secret is unrecoverable and whose every delivery is discarded
forever. The `put` is wrapped: on failure the webhook is deleted (errors from that delete are
swallowed) and the original error is rethrown.

`onEnable` also deletes a leftover registration found in the store before creating a replacement.
Republishing a flow calls `triggerSourceService.enable` without ever calling `disable`
(`flow.service.ts` → `flow-service-side-effects.ts` → `trigger-source-service.ts`), so `onEnable`
really does run without a matching `onDisable`; without that cleanup every republish would leak an
Oro webhook whose secret is no longer stored anywhere. The store is keyed by `flowId`, not by flow
version (`StoreScope.FLOW` in `packages/server/engine/src/lib/piece-context/store.ts`), so the
leftover entry is still visible at that point.

A rejected delivery is logged with `console.warn` and returns `[]` — no run is created, the caller
still gets its 200, and no secret material reaches the log. The log line reads `context.flows` and
`context.step` through optional chaining: `step` only exists on the trigger run context since
Activepieces 0.71.0 (engine commit `d64d7bf8f3`), and a plain property access would turn "discard
the forged delivery" into a thrown `TypeError` on older engines — on the security path, of all
places. The success path returns
`[context.payload.body]`; returning the whole payload would change the output schema of every
existing flow.

The HMAC comparison mirrors `verifyHmacAuth` in
`packages/pieces/core/webhook/src/lib/triggers/catch-hook.ts` — explicit length check, then
`timingSafeEqual`. It is copied rather than imported: pieces may not depend on each other.

## Local development

```bash
npx turbo run test       --filter=@activepieces/piece-orocommerce   # vitest (builds first)
npx turbo run i18n:check --filter=@activepieces/piece-orocommerce   # i18n gate (builds first)
npx turbo run lint       --filter=@activepieces/piece-orocommerce
npx turbo run build      --filter=@activepieces/piece-orocommerce   # tsc -p tsconfig.lib.json, also the type-check
npm run lint-dev                                                    # repo-wide lint with auto-fix
```

There is no `typecheck` script in this package, so the root `typecheck` task is a no-op here — the
build is the type-check.

`.github/workflows/ci.yml` runs `test` and `i18n:check` for this piece by name, alongside the other
packages in its hardcoded filter list. `test/jsonapi-roundtrip.test.ts` guards the
serialize/deserialize contract above, `test/line-items.test.ts` guards line-item validation,
`test/body-utils.test.ts` guards the request-body helpers, and `test/action-guards.test.ts` guards
the checks that stop an action calling Oro with unusable input.

## The i18n gate

`src/i18n/translation.json` is the English source; the per-locale files beside it are its
translations. Both are generated, not hand-maintained:

```bash
npm run cli pieces generate-translation-file orocommerce            # canonical; writes translation.json only
npx turbo run i18n:write --filter=@activepieces/piece-orocommerce   # also reconciles the locale files (builds first)
```

The two are not interchangeable. The CLI rewrites `translation.json` and nothing else, and it writes
no trailing newline; `i18n:write` rewrites all six files and does. Prefer `i18n:write` — it is the
one that keeps the locale files in step with the source.

`npm run i18n:check` (`tools/check-i18n.mjs`) fails the build when they drift. It imports the
**built** piece from `dist/` and only checks that the file exists, never that it is current — run it
through turbo (`npx turbo run i18n:check`), which builds first. It walks the same 19 metadata paths as
`pieceTranslation.pathsToValuesToTranslate` in `packages/pieces/framework/src/lib/i18n.ts`, and
truncates keys at 512 characters exactly as the official generator does. It fails on keys missing
from or stale in `translation.json`, on any locale file whose key set differs from it, and on empty
values. Values identical to the English source are a warning; `--strict-untranslated` promotes them
to errors.

`i18n:write` regenerates `translation.json` and reconciles every locale file against it — stale keys
are dropped, missing keys are seeded with the English text, and existing translations are left
untouched. Dropped keys are listed, because a key disappears whenever its English source text
changes and the translation attached to it goes with it. Seeded keys still need translating.

## Passwords are step inputs, and step inputs are not secrets

Four actions take a password: `create-user`, `update-user`, `create-customer-user` and
`update-customer-user`. Their values are ordinary step inputs — rendered in clear text in the
builder, persisted in the flow version, and stored in step inputs. Run-log input truncation
(`AP_FLOW_RUN_LOG_INPUT_TRUNCATE_THRESHOLD_KB`, 2 KB) does not help; a password is far under the
threshold. The prop descriptions say so, which is the only mitigation available today.

There is no `Property.SecretText` to switch to. `SecretTextProperty` exists, but only as a
`PieceAuthProperty` reachable through `PieceAuth.SecretText`, and it is deliberately absent from the
`InputProperty` union that `createAction`'s `props` must satisfy — so it cannot be used as a step
input without a cast, and it carries auth-only concerns (`validate`, `getConnectionIdentifier`) that
make no sense on a step.

Everything *downstream* of the authoring API already supports it: the builder renders
`PropertyType.SECRET_TEXT` with `type='password'`
(`packages/web/src/app/builder/piece-properties/properties-utils.tsx`), `piecePropertiesUtils.buildSchema`
validates it as a string, and the web form seeds it with `''`. Only the factory and the union entry
are missing. Adding them is a framework change worth proposing on its own merits for every piece —
not something to smuggle in here.

Note that it would fix only the *display*. A step-level `SECRET_TEXT` value is still persisted
verbatim in the flow version, so removing passwords from flow storage altogether needs a
connection-based design, not a prop type.

## Internal-infrastructure escape hatch

The connection has an `isInternalInfrastructure` checkbox. When it is on, and only then,
`client.ts` reads two environment variables:

- `ORO_SERVER_URL` — replaces the connection's Server URL. It applies to **both** the token endpoint
  and the API base URL, and it is what the token cache key hashes, so flipping it does not reuse a
  token minted for the old host.
- `ORO_SERVER_USER_AGENT` — adds a `User-Agent` header to the token request and to every API
  request.

Both are ignored when the checkbox is off or the variable is empty. The `adminPrefix`, client id and
client secret always come from the connection.

## Gotchas

- `loadDropdownOptions` derives the sparse-fieldset param as `fields[resourceUri.slice(1)]`, which
  assumes `resourceUri` starts with `/`. Pass `'/customers'`, not `'customers'`, or you get
  `fields[ustomers]` and a silently ignored fieldset.
- `Serialize JSON:API Request` accepts a single-resource document and unwraps it, but **rejects a
  collection** (`data` is an array) with an explanatory error. Loop first.
- Props created inside `Property.DynamicProperties` never reach piece metadata, so the line-item
  field labels in `create-order.ts` and `create-invoice.ts` cannot be translated at all. Moving those
  props out of `DynamicProperties` into a plain `Property.Array` is the only fix, and it is a
  separate decision.
- `src/i18n/pl.json` and `src/i18n/uk.json` are never loaded. `pieceTranslation.initializeI18n`
  iterates `LocalesEnum` (`packages/core/utils/src/lib/locale.ts`), which has no Polish or
  Ukrainian. The gate keeps them in sync so they are ready if those locales are added, and
  `i18n:check` prints a warning for each.
- **An untouched `Property.Checkbox` arrives as `false`, not `undefined`.** The builder seeds an
  unset checkbox with `property.defaultValue ?? false`
  (`packages/web/src/features/pieces/utils/form-utils.tsx`) and persists it into the step input, and
  `checkboxProcessor` passes `false` through — it is the one property type whose "empty" form value is
  not normalised to `undefined` the way `textProcessor` and `numberProcessor` normalise theirs. So
  `p.enabled ?? undefined` is `false`, `pickDefined` keeps it, and `update-user` / `update-customer-user`
  send `enabled: false` on every call while `assertUpdateNotEmpty` can never fire for them. Fixing it
  means a three-state prop (a `Property.StaticDropdown` with a "leave unchanged" option, as in
  `campaign-monitor/src/lib/actions/update-subscriber-details.ts`), which changes the props and so
  needs an i18n regeneration — do not paper over it with a `defaultValue`, since `true` would
  unconditionally *enable* instead. Hand-written `propsValue` in `test/action-guards.test.ts` does not
  reproduce this; a builder-shaped case must include `enabled: false`.
- Line-item input is validated through `lineItemUtils` (`src/lib/common/line-items.ts`), not bare
  `Number()`. `Number(undefined)` is `NaN` and `JSON.stringify` serialises `NaN` as `null`, so an
  unvalidated missing quantity used to reach Oro as `null` with no error. Route any new line-item
  field through the helper.
