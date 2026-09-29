# OroCommerce piece for Activepieces

Automate [OroCommerce](https://oroinc.com/orocommerce/) from
[Activepieces](https://www.activepieces.com/): create and update customers, storefront and
back-office users, orders and invoices, and start flows from OroCommerce webhook events. Everything
runs against the OroCommerce back-office JSON:API.

| | |
| --- | --- |
| Package | `@oroinc/piece-orocommerce` |
| Actions | 11 |
| Triggers | 1 (Oro Webhook Event) |
| Supported Activepieces | 0.92.0 and later |
| Licence | MIT |
| Source | [github.com/oroinc/activepieces-piece](https://github.com/oroinc/activepieces-piece) |

## Install

Installing a piece is a platform admin action, on an instance running Activepieces 0.92.0 or later.

Sign in as a platform admin, open **Platform Setup → Pieces**, and click **Install Piece**. In the
**Install a piece** dialog:

| Field | Value |
| --- | --- |
| **Package Type** | **NPM Registry** |
| **Piece Name** | `@oroinc/piece-orocommerce` |
| **Piece Version** | the exact version, for example `1.0.0` |

Then click **Install**.

Every [release](https://github.com/oroinc/activepieces-piece/releases) also attaches the packed
piece as a `.tgz` and records its sha256 in the release notes. It is the same artifact that is
published here, so that checksum is how anyone can confirm that what npm serves is what Oro
released. Whether the `.tgz` can be uploaded instead depends on the edition: **Package Type →
Packed Archive (.tgz)** is disabled unless the instance runs an edition above Community and its
platform plan allows managing pieces. On Community Edition, install from npm.

## Setting up a connection

The piece authenticates with **OAuth 2.0 Client Credentials**. Create the credentials in Oro first:

1. Log in to your OroCommerce admin panel.
2. Go to **System → User Management → OAuth Applications**.
3. Click **Create OAuth Application**:
   - **Application Name** - anything descriptive, e.g. `Activepieces Integration`.
   - **Grants** - select **Client Credentials**.
   - **Redirect URIs** - leave empty, the Client Credentials flow does not use them.
4. Save, then copy the **Client ID** and **Client Secret**.

Then add the connection in Activepieces:

| Field | Value |
| --- | --- |
| **Server URL** | Base URL of your instance, e.g. `https://your-store.com` |
| **Admin Prefix** | Admin panel prefix, usually `admin` |
| **Client ID** / **Client Secret** | From the OAuth application above |
| **Default HTTP Headers** | Optional JSON object sent with every request of this piece |
| **Internal infrastructure** | Leave off unless you run Oro's own hosted infrastructure |

Activepieces validates the connection by reading a region record, so the OAuth application's user
needs read access to regions. Without it the connection is reported invalid even when the
credentials are correct.

**The OAuth application's organization scopes every record the connection can reach.** A customer,
order or user that belongs to another organization answers `403 No access to the entity` - the same
status a missing permission produces, so it reads as an authentication problem when it is not one. If
a record you can see in the back office is invisible to a step, check the organization on the OAuth
application's user before touching its roles. On a multi-organization instance you need one connection
per organization.

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
rather than reporting success on an empty request.

**The multi-select props on the update actions replace the whole list, they do not add to it.**
Roles, groups, business units and organizations are labelled "(replaces all existing …)" for that
reason: sending one role removes the others, so include everything the record should keep.

## Trigger

**Oro Webhook Event** starts a flow when the selected OroCommerce webhook topic fires. The topic
dropdown lists only the topics your connection can read. Enabling the trigger registers the webhook
in Oro; disabling it removes the registration.

An entity publishes no topics until it is opened up in Oro: **System → Entities → Entity Management →
the entity → Webhook accessible = Yes**. Until then the Topic dropdown offers nothing for it, and
publishing a flow whose trigger names one of its topics fails with `valid webhook topic constraint`.

**Sign webhook deliveries** is on by default. Enabling the trigger then generates a secret, hands it
to Oro at registration, and every later delivery must carry a matching `Webhook-Signature` header or
it is discarded without starting a run. Turn it off only when something between Oro and Activepieces
rewrites the request body - the signature covers the exact bytes delivered, so a proxy that
re-encodes the body makes every delivery fail verification. With signing off, anyone who learns the
webhook URL can start the flow with a payload of their choosing.

The secret cannot be read back or changed after registration. To rotate it, disable and re-enable
the trigger, which deletes the old webhook and registers a new one.

A rejected delivery creates no run and Oro still gets its 200, so a wrong secret looks like silence.
If a signed trigger goes quiet, check the worker logs for "webhook delivery discarded".

## Versions and upgrading

The package follows [semantic versioning](https://semver.org/). A major version means a flow
somebody has already built can break; a minor version adds an action, a trigger or an optional
prop; a patch leaves the piece's surface as it was.

A flow pins the exact piece version it was built with, so installing a newer version does not move
existing flows onto it. An upgrade is two steps: install the new version, then update each flow's
step to it. Both versions stay installed until you remove the old one, so flows can be moved over
one at a time.

What changed in each version is in
[CHANGELOG.md](https://github.com/oroinc/activepieces-piece/blob/main/packages/orocommerce/CHANGELOG.md).

## Reporting issues

Open an issue at <https://github.com/oroinc/activepieces-piece/issues> with your OroCommerce
version, the Activepieces version, the action or trigger involved, and the error text from the run
log. Do not paste client secrets, tokens or customer data.

## Licence

MIT; see
[LICENSE](https://github.com/oroinc/activepieces-piece/blob/main/LICENSE). Most of what this package
contains is not written by Oro: the bundler inlines the Activepieces framework and every npm package
the piece reaches into a single `src/index.js`, and the `NOTICE` file shipped beside it lists each of
them with its full licence text.

The source, the build and the contribution guide are at
<https://github.com/oroinc/activepieces-piece>.
