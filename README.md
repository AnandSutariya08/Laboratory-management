# Health Care Labs

Laboratory information system for Health Care Labs: registration, billing, sample accession, result entry and verification, reports, dispatch, refunds and analytics. React (Vite) + Ant Design + Firebase (Auth, Firestore with `onSnapshot` real-time updates).

Functional spec: `../flabs-research/spec/` (start with `00-overview-and-architecture.md`).

## Run locally (Firebase emulators)

Requires Node 22.19+ and JDK 21 (`brew install openjdk@21`) for the emulators.

```bash
npm install
npm run emulators      # terminal 1: Auth + Firestore emulators, UI at http://localhost:4000
npm run seed           # terminal 2: lab settings, starter catalogue, admin login
npm run dev            # http://localhost:5173
```

Local admin login (emulator only): `admin@healthcarelabs.local` / `admin123`.
`.env.development` points the app at the emulators.

## Deploy to a real Firebase project

1. Create a Firebase project (region `asia-south1`), enable Email/Password sign-in and Firestore.
2. Copy `.env.example` to `.env.production` and fill in the web app config; set `VITE_USE_EMULATORS=false`.
3. Set the project id in `.firebaserc`.
4. Seed with a service account: `GOOGLE_APPLICATION_CREDENTIALS=key.json FIREBASE_PROJECT=<id> ADMIN_EMAIL=... ADMIN_PASSWORD=... node scripts/seed.mjs`
5. `npm run deploy` (builds, then deploys hosting, Firestore rules and indexes).

## Structure

- `src/types.ts` — data model (money in paise).
- `src/lib/` — billing maths (discount allocation, dues, report status), result logic (ranges, flags, formula evaluator), Firestore paths and counters, order operations.
- `src/hooks/` — `useLiveQuery` / `useLiveDoc` (onSnapshot) and catalogue hooks.
- `src/pages/` — registration, patients, accession, results, report, analysis, catalogue, admin.
- `firestore.rules` — role-based access; ledger and result versions are append-only; bills are voided, never deleted.
- `scripts/seed.mjs` — starter catalogue (reference ranges need pathologist review before clinical use).

## Importing your test catalogue

Tests > Import Catalogue: download the CSV template, fill it from your existing system's export (one row per parameter), preview, then import. Import tests before packages.

## Messaging setup

Report and booking messages (WhatsApp, SMS, email) are sent by the Cloud Functions in `functions/` (callables `sendReport`, `sendBookingMessage`, `getPublicReport`, and the `onOrderFinal` auto-send trigger). Provider keys live in Secret Manager, never in Firestore or the web app. Deploy with `firebase deploy --only functions,firestore:rules` (the `functions` predeploy step builds the TypeScript).

**Dev mode:** if a channel's secret is missing or empty (for example in the emulator), nothing is sent. The rendered message is written to `labs/{labId}/outbox` with status `logged`, the delivery history shows "Logged (dev)", and report links still work, so the whole flow can be tested locally. Run `npm run build` in `functions/` and start the Functions emulator alongside Auth and Firestore (`firebase emulators:start`).

Set each secret with `firebase functions:secrets:set NAME` (it prompts for the value):

| Secret | Value |
| --- | --- |
| `WHATSAPP_TOKEN` | Permanent system-user access token for the WhatsApp Cloud API |
| `WHATSAPP_PHONE_NUMBER_ID` | Phone number ID from WhatsApp Manager (not the phone number) |
| `MSG91_AUTH_KEY` | MSG91 auth key |
| `MSG91_REPORT_TEMPLATE_ID` | MSG91 Flow template id for the report SMS |
| `MSG91_BOOKING_TEMPLATE_ID` | MSG91 Flow template id for booking SMS |
| `SMTP_URL` | `smtps://user:password@smtp.example.com:465` (or `smtp://user:pass@host:587`); URL-encode special characters in the password |
| `MAIL_FROM` | Sender, e.g. `Health Care Labs <reports@lab.example.com>` |

**WhatsApp templates.** Business-initiated messages need templates approved by Meta (category Utility, language English). Set the template names under Settings > Messaging (defaults `report_ready` and `booking_update`). Body variables are filled positionally in this order:

- Report template: `{{1}}` patient name, `{{2}}` lab name, `{{3}}` bill number, `{{4}}` report link.
- Booking template (used for both events): `{{1}}` patient name, `{{2}}` lab name, `{{3}}` booking id, `{{4}}` date and slot, `{{5}}` collector name (`-` when not yet assigned).

**SMS (MSG91, India DLT).** SMS templates must be registered on your DLT portal and mapped to MSG91 Flow templates. Create the Flow variables with these exact names: report SMS `patientName`, `labName`, `billNo`, `link`; booking SMS `patientName`, `labName`, `bookingId`, `slot`, `collectorName`. Whitelist your report-link domain on DLT, and mind the per-variable length limit.

**Public report links.** Set Settings > Messaging > Public app URL (for example `https://lab.example.com`); links are `<url>/r/<token>`. The patient must enter the last 4 digits of their phone or their patient number; five wrong attempts lock the link. Links expire after the configured number of days. Share documents are in the root `reportShares` collection, reachable only by the functions.

Other options there: auto-send when a report becomes Final (uses the patient's selected WhatsApp/SMS/email dispatch modes) and blocking sends while a balance is due.

## AI setup

AI features (analyst chat and dashboards, result interpretation, MCP connector) run in Cloud Functions in `functions/src/ai/`. The Anthropic API key lives only in Secret Manager.

1. Set the key: `firebase functions:secrets:set ANTHROPIC_API_KEY`, then redeploy functions (`firebase deploy --only functions,firestore:rules,firestore:indexes`). With no key every AI call fails with "AI is not configured: set the ANTHROPIC_API_KEY secret"; nothing is ever answered without the model.
2. Enable AI in Lab Profile (Settings): turns on `aiEnabled` and lets you pick the model.
3. **Model and cost.** The default is `claude-opus-5-5` (Opus 5.5, $4 / $20 per million input / output tokens). `claude-sonnet-5-5` (Sonnet 5.5) and `claude-haiku-5-5` (Haiku 5.5) are cheaper; Haiku has no server-side refusal fallback. The analyst chat uses medium effort and interpretation low effort; the system prompt and tool definitions are prompt-cached, so repeated questions cost less. Analyst turns can make several tool calls, so a chat answer typically costs a few US cents on Opus 5.5.
4. **Privacy.** The analyst and the MCP connector only ever see aggregates (totals and groupings by day, referrer, department, test, payment mode, staff); no patient names, phone numbers or emails are queried or returned. Result interpretation sends only the patient's age and gender, the test name, and each parameter's value, unit, reference range and flag; never names, ids or contact details. Interpretations are saved as drafts on the result for the pathologist to review.
5. **Indexes.** Analytics reads `orders` by `deleted` + `createdAt` and the `ledger` collection group by `postedAt`; both are in `firestore.indexes.json` (deploy them for a real project).

### Connect Claude to your lab data (MCP)

1. In the app, create an MCP connection (admins only) with a label and validity in days. The connector URL is shown once.
2. In Claude: Settings > Connectors > Add custom connector, paste the URL, and save.
3. Ask Claude about your lab (for example "revenue by referrer last month"). Tools exposed: `get_kpis`, `run_analytics`, `list_tests`, `list_departments`, `lab_info`; all read-only and aggregate-only. Every call is logged under `labs/{labId}/mcpAudit`.

**The URL contains the access token: treat it as a secret** and do not share it. Revoke the connection in the app to cut access immediately; connections also expire on their own. In production the URL is `https://asia-south1-<project>.cloudfunctions.net/mcp/<token>` (in the emulator `http://127.0.0.1:5001/<project>/asia-south1/mcp/<token>`). To serve it from your own domain, set `publicApiBaseUrl` on the lab settings document to your Hosting domain; `firebase.json` rewrites `/mcp/**` to the function.
