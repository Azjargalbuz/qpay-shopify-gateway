export class ShopifyClient {
  constructor({
    shopDomain,
    accessToken,
    apiVersion = "2026-04"
  }) {
    this.shopDomain = normalizeShopDomain(shopDomain);
    this.accessToken = accessToken;
    this.apiVersion = apiVersion;
  }

  isConfigured() {
    return Boolean(this.shopDomain && this.accessToken);
  }

  async addPaymentUrlToOrder({ order, paymentUrl }) {
    if (!this.isConfigured()) {
      return { skipped: true, reason: "SHOPIFY_SHOP_DOMAIN or SHOPIFY_ADMIN_ACCESS_TOKEN is not configured" };
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
      return { skipped: true, reason: "SHOPIFY_SHOP_DOMAIN or SHOPIFY_ADMIN_ACCESS_TOKEN is not configured" };
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
      return { skipped: true, reason: "SHOPIFY_SHOP_DOMAIN or SHOPIFY_ADMIN_ACCESS_TOKEN is not configured" };
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
    const response = await fetch(
      `https://${this.shopDomain}/admin/api/${this.apiVersion}${path}`,
      {
        method,
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": this.accessToken
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
