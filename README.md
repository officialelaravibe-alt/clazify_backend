# Clazify backend (v2.2)

Secure API between:
- **Clazify Android app** (trainers),
- **LAS desktop app** (manager — sends lecture adjustments),
- **Google Apps Script** (sends attendance).

Hosted on Render, data in Supabase PostgreSQL, push notifications through Firebase Cloud Messaging.

## Who can call what (no shared secrets)

Everybody signs in with a **Google work account** — only `@codequotient.com` and `@cqst.in` (change with `ALLOWED_EMAIL_DOMAINS`).
The server checks the Google ID token (signature, expiry, client ID, verified email, domain) and gives back its own session token. Only the SHA-256 of a session token is stored.

| Caller | Sign-in | Can do |
|---|---|---|
| LAS (manager) | `POST /api/auth/google {client:"las"}` — must be a manager. The first LAS sign-in becomes the manager (or `MANAGER_EMAILS`). | Send the team list (`PUT /api/team`, email + name), send adjustments |
| Clazify app (trainer) | `POST /api/auth/google {client:"app"}` — email must be in the manager's team list | Everything in the app |
| Google Apps Script | `ScriptApp.getIdentityToken()` as Bearer — the script owner must be in the team list | Upload attendance |
| Anyone | — | `GET /health`, `POST /api/timetable/refresh` (cron ping, no input, no data back) |

- Removing someone from the team list in LAS ends their access at once.
- One phone per trainer: signing in on a new phone signs the old one out and warns it.
- Member lists never include emails or push tokens.
- NVIDIA and Google Drive keys stay on the server.
- No CORS, Helmet headers, rate limits, 1 MB body limit, generic errors, redacted logs.

## Lecture adjustments

1. LAS sends the **whole plan for one date** to `POST /api/adjustments`.
2. Each item carries `assignedEmail` (from the LAS team list) and goes ONLY to the trainer signed in with that email.
   No email in the team list, or that trainer has not signed in yet = listed under `unmatched`. With an email, the lecture is kept and reaches that trainer as soon as they sign in.
3. New or changed lectures → data-only push `ADJUSTMENT` to that trainer.
   Lectures removed from the plan (or moved to someone else) → push `ADJUSTMENT_CANCELLED`.
   Sending the same plan again sends nothing.
4. The app also calls `GET /api/adjustments/mine` (today + 6 days) when it opens, so a missed push is not a problem.

Reply to LAS: `{ success, count, notified, cancelled, unmatched: [names] }`.

## Timetable (read on the server)

The timetable PDF is put in the shared Google Drive folder (`GOOGLE_DRIVE_FOLDER_ID`). The server reads the **newest** PDF:

1. It reads only the header ("Teacher ...") of every page.
2. Only pages whose teacher matches an active LAS team member are parsed (same name rules as `src/names.js`).
3. Cells are found from the table lines, so 2-slot lectures, 4-slot labs and half rows are read exactly.
4. The result is saved in `timetables` + `timetable_entries`. Old data stays until a new parse succeeds.

It is parsed again only when the newest file, its Drive `modifiedTime`, the team list or the parser version changes.

| Endpoint | Who | What |
|---|---|---|
| `POST /api/timetable/refresh` | anyone (cron-job.org) | Starts a check in the background, answers `202 {status}` at once. Max one check per minute, 30 calls per hour. |
| `POST /api/las/timetable/refresh` | manager | Checks now and waits. Body `{force:true}` parses again even if nothing changed. Reply: `{status, fileName, pages, teachersMatched, lectures, unmatched:[team names not found in the PDF]}` |
| `GET /api/las/timetable` | manager | `{timetable, teachers:[all names in the PDF], unmatched, lectures:[{email, teacher, day, slots, courseCode, venue, className}], sync}` |
| `GET /api/timetable/mine?known=<version>` | trainer app | `{changed, version, timetable, lectures:[{day, slots, courseCode, venue, className}]}` — only the trainer's own lectures. When `known` is the current version the answer is just `{changed:false, version}` and the phone keeps its saved copy. After a new timetable is saved, trainers whose own lectures changed get a data-only `TIMETABLE_UPDATED` push (no lecture data in it). |

Changing the team in LAS (`PUT /api/team`) also starts a check, so a new member's page is read.

Suggested cron-job.org job: `POST https://<server>/api/timetable/refresh`, Mon–Sat 08:30 and 13:00 IST.
It also wakes the free Render server before classes and keeps the Supabase project active.

Test PDF: `test/fixtures/timetable_sample.pdf` (made-up names, built by `make_timetable_pdf.py`). Never commit a real timetable: this repository is public.

## Environment variables

See `.env.example`. Endpoints whose secret is missing or too short are switched off (HTTP 503) instead of running open.

## Run and test

```
npm ci
npm test      # starts a throw-away local PostgreSQL, tests the upgrade from the old schema and every endpoint
npm start
```

The server upgrades the database schema by itself on start-up (safe to run many times).
