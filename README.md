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
- `STORE_PREFIX`

QPay's official developer docs describe OAuth credentials, sandbox token endpoint, invoice creation, callback URL, and payment check endpoints at https://developer.qpay.mn/.

`STORE_PREFIX` is optional, but recommended when you run the same gateway code for more than one Shopify store. It keeps QPay/HiPay invoice identifiers unique, for example `SUNBEAM-#1113` and `STORE2-#1113`.

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
SHOPIFY_CLIENT_ID=your_shopify_app_client_id
SHOPIFY_CLIENT_SECRET=your_shopify_app_client_secret
SHOPIFY_WEBHOOK_SECRET=your_shopify_webhook_secret
SHOPIFY_API_VERSION=2026-07
SHOPIFY_QPAY_GATEWAY_NAMES=qpay,manual
SHOPIFY_MARK_PAID=false
```

`SHOPIFY_WEBHOOK_SECRET` enables HMAC validation for Shopify webhooks. `SHOPIFY_CLIENT_ID` and `SHOPIFY_CLIENT_SECRET` let this service request Shopify Admin API tokens automatically with the client credentials grant, then write the `QPay payment URL` note attribute and `qpay-pending` tag back to the Shopify order.

If you have a legacy admin-created custom app token, you can use `SHOPIFY_ADMIN_ACCESS_TOKEN` instead of `SHOPIFY_CLIENT_ID` and `SHOPIFY_CLIENT_SECRET`.

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

## Custom Checkout

Hosted checkout URL:

```text
https://your-payment-domain.mn/checkout?items=<variantId>:<quantity>,<variantId>:<quantity>
```

Example:

```text
https://qpay-shopify-gateway.onrender.com/checkout?items=123456789:1,987654321:2
```

The checkout page creates a Shopify draft order, creates a QPay invoice, stores the payment URL on the draft order, and redirects the customer to the QPay QR page. When QPay reports the invoice as paid, the service completes the draft order and creates the real paid Shopify order.

Required Shopify app scopes for custom checkout:

```text
read_orders,write_orders,read_products,read_draft_orders,write_draft_orders
```

Set shipping defaults in Render:

```text
CUSTOM_CHECKOUT_SHIPPING_PRICE=7000
CUSTOM_CHECKOUT_SHIPPING_TITLE=Delivery
CUSTOM_CHECKOUT_FREE_SHIPPING_THRESHOLD=0
```

To redirect the cart checkout button from a Shopify theme, build the `items` query from `/cart.js`:

```html
<script>
document.addEventListener("submit", async (event) => {
  if (!event.target.matches('form[action="/cart"]')) return;
  const submitter = event.submitter;
  if (!submitter || !/checkout/i.test(submitter.name + " " + submitter.value + " " + submitter.textContent)) return;

  event.preventDefault();
  const cart = await fetch("/cart.js").then((response) => response.json());
  const items = cart.items.map((item) => `${item.variant_id}:${item.quantity}`).join(",");
  location.href = `https://qpay-shopify-gateway.onrender.com/checkout?items=${encodeURIComponent(items)}`;
});
</script>
```

## HiPay

HiPay can be opened from the payment page's `Hipay` button. The service creates a HiPay checkout for the same Shopify draft order amount and sends the customer to the HiPay app/web payment form.

Render environment variables:

```text
HIPAY_BASE_URL=https://test.hipay.mn
HIPAY_CLIENT_ID=sunbeam1
HIPAY_CLIENT_SECRET=...
HIPAY_REDIRECT_URL=https://qpay-shopify-gateway.onrender.com/api/hipay/redirect
HIPAY_WEBHOOK_URL=https://qpay-shopify-gateway.onrender.com/api/hipay/callback
```

HiPay docs used:

- Create invoice: https://developers.hipay.mn/checkout/
- Payment form: https://developers.hipay.mn/payment/
- Payment webhook: https://developers.hipay.mn/response-webhook/
- Deeplink: https://developers.hipay.mn/payment-deeplink/

## Multiple Stores

The simplest multi-store setup is one Render Web Service per Shopify store, all connected to the same GitHub repository.

Example:

```text
qpay-shopify-gateway-sunbeam
qpay-shopify-gateway-store2
```

Each Render service must have its own environment variables:

```text
PUBLIC_BASE_URL=https://store2-gateway.onrender.com
STORE_PREFIX=STORE2
SHOPIFY_SHOP_DOMAIN=second-store.myshopify.com
SHOPIFY_CLIENT_ID=...
SHOPIFY_CLIENT_SECRET=...
QPAY_CLIENT_ID=...
QPAY_CLIENT_SECRET=...
QPAY_INVOICE_CODE=...
HIPAY_CLIENT_ID=...
HIPAY_CLIENT_SECRET=...
```

Then configure the second Shopify theme checkout redirect to use that second Render URL:

```text
https://store2-gateway.onrender.com/checkout?items=...
```
