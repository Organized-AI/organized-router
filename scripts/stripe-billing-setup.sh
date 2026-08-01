#!/usr/bin/env bash
# Organized Router billing setup - version-agnostic.
#
# Uses `stripe post` raw API passthrough rather than the `stripe billing meters`
# subcommand. The sugar subcommands change shape between CLI releases; the raw
# endpoint does not. This script works on any CLI new enough to have `stripe post`.
#
# Requires: stripe CLI (authenticated), jq.
# ALWAYS run with TEST=1 first. A meter with a wrong value_settings key is not
# cleanly deletable.

set -euo pipefail

PRODUCT_ID="${PRODUCT_ID:?set PRODUCT_ID to the Organized Router product id}"
EVENT_NAME="${EVENT_NAME:-organized_router_savings_share}"

ARGS=()
if [ "${TEST:-0}" = "1" ]; then
  ARGS+=(--api-key "${STRIPE_TEST_KEY:?set STRIPE_TEST_KEY when TEST=1}")
  echo "MODE: test"
else
  echo "MODE: LIVE. Ctrl-C now if that is not what you meant."; sleep 3
fi

api() { stripe "$@" "${ARGS[@]}"; }

echo "==> 0. Preflight"
command -v jq >/dev/null || { echo "jq required"; exit 1; }
stripe version >/dev/null || { echo "stripe CLI required"; exit 1; }
api get /v1/products/"$PRODUCT_ID" >/dev/null || { echo "product $PRODUCT_ID not found in this mode"; exit 1; }

echo "==> 1. Meter (idempotent on event_name)"
EXISTING=$(api get /v1/billing/meters -d limit=100 \
  | jq -r --arg e "$EVENT_NAME" '.data[] | select(.event_name==$e and .status=="active") | .id' | head -1)

if [ -n "$EXISTING" ]; then
  METER_ID="$EXISTING"
  echo "    reusing: $METER_ID"
else
  METER_ID=$(api post /v1/billing/meters \
    -d "display_name=Savings Share" \
    -d "event_name=$EVENT_NAME" \
    -d "default_aggregation[formula]=sum" \
    -d "value_settings[event_payload_key]=value" \
    -d "customer_mapping[type]=by_id" \
    -d "customer_mapping[event_payload_key]=stripe_customer_id" | jq -r '.id')
  echo "    created: $METER_ID"
fi
[ -n "$METER_ID" ] && [ "$METER_ID" != "null" ] || { echo "meter creation failed"; exit 1; }

echo "==> 2. Metered price bound to the meter"
# Worker emits SAVINGS IN CENTS as the meter value.
# 0.05 cents per cent saved = exactly 5%. Invoice quantity is the auditable number.
SHARE_PRICE_ID=$(api post /v1/prices \
  -d "product=$PRODUCT_ID" \
  -d "currency=usd" \
  -d "nickname=Savings share 5%" \
  -d "billing_scheme=per_unit" \
  -d "unit_amount_decimal=0.05" \
  -d "recurring[interval]=month" \
  -d "recurring[usage_type]=metered" \
  -d "recurring[meter]=$METER_ID" | jq -r '.id')
echo "    created: $SHARE_PRICE_ID"

echo "==> 3. Verify"
api get /v1/prices/"$SHARE_PRICE_ID" | jq '{id, unit_amount_decimal, recurring}'

cat <<SUMMARY

Record these:
  STRIPE_PRODUCT_ID=$PRODUCT_ID
  STRIPE_METER_ID=$METER_ID
  STRIPE_SHARE_PRICE_ID=$SHARE_PRICE_ID

One subscription, both lines, one invoice:
  stripe post /v1/subscriptions ${ARGS[*]:-} \\
    -d "customer=cus_XXXX" \\
    -d "items[0][price]=<the \$50 monthly price id>" \\
    -d "items[1][price]=$SHARE_PRICE_ID"

Report savings (value in CENTS SAVED, not dollars, not the share):
  stripe post /v1/billing/meter_events ${ARGS[*]:-} \\
    -d "event_name=$EVENT_NAME" \\
    -d "payload[stripe_customer_id]=cus_XXXX" \\
    -d "payload[value]=40000"      # \$400.00 saved -> \$20.00 share

Confirm the arithmetic before going live:
  stripe get /v1/invoices/upcoming ${ARGS[*]:-} -d customer=cus_XXXX
SUMMARY
