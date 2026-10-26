# CLAUDE.md

Guidance for future Claude sessions working in this repo.

## What this is

A single Google Apps Script (`Code.gs`) **bound to the "Personalized Batch Mailer
Request" Google Form**. It runs as **james@myadventuregroup.com.au** (the Form
owner), so `GmailApp` reads James's own inbox and sends as James. Deploy by
pasting `Code.gs` into the Form's bound Apps Script project — this repo is the
source of truth, not a deploy target. No build step, package manager, or tests.

> **Note:** older comments said it runs as "julienne". That was wrong and was
> corrected on 2026-10-26 — it runs as **James**. The working directory for this
> project is often the `chat_history/` subfolder, but the project root (with
> `Code.gs`, `as_built.txt`, `CLAUDE.md`, `.gitignore`) is `batch_mailer/`.

## Flow (read before editing Code.gs)

`onFormSubmit(e)` (installable "On form submit" trigger) runs the whole pipeline:

1. `readFormAnswers_` / `parseAndValidateAnswers_` — form item titles are matched
   by **prefix** (case-insensitive, trimmed) via `FORM_TITLES`, so extra text can
   be appended to a question title without breaking parsing.
2. Insert a `processing` row into `public.personalized_batch_mailer_requests`
   (Supabase).
3. `findSourceEmail_` — `GmailApp.search` by `subject:"..." to:me` within a few
   days of the submitted sent-date, then keeps only messages whose date (in
   `Asia/Manila`) exactly matches. **Throws if 0 or >1 match** — the subject+date
   must identify exactly one email.
4. `readSheet_` — first sheet of the linked spreadsheet; row 1 = headers; the
   **first column is the recipient email**.
5. `validateMappingColumns_` — every mapped column must exist in the header row.
6. `sendPersonalizedEmails_` — per row, substitutes each `{{placeholder}}` with
   the mapped column value and sends via `GmailApp.sendEmail`, **forwarding the
   source email's attachments**. Rows without a valid email are skipped.
7. `sendCompletionEmail_` — summary to requester + notify list (or a failure
   email on any thrown error).
8. Update the Supabase row to `processed` (counts) or `error` (message).

Placeholder mapping input format: one `{{placeholder}} = Column Name` per line.

## Critical conventions / gotchas

- **Shared Gmail quota.** The mailer + the two lead-response watchers
  (`../gmail_watchers/outbound_lead_response_automations`,
  `../gmail_watchers/process_leads_per_response`) all run as **James**, sharing
  **one** per-account Apps Script Gmail quota pool. If a mailer run fails with
  *"Service invoked too many times for one day: premium gmail"*, the pool is
  exhausted — usually by watcher polling, not the mailer. Quota resets midnight US
  Pacific (~3 PM PH during PDT, ~4 PM PH during PST).
- **Pre-send guard is partial.** `MailApp.getRemainingDailyQuota()` only reflects
  the recipient-SEND quota, not the broader Gmail service-invocation (read) quota
  that also throws the "too many times" error. A clean guard pass does not
  guarantee the send will succeed if reads are exhausted.
- **Auth.** Supabase calls use `SUPABASE_SERVICE_ROLE_KEY` (Script Property) as
  both `apikey` and `Authorization: Bearer`, with a custom `User-Agent` so
  Supabase doesn't reject it as a browser request. `SUPABASE_URL` is also a Script
  Property. Never hardcode keys in `Code.gs`.
- **Don't run `onFormSubmit` manually** — it needs the real form-submission event
  object; it throws a helpful error if invoked without one. Test via an actual
  form submission.

## Deploying a change

Edit `Code.gs` here, then paste it over the bound Apps Script project's `Code.gs`
and save. String/comment-only changes (like the julienne→James fix) need no new
Script Property or OAuth scope and no re-authorization.

## Security

- `claude_code_automations_github_fine_grained_personal_access_token.txt` holds a
  live GitHub PAT and is **gitignored** — never stage or commit it. All runtime
  secrets (Supabase key) live in Apps Script Script Properties, never in `Code.gs`.
