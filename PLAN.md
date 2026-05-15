# ICP Prospector — Product & Technical Plan

This document breaks the vision into phases, proposes a data model and system shape, names integration options, and lists **decisions we need from you** before implementation.

---

## Goals (restated)

1. **ICP → people**: You describe an ideal customer profile (free-form context). Background agents do web research (and optionally LinkedIn-adjacent research) to **discover individuals** who match, with deduplication and progress toward a target count (e.g. “find 100 people”).
2. **Unified people + companies**: One database of people and companies, with **foreign keys**, **contact fields**, and **prospecting state** so agents do not re-prospect the same person.
3. **Learning where discovery works**: Over time, record **which sources / query patterns / workflows** correlate with good leads so the system can prefer them.
4. **Phase 2 — semantic search**: Per-person (and company) **keywords + embeddings** (e.g. OpenAI) for search across the corpus.
5. **Phase 2 — email**: Connect **one or more** email accounts; for selected people, spin up **per-person drafting agents** that read DB context, optionally do more research, and return a **structured draft** (subject + body). The system creates **real drafts in your mailbox** (no auto-send); you review and send manually.

---

## Phased roadmap

### Part 1 — Prospecting core (MVP)

| Area | Scope |
|------|--------|
| **Ingest ICP** | Store “campaigns” or “runs” with raw ICP text + structured knobs (target count, geography, seniority, etc. — exact fields TBD with you). |
| **Agent orchestration** | Job queue + worker(s) that call an LLM with **tools**: web search (Exa and/or others), fetch URL, maybe news/company lookup. **No** mass LinkedIn scraping in MVP unless you explicitly accept compliance risk (see Risks). |
| **People & companies** | Relational schema: `companies`, `people`, link people → company; unique identity to dedupe (see Data model). |
| **Prospecting lifecycle** | States such as `discovered` → `enriched` → `prospected` (or simpler: `candidate` / `qualified` / `deduped_hit` / `archived`). Agent checks DB **before** counting a net-new lead; writes row + audit trail. |
| **“Find N people”** | Orchestrator runs until `qualified_count >= N` or budget/time cap; idempotent so restarts do not double-count. |
| **Source attribution** | Every person (or edge table) records **how** they were found: query string, Exa result ID, URL, agent step ID — feeds “what worked” analytics later. |

### Part 2 — Search, email accounts, draft agents

| Area | Scope |
|------|--------|
| **Embeddings** | Background job: chunk `people.notes`, `people.context`, company description, titles → embeddings table(s); hybrid **keyword + vector** search API. |
| **Email OAuth** | Gmail and/or Microsoft 365 (most teams need both eventually); store refresh tokens securely (vault/KMS — decision). |
| **Draft pipeline** | User selects subset → creates `draft_jobs` → one agent per person (with concurrency limits) → structured output JSON → provider API **create draft** (Gmail: `users.drafts.create`; Graph: create message in drafts folder). |
| **Safety** | Rate limits, opt-out list, “do not contact” flag on `people`, optional human approval gate before draft creation. |

---

## Proposed data model (first pass)

**`companies`**

- `id` (UUID)
- `name`, `domain` (unique where known), `website`, `industry`, `employee_range`, `hq_location`, raw JSON for enrichment payloads
- `created_at`, `updated_at`

**`people`**

- `id` (UUID)
- `company_id` (FK → `companies`, nullable if unknown)
- **Identity / dedupe**: `email` (unique if present), `linkedin_url` (unique if present), or composite `normalized_name` + `company_id` + fuzzy rules (weak — better to anchor on email/LinkedIn URL when available)
- **Contact**: `email`, `phone`, `linkedin_url`, `twitter_url`, etc.
- **Role**: `title`, `seniority`, `department` (optional structured tags)
- **Agent fields**: `notes` (long text), `context` (long text — research dump), `icp_keywords` (text[] or JSON for Phase 2)
- **State machine**: e.g. `lifecycle_status` (`new`, `researched`, `prospected`, `drafted`, `contacted`, `do_not_contact`)
- **Dedup**: `first_seen_campaign_id`, `last_seen_at`
- `created_at`, `updated_at`

**`campaigns`** (or `icp_runs`)

- `id`, `name`, `icp_document` (text/markdown), `target_count`, `status`, `created_by`, timestamps

**`discovery_events`** (audit + “what worked”)

- `id`, `campaign_id`, `person_id` (nullable until resolved), `source_type` (`exa`, `web_fetch`, `manual`, …), `source_query`, `source_url`, `exa_result_id` (if applicable), `agent_trace_id`, `metadata` (JSONB), `created_at`

**`source_effectiveness`** (can start as materialized view / nightly rollup)

- Aggregates from `discovery_events` joined to outcomes (e.g. later `replied`, `meeting_booked` if you add outreach tracking) — **schema TBD** once we define “success.”

**Phase 2 additions**

- `email_accounts` — provider, OAuth tokens (encrypted), display name
- `drafts` — `person_id`, `email_account_id`, `provider_draft_id`, `subject`, `body`, `status`, `agent_run_id`
- `person_embeddings` / `company_embeddings` — `embedding vector`, `model`, `content_hash`, `chunk_index`

---

## System architecture (recommended direction)

High level: **API + Postgres + Redis (or SQL-only queue for MVP) + worker processes**.

1. **Control plane**: REST or tRPC API; creates campaigns, enqueues “find N” jobs, exposes people/company CRUD and search (Phase 2).
2. **Agent workers**: Stateless processes pulling jobs; each job has **tool access** (Exa HTTP API, `fetch`, optional others). LLM calls are logged with **run IDs** tied to `discovery_events`.
3. **Deduplication**: On candidate person, worker runs **UPSERT** / uniqueness check on strong keys (email, LinkedIn URL) before incrementing campaign progress.
4. **“Already prospected”**: Before deep research, lightweight DB read; if `lifecycle_status` indicates done, agent skips to next hypothesis.

**Stack (suggestions — not locked)**

- **Backend**: Node (TypeScript) + Fastify/Hono *or* Python + FastAPI — pick based on your comfort and email SDK maturity (Google/Microsoft client libs exist for both).
- **DB**: Postgres (pgvector in Phase 2 for embeddings).
- **Frontend** (later): React + your UI kit; for MVP even a **Retool / admin API** could suffice.

---

## Integrations

| Integration | Role |
|-------------|------|
| **Exa** | Semantic/neural search over the web; great for “companies like X” and “people writing about Y.” |
| **OpenAI (or similar)** | Planner + tool-calling agent; embeddings in Phase 2. |
| **Clearbit / Apollo / etc.** (optional) | If you want **higher hit rate on email/phone** without agents guessing — often worth it for B2B; cost + compliance tradeoff. |
| **Gmail / Microsoft Graph** | OAuth, draft creation (Phase 2). |
| **LinkedIn** | **Do not** rely on unofficial scraping for a serious tool; ToS and legal risk. Prefer: public web mentions, company sites, conference speaker pages, podcasts, Exa — and optional **manual** LinkedIn URL paste or **official** partner flows if you later qualify for them. |

---

## Agent design notes

**Prospecting agent**

- Inputs: ICP text, `campaign_id`, remaining quota, exclusion lists.
- Tools: `exa_search`, `fetch_url`, `normalize_company`, `upsert_person` (validates required fields), `log_discovery_event`.
- Output: Structured tool calls only (no free-form “I found someone” without DB write) to keep the pipeline auditable.

**Drafting agent (Phase 2)**

- Inputs: `person_id`, style guide (your voice), constraints (length, no false claims).
- Tools: read DB, optional `exa_search` / `fetch_url`, `submit_draft` tool returning `{ subject, body_html or body_text }`.
- Post-process: Server creates provider draft; stores row in `drafts`.

---

## Open questions for you

Answer these when you can — they drive schema and MVP scope.

### Product

1. **Primary user**: Just you, or a small team with roles (admin vs researcher)?
2. **“100 people” definition**: Must every row have **verified email**, or is “strong LinkedIn + company” acceptable for v1 with email TBD?
3. **Geography & compliance**: US-only first, or global? Any regulated industries (health, finance) affecting messaging retention?
4. **Success metric for “sources that worked”**: Reply rate, meeting booked, subjective star rating, or “accepted into CRM”?

### Technical

5. **Email provider for Phase 2**: Gmail only, Microsoft only, or **both** from day one of email work?
6. **Hosting**: Local-first (Docker on your machine), or deployed (Fly.io, Railway, AWS)?
7. **Secrets**: OK to use a cloud KMS / Vault, or keep everything in `.env` for personal MVP?
8. **Agent hosting**: Same process as API workers, or separate **Cursor Agent / external** runner that only talks to your API? (You mentioned agents “behind the scenes” — clarifying this avoids a wrong integration.)

### Legal / ethics

9. **Cold email jurisdiction**: Are you targeting regions with strict cold-email rules (e.g. parts of EU/UK)? That affects consent fields and suppression lists.
10. **Data retention**: How long should raw agent traces and `discovery_events` be kept?

---

## Risks & guardrails

- **LinkedIn**: Automated profile scraping is high-risk; plan MVP around **public** sources + optional enrichment vendors with terms of use you accept.
- **Accuracy**: Agents hallucinate contacts; enforce **source URL** per fact and human-review-friendly exports.
- **Rate limits**: Exa, OpenAI, and email APIs all need backoff and per-tenant quotas.
- **Duplicate people**: Invest early in **canonical identifiers** (domain + email strongest).

---

## Suggested implementation order (after you answer questions)

1. Repo skeleton: API, Postgres migrations, Docker Compose for local Postgres.
2. Schema: `companies`, `people`, `campaigns`, `discovery_events`.
3. Single “prospect run” worker with Exa + fetch + structured upsert.
4. CLI or minimal UI: create campaign, set N, watch progress.
5. Analytics view: top queries / URLs by accepted leads.
6. Phase 2 branch: pgvector, OAuth email, draft jobs, Gmail draft creation.

---

## Next step

Reply to the **Open questions** section (even briefly). With those answers, the next planning iteration can lock **MVP schema**, **provider choices**, and **the first vertical slice** (e.g. “ICP text → 10 deduped people with sources in DB” end-to-end).
