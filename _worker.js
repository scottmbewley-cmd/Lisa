// Exquisitely You — single-file Worker
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
  const match = cookie.match(/ey_staff_session=([^;]+)/);
  if (!match) return false;
  const expected = await hashValue(env.STAFF_PASSWORD || "changeme-EY2026");
  return match[1] === expected;
}

async function handleLogin(request, env) {
  const body = await request.json().catch(() => ({}));
  const correct = env.STAFF_PASSWORD || "changeme-EY2026";
  if ((body.password || "") !== correct) {
    return json({ success: false, error: "Incorrect password" }, 401);
  }
  const sessionValue = await hashValue(correct);
  const headers = new Headers({ "Content-Type": "application/json" });
  headers.append("Set-Cookie", `ey_staff_session=${sessionValue}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`);
  return new Response(JSON.stringify({ success: true }), { status: 200, headers });
}

async function nextSku(env) {
  const { results } = await env.DB.prepare(`SELECT sku FROM inventory WHERE sku LIKE 'EY-%'`).all();
  const nums = results.map(r => (r.sku.match(/^EY-(\d+)$/) || [])[1]).filter(Boolean).map(Number);
  const next = nums.length ? Math.max(...nums) + 1 : 1;
  return "EY-" + String(next).padStart(4, "0");
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
  const raw = (results[0] && results[0].active_libraries) || "A,B";
  return raw.split(",").map(s => s.trim()).filter(Boolean);
}

async function renderShopPage(request, env) {
  const libs = await getActiveLibraries(env);
  const placeholders = libs.map((_, i) => `?${i + 1}`).join(",");
  const { results } = libs.length
    ? await env.DB.prepare(`SELECT * FROM shop_products WHERE library IN (${placeholders}) ORDER BY position ASC, created_at ASC`).bind(...libs).all()
    : { results: [] };

  const cardsHtml = results.length
    ? results.map(p => `
      <div class="product-card">
        <div class="product-image"><img src="${escapeHtml(p.image_url)}" alt="${escapeHtml(p.name)}" /></div>
        <div class="product-info">
          <span class="eyebrow" style="font-size:0.85rem;">${escapeHtml(p.category)}</span>
          <h3>${escapeHtml(p.name)}</h3>
          <p class="product-price">${escapeHtml(p.price)}</p>
        </div>
      </div>`).join("")
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
    const { results } = await env.DB.prepare(`SELECT * FROM shop_products WHERE id IN (${placeholders})`).bind(...ids).all();
    products = ids.map(id => results.find(r => r.id === id)).filter(Boolean);
  }

  const cardsHtml = products.length
    ? products.map(p => `
      <div class="product-card">
        <div class="product-image"><img src="${escapeHtml(p.image_url)}" alt="${escapeHtml(p.name)}" /></div>
        <div class="product-info">
          <h3>${escapeHtml(p.name)}</h3>
          <p class="product-price">${escapeHtml(p.price)}</p>
        </div>
      </div>`).join("")
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
async function handleShopProducts(request, env, url) {
  if (request.method === "GET") {
    const { results } = await env.DB.prepare(`SELECT * FROM shop_products ORDER BY library, created_at DESC`).all();
    return json(results);
  }
  if (request.method === "POST") {
    const b = await request.json();
    if (!b.name || !b.price || !b.library) return json({ error: "name, price, and library are required" }, 400);
    const countRow = await env.DB.prepare(`SELECT COUNT(*) as n, COALESCE(MAX(position),-1) as maxPos FROM shop_products WHERE library = ?1`).bind(b.library).first();
    if (countRow.n >= 20) return json({ error: "Library " + b.library + " is full (20/20). Remove a piece before adding another." }, 400);
    const nextPos = countRow.maxPos + 1;
    const insertRes = await env.DB.prepare(
      `INSERT INTO shop_products (name, price, category, image_url, library, position) VALUES (?1,?2,?3,?4,?5,?6)`
    ).bind(b.name, b.price, b.category || "", b.image_url || "", b.library, nextPos).run();
    return json({ success: true, id: insertRes.meta.last_row_id });
  }
  if (request.method === "PATCH") {
    const id = url.searchParams.get("id");
    if (!id) return json({ error: "id required" }, 400);
    const b = await request.json();
    const fields = ["name", "price", "category", "image_url", "library"];
    const sets = []; const vals = [];
    fields.forEach(f => { if (b[f] !== undefined) { sets.push(`${f} = ?`); vals.push(b[f]); } });
    if (!sets.length) return json({ error: "no fields to update" }, 400);
    vals.push(id);
    await env.DB.prepare(`UPDATE shop_products SET ${sets.join(", ")} WHERE id = ?`).bind(...vals).run();
    return json({ success: true });
  }
  if (request.method === "DELETE") {
    const id = url.searchParams.get("id");
    if (!id) return json({ error: "id required" }, 400);
    await env.DB.prepare(`DELETE FROM shop_products WHERE id = ?`).bind(id).run();
    return json({ success: true });
  }
  return json({ error: "Method not allowed" }, 405);
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
  if (!b.library || !["A","B","C"].includes(b.library) || !Array.isArray(b.order)) {
    return json({ error: "library and order[] (product ids) are required" }, 400);
  }
  const stmts = b.order.map((id, idx) =>
    env.DB.prepare(`UPDATE shop_products SET position = ?1 WHERE id = ?2 AND library = ?3`).bind(idx, id, b.library)
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
    const valid = libs.filter(l => ["A", "B", "C"].includes(l));
    if (valid.length !== 2) return json({ error: "Exactly two libraries must be active" }, 400);
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
      if (path === "/api/inventory") return handleInventory(request, env, url);
      if (path === "/api/sales") return handleSales(request, env, url);
      if (path === "/api/expenditure") return handleExpenditure(request, env, url);
      if (path === "/api/suppliers") return handleSuppliers(request, env, url);
      if (path === "/api/notes") return handleNotes(request, env);
      if (path === "/api/shop-products") return handleShopProducts(request, env, url);
      if (path === "/api/shop-config") return handleShopConfig(request, env);
      if (path === "/api/shop-reorder") return handleShopReorder(request, env);
      if (path === "/api/upload-image") return handleImageUpload(request, env);
      if (path === "/api/home-content") return handleHomeContent(request, env);
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
