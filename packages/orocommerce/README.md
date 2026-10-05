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
| **Internal infrastructure** | leave off |
| **Verify TLS certificate** | leave on, see below |

- The OAuth application's user needs read access to regions: the connection check reads one.
- The OAuth application's organization limits what the connection can see. A record from another
  organization returns `403 No access to the entity`. Use one connection per organization.

### Private certificates

For a server whose certificate comes from a private CA, prefer trusting that CA over turning
verification off: set `NODE_EXTRA_CA_CERTS` to the CA file (PEM) on the worker container and
`AP_SANDBOX_PROPAGATED_ENV_VARS=NODE_EXTRA_CA_CERTS` on the app container (both on the one container
in the default single-container setup). The worker starts the engine with an allowlisted
environment, so the first setting alone does not reach the piece. Restart after changing either.
Turning **Verify TLS certificate** off is the alternative for a trusted internal URL; it affects
that connection only.

For connections with **Internal infrastructure** on, `ORO_SERVER_VERIFY_TLS` on the worker container
overrides **Verify TLS certificate**: `false`, `0`, `no` or `off` turns verification off, and `true`,
`1`, `yes` or `on` turns it on, in any case. Unset or empty, each connection's own setting decides;
any other value verifies and logs a warning once. Like `ORO_SERVER_USER_AGENT`, it reaches the piece
only if `AP_SANDBOX_PROPAGATED_ENV_VARS` on the app container lists it; restart after changing it.
Connections that already exist follow it without being edited. For an internal CA, trusting it with
`NODE_EXTRA_CA_CERTS` stays the safer choice.

### Proxy

Requests go through the proxy named in `https_proxy`, `http_proxy` and `no_proxy` (or the upper-case
names). These reach the piece the same way as the CA file above: set them on the worker container
and list the same names in `AP_SANDBOX_PROPAGATED_ENV_VARS` on the app container (one comma-separated
list, next to `NODE_EXTRA_CA_CERTS` if that is set), then restart. With none of them set, requests
connect directly, as before. **Verify TLS certificate** and `ORO_SERVER_VERIFY_TLS` apply through
the proxy too. Proxy credentials go in the proxy URL, for example
`http://user:password@proxy.internal:3128`. An https proxy with its own private CA is not covered.

### User-Agent

Every request, the token request included, sends `User-Agent: oroinc-piece-orocommerce/<version>`,
for example `oroinc-piece-orocommerce/1.0.0`. To send another, put `{"User-Agent": "..."}` in
**Default HTTP Headers**, or turn **Internal infrastructure** on and set `ORO_SERVER_USER_AGENT` on
the worker container with `AP_SANDBOX_PROPAGATED_ENV_VARS=ORO_SERVER_USER_AGENT` on the app
container; that one wins over the connection's. A User-Agent set on a step wins on that step's
request.

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
