export function checkoutPageHtml() {
  return `<!doctype html>
<html lang="mn">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>QPay Checkout</title>
  <style>
    :root {
      --ink: #111827;
      --muted: #687385;
      --line: #d9dee7;
      --bg: #f6f8fb;
      --blue: #155eef;
      --danger: #c62828;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: Arial, Helvetica, sans-serif;
      color: var(--ink);
      background: var(--bg);
    }
    header {
      height: 76px;
      display: grid;
      place-items: center;
      background: #fff;
      border-bottom: 1px solid var(--line);
      font-size: 28px;
      font-weight: 800;
    }
    main {
      width: min(1120px, 100%);
      margin: 0 auto;
      padding: 30px 20px 42px;
      display: grid;
      grid-template-columns: minmax(0, 1.1fr) minmax(320px, 0.8fr);
      gap: 34px;
    }
    h2 {
      font-size: 20px;
      margin: 0 0 16px;
    }
    form {
      display: grid;
      gap: 22px;
    }
    .fields {
      display: grid;
      gap: 12px;
    }
    .pair {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
    }
    input, textarea {
      width: 100%;
      min-height: 50px;
      border: 1px solid #cbd2dc;
      border-radius: 8px;
      padding: 13px 15px;
      font-size: 16px;
      background: #fff;
      color: var(--ink);
    }
    textarea {
      min-height: 82px;
      resize: vertical;
    }
    .shipping {
      border: 1px solid var(--line);
      background: #fff;
      border-radius: 8px;
      padding: 17px;
      display: flex;
      justify-content: space-between;
      gap: 16px;
      align-items: center;
    }
    .shipping strong { display: block; margin-bottom: 4px; }
    .summary {
      background: #fff;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 24px;
      align-self: start;
    }
    .items {
      display: grid;
      gap: 14px;
      margin-bottom: 18px;
    }
    .item {
      display: grid;
      grid-template-columns: 58px 1fr auto;
      gap: 12px;
      align-items: center;
    }
    .item img {
      width: 58px;
      height: 58px;
      object-fit: cover;
      border-radius: 8px;
      border: 1px solid var(--line);
      background: #f0f2f5;
    }
    .item-title {
      font-weight: 700;
      line-height: 1.3;
    }
    .item-meta {
      margin-top: 4px;
      color: var(--muted);
      font-size: 14px;
    }
    .totals {
      border-top: 1px solid var(--line);
      padding-top: 16px;
      display: grid;
      gap: 10px;
    }
    .total-row {
      display: flex;
      justify-content: space-between;
      gap: 12px;
    }
    .grand {
      font-size: 20px;
      font-weight: 800;
      padding-top: 8px;
    }
    button {
      min-height: 54px;
      border: 0;
      border-radius: 8px;
      background: var(--blue);
      color: #fff;
      font-size: 16px;
      font-weight: 800;
      cursor: pointer;
    }
    button:disabled {
      opacity: .65;
      cursor: wait;
    }
    .error {
      color: var(--danger);
      font-weight: 700;
      min-height: 22px;
    }
    .muted { color: var(--muted); }
    @media (max-width: 820px) {
      main { grid-template-columns: 1fr; padding: 22px 14px 34px; }
      .pair { grid-template-columns: 1fr; }
      header { height: 64px; font-size: 24px; }
    }
  </style>
</head>
<body>
  <header>Sunbeam</header>
  <main>
    <form id="checkout">
      <section>
        <h2>Холбоо барих мэдээлэл</h2>
        <div class="fields">
          <input name="email" type="email" placeholder="И-мэйл" autocomplete="email" required>
          <input name="phone" type="tel" placeholder="Утасны дугаар" autocomplete="tel" required>
        </div>
      </section>
      <section>
        <h2>Хүргэлтийн мэдээлэл</h2>
        <div class="fields">
          <div class="pair">
            <input name="lastName" placeholder="Овог" autocomplete="family-name" required>
            <input name="firstName" placeholder="Нэр" autocomplete="given-name" required>
          </div>
          <textarea name="address1" placeholder="Хаяг" autocomplete="street-address" required></textarea>
          <input name="address2" placeholder="Орц, давхар, хаалганы дугаар">
          <input name="city" placeholder="Хот эсвэл аймаг" autocomplete="address-level2" required>
        </div>
      </section>
      <section>
        <h2>Хүргэлтийн хэлбэр</h2>
        <div class="shipping">
          <div>
            <strong>Энгийн</strong>
            <span class="muted">48 цагийн дотор хүргэгдэнэ</span>
          </div>
          <strong id="shipping-price">...</strong>
        </div>
      </section>
      <section>
        <h2>Төлбөрийн хэлбэр</h2>
        <div class="shipping">
          <div>
            <strong>QPay</strong>
            <span class="muted">Захиалга үүсээд QR төлбөрийн хуудас нээгдэнэ</span>
          </div>
          <strong>Q</strong>
        </div>
      </section>
      <div class="error" id="error"></div>
      <button id="submit" type="submit">QPay-р төлөх</button>
    </form>
    <aside class="summary">
      <div class="items" id="items"><span class="muted">Сагс уншиж байна...</span></div>
      <div class="totals">
        <div class="total-row"><span>Бараа</span><strong id="subtotal">...</strong></div>
        <div class="total-row"><span>Хүргэлт</span><strong id="shipping">...</strong></div>
        <div class="total-row grand"><span>Нийт</span><strong id="total">...</strong></div>
      </div>
    </aside>
  </main>
  <script>
    const params = new URLSearchParams(location.search);
    const itemsParam = params.get("items") || "";
    const formatMoney = (amount) => new Intl.NumberFormat("mn-MN").format(Number(amount || 0)) + " MNT";
    let checkoutItems = [];
    let shippingPrice = 0;

    async function loadCart() {
      if (!itemsParam) {
        throw new Error("Сагсны мэдээлэл олдсонгүй.");
      }

      const response = await fetch("/api/custom-checkout/cart?items=" + encodeURIComponent(itemsParam));
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || "Сагс уншиж чадсангүй.");
      }

      checkoutItems = data.items;
      shippingPrice = data.shippingPrice;
      renderSummary(data);
    }

    function renderSummary(data) {
      document.getElementById("items").innerHTML = data.items.map((item) => {
        const image = item.image || "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='58' height='58'%3E%3Crect width='58' height='58' fill='%23edf0f4'/%3E%3C/svg%3E";
        return '<div class="item">' +
          '<img alt="" src="' + image + '">' +
          '<div><div class="item-title">' + escapeHtml(item.title) + '</div>' +
          '<div class="item-meta">' + escapeHtml(item.variantTitle || "") + ' x ' + item.quantity + '</div></div>' +
          '<strong>' + formatMoney(item.linePrice) + '</strong>' +
        '</div>';
      }).join("");
      document.getElementById("subtotal").textContent = formatMoney(data.subtotal);
      document.getElementById("shipping").textContent = formatMoney(data.shippingPrice);
      document.getElementById("shipping-price").textContent = formatMoney(data.shippingPrice);
      document.getElementById("total").textContent = formatMoney(data.total);
    }

    document.getElementById("checkout").addEventListener("submit", async (event) => {
      event.preventDefault();
      const button = document.getElementById("submit");
      const error = document.getElementById("error");
      button.disabled = true;
      button.textContent = "Захиалга үүсгэж байна...";
      error.textContent = "";

      const form = new FormData(event.currentTarget);
      const payload = {
        items: checkoutItems.map((item) => ({ variantId: item.variantId, quantity: item.quantity })),
        customer: {
          email: form.get("email"),
          phone: form.get("phone")
        },
        shippingAddress: {
          first_name: form.get("firstName"),
          last_name: form.get("lastName"),
          address1: form.get("address1"),
          address2: form.get("address2"),
          city: form.get("city"),
          country: "Mongolia",
          phone: form.get("phone")
        }
      };

      try {
        const response = await fetch("/api/custom-checkout/orders", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });
        const data = await response.json();
        if (!response.ok) {
          throw new Error(data.error || "Захиалга үүсгэж чадсангүй.");
        }
        location.href = data.paymentUrl;
      } catch (err) {
        error.textContent = err.message;
        button.disabled = false;
        button.textContent = "QPay-р төлөх";
      }
    });

    function escapeHtml(value) {
      return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
    }

    loadCart().catch((err) => {
      document.getElementById("items").innerHTML = '<span class="error">' + escapeHtml(err.message) + '</span>';
      document.getElementById("submit").disabled = true;
    });
  </script>
</body>
</html>`;
}
