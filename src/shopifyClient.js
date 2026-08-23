export class ShopifyClient {
  constructor({
    shopDomain,
    accessToken,
    clientId,
    clientSecret,
    apiVersion = "2026-04"
  }) {
    this.shopDomain = normalizeShopDomain(shopDomain);
    this.accessToken = accessToken;
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.apiVersion = apiVersion;
    this.staticAccessToken = Boolean(accessToken);
    this.tokenExpiresAt = accessToken ? Number.POSITIVE_INFINITY : 0;
  }

  isConfigured() {
    return Boolean(
      this.shopDomain &&
      (this.accessToken || (this.clientId && this.clientSecret))
    );
  }

  async addPaymentUrlToOrder({ order, paymentUrl }) {
    if (!this.isConfigured()) {
      return { skipped: true, reason: "Shopify Admin API credentials are not configured" };
    }

    const noteAttributes = Array.isArray(order.note_attributes) ? order.note_attributes : [];
    const nextNoteAttributes = upsertNoteAttribute(noteAttributes, "QPay payment URL", paymentUrl);
    const tags = appendTag(order.tags, "qpay-pending");
    const note = appendPaymentUrlToNote(order.note, paymentUrl);

    return this.request(`/orders/${order.id}.json`, {
      method: "PUT",
      body: {
        order: {
          id: order.id,
          note_attributes: nextNoteAttributes,
          note,
          tags
        }
      }
    });
  }

  async markOrderPaid({ orderId, amount, currency = "MNT" }) {
    if (!this.isConfigured()) {
      return { skipped: true, reason: "Shopify Admin API credentials are not configured" };
    }

    return this.request(`/orders/${orderId}/transactions.json`, {
      method: "POST",
      body: {
        transaction: {
          kind: "capture",
          status: "success",
          amount: String(amount),
          currency,
          gateway: "QPay"
        }
      }
    });
  }

  async tagOrderPaid(order) {
    if (!this.isConfigured()) {
      return { skipped: true, reason: "Shopify Admin API credentials are not configured" };
    }

    return this.request(`/orders/${order.shopifyOrderId}.json`, {
      method: "PUT",
      body: {
        order: {
          id: order.shopifyOrderId,
          tags: appendTag(order.shopifyTags, "qpay-paid")
        }
      }
    });
  }

  async getCheckoutItems(items) {
    if (!this.isConfigured()) {
      throw new Error("Shopify Admin API credentials are not configured");
    }

    const rows = await Promise.all(items.map(async (item) => {
      const variantData = await this.request(`/variants/${encodeURIComponent(item.variantId)}.json`);
      const variant = variantData.variant;
      let productTitle = "Product";
      let image = null;

      if (variant?.product_id) {
        const productData = await this.request(`/products/${encodeURIComponent(variant.product_id)}.json`);
        productTitle = productData.product?.title || productTitle;
        image = productData.product?.image?.src || null;
      }

      const quantity = Number(item.quantity || 1);
      const price = Number(variant?.price || 0);

      return {
        variantId: String(item.variantId),
        productId: variant?.product_id,
        title: productTitle,
        variantTitle: variant?.title,
        image,
        quantity,
        price,
        linePrice: price * quantity
      };
    }));

    return rows;
  }

  async addPaymentUrlToDraftOrder({ draftOrder, paymentUrl }) {
    if (!this.isConfigured()) {
      return { skipped: true, reason: "Shopify Admin API credentials are not configured" };
    }

    const note = appendPaymentUrlToNote(draftOrder.note, paymentUrl);
    const noteAttributes = Array.isArray(draftOrder.note_attributes) ? draftOrder.note_attributes : [];
    const nextNoteAttributes = upsertNoteAttribute(noteAttributes, "QPay payment URL", paymentUrl);

    return this.request(`/draft_orders/${draftOrder.id}.json`, {
      method: "PUT",
      body: {
        draft_order: {
          id: draftOrder.id,
          note,
          note_attributes: nextNoteAttributes,
          tags: appendTag(draftOrder.tags, "qpay-pending")
        }
      }
    });
  }

  async completeDraftOrder({ draftOrderId, paymentPending = false }) {
    if (!this.isConfigured()) {
      throw new Error("Shopify Admin API credentials are not configured");
    }

    const query = paymentPending ? "?payment_pending=true" : "";
    const data = await this.request(`/draft_orders/${draftOrderId}/complete.json${query}`, {
      method: "PUT",
      body: {}
    });

    return data.draft_order;
  }

  async createDraftOrder({
    email,
    phone,
    shippingAddress,
    items,
    shippingPrice = 0,
    shippingTitle = "Delivery"
  }) {
    if (!this.isConfigured()) {
      throw new Error("Shopify Admin API credentials are not configured");
    }

    const lineItems = items.map((item) => ({
      variant_id: Number(item.variantId),
      quantity: Number(item.quantity || 1)
    }));
    const tags = "qpay-draft, custom-checkout";

    const draftOrderData = await this.request("/draft_orders.json", {
      method: "POST",
      body: {
        draft_order: {
          email,
          line_items: lineItems,
          shipping_address: shippingAddress,
          billing_address: shippingAddress,
          note: `QPay payment pending${phone ? `\nPhone: ${phone}` : ""}`,
          tags,
          shipping_lines: Number(shippingPrice) > 0
            ? [{ title: shippingTitle, price: String(shippingPrice), code: "CUSTOM_DELIVERY" }]
            : []
        }
      }
    });

    return draftOrderData.draft_order;
  }

  async request(path, { method = "GET", body } = {}) {
    const accessToken = await this.getAccessToken();
    let result = await this.performRequest(path, { method, body, accessToken });

    if ((result.response.status === 401 || result.response.status === 403) && !this.staticAccessToken) {
      this.accessToken = null;
      this.tokenExpiresAt = 0;
      const freshAccessToken = await this.getAccessToken();
      result = await this.performRequest(path, { method, body, accessToken: freshAccessToken });
    }

    if (!result.response.ok) {
      const error = new Error(result.data.errors || `Shopify request failed with ${result.response.status}`);
      error.status = result.response.status;
      error.data = result.data;
      throw error;
    }

    return result.data;
  }

  async performRequest(path, { method, body, accessToken }) {
    const response = await fetch(
      `https://${this.shopDomain}/admin/api/${this.apiVersion}${path}`,
      {
        method,
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": accessToken
        },
        body: body ? JSON.stringify(body) : undefined
      }
    );

    const text = await response.text();
    const data = parseShopifyJson(text, response);

    return { response, data };
  }

  async getAccessToken() {
    if (this.accessToken && Date.now() < this.tokenExpiresAt) {
      return this.accessToken;
    }

    if (!this.clientId || !this.clientSecret) {
      throw new Error("SHOPIFY_ADMIN_ACCESS_TOKEN or SHOPIFY_CLIENT_ID/SHOPIFY_CLIENT_SECRET is required");
    }

    const form = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: this.clientId,
      client_secret: this.clientSecret
    });

    const response = await fetch(`https://${this.shopDomain}/admin/oauth/access_token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: form
    });

    const text = await response.text();
    const data = parseShopifyJson(text, response);

    if (!response.ok) {
      const error = new Error(data.error_description || data.error || `Shopify token request failed with ${response.status}`);
      error.status = response.status;
      error.data = data;
      throw error;
    }

    this.accessToken = data.access_token;
    const expiresInMs = Number(data.expires_in ?? 86399) * 1000;
    this.tokenExpiresAt = Date.now() + expiresInMs - 60_000;

    if (!this.accessToken) {
      throw new Error("Shopify did not return access_token");
    }

    return this.accessToken;
  }
}

function normalizeShopDomain(shopDomain) {
  if (!shopDomain) {
    return "";
  }

  return shopDomain
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "");
}

function parseShopifyJson(text, response) {
  if (!text) {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch {
    const error = new Error(`Shopify returned non-JSON response with ${response.status}`);
    error.status = response.status;
    error.data = {
      contentType: response.headers.get("content-type"),
      bodyStart: text.slice(0, 240)
    };
    throw error;
  }
}

function upsertNoteAttribute(noteAttributes, name, value) {
  const next = noteAttributes.filter((item) => item.name !== name);
  next.push({ name, value });
  return next;
}

function appendPaymentUrlToNote(currentNote, paymentUrl) {
  const note = String(currentNote || "").trim();
  const line = `QPay payment URL: ${paymentUrl}`;

  if (note.includes(paymentUrl)) {
    return note;
  }

  return note ? `${note}\n${line}` : line;
}

function appendTag(currentTags = "", tag) {
  const tags = String(currentTags)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  if (!tags.includes(tag)) {
    tags.push(tag);
  }

  return tags.join(", ");
}
