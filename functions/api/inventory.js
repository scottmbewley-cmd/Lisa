function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function onRequestGet(context) {
  const { env, request } = context;
  const url = new URL(request.url);
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

export async function onRequestPost(context) {
  const { env, request } = context;
  const b = await request.json();

  // Generate next SKU if not provided
  let sku = b.sku;
  if (!sku) {
    const { results } = await env.DB.prepare(
      `SELECT sku FROM inventory WHERE sku LIKE 'EY-%'`
    ).all();
    const nums = results
      .map(r => (r.sku.match(/^EY-(\d+)$/) || [])[1])
      .filter(Boolean)
      .map(Number);
    const next = nums.length ? Math.max(...nums) + 1 : 1;
    sku = "EY-" + String(next).padStart(4, "0");
  }

  await env.DB.prepare(
    `INSERT INTO inventory (sku, name, category, material, stone_detail, durability, quantity, cost_per_item, sell_price, reorder_at, supplier, photo_url, notes)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)`
  )
    .bind(
      sku, b.name || "", b.category || "", b.material || "", b.stone_detail || "",
      b.durability || "", b.quantity || 0, b.cost_per_item || 0, b.sell_price || 0,
      b.reorder_at || 0, b.supplier || "", b.photo_url || "", b.notes || ""
    )
    .run();

  return json({ success: true, sku });
}

export async function onRequestPatch(context) {
  const { env, request } = context;
  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  if (!id) return json({ error: "id required" }, 400);

  const b = await request.json();
  const fields = ["name","category","material","stone_detail","durability","quantity","cost_per_item","sell_price","reorder_at","supplier","photo_url","notes"];
  const sets = [];
  const vals = [];
  fields.forEach(f => {
    if (b[f] !== undefined) { sets.push(`${f} = ?`); vals.push(b[f]); }
  });
  if (!sets.length) return json({ error: "no fields to update" }, 400);
  sets.push(`updated_at = CURRENT_TIMESTAMP`);
  vals.push(id);

  await env.DB.prepare(`UPDATE inventory SET ${sets.join(", ")} WHERE id = ?`).bind(...vals).run();
  return json({ success: true });
}

export async function onRequestDelete(context) {
  const { env, request } = context;
  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  if (!id) return json({ error: "id required" }, 400);

  await env.DB.prepare(`DELETE FROM inventory WHERE id = ?`).bind(id).run();
  return json({ success: true });
}
