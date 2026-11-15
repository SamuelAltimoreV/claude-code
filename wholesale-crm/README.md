# Wholesale CRM

An operating system for a real estate wholesaling company: lead generation, acquisitions, underwriting,
offers, contracts, buyers, dispositions, transactions, communications, automation and analytics in one
application where every record is connected.

## Run it

```bash
cd wholesale-crm
npm install
npm run build        # builds the web app into ./dist
npm start            # http://localhost:8787
```

Open http://localhost:8787, choose **Create a workspace**, and keep "Load Ohio demo data" ticked to explore
with sample records. For development with hot reload use `npm run dev` (web app on :5173, API on :8787).

| Command | What it does |
|---|---|
| `npm test` | 37 tests: underwriting math, scoring, matching, compliance, the full API workflow, permissions, tenant isolation, scheduler, webhooks, attachments, and the SMS / email / AI connectors against local stand-ins |
| `npm run test:e2e` | Browser test of the lead-to-closing workflow through the UI |
| `npm run test:e2e:sweep` | Browser test of 27 secondary flows (filters, saved views, bulk actions, uploads, settings, roles, mobile) |

Each browser test needs its own fresh database: run `DB_MEMORY=true npm start`, run one test, restart the server
before the next.
| `npm run typecheck` | TypeScript check of server, shared logic and web app |

Configuration is in `.env` (copy `.env.example`). With no configuration the app stores data in an embedded
PostgreSQL under `./data/pg`. Set `DATABASE_URL` to use a PostgreSQL server or Supabase instead — the same SQL
runs on both, and the test suite passes on PostgreSQL 16.

## Architecture

```
shared/     Pure TypeScript used by both server and browser
  schema.ts       The relational data model (35 entities). DDL, validation and forms derive from it
  settings.ts     Organization settings, pipeline stages, role permission matrix
  calc.ts         Deal underwriting (percent-of-ARV and cost-based), comps, rule-based checks
  logic.ts        Lead scoring, buyer matching, compliance gate, duplicate detection, merge fields
  metrics.ts      Every dashboard / report number, computed from records
  automation.ts   Trigger, condition and action vocabulary + starter templates
server/
  db.ts           PostgreSQL access (pg or embedded PGlite), transactions, savepoints, schema migration
  repo.ts         Org-scoped SQL — the tenant isolation chokepoint
  service.ts      Validation, authorization, audit log and domain rules for every write
  automation.ts   Automation engine, follow-up sequences, scheduler, buyer matching/selection
  integrations.ts Provider registry, Twilio + SMTP connectors, signed webhooks
  ai.ts           Claude features (lead summary, deal review, analyst with read-only tools)
  auth.ts         scrypt password hashing, hashed session tokens, rate limiting
  app.ts          HTTP API
  seed.ts         Starter configuration and flagged demo data
client/src/
  lib/            API client, data hooks, formatting
  ui/             Design system: forms, data table, charts, timeline, dialogs
  pages/          The 18 sections
tests/            API workflow tests and the browser end-to-end test
```

**Key decisions**

- **PostgreSQL, relational, one schema definition.** Tables, foreign keys and indexes are generated from
  `shared/schema.ts`. Required references use `ON DELETE RESTRICT`, children cascade, optional links null out.
  Many-to-many seller/property ownership lives in `property_contacts`.
- **Security is enforced on the server.** Every query is scoped by `org_id` in `repo.ts`; every read and write
  passes the role permission matrix in `service.ts` (none / own / all per resource, plus delete). The browser
  hides what a role cannot use, but that is never the only check. Sessions are httpOnly cookies holding a
  random token whose hash is stored; state-changing requests require a custom header (CSRF).
- **One write path.** The API, automations, sequences, imports and webhooks all go through
  `service.create/patch/destroy`, so domain rules, the activity timeline and the audit log cannot be bypassed.
- **Each request is one transaction.** Automations triggered by a change run inside it; calls to outside
  providers (SMS, email, webhooks) are deferred until after commit.
- **Metrics are computed, never stored.** Dashboards and reports call the same functions in `shared/metrics.ts`
  that the tests and the AI analyst use.

Supabase note: this app talks to PostgreSQL from the server only, so tenant isolation is enforced in the
service layer rather than with Row Level Security. If you later expose the database directly to browsers
(Supabase client), add RLS policies on `org_id` first — see the roadmap.

## What is functional today

Everything below works end to end against the database and is covered by tests.

| Area | Status |
|---|---|
| Accounts, organizations, invites, 8 roles with an editable permission matrix, audit log | Working |
| Leads: profiles, scoring with visible reasons, tags, custom fields, saved views, bulk edit/assign, CSV import/export, duplicate detection | Working |
| Properties: independent records, multiple sellers, comps, photos/documents, seller-signal detection, full history | Working |
| Pipeline: 17 customizable stages, drag and drop, stage rules, per-stage stats | Working |
| Deal Analyzer: configurable % rule, cost-based strategy, comps, ratings, scenario comparison, save to property/lead | Working |
| Offers and counteroffers, contract tracking with signatures and deadlines, transactions with checklists | Working |
| Buyers, buy-box matching with explanations, dispositions, interest tracking, offer comparison, buyer selection | Working |
| Revenue recorded at closing; dashboard, analytics, marketing attribution and ROI | Working |
| Tasks, calendar (day/week/month), reminders, notifications | Working |
| Automation builder (13 triggers, 13 condition fields, 12 actions), execution history, retry, sequences | Working |
| Compliance: consent timestamps, do-not-contact, suppression list, quiet hours, unsubscribe links | Working |
| Conversation log with full notes and optional call transcripts | Working |
| Company settings: brand color, formats, lists, custom fields, markets, scoring, analyzer defaults | Working |
| Inbound/outbound webhooks (Zapier, Make, web forms), iCalendar feed | Working |
| Demo data flagged `is_demo`, removable in one click | Working |

## What needs credentials or is not built

Nothing in the app reports a send or a connection that did not happen.

| Capability | State | To enable |
|---|---|---|
| Sending and receiving SMS | Tested against a local mock of the Twilio REST API: request format, consent and contact-hour gating, failure handling, inbound STOP with signature check. **Not yet run against Twilio itself** | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` |
| Sending email | Tested against a local SMTP server: delivery, footer, unsubscribe link, suppression, automation and sequence sends. **Not yet run against your email provider** | `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` |
| AI lead summary, call summary, deal review, business analyst | Tested against a mock of the Anthropic Messages API: request shape, structured-output parsing, the analyst's tool calls over real records, permissions. **Not yet run against the live API** | `ANTHROPIC_API_KEY` |
| Calls | Logged manually | A calling-platform connector (not built) |
| Property data, county records, skip tracing, verified comps, MLS | Not built. Fields exist; records carry `data_source` | Provider contract + connector |
| E-signature | Signature status tracked by hand | Connector (not built) |
| Google Calendar two-way sync, Drive/Dropbox, accounting | Not built (one-way calendar feed and CSV export exist) | Connectors |

Until SMS/email are connected, sequence steps for those channels become manual tasks (when consent is on
file) and automation send actions fail with a logged reason. After adding credentials, use **Integrations →
Test connection** first, then send one message to yourself before relying on automations.

## Compliance

The compliance gate in `shared/logic.ts` (`canContact`) is applied to every manual send, sequence step and
automation action: do-not-contact, suppression list, recorded consent, contact hours, and a company mailing
address for email. These controls support TCPA, CAN-SPAM and do-not-call compliance; they are not legal
advice. You remain responsible for scrubbing lists against the national and Ohio do-not-call registries,
A2P 10DLC registration, and Ohio telephone-solicitation rules. The app tracks contracts and stores your
documents; it does not draft legally binding agreements.

## Product thinking: where this goes beyond a contact database

- **Nothing without a next step.** Every lead's next follow-up is derived from its open tasks. Leads with none
  are flagged on the lead, the pipeline card, the table and the dashboard.
- **Logging a call does the bookkeeping.** It updates last-contact, rescores the lead, advances the stage on
  first contact, creates the follow-up task, and pauses sequences when the seller replies.
- **One chain from offer to revenue.** An accepted offer pre-fills the contract; a fully executed contract opens
  the transaction with its checklist; starting a disposition matches buyers; selecting a buyer drafts the
  assignment agreement; closing records the fee and updates every dashboard.
- **Underwriting that argues back.** Rule-based checks flag missing comps, ARV that disagrees with comps,
  implausible repair budgets and asking prices above the MAO, and show how many buyers would match at that price.
- **Explainable scores.** Lead scores and buyer match scores list each factor, its points and the reason.
- **Speed to lead and stale-lead rescue** ship as enabled automations.

## Roadmap

1. **Row Level Security + a dedicated DB role** so isolation is enforced by PostgreSQL as well as the service
   layer (required before any direct-from-browser database access).
2. **Server-side pagination and aggregation.** The browser currently loads each collection and computes
   metrics locally, which is fast into the tens of thousands of records; beyond that, move list filtering and
   `shared/metrics.ts` aggregation into SQL.
3. **Live provider verification** for Twilio, SMTP and Anthropic, then two-way SMS threads and email open tracking.
4. **Calling platform** (click-to-call, recordings, automatic call logs) feeding AI call summaries.
5. **Property data, skip tracing and verified comps** behind the existing `data_source` field.
6. **E-signature** to drive signature status automatically; document generation from attorney-approved templates.
7. **Background job queue** (the scheduler runs in-process once a minute; use a queue with multiple app instances).
8. **Buyer portal / deal pages**, mobile driving-for-dollars capture, commission splits and payroll,
   two-factor authentication and SSO, object storage for attachments.
