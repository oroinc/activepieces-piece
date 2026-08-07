# OroCommerce piece

Actions and a webhook trigger for the OroCommerce back-office JSON:API.

This repo bans code comments, so the non-obvious rules of this piece live here. Read the sections
below before changing anything under `src/` — most of them exist because of a bug that is easy to
reintroduce.

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

## Local development

```bash
npx turbo run test  --filter=@activepieces/piece-orocommerce   # vitest (builds first)
npx turbo run lint  --filter=@activepieces/piece-orocommerce
npx turbo run build --filter=@activepieces/piece-orocommerce   # tsc -p tsconfig.lib.json, also the type-check
npm run lint-dev                                               # repo-wide lint with auto-fix
```

There is no `typecheck` script in this package, so the root `typecheck` task is a no-op here — the
build is the type-check.

**CI does not run these tests.** `.github/workflows/ci.yml` builds pieces touched by the diff, but
its test step is a hardcoded filter list (`@activepieces/engine`, `@activepieces/shared`,
`@activepieces/ai-providers`) that does not include this piece. `test/jsonapi-roundtrip.test.ts`
guards the serialize/deserialize contract above and is local-only today — run it yourself before
touching `src/lib/common/jsonapi/`.

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
- Piece i18n keys live in `src/i18n/translation.json` (identity-mapped English).
