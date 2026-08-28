async function hashValue(value) {
  const enc = new TextEncoder().encode(value);
  const hashBuf = await crypto.subtle.digest("SHA-256", enc);
  return [...new Uint8Array(hashBuf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const body = await request.json().catch(() => ({}));
  const provided = body.password || "";
  const correct = env.STAFF_PASSWORD || "changeme-EY2026";

  if (provided !== correct) {
    return new Response(JSON.stringify({ success: false, error: "Incorrect password" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const sessionValue = await hashValue(correct);
  const headers = new Headers({ "Content-Type": "application/json" });
  headers.append(
    "Set-Cookie",
    `ey_staff_session=${sessionValue}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`
  );

  return new Response(JSON.stringify({ success: true }), { status: 200, headers });
}
