// Evelle — single-file Worker
// Handles /api/* routes and staff-area auth gating, serves everything else
// as static assets via the ASSETS binding.

// Kill-switch: Business Hub is temporarily taken offline while a replacement
// is built. Flip to false and redeploy to restore access.
const HUB_DISABLED = true;
const HUB_API_ROUTES = new Set(["/api/inventory", "/api/sales", "/api/expenditure", "/api/suppliers", "/api/notes"]);

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

async function handleInventory(request, env, url) {
  if (request.method === "GET") {
    const q = url.searchParams.get("q");
    let stmt;
    if (q) {
      const like = `%${q}%`;
      stmt = env.DB.prepare(
        `SELECT * FROM inventory WHERE name LIKE ?1 OR sku LIKE ?1 OR material LIKE ?1 OR supplier LIKE ?1 ORDER BY created_at DESC`
      ).bind(like);
    } else {
      stmt = env.DB.prepare(`SELECT * FROM inventory ORDER BY created_at DESC`);
    }
    const { results } = await stmt.all();
    return json(results);
  }

  if (request.method === "POST") {
    const b = await request.json();
    const sku = b.sku || await nextSku(env);
    await env.DB.prepare(
      `INSERT INTO inventory (sku, name, category, material, stone_detail, durability, quantity, cost_per_item, sell_price, reorder_at, supplier, photo_url, notes)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)`
    ).bind(
      sku, b.name || "", b.category || "", b.material || "", b.stone_detail || "",
      b.durability || "", b.quantity || 0, b.cost_per_item || 0, b.sell_price || 0,
      b.reorder_at || 0, b.supplier || "", b.photo_url || "", b.notes || ""
    ).run();
    return json({ success: true, sku });
  }

  if (request.method === "PATCH") {
    const id = url.searchParams.get("id");
    if (!id) return json({ error: "id required" }, 400);
    const b = await request.json();
    const fields = ["name","category","material","stone_detail","durability","quantity","cost_per_item","sell_price","reorder_at","supplier","photo_url","notes"];
    const sets = []; const vals = [];
    fields.forEach(f => { if (b[f] !== undefined) { sets.push(`${f} = ?`); vals.push(b[f]); } });
    if (!sets.length) return json({ error: "no fields to update" }, 400);
    sets.push(`updated_at = CURRENT_TIMESTAMP`);
    vals.push(id);
    await env.DB.prepare(`UPDATE inventory SET ${sets.join(", ")} WHERE id = ?`).bind(...vals).run();
    return json({ success: true });
  }

  if (request.method === "DELETE") {
    const id = url.searchParams.get("id");
    if (!id) return json({ error: "id required" }, 400);
    await env.DB.prepare(`DELETE FROM inventory WHERE id = ?`).bind(id).run();
    return json({ success: true });
  }

  return json({ error: "Method not allowed" }, 405);
}

async function handleInvReport(request, env, url) {
  if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
  const allCats = ["Ring","Bracelet","Necklace","Earring","Anklet","Other"];
  const raw = (url.searchParams.get("categories") || "").split(",").map(s => s.trim()).filter(Boolean);
  const cats = raw.length ? raw.filter(c => allCats.includes(c)) : allCats;
  if (!cats.length) return json({ summary: [], items: [] });
  const placeholders = cats.map((_, i) => `?${i + 1}`).join(",");
  const { results: summaryRows } = await env.DB.prepare(
    `SELECT category,
            COUNT(*) as items,
            COALESCE(SUM(quantity),0) as total_qty,
            COALESCE(SUM(quantity * sell_price),0) as total_value,
            SUM(CASE WHEN quantity <= COALESCE(reorder_at,2) THEN 1 ELSE 0 END) as low_count
     FROM inventory WHERE category IN (${placeholders}) GROUP BY category`
  ).bind(...cats).all();
  const byCategory = {};
  summaryRows.forEach(r => { byCategory[r.category] = r; });
  const summary = cats.map(c => byCategory[c] || { category: c, items: 0, total_qty: 0, total_value: 0, low_count: 0 });

  const { results: items } = await env.DB.prepare(
    `SELECT id, sku, name, category, quantity, sell_price, reorder_at FROM inventory WHERE category IN (${placeholders}) ORDER BY category ASC, name ASC`
  ).bind(...cats).all();

  return json({ summary, items });
}

async function handleInvSearch(request, env, url) {
  if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
  const category = url.searchParams.get("category") || "";
  const q = url.searchParams.get("q") || "";
  if (!category && !q) return json([]);
  let stmt;
  if (category && q) {
    const like = `%${q}%`;
    stmt = env.DB.prepare(
      `SELECT * FROM inventory WHERE category = ?1 AND (name LIKE ?2 OR sku LIKE ?2 OR supplier LIKE ?2 OR supplier_code LIKE ?2) ORDER BY name ASC`
    ).bind(category, like);
  } else if (category) {
    stmt = env.DB.prepare(`SELECT * FROM inventory WHERE category = ?1 ORDER BY name ASC`).bind(category);
  } else {
    const like = `%${q}%`;
    stmt = env.DB.prepare(
      `SELECT * FROM inventory WHERE name LIKE ?1 OR sku LIKE ?1 OR supplier LIKE ?1 OR supplier_code LIKE ?1 ORDER BY name ASC`
    ).bind(like);
  }
  const { results } = await stmt.all();
  return json(results);
}

async function handleInvLowStock(request, env, url) {
  if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
  const category = url.searchParams.get("category") || "";
  let sql = `SELECT * FROM inventory WHERE shop_position IS NOT NULL AND quantity <= COALESCE(reorder_at, 2)`;
  const binds = [];
  if (category) { sql += ` AND category = ?1`; binds.push(category); }
  sql += ` ORDER BY category ASC, quantity ASC`;
  const { results } = await env.DB.prepare(sql).bind(...binds).all();
  return json(results);
}

async function handleInvItems(request, env, url) {
  if (request.method === "POST") {
    const b = await request.json();
    const missing = [];
    if (!b.category) missing.push("category");
    if (!b.name) missing.push("name");
    if (!b.description) missing.push("description");
    if (!b.photo_url) missing.push("photo");
    if (!b.sell_price) missing.push("sell price");
    if (missing.length) return json({ error: "Missing: " + missing.join(", ") + ". All of these are needed before it can go live in the shop." }, 400);

    const caps = { Ring: 50, Bracelet: 50, Necklace: 50, Earring: 50, Anklet: 50, Other: 10 };
    const cap = caps[b.category];
    if (!cap) return json({ error: "Unknown category" }, 400);
    const countRow = await env.DB.prepare(`SELECT COUNT(*) as n, COALESCE(MAX(shop_position),-1) as maxPos FROM inventory WHERE category = ?1 AND shop_position IS NOT NULL`).bind(b.category).first();
    if (countRow.n >= cap) return json({ error: b.category + " Library is full (" + cap + "/" + cap + "). Remove a piece from Shop Library before adding another." }, 400);

    const sku = await nextSku(env);
    const nextPos = countRow.maxPos + 1;
    await env.DB.prepare(
      `INSERT INTO inventory (sku, name, category, quantity, cost_per_item, sell_price, reorder_at, supplier, supplier_code, photo_url, notes, shop_position)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)`
    ).bind(
      sku, b.name, b.category, b.quantity || 0, b.cost_per_item || 0, b.sell_price || 0,
      b.reorder_at || 2, b.supplier || "", b.supplier_code || "", b.photo_url || "", b.description || "", nextPos
    ).run();
    return json({ success: true, sku });
  }
  if (request.method === "PATCH") {
    const id = url.searchParams.get("id");
    if (!id) return json({ error: "id required" }, 400);
    const b = await request.json();
    const fieldMap = { name: "name", category: "category", quantity: "quantity", cost_per_item: "cost_per_item", sell_price: "sell_price", reorder_at: "reorder_at", supplier: "supplier", supplier_code: "supplier_code", photo_url: "photo_url", description: "notes" };
    const sets = []; const vals = [];
    Object.keys(fieldMap).forEach(f => { if (b[f] !== undefined) { sets.push(`${fieldMap[f]} = ?`); vals.push(b[f]); } });
    if (!sets.length) return json({ error: "no fields to update" }, 400);
    sets.push(`updated_at = CURRENT_TIMESTAMP`);
    vals.push(id);
    await env.DB.prepare(`UPDATE inventory SET ${sets.join(", ")} WHERE id = ?`).bind(...vals).run();
    return json({ success: true });
  }
  if (request.method === "DELETE") {
    const id = url.searchParams.get("id");
    if (!id) return json({ error: "id required" }, 400);
    await env.DB.prepare(`DELETE FROM inventory WHERE id = ?`).bind(id).run();
    return json({ success: true });
  }
  return json({ error: "Method not allowed" }, 405);
}

async function handleSales(request, env, url) {
  if (request.method === "GET") {
    const { results } = await env.DB.prepare(`SELECT * FROM sales ORDER BY sale_date DESC, created_at DESC`).all();
    return json(results);
  }
  if (request.method === "POST") {
    const b = await request.json();
    const insertRes = await env.DB.prepare(
      `INSERT INTO sales (sale_date, item_sku, item_name, category, quantity, sale_price, platform, received_via)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8)`
    ).bind(
      b.sale_date || new Date().toISOString().slice(0, 10),
      b.item_sku || null, b.item_name || "", b.category || "",
      b.quantity || 1, b.sale_price || 0, b.platform || "", b.received_via || ""
    ).run();
    if (b.item_sku) {
      await env.DB.prepare(
        `UPDATE inventory SET quantity = MAX(0, quantity - ?1), updated_at = CURRENT_TIMESTAMP WHERE sku = ?2`
      ).bind(b.quantity || 1, b.item_sku).run();
    }
    return json({ success: true, id: insertRes.meta.last_row_id });
  }
  if (request.method === "PATCH") {
    const id = url.searchParams.get("id");
    if (!id) return json({ error: "id required" }, 400);
    const b = await request.json();
    const fields = ["sale_date","item_sku","item_name","category","quantity","sale_price","platform","received_via"];
    const sets = []; const vals = [];
    fields.forEach(f => { if (b[f] !== undefined) { sets.push(`${f} = ?`); vals.push(b[f]); } });
    if (!sets.length) return json({ error: "no fields to update" }, 400);
    vals.push(id);
    await env.DB.prepare(`UPDATE sales SET ${sets.join(", ")} WHERE id = ?`).bind(...vals).run();
    return json({ success: true });
  }
  if (request.method === "DELETE") {
    const id = url.searchParams.get("id");
    if (!id) return json({ error: "id required" }, 400);
    await env.DB.prepare(`DELETE FROM sales WHERE id = ?`).bind(id).run();
    return json({ success: true });
  }
  return json({ error: "Method not allowed" }, 405);
}

async function handleExpenditure(request, env, url) {
  if (request.method === "GET") {
    const { results } = await env.DB.prepare(`SELECT * FROM expenditure ORDER BY exp_date DESC, created_at DESC`).all();
    return json(results);
  }
  if (request.method === "POST") {
    const b = await request.json();
    let linkedId = null;

    if (b.category === "Stock / Inventory" && b.stock_name) {
      const sku = await nextSku(env);
      const insertRes = await env.DB.prepare(
        `INSERT INTO inventory (sku, name, category, material, stone_detail, durability, quantity, cost_per_item, sell_price, reorder_at, supplier, photo_url)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)`
      ).bind(
        sku, b.stock_name, b.stock_category || "", b.stock_material || "",
        b.stock_stone || "", b.stock_durability || "", b.stock_quantity || 0,
        b.amount && b.stock_quantity ? (b.amount / b.stock_quantity) : 0,
        b.stock_sell_price || 0, b.stock_reorder_at || 0, b.stock_supplier || "", b.stock_photo || ""
      ).run();
      linkedId = insertRes.meta.last_row_id;
    }

    const expInsert = await env.DB.prepare(
      `INSERT INTO expenditure (exp_date, category, paid_from, amount, notes, linked_inventory_id)
       VALUES (?1,?2,?3,?4,?5,?6)`
    ).bind(
      b.exp_date || new Date().toISOString().slice(0, 10),
      b.category || "", b.paid_from || "", b.amount || 0, b.notes || "", linkedId
    ).run();

    return json({ success: true, id: expInsert.meta.last_row_id, linkedInventoryId: linkedId });
  }
  if (request.method === "PATCH") {
    const id = url.searchParams.get("id");
    if (!id) return json({ error: "id required" }, 400);
    const b = await request.json();
    const fields = ["exp_date","category","paid_from","amount","notes"];
    const sets = []; const vals = [];
    fields.forEach(f => { if (b[f] !== undefined) { sets.push(`${f} = ?`); vals.push(b[f]); } });
    if (!sets.length) return json({ error: "no fields to update" }, 400);
    vals.push(id);
    await env.DB.prepare(`UPDATE expenditure SET ${sets.join(", ")} WHERE id = ?`).bind(...vals).run();
    return json({ success: true });
  }
  if (request.method === "DELETE") {
    const id = url.searchParams.get("id");
    if (!id) return json({ error: "id required" }, 400);
    await env.DB.prepare(`DELETE FROM expenditure WHERE id = ?`).bind(id).run();
    return json({ success: true });
  }
  return json({ error: "Method not allowed" }, 405);
}

async function handleSuppliers(request, env, url) {
  if (request.method === "GET") {
    const { results } = await env.DB.prepare(`SELECT * FROM suppliers ORDER BY date_ordered DESC`).all();
    return json(results);
  }
  if (request.method === "POST") {
    const b = await request.json();
    const insertRes = await env.DB.prepare(
      `INSERT INTO suppliers (name, date_ordered, lead_time_days, status) VALUES (?1,?2,?3,?4)`
    ).bind(b.name || "", b.date_ordered || new Date().toISOString().slice(0, 10), b.lead_time_days || 0, b.status || "Ordered").run();
    return json({ success: true, id: insertRes.meta.last_row_id });
  }
  if (request.method === "PATCH") {
    const id = url.searchParams.get("id");
    if (!id) return json({ error: "id required" }, 400);
    const b = await request.json();
    const fields = ["name","date_ordered","lead_time_days","status"];
    const sets = []; const vals = [];
    fields.forEach(f => { if (b[f] !== undefined) { sets.push(`${f} = ?`); vals.push(b[f]); } });
    if (!sets.length) return json({ error: "no fields to update" }, 400);
    vals.push(id);
    await env.DB.prepare(`UPDATE suppliers SET ${sets.join(", ")} WHERE id = ?`).bind(...vals).run();
    return json({ success: true });
  }
  if (request.method === "DELETE") {
    const id = url.searchParams.get("id");
    if (!id) return json({ error: "id required" }, 400);
    await env.DB.prepare(`DELETE FROM suppliers WHERE id = ?`).bind(id).run();
    return json({ success: true });
  }
  return json({ error: "Method not allowed" }, 405);
}

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
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
        </div>
        <div class="product-desc">${escapeHtml(p.notes)}</div>
      </div>`;
      }).join("")
    : `<p class="muted" style="grid-column:1/-1;">New pieces coming soon — check back shortly.</p>`;

  const template = await (await env.ASSETS.fetch(new Request(new URL("/shop.html", request.url)))).text();
  const html = template.replace("<!--SHOP_PRODUCTS-->", cardsHtml);
  return new Response(html, { headers: { "Content-Type": "text/html;charset=UTF-8" } });
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
    .replace("<!--WHY_BODY-->", escapeHtml(hc.why_body || ""));
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
    .replace("<!--STORY_NOTE-->", noteHtml);
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
    .replace("<!--CONTACT_SUBTITLE-->", escapeHtml(cc.subtitle || ""));
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
    .replace("<!--CARE_NOTE-->", noteHtml);
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

async function handleNotes(request, env) {
  if (request.method === "GET") {
    const { results } = await env.DB.prepare(`SELECT * FROM notes ORDER BY updated_at DESC LIMIT 1`).all();
    return json(results[0] || { content: "" });
  }
  if (request.method === "POST") {
    const b = await request.json();
    const { results } = await env.DB.prepare(`SELECT id FROM notes ORDER BY updated_at DESC LIMIT 1`).all();
    if (results.length) {
      await env.DB.prepare(`UPDATE notes SET content = ?1, updated_at = CURRENT_TIMESTAMP WHERE id = ?2`)
        .bind(b.content || "", results[0].id).run();
    } else {
      await env.DB.prepare(`INSERT INTO notes (content) VALUES (?1)`).bind(b.content || "").run();
    }
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
      if (HUB_DISABLED && HUB_API_ROUTES.has(path)) {
        return json({ error: "Not found" }, 404);
      }
      if (path === "/api/inventory") return handleInventory(request, env, url);
      if (path === "/api/inv-search") return handleInvSearch(request, env, url);
      if (path === "/api/inv-report") return handleInvReport(request, env, url);
      if (path === "/api/inv-lowstock") return handleInvLowStock(request, env, url);
      if (path === "/api/inv-items") return handleInvItems(request, env, url);
      if (path === "/api/sales") return handleSales(request, env, url);
      if (path === "/api/expenditure") return handleExpenditure(request, env, url);
      if (path === "/api/suppliers") return handleSuppliers(request, env, url);
      if (path === "/api/notes") return handleNotes(request, env);
      if (path === "/api/shop-products") return handleShopProducts(request, env, url);
      if (path === "/api/shop-unpublish") return handleShopUnpublish(request, env);
      if (path === "/api/shop-config") return handleShopConfig(request, env);
      if (path === "/api/shop-reorder") return handleShopReorder(request, env);
      if (path === "/api/upload-image") return handleImageUpload(request, env);
      if (path === "/api/home-content") return handleHomeContent(request, env);
      if (path === "/api/story-content") return handleStoryContent(request, env);
      if (path === "/api/contact-content") return handleContactContent(request, env);
      if (path === "/api/care-content") return handleCareContent(request, env);
      return json({ error: "Not found" }, 404);
    }

    // Protect staff pages (except the login page itself)
    if (path.startsWith("/staff/") && path !== "/staff/login.html" && path !== "/staff/login") {
      if (!(await isAuthed(request, env))) {
        return Response.redirect(new URL("/staff/login.html", url.origin), 302);
      }
      if (HUB_DISABLED && (path === "/staff/hub.html" || path === "/staff/hub")) {
        return Response.redirect(new URL("/staff/index.html", url.origin), 302);
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

    // Everything else: serve the static file as-is
    return env.ASSETS.fetch(request);
  },
};
