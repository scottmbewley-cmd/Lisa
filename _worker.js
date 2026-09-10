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

// Ring sizing — ONLY category that gets per-size stock. Every other
// category keeps a single flat quantity/shop_qty on the inventory row, as
// before. For a Ring, inventory.quantity and inventory.shop_qty become a
// MAINTAINED CACHE (the sum across ring_sizes) so every existing read path
// (search, low-stock, reports, shop listing) keeps working unmodified —
// they just read a total that happens to be kept in sync elsewhere. The
// ring_sizes rows are the real source of truth for a ring's stock; nothing
// but the functions below is allowed to write inventory.quantity/shop_qty
// for a Ring, or the cache will drift from reality.
async function getRingSizes(env, inventoryId) {
  const { results } = await env.DB.prepare(
    `SELECT id, size, quantity, shop_qty FROM ring_sizes WHERE inventory_id = ?1 ORDER BY id ASC`
  ).bind(inventoryId).all();
  return results;
}

// Replaces the full size breakdown for a ring with exactly what's given —
// sizes not present in the new list are removed. Existing sizes keep their
// shop_qty untouched (only warehouse quantity comes from this list) unless
// removed entirely, in which case any shop_qty they held is lost — the
// caller (handleInvItems) is responsible for warning if that would strand
// live shop stock.
async function setRingSizes(env, inventoryId, sizes) {
  const clean = (sizes || [])
    .map(s => ({ size: String(s.size || "").trim(), quantity: Math.max(0, Number(s.quantity) || 0) }))
    .filter(s => s.size);
  const existing = await getRingSizes(env, inventoryId);
  const keepNames = clean.map(s => s.size);
  const toRemove = existing.filter(e => !keepNames.includes(e.size));
  const stmts = [];
  for (const r of toRemove) {
    stmts.push(env.DB.prepare(`DELETE FROM ring_sizes WHERE id = ?1`).bind(r.id));
  }
  for (const s of clean) {
    stmts.push(env.DB.prepare(
      `INSERT INTO ring_sizes (inventory_id, size, quantity) VALUES (?1,?2,?3)
       ON CONFLICT(inventory_id, size) DO UPDATE SET quantity = excluded.quantity`
    ).bind(inventoryId, s.size, s.quantity));
  }
  if (stmts.length) await env.DB.batch(stmts);
  await recomputeRingTotals(env, inventoryId);
}

async function recomputeRingTotals(env, inventoryId) {
  const row = await env.DB.prepare(
    `SELECT COALESCE(SUM(quantity),0) as q, COALESCE(SUM(shop_qty),0) as sq FROM ring_sizes WHERE inventory_id = ?1`
  ).bind(inventoryId).first();
  await env.DB.prepare(`UPDATE inventory SET quantity = ?1, shop_qty = ?2 WHERE id = ?3`)
    .bind(row.q, row.sq, inventoryId).run();
  return row;
}

async function handleInvReport(request, env, url) {
  if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
  const allCats = ["Ring","Bracelet","Necklace","Earring","Anklet","Bangle","Watch","Finger Bracelet","Other"];
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
    `SELECT id, sku, name, category, quantity, shop_qty, sell_price, reorder_at FROM inventory WHERE category IN (${placeholders}) ORDER BY category ASC, name ASC`
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
  for (const row of results) {
    if (row.category === "Ring") row.sizes = await getRingSizes(env, row.id);
  }
  return json(results);
}

async function handleInvLowStock(request, env, url) {
  if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
  const category = url.searchParams.get("category") || "";
  let sql = `SELECT * FROM inventory WHERE shop_position IS NOT NULL AND shop_qty <= COALESCE(reorder_at, 2)`;
  const binds = [];
  if (category) { sql += ` AND category = ?1`; binds.push(category); }
  sql += ` ORDER BY category ASC, shop_qty ASC`;
  const { results } = await env.DB.prepare(sql).bind(...binds).all();
  return json(results);
}

// Logs an automatic 'Inventory Stock' expenditure entry when Inventory
// quantity genuinely increases (new item added, or an existing item
// restocked) — real money leaving the business, so Lisa never has to
// re-type a cost she already entered in Inventory. linked_inventory_id is
// what marks this row as auto-generated: manual entries (the accounting
// page's entry form) never set it, and can't pick category
// 'Inventory Stock' either, so the two are always cleanly distinguishable
// in the ledger.
//
// Only called when qtyDelta > 0 (never on a decrease or an unchanged
// quantity) and costPerItem > 0 (a zero-cost item has nothing real to
// log — an amount of £0 would just be noise in the ledger).
async function logStockExpenditure(env, { inventoryId, qtyDelta, costPerItem, name, sku }) {
  const amount = qtyDelta * costPerItem;
  await env.DB.prepare(
    `INSERT INTO expenditure (exp_date, category, paid_from, amount, notes, linked_inventory_id)
     VALUES (?1,?2,?3,?4,?5,?6)`
  ).bind(
    new Date().toISOString().slice(0, 10),
    "Inventory Stock",
    "",
    amount,
    `Auto: ${qtyDelta} × ${name} (${sku}) @ £${costPerItem.toFixed(2)} each`,
    inventoryId
  ).run();
}

const CATEGORY_CAPS = { Ring: 50, Bracelet: 50, Necklace: 50, Earring: 50, Anklet: 50, Bangle: 50, Watch: 50, "Finger Bracelet": 50, Other: 10 };

async function handleInvItems(request, env, url) {
  if (request.method === "GET") {
    const { results } = await env.DB.prepare(
      `SELECT id, sku, name, category, quantity, shop_qty, cost_per_item, sell_price, reorder_at, supplier, supplier_code, photo_url, notes, shop_position
       FROM inventory WHERE shop_position IS NOT NULL ORDER BY category ASC, name ASC`
    ).all();
    // Rings carry their per-size breakdown alongside the aggregate totals
    // above — the aggregate stays authoritative for every existing view
    // (low stock, search, reports); sizes[] is additive, for the Ring-aware
    // UI only.
    for (const row of results) {
      if (row.category === "Ring") row.sizes = await getRingSizes(env, row.id);
    }
    return json(results);
  }
  if (request.method === "POST") {
    const b = await request.json();
    const missing = [];
    if (!b.category) missing.push("category");
    if (!b.name) missing.push("name");
    if (!b.supplier) missing.push("supplier");
    if (!b.cost_per_item) missing.push("cost per item");
    if (missing.length) return json({ error: "Missing: " + missing.join(", ") + ". These are needed to log the item into the Warehouse." }, 400);
    if (!CATEGORY_CAPS[b.category]) return json({ error: "Unknown category" }, 400);

    const isRing = b.category === "Ring";
    // For a Ring, quantity is derived entirely from the sizes[] breakdown —
    // a flat b.quantity is ignored so the two can never disagree.
    const quantity = isRing
      ? (Array.isArray(b.sizes) ? b.sizes.reduce((sum, s) => sum + (Math.max(0, Number(s.quantity) || 0)), 0) : 0)
      : (Number(b.quantity) || 0);
    const costPerItem = Number(b.cost_per_item) || 0;
    const sku = await nextSku(env);
    const insertRes = await env.DB.prepare(
      `INSERT INTO inventory (sku, name, category, quantity, shop_qty, cost_per_item, sell_price, reorder_at, supplier, supplier_code, photo_url, notes, shop_position)
       VALUES (?1,?2,?3,?4,0,?5,?6,?7,?8,?9,?10,?11,NULL)`
    ).bind(
      sku, b.name, b.category, quantity, costPerItem, b.sell_price || 0,
      b.reorder_at || 2, b.supplier || "", b.supplier_code || "", b.photo_url || "", b.description || ""
    ).run();
    const newId = insertRes.meta.last_row_id;

    if (isRing && Array.isArray(b.sizes) && b.sizes.length) {
      await setRingSizes(env, newId, b.sizes);
    }

    // A new item's starting quantity is an increase from 0 — real stock cost,
    // incurred at Warehouse intake (this is when the cash actually left).
    if (quantity > 0 && costPerItem > 0) {
      await logStockExpenditure(env, { inventoryId: newId, qtyDelta: quantity, costPerItem, name: b.name, sku });
    }

    return json({ success: true, sku });
  }
  if (request.method === "PATCH") {
    const id = url.searchParams.get("id");
    if (!id) return json({ error: "id required" }, 400);
    const b = await request.json();

    // Read the current row FIRST (whenever quantity is part of this edit) so
    // the increase is measured against what's actually in the database right
    // now, not anything the client claims — a plain re-save with an
    // unchanged quantity, or a decrease, must never log a stock expenditure.
    // For a Ring, b.sizes[] replaces b.quantity as the trigger — the current
    // total is read the same way either way, from the aggregate column.
    let current = null;
    if (b.quantity !== undefined || b.sizes !== undefined) {
      current = await env.DB.prepare(`SELECT quantity, cost_per_item, name, sku, category FROM inventory WHERE id = ?1`).bind(id).first();
    }

    let newQuantity;
    if (current && current.category === "Ring" && Array.isArray(b.sizes)) {
      await setRingSizes(env, id, b.sizes);
      const totals = await env.DB.prepare(`SELECT quantity FROM inventory WHERE id = ?1`).bind(id).first();
      newQuantity = totals.quantity;
    }

    const fieldMap = { name: "name", category: "category", cost_per_item: "cost_per_item", sell_price: "sell_price", reorder_at: "reorder_at", supplier: "supplier", supplier_code: "supplier_code", photo_url: "photo_url", description: "notes" };
    // quantity is only settable directly for non-Ring items — a Ring's
    // quantity comes solely from setRingSizes() above.
    if (!(current && current.category === "Ring") && b.quantity !== undefined) fieldMap.quantity = "quantity";
    const sets = []; const vals = [];
    Object.keys(fieldMap).forEach(f => { if (b[f] !== undefined) { sets.push(`${fieldMap[f]} = ?`); vals.push(b[f]); } });
    if (sets.length) {
      sets.push(`updated_at = CURRENT_TIMESTAMP`);
      vals.push(id);
      await env.DB.prepare(`UPDATE inventory SET ${sets.join(", ")} WHERE id = ?`).bind(...vals).run();
    } else if (newQuantity === undefined) {
      return json({ error: "no fields to update" }, 400);
    }

    if (current) {
      const afterQty = newQuantity !== undefined ? newQuantity : (Number(b.quantity) || 0);
      const qtyDelta = afterQty - (Number(current.quantity) || 0);
      // If cost_per_item is being changed in this same edit, that's what was
      // just paid for the added units; otherwise fall back to the cost
      // already on file. A pure cost correction (no quantity field at all)
      // never reaches this block, since `current` is only read above when
      // b.quantity or b.sizes is present.
      const costPerItem = b.cost_per_item !== undefined ? (Number(b.cost_per_item) || 0) : (Number(current.cost_per_item) || 0);
      if (qtyDelta > 0 && costPerItem > 0) {
        await logStockExpenditure(env, {
          inventoryId: id, qtyDelta, costPerItem,
          name: b.name !== undefined ? b.name : current.name,
          sku: current.sku,
        });
      }
    }

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

// Warehouse -> Inventory transfer. Moves units from the Warehouse pool
// (quantity) into the Shop pool (shop_qty) for the same row — same SKU,
// same catalog record, only the location split changes. No cash moves
// here; the expenditure was already logged at Warehouse intake.
//
// On an item's FIRST transfer (shop_position still NULL) this is also the
// point it goes live: shop-ready fields must be present and the category
// slot cap is enforced, exactly as item creation used to enforce it.
async function handleInvTransfer(request, env, url) {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const b = await request.json();
  const id = b.id;
  if (!id) return json({ error: "id required" }, 400);

  const row = await env.DB.prepare(`SELECT id, sku, category, quantity, shop_qty, shop_position, sell_price, photo_url, notes FROM inventory WHERE id = ?1`).bind(id).first();
  if (!row) return json({ error: "Item not found" }, 404);

  const isRing = row.category === "Ring";
  // Rings transfer per size: b.sizes = [{ size, qty }, ...]. Everything
  // else keeps the original flat b.qty. Validate every line BEFORE writing
  // anything, so a transfer with one bad size fails as a whole rather than
  // partially applying.
  let sizeLines = [];
  let qty = 0;
  if (isRing) {
    sizeLines = (Array.isArray(b.sizes) ? b.sizes : []).map(s => ({ size: String(s.size || "").trim(), qty: Number(s.qty) || 0 })).filter(s => s.size && s.qty > 0);
    if (!sizeLines.length) return json({ error: "Pick at least one size and quantity to transfer." }, 400);
    qty = sizeLines.reduce((sum, s) => sum + s.qty, 0);
    const ringSizes = await getRingSizes(env, id);
    for (const line of sizeLines) {
      const match = ringSizes.find(r => r.size === line.size);
      if (!match || Number(match.quantity) < line.qty) {
        return json({ error: `Only ${match ? match.quantity : 0} of size ${line.size} in Warehouse for ${row.sku} — can't transfer ${line.qty}.` }, 400);
      }
    }
  } else {
    qty = Number(b.qty) || 0;
    if (qty <= 0) return json({ error: "qty must be greater than 0" }, 400);
    if (Number(row.quantity) < qty) return json({ error: `Only ${row.quantity} in Warehouse for ${row.sku} — can't transfer ${qty}.` }, 400);
  }

  const firstTransfer = row.shop_position === null;
  let nextPos = null;
  if (firstTransfer) {
    const missing = [];
    if (!row.sell_price) missing.push("sell price");
    if (!row.photo_url) missing.push("photo");
    if (!row.notes) missing.push("description");
    if (missing.length) return json({ error: `Missing: ${missing.join(", ")}. These must be set on the item before it can go live in the shop.` }, 400);

    const cap = CATEGORY_CAPS[row.category];
    if (!cap) return json({ error: "Unknown category" }, 400);
    const countRow = await env.DB.prepare(`SELECT COUNT(*) as n, COALESCE(MAX(shop_position),-1) as maxPos FROM inventory WHERE category = ?1 AND shop_position IS NOT NULL`).bind(row.category).first();
    if (countRow.n >= cap) return json({ error: row.category + " Library is full (" + cap + "/" + cap + "). Remove a piece from Shop Library before adding another." }, 400);
    nextPos = countRow.maxPos + 1;
  }

  if (isRing) {
    const stmts = sizeLines.map(line =>
      env.DB.prepare(`UPDATE ring_sizes SET quantity = quantity - ?1, shop_qty = shop_qty + ?1 WHERE inventory_id = ?2 AND size = ?3`).bind(line.qty, id, line.size)
    );
    await env.DB.batch(stmts);
    await recomputeRingTotals(env, id);
    if (firstTransfer) {
      await env.DB.prepare(`UPDATE inventory SET shop_position = ?1, updated_at = CURRENT_TIMESTAMP WHERE id = ?2`).bind(nextPos, id).run();
    }
  } else if (firstTransfer) {
    await env.DB.prepare(
      `UPDATE inventory SET quantity = quantity - ?1, shop_qty = shop_qty + ?1, shop_position = ?2, updated_at = CURRENT_TIMESTAMP WHERE id = ?3`
    ).bind(qty, nextPos, id).run();
  } else {
    await env.DB.prepare(
      `UPDATE inventory SET quantity = quantity - ?1, shop_qty = shop_qty + ?1, updated_at = CURRENT_TIMESTAMP WHERE id = ?2`
    ).bind(qty, id).run();
  }

  return json({ success: true });
}

// Stream Plans — Lisa's prep tool for Whatnot live shows. Each item on a
// plan is a shortcut into Inventory (inventory_id), never a copy — the
// prompt card always reflects the item's current live name, description,
// price, stock, and photo, straight from the same row Inventory manages.
// Plans are never locked or archived: any plan, old or new, can be
// reopened, edited, and reused for a live stream whenever Lisa wants.
async function handleStreamPlans(request, env, url) {
  if (request.method === "GET") {
    const id = url.searchParams.get("id");
    if (id) {
      const plan = await env.DB.prepare(`SELECT * FROM stream_plans WHERE id = ?1`).bind(id).first();
      if (!plan) return json({ error: "Plan not found" }, 404);
      const { results: items } = await env.DB.prepare(
        `SELECT spi.id, spi.position, spi.complete, spi.hook_note, spi.item_type, spi.inventory_id,
                spi.prompt_label, spi.prompt_text,
                inv.name, inv.category, inv.notes as description, inv.sell_price, inv.shop_qty as quantity, inv.photo_url, inv.sku
         FROM stream_plan_items spi
         LEFT JOIN inventory inv ON inv.id = spi.inventory_id
         WHERE spi.plan_id = ?1 ORDER BY spi.position ASC`
      ).bind(id).all();
      return json({ plan, items });
    }
    const { results: plans } = await env.DB.prepare(
      `SELECT sp.*,
              (SELECT COUNT(*) FROM stream_plan_items spi WHERE spi.plan_id = sp.id) as item_count,
              (SELECT COALESCE(SUM(complete),0) FROM stream_plan_items spi WHERE spi.plan_id = sp.id) as complete_count
       FROM stream_plans sp ORDER BY COALESCE(sp.planned_at, sp.created_at) DESC, sp.id DESC`
    ).all();
    return json(plans);
  }
  if (request.method === "POST") {
    const b = await request.json().catch(() => ({}));
    const insertRes = await env.DB.prepare(
      `INSERT INTO stream_plans (title, planned_at, duration_minutes) VALUES (?1,?2,?3)`
    ).bind(b.title || "", b.planned_at || null, b.duration_minutes ? Number(b.duration_minutes) : null).run();
    return json({ success: true, id: insertRes.meta.last_row_id });
  }
  if (request.method === "PATCH") {
    const id = url.searchParams.get("id");
    if (!id) return json({ error: "id required" }, 400);
    const b = await request.json();
    const fieldMap = { title: "title", planned_at: "planned_at", duration_minutes: "duration_minutes" };
    const sets = []; const vals = [];
    Object.keys(fieldMap).forEach(f => { if (b[f] !== undefined) { sets.push(`${fieldMap[f]} = ?`); vals.push(b[f]); } });
    if (!sets.length) return json({ error: "no fields to update" }, 400);
    sets.push(`updated_at = CURRENT_TIMESTAMP`);
    vals.push(id);
    await env.DB.prepare(`UPDATE stream_plans SET ${sets.join(", ")} WHERE id = ?`).bind(...vals).run();
    return json({ success: true });
  }
  if (request.method === "DELETE") {
    const id = url.searchParams.get("id");
    if (!id) return json({ error: "id required" }, 400);
    await env.DB.prepare(`DELETE FROM stream_plan_items WHERE plan_id = ?1`).bind(id).run();
    await env.DB.prepare(`DELETE FROM stream_plans WHERE id = ?1`).bind(id).run();
    return json({ success: true });
  }
  return json({ error: "Method not allowed" }, 405);
}

async function handleStreamPlanItems(request, env, url) {
  if (request.method === "POST") {
    const b = await request.json();
    if (!b.plan_id) return json({ error: "plan_id required" }, 400);
    const itemType = b.item_type === "prompt" ? "prompt" : "item";
    if (itemType === "item" && !b.inventory_id) return json({ error: "inventory_id required for an item card" }, 400);
    if (itemType === "prompt" && !String(b.prompt_label || "").trim()) return json({ error: "prompt_label required for a prompt card" }, 400);

    const posRow = await env.DB.prepare(`SELECT COALESCE(MAX(position),-1) as maxPos FROM stream_plan_items WHERE plan_id = ?1`).bind(b.plan_id).first();
    const insertRes = await env.DB.prepare(
      `INSERT INTO stream_plan_items (plan_id, item_type, inventory_id, prompt_label, prompt_text, position, complete, hook_note)
       VALUES (?1,?2,?3,?4,?5,?6,0,'')`
    ).bind(
      b.plan_id, itemType,
      itemType === "item" ? b.inventory_id : null,
      itemType === "prompt" ? b.prompt_label.trim() : null,
      itemType === "prompt" ? (b.prompt_text || "") : null,
      posRow.maxPos + 1
    ).run();
    return json({ success: true, id: insertRes.meta.last_row_id });
  }
  if (request.method === "PATCH") {
    const id = url.searchParams.get("id");
    if (!id) return json({ error: "id required" }, 400);
    const b = await request.json();
    const fieldMap = { complete: "complete", hook_note: "hook_note", prompt_label: "prompt_label", prompt_text: "prompt_text" };
    const sets = []; const vals = [];
    Object.keys(fieldMap).forEach(f => { if (b[f] !== undefined) { sets.push(`${fieldMap[f]} = ?`); vals.push(f === "complete" ? (b[f] ? 1 : 0) : b[f]); } });
    if (!sets.length) return json({ error: "no fields to update" }, 400);
    vals.push(id);
    await env.DB.prepare(`UPDATE stream_plan_items SET ${sets.join(", ")} WHERE id = ?`).bind(...vals).run();
    return json({ success: true });
  }
  if (request.method === "DELETE") {
    const id = url.searchParams.get("id");
    if (!id) return json({ error: "id required" }, 400);
    await env.DB.prepare(`DELETE FROM stream_plan_items WHERE id = ?1`).bind(id).run();
    return json({ success: true });
  }
  return json({ error: "Method not allowed" }, 405);
}

// Fresh routes for the Accounting tool — deliberately NOT /api/expenditure,
// which is dead code blocked by HUB_DISABLED and tied to the old disabled
// Business Hub. These reuse the existing `expenditure` table.
//
// "Inventory Stock" and "Postage" are both reserved for automatic logging
// (linked_inventory_id / linked_order_id set respectively, never both) —
// excluded here on purpose so a manual entry can never masquerade as an
// auto-generated one.
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
    const row = await env.DB.prepare(`SELECT linked_inventory_id, linked_order_id FROM expenditure WHERE id = ?1`).bind(id).first();
    if (!row) return json({ error: "Not found" }, 404);
    if (row.linked_inventory_id !== null) {
      return json({ error: "That's an automatic stock entry — delete or correct it from Inventory instead." }, 400);
    }
    if (row.linked_order_id !== null) {
      return json({ error: "That's an automatic postage entry, tied to a specific invoice — it can't be deleted here." }, 400);
    }
    await env.DB.prepare(`DELETE FROM expenditure WHERE id = ?1`).bind(id).run();
    return json({ success: true });
  }
  return json({ error: "Method not allowed" }, 405);
}

// Revenue: everything actually received (item subtotal + shipping) for
// non-cancelled orders in the period.
//
// Total Expenses: every cost entered for the period, all categories
// combined — including Inventory Stock, which is not treated as a
// special case here. This is deliberately cash-basis: a cost counts in
// the period it was paid, not the period the stock it bought eventually
// sells in. Net Profit = Revenue - Total Expenses, full stop.
async function handleAccountingReport(request, env, url) {
  if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  if (!from || !to) return json({ error: "from and to (YYYY-MM-DD) are required" }, 400);

  const revRow = await env.DB.prepare(
    `SELECT COALESCE(SUM(total),0) as revenue, COUNT(*) as order_count
     FROM orders WHERE status != 'cancelled' AND date(created_at) BETWEEN ?1 AND ?2`
  ).bind(from, to).first();

  const { results: byCategory } = await env.DB.prepare(
    `SELECT COALESCE(category,'(none)') as category, COALESCE(SUM(amount),0) as amount
     FROM expenditure WHERE exp_date BETWEEN ?1 AND ?2
     GROUP BY category ORDER BY amount DESC`
  ).bind(from, to).all();

  // Revenue by product category (Ring/Bracelet/Necklace/etc.) — same shape
  // as the expenditure breakdown, mirrored on the Sales Accounting page.
  // Uses order_items.category, snapshotted at sale time, so a later
  // category rename on an inventory item never rewrites historical sales.
  const { results: salesByCategory } = await env.DB.prepare(
    `SELECT oi.category as category, COALESCE(SUM(oi.line_total),0) as amount
     FROM order_items oi JOIN orders o ON o.id = oi.order_id
     WHERE o.status != 'cancelled' AND date(o.created_at) BETWEEN ?1 AND ?2
     GROUP BY oi.category ORDER BY amount DESC`
  ).bind(from, to).all();

  const revenue = Number(revRow.revenue) || 0;
  const totalExpenses = byCategory.reduce((sum, r) => sum + Number(r.amount), 0);
  const netProfit = revenue - totalExpenses;

  return json({
    from, to,
    revenue, order_count: revRow.order_count,
    total_expenses: totalExpenses, net_profit: netProfit,
    expense_by_category: byCategory.map(r => ({ category: r.category, amount: Number(r.amount) })),
    sales_by_category: salesByCategory.map(r => ({ category: r.category, amount: Number(r.amount) })),
  });
}

async function getActiveLibraries(env) {
  const { results } = await env.DB.prepare(`SELECT active_libraries FROM shop_config WHERE id = 1`).all();
  const raw = (results[0] && results[0].active_libraries) || "Ring,Bracelet,Necklace,Earring,Anklet,Bangle,Watch,Finger Bracelet";
  return raw.split(",").map(s => s.trim()).filter(Boolean);
}

async function handleSiteLogo(request, env) {
  if (request.method === "GET") {
    const { results } = await env.DB.prepare(`SELECT logo_url FROM shop_config WHERE id = 1`).all();
    return json({ logo_url: (results[0] && results[0].logo_url) || null });
  }
  if (request.method === "POST") {
    const b = await request.json();
    if (!b.logo_url) return json({ error: "logo_url required" }, 400);
    await env.DB.prepare(`UPDATE shop_config SET logo_url = ?1 WHERE id = 1`).bind(b.logo_url).run();
    return json({ success: true });
  }
  return json({ error: "Method not allowed" }, 405);
}

async function renderShopPage(request, env) {
  const libs = await getActiveLibraries(env);
  const placeholders = libs.map((_, i) => `?${i + 1}`).join(",");
  const { results } = libs.length
    ? await env.DB.prepare(`SELECT * FROM inventory WHERE category IN (${placeholders}) AND shop_position IS NOT NULL ORDER BY RANDOM()`).bind(...libs).all()
    : { results: [] };

  const CATEGORY_PLURAL = { Ring: "rings", Bracelet: "bracelets", Necklace: "necklaces", Earring: "earrings", Anklet: "anklets", Bangle: "bangles", Watch: "watches", "Finger Bracelet": "finger bracelets", Other: "other" };

  // Rings only: fetch each ring's live per-size stock so the customer can
  // pick a size on the card. Sizes with shop_qty <= 0 still render (greyed,
  // disabled) so the customer can see the size exists rather than it just
  // vanishing from the list.
  const ringSizesById = {};
  const ringIds = results.filter(p => p.category === "Ring").map(p => p.id);
  if (ringIds.length) {
    const ph = ringIds.map((_, i) => `?${i + 1}`).join(",");
    // Fetches every size, including sold-out ones (shop_qty = 0), so they
    // can still be shown in the dropdown, disabled, rather than silently
    // vanishing.
    const { results: allSizeRows } = await env.DB.prepare(
      `SELECT inventory_id, size, shop_qty FROM ring_sizes WHERE inventory_id IN (${ph}) ORDER BY id ASC`
    ).bind(...ringIds).all();
    allSizeRows.forEach(r => { (ringSizesById[r.inventory_id] = ringSizesById[r.inventory_id] || []).push({ size: r.size, shop_qty: Number(r.shop_qty) }); });
  }

  const cardsHtml = results.length
    ? results.map(p => {
        const soldOut = Number(p.shop_qty) <= 0;
        const searchBlob = (p.name + " " + p.category + " " + (CATEGORY_PLURAL[p.category] || "") + " " + (p.notes || "")).toLowerCase();
        const sizes = p.category === "Ring" ? (ringSizesById[p.id] || []) : [];
        const sizesAttr = sizes.length ? ` data-sizes="${escapeHtml(JSON.stringify(sizes))}"` : "";
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
          ${sizes.length ? `<select class="size-select"${sizesAttr} onclick="event.stopPropagation()">
            <option value="">Select a size</option>
            ${sizes.map(s => `<option value="${escapeHtml(s.size)}"${s.shop_qty <= 0 ? ' disabled' : ''}>${escapeHtml(s.size)}${s.shop_qty <= 0 ? ' \u2014 Sold out' : ''}</option>`).join("")}
          </select>` : ''}
          <button type="button" class="add-to-cart-btn" data-id="${escapeHtml(p.id)}" data-sku="${escapeHtml(p.sku)}" data-name="${escapeHtml(p.name)}" data-price="${Number(p.sell_price || 0)}" data-image="${escapeHtml(p.photo_url)}" data-quantity="${Number(p.shop_qty || 0)}"${(soldOut || sizes.length) ? ' disabled' : ''}>${soldOut ? 'Sold Out' : (sizes.length ? 'Select a size' : 'Add to Cart')}</button>
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
    const fields = ["show_return_address", "return_name", "return_address", "postage_cost"];
    const sets = []; const vals = [];
    fields.forEach(f => {
      if (b[f] !== undefined) {
        sets.push(`${f} = ?`);
        vals.push(f === "show_return_address" ? (b[f] ? 1 : 0) : f === "postage_cost" ? (Number(b[f]) || 0) : b[f]);
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
        const soldOut = Number(p.shop_qty) <= 0;
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

// ===== Contact form email (SMTP to Zoho) =====
// Sends every contact-form submission straight into Lisa's Zoho inbox via
// raw SMTP over Cloudflare's TCP socket API (cloudflare:sockets) — no
// third-party email service, no extra account. Credentials come from
// env.ZOHO_SMTP_USER / env.ZOHO_SMTP_PASS, set with `wrangler secret put`
// (ZOHO_SMTP_USER is the full mailbox address, ZOHO_SMTP_PASS is a Zoho
// app-specific password, not the account login password). Until both are
// set, contactEmailConfigured() is false and the endpoint below returns a
// clean "not live yet" response instead of attempting to connect.
function contactEmailConfigured(env) {
  return !!(env.ZOHO_SMTP_USER && env.ZOHO_SMTP_PASS);
}

// Reads one full SMTP response, which may be a single line ("250 OK") or
// several continuation lines ("250-..." ... "250 OK") — only a line with a
// SPACE after the 3-digit code ends the response, a dash means more lines
// follow. Returns the numeric code of that final line plus the raw text,
// so callers can check e.g. res.code === 250.
async function readSmtpResponse(reader) {
  let buf = "";
  const decoder = new TextDecoder();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\r\n").filter(Boolean);
    const last = lines[lines.length - 1];
    if (last && /^\d{3} /.test(last)) {
      return { code: Number(last.slice(0, 3)), text: buf };
    }
  }
  return { code: 0, text: buf };
}

// Minimal SMTP client: connect → STARTTLS → AUTH LOGIN → MAIL/RCPT/DATA →
// QUIT. Deliberately hand-rolled rather than an npm SMTP library, since
// this project has no build step / bundler — everything lives in this one
// file, same as the rest of the Worker.
async function sendSmtpMail(env, { to, replyTo, subject, text }) {
  const { connect } = await import("cloudflare:sockets");
  const socket = connect(
    { hostname: "smtp.zoho.eu", port: 587 },
    { secureTransport: "starttls", allowHalfOpen: false }
  );

  let writer = socket.writable.getWriter();
  let reader = socket.readable.getReader();
  const enc = new TextEncoder();
  const send = async (line) => { await writer.write(enc.encode(line + "\r\n")); };

  let res = await readSmtpResponse(reader);
  if (res.code !== 220) throw new Error("SMTP greeting failed: " + res.text);

  await send("EHLO evellejewellery.co.uk");
  res = await readSmtpResponse(reader);
  if (res.code !== 250) throw new Error("EHLO failed: " + res.text);

  await send("STARTTLS");
  res = await readSmtpResponse(reader);
  if (res.code !== 220) throw new Error("STARTTLS failed: " + res.text);

  // Hand the connection to TLS — old plaintext reader/writer are done.
  writer.releaseLock();
  reader.releaseLock();
  const tlsSocket = socket.startTls();
  writer = tlsSocket.writable.getWriter();
  reader = tlsSocket.readable.getReader();

  await send("EHLO evellejewellery.co.uk");
  res = await readSmtpResponse(reader);
  if (res.code !== 250) throw new Error("EHLO (TLS) failed: " + res.text);

  await send("AUTH LOGIN");
  res = await readSmtpResponse(reader);
  if (res.code !== 334) throw new Error("AUTH LOGIN not offered: " + res.text);

  await send(btoa(env.ZOHO_SMTP_USER));
  res = await readSmtpResponse(reader);
  if (res.code !== 334) throw new Error("AUTH username rejected: " + res.text);

  await send(btoa(env.ZOHO_SMTP_PASS));
  res = await readSmtpResponse(reader);
  if (res.code !== 235) throw new Error("AUTH failed — check ZOHO_SMTP_USER/ZOHO_SMTP_PASS: " + res.text);

  await send(`MAIL FROM:<${env.ZOHO_SMTP_USER}>`);
  res = await readSmtpResponse(reader);
  if (res.code !== 250) throw new Error("MAIL FROM rejected: " + res.text);

  await send(`RCPT TO:<${to}>`);
  res = await readSmtpResponse(reader);
  if (res.code !== 250 && res.code !== 251) throw new Error("RCPT TO rejected: " + res.text);

  await send("DATA");
  res = await readSmtpResponse(reader);
  if (res.code !== 354) throw new Error("DATA rejected: " + res.text);

  const headers = [
    `From: Evelle Website <${env.ZOHO_SMTP_USER}>`,
    `To: <${to}>`,
    replyTo ? `Reply-To: <${replyTo}>` : null,
    `Subject: ${subject}`,
    `Date: ${new Date().toUTCString()}`,
    `Content-Type: text/plain; charset=UTF-8`,
  ].filter(Boolean).join("\r\n");

  // Dot-stuff per RFC 5321 — a line starting with '.' in the body would
  // otherwise be misread as the end-of-message marker.
  const body = text.replace(/\r\n\./g, "\r\n..").replace(/^\./, "..");

  await send(headers + "\r\n\r\n" + body + "\r\n.");
  res = await readSmtpResponse(reader);
  if (res.code !== 250) throw new Error("Message not accepted: " + res.text);

  await send("QUIT");
  try { await tlsSocket.close(); } catch (e) { /* best-effort */ }
}

async function handleContactSubmit(request, env) {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const b = await request.json().catch(() => ({}));
  const name = String(b.name || "").trim();
  const email = String(b.email || "").trim();
  const message = String(b.message || "").trim();
  if (!name || !email || !message) {
    return json({ error: "missing_fields", message: "Name, email, and message are all required." }, 400);
  }
  if (!contactEmailConfigured(env)) {
    return json({ error: "email_not_live", message: "Sorry — our contact form isn't switched on yet. Please email us directly at lisa@evellejewellery.co.uk instead." }, 503);
  }
  try {
    await sendSmtpMail(env, {
      to: "lisa@evellejewellery.co.uk",
      replyTo: email,
      subject: "New enquiry from evellejewellery.co.uk — " + name,
      text: `Name: ${name}\nEmail: ${email}\n\n${message}`,
    });
    return json({ success: true });
  } catch (e) {
    return json({ error: "send_failed", message: "Something went wrong sending your message — please try again or email us directly." }, 502);
  }
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
// Checkout is server-rendered only so the (non-secret) PayPal client id and
// the current postage cost can be injected — checkout.html's JS uses the
// PayPal id to decide whether to load the SDK, and the postage figure to
// show the customer the exact amount they'll actually be charged. The real,
// authoritative charge is always computed server-side in priceCartLines()
// at create-order time regardless of what's shown here.
async function renderCheckoutPage(request, env) {
  const template = await (await env.ASSETS.fetch(new Request(new URL("/checkout.html", request.url)))).text();
  const postageCost = await getPostageCost(env);
  const html = template
    .replace("<!--PAYPAL_CLIENT_ID-->", escapeHtml(env.PAYPAL_CLIENT_ID || ""))
    .replace("<!--POSTAGE_COST-->", String(postageCost))
    .replace("<!--SOCIAL_LINKS-->", socialLinksHtml(await getSocialLinks(env)));
  return new Response(html, { headers: { "Content-Type": "text/html;charset=UTF-8" } });
}

async function handleShopProducts(request, env, url) {
  if (request.method === "GET") {
    const { results } = await env.DB.prepare(`SELECT id, name, category, sku, shop_qty, sell_price, photo_url, shop_position FROM inventory WHERE shop_position IS NOT NULL ORDER BY category ASC, shop_position ASC`).all();
    const mapped = results.map(r => ({
      id: r.id, name: r.name, category: r.category, sku: r.sku, quantity: r.shop_qty,
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
  const validCats = ["Ring","Bracelet","Necklace","Earring","Anklet","Bangle","Watch","Finger Bracelet","Other"];
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
    const validCats = ["Ring","Bracelet","Necklace","Earring","Anklet","Bangle","Watch","Finger Bracelet","Other"];
    const valid = libs.filter(l => validCats.includes(l));
    await env.DB.prepare(`UPDATE shop_config SET active_libraries = ?1 WHERE id = 1`).bind(valid.join(",")).run();
    return json({ success: true, active_libraries: valid });
  }
  return json({ error: "Method not allowed" }, 405);
}

const ORDER_STATUSES = ["paid", "posted", "cancelled"];

// The postage charged to customers and logged as an expense are always the
// SAME number, read fresh from delivery_settings — set once by staff,
// editable any time. Falls back to 2.50 only if the row is ever missing
// entirely (should never happen once delivery_settings exists).
async function getPostageCost(env) {
  const row = await env.DB.prepare(`SELECT postage_cost FROM delivery_settings WHERE id = 1`).first();
  return row && row.postage_cost !== null && row.postage_cost !== undefined ? Number(row.postage_cost) : 2.50;
}

// Sums duplicate id+size lines so a tampered or stale client cart can't
// submit the same line twice to bypass the per-line stock guard below.
// Keyed on id+size (not just id) so two different ring sizes of the same
// SKU are always kept as separate lines, never merged into one quantity.
function mergeCartLines(items) {
  const map = new Map();
  (items || []).forEach(it => {
    const id = it && it.id;
    if (id === undefined || id === null || id === "") return;
    const qty = Number(it.qty) || 0;
    if (qty <= 0) return;
    const size = it.size ? String(it.size).trim() : null;
    const key = id + "::" + (size || "");
    const existing = map.get(key);
    map.set(key, { id, size, qty: (existing ? existing.qty : 0) + qty });
  });
  return [...map.values()];
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

  // Rolls back everything decremented so far in this order, both the
  // per-size ring_sizes row (if any) and the parent inventory aggregate.
  async function rollback(done) {
    for (const d of done) {
      if (d.size) {
        await env.DB.prepare(`UPDATE ring_sizes SET shop_qty = shop_qty + ?1 WHERE inventory_id = ?2 AND size = ?3`).bind(d.qty, d.id, d.size).run();
      }
      await env.DB.prepare(`UPDATE inventory SET shop_qty = shop_qty + ?1, updated_at = CURRENT_TIMESTAMP WHERE id = ?2`)
        .bind(d.qty, d.id).run();
    }
  }

  const decremented = []; // { id, size, qty, sku, name, category, sell_price, cost_per_item }
  for (const line of items) {
    // A ring line guards stock at the SIZE level first — the specific size
    // requested must have enough shop_qty, not just the ring overall. Only
    // once that atomic guard passes do we touch the parent aggregate, using
    // the exact same qty, so the two can never end up decremented by
    // different amounts.
    if (line.size) {
      const sizeRow = await env.DB.prepare(
        `UPDATE ring_sizes SET shop_qty = shop_qty - ?1 WHERE inventory_id = ?2 AND size = ?3 AND shop_qty >= ?1 RETURNING id`
      ).bind(line.qty, line.id, line.size).first();
      if (!sizeRow) {
        await rollback(decremented);
        const failedItem = await env.DB.prepare(`SELECT id, name, sku FROM inventory WHERE id = ?1`).bind(line.id).first();
        return { success: false, error: "item_unavailable", item: failedItem ? { id: failedItem.id, size: line.size, name: failedItem.name + " (size " + line.size + ")", sku: failedItem.sku } : { id: line.id, size: line.size } };
      }
    }

    const row = await env.DB.prepare(
      `UPDATE inventory SET shop_qty = shop_qty - ?1, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?2 AND shop_qty >= ?1
       RETURNING sku, name, category, sell_price, cost_per_item`
    ).bind(line.qty, line.id).first();

    if (!row) {
      // Parent guard failed — should only happen if the aggregate had drifted
      // from the sum of its sizes. Undo the size decrement just made above
      // (if any) plus every decrement already made earlier in this order.
      if (line.size) {
        await env.DB.prepare(`UPDATE ring_sizes SET shop_qty = shop_qty + ?1 WHERE inventory_id = ?2 AND size = ?3`).bind(line.qty, line.id, line.size).run();
      }
      await rollback(decremented);
      const failedItem = await env.DB.prepare(`SELECT id, name, sku FROM inventory WHERE id = ?1`).bind(line.id).first();
      return { success: false, error: "item_unavailable", item: failedItem ? { ...failedItem, size: line.size } : { id: line.id, size: line.size } };
    }

    decremented.push({
      id: line.id, size: line.size, qty: line.qty, sku: row.sku, name: row.name, category: row.category,
      sell_price: Number(row.sell_price) || 0, cost_per_item: Number(row.cost_per_item) || 0,
    });
  }

  const subtotal = decremented.reduce((sum, it) => sum + it.sell_price * it.qty, 0);
  const shipping = await getPostageCost(env);
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

  // Derived from the just-inserted row's AUTOINCREMENT id, never a
  // SELECT MAX()+1 — that id is already race-free, so riding on it keeps
  // invoice numbers race-free under concurrent checkouts with no extra guard.
  const invoiceNumber = "INV-" + String(orderId).padStart(4, "0");
  await env.DB.prepare(`UPDATE orders SET invoice_number = ?1 WHERE id = ?2`).bind(invoiceNumber, orderId).run();

  const itemStmts = decremented.map(it =>
    env.DB.prepare(
      `INSERT INTO order_items (order_id, inventory_id, sku, name, category, unit_price, quantity, line_total, unit_cost, line_cost, size)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)`
    ).bind(orderId, it.id, it.sku, it.name, it.category, it.sell_price, it.qty, it.sell_price * it.qty, it.cost_per_item, it.cost_per_item * it.qty, it.size || null)
  );
  await env.DB.batch(itemStmts);

  // Postage is charged to the customer and logged as an expense at the
  // SAME moment, using the SAME figure — there is no separate "what it
  // actually cost" step afterward, because nothing can be added to an
  // order once the customer has already paid. Tied to this invoice via
  // linked_order_id, same discipline as Inventory Stock's auto-logging.
  if (shipping > 0) {
    await env.DB.prepare(
      `INSERT INTO expenditure (exp_date, category, paid_from, amount, notes, linked_order_id)
       VALUES (?1,?2,?3,?4,?5,?6)`
    ).bind(
      new Date().toISOString().slice(0, 10), "Postage", "", shipping,
      `Auto: postage for ${invoiceNumber}`, orderId
    ).run();
  }

  return { success: true, orderId, invoiceNumber, subtotal, shipping, total };
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
    const row = await env.DB.prepare(`SELECT id, sku, name, category, sell_price, shop_qty FROM inventory WHERE id = ?1`).bind(line.id).first();
    if (!row) return { error: "item_unavailable", item: { id: line.id } };
    // For a ring line, availability is checked against the SPECIFIC size's
    // shop stock, not the ring's overall total — the ring can show plenty
    // of stock in aggregate while the exact size asked for is sold out.
    if (line.size) {
      const sizeRow = await env.DB.prepare(`SELECT shop_qty FROM ring_sizes WHERE inventory_id = ?1 AND size = ?2`).bind(line.id, line.size).first();
      if (!sizeRow || Number(sizeRow.shop_qty) < line.qty) {
        return { error: "item_unavailable", item: { id: row.id, name: row.name + " (size " + line.size + ")", sku: row.sku } };
      }
    } else if (Number(row.shop_qty) < line.qty) {
      return { error: "item_unavailable", item: { id: row.id, name: row.name, sku: row.sku } };
    }
    priced.push({ id: line.id, size: line.size, qty: line.qty, sku: row.sku, name: row.name, category: row.category, price: Number(row.sell_price) || 0 });
  }
  const subtotal = priced.reduce((sum, it) => sum + it.price * it.qty, 0);
  const shipping = await getPostageCost(env);
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
          name: (it.size ? `${it.name} (Size ${it.size})` : it.name).slice(0, 127),
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
    JSON.stringify(priced.items.map(it => ({ id: it.id, qty: it.qty, size: it.size || null }))),
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
  return json({ success: true, orderId: result.orderId, invoiceNumber: result.invoiceNumber, total: result.total });
}

// Staff-only manual override for testing the full order pipeline without
// PayPal. Gated by isAuthed() at the router level (same as every other
// /api/ route below) — a customer hitting checkout with no staff session
// gets a plain 401, never touches stock or creates an order. Runs through
// the exact same confirmOrder() every real payment uses, so stock decrement,
// invoice numbering, and order_items snapshotting are all genuinely tested,
// not faked. The only thing skipped is PayPal itself, which can't be tested
// without their own sandbox regardless of what this site does.
async function handleStaffTestOrder(request, env) {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const b = await request.json().catch(() => ({}));
  const c = b.customer || {};
  const missing = ["name", "email", "address_line1", "city", "postcode"].filter(f => !String(c[f] || "").trim());
  if (missing.length) return json({ error: "missing_fields", message: "Missing: " + missing.join(", ") }, 400);

  const result = await confirmOrder(env, { customer: c, items: b.items });
  if (!result.success) {
    return json({
      success: false, error: result.error, item: result.item,
      message: result.item ? ('"' + result.item.name + '" is out of stock.') : 'That item is out of stock.',
    }, 409);
  }
  return json({ success: true, orderId: result.orderId, invoiceNumber: result.invoiceNumber, total: result.total });
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
    const sort = url.searchParams.get("sort") || "";
    let sql = `SELECT o.*, (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id) as item_count FROM orders o`;
    const binds = [];
    if (status) { sql += ` WHERE o.status = ?1`; binds.push(status); }
    // 'invoice' sorts by id ASC (numerical order, INV-0001 first) for the
    // Accounting ledger view; every other caller (Orders & Sales, Delivery)
    // keeps the existing newest-first behaviour unchanged.
    sql += sort === "invoice" ? ` ORDER BY o.id ASC` : ` ORDER BY o.created_at DESC`;
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
    // created_at IS the paid timestamp — orders can only ever be inserted
    // as 'paid' (see confirmOrder), so that fact is permanent and never
    // needs its own column. posted_at / cancelled_at capture the other two
    // transitions the same way, so every invoice keeps a permanent record
    // of when each stage happened, visible regardless of current status.
    const stampCol = b.status === "posted" ? "posted_at" : b.status === "cancelled" ? "cancelled_at" : null;
    const sql = stampCol
      ? `UPDATE orders SET status = ?1, ${stampCol} = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?2`
      : `UPDATE orders SET status = ?1, updated_at = CURRENT_TIMESTAMP WHERE id = ?2`;
    await env.DB.prepare(sql).bind(b.status, id).run();

    return json({ success: true });
  }

  return json({ error: "Method not allowed" }, 405);
}

// Free-text search across invoice number, customer name, email, and
// postcode, with an optional created-date range — for staff pulling up a
// specific invoice fast (refunds/returns, HMRC records). Returns each match
// in the same { order, items } shape as GET /api/orders?id= so the UI can
// reuse that rendering.
async function handleInvoiceSearch(request, env, url) {
  if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
  const q = (url.searchParams.get("q") || "").trim();
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  if (!q) return json({ error: "q is required" }, 400);

  let sql = `SELECT * FROM orders WHERE (
    invoice_number LIKE ?1 ESCAPE '\\' OR customer_name LIKE ?1 ESCAPE '\\' OR
    customer_email LIKE ?1 ESCAPE '\\' OR postcode LIKE ?1 ESCAPE '\\'
  )`;
  const escaped = q.replace(/[\\%_]/g, c => "\\" + c);
  const binds = [`%${escaped}%`];
  let n = 2;
  if (from) { sql += ` AND date(created_at) >= ?${n}`; binds.push(from); n++; }
  if (to) { sql += ` AND date(created_at) <= ?${n}`; binds.push(to); n++; }
  sql += ` ORDER BY created_at DESC LIMIT 50`;

  const { results: orders } = await env.DB.prepare(sql).bind(...binds).all();
  if (!orders.length) return json({ orders: [] });

  const ids = orders.map(o => o.id);
  const placeholders = ids.map((_, i) => `?${i + 1}`).join(",");
  const { results: items } = await env.DB.prepare(
    `SELECT * FROM order_items WHERE order_id IN (${placeholders}) ORDER BY id ASC`
  ).bind(...ids).all();
  const itemsByOrder = {};
  for (const it of items) {
    (itemsByOrder[it.order_id] = itemsByOrder[it.order_id] || []).push(it);
  }

  return json({ orders: orders.map(o => ({ order: o, items: itemsByOrder[o.id] || [] })) });
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

    // Contact form is customer-facing — no staff session exists on the public site
    if (path === "/api/contact-submit" && request.method === "POST") {
      return handleContactSubmit(request, env);
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

    // Site logo — every page points here so a staff upload updates it
    // everywhere at once, with no redeploy. Falls back to the bundled
    // default file until a custom one is saved via Content Editor.
    if (path === "/logo" && request.method === "GET") {
      const { results } = await env.DB.prepare(`SELECT logo_url FROM shop_config WHERE id = 1`).all();
      const logoUrl = results[0] && results[0].logo_url;
      return Response.redirect(new URL(logoUrl || "/assets/images/evelle-logo.png", request.url).toString(), 302);
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
      if (path === "/api/inv-transfer") return handleInvTransfer(request, env, url);
      if (path === "/api/stream-plans") return handleStreamPlans(request, env, url);
      if (path === "/api/stream-plan-items") return handleStreamPlanItems(request, env, url);
      if (path === "/api/orders") return handleOrders(request, env, url);
      if (path === "/api/staff-test-order") return handleStaffTestOrder(request, env);
      if (path === "/api/invoice-search") return handleInvoiceSearch(request, env, url);
      if (path === "/api/expense-entries") return handleExpenseEntries(request, env, url);
      if (path === "/api/accounting-report") return handleAccountingReport(request, env, url);
      if (path === "/api/shop-products") return handleShopProducts(request, env, url);
      if (path === "/api/shop-unpublish") return handleShopUnpublish(request, env);
      if (path === "/api/shop-config") return handleShopConfig(request, env);
      if (path === "/api/shop-reorder") return handleShopReorder(request, env);
      if (path === "/api/upload-image") return handleImageUpload(request, env);
      if (path === "/api/site-logo") return handleSiteLogo(request, env);
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
