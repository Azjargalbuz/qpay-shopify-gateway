const BASE_URLS = {
  sandbox: "https://merchant-sandbox.qpay.mn/v2",
  production: "https://merchant.qpay.mn/v2"
};

export class QPayClient {
  constructor({
    env = "sandbox",
    clientId,
    clientSecret,
    invoiceCode,
    callbackUrl
  }) {
    if (!clientId || !clientSecret || !invoiceCode) {
      throw new Error("QPAY_CLIENT_ID, QPAY_CLIENT_SECRET, and QPAY_INVOICE_CODE are required");
    }

    this.baseUrl = BASE_URLS[env] ?? BASE_URLS.sandbox;
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.invoiceCode = invoiceCode;
    this.callbackUrl = callbackUrl;
    this.token = null;
    this.refreshToken = null;
    this.tokenExpiresAt = 0;
  }

  async createInvoice({
    senderInvoiceNo,
    amount,
    description,
    receiverCode = "terminal",
    callbackUrl = this.callbackUrl,
    receiverData
  }) {
    if (!senderInvoiceNo || !amount || !description) {
      throw new Error("senderInvoiceNo, amount, and description are required");
    }

    return this.request("/invoice", {
      method: "POST",
      body: {
        invoice_code: this.invoiceCode,
        sender_invoice_no: senderInvoiceNo,
        invoice_receiver_code: receiverCode,
        invoice_receiver_data: receiverData,
        invoice_description: description,
        amount,
        callback_url: callbackUrl
      }
    });
  }

  async getInvoice(invoiceId) {
    return this.request(`/invoice/${encodeURIComponent(invoiceId)}`);
  }

  async cancelInvoice(invoiceId) {
    return this.request(`/invoice/${encodeURIComponent(invoiceId)}`, {
      method: "DELETE"
    });
  }

  async checkInvoicePayment(invoiceId) {
    return this.request("/payment/check", {
      method: "POST",
      body: {
        object_type: "INVOICE",
        object_id: invoiceId,
        offset: {
          page_number: 1,
          page_limit: 100
        }
      }
    });
  }

  async getPayment(paymentId) {
    return this.request(`/payment/${encodeURIComponent(paymentId)}`);
  }

  async request(path, { method = "GET", body } = {}) {
    const token = await this.getAccessToken();
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: body ? JSON.stringify(body) : undefined
    });

    return parseQPayResponse(response);
  }

  async getAccessToken() {
    if (this.token && Date.now() < this.tokenExpiresAt) {
      return this.token;
    }

    if (this.refreshToken) {
      try {
        await this.refreshAccessToken();
        return this.token;
      } catch {
        this.token = null;
        this.refreshToken = null;
        this.tokenExpiresAt = 0;
      }
    }

    await this.fetchAccessToken();
    return this.token;
  }

  async fetchAccessToken() {
    const response = await fetch(`${this.baseUrl}/auth/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basicAuth(this.clientId, this.clientSecret)}`,
        "Content-Type": "application/json"
      }
    });

    const data = await parseQPayResponse(response);
    this.setTokenData(data);
  }

  async refreshAccessToken() {
    const response = await fetch(`${this.baseUrl}/auth/refresh`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.refreshToken}`,
        "Content-Type": "application/json"
      }
    });

    const data = await parseQPayResponse(response);
    this.setTokenData(data);
  }

  setTokenData(data) {
    this.token = data.access_token;
    this.refreshToken = data.refresh_token;
    const expiresInMs = Number(data.expires_in ?? 300) * 1000;
    this.tokenExpiresAt = Date.now() + expiresInMs - 30_000;

    if (!this.token) {
      throw new Error("QPay did not return access_token");
    }
  }
}

async function parseQPayResponse(response) {
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};

  if (!response.ok) {
    const message = data.message || data.error || `QPay request failed with ${response.status}`;
    const error = new Error(message);
    error.status = response.status;
    error.data = data;
    throw error;
  }

  return data;
}

function basicAuth(username, password) {
  return Buffer.from(`${username}:${password}`).toString("base64");
}
