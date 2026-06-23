# QPay Gateway Starter

Minimal dependency-free Node.js integration for QPay v2.

## Setup

```bash
cp .env.example .env
node src/server.js
```

Fill `.env` with credentials from QPay:

- `QPAY_CLIENT_ID`
- `QPAY_CLIENT_SECRET`
- `QPAY_INVOICE_CODE`
- `QPAY_CALLBACK_URL`
- `PUBLIC_BASE_URL`

QPay's official developer docs describe OAuth credentials, sandbox token endpoint, invoice creation, callback URL, and payment check endpoints at https://developer.qpay.mn/.

## Create Invoice

```bash
curl -X POST http://localhost:4001/api/qpay/invoices \
  -H "Content-Type: application/json" \
  -d '{
    "orderId": "ORDER-1001",
    "amount": 1000,
    "description": "ORDER-1001 payment",
    "receiverCode": "terminal"
  }'
```

Response includes:

- `invoiceId`
- `paymentUrl`
- `qrText`
- `qrImage`
- `urls` for bank app deeplinks

Open `paymentUrl` to show a public payment page like:

```text
https://your-domain.mn/merchant_1/<qpayInvoiceId>/<orderId>
```

## Check Payment

```bash
curl -X POST http://localhost:4001/api/qpay/invoices/<invoiceId>/check
```

## Callback

Set QPay callback URL to:

```text
https://your-domain.mn/api/qpay/callback
```

For local testing, expose your server with a public tunnel and set `QPAY_CALLBACK_URL` to that public callback URL.

## Notes

This starter stores invoice state in `data/invoices.json`. For production, persist `orderId`, `invoiceId`, QPay status, payment id, and raw callback/check payloads in your database.

## Shopify Flow

Use this with Shopify as a manual payment flow:

1. Shopify Admin > Settings > Payments > Manual payment methods.
2. Create a custom method named `QPay`.
3. Shopify Admin > Settings > Notifications > Webhooks.
4. Create an `Order creation` webhook with JSON format.
5. Set webhook URL to `https://your-payment-domain.mn/api/shopify/orders/create`.
6. When an unpaid Shopify QPay/manual order arrives, this service creates a QPay invoice and stores a public payment page URL.
7. Use QPay callback or `POST /api/qpay/invoices/<invoiceId>/check` to confirm payment.

Set these Shopify values in `.env`:

```text
SHOPIFY_SHOP_DOMAIN=your-store.myshopify.com
SHOPIFY_ADMIN_ACCESS_TOKEN=shpat_or_custom_app_token
SHOPIFY_WEBHOOK_SECRET=your_shopify_webhook_secret
SHOPIFY_API_VERSION=2026-04
SHOPIFY_QPAY_GATEWAY_NAMES=qpay,manual
SHOPIFY_MARK_PAID=false
```

`SHOPIFY_WEBHOOK_SECRET` enables HMAC validation for Shopify webhooks. `SHOPIFY_ADMIN_ACCESS_TOKEN` lets this service write the `QPay payment URL` note attribute and `qpay-pending` tag back to the Shopify order.

Keep `SHOPIFY_MARK_PAID=false` until you test transaction creation on your store. When enabled, the QPay callback/payment check attempts to create a successful Shopify transaction and tags the order `qpay-paid`.

## Shopify Webhook Endpoint

```text
POST /api/shopify/orders/create
```

Expected Shopify event:

```text
Order creation
```

The endpoint skips orders whose gateway does not match `SHOPIFY_QPAY_GATEWAY_NAMES`.
