// Protects /staff/* pages (except login.html) and /api/* routes (except login)
// with a single shared staff password, set via the STAFF_PASSWORD environment
// variable in Cloudflare Pages settings.

async function expectedSessionValue(env) {
  const password = env.STAFF_PASSWORD || "changeme-EY2026";
  const enc = new TextEncoder().encode(password);
  const hashBuf = await crypto.subtle.digest("SHA-256", enc);
  return [...new Uint8Array(hashBuf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

export async function onRequest(context) {
  const { request, env, next } = context;
  const url = new URL(request.url);
  const path = url.pathname;

  const isPublic = path === "/staff/login.html" || path === "/api/login";

  if (isPublic) return next();

  const needsAuth = path.startsWith("/staff/") || path.startsWith("/api/");
  if (!needsAuth) return next();

  const cookie = request.headers.get("Cookie") || "";
  const match = cookie.match(/ey_staff_session=([^;]+)/);
  const provided = match ? match[1] : null;
  const expected = await expectedSessionValue(env);

  if (provided === expected) {
    return next();
  }

  if (path.startsWith("/api/")) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  return Response.redirect(new URL("/staff/login.html", url.origin), 302);
}
