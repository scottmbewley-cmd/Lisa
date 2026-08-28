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

async function handleSales(request, env) {
  if (request.method === "GET") {
    const { results } = await env.DB.prepare(`SELECT * FROM sales ORDER BY sale_date DESC, created_at DESC`).all();
    return json(results);
  }
  if (request.method === "POST") {
    const b = await request.json();
    await env.DB.prepare(
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
    return json({ success: true });
  }
  return json({ error: "Method not allowed" }, 405);
}

async function handleExpenditure(request, env) {
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
        `INSERT INTO inventory (sku, name, category, material, stone_detail, durability, quantity, cost_per_item, sell_price, reorder_at, supplier)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)`
      ).bind(
        sku, b.stock_name, b.stock_category || "", b.stock_material || "",
        b.stock_stone || "", b.stock_durability || "", b.stock_quantity || 0,
        b.amount && b.stock_quantity ? (b.amount / b.stock_quantity) : 0,
        b.stock_sell_price || 0, b.stock_reorder_at || 0, b.stock_supplier || ""
      ).run();
      linkedId = insertRes.meta.last_row_id;
    }

    await env.DB.prepare(
      `INSERT INTO expenditure (exp_date, category, paid_from, amount, notes, linked_inventory_id)
       VALUES (?1,?2,?3,?4,?5,?6)`
    ).bind(
      b.exp_date || new Date().toISOString().slice(0, 10),
      b.category || "", b.paid_from || "", b.amount || 0, b.notes || "", linkedId
    ).run();

    return json({ success: true, linkedInventoryId: linkedId });
  }
  return json({ error: "Method not allowed" }, 405);
}

async function handleSuppliers(request, env) {
  if (request.method === "GET") {
    const { results } = await env.DB.prepare(`SELECT * FROM suppliers ORDER BY date_ordered DESC`).all();
    return json(results);
  }
  if (request.method === "POST") {
    const b = await request.json();
    await env.DB.prepare(
      `INSERT INTO suppliers (name, date_ordered, lead_time_days) VALUES (?1,?2,?3)`
    ).bind(b.name || "", b.date_ordered || new Date().toISOString().slice(0, 10), b.lead_time_days || 0).run();
    return json({ success: true });
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

    // Protect all other /api/* routes
    if (path.startsWith("/api/")) {
      if (!(await isAuthed(request, env))) {
        return json({ error: "Unauthorized" }, 401);
      }
      if (path === "/api/inventory") return handleInventory(request, env, url);
      if (path === "/api/sales") return handleSales(request, env);
      if (path === "/api/expenditure") return handleExpenditure(request, env);
      if (path === "/api/suppliers") return handleSuppliers(request, env);
      if (path === "/api/notes") return handleNotes(request, env);
      return json({ error: "Not found" }, 404);
    }

    // Protect staff pages (except the login page itself)
    if (path.startsWith("/staff/") && path !== "/staff/login.html") {
      if (!(await isAuthed(request, env))) {
        return Response.redirect(new URL("/staff/login.html", url.origin), 302);
      }
    }

    // Everything else: serve the static file as-is
    return env.ASSETS.fetch(request);
  },
};
