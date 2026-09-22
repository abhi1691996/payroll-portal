# Deploying to Vercel

This app needs a real Postgres host (Vercel itself has no database), so the setup is: **Neon** for
Postgres, **GitHub** for source control, **Vercel** for hosting — the standard combination, and it
already fits this schema (`DATABASE_URL` is a pooled connection, `DIRECT_URL` is the direct one, which
is exactly how Neon splits its two connection strings).

Local prerequisites are already done: `postinstall` now runs `prisma generate` on every install (Vercel
needs this since the generated client isn't committed), `trustHost: true` is set in `src/auth.ts` (Vercel
proxies requests, so Auth.js needs to trust the `Host` header it's given), and the repo has been
`git init`'d with an initial commit.

## 1. Create the database (Neon)

1. Go to [neon.tech](https://neon.tech) (or, from the Vercel dashboard: **Storage → Create Database →
   Postgres** — that's Neon too) and create a project. Any region close to where you'll host is fine.
2. On the project's **Connection Details** panel, copy two strings:
   - The **pooled** one (hostname contains `-pooler`) → this becomes `DATABASE_URL`.
   - The **direct** one (no `-pooler`) → this becomes `DIRECT_URL`.
   Both need `?sslmode=require` on the end if Neon doesn't already add it.
3. Keep this tab open — you'll paste these into Vercel in step 4, and I'll need `DIRECT_URL` once
   (locally, never pasted into chat) to run the first migration.

## 2. Push to GitHub

1. Create a new **empty** repository on GitHub (no README, no `.gitignore` — this repo already has
   its own). Note the URL it gives you, e.g. `https://github.com/<you>/payroll-portal.git`.
2. Then, from `D:\Claude\payroll-portal`:
   ```
   git remote add origin https://github.com/<you>/payroll-portal.git
   git branch -M main
   git push -u origin main
   ```
   (Tell me the repo URL and I can run this for you.)

## 3. Import into Vercel

1. [vercel.com/new](https://vercel.com/new) → **Import Git Repository** → pick the repo you just
   pushed. Vercel auto-detects Next.js; leave the build settings as-is.
2. **Before the first deploy**, add these **Environment Variables** (Project Settings → Environment
   Variables, or the import screen's "Environment Variables" section) — apply them to Production
   (and Preview too, if you want preview deploys, but see the note on migrations below first):

   | Name | Value |
   |---|---|
   | `DATABASE_URL` | the **pooled** Neon string from step 1 |
   | `DIRECT_URL` | the **direct** Neon string from step 1 |
   | `AUTH_SECRET` | a random 32-byte secret — generated one for you: `7PFgn/1o5oltTtqukyfpoRVkt88lkMVIQ8tG3BsCxy0=` (or make your own with `npx auth secret`) |
   | `SUPER_ADMIN_EMAIL` | the email you'll use to sign in as the platform Super Admin |
   | `SUPER_ADMIN_PASSWORD` | a strong password for that account |

3. Deploy. It will build and go live, but **the database is still empty** — nothing works until step
   4 runs.

## 4. Run the first migration and seed

The migrations aren't run automatically on deploy (on purpose — one of them creates a second Postgres
*role* with Row-Level Security policies, and that's not something to run unattended on every push without
watching it). Do this once, from your machine, against the **production** database:

1. Create `.env.production.local` in the project root (already covered by `.gitignore` — it will never
   be committed) with just:
   ```
   DATABASE_URL="<the pooled Neon string>"
   DIRECT_URL="<the direct Neon string>"
   ```
2. Tell me it's there and I'll load it and run, against production:
   ```
   npx prisma migrate deploy
   npm run db:seed
   ```
   (`db:seed` with **no** `--demo` flag — that flag creates fake demo companies, which you don't want in
   production. It seeds the permission catalogue, the plans, and the Super Admin from
   `SUPER_ADMIN_EMAIL`/`SUPER_ADMIN_PASSWORD`.) If you'd rather run these yourself: in PowerShell,
   `Get-Content .env.production.local | ForEach-Object { if ($_ -match '^(\w+)="?(.*?)"?$') { Set-Item "Env:$($Matches[1])" $Matches[2] } }`
   loads the file into your session first.

3. **Rotate the `payroll_app` database password.** The RLS migration creates that role with the
   development default password (`payroll_app`) the *first* time it runs anywhere — it has to, since
   the role doesn't exist yet for it to read a password from. Right after step 4.2, run this once
   against Neon (its SQL Editor, or `psql` with `DIRECT_URL`):
   ```sql
   ALTER ROLE payroll_app PASSWORD 'xP3x2nn7HC5ssBFB7B7uBUQKrlR7jrJH';
   ```
   (or your own random string), then update the **`DATABASE_URL`** environment variable in Vercel to
   use that new password in place of `payroll_app`, and redeploy (Vercel → Deployments → ⋯ → Redeploy)
   so the running app picks it up. Skipping this leaves the app's database role on a publicly-known
   password.

## 5. Verify

Open the Vercel URL, sign in with `SUPER_ADMIN_EMAIL` / `SUPER_ADMIN_PASSWORD`, and use **Add client**
to create your first real company (this also sets up its roles, default rules and an invite link for
its Company Admin).

## Known constraints on Vercel

- **Bulk CSV uploads** go through a Server Action with a 5 MB body limit set in `next.config.ts` —
  Vercel's own platform has historically capped serverless function request bodies lower than that on
  some plans. If a large attendance/employee sheet fails to upload in production but works locally,
  that's why; ask me and I can move the upload to a direct-to-storage flow instead of shrinking it blindly.
- **Preview deployments**: if you turn on `DATABASE_URL`/`DIRECT_URL` for the Preview environment too,
  every preview branch shares the **same** production database unless you point it at a separate Neon
  branch/project. Neon supports database branching for exactly this; ask if you want it wired up.
- Payslip PDFs (`@react-pdf/renderer`) and the credentials-based login both run on the Node.js
  serverless runtime (the default for Route Handlers/Server Actions) — no Edge-runtime changes were
  needed anywhere.
