# Exquisitely You — Website (working title: Lisa)

Static front end + Cloudflare Pages Functions + D1 database. Built to replace the
Supabase/Netlify prototype. No build step — plain HTML/CSS/JS.

## Structure

- `index.html`, `shop.html`, `story.html`, `care.html`, `contact.html` — public site
- `staff/login.html` — staff sign-in (single shared password)
- `staff/index.html` — staff dashboard (links to Business Hub + placeholder sections)
- `staff/hub.html` — Business Hub: Inventory, Sales, Expenditure, Suppliers, Notes
- `functions/api/*.js` — Cloudflare Pages Functions (the backend API)
- `functions/_middleware.js` — protects `/staff/*` and `/api/*` behind login

## Database

D1 database `lisa-ey-db` already created on the Customer Sites Cloudflare account,
with five tables: `inventory`, `sales`, `expenditure`, `suppliers`, `notes`.

## Two things to set up in the Cloudflare dashboard before this works live

1. **Create the Pages project** — Customer Sites → Workers & Pages → Create →
   Pages → connect to GitHub → select the `Lisa` repo.

2. **Bind the D1 database** — In the new Pages project → Settings → Functions →
   D1 database bindings → Add binding → variable name `DB` → select `lisa-ey-db`.

3. **Set the staff password** — Settings → Environment variables → Add variable →
   name `STAFF_PASSWORD` → your chosen password. Until this is set, it falls back
   to `changeme-EY2026` — change this before sharing the login with Lisa.

Once those three are done, every push to the `main` branch on GitHub deploys
automatically — no further manual steps.
