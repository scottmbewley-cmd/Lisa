function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function onRequestGet(context) {
  const { env } = context;
  const { results } = await env.DB.prepare(
    `SELECT * FROM sales ORDER BY sale_date DESC, created_at DESC`
  ).all();
  return json(results);
}

export async function onRequestPost(context) {
  const { env, request } = context;
  const b = await request.json();

  await env.DB.prepare(
    `INSERT INTO sales (sale_date, item_sku, item_name, category, quantity, sale_price, platform, received_via)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8)`
  )
    .bind(
      b.sale_date || new Date().toISOString().slice(0, 10),
      b.item_sku || null, b.item_name || "", b.category || "",
      b.quantity || 1, b.sale_price || 0, b.platform || "", b.received_via || ""
    )
    .run();

  // auto-decrement matching inventory stock, floor at 0
  if (b.item_sku) {
    await env.DB.prepare(
      `UPDATE inventory SET quantity = MAX(0, quantity - ?1), updated_at = CURRENT_TIMESTAMP WHERE sku = ?2`
    ).bind(b.quantity || 1, b.item_sku).run();
  }

  return json({ success: true });
}
