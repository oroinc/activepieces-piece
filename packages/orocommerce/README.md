# OroCommerce piece for Activepieces

Automate [OroCommerce](https://oroinc.com/orocommerce/) from
[Activepieces](https://www.activepieces.com/): create and update customers, storefront and
back-office users, orders and invoices, and start flows from OroCommerce webhook events.

- Supported: Activepieces 0.92.0 and later
- Licence: MIT
- Source: [github.com/oroinc/activepieces-piece](https://github.com/oroinc/activepieces-piece)

## Install

As a platform admin: **Platform Setup → Pieces → Install Piece**.

| Field | Value |
| --- | --- |
| **Package Type** | **NPM Registry** |
| **Piece Name** | `@oroinc/piece-orocommerce` |
| **Piece Version** | the exact version, for example `1.0.0` |

Each [GitHub release](https://github.com/oroinc/activepieces-piece/releases) has the same `.tgz` and
its sha256.

## Connection

In OroCommerce: **System → User Management → OAuth Applications → Create OAuth Application**, grant
**Client Credentials**, save, copy the Client ID and Client Secret.

In Activepieces:

| Field | Value |
| --- | --- |
| **Server URL** | e.g. `https://your-store.com` |
| **Admin Prefix** | usually `admin` |
| **Client ID** / **Client Secret** | from the OAuth application |
| **Default HTTP Headers** | optional JSON object sent with every request |
| **Internal infrastructure** | leave off, see [Environment variables](#environment-variables) |
| **Verify TLS certificate** | leave on, see below |

- The Server URL must be the final address: redirects (http to https, to www, to a login page) are
  not followed and fail the step.
- The OAuth application's user needs read access to regions: the connection check reads one.
- The OAuth application's organization limits what the connection can see. A record from another
  organization returns `403 No access to the entity`. Use one connection per organization.

### Private certificates

For a server whose certificate comes from a private CA, prefer trusting that CA over turning
verification off: point `NODE_EXTRA_CA_CERTS` at the CA file (PEM), see
[Environment variables](#environment-variables). Turning **Verify TLS certificate** off is the
alternative for a trusted internal URL; it affects that connection only.

For connections with **Internal infrastructure** on, `ORO_SERVER_VERIFY_TLS` overrides the
**Verify TLS certificate** option for all of them at once, connections that already exist included.
Its values are listed under [Environment variables](#environment-variables). For an internal CA,
trusting it with `NODE_EXTRA_CA_CERTS` stays the safer choice.

### Proxy

With Node's `NODE_USE_ENV_PROXY=1`, requests, the token request included, go through the proxy set
in `https_proxy` or `http_proxy`, except to hosts in `no_proxy`, like those of every other piece
that sends with Node's `fetch`; see [Environment variables](#environment-variables). Without it, or
with no proxy set, requests connect directly. **Verify TLS certificate** and `ORO_SERVER_VERIFY_TLS` apply
through the proxy too. Proxy credentials go in the proxy URL, for example
`http://user:password@proxy.internal:3128`, and are sent to the proxy only. An https proxy with its
own private CA is not covered.

### User-Agent

Every request, the token request included, sends `User-Agent: oroinc-piece-orocommerce/<version>`,
for example `oroinc-piece-orocommerce/1.0.0`. To send another, put `{"User-Agent": "..."}` in
**Default HTTP Headers**, or turn **Internal infrastructure** on and set `ORO_SERVER_USER_AGENT`
(see [Environment variables](#environment-variables)); that one wins over the connection's. A
User-Agent set on a step wins on that step's request.

### Environment variables

| Variable | Read when | Effect |
| --- | --- | --- |
| `ORO_SERVER_URL` | **Internal infrastructure** on | replaces the connection's **Server URL**; see [Internal and external Oro in one Activepieces](#internal-and-external-oro-in-one-activepieces) |
| `ORO_SERVER_USER_AGENT` | **Internal infrastructure** on | User-Agent for every request; one set on a step still wins on that step |
| `ORO_SERVER_VERIFY_TLS` | **Internal infrastructure** on | overrides **Verify TLS certificate**: `false`, `0`, `no` or `off` turns verification off, `true`, `1`, `yes` or `on` turns it on, in any case; unset or empty leaves it to the checkbox; any other value verifies and logs a warning once |
| `NODE_USE_ENV_PROXY` | always, when the engine starts | Node's own switch for the proxy variables below: only `1` turns it on, for this piece and every other piece that sends with Node's `fetch` |
| `https_proxy`, `http_proxy`, `no_proxy` (or upper case; lower case wins) | with `NODE_USE_ENV_PROXY=1`, when the engine starts | proxy for every request: `https_proxy` for https, falling back to `http_proxy`; hosts in `no_proxy` are reached directly, see [Internal and external Oro in one Activepieces](#internal-and-external-oro-in-one-activepieces) |
| `NODE_EXTRA_CA_CERTS` | always, when the engine starts | trusts the CA certificates in that PEM file; preferred over turning verification off |

Set them on the worker container. Of the worker's own variables, the engine that runs the piece
sees only those listed in `AP_SANDBOX_PROPAGATED_ENV_VARS` on the app container, so list each name
there too (one comma-separated list; in the default setup both are the one container), and restart
after changing any of them.

### Internal and external Oro in one Activepieces

One Activepieces can connect to an internal and an external Oro at the same time, with one
connection each. Turn **Internal infrastructure** on for the internal connection only:
`ORO_SERVER_URL`, `ORO_SERVER_USER_AGENT` and `ORO_SERVER_VERIFY_TLS` apply only to connections
that have it on. The external connection keeps its own **Server URL**, **Verify TLS certificate**
and User-Agent, and with `NODE_USE_ENV_PROXY=1` it goes through the proxy. For the internal
connection to reach its server directly, list the internal host in `no_proxy`. It is matched per
host, so use the exact host name: on Node 24.14.0 this piece and Node's own `fetch` match domain
suffixes and wildcards differently. In **Custom API Call** on the internal connection, enter a path
such as `customers`; a full URL is sent to the host it names. List every one of these variables in
`AP_SANDBOX_PROPAGATED_ENV_VARS`. The worker itself needs `NODE_USE_ENV_PROXY=1` as well, since it
downloads pieces with Node's `fetch`.

## Actions

| Action | What it does |
| --- | --- |
| **Create / Update Customer** | Customer (company) records |
| **Create / Update Customer User** | Storefront accounts, with addresses |
| **Create / Update User** | Back-office users, roles, groups, business units |
| **Create Order** | Order with line items and addresses |
| **Create Invoice** | Invoice with line items and an optional PDF |
| **Custom API Call** | Any other OroCommerce JSON:API endpoint |
| **Serialize / Unserialize JSON:API** | Convert between a flat object and a JSON:API document |

- Update actions change only the fields you fill in.
- Multi-selects on update actions (roles, groups, business units, organizations) replace the whole
  list.

## Trigger

**Oro Webhook Event** starts a flow on the selected OroCommerce webhook topic. Enabling the trigger
registers the webhook in Oro; disabling it removes it.

- An entity has no topics until **System → Entities → Entity Management → the entity → Webhook
  accessible = Yes**.
- **Sign webhook deliveries** is on by default: unsigned or wrongly signed deliveries are dropped
  without a run (see "webhook delivery discarded" in the worker log). Turn it off only if a proxy
  rewrites the request body.
- To rotate the secret, disable and re-enable the trigger.

## Versions

Semantic versioning. A flow keeps the piece version it was built with; to upgrade, install the new
version, then update each flow's steps. Changes:
[CHANGELOG.md](https://github.com/oroinc/activepieces-piece/blob/main/packages/orocommerce/CHANGELOG.md).

## Issues

<https://github.com/oroinc/activepieces-piece/issues> - include the OroCommerce and Activepieces
versions, the step and the error text. No secrets or customer data.

## Licence

MIT, see [LICENSE](https://github.com/oroinc/activepieces-piece/blob/main/LICENSE). Bundled
third-party code is listed in `NOTICE`.
