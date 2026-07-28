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

    return this.request(`/orders/${order.id}.json`, {
      method: "PUT",
      body: {
        order: {
          id: order.id,
          note_attributes: nextNoteAttributes,
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

  async request(path, { method = "GET", body } = {}) {
    const accessToken = await this.getAccessToken();
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
    const data = text ? JSON.parse(text) : {};

    if (!response.ok) {
      const error = new Error(data.errors || `Shopify request failed with ${response.status}`);
      error.status = response.status;
      error.data = data;
      throw error;
    }

    return data;
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
    const data = text ? JSON.parse(text) : {};

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

function upsertNoteAttribute(noteAttributes, name, value) {
  const next = noteAttributes.filter((item) => item.name !== name);
  next.push({ name, value });
  return next;
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
