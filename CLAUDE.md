# CLAUDE.md — Evelle Jewellery website

Repo root: `C:\Users\Administrator\Desktop\Lisa`
Live site: **https://evellejewellery.co.uk**

Static front end + a single Cloudflare Worker (`_worker.js`) + D1. No build step,
plain HTML/CSS/JS. All backend logic (`/api/*`, staff login gating, static asset
serving) lives in the one `_worker.js` file — Cloudflare's Workers-with-static-assets
pattern, not Pages Functions.

Public pages: `index` `shop` `story` `care` `contact` `checkout`.
Staff area: `public/staff/` (login + Business Hub), gated by `STAFF_PASSWORD` secret.

---

## Cloudflare — verified by API on 2026-09-23

| Thing | Value |
|---|---|
| **Account** | **Customer Sites** — `c6461ebabf215cc5954addbe79c58748` |
| Zone | `evellejewellery.co.uk` — `f9aa1166d11db2f750fbc70ec40bdcd3` (active) |
| Worker | `lisa-website` (also `lisa-website.scott-bewley.workers.dev`) |
| D1 | `lisa-ey-db` — `1cbcab9d-8aeb-40d4-ae00-ebb8d8eb5f65` (binding `DB`) |
| R2 | `evelle-images` (binding `IMAGES`) |
| Assets | `./public` (binding `ASSETS`, `run_worker_first: true`) |

**This site is NOT on OWN SITES (`03986f327d56348da4402ea862def397`).** Confirmed by
API: OWN SITES holds only `mudeford-web-design-db` / `mudeford-web-design-media` and
one unrelated Worker. A stale `.wrangler` cache elsewhere on this machine points at
OWN SITES — do not trust local caches, query the API.


**Account-wide protection already in place:** 20 Firewall Access Rules (whitelist
mode) covering Googles official crawler IP ranges (66.249.64.0/24-79.0/24,
192.178.4.0/24-7.0/24) were created 2026-09-16 to fix Cloudflares DDoS
protection false-flagging Googlebot. Account-level, so they cover every Customer
Sites zone including this one. Verified still active via API 2026-09-23. Do not
recreate these -- if Google publishes new crawler ranges later, extend this set
rather than replacing it.

The account token can see three accounts: Customer Sites, OWN SITES, and
Domain Holding Area (`bad610e7433aa6c02b78dae22828189c`).

---

## Git

- Remote: `origin  https://github.com/scottmbewley-cmd/Lisa.git`
- Default branch: `main`
- Gitignored: `.wrangler/`, `node_modules/`, `.dev.vars`, `deploy_log*.txt`, `tail_log.txt`

---

## Deploy

There is **no `package.json`** — no npm scripts. Deploy is wrangler direct.

`wrangler.jsonc` deliberately has **no `account_id`**, and the token sees three
accounts, so a bare `wrangler deploy` fails with:

```
X [ERROR] More than one account available but unable to select one in non-interactive mode.
```

Set the account explicitly. From `Desktop\Lisa`, in PowerShell:

```powershell
$env:CLOUDFLARE_ACCOUNT_ID = "c6461ebabf215cc5954addbe79c58748"
npx wrangler deploy
```

Full sequence:

1. **Ask Scott and get explicit confirmation before deploying.**
2. Verify the Cloudflare account by API (not from cache).
3. Stage changed files **by name**, commit, push to `main`.
4. `$env:CLOUDFLARE_ACCOUNT_ID = "c6461eba..."` then `npx wrangler deploy`.
5. Verify live with a cache-busting query string, e.g.
   `curl -sI "https://evellejewellery.co.uk/shop.html?cb=$(date +%s)"`
6. Update **Known state** below before finishing the session.

A successful deploy prints the bindings table plus
`Deployed lisa-website triggers` and the custom domain.

---

## Standing rules for this project

- **Never deploy without explicit confirmation from Scott.** No exceptions for
  "small" changes.
- **Always verify the Cloudflare account before any Cloudflare action.** Query the
  API; never assume from memory or from a `.wrangler` cache.
- **Stage files by name — never `git add .`**
- **Verify live after every deploy** with a cache-busting query string. A "not
  working" report is often a stale cache, not a code bug.
- **Update the Known state section below** at the end of any session that fixes,
  deploys, or changes anything here — without being asked.
- Global rules in `~/.claude/CLAUDE.md` also apply: one browser tab at a time;
  no deploy logs or scratch files written to the Desktop.

Note: this repo has **no `Open Live Site.url`** shortcut (unlike Orca / NFFS /
NewForestPropertyServices). The global rule about keeping that file current does
not apply here unless one is added.

---

## Known state — as of 2026-09-23

**Production matches the repo** as of `d1a5669` (2026-09-20) — canonicals from that
commit verified live on all four inner pages. No site code has changed since; the
only later commit adds this CLAUDE.md.

**SEO / indexing already done**

- `robots.txt` — `0219ec3`, 2026-09-07. Allows all, disallows `/staff/` and `/api/`,
  declares the sitemap. Serving live.
- `sitemap.xml` — `0219ec3`, 2026-09-07. 5 URLs (`/`, shop, story, care, contact).
  Returns 200.
- Canonical tags — `d1a5669`, 2026-09-20. Self-referencing, apex HTTPS, on all five
  public pages. Verified live.
- Favicon set, `width`/`height` on logo images sitewide, contrast fixes on `.muted`
  and footer — `6281f50`, 2026-09-12.

**Zone config — set in the Cloudflare dashboard, NOT in this repo** (so it will not
show up in git; check the dashboard before assuming it is missing)

- Dynamic redirect rule: `www.evellejewellery.co.uk` → apex. Verified live: 301.
- Dynamic redirect rule: apex `/index.html` → `/`.
- HSTS on: `max-age=15552000`, `includeSubDomains`, `preload`, plus `nosniff`
  (set 2026-09-12). Confirmed in live response headers.
- Always Use HTTPS: on.

**Outstanding**

- `meta description` exists only on `index.html`. Missing on `shop`, `story`,
  `care`, `contact`.
- No Open Graph / Twitter card tags on any page.
- `checkout.html` has no canonical, is absent from the sitemap, and is not
  disallowed in `robots.txt` — so it is crawlable but unmarked. Decide: `noindex`
  or leave.
- `sitemap.xml` has no `<lastmod>` values.
- **Not in Google Search Console — deliberate, not an oversight.** This site is not
  officially launched yet. Scott is keeping it low-visibility on purpose while it's
  unlaunched: no GBP, no Search Console property, no promotion. Do NOT set any of
  this up, submit a sitemap, or try to improve indexing here unless Scott explicitly
  says the site has launched. If he says it's ready to push live/public, ask what
  he wants set up before doing anything.
