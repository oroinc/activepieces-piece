# Changelog

Semantic versioning: https://semver.org/

## 1.0.0

* First release as `@oroinc/piece-orocommerce`.
* 11 actions: Create/Update Customer, Create/Update Customer User, Create/Update User, Create Order,
  Create Invoice, Custom API Call, Serialize JSON:API Request, Unserialize JSON:API Response.
* Serialize JSON:API Request supports `"_meta": {"update": true}` on embedded records.
* Trigger: Oro Webhook Event, signed deliveries on by default; deliveries that cannot be verified
  are discarded.
* TLS certificates are verified unless the connection's Verify TLS certificate (on by default) is
  turned off. For connections with Internal infrastructure on, `ORO_SERVER_VERIFY_TLS` (`true` or
  `false`, listed in `AP_SANDBOX_PROPAGATED_ENV_VARS`) overrides it.
* With Node's `NODE_USE_ENV_PROXY=1`, requests go through the proxy set in `https_proxy`,
  `http_proxy` and `no_proxy` (or the upper-case names), like those of every other piece that sends
  with Node's `fetch`. All of them reach the piece only when `AP_SANDBOX_PROPAGATED_ENV_VARS` lists
  them. Verify TLS certificate applies through the proxy too.
* Requests, the token request included, send `User-Agent: oroinc-piece-orocommerce/<version>`
  unless Default HTTP Headers or `ORO_SERVER_USER_AGENT` sets another.
* The connection sets the Authorization header; one in Default HTTP Headers or on a step is ignored.
* Custom API Call gets a new token and retries once after a 401.
* Default HTTP Headers that are not valid JSON fail the step instead of being ignored.
* Step errors show the HTTP status and the response body only, and failed requests are logged as
  one line with method, address and status, without bodies or credentials, so neither holds the
  client secret.
* Redirects are not followed: a 3xx fails the step and the connection check, naming the redirect
  target, instead of quietly reaching another address. Custom API Call's own request keeps its
  Follow redirects option.
* Password is create-only (Create User, Create Customer User).
* English only.
* Requires Activepieces 0.92.0 or later.
* Known limitations: Custom API Call props come from upstream Activepieces.
