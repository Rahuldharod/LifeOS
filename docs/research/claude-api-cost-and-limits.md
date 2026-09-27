# Claude API cost and limits for LifeOS workloads

- **Ticket:** #2 (map: #1)
- **Researched:** 2026-09-27, against primary Anthropic docs (links in [Sources](#sources))
- **Status:** Research complete. Token counts are estimates until measured (see [Open items](#open-items-tbd)).

---

## Bottom line

| Question | Answer |
|---|---|
| Monthly cost at Rahul's volume | **About $2 to $55 a month**, depending on model and usage. Recommended setup: **about $10 a month** (range $4 to $23). |
| Biggest cost driver | Meeting processing: about 50% of spend. Transcripts are the main input. |
| Prompt caching | **Saves little** in LifeOS (at most about 9% of spend). Calls are hours apart, so a 5-minute cache has usually expired before the next call. It is worth using only for follow-up questions on the same meeting. |
| Batch API | **Halves** the cost of any job that can wait (most finish in under 1 hour, up to 24 hours). Saves about $4 to $8 a month. It is the only cost lever that matters, but results are not immediate. |
| Rate limits | **Not a constraint.** The lowest standard tier allows 1,000 requests a minute. LifeOS needs about 15 requests a day. The real guardrail is the **monthly spend cap** ($500 on the Start tier). Set your own lower cap. |
| Training on your data | **No**, by default under the Commercial Terms. Inputs and outputs are deleted within 30 days (Batch results: 29 days). No EU data residency option exists. |
| Real blocker | **Not cost.** It is whether Eagle Eye policy allows work meeting transcripts to go to a personal Anthropic API account. `[TBD — needs input from Rahul]` |

**So what:** cost is too small to drive the architecture. Pick models on quality and latency, set a spend cap, and settle the employer-data question before any real transcript is sent.

---

## 1. Current models and prices

Source: [Pricing](https://platform.claude.com/docs/en/about-claude/pricing), [Models overview](https://platform.claude.com/docs/en/about-claude/models/overview). Prices are USD per million tokens (MTok).

| Model | API ID | Input | Output | Cache write (5 min) | Cache read | Batch in / out | Context |
|---|---|---|---|---|---|---|---|
| Claude Opus 5.5 | `claude-opus-5-5` | $4 | $20 | $5 | $0.20 | $2 / $10 | 1M |
| Claude Sonnet 5 | `claude-sonnet-5` | $2 | $10 | $2.50 | $0.20 | $1 / $5 | 1M |
| Claude Haiku 4.5 | `claude-haiku-4-5` | $1 | $5 | $1.25 | $0.10 | $0.50 / $2.50 | 200K |
| Claude Fable 5.1 (top tier) | `claude-fable-5-1` | $10 | $50 | $12.50 | $0.25 | $5 / $25 | 1M |

Points that affect LifeOS:

- **Sonnet 5 pricing is permanent.** $2/$10 started as launch pricing. The planned rise to $3/$15 on 2026-09-01 was cancelled.
- **Opus 5.5 always thinks.** Thinking tokens are billed as output. The default effort is `medium`. Lowering effort is the only way to reduce thinking.
- **Newer tokenizer.** Claude 4.7 and later models count about 30% more tokens for the same text than older models. Haiku 4.5 uses the older tokenizer, so its real token counts come out a little lower than the estimates below.
- **Haiku 4.5 retirement date.** Listed as "not sooner than October 15, 2026", with at least 60 days' notice ([Model deprecations](https://platform.claude.com/docs/en/about-claude/model-deprecations)). It is not deprecated yet, but keep the model ID configurable.
- **Fable 5.1 does not suit this workload.** It costs 2.5x Opus 5.5 and must keep data for 30 days (no zero-retention option).
- **US-only inference** (`inference_geo: "us"`) adds 10% to all prices. The default (`global`) has no surcharge.

---

## 2. Token assumptions per operation

These are estimates, not measurements. "Output" includes thinking tokens at low or medium effort.

| Operation | What is sent | Input tokens (low / typical / high) | Output tokens (low / typical / high) | Monthly volume (low / typical / high) |
|---|---|---|---|---|
| **Process a meeting** | System prompt and output format (1.5K), people/project context (1K), free-form note (1–3K), transcript (8–15K for 30–60 min) | 11K / 16.5K / 20K | 2K / 3.5K / 5K (summary, decisions, tasks, open points, plus thinking) | 65 / 87 / 108 (15 / 20 / 25 meetings a week × 4.33) |
| **Daily Top 3** | System prompt (1.5K), open tasks and today's meetings (4–15K) | 5.5K / 9.5K / 16.5K | 1K / 2K / 3K | 22 / 30 / 30 |
| **Raw source → Knowledge Note** | System prompt (1.5K), source text (2–20K) | 3.5K / 7.5K / 21.5K | 1.5K / 3K / 5K | 10 / 40 / 80 `[TBD]` |
| **Quick Capture extraction** | System prompt (1.5K), capture text (~0.3K), context (~1K) | 2K / 2.8K / 4K | 0.4K / 0.8K / 1.2K | 60 / 200 / 400 `[TBD]` |

Rule of thumb: 1 token is about 0.75 English words. A 45-minute meeting transcript is about 6–8K words, which is about 10–13K tokens on the new tokenizer.

---

## 3. Cost per operation

Calculation: input tokens × input price + output tokens × output price. Standard (real-time) API, no caching.

| Operation | Opus 5.5 | Sonnet 5 | Haiku 4.5 |
|---|---|---|---|
| Process a meeting (typical) | **$0.136** (range $0.08–0.18) | **$0.068** (range $0.04–0.09) | **$0.034** (range $0.02–0.05) |
| Daily Top 3 | $0.078 | $0.039 | $0.020 |
| Knowledge Note | $0.090 | $0.045 | $0.023 |
| Quick Capture | $0.027 | $0.014 | $0.007 |

---

## 4. Monthly cost range

| Scenario | Opus 5.5 everywhere | Sonnet 5 everywhere | Haiku 4.5 everywhere | **Recommended mix** (Sonnet 5, with Haiku for Quick Capture) |
|---|---|---|---|---|
| Low (15 meetings a week, light use) | $7.80 | $3.90 | $1.95 | **about $3.60** |
| **Typical (20 meetings a week)** | **$23.20** | **$11.60** | **$5.80** | **about $10.25** |
| High (25 meetings a week, heavy capture and notes) | $54.10 | $27.05 | $13.50 | **about $23** |
| Typical, with meetings and notes sent via Batch | $15.50 | $7.75 | $3.90 | about $6.40 |

Typical Sonnet 5 split: meetings $5.92, Quick Capture $2.72, Knowledge Notes $1.80, Top 3 $1.17.

**Headroom:** adding follow-up questions and reprocessing (say 2x the typical volume) keeps the recommended mix under about $25 a month. Even Opus 5.5 at 2x the high scenario (about $110) stays well under the $500 Start-tier cap.

---

## 5. Prompt caching and the Batch API

### Prompt caching ([docs](https://platform.claude.com/docs/en/build-with-claude/prompt-caching))

| Fact | Value |
|---|---|
| Write cost | 1.25x input price (5-min cache), 2x (1-hour cache) |
| Read cost | 0.1x input price (0.05x on Opus 5.5) |
| Minimum prompt length that can be cached | 512 tokens (Opus 5.5), 1,024 (Sonnet 5), **4,096 (Haiku 4.5)** |
| Scope | Per organization and per workspace; never shared across organizations |

**Why caching saves little here:**

1. **The only content every call shares is the system prompt (~1.5K tokens).** Even if every call hit the cache, the saving is about $1 a month on Sonnet 5 and $2 on Opus 5.5.
2. **Calls are far apart.** Meetings happen hours apart, so a 5-minute cache has usually expired. A 1-hour cache costs 2x to write and needs 2 reads to pay back.
3. **Haiku cannot cache a 1.5K system prompt**, because its minimum is 4,096 tokens.

**Where caching does pay off:** follow-up questions on a meeting you just processed ("what did X commit to?"). Cache the transcript for 5 minutes. A follow-up then costs **$0.014 instead of $0.043** on Sonnet 5 (about 67% less).

### Batch API ([docs](https://platform.claude.com/docs/en/build-with-claude/batch-processing))

| Fact | Value |
|---|---|
| Discount | 50% on input and output |
| Latency | Most batches finish in under 1 hour. A request expires if it is not done in 24 hours (expired requests are not billed). |
| Results kept | 29 days, then deleted |
| Combines with caching | Yes, but cache hits are best effort (the docs report 30–98% hit rates) |
| Zero-retention eligible | **No.** Batch jobs are stored. |

**Fit for LifeOS:** good for an "end-of-day, process all meetings" job or bulk Knowledge Note imports. Bad for "I just left the meeting and want my tasks now." The saving is a few dollars a month, so offer Batch as an option, not the default.

---

## 6. Rate limits and spend caps (single user)

Source: [Rate limits](https://platform.claude.com/docs/en/api/rate-limits).

| Tier | Monthly spend cap | Opus 5.5 / Sonnet 5 / Haiku 4.5 limits |
|---|---|---|
| Start | $500 | 1,000 requests/min, 2M input tokens/min, 400K output tokens/min (each model) |
| Build | $1,000 | 5,000 requests/min, 5M input tokens/min, 1M output tokens/min |
| Scale | $200,000 | 10,000 requests/min, 10M input tokens/min, 2M output tokens/min |

- **LifeOS peak load** is about 5 requests in a minute and about 100K tokens (for example, a burst of reprocessing). That is under 5% of the Start tier.
- **New organizations** may start in a lower "Evaluation" tier while they build history. Limits rise automatically. Exact numbers are not published `[TBD]`.
- **Cached reads do not count** toward the input-tokens-per-minute limit on current models.
- **Hitting the spend cap:** requests return HTTP 429 with `error_code: enforced_spend_limit_reached` and no `retry-after` header, so retrying will not help. LifeOS should show a clear "AI budget reached" state instead of retrying.
- **Your own spend limit** (set in Console → Billing) returns HTTP 400 when reached. **Recommendation: set it to $30 a month.**
- **Batch API limits** are separate: 1,000 requests/min and 200,000 queued requests on the Start tier. Not a concern.

---

## 7. Data retention and training (sending employer work data)

| Topic | What Anthropic's terms say | Source |
|---|---|---|
| Training | "Anthropic may not train models on Customer Content from Services." Exception: feedback you send explicitly, or programs you opt into. | [Commercial Terms](https://www.anthropic.com/legal/commercial-terms), [Privacy Center](https://privacy.claude.com/en/articles/7996868-is-my-data-used-for-model-training) |
| Ownership | The customer keeps rights to inputs and owns outputs | [Commercial Terms](https://www.anthropic.com/legal/commercial-terms) |
| Standard retention | API inputs and outputs are deleted within 30 days | [Privacy Center](https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data) |
| Flagged content | Up to 2 years (inputs and outputs), even under zero retention | [API and data retention](https://platform.claude.com/docs/en/manage-claude/api-and-data-retention) |
| Batch / Files API | Batch results: 29 days. Files: kept until deleted. Neither can be zero-retention. | same |
| Prompt caching | Can be zero-retention. The cache is held in memory for its lifetime only. | same |
| Zero data retention (ZDR) | Available only by arrangement with Anthropic sales, per organization. Fable 5.x must keep data 30 days. | same |
| Data Processing Addendum | Included in the Commercial Terms automatically | [Commercial Terms](https://www.anthropic.com/legal/commercial-terms) |
| Where data is processed | Inference runs `global` (default) or `us`. Data at rest is stored in the US only. **No EU option.** | [Data residency](https://platform.claude.com/docs/en/manage-claude/data-residency) |
| Who may agree to the terms | An individual cannot accept on behalf of a company without authority to bind it | [Commercial Terms](https://www.anthropic.com/legal/commercial-terms) |

**Implications for sending Eagle Eye data:**

1. **Anthropic's side is acceptable for most B2B uses:** no training, 30-day deletion, DPA included. That is the same basic posture as a typical SaaS vendor.
2. **The open risk is on the employer side, not Anthropic's.** A personal API account would send Eagle Eye client names, deal details and colleagues' personal data (names, opinions in transcripts) to a vendor Eagle Eye may not have approved. Under GDPR this is Eagle Eye's decision, not Rahul's. `[TBD — needs input from Rahul: does Eagle Eye's AI/acceptable-use policy allow this? Is there a company Anthropic org, Bedrock or Vertex account to use instead?]`
3. **EU residency:** with no EU inference or storage on the first-party API, data transfers to the US. If Eagle Eye requires EU processing, Claude on **Google Cloud Vertex AI or Amazon Bedrock** with EU regional endpoints (10% surcharge) is the route. `[TBD — confirm EU region availability for the chosen model]`
4. **Design consequence:** keep LifeOS's AI provider behind its existing adapter. Default work meetings to "do not send" until policy is confirmed. Do not use the Batch or Files APIs for work data, because both keep data longer.

---

## 8. Recommendation

### Options

| Option | Monthly (typical) | Pros | Cons |
|---|---|---|---|
| **A. Opus 5.5 everywhere** | ~$23 | Best extraction quality; one model | 2x cost; slower; always thinks (more output tokens) |
| **B. Sonnet 5 everywhere, Haiku 4.5 for Quick Capture** | ~$10 | Strong quality at half the price; fast; Haiku keeps capture near-instant | Two models to test; Haiku's retirement date needs watching |
| **C. Haiku 4.5 everywhere** | ~$6 | Cheapest; fastest | Weaker at pulling decisions and commitments from long, messy transcripts; cannot cache short prompts; retirement date not far off |
| **D. Option B, with meetings processed via Batch** | ~$6.40 | Lowest cost for good quality | Results up to 1 hour later (up to 24h at worst); data kept 29 days |

### Recommended: Option B

1. **Default** `claude-sonnet-5` for meeting processing, Top 3 and Knowledge Notes. Use `claude-haiku-4-5` for Quick Capture.
2. **Add a per-meeting "high quality" toggle** that switches to `claude-opus-5-5` for important client meetings. At about $0.14 per meeting this is cheap insurance.
3. **Keep model IDs in config**, not code (because of the Haiku retirement date and frequent new releases).
4. **Make Batch opt-in** ("process tonight") for personal content only, not work data.
5. **Cache the transcript** only for follow-up questions on a meeting.
6. **Set a $30/month spend limit** in Console, and handle HTTP 429 `enforced_spend_limit_reached` in the UI.
7. **Log `usage` from every response** (input, output and cache tokens) so these estimates can be replaced with real numbers after 2 weeks.

**Why this is enough:** on quality, cost is a rounding error: the gap between the best and cheapest reasonable setup is about $15 a month. Put the effort into the employer-data decision instead. That decision could require changing the provider route (to Bedrock or Vertex EU), and changing routes costs more than any model choice.

---

## Open items `[TBD]`

| Item | Needed from | Why it matters |
|---|---|---|
| Eagle Eye policy on sending work transcripts to a third-party AI via a personal account | Rahul (IT / DPO / manager) | Could block work-data use entirely, or require a company account or EU route |
| Real token counts per operation | Measure with `count_tokens` or logged `usage` on 5–10 real meetings | Replaces the estimates in §2–4 |
| Knowledge Note and Quick Capture monthly volumes | Rahul | These are the least certain inputs |
| Thinking-token overhead at `low` vs `medium` effort | Measure | Could move output cost by ±50% |
| Evaluation-tier starting limits for a new organization | Console after signup | Not published; unlikely to matter at this volume |
| EU-region availability of Sonnet 5 / Opus 5.5 on Vertex or Bedrock | Vertex / Bedrock docs | Only if EU residency is required |

---

## Sources

- Pricing (models, caching, batch, data residency, tokenizer note): https://platform.claude.com/docs/en/about-claude/pricing
- Models overview (IDs, context, default effort): https://platform.claude.com/docs/en/about-claude/models/overview
- Model deprecations (retirement dates): https://platform.claude.com/docs/en/about-claude/model-deprecations
- Rate limits and spend caps: https://platform.claude.com/docs/en/api/rate-limits
- Prompt caching (minimum lengths, TTL, isolation): https://platform.claude.com/docs/en/build-with-claude/prompt-caching
- Batch processing (latency, 29-day results, cache hit rates): https://platform.claude.com/docs/en/build-with-claude/batch-processing
- API and data retention (ZDR, feature eligibility, flagged content): https://platform.claude.com/docs/en/manage-claude/api-and-data-retention
- Data residency (inference and workspace geo): https://platform.claude.com/docs/en/manage-claude/data-residency
- Commercial Terms of Service: https://www.anthropic.com/legal/commercial-terms
- Privacy Center, training on commercial data: https://privacy.claude.com/en/articles/7996868-is-my-data-used-for-model-training
- Privacy Center, commercial data retention: https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data
