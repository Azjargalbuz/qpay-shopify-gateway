export class HipayClient {
  constructor({
    baseUrl = "https://test.hipay.mn",
    clientId,
    clientSecret,
    redirectUrl,
    webhookUrl
  }) {
    if (!clientId || !clientSecret) {
      throw new Error("HIPAY_CLIENT_ID and HIPAY_CLIENT_SECRET are required");
    }

    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.redirectUrl = redirectUrl;
    this.webhookUrl = webhookUrl;
  }

  async createCheckout({ amount, redirectUrl = this.redirectUrl, webhookUrl = this.webhookUrl, items = [] }) {
    return this.request("/checkout", {
      method: "POST",
      body: {
        entityId: this.clientId,
        redirect_uri: redirectUrl,
        webhook_url: webhookUrl,
        amount,
        qrData: false,
        items
      }
    });
  }

  async getCheckout(checkoutId) {
    return this.request(`/checkout/get/${encodeURIComponent(checkoutId)}?entityId=${encodeURIComponent(this.clientId)}`);
  }

  paymentFormUrl({ checkoutId, email, phone, lang = "mn" }) {
    const url = new URL(`${this.baseUrl}/payment/`);
    url.searchParams.set("checkoutId", checkoutId);
    url.searchParams.set("lang", lang);
    if (email) url.searchParams.set("email", email);
    if (phone) url.searchParams.set("phone", phone);
    return url.toString();
  }

  deeplink(checkoutId) {
    return `hipay://pay/${encodeURIComponent(checkoutId)}`;
  }

  async request(path, { method = "GET", body } = {}) {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.clientSecret}`,
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: body ? JSON.stringify(body) : undefined
    });

    const text = await response.text();
    const data = text ? JSON.parse(text) : {};

    if (!response.ok) {
      const error = new Error(data.message || data.error || `HiPay request failed with ${response.status}`);
      error.status = response.status;
      error.data = data;
      throw error;
    }

    const result = Array.isArray(data) ? data[0] : data;
    if (result?.description && result.description !== "SUCCESS") {
      const error = new Error(result.message || `HiPay returned ${result.description}`);
      error.data = result;
      throw error;
    }

    return result;
  }
}
