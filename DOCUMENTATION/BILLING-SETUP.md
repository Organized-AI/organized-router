# Billing Setup

Two lines, one invoice, one subscription.

```
 Stripe Product: Organized Router
   |
   +-- Price A   licensed, $50.00 / month           -> flat subscription
   |
   +-- Price B   metered, unit_amount_decimal 0.05  -> savings share
                   |
                   +-- Meter: organized_router_savings_share
                         aggregation: sum
                         value key:   value          (savings in CENTS)
                         customer:    by_id via stripe_customer_id
```

## Why savings-in-cents as the meter value

The Worker could emit the already-computed share and bill 1 cent per unit. It does not, because
then the invoice line reads "2000 units" and means nothing to the customer.

Emitting the raw savings in cents and charging 0.05 cents per unit produces the same total and a
line item whose quantity IS the auditable number. A customer who saved $400.00 sees a quantity of
40,000 and a charge of $20.00, and can reconcile that against `/api/billing/preview` line by line.

```
saved_cents = round((cost(baseline) - cost(selected) - probe_cost) * 100)
meter value = max(0, saved_cents)
charge      = saved_cents * $0.0005 = 5% of savings
```

`unit_amount_decimal` accepts up to 12 decimal places, so 0.05 is exact. No rounding drift.

## Order of operations

1. Meter first. A metered price cannot be created without a meter id to bind to.
2. Price second, on the SAME product as the $50 price. Same product plus same interval is what
   puts both lines on one invoice.
3. Subscription with both prices as items. The metered item takes no quantity at creation.
4. Meter events from the queue consumer, never from the request path.

## Test mode first

Meters and metered prices are not deletable in the way you would want when you get the value key
wrong. Run the script with `TEST=1` and a test key, send a few meter events, pull a draft invoice,
and confirm the arithmetic before touching live.

## Verification

```
stripe billing meters list
stripe billing meter-event-summaries list --meter mtr_XXX \
  --customer cus_XXX --start-time <unix> --end-time <unix>
stripe invoices upcoming --customer cus_XXX
```

The upcoming invoice should show two lines: $50.00 flat, and the share with quantity equal to the
cents saved in the period.
