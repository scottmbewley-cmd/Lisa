function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function onRequestGet(context) {
  const { env } = context;
  const { results } = await env.DB.prepare(
    `SELECT * FROM suppliers ORDER BY date_ordered DESC`
  ).all();
  return json(results);
}

export async function onRequestPost(context) {
  const { env, request } = context;
  const b = await request.json();

  await env.DB.prepare(
    `INSERT INTO suppliers (name, date_ordered, lead_time_days) VALUES (?1,?2,?3)`
  )
    .bind(b.name || "", b.date_ordered || new Date().toISOString().slice(0, 10), b.lead_time_days || 0)
    .run();

  return json({ success: true });
}
