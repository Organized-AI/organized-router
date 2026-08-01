# Configuration

Every identifier in the docs is a placeholder. Supply your own.

| Placeholder | What it is | Where to find it |
|---|---|---|
| `${CF_ACCOUNT_ID}` | Cloudflare account id | Cloudflare dashboard, any zone overview |
| `${CF_ZONE_ID}` | Cloudflare zone id for your domain | zone overview, API section |
| `acct_XXXXXXXXXXXXXXXX` | Stripe account id | Stripe dashboard, account settings |
| `GTM-XXXXXXX` | GTM web container | Tag Manager container settings |
| `GTM-YYYYYYY` | server-side GTM container | Tag Manager, server container |
| `G-XXXXXXXXXX` | GA4 measurement id | GA4 admin, data streams |
| `<your-subdomain>.stape.io` | sGTM endpoint | Stape container settings |

None of these are credentials. They are identifiers, and several are visible in any page
source. They are placeholders so a fork does not accidentally ship someone else's
container ids.

Real secrets never appear in this repository. They go to `wrangler secret put` and are
read from the Worker environment at runtime.
