function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function onRequestGet(context) {
  const { env } = context;
  const { results } = await env.DB.prepare(
    `SELECT * FROM notes ORDER BY updated_at DESC LIMIT 1`
  ).all();
  return json(results[0] || { content: "" });
}

export async function onRequestPost(context) {
  const { env, request } = context;
  const b = await request.json();

  const { results } = await env.DB.prepare(`SELECT id FROM notes ORDER BY updated_at DESC LIMIT 1`).all();

  if (results.length) {
    await env.DB.prepare(`UPDATE notes SET content = ?1, updated_at = CURRENT_TIMESTAMP WHERE id = ?2`)
      .bind(b.content || "", results[0].id)
      .run();
  } else {
    await env.DB.prepare(`INSERT INTO notes (content) VALUES (?1)`).bind(b.content || "").run();
  }

  return json({ success: true });
}
