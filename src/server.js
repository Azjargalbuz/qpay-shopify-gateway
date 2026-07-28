import { createServer } from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { QPayClient } from "./qpayClient.js";
import { ShopifyClient } from "./shopifyClient.js";

loadDotEnv();

const port = Number(process.env.PORT || 4001);
const publicBaseUrl = process.env.PUBLIC_BASE_URL || `http://localhost:${port}`;
let qpay;
let shopify;
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
});

async function route(req, res, body, rawBody) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;

  if (req.method === "GET" && path === "/health") {
    sendJson(res, 200, { ok: true });
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

    const orderId = String(body.name || body.order_number || body.id);
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
    const payment = await getQPay().checkInvoicePayment(invoiceId);
    const paid = payment.rows?.some((row) => row.payment_status === "PAID") ?? false;

    const localInvoice = invoices.get(invoiceId);
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
      rows: payment.rows ?? []
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

  if (req.method === "POST" && path === "/api/qpay/callback") {
    const paymentId = url.searchParams.get("payment_id") || body.payment_id;
    const invoiceId = url.searchParams.get("invoice_id") || body.invoice_id || body.object_id;
    console.log("QPay callback received", { invoiceId, paymentId });

    if (invoiceId) {
      const payment = await getQPay().checkInvoicePayment(invoiceId);
      const paid = payment.rows?.some((row) => row.payment_status === "PAID") ?? false;
      const localInvoice = invoices.get(invoiceId);

      if (localInvoice && paid) {
        localInvoice.status = "PAID";
        localInvoice.paymentId = paymentId ?? payment.rows?.[0]?.payment_id;
        localInvoice.paidAt = new Date().toISOString();
        invoices.set(invoiceId, localInvoice);
        saveInvoices(invoices);
        console.log("QPay invoice marked paid from callback", {
          invoiceId,
          orderId: localInvoice.orderId,
          paymentId: localInvoice.paymentId
        });
        await updateShopifyAfterPaid(localInvoice);
      }
    }

    sendJson(res, 200, { ok: true });
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
        resolve({ body: JSON.parse(raw), rawBody: raw });
      } catch {
        const error = new Error("Invalid JSON body");
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
        link.href = item.link;
        link.textContent = item.name || item.description || "Банк";
        banks.appendChild(link);
      }
    }

    async function checkPayment() {
      check.disabled = true;
      check.textContent = "Шалгаж байна...";
      try {
        const response = await fetch("/api/qpay/invoices/" + encodeURIComponent(invoiceId) + "/check", { method: "POST" });
        const data = await response.json();
        if (data.paid) {
          status.textContent = "Төлөгдсөн";
          panel.classList.add("paid");
          check.textContent = "Төлөгдсөн";
        } else {
          check.textContent = "Дахин шалгах";
        }
      } finally {
        check.disabled = false;
      }
    }

    check.addEventListener("click", checkPayment);
    loadPayment().catch((error) => {
      amount.textContent = "Олдсонгүй";
      qr.innerHTML = '<span class="loading">' + error.message + '</span>';
    });
  </script>
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
