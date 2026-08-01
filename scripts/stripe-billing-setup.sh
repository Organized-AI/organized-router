#!/usr/bin/env bash
# Organized Router billing setup.
# Creates the savings-share meter and a metered price bound to it, on the SAME product
# as the $50 subscription so both land on one invoice.
#
# Requires: stripe CLI, authenticated against the Organized AI account.
# Run with TEST=1 to operate in test mode first. Do that.

set -euo pipefail

PRODUCT_ID="${PRODUCT_ID:?set PRODUCT_ID to the Organized Router product id}"
MODE_FLAG=""
[ "${TEST:-0}" = "1" ] && MODE_FLAG="--api-key ${STRIPE_TEST_KEY:?set STRIPE_TEST_KEY when TEST=1}"

echo "==> 1. Create the savings-share meter"
METER_JSON=$(stripe billing meters create $MODE_FLAG \
  --display-name "Savings Share" \
  --event-name "organized_router_savings_share" \
  -d "default_aggregation[formula]=sum" \
  -d "value_settings[event_payload_key]=value" \
  -d "customer_mapping[type]=by_id" \
  -d "customer_mapping[event_payload_key]=stripe_customer_id")
METER_ID=$(echo "$METER_JSON" | jq -r '.id')
echo "    meter: $METER_ID"

echo "==> 2. Create the metered price bound to that meter"
# The Worker emits the SAVINGS in cents as the meter value.
# unit_amount_decimal 0.05 charges 0.05 cents per cent saved = exactly 5%.
# The invoice line quantity is then the raw savings in cents, which is the auditable number.
PRICE_JSON=$(stripe prices create $MODE_FLAG \
  --product "$PRODUCT_ID" \
  --currency usd \
  --nickname "Savings share 5%" \
  --billing-scheme per_unit \
  -d "unit_amount_decimal=0.05" \
  -d "recurring[interval]=month" \
  -d "recurring[usage_type]=metered" \
  -d "recurring[meter]=$METER_ID")
SHARE_PRICE_ID=$(echo "$PRICE_JSON" | jq -r '.id')
echo "    price: $SHARE_PRICE_ID"

echo
echo "==> Done. Record these:"
echo "    STRIPE_PRODUCT_ID=$PRODUCT_ID"
echo "    STRIPE_METER_ID=$METER_ID"
echo "    STRIPE_SHARE_PRICE_ID=$SHARE_PRICE_ID"
echo
echo "==> 3. A subscription carrying BOTH lines on one invoice:"
cat <<CMD

stripe subscriptions create \\
  --customer cus_XXXX \\
  -d "items[0][price]=<the \$50 monthly price id>" \\
  -d "items[1][price]=$SHARE_PRICE_ID"

CMD
echo "==> 4. Report a savings event (value is savings in CENTS, not dollars):"
cat <<CMD

stripe billing meter-events create \\
  --event-name organized_router_savings_share \\
  -d "payload[stripe_customer_id]=cus_XXXX" \\
  -d "payload[value]=40000"     # \$400.00 saved -> \$20.00 share

CMD
