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

- The OAuth application's user needs read access to regions: the connection check reads one.
- The OAuth application's organization limits what the connection can see. A record from another
  organization returns `403 No access to the entity`. Use one connection per organization.

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
