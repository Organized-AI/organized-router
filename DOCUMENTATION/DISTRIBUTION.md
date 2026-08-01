# Distribution

The repository is public and MIT. There is nothing to gate. GitPaywall is used here in
email-capture mode only: a free wall that trades a contact for a bundle, on top of a
codebase anyone can already clone.

## What the wall gates

Not the source. The wall sits in front of assets that are genuinely worth an email and
that do not belong in the repo:

| Asset | Why it is not in the repo |
|---|---|
| Provider error fixture corpus | Real captured 4xx bodies from Anthropic, OpenAI, Gemini, OpenRouter. Large, and regenerated as providers change |
| Catalog snapshot (JSON) | A point-in-time dump of verified patches, importable straight into KV |
| Receipt digest script | `receipt.py`, the local token-receipt miner, versioned separately |

Anyone who clones and builds gets all of this eventually by running the thing. The wall
just saves them the work.

## Setup

1. Install the GitPaywall GitHub App and import `Organized-AI/organized-router`.
2. Create a paywall of type **email**, not payment. Email capture is free; GitPaywall's
   revenue share only applies to paid walls, and there is no paid wall here.
3. Set the invite permission to **read**. The repository is public, so the invite is
   cosmetic. What matters is the captured contact.
4. Configure the outbound webhook from the Customers tab. Payload carries email, git
   handle, created timestamp, paywall id, and paywall type.
5. Route the webhook to the router worker at `POST /api/lead`. It writes to D1 `leads`
   and fires a `sign_up` event through sGTM.

## Funnel

```
public repo / README
        |
        v
  email wall  ->  fixtures + catalog snapshot + receipt.py
        |
        v
  receipt.py run locally  ->  user sees their own token spend
        |
        v
  hosted trial  ->  $50/month + 5% of verified savings
```

The receipt is the hinge. Someone who has seen their own numbers has a baseline, and a
baseline is what the savings share is measured against. The email is worth having only
because it leads there.

## Tracking

Events into `GTM-XXXXXXX`, forwarded through sGTM `GTM-YYYYYYY` at
`<your-subdomain>.stape.io` to GA4 `G-XXXXXXXXXX`, Google Ads Enhanced Conversions, and
Meta CAPI.

| Event | Fires |
|---|---|
| `sign_up` | GitPaywall email webhook received |
| `receipt_pushed` | user pushes a receipt digest |
| `first_route` | first request through the hosted router |
| `first_recovery` | first successful patched retry |
| `purchase` | subscription activation, value 50.00 USD |
| `savings_share_billed` | value = actual share |

Dedupe browser and server events on `event_id`. Purchase must carry a real value.
