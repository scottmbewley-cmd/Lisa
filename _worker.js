// Evelle — single-file Worker
// Handles /api/* routes and staff-area auth gating, serves everything else
// as static assets via the ASSETS binding.

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function hashValue(value) {
  const enc = new TextEncoder().encode(value);
  const buf = await crypto.subtle.digest("SHA-256", enc);
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

async function isAuthed(request, env) {
  const cookie = request.headers.get("Cookie") || "";
  const match = cookie.match(/ev_staff_session=([^;]+)/);
  if (!match) return false;
  const expected = await hashValue(env.STAFF_PASSWORD || "changeme-EV2026");
  return match[1] === expected;
}

async function handleLogin(request, env) {
  const body = await request.json().catch(() => ({}));
  const correct = env.STAFF_PASSWORD || "changeme-EV2026";
  if ((body.password || "") !== correct) {
    return json({ success: false, error: "Incorrect password" }, 401);
  }
  const sessionValue = await hashValue(correct);
  const headers = new Headers({ "Content-Type": "application/json" });
  headers.append("Set-Cookie", `ev_staff_session=${sessionValue}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`);
  return new Response(JSON.stringify({ success: true }), { status: 200, headers });
}

async function nextSku(env) {
  const { results } = await env.DB.prepare(`SELECT sku FROM inventory WHERE sku LIKE 'EV-%'`).all();
  const nums = results.map(r => (r.sku.match(/^EV-(\d+)$/) || [])[1]).filter(Boolean).map(Number);
  const next = nums.length ? Math.max(...nums) + 1 : 1;
  return "EV-" + String(next).padStart(4, "0");
}

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Fresh routes for the Accounting tool — deliberately NOT /api/expenditure,
// which is dead code blocked by HUB_DISABLED and tied to the old disabled
// Business Hub. These reuse the existing `expenditure` table.
//
// "Inventory Stock" is reserved for Task 3's automatic logging
// (linked_inventory_id set, category always 'Inventory Stock'). It's
// excluded here on purpose so a manual entry can never masquerade as an
// auto-generated one — linked_inventory_id IS NULL is what proves an
// entry came from this form.
const EXPENSE_CATEGORIES = ["Packaging", "Subscriptions", "Office", "Marketing", "Fees", "Other"];

async function handleExpenseEntries(request, env, url) {
  if (request.method === "GET") {
    const { results } = await env.DB.prepare(`SELECT * FROM expenditure ORDER BY exp_date DESC, created_at DESC LIMIT 100`).all();
    return json(results);
  }
  if (request.method === "POST") {
    const b = await request.json();
    if (!b.category || !EXPENSE_CATEGORIES.includes(b.category)) {
      return json({ error: "category must be one of: " + EXPENSE_CATEGORIES.join(", ") }, 400);
    }
    const amount = Number(b.amount) || 0;
    if (amount <= 0) return json({ error: "amount must be greater than 0" }, 400);
    const insertRes = await env.DB.prepare(
      `INSERT INTO expenditure (exp_date, category, paid_from, amount, notes, linked_inventory_id)
       VALUES (?1,?2,?3,?4,?5,NULL)`
    ).bind(
      b.exp_date || new Date().toISOString().slice(0, 10),
      b.category, b.paid_from || "", amount, b.notes || ""
    ).run();
    return json({ success: true, id: insertRes.meta.last_row_id });
  }
  if (request.method === "DELETE") {
    const id = url.searchParams.get("id");
    if (!id) return json({ error: "id required" }, 400);
    const row = await env.DB.prepare(`SELECT linked_inventory_id FROM expenditure WHERE id = ?1`).bind(id).first();
    if (!row) return json({ error: "Not found" }, 404);
    if (row.linked_inventory_id !== null) {
      return json({ error: "That's an automatic stock entry — delete or correct it from Inventory instead." }, 400);
    }
    await env.DB.prepare(`DELETE FROM expenditure WHERE id = ?1`).bind(id).run();
    return json({ success: true });
  }
  return json({ error: "Method not allowed" }, 405);
}

// Revenue: everything actually received (item subtotal + shipping) for
// non-cancelled orders in the period.
//
// COGS (cost of goods sold): the snapshotted line_cost of items sold in
// this period — not the same thing as money spent buying stock in this
// period, which is a cash-flow fact and can fall in a completely
// different period. Gross Profit = Revenue - COGS.
//
// Stock cash spent is reported as its own figure and NEVER subtracted
// from profit directly — it already flows into Gross Profit later, at
// whatever point that stock actually sells, via COGS. Subtracting it here
// too would double-count it.
//
// Net Profit = Gross Profit - operating expenses, where "operating
// expenses" is every expenditure category EXCEPT 'Inventory Stock'.
async function handleAccountingReport(request, env, url) {
  if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  if (!from || !to) return json({ error: "from and to (YYYY-MM-DD) are required" }, 400);

  const revRow = await env.DB.prepare(
    `SELECT COALESCE(SUM(total),0) as revenue, COUNT(*) as order_count
     FROM orders WHERE status != 'cancelled' AND date(created_at) BETWEEN ?1 AND ?2`
  ).bind(from, to).first();

  const cogsRow = await env.DB.prepare(
    `SELECT COALESCE(SUM(oi.line_cost),0) as cogs
     FROM order_items oi JOIN orders o ON o.id = oi.order_id
     WHERE o.status != 'cancelled' AND date(o.created_at) BETWEEN ?1 AND ?2`
  ).bind(from, to).first();

  const { results: byCategory } = await env.DB.prepare(
    `SELECT COALESCE(category,'(none)') as category, COALESCE(SUM(amount),0) as amount
     FROM expenditure WHERE exp_date BETWEEN ?1 AND ?2
     GROUP BY category ORDER BY amount DESC`
  ).bind(from, to).all();

  const stockRow = byCategory.find(r => r.category === "Inventory Stock");
  const stockCashSpent = stockRow ? Number(stockRow.amount) : 0;
  const operatingExpenses = byCategory.filter(r => r.category !== "Inventory Stock").reduce((sum, r) => sum + Number(r.amount), 0);

  const revenue = Number(revRow.revenue) || 0;
  const cogs = Number(cogsRow.cogs) || 0;
  const grossProfit = revenue - cogs;
  const netProfit = grossProfit - operatingExpenses;

  return json({
    from, to,
    revenue, order_count: revRow.order_count, cogs, gross_profit: grossProfit,
    operating_expenses: operatingExpenses, net_profit: netProfit, stock_cash_spent: stockCashSpent,
    expense_by_category: byCategory.map(r => ({ category: r.category, amount: Number(r.amount) })),
  });
}

async function getActiveLibraries(env) {
  const { results } = await env.DB.prepare(`SELECT active_libraries FROM shop_config WHERE id = 1`).all();
  const raw = (results[0] && results[0].active_libraries) || "Ring,Bracelet,Necklace,Earring,Anklet";
  return raw.split(",").map(s => s.trim()).filter(Boolean);
}

async function renderShopPage(request, env) {
  const libs = await getActiveLibraries(env);
  const placeholders = libs.map((_, i) => `?${i + 1}`).join(",");
  const { results } = libs.length
    ? await env.DB.prepare(`SELECT * FROM inventory WHERE category IN (${placeholders}) AND shop_position IS NOT NULL ORDER BY RANDOM()`).bind(...libs).all()
    : { results: [] };

  const CATEGORY_PLURAL = { Ring: "rings", Bracelet: "bracelets", Necklace: "necklaces", Earring: "earrings", Anklet: "anklets", Other: "other" };

  const cardsHtml = results.length
    ? results.map(p => {
        const soldOut = Number(p.quantity) <= 0;
        const searchBlob = (p.name + " " + p.category + " " + (CATEGORY_PLURAL[p.category] || "") + " " + (p.notes || "")).toLowerCase();
        return `
      <div class="product-card${soldOut ? ' sold-out' : ''}" data-category="${escapeHtml(p.category)}" data-search="${escapeHtml(searchBlob)}">
        <div class="product-image">
          <img src="${escapeHtml(p.photo_url)}" alt="${escapeHtml(p.name)}" />
          ${soldOut ? '<span class="sold-out-badge">Sold Out</span>' : ''}
        </div>
        <div class="product-info">
          <span class="eyebrow" style="font-size:0.85rem;">${escapeHtml(p.category)}</span>
          <h3>${escapeHtml(p.name)}</h3>
          <p class="product-price">\u00a3${Number(p.sell_price || 0).toFixed(2)}</p>
          <p class="product-sku">SKU ${escapeHtml(p.sku)}</p>
          <button type="button" class="add-to-cart-btn" data-id="${escapeHtml(p.id)}" data-sku="${escapeHtml(p.sku)}" data-name="${escapeHtml(p.name)}" data-price="${Number(p.sell_price || 0)}" data-image="${escapeHtml(p.photo_url)}" data-quantity="${Number(p.quantity || 0)}"${soldOut ? ' disabled' : ''}>${soldOut ? 'Sold Out' : 'Add to Cart'}</button>
        </div>
        <div class="product-desc">${escapeHtml(p.notes)}</div>
      </div>`;
      }).join("")
    : `<p class="muted" style="grid-column:1/-1;">New pieces coming soon — check back shortly.</p>`;

  const template = await (await env.ASSETS.fetch(new Request(new URL("/shop.html", request.url)))).text();
  const html = template.replace("<!--SHOP_PRODUCTS-->", cardsHtml).replace("<!--SOCIAL_LINKS-->", socialLinksHtml(await getSocialLinks(env)));
  return new Response(html, { headers: { "Content-Type": "text/html;charset=UTF-8" } });
}

async function getDeliverySettings(env) {
  const { results } = await env.DB.prepare(`SELECT * FROM delivery_settings WHERE id = 1`).all();
  return results[0] || {};
}

async function handleDeliverySettings(request, env) {
  if (request.method === "GET") {
    return json(await getDeliverySettings(env));
  }
  if (request.method === "POST") {
    const b = await request.json();
    const fields = ["show_return_address", "return_name", "return_address"];
    const sets = []; const vals = [];
    fields.forEach(f => {
      if (b[f] !== undefined) {
        sets.push(`${f} = ?`);
        vals.push(f === "show_return_address" ? (b[f] ? 1 : 0) : b[f]);
      }
    });
    if (!sets.length) return json({ error: "no fields to update" }, 400);
    sets.push(`updated_at = CURRENT_TIMESTAMP`);
    await env.DB.prepare(`UPDATE delivery_settings SET ${sets.join(", ")} WHERE id = 1`).bind(...vals).run();
    return json({ success: true });
  }
  return json({ error: "Method not allowed" }, 405);
}

async function getSocialLinks(env) {
  const { results } = await env.DB.prepare(`SELECT * FROM social_links WHERE id = 1`).all();
  return results[0] || {};
}

function socialLinksHtml(sl) {
  const icons = [];
  if (sl.instagram_url) {
    icons.push(`<a href="${escapeHtml(sl.instagram_url)}" aria-label="Instagram" target="_blank" rel="noopener"><svg viewBox="0 0 24 24"><path d="M12 2.2c3.2 0 3.6 0 4.9.1 1.2.1 2 .2 2.4.4.6.2 1 .5 1.5 1 .4.4.7.8 1 1.5.2.5.3 1.3.4 2.4.1 1.3.1 1.7.1 4.9s0 3.6-.1 4.9c-.1 1.2-.2 2-.4 2.4-.2.6-.5 1-1 1.5-.4.4-.8.7-1.5 1-.5.2-1.3.3-2.4.4-1.3.1-1.7.1-4.9.1s-3.6 0-4.9-.1c-1.2-.1-2-.2-2.4-.4-.6-.2-1-.5-1.5-1-.4-.4-.7-.8-1-1.5-.2-.5-.3-1.3-.4-2.4C2 15.6 2 15.2 2 12s0-3.6.1-4.9c.1-1.2.2-2 .4-2.4.2-.6.5-1 1-1.5.4-.4.8-.7 1.5-1 .5-.2 1.3-.3 2.4-.4C8.4 2.2 8.8 2.2 12 2.2zm0 3a6.8 6.8 0 100 13.6 6.8 6.8 0 000-13.6zm0 2a4.8 4.8 0 110 9.6 4.8 4.8 0 010-9.6zm7-2.1a1.6 1.6 0 11-3.2 0 1.6 1.6 0 013.2 0z"/></svg></a>`);
  }
  if (sl.facebook_url) {
    icons.push(`<a href="${escapeHtml(sl.facebook_url)}" aria-label="Facebook" target="_blank" rel="noopener"><svg viewBox="0 0 24 24"><path d="M13.5 21v-8h2.7l.4-3.1h-3.1V8c0-.9.2-1.5 1.5-1.5H17V3.6C16.7 3.6 15.7 3.5 14.5 3.5c-2.4 0-4 1.5-4 4.2v2.2H7.8V13h2.7v8h3z"/></svg></a>`);
  }
  if (sl.whatnot_url) {
    icons.push(`<a href="${escapeHtml(sl.whatnot_url)}" aria-label="Whatnot" target="_blank" rel="noopener"><span class="w-mark">W</span></a>`);
  }
  return icons.join("\n          ");
}

async function handleSocialLinks(request, env) {
  if (request.method === "GET") {
    return json(await getSocialLinks(env));
  }
  if (request.method === "POST") {
    const b = await request.json();
    const fields = ["instagram_url", "facebook_url", "whatnot_url"];
    const sets = []; const vals = [];
    fields.forEach(f => { if (b[f] !== undefined) { sets.push(`${f} = ?`); vals.push(b[f] === "" ? null : b[f]); } });
    if (!sets.length) return json({ error: "no fields to update" }, 400);
    sets.push(`updated_at = CURRENT_TIMESTAMP`);
    await env.DB.prepare(`UPDATE social_links SET ${sets.join(", ")} WHERE id = 1`).bind(...vals).run();
    return json({ success: true });
  }
  return json({ error: "Method not allowed" }, 405);
}

async function getHomeContent(env) {
  const { results } = await env.DB.prepare(`SELECT * FROM home_content WHERE id = 1`).all();
  return results[0] || {};
}

async function renderHomePage(request, env) {
  const hc = await getHomeContent(env);
  const heroUrl = hc.hero_image_url || "assets/images/evelle-hero.jpg";
  const ids = [hc.featured_1, hc.featured_2, hc.featured_3, hc.featured_4].filter(Boolean);
  let products = [];
  if (ids.length) {
    const placeholders = ids.map((_, i) => `?${i + 1}`).join(",");
    const { results } = await env.DB.prepare(`SELECT * FROM inventory WHERE id IN (${placeholders})`).bind(...ids).all();
    products = ids.map(id => results.find(r => r.id === id)).filter(Boolean);
  }

  const cardsHtml = products.length
    ? products.map(p => {
        const soldOut = Number(p.quantity) <= 0;
        return `
      <div class="product-card${soldOut ? ' sold-out' : ''}">
        <div class="product-image">
          <img src="${escapeHtml(p.photo_url)}" alt="${escapeHtml(p.name)}" />
          ${soldOut ? '<span class="sold-out-badge">Sold Out</span>' : ''}
        </div>
        <div class="product-info">
          <h3>${escapeHtml(p.name)}</h3>
          <p class="product-price">\u00a3${Number(p.sell_price || 0).toFixed(2)}</p>
          <p class="product-sku">SKU ${escapeHtml(p.sku)}</p>
        </div>
        <div class="product-desc">${escapeHtml(p.notes)}</div>
      </div>`;
      }).join("")
    : `<p class="muted" style="grid-column:1/-1;">New pieces coming soon \u2014 check back shortly.</p>`;

  const template = await (await env.ASSETS.fetch(new Request(new URL("/index.html", request.url)))).text();
  const html = template
    .replace("<!--HERO_IMAGE-->", escapeHtml(heroUrl))
    .replace("<!--HOME_PRODUCTS-->", cardsHtml)
    .replace("<!--WHY_HEADING-->", escapeHtml(hc.why_heading || "Everyday jewellery, built to last"))
    .replace("<!--WHY_BODY-->", escapeHtml(hc.why_body || ""))
    .replace("<!--SOCIAL_LINKS-->", socialLinksHtml(await getSocialLinks(env)));
  return new Response(html, { headers: { "Content-Type": "text/html;charset=UTF-8" } });
}

async function handleHomeContent(request, env) {
  if (request.method === "GET") {
    const hc = await getHomeContent(env);
    return json(hc);
  }
  if (request.method === "POST") {
    const b = await request.json();
    const fields = ["hero_image_url", "featured_1", "featured_2", "featured_3", "featured_4", "why_heading", "why_body"];
    const sets = []; const vals = [];
    fields.forEach(f => { if (b[f] !== undefined) { sets.push(`${f} = ?`); vals.push(b[f] === "" ? null : b[f]); } });
    if (!sets.length) return json({ error: "no fields to update" }, 400);
    sets.push(`updated_at = CURRENT_TIMESTAMP`);
    await env.DB.prepare(`UPDATE home_content SET ${sets.join(", ")} WHERE id = 1`).bind(...vals).run();
    return json({ success: true });
  }
  return json({ error: "Method not allowed" }, 405);
}
async function getStoryContent(env) {
  const { results } = await env.DB.prepare(`SELECT * FROM story_content WHERE id = 1`).all();
  return results[0] || {};
}

async function renderStoryPage(request, env) {
  const sc = await getStoryContent(env);
  const imageHtml = sc.image_url
    ? `<img src="${escapeHtml(sc.image_url)}" alt="" style="width:100%;max-width:480px;aspect-ratio:4/5;object-fit:cover;border-radius:20px;display:block;margin:0 auto 32px;" />`
    : "";
  const noteHtml = sc.note
    ? `<p class="muted" style="font-style:italic;">${escapeHtml(sc.note)}</p>`
    : "";

  const template = await (await env.ASSETS.fetch(new Request(new URL("/story.html", request.url)))).text();
  const html = template
    .replace("<!--STORY_EYEBROW-->", escapeHtml(sc.eyebrow || "From the workbench"))
    .replace("<!--STORY_HEADING-->", escapeHtml(sc.heading || "Our Story"))
    .replace("<!--STORY_IMAGE-->", imageHtml)
    .replace("<!--STORY_PARA1-->", escapeHtml(sc.paragraph_1 || ""))
    .replace("<!--STORY_PARA2-->", escapeHtml(sc.paragraph_2 || ""))
    .replace("<!--STORY_NOTE-->", noteHtml)
    .replace("<!--SOCIAL_LINKS-->", socialLinksHtml(await getSocialLinks(env)));
  return new Response(html, { headers: { "Content-Type": "text/html;charset=UTF-8" } });
}

async function handleStoryContent(request, env) {
  if (request.method === "GET") {
    return json(await getStoryContent(env));
  }
  if (request.method === "POST") {
    const b = await request.json();
    const fields = ["eyebrow", "heading", "paragraph_1", "paragraph_2", "note", "image_url"];
    const sets = []; const vals = [];
    fields.forEach(f => { if (b[f] !== undefined) { sets.push(`${f} = ?`); vals.push(b[f] === "" ? null : b[f]); } });
    if (!sets.length) return json({ error: "no fields to update" }, 400);
    sets.push(`updated_at = CURRENT_TIMESTAMP`);
    await env.DB.prepare(`UPDATE story_content SET ${sets.join(", ")} WHERE id = 1`).bind(...vals).run();
    return json({ success: true });
  }
  return json({ error: "Method not allowed" }, 405);
}

async function getContactContent(env) {
  const { results } = await env.DB.prepare(`SELECT * FROM contact_content WHERE id = 1`).all();
  return results[0] || {};
}

async function renderContactPage(request, env) {
  const cc = await getContactContent(env);
  const template = await (await env.ASSETS.fetch(new Request(new URL("/contact.html", request.url)))).text();
  const html = template
    .replace("<!--CONTACT_EYEBROW-->", escapeHtml(cc.eyebrow || "Say hello"))
    .replace("<!--CONTACT_HEADING-->", escapeHtml(cc.heading || "Get in Touch"))
    .replace("<!--CONTACT_SUBTITLE-->", escapeHtml(cc.subtitle || ""))
    .replace("<!--SOCIAL_LINKS-->", socialLinksHtml(await getSocialLinks(env)));
  return new Response(html, { headers: { "Content-Type": "text/html;charset=UTF-8" } });
}

async function handleContactContent(request, env) {
  if (request.method === "GET") {
    return json(await getContactContent(env));
  }
  if (request.method === "POST") {
    const b = await request.json();
    const fields = ["eyebrow", "heading", "subtitle"];
    const sets = []; const vals = [];
    fields.forEach(f => { if (b[f] !== undefined) { sets.push(`${f} = ?`); vals.push(b[f] === "" ? null : b[f]); } });
    if (!sets.length) return json({ error: "no fields to update" }, 400);
    sets.push(`updated_at = CURRENT_TIMESTAMP`);
    await env.DB.prepare(`UPDATE contact_content SET ${sets.join(", ")} WHERE id = 1`).bind(...vals).run();
    return json({ success: true });
  }
  return json({ error: "Method not allowed" }, 405);
}
async function getCareContent(env) {
  const { results } = await env.DB.prepare(`SELECT * FROM care_content WHERE id = 1`).all();
  return results[0] || {};
}

async function renderCarePage(request, env) {
  const cc = await getCareContent(env);
  const noteHtml = cc.note
    ? `<p class="muted" style="font-style:italic; margin-top:30px;">${escapeHtml(cc.note)}</p>`
    : "";
  const template = await (await env.ASSETS.fetch(new Request(new URL("/care.html", request.url)))).text();
  const html = template
    .replace("<!--CARE_EYEBROW-->", escapeHtml(cc.eyebrow || "Keep it shining"))
    .replace("<!--CARE_HEADING-->", escapeHtml(cc.heading || "Jewellery Care"))
    .replace("<!--CARE_S1_TITLE-->", escapeHtml(cc.section1_title || ""))
    .replace("<!--CARE_S1_BODY-->", escapeHtml(cc.section1_body || ""))
    .replace("<!--CARE_S2_TITLE-->", escapeHtml(cc.section2_title || ""))
    .replace("<!--CARE_S2_BODY-->", escapeHtml(cc.section2_body || ""))
    .replace("<!--CARE_S3_TITLE-->", escapeHtml(cc.section3_title || ""))
    .replace("<!--CARE_S3_BODY-->", escapeHtml(cc.section3_body || ""))
    .replace("<!--CARE_NOTE-->", noteHtml)
    .replace("<!--SOCIAL_LINKS-->", socialLinksHtml(await getSocialLinks(env)));
  return new Response(html, { headers: { "Content-Type": "text/html;charset=UTF-8" } });
}

async function handleCareContent(request, env) {
  if (request.method === "GET") {
    return json(await getCareContent(env));
  }
  if (request.method === "POST") {
    const b = await request.json();
    const fields = ["eyebrow", "heading", "section1_title", "section1_body", "section2_title", "section2_body", "section3_title", "section3_body", "note"];
    const sets = []; const vals = [];
    fields.forEach(f => { if (b[f] !== undefined) { sets.push(`${f} = ?`); vals.push(b[f] === "" ? null : b[f]); } });
    if (!sets.length) return json({ error: "no fields to update" }, 400);
    sets.push(`updated_at = CURRENT_TIMESTAMP`);
    await env.DB.prepare(`UPDATE care_content SET ${sets.join(", ")} WHERE id = 1`).bind(...vals).run();
    return json({ success: true });
  }
  return json({ error: "Method not allowed" }, 405);
}
// Checkout is server-rendered only so the (non-secret) PayPal client id can
// be injected — checkout.html's JS uses it to decide whether to load the
// PayPal SDK at all, or show a graceful "payments aren't live yet" state.
async function renderCheckoutPage(request, env) {
  const template = await (await env.ASSETS.fetch(new Request(new URL("/checkout.html", request.url)))).text();
  const html = template.replace("<!--PAYPAL_CLIENT_ID-->", escapeHtml(env.PAYPAL_CLIENT_ID || "")).replace("<!--SOCIAL_LINKS-->", socialLinksHtml(await getSocialLinks(env)));
  return new Response(html, { headers: { "Content-Type": "text/html;charset=UTF-8" } });
}

async function handleShopProducts(request, env, url) {
  if (request.method === "GET") {
    const { results } = await env.DB.prepare(`SELECT id, name, category, sku, quantity, sell_price, photo_url, shop_position FROM inventory WHERE shop_position IS NOT NULL ORDER BY category ASC, shop_position ASC`).all();
    const mapped = results.map(r => ({
      id: r.id, name: r.name, category: r.category, sku: r.sku, quantity: r.quantity,
      price: "\u00a3" + Number(r.sell_price || 0).toFixed(2),
      image_url: r.photo_url, position: r.shop_position
    }));
    return json(mapped);
  }
  return json({ error: "Method not allowed" }, 405);
}

async function handleShopUnpublish(request, env) {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const b = await request.json();
  if (!b.id) return json({ error: "id required" }, 400);
  await env.DB.prepare(`UPDATE inventory SET shop_position = NULL WHERE id = ?1`).bind(b.id).run();
  return json({ success: true });
}

async function handleImageUpload(request, env) {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  try {
    const formData = await request.formData();
    const file = formData.get("file");
    if (!file || typeof file === "string") return json({ error: "No file provided" }, 400);
    if (!file.type || !file.type.startsWith("image/")) return json({ error: "File must be an image" }, 400);
    if (file.size > 8 * 1024 * 1024) return json({ error: "Image must be under 8MB" }, 400);
    const ext = (file.name.split(".").pop() || "jpg").toLowerCase().replace(/[^a-z0-9]/g, "") || "jpg";
    const key = Date.now() + "-" + Math.random().toString(36).slice(2, 9) + "." + ext;
    await env.IMAGES.put(key, await file.arrayBuffer(), { httpMetadata: { contentType: file.type } });
    return json({ success: true, url: "/images/" + key });
  } catch (e) {
    return json({ error: "Upload failed: " + e.message }, 500);
  }
}

async function handleShopReorder(request, env) {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const b = await request.json();
  const validCats = ["Ring","Bracelet","Necklace","Earring","Anklet","Other"];
  if (!b.category || !validCats.includes(b.category) || !Array.isArray(b.order)) {
    return json({ error: "category and order[] (inventory ids) are required" }, 400);
  }
  const stmts = b.order.map((id, idx) =>
    env.DB.prepare(`UPDATE inventory SET shop_position = ?1 WHERE id = ?2 AND category = ?3`).bind(idx, id, b.category)
  );
  if (stmts.length) await env.DB.batch(stmts);
  return json({ success: true });
}

async function handleShopConfig(request, env) {
  if (request.method === "GET") {
    const libs = await getActiveLibraries(env);
    return json({ active_libraries: libs });
  }
  if (request.method === "POST") {
    const b = await request.json();
    const libs = Array.isArray(b.active_libraries) ? b.active_libraries : [];
    const validCats = ["Ring","Bracelet","Necklace","Earring","Anklet","Other"];
    const valid = libs.filter(l => validCats.includes(l));
    await env.DB.prepare(`UPDATE shop_config SET active_libraries = ?1 WHERE id = 1`).bind(valid.join(",")).run();
    return json({ success: true, active_libraries: valid });
  }
  return json({ error: "Method not allowed" }, 405);
}

const ORDER_STATUSES = ["paid", "posted", "cancelled"];
const UK_SHIPPING_FLAT = 2.50; // must match public/assets/js/cart.js's UK_SHIPPING_FLAT

// Sums duplicate ids so a tampered or stale client cart can't submit the
// same line twice to bypass the per-line stock guard below.
function mergeCartLines(items) {
  const map = new Map();
  (items || []).forEach(it => {
    const id = it && it.id;
    if (id === undefined || id === null || id === "") return;
    const qty = Number(it.qty) || 0;
    if (qty <= 0) return;
    map.set(id, (map.get(id) || 0) + qty);
  });
  return [...map.entries()].map(([id, qty]) => ({ id, qty }));
}

// Confirms an order: atomically checks-and-decrements stock for every cart
// line, then creates the order + order_items rows.
//
// Pricing AND cost are always re-read from the live inventory row at the
// moment of decrement (via UPDATE ... RETURNING) — never trusted from the
// client — so a stale or tampered cart can't under-charge, and order_items
// snapshot both the real price charged and the real cost at that moment,
// rather than a live join back to inventory. cost_per_item on an inventory
// row can change after the fact (a restock at a new price, a correction),
// so without this snapshot a later Gross Profit report would silently use
// today's cost for a sale that happened under yesterday's cost.
//
// Concurrency / the "last item" race: each line's guard-and-decrement is a
// single `UPDATE ... WHERE quantity >= ? RETURNING ...` statement, so the
// check and the decrement happen as one atomic step with no window for
// another request to interleave between them. D1/SQLite serializes writes
// to a given row, so when two customers race for the last unit, only one
// UPDATE's WHERE clause can still see quantity >= qty and succeed — the
// other affects 0 rows (RETURNING gives back nothing), which is treated as
// a clean sold-out failure, never a double-sell.
//
// A cart can hold several different items. If a later line in the same
// order fails its guard, every line already decremented earlier in this
// same call is compensated (added back) before returning, so a multi-item
// order never leaves partial stock committed with no matching order.
//
// Caller contract: only call this AFTER payment has already been captured
// server-side (e.g. a verified PayPal capture) — this function reserves
// stock and records the order, it does not take payment. If it returns
// sold_out after payment has been captured, the caller is responsible for
// refunding/voiding that capture — this function has no PayPal awareness.
async function confirmOrder(env, input) {
  const items = mergeCartLines(input.items);
  if (!items.length) return { success: false, error: "empty_cart" };

  const decremented = []; // { id, qty, sku, name, category, sell_price, cost_per_item }
  for (const line of items) {
    const row = await env.DB.prepare(
      `UPDATE inventory SET quantity = quantity - ?1, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?2 AND quantity >= ?1
       RETURNING sku, name, category, sell_price, cost_per_item`
    ).bind(line.qty, line.id).first();

    if (!row) {
      // Guard failed — undo every decrement already made earlier in this order.
      for (const done of decremented) {
        await env.DB.prepare(`UPDATE inventory SET quantity = quantity + ?1, updated_at = CURRENT_TIMESTAMP WHERE id = ?2`)
          .bind(done.qty, done.id).run();
      }
      const failedItem = await env.DB.prepare(`SELECT id, name, sku FROM inventory WHERE id = ?1`).bind(line.id).first();
      return { success: false, error: "item_unavailable", item: failedItem || { id: line.id } };
    }

    decremented.push({
      id: line.id, qty: line.qty, sku: row.sku, name: row.name, category: row.category,
      sell_price: Number(row.sell_price) || 0, cost_per_item: Number(row.cost_per_item) || 0,
    });
  }

  const subtotal = decremented.reduce((sum, it) => sum + it.sell_price * it.qty, 0);
  const shipping = UK_SHIPPING_FLAT;
  const total = subtotal + shipping;
  const c = input.customer || {};

  const orderInsert = await env.DB.prepare(
    `INSERT INTO orders (status, customer_name, customer_email, address_line1, address_line2, city, county, postcode, notes, subtotal, shipping, total, paypal_order_id, paypal_capture_id)
     VALUES ('paid', ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)`
  ).bind(
    c.name || "", c.email || "", c.address_line1 || "", c.address_line2 || "",
    c.city || "", c.county || "", c.postcode || "", c.notes || "",
    subtotal, shipping, total, input.paypal_order_id || null, input.paypal_capture_id || null
  ).run();
  const orderId = orderInsert.meta.last_row_id;

  const itemStmts = decremented.map(it =>
    env.DB.prepare(
      `INSERT INTO order_items (order_id, inventory_id, sku, name, category, unit_price, quantity, line_total, unit_cost, line_cost)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)`
    ).bind(orderId, it.id, it.sku, it.name, it.category, it.sell_price, it.qty, it.sell_price * it.qty, it.cost_per_item, it.cost_per_item * it.qty)
  );
  await env.DB.batch(itemStmts);

  return { success: true, orderId, subtotal, shipping, total };
}

// ===== PayPal Orders API v2 =====
// Credentials come from env.PAYPAL_CLIENT_ID / PAYPAL_SECRET / PAYPAL_MODE,
// set with `wrangler secret put` — never hardcoded, never logged. Until
// they're set, paypalConfigured() is false and both endpoints below return
// a clean "payments aren't live yet" response instead of attempting any
// PayPal call.
function paypalConfigured(env) {
  return !!(env.PAYPAL_CLIENT_ID && env.PAYPAL_SECRET);
}

function paypalBaseUrl(env) {
  return env.PAYPAL_MODE === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";
}

async function paypalAccessToken(env) {
  const auth = btoa(env.PAYPAL_CLIENT_ID + ":" + env.PAYPAL_SECRET);
  const res = await fetch(paypalBaseUrl(env) + "/v1/oauth2/token", {
    method: "POST",
    headers: { "Authorization": "Basic " + auth, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) throw new Error("PayPal auth failed");
  const data = await res.json();
  return data.access_token;
}

// Recomputes subtotal/total from LIVE inventory prices for the given cart
// lines — never trusts a client-submitted price. Also rejects up front if
// any line already exceeds current stock, so we don't send a customer to
// PayPal for a cart that's doomed to fail at capture time. This is a
// read-only availability check (no decrement) — the real, race-safe
// guard is confirmOrder()'s guarded UPDATE at capture time.
async function priceCartLines(env, items) {
  const lines = mergeCartLines(items);
  if (!lines.length) return { error: "empty_cart" };
  const priced = [];
  for (const line of lines) {
    const row = await env.DB.prepare(`SELECT id, sku, name, category, sell_price, quantity FROM inventory WHERE id = ?1`).bind(line.id).first();
    if (!row || Number(row.quantity) < line.qty) {
      return { error: "item_unavailable", item: row ? { id: row.id, name: row.name, sku: row.sku } : { id: line.id } };
    }
    priced.push({ id: line.id, qty: line.qty, sku: row.sku, name: row.name, category: row.category, price: Number(row.sell_price) || 0 });
  }
  const subtotal = priced.reduce((sum, it) => sum + it.price * it.qty, 0);
  const shipping = UK_SHIPPING_FLAT;
  return { items: priced, subtotal, shipping, total: subtotal + shipping };
}

async function handlePaypalCreateOrder(request, env) {
  if (!paypalConfigured(env)) {
    return json({ error: "payments_not_live", message: "Online payment isn't switched on yet — please check back soon." }, 503);
  }
  const b = await request.json().catch(() => ({}));
  const c = b.customer || {};
  const missing = ["name", "email", "address_line1", "city", "postcode"].filter(f => !String(c[f] || "").trim());
  if (missing.length) return json({ error: "missing_fields", message: "Missing: " + missing.join(", ") }, 400);

  const priced = await priceCartLines(env, b.items);
  if (priced.error) return json(priced, priced.error === "empty_cart" ? 400 : 409);

  let token;
  try {
    token = await paypalAccessToken(env);
  } catch (e) {
    return json({ error: "paypal_unreachable", message: "Could not start payment — please try again shortly." }, 502);
  }

  const ppRes = await fetch(paypalBaseUrl(env) + "/v2/checkout/orders", {
    method: "POST",
    headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({
      intent: "CAPTURE",
      purchase_units: [{
        amount: {
          currency_code: "GBP",
          value: priced.total.toFixed(2),
          breakdown: {
            item_total: { currency_code: "GBP", value: priced.subtotal.toFixed(2) },
            shipping: { currency_code: "GBP", value: priced.shipping.toFixed(2) },
          },
        },
        items: priced.items.map(it => ({
          name: it.name.slice(0, 127),
          quantity: String(it.qty),
          unit_amount: { currency_code: "GBP", value: it.price.toFixed(2) },
        })),
      }],
    }),
  });
  if (!ppRes.ok) {
    return json({ error: "paypal_create_failed", message: "Could not start payment — please try again." }, 502);
  }
  const ppData = await ppRes.json();

  await env.DB.prepare(
    `INSERT INTO pending_orders (paypal_order_id, customer_json, items_json, subtotal, shipping, total) VALUES (?1,?2,?3,?4,?5,?6)`
  ).bind(
    ppData.id,
    JSON.stringify({ name: c.name, email: c.email, address_line1: c.address_line1, address_line2: c.address_line2 || "", city: c.city, county: c.county || "", postcode: c.postcode, notes: c.notes || "" }),
    JSON.stringify(priced.items.map(it => ({ id: it.id, qty: it.qty }))),
    priced.subtotal, priced.shipping, priced.total
  ).run();

  return json({ orderID: ppData.id });
}

async function handlePaypalCaptureOrder(request, env) {
  if (!paypalConfigured(env)) {
    return json({ error: "payments_not_live", message: "Online payment isn't switched on yet — please check back soon." }, 503);
  }
  const b = await request.json().catch(() => ({}));
  const paypalOrderId = b.orderID;
  if (!paypalOrderId) return json({ error: "orderID required" }, 400);

  const pending = await env.DB.prepare(`SELECT * FROM pending_orders WHERE paypal_order_id = ?1`).bind(paypalOrderId).first();
  if (!pending) return json({ error: "session_expired", message: "This payment session has expired — please start checkout again." }, 404);

  let token;
  try {
    token = await paypalAccessToken(env);
  } catch (e) {
    return json({ error: "paypal_unreachable", message: "Could not confirm payment — please try again shortly." }, 502);
  }

  const capRes = await fetch(paypalBaseUrl(env) + "/v2/checkout/orders/" + encodeURIComponent(paypalOrderId) + "/capture", {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + token,
      "Content-Type": "application/json",
      "PayPal-Request-Id": "capture-" + paypalOrderId, // idempotency: safe if this call is retried
    },
  });
  const capData = await capRes.json().catch(() => ({}));
  const capture = capData.purchase_units && capData.purchase_units[0] && capData.purchase_units[0].payments && capData.purchase_units[0].payments.captures && capData.purchase_units[0].payments.captures[0];

  if (!capRes.ok || !capture || capture.status !== "COMPLETED") {
    return json({ error: "payment_not_completed", message: "Your payment didn't go through — please try again." }, 402);
  }

  const capturedAmount = Number(capture.amount && capture.amount.value);
  if (Math.abs(capturedAmount - pending.total) > 0.01) {
    // Should never happen — the amount was fixed at create-order time. If it
    // does, don't touch stock or create an order; this needs a human to look at it.
    return json({ error: "amount_mismatch", message: "Something went wrong confirming your payment — please contact us and we'll sort it out." }, 500);
  }

  const result = await confirmOrder(env, {
    customer: JSON.parse(pending.customer_json),
    items: JSON.parse(pending.items_json),
    paypal_order_id: paypalOrderId,
    paypal_capture_id: capture.id,
  });

  if (!result.success) {
    // Payment already captured but we can't fulfil it — refund what we took.
    let refunded = false;
    try {
      const refundRes = await fetch(paypalBaseUrl(env) + "/v2/payments/captures/" + encodeURIComponent(capture.id) + "/refund", {
        method: "POST",
        headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json" },
      });
      refunded = refundRes.ok;
    } catch (e) { /* best-effort — pending row is kept below either way for staff follow-up */ }

    return json({
      success: false,
      error: result.error,
      item: result.item,
      refunded,
      message: (result.item ? ('"' + result.item.name + '" just sold out. ') : 'That item just sold out. ') +
        (refunded ? "You have not been charged." : "Your payment has been captured — please contact us and we'll refund you right away."),
    }, 409);
  }

  await env.DB.prepare(`DELETE FROM pending_orders WHERE paypal_order_id = ?1`).bind(paypalOrderId).run();
  return json({ success: true, orderId: result.orderId, total: result.total });
}

async function handleOrders(request, env, url) {
  if (request.method === "GET") {
    const id = url.searchParams.get("id");
    if (id) {
      const order = await env.DB.prepare(`SELECT * FROM orders WHERE id = ?1`).bind(id).first();
      if (!order) return json({ error: "Order not found" }, 404);
      const { results: items } = await env.DB.prepare(`SELECT * FROM order_items WHERE order_id = ?1 ORDER BY id ASC`).bind(id).all();
      return json({ order, items });
    }
    const status = url.searchParams.get("status") || "";
    let sql = `SELECT o.*, (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id) as item_count FROM orders o`;
    const binds = [];
    if (status) { sql += ` WHERE o.status = ?1`; binds.push(status); }
    sql += ` ORDER BY o.created_at DESC`;
    const { results } = await env.DB.prepare(sql).bind(...binds).all();
    return json(results);
  }

  if (request.method === "PATCH") {
    const id = url.searchParams.get("id");
    if (!id) return json({ error: "id required" }, 400);
    const b = await request.json();
    if (!b.status || !ORDER_STATUSES.includes(b.status)) {
      return json({ error: "status must be one of: " + ORDER_STATUSES.join(", ") }, 400);
    }
    await env.DB.prepare(`UPDATE orders SET status = ?1, updated_at = CURRENT_TIMESTAMP WHERE id = ?2`).bind(b.status, id).run();
    return json({ success: true });
  }

  return json({ error: "Method not allowed" }, 405);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Login endpoint is always public
    if (path === "/api/login" && request.method === "POST") {
      return handleLogin(request, env);
    }

    // Checkout/payment endpoints are customer-facing — no staff session exists at checkout
    if (path === "/api/paypal/create-order" && request.method === "POST") {
      return handlePaypalCreateOrder(request, env);
    }
    if (path === "/api/paypal/capture-order" && request.method === "POST") {
      return handlePaypalCaptureOrder(request, env);
    }

    // Uploaded images are served publicly straight from R2
    if (path.startsWith("/images/") && request.method === "GET") {
      const key = path.slice("/images/".length);
      const obj = await env.IMAGES.get(key);
      if (!obj) return new Response("Not found", { status: 404 });
      const headers = new Headers();
      obj.writeHttpMetadata(headers);
      headers.set("etag", obj.httpEtag);
      headers.set("Cache-Control", "public, max-age=31536000, immutable");
      return new Response(obj.body, { headers });
    }

    // Protect all other /api/* routes
    if (path.startsWith("/api/")) {
      if (!(await isAuthed(request, env))) {
        return json({ error: "Unauthorized" }, 401);
      }
      if (path === "/api/inv-search") return handleInvSearch(request, env, url);
      if (path === "/api/inv-report") return handleInvReport(request, env, url);
      if (path === "/api/inv-lowstock") return handleInvLowStock(request, env, url);
      if (path === "/api/inv-items") return handleInvItems(request, env, url);
      if (path === "/api/orders") return handleOrders(request, env, url);
      if (path === "/api/expense-entries") return handleExpenseEntries(request, env, url);
      if (path === "/api/accounting-report") return handleAccountingReport(request, env, url);
      if (path === "/api/shop-products") return handleShopProducts(request, env, url);
      if (path === "/api/shop-unpublish") return handleShopUnpublish(request, env);
      if (path === "/api/shop-config") return handleShopConfig(request, env);
      if (path === "/api/shop-reorder") return handleShopReorder(request, env);
      if (path === "/api/upload-image") return handleImageUpload(request, env);
      if (path === "/api/home-content") return handleHomeContent(request, env);
      if (path === "/api/story-content") return handleStoryContent(request, env);
      if (path === "/api/contact-content") return handleContactContent(request, env);
      if (path === "/api/care-content") return handleCareContent(request, env);
      if (path === "/api/social-links") return handleSocialLinks(request, env);
      if (path === "/api/delivery-settings") return handleDeliverySettings(request, env);
      return json({ error: "Not found" }, 404);
    }

    // Protect staff pages (except the login page itself)
    if (path.startsWith("/staff/") && path !== "/staff/login.html" && path !== "/staff/login") {
      if (!(await isAuthed(request, env))) {
        return Response.redirect(new URL("/staff/login.html", url.origin), 302);
      }
          }


    // Homepage is server-rendered from the database
    if ((path === "/" || path === "/index.html") && request.method === "GET") {
      try {
        return await renderHomePage(request, env);
      } catch (e) {
        return env.ASSETS.fetch(request);
      }
    }
    // Story page is server-rendered from the database
    if (path === "/story.html" && request.method === "GET") {
      try {
        return await renderStoryPage(request, env);
      } catch (e) {
        return env.ASSETS.fetch(request);
      }
    }

    // Contact page is server-rendered from the database
    if (path === "/contact.html" && request.method === "GET") {
      try {
        return await renderContactPage(request, env);
      } catch (e) {
        return env.ASSETS.fetch(request);
      }
    }
    // Care page is server-rendered from the database
    if (path === "/care.html" && request.method === "GET") {
      try {
        return await renderCarePage(request, env);
      } catch (e) {
        return env.ASSETS.fetch(request);
      }
    }
    // Shop page is server-rendered from the database
    if (path === "/shop.html" && request.method === "GET") {
      try {
        return await renderShopPage(request, env);
      } catch (e) {
        return json({ error: "Shop is temporarily unavailable" }, 500);
      }
    }

    // Checkout page is server-rendered to inject the PayPal client id
    if (path === "/checkout.html" && request.method === "GET") {
      try {
        return await renderCheckoutPage(request, env);
      } catch (e) {
        return env.ASSETS.fetch(request);
      }
    }

    // Everything else: serve the static file as-is
    return env.ASSETS.fetch(request);
  },
};
