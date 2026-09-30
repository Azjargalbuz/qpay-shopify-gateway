import { createServer } from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { QPayClient } from "./qpayClient.js";
import { ShopifyClient } from "./shopifyClient.js";
import { checkoutPageHtml } from "./checkoutPage.js";
import { HipayClient } from "./hipayClient.js";

loadDotEnv();

const port = Number(process.env.PORT || 4001);
const publicBaseUrl = process.env.PUBLIC_BASE_URL || `http://localhost:${port}`;
let qpay;
let shopify;
let hipay;
const invoices = loadInvoices();

const server = createServer(async (req, res) => {
  try {
    const { body, rawBody } = await parseRequestBody(req);
    await route(req, res, body, rawBody);
  } catch (error) {
    console.error(error);
    sendJson(res, error.status || 500, {
      error: error.message,
      details: error.data
    });
  }
});

server.listen(port, () => {
  console.log(`QPay gateway listening on http://localhost:${port}`);
  logRuntimeConfig();
});

async function route(req, res, body, rawBody) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;

  if (req.method === "GET" && path === "/health") {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "GET" && path === "/checkout") {
    sendHtml(res, checkoutPageHtml());
    return;
  }

  const hipayPayMatch = path.match(/^\/hipay\/pay\/([^/]+)$/);
  if (req.method === "GET" && hipayPayMatch) {
    const invoiceId = decodeURIComponent(hipayPayMatch[1]);
    const invoice = invoices.get(invoiceId);
    if (!invoice) {
      sendHtml(res, hipayLaunchPageHtml({ error: "Payment invoice not found" }));
      return;
    }

    const hipayCheckout = await ensureHipayCheckout(invoice);
    sendHtml(res, hipayLaunchPageHtml({
      orderId: invoice.orderId,
      amount: invoice.amount,
      checkoutId: hipayCheckout.checkoutId,
      deeplink: hipayCheckout.deeplink,
      paymentUrl: hipayCheckout.paymentUrl
    }));
    return;
  }

  if ((req.method === "GET" || req.method === "POST") && (path === "/api/hipay/callback" || path === "/api/hipay/redirect")) {
    const checkoutId = url.searchParams.get("checkoutId") || body.checkoutId;
    const paymentId = url.searchParams.get("paymentId") || body.paymentId;
    console.log("HiPay callback received", { checkoutId, paymentId, path });

    if (checkoutId) {
      await markHipayPaid({ checkoutId, paymentId });
    }

    if (path === "/api/hipay/redirect" && checkoutId) {
      const invoice = findInvoiceByHipayCheckoutId(checkoutId);
      if (invoice) {
        sendHtml(res, redirectHtml(`/thank-you/${encodeURIComponent(invoice.qpayInvoiceId)}/${encodeURIComponent(invoice.orderId)}`));
        return;
      }
    }

    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "GET" && path === "/api/custom-checkout/cart") {
    const items = parseCheckoutItems(url.searchParams.get("items"));
    const checkoutItems = await getShopify().getCheckoutItems(items);
    const subtotal = sum(checkoutItems.map((item) => item.linePrice));
    const shippingPrice = getCustomCheckoutShippingPrice(subtotal);

    sendJson(res, 200, {
      items: checkoutItems,
      subtotal,
      shippingPrice,
      total: subtotal + shippingPrice
    });
    return;
  }

  if (req.method === "POST" && path === "/api/custom-checkout/orders") {
    const items = normalizeCheckoutItems(body.items);
    const subtotalItems = await getShopify().getCheckoutItems(items);
    const subtotal = sum(subtotalItems.map((item) => item.linePrice));
    const shippingPrice = getCustomCheckoutShippingPrice(subtotal);

    const draftOrder = await getShopify().createDraftOrder({
      email: body.customer?.email,
      phone: body.customer?.phone,
      shippingAddress: body.shippingAddress,
      items,
      shippingPrice,
      shippingTitle: process.env.CUSTOM_CHECKOUT_SHIPPING_TITLE || "Delivery"
    });

    const orderId = buildStoreOrderId(draftOrder.name || draftOrder.id);
    // Charge the same total shown on the hosted checkout. Shopify's draft order
    // response must not be allowed to silently drop the custom shipping charge.
    const amount = subtotal + shippingPrice;
    const invoice = await getQPay().createInvoice({
      senderInvoiceNo: orderId,
      amount,
      description: `${orderId} custom checkout draft payment`,
      receiverCode: "terminal",
      callbackUrl: process.env.QPAY_CALLBACK_URL
    });
    const paymentUrl = buildPaymentUrl(invoice.invoice_id, orderId);

    invoices.set(invoice.invoice_id, {
      orderId,
      amount,
      status: "NEW",
      qpayInvoiceId: invoice.invoice_id,
      paymentUrl,
      qrText: invoice.qr_text,
      qrImage: invoice.qr_image,
      urls: invoice.urls ?? [],
      shopifyDraftOrderId: draftOrder.id,
      shopifyDraftOrderName: draftOrder.name,
      shopifyTags: draftOrder.tags,
      currency: draftOrder.currency || "MNT",
      source: "custom-checkout",
      createdAt: new Date().toISOString()
    });
    saveInvoices(invoices);

    await getShopify().addPaymentUrlToDraftOrder({
      draftOrder,
      paymentUrl
    });

    console.log("Custom checkout draft order created", {
      shopifyDraftOrderId: draftOrder.id,
      orderId,
      amount,
      invoiceId: invoice.invoice_id,
      paymentUrl
    });

    sendJson(res, 201, {
      ok: true,
      orderId,
      shopifyDraftOrderId: draftOrder.id,
      invoiceId: invoice.invoice_id,
      paymentUrl
    });
    return;
  }

  if (req.method === "POST" && path === "/api/shopify/orders/create") {
    console.log("Shopify order webhook received", {
      shop: req.headers["x-shopify-shop-domain"],
      topic: req.headers["x-shopify-topic"],
      apiVersion: req.headers["x-shopify-api-version"],
      orderId: body.id,
      orderName: body.name,
      gateways: [body.gateway, body.payment_gateway_names, body.processing_method].flat().filter(Boolean)
    });

    verifyShopifyWebhook(req, rawBody);

    if (String(body.tags || "").toLowerCase().includes("custom-checkout")) {
      console.log("Shopify order webhook skipped for custom checkout completed order", {
        orderId: body.id,
        orderName: body.name,
        tags: body.tags
      });
      sendJson(res, 200, {
        ok: true,
        skipped: true,
        reason: "Custom checkout orders are handled by draft completion"
      });
      return;
    }

    if (!isQPayShopifyOrder(body)) {
      console.log("Shopify order skipped because payment method is not QPay/manual", {
        orderId: body.id,
        orderName: body.name,
        gateways: [body.gateway, body.payment_gateway_names, body.processing_method].flat().filter(Boolean)
      });
      sendJson(res, 200, {
        ok: true,
        skipped: true,
        reason: "Order payment method is not QPay"
      });
      return;
    }

    const existingInvoice = findInvoiceByShopifyOrderId(body.id);
    if (existingInvoice) {
      console.log("Shopify order already has QPay invoice", {
        orderId: body.id,
        orderName: body.name,
        invoiceId: existingInvoice.qpayInvoiceId,
        paymentUrl: existingInvoice.paymentUrl
      });
      sendJson(res, 200, {
        ok: true,
        duplicate: true,
        invoiceId: existingInvoice.qpayInvoiceId,
        paymentUrl: existingInvoice.paymentUrl
      });
      return;
    }

    const orderId = buildStoreOrderId(body.name || body.order_number || body.id);
    const amount = Number(body.total_price);
    const description = `${orderId} Shopify order payment`;
    const invoice = await getQPay().createInvoice({
      senderInvoiceNo: orderId,
      amount,
      description,
      receiverCode: "terminal",
      callbackUrl: process.env.QPAY_CALLBACK_URL
    });
    const paymentUrl = buildPaymentUrl(invoice.invoice_id, orderId);
    console.log("QPay invoice created for Shopify order", {
      shopifyOrderId: body.id,
      orderId,
      amount,
      invoiceId: invoice.invoice_id,
      paymentUrl
    });

    invoices.set(invoice.invoice_id, {
      orderId,
      amount,
      status: "NEW",
      qpayInvoiceId: invoice.invoice_id,
      paymentUrl,
      qrText: invoice.qr_text,
      qrImage: invoice.qr_image,
      urls: invoice.urls ?? [],
      shopifyOrderId: body.id,
      shopifyOrderName: body.name,
      shopifyShopDomain: req.headers["x-shopify-shop-domain"],
      shopifyTags: body.tags,
      currency: body.currency || "MNT",
      createdAt: new Date().toISOString()
    });
    saveInvoices(invoices);

    let shopifyUpdate = { skipped: true };
    try {
      shopifyUpdate = await getShopify().addPaymentUrlToOrder({
        order: body,
        paymentUrl
      });
      console.log("Shopify order updated with QPay payment URL", {
        shopifyOrderId: body.id,
        orderId,
        paymentUrl
      });
    } catch (error) {
      shopifyUpdate = {
        ok: false,
        error: error.message,
        details: error.data
      };
      console.error("Failed to update Shopify order with QPay URL", error);
    }

    sendJson(res, 201, {
      ok: true,
      orderId,
      invoiceId: invoice.invoice_id,
      paymentUrl,
      shopifyUpdate
    });
    return;
  }

  if (req.method === "POST" && path === "/api/qpay/invoices") {
    const {
      orderId,
      amount,
      description,
      receiverCode,
      receiverData,
      callbackUrl
    } = body;

    const invoice = await getQPay().createInvoice({
      senderInvoiceNo: orderId,
      amount,
      description,
      receiverCode,
      receiverData,
      callbackUrl
    });

    invoices.set(invoice.invoice_id, {
      orderId,
      amount,
      status: "NEW",
      qpayInvoiceId: invoice.invoice_id,
      paymentUrl: buildPaymentUrl(invoice.invoice_id, orderId),
      qrText: invoice.qr_text,
      qrImage: invoice.qr_image,
      urls: invoice.urls ?? [],
      createdAt: new Date().toISOString()
    });
    saveInvoices(invoices);

    sendJson(res, 201, {
      orderId,
      invoiceId: invoice.invoice_id,
      paymentUrl: buildPaymentUrl(invoice.invoice_id, orderId),
      qrText: invoice.qr_text,
      qrImage: invoice.qr_image,
      urls: invoice.urls
    });
    return;
  }

  const invoiceMatch = path.match(/^\/api\/qpay\/invoices\/([^/]+)$/);
  if (req.method === "GET" && invoiceMatch) {
    const invoice = await getQPay().getInvoice(invoiceMatch[1]);
    sendJson(res, 200, invoice);
    return;
  }

  const checkMatch = path.match(/^\/api\/qpay\/invoices\/([^/]+)\/check$/);
  if (req.method === "POST" && checkMatch) {
    const invoiceId = checkMatch[1];
    const recoveryDraftOrderId = url.searchParams.get("draft_order_id");
    const payment = await getQPay().checkInvoicePayment(invoiceId);
    const paid = payment.rows?.some((row) => row.payment_status === "PAID") ?? false;

    const localInvoice = await findOrRecoverInvoice(invoiceId, recoveryDraftOrderId);
    if (localInvoice && paid) {
      localInvoice.status = "PAID";
      localInvoice.paidAt = new Date().toISOString();
      invoices.set(invoiceId, localInvoice);
      saveInvoices(invoices);
      console.log("QPay invoice marked paid from payment check", {
        invoiceId,
        orderId: localInvoice.orderId
      });
      await updateShopifyAfterPaid(localInvoice);
    }

    sendJson(res, 200, {
      paid,
      paidAmount: payment.paid_amount,
      count: payment.count,
      rows: payment.rows ?? [],
      shopifyOrderId: localInvoice?.shopifyOrderId,
      shopifyOrderName: localInvoice?.shopifyOrderName
    });
    return;
  }

  if (req.method === "DELETE" && invoiceMatch) {
    const invoiceId = invoiceMatch[1];
    const result = await getQPay().cancelInvoice(invoiceId);
    invoices.delete(invoiceId);
    saveInvoices(invoices);
    sendJson(res, 200, result);
    return;
  }

  if ((req.method === "GET" || req.method === "POST") && path === "/api/qpay/callback") {
    const paymentId = url.searchParams.get("payment_id") || body.payment_id || body.paymentId;
    const invoiceId = url.searchParams.get("invoice_id")
      || body.invoice_id
      || body.invoiceId
      || body.object_id
      || body.objectId;
    const result = await handleQPayCallback({ invoiceId, paymentId, method: req.method });
    sendJson(res, 200, result);
    return;
  }

  const orderMatch = path.match(/^\/api\/orders\/([^/]+)\/payment-status$/);
  if (req.method === "GET" && orderMatch) {
    const invoice = [...invoices.values()].find((item) => item.orderId === orderMatch[1]);

    if (!invoice) {
      sendJson(res, 404, { error: "Order payment invoice not found" });
      return;
    }

    sendJson(res, 200, invoice);
    return;
  }

  const paymentDataMatch = path.match(/^\/api\/payment-page\/([^/]+)$/);
  if (req.method === "GET" && paymentDataMatch) {
    const invoiceId = decodeURIComponent(paymentDataMatch[1]);
    const invoice = invoices.get(invoiceId);

    if (!invoice) {
      sendJson(res, 404, { error: "Payment invoice not found" });
      return;
    }

    sendJson(res, 200, publicInvoice(invoice));
    return;
  }

  const publicPaymentMatch = path.match(/^\/(merchant_[^/]+)\/([^/]+)\/([^/]+)$/);
  if (req.method === "GET" && publicPaymentMatch) {
    const [, merchant, invoiceId, orderId] = publicPaymentMatch.map(decodeURIComponent);
    sendHtml(res, paymentPageHtml({ merchant, invoiceId, orderId }));
    return;
  }

  const thankYouMatch = path.match(/^\/thank-you\/([^/]+)\/([^/]+)$/);
  if (req.method === "GET" && thankYouMatch) {
    const [, invoiceId, orderId] = thankYouMatch.map(decodeURIComponent);
    sendHtml(res, thankYouPageHtml({ invoiceId, orderId }));
    return;
  }

  sendJson(res, 404, { error: "Not found" });
}

function getQPay() {
  if (!qpay) {
    qpay = new QPayClient({
      env: process.env.QPAY_ENV,
      clientId: process.env.QPAY_CLIENT_ID,
      clientSecret: process.env.QPAY_CLIENT_SECRET,
      invoiceCode: process.env.QPAY_INVOICE_CODE,
      callbackUrl: process.env.QPAY_CALLBACK_URL
    });
  }

  return qpay;
}

function logRuntimeConfig() {
  console.log("Runtime config", {
    publicBaseUrl,
    storePrefix: process.env.STORE_PREFIX || "",
    qpay: {
      env: String(process.env.QPAY_ENV || "").trim(),
      clientId: describeSecret(process.env.QPAY_CLIENT_ID),
      clientSecret: describeSecret(process.env.QPAY_CLIENT_SECRET),
      invoiceCode: describeSecret(process.env.QPAY_INVOICE_CODE),
      callbackUrl: process.env.QPAY_CALLBACK_URL || ""
    },
    shopify: {
      shopDomain: process.env.SHOPIFY_SHOP_DOMAIN || "",
      clientId: describeSecret(process.env.SHOPIFY_CLIENT_ID),
      clientSecret: describeSecret(process.env.SHOPIFY_CLIENT_SECRET),
      hasAdminAccessToken: Boolean(process.env.SHOPIFY_ADMIN_ACCESS_TOKEN)
    }
  });
}

function describeSecret(value) {
  const text = String(value || "").trim();
  if (!text) {
    return { set: false, length: 0 };
  }

  return { set: true, length: text.length };
}

function getShopify() {
  if (!shopify) {
    shopify = new ShopifyClient({
      shopDomain: process.env.SHOPIFY_SHOP_DOMAIN,
      accessToken: process.env.SHOPIFY_ADMIN_ACCESS_TOKEN,
      clientId: process.env.SHOPIFY_CLIENT_ID,
      clientSecret: process.env.SHOPIFY_CLIENT_SECRET,
      apiVersion: process.env.SHOPIFY_API_VERSION
    });
  }

  return shopify;
}

function getHipay() {
  if (!hipay) {
    hipay = new HipayClient({
      baseUrl: process.env.HIPAY_BASE_URL || "https://test.hipay.mn",
      clientId: process.env.HIPAY_CLIENT_ID,
      clientSecret: process.env.HIPAY_CLIENT_SECRET,
      redirectUrl: process.env.HIPAY_REDIRECT_URL || `${publicBaseUrl.replace(/\/$/, "")}/api/hipay/redirect`,
      webhookUrl: process.env.HIPAY_WEBHOOK_URL || `${publicBaseUrl.replace(/\/$/, "")}/api/hipay/callback`
    });
  }

  return hipay;
}

function parseRequestBody(req) {
  return new Promise((resolve, reject) => {
    if (!["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) {
      resolve({ body: {}, rawBody: "" });
      return;
    }

    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      if (!raw) {
        resolve({ body: {}, rawBody: "" });
        return;
      }

      try {
        const contentType = String(req.headers["content-type"] || "");
        if (contentType.includes("application/x-www-form-urlencoded")) {
          resolve({ body: Object.fromEntries(new URLSearchParams(raw)), rawBody: raw });
          return;
        }

        resolve({ body: JSON.parse(raw), rawBody: raw });
      } catch {
        const error = new Error("Invalid request body");
        error.status = 400;
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function sendHtml(res, html) {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

function loadDotEnv() {
  if (!existsSync(".env")) {
    return;
  }

  const lines = readFileSync(".env", "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim();
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

function buildPaymentUrl(invoiceId, orderId) {
  return `${publicBaseUrl.replace(/\/$/, "")}/merchant_1/${encodeURIComponent(invoiceId)}/${encodeURIComponent(orderId)}`;
}

function buildStoreOrderId(orderId) {
  const normalizedOrderId = String(orderId);
  const prefix = String(process.env.STORE_PREFIX || "").trim();

  if (!prefix || normalizedOrderId.startsWith(`${prefix}-`)) {
    return normalizedOrderId;
  }

  return `${prefix}-${normalizedOrderId}`;
}

function publicInvoice(invoice) {
  return {
    orderId: invoice.orderId,
    amount: invoice.amount,
    status: invoice.status,
    qpayInvoiceId: invoice.qpayInvoiceId,
    qrText: invoice.qrText,
    qrImage: invoice.qrImage,
    urls: invoice.urls ?? [],
    createdAt: invoice.createdAt,
    paidAt: invoice.paidAt
  };
}

function findInvoiceByShopifyOrderId(shopifyOrderId) {
  return [...invoices.values()].find((invoice) => invoice.shopifyOrderId === shopifyOrderId);
}

function findInvoiceByHipayCheckoutId(checkoutId) {
  return [...invoices.values()].find((invoice) => invoice.hipayCheckoutId === checkoutId);
}

async function ensureHipayCheckout(invoice) {
  if (invoice.hipayCheckoutId) {
    return {
      checkoutId: invoice.hipayCheckoutId,
      deeplink: invoice.hipayDeeplink,
      paymentUrl: invoice.hipayPaymentUrl
    };
  }

  const checkout = await getHipay().createCheckout({
    amount: invoice.amount,
    items: [{
      itemno: String(invoice.orderId).slice(0, 32),
      name: `Order ${invoice.orderId}`,
      price: Number(invoice.amount),
      quantity: 1,
      measure: "ш"
    }]
  });
  const checkoutId = checkout.checkoutId;
  const paymentUrl = getHipay().paymentFormUrl({ checkoutId });
  const deeplink = getHipay().deeplink(checkoutId);

  invoice.hipayCheckoutId = checkoutId;
  invoice.hipayPaymentUrl = paymentUrl;
  invoice.hipayDeeplink = deeplink;
  invoice.hipayStatus = "NEW";
  invoices.set(invoice.qpayInvoiceId, invoice);
  saveInvoices(invoices);

  console.log("HiPay checkout created", {
    orderId: invoice.orderId,
    invoiceId: invoice.qpayInvoiceId,
    checkoutId,
    paymentUrl
  });

  return { checkoutId, paymentUrl, deeplink };
}

async function markHipayPaid({ checkoutId, paymentId }) {
  const invoice = findInvoiceByHipayCheckoutId(checkoutId);
  if (!invoice) {
    console.warn("HiPay callback checkoutId not found", { checkoutId, paymentId });
    return;
  }

  const status = await getHipay().getCheckout(checkoutId);
  const isPaid = String(status.status || "").toLowerCase().startsWith("paid");
  if (!isPaid) {
    invoice.hipayStatus = status.status || "UNKNOWN";
    invoices.set(invoice.qpayInvoiceId, invoice);
    saveInvoices(invoices);
    console.log("HiPay checkout is not paid yet", { checkoutId, status: invoice.hipayStatus });
    return;
  }

  invoice.status = "PAID";
  invoice.hipayStatus = status.status;
  invoice.hipayPaymentId = paymentId || status.paymentId;
  invoice.hipayPaymentType = status.paymentType;
  invoice.paidAt = new Date().toISOString();
  invoices.set(invoice.qpayInvoiceId, invoice);
  saveInvoices(invoices);

  console.log("HiPay invoice marked paid", {
    checkoutId,
    invoiceId: invoice.qpayInvoiceId,
    orderId: invoice.orderId,
    paymentId: invoice.hipayPaymentId
  });

  await updateShopifyAfterPaid(invoice);
}

function parseCheckoutItems(itemsParam) {
  if (!itemsParam) {
    const error = new Error("items query parameter is required");
    error.status = 400;
    throw error;
  }

  const items = itemsParam.split(",").map((entry) => {
    const [variantId, quantity = "1"] = entry.split(":");
    return {
      variantId: variantId?.trim(),
      quantity: Number(quantity)
    };
  });

  return normalizeCheckoutItems(items);
}

function normalizeCheckoutItems(items) {
  if (!Array.isArray(items) || items.length === 0) {
    const error = new Error("At least one checkout item is required");
    error.status = 400;
    throw error;
  }

  return items.map((item) => {
    const variantId = String(item.variantId || "").trim();
    const quantity = Number(item.quantity || 1);

    if (!variantId || !Number.isFinite(quantity) || quantity <= 0) {
      const error = new Error("Each item requires variantId and positive quantity");
      error.status = 400;
      throw error;
    }

    return { variantId, quantity };
  });
}

function getCustomCheckoutShippingPrice(subtotal) {
  const freeShippingThreshold = Number(process.env.CUSTOM_CHECKOUT_FREE_SHIPPING_THRESHOLD || 0);
  if (freeShippingThreshold > 0 && subtotal >= freeShippingThreshold) {
    return 0;
  }

  return Number(process.env.CUSTOM_CHECKOUT_SHIPPING_PRICE || 0);
}

function sum(values) {
  return values.reduce((total, value) => total + Number(value || 0), 0);
}

function isQPayShopifyOrder(order) {
  const allowedGatewayNames = (process.env.SHOPIFY_QPAY_GATEWAY_NAMES || "qpay,manual")
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);
  const gateways = [
    order.gateway,
    order.payment_gateway_names,
    order.processing_method
  ].flat().filter(Boolean);

  return gateways.some((gateway) => {
    const normalizedGateway = String(gateway).toLowerCase();
    return allowedGatewayNames.some((allowedName) => normalizedGateway.includes(allowedName));
  });
}

function verifyShopifyWebhook(req, rawBody) {
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET;
  if (!secret) {
    return;
  }

  const receivedHmac = req.headers["x-shopify-hmac-sha256"];
  if (!receivedHmac) {
    const error = new Error("Missing Shopify webhook HMAC header");
    error.status = 401;
    throw error;
  }

  const digest = createHmac("sha256", secret)
    .update(rawBody, "utf8")
    .digest("base64");

  const received = Buffer.from(receivedHmac, "base64");
  const expected = Buffer.from(digest, "base64");
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
    const error = new Error("Invalid Shopify webhook HMAC");
    error.status = 401;
    throw error;
  }
}

async function updateShopifyAfterPaid(invoice) {
  if (invoice.shopifyDraftOrderId && !invoice.shopifyOrderId) {
    try {
      const completedDraftOrder = await getShopify().completeDraftOrder({
        draftOrderId: invoice.shopifyDraftOrderId,
        paymentPending: false
      });
      invoice.shopifyOrderId = completedDraftOrder.order_id;
      invoice.shopifyOrderName = completedDraftOrder.name || invoice.shopifyDraftOrderName;
      invoice.shopifyTags = completedDraftOrder.tags || invoice.shopifyTags;
      saveInvoices(invoices);
      console.log("Shopify draft order completed after QPay payment", {
        draftOrderId: invoice.shopifyDraftOrderId,
        shopifyOrderId: invoice.shopifyOrderId,
        orderName: invoice.shopifyOrderName
      });
    } catch (error) {
      console.error("Failed to complete Shopify draft order after QPay payment", error);
    }
    return;
  }

  if (!invoice.shopifyOrderId) {
    return;
  }

  try {
    if (process.env.SHOPIFY_MARK_PAID === "true") {
      await getShopify().markOrderPaid({
        orderId: invoice.shopifyOrderId,
        amount: invoice.amount,
        currency: invoice.currency || "MNT"
      });
    }

    await getShopify().tagOrderPaid(invoice);
  } catch (error) {
    console.error("Failed to update Shopify order after QPay payment", error);
  }
}

async function handleQPayCallback({ invoiceId, paymentId, method }) {
  let resolvedInvoiceId = invoiceId;
  console.log("QPay callback received", { invoiceId, paymentId, method });

  if (!resolvedInvoiceId && paymentId) {
    const paymentDetails = await getQPay().getPayment(paymentId);
    resolvedInvoiceId = paymentDetails.object_id
      || paymentDetails.payment_object_id
      || paymentDetails.invoice_id;
    console.log("QPay callback invoice resolved from payment", {
      paymentId,
      invoiceId: resolvedInvoiceId
    });
  }

  if (!resolvedInvoiceId) {
    console.warn("QPay callback did not include a usable invoice identifier", {
      paymentId,
      method
    });
    return { ok: true, processed: false };
  }

  const payment = await getQPay().checkInvoicePayment(resolvedInvoiceId);
  const paidRow = payment.rows?.find((row) => row.payment_status === "PAID");
  const localInvoice = await findOrRecoverInvoice(resolvedInvoiceId);

  if (!localInvoice) {
    console.warn("QPay callback invoice was not found locally", {
      invoiceId: resolvedInvoiceId,
      paymentId
    });
    return { ok: true, processed: false };
  }

  if (!paidRow) {
    console.log("QPay callback payment is not paid yet", {
      invoiceId: resolvedInvoiceId,
      paymentId
    });
    return { ok: true, processed: false };
  }

  localInvoice.status = "PAID";
  localInvoice.paymentId = paymentId || paidRow.payment_id;
  localInvoice.paidAt ||= new Date().toISOString();
  invoices.set(resolvedInvoiceId, localInvoice);
  saveInvoices(invoices);
  console.log("QPay invoice marked paid from callback", {
    invoiceId: resolvedInvoiceId,
    orderId: localInvoice.orderId,
    paymentId: localInvoice.paymentId
  });
  await updateShopifyAfterPaid(localInvoice);

  return { ok: true, processed: true };
}

async function findOrRecoverInvoice(invoiceId, draftOrderId) {
  const existingInvoice = invoices.get(invoiceId);
  if (existingInvoice) {
    return existingInvoice;
  }

  const draftOrder = await getShopify().findDraftOrderByQPayInvoiceId(invoiceId, draftOrderId);
  if (!draftOrder) {
    return null;
  }

  const recoveredInvoice = {
    orderId: buildStoreOrderId(draftOrder.name || draftOrder.id),
    amount: Number(draftOrder.total_price || 0),
    status: "NEW",
    qpayInvoiceId: invoiceId,
    paymentUrl: buildPaymentUrl(invoiceId, buildStoreOrderId(draftOrder.name || draftOrder.id)),
    shopifyDraftOrderId: draftOrder.id,
    shopifyDraftOrderName: draftOrder.name,
    shopifyTags: draftOrder.tags,
    shopifyOrderId: draftOrder.order_id || undefined,
    currency: draftOrder.currency || "MNT",
    source: "shopify-draft-recovery",
    createdAt: draftOrder.created_at || new Date().toISOString()
  };

  invoices.set(invoiceId, recoveredInvoice);
  saveInvoices(invoices);
  console.log("Recovered QPay invoice from Shopify draft order", {
    invoiceId,
    orderId: recoveredInvoice.orderId,
    shopifyDraftOrderId: recoveredInvoice.shopifyDraftOrderId
  });
  return recoveredInvoice;
}

function loadInvoices() {
  if (!existsSync("data/invoices.json")) {
    return new Map();
  }

  const rows = JSON.parse(readFileSync("data/invoices.json", "utf8"));
  return new Map(rows.map((invoice) => [invoice.qpayInvoiceId, invoice]));
}

function saveInvoices(invoiceMap) {
  mkdirSync("data", { recursive: true });
  writeFileSync(
    "data/invoices.json",
    JSON.stringify([...invoiceMap.values()], null, 2)
  );
}

function paymentPageHtml({ merchant, invoiceId, orderId }) {
  const safeMerchant = escapeHtml(merchant);
  const safeInvoiceId = escapeHtml(invoiceId);
  const safeOrderId = escapeHtml(orderId);

  return `<!doctype html>
<html lang="mn">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>QPay төлбөр</title>
  <style>
    :root {
      color-scheme: light;
      --ink: #172026;
      --muted: #64717d;
      --line: #d9e0e6;
      --blue: #1473e6;
      --green: #168a4a;
      --bg: #f5f7f9;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: Arial, Helvetica, sans-serif;
      background: var(--bg);
      color: var(--ink);
    }
    .wrap {
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 24px;
    }
    .panel {
      width: min(520px, 100%);
      background: #fff;
      border: 1px solid var(--line);
      border-radius: 8px;
      overflow: hidden;
      box-shadow: 0 14px 40px rgba(23, 32, 38, 0.08);
    }
    .head {
      padding: 22px 24px;
      border-bottom: 1px solid var(--line);
      display: flex;
      justify-content: space-between;
      gap: 16px;
      align-items: center;
    }
    .brand {
      font-size: 20px;
      font-weight: 700;
    }
    .badge {
      padding: 7px 10px;
      border-radius: 999px;
      background: #edf4ff;
      color: #0757b8;
      font-size: 13px;
      font-weight: 700;
    }
    .body { padding: 24px; }
    .meta {
      display: grid;
      gap: 10px;
      margin-bottom: 20px;
      color: var(--muted);
      font-size: 14px;
    }
    .row {
      display: flex;
      justify-content: space-between;
      gap: 14px;
    }
    .row strong {
      color: var(--ink);
      text-align: right;
      overflow-wrap: anywhere;
    }
    .amount {
      font-size: 32px;
      font-weight: 800;
      margin: 18px 0 20px;
    }
    .qr {
      display: grid;
      place-items: center;
      min-height: 260px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #fbfcfd;
      margin-bottom: 18px;
    }
    .qr img {
      width: min(250px, 86%);
      height: auto;
      display: block;
    }
    .loading { color: var(--muted); }
    .banks {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
      margin-bottom: 18px;
    }
    .bank {
      display: block;
      padding: 12px;
      border: 1px solid var(--line);
      border-radius: 8px;
      color: var(--ink);
      text-decoration: none;
      font-weight: 700;
      text-align: center;
      overflow-wrap: anywhere;
    }
    .hint {
      color: var(--muted);
      font-size: 13px;
      line-height: 1.45;
      margin: -6px 0 16px;
    }
    .actions {
      display: flex;
      gap: 10px;
    }
    button, .primary {
      border: 0;
      border-radius: 8px;
      padding: 13px 16px;
      font-weight: 800;
      cursor: pointer;
      text-decoration: none;
      text-align: center;
    }
    button {
      background: var(--blue);
      color: #fff;
      flex: 1;
    }
    .primary {
      background: #edf4ff;
      color: #0757b8;
      flex: 1;
    }
    .paid .badge {
      background: #e9f8ef;
      color: var(--green);
    }
    .paid button {
      background: var(--green);
    }
    @media (max-width: 460px) {
      .wrap { padding: 12px; }
      .head, .body { padding: 18px; }
      .banks { grid-template-columns: 1fr; }
      .actions { flex-direction: column; }
    }
  </style>
</head>
<body>
  <main class="wrap">
    <section class="panel" id="panel">
      <div class="head">
        <div>
          <div class="brand">QPay төлбөр</div>
          <div class="loading">${safeMerchant}</div>
        </div>
        <div class="badge" id="status">Хүлээгдэж байна</div>
      </div>
      <div class="body">
        <div class="meta">
          <div class="row"><span>Захиалга</span><strong>${safeOrderId}</strong></div>
          <div class="row"><span>Нэхэмжлэх</span><strong>${safeInvoiceId}</strong></div>
        </div>
        <div class="amount" id="amount">...</div>
        <div class="qr" id="qr"><span class="loading">QR уншиж байна...</span></div>
        <p class="hint">Банкны app товчнууд ихэвчлэн тухайн банкны апп суусан гар утсан дээр ажиллана. Компьютер дээр нээгдэхгүй бол QR кодоо банкны апп-аар уншуулна уу.</p>
        <div class="banks" id="banks"></div>
        <div class="actions">
          <button id="check" type="button">Төлбөр шалгах</button>
          <a class="primary" href="/" id="back">Буцах</a>
        </div>
      </div>
    </section>
  </main>
  <script>
    const invoiceId = ${JSON.stringify(invoiceId)};
    const orderId = ${JSON.stringify(orderId)};
    const amount = document.getElementById("amount");
    const qr = document.getElementById("qr");
    const banks = document.getElementById("banks");
    const status = document.getElementById("status");
    const panel = document.getElementById("panel");
    const check = document.getElementById("check");
    let pollCount = 0;

    function thankYouUrl() {
      return "/thank-you/" + encodeURIComponent(invoiceId) + "/" + encodeURIComponent(orderId);
    }

    async function loadPayment() {
      const response = await fetch("/api/payment-page/" + encodeURIComponent(invoiceId));
      if (!response.ok) throw new Error("Payment invoice not found");
      const data = await response.json();
      render(data);
    }

    function render(data) {
      amount.textContent = new Intl.NumberFormat("mn-MN").format(data.amount || 0) + " MNT";
      status.textContent = data.status === "PAID" ? "Төлөгдсөн" : "Хүлээгдэж байна";
      panel.classList.toggle("paid", data.status === "PAID");
      if (data.status === "PAID") {
        location.href = thankYouUrl();
        return;
      }

      if (data.qrImage) {
        const src = data.qrImage.startsWith("data:")
          ? data.qrImage
          : "data:image/png;base64," + data.qrImage;
        qr.innerHTML = '<img alt="QPay QR" src="' + src + '">';
      } else if (data.qrText) {
        qr.innerHTML = '<span class="loading">' + data.qrText + '</span>';
      } else {
        qr.innerHTML = '<span class="loading">QR олдсонгүй</span>';
      }

      banks.innerHTML = "";
      for (const item of data.urls || []) {
        const link = document.createElement("a");
        link.className = "bank";
        const label = item.name || item.description || "Банк";
        link.href = label.toLowerCase().includes("hipay")
          ? "/hipay/pay/" + encodeURIComponent(invoiceId)
          : item.link;
        link.target = "_blank";
        link.rel = "noopener";
        link.textContent = label;
        banks.appendChild(link);
      }
    }

    async function checkPayment(options = {}) {
      const silent = options.silent === true;
      if (!silent) {
        check.disabled = true;
        check.textContent = "Шалгаж байна...";
      }
      try {
        const response = await fetch("/api/qpay/invoices/" + encodeURIComponent(invoiceId) + "/check", { method: "POST" });
        const data = await response.json();
        if (data.paid) {
          status.textContent = "Төлөгдсөн";
          panel.classList.add("paid");
          check.textContent = "Төлөгдсөн";
          location.href = thankYouUrl();
        } else if (!silent) {
          check.textContent = "Дахин шалгах";
        }
      } finally {
        if (!silent) {
          check.disabled = false;
        }
      }
    }

    check.addEventListener("click", checkPayment);
    setInterval(async () => {
      pollCount += 1;
      if (pollCount > 60) return;
      try {
        await checkPayment({ silent: true });
      } catch {}
    }, 5000);
    loadPayment().catch((error) => {
      amount.textContent = "Олдсонгүй";
      qr.innerHTML = '<span class="loading">' + error.message + '</span>';
    });
  </script>
</body>
</html>`;
}

function hipayLaunchPageHtml({ orderId, amount, checkoutId, deeplink, paymentUrl, error }) {
  if (error) {
    return `<!doctype html><html lang="mn"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>HiPay</title></head><body><p>${escapeHtml(error)}</p></body></html>`;
  }

  return `<!doctype html>
<html lang="mn">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>HiPay руу шилжиж байна</title>
  <style>
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 24px;
      background: #f5f7f9;
      color: #172026;
      font-family: Arial, Helvetica, sans-serif;
    }
    .panel {
      width: min(480px, 100%);
      background: #fff;
      border: 1px solid #d9e0e6;
      border-radius: 8px;
      padding: 28px;
      text-align: center;
      box-shadow: 0 14px 40px rgba(23, 32, 38, 0.08);
    }
    h1 { margin: 0 0 10px; font-size: 24px; }
    p { margin: 0 0 18px; color: #64717d; line-height: 1.5; }
    .meta {
      display: grid;
      gap: 8px;
      margin: 18px 0;
      padding: 14px;
      border: 1px solid #d9e0e6;
      border-radius: 8px;
      text-align: left;
      font-size: 14px;
    }
    .row { display: flex; justify-content: space-between; gap: 12px; }
    a {
      display: block;
      padding: 13px 16px;
      border-radius: 8px;
      text-decoration: none;
      font-weight: 800;
      margin-top: 10px;
    }
    .primary { background: #1473e6; color: #fff; }
    .secondary { background: #edf4ff; color: #0757b8; }
  </style>
</head>
<body>
  <main class="panel">
    <h1>HiPay руу шилжиж байна</h1>
    <p>Хэрэв HiPay app автоматаар нээгдэхгүй бол доорх товчийг дарна уу.</p>
    <div class="meta">
      <div class="row"><span>Захиалга</span><strong>${escapeHtml(orderId)}</strong></div>
      <div class="row"><span>Дүн</span><strong>${escapeHtml(new Intl.NumberFormat("mn-MN").format(Number(amount || 0)))} MNT</strong></div>
      <div class="row"><span>HiPay checkout</span><strong>${escapeHtml(checkoutId)}</strong></div>
    </div>
    <a class="primary" href="${escapeHtml(deeplink)}">HiPay app нээх</a>
    <a class="secondary" href="${escapeHtml(paymentUrl)}">Web payment page нээх</a>
  </main>
  <script>
    const deeplink = ${JSON.stringify(deeplink)};
    const paymentUrl = ${JSON.stringify(paymentUrl)};
    if (/Android|iPhone|iPad|iPod/i.test(navigator.userAgent)) {
      location.href = deeplink;
      setTimeout(() => { location.href = paymentUrl; }, 1400);
    }
  </script>
</body>
</html>`;
}

function redirectHtml(path) {
  return `<!doctype html><html lang="mn"><head><meta charset="utf-8"><meta http-equiv="refresh" content="0; url=${escapeHtml(path)}"><script>location.href=${JSON.stringify(path)}</script></head><body></body></html>`;
}

function thankYouPageHtml({ invoiceId, orderId }) {
  const safeInvoiceId = escapeHtml(invoiceId);
  const safeOrderId = escapeHtml(orderId);

  return `<!doctype html>
<html lang="mn">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Төлбөр амжилттай</title>
  <style>
    :root {
      --ink: #172026;
      --muted: #64717d;
      --line: #d9e0e6;
      --green: #168a4a;
      --bg: #f5f7f9;
      --blue: #1473e6;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 24px;
      background: var(--bg);
      color: var(--ink);
      font-family: Arial, Helvetica, sans-serif;
    }
    .panel {
      width: min(520px, 100%);
      background: #fff;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 34px 28px;
      text-align: center;
      box-shadow: 0 14px 40px rgba(23, 32, 38, 0.08);
    }
    .mark {
      width: 64px;
      height: 64px;
      border-radius: 999px;
      display: grid;
      place-items: center;
      margin: 0 auto 20px;
      background: #e9f8ef;
      color: var(--green);
      font-size: 36px;
      font-weight: 900;
    }
    h1 {
      margin: 0 0 10px;
      font-size: 28px;
    }
    p {
      margin: 0 0 20px;
      color: var(--muted);
      line-height: 1.5;
    }
    .meta {
      display: grid;
      gap: 10px;
      padding: 16px;
      margin: 22px 0;
      border: 1px solid var(--line);
      border-radius: 8px;
      text-align: left;
      font-size: 14px;
    }
    .row {
      display: flex;
      justify-content: space-between;
      gap: 14px;
    }
    .row strong {
      overflow-wrap: anywhere;
      text-align: right;
    }
    a {
      display: inline-block;
      min-width: 180px;
      padding: 13px 16px;
      border-radius: 8px;
      background: var(--blue);
      color: #fff;
      text-decoration: none;
      font-weight: 800;
    }
  </style>
</head>
<body>
  <main class="panel">
    <div class="mark">✓</div>
    <h1>Төлбөр амжилттай</h1>
    <p>Таны төлбөр төлөгдөж захиалга баталгаажлаа. БАЯРЛАЛАА</p>
    <div class="meta">
      <div class="row"><span>Захиалга</span><strong>${safeOrderId}</strong></div>
      <div class="row"><span>Нэхэмжлэх</span><strong>${safeInvoiceId}</strong></div>
    </div>
    <a href="https://${escapeHtml(process.env.SHOPIFY_SHOP_DOMAIN || "")}">Дэлгүүр рүү буцах</a>
  </main>
</body>
</html>`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
