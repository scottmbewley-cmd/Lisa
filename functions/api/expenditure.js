function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function onRequestGet(context) {
  const { env } = context;
  const { results } = await env.DB.prepare(
    `SELECT * FROM expenditure ORDER BY exp_date DESC, created_at DESC`
  ).all();
  return json(results);
}

export async function onRequestPost(context) {
  const { env, request } = context;
  const b = await request.json();
  let linkedId = null;

  // If this expense is logging new stock, create/update the matching inventory row
  if (b.category === "Stock / Inventory" && b.stock_name) {
    const skuRows = await env.DB.prepare(`SELECT sku FROM inventory WHERE sku LIKE 'EY-%'`).all();
    const skuNums = skuRows.results
      .map(r => (r.sku.match(/^EY-(\d+)$/) || [])[1])
      .filter(Boolean)
      .map(Number);
    const next = skuNums.length ? Math.max(...skuNums) + 1 : 1;
    const sku = "EY-" + String(next).padStart(4, "0");

    const insertRes = await env.DB.prepare(
      `INSERT INTO inventory (sku, name, category, material, stone_detail, durability, quantity, cost_per_item, sell_price, reorder_at, supplier)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)`
    )
      .bind(
        sku, b.stock_name, b.stock_category || "", b.stock_material || "",
        b.stock_stone || "", b.stock_durability || "", b.stock_quantity || 0,
        b.amount && b.stock_quantity ? (b.amount / b.stock_quantity) : 0,
        b.stock_sell_price || 0, b.stock_reorder_at || 0, b.stock_supplier || ""
      )
      .run();
    linkedId = insertRes.meta.last_row_id;
  }

  await env.DB.prepare(
    `INSERT INTO expenditure (exp_date, category, paid_from, amount, notes, linked_inventory_id)
     VALUES (?1,?2,?3,?4,?5,?6)`
  )
    .bind(
      b.exp_date || new Date().toISOString().slice(0, 10),
      b.category || "", b.paid_from || "", b.amount || 0, b.notes || "", linkedId
    )
    .run();

  return json({ success: true, linkedInventoryId: linkedId });
}
