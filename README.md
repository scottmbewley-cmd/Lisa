# Evelle — Website

Static front end + a single Cloudflare Worker script + D1 database. Built to
replace the Supabase/Netlify prototype. No build step — plain HTML/CSS/JS.

## Structure

- `index.html`, `shop.html`, `story.html`, `care.html`, `contact.html` — public site
- `staff/login.html` — staff sign-in (single shared password)
- `staff/index.html` — staff dashboard (links to Business Hub + placeholder sections)
- `staff/hub.html` — Business Hub: Inventory, Sales, Expenditure, Suppliers, Notes
- `_worker.js` — single Worker script handling `/api/*` routes, staff login
  gating, and serving everything else as static assets. Cloudflare's modern
  Workers-with-static-assets pattern replaced the old Pages Functions folder
  approach, so all backend logic lives in this one file.

## Database

D1 database `lisa-ey-db` already created on the Customer Sites Cloudflare account,
with five tables: `inventory`, `sales`, `expenditure`, `suppliers`, `notes`.

## Deploy

Uploaded directly via Cloudflare dashboard → Workers & Pages → Create application
→ Upload your static files (drag in this whole folder or its ZIP).

## Two things to set up in the Cloudflare dashboard after uploading

1. **Bind the D1 database** — Worker → Settings → Bindings → Add → D1 database →
   variable name `DB` → select `lisa-ey-db`.

2. **Set the staff password** — Settings → Variables and Secrets → Add →
   name `STAFF_PASSWORD` → your chosen password. Until this is set, it falls back
   to `changeme-EV2026` — change this before sharing the login with Lisa.

After both, redeploy (or it applies on the next request depending on binding type).
