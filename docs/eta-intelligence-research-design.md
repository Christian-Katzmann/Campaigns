# ETA Intelligence — Research Design

**Question:** How do we use historical campaign data to produce *useful, reliable ETA ranges* for future steps, phases, and campaigns — good enough for Christian to decide "do I have time for laundry / VR boxing / a workout while the AI runs?"

**Stance:** Estimate **bottom-up from steps** (lots of data), report **ranges + confidence** (never a single number), and **reuse the existing ledger** (`read-past-campaigns.py` + `state.json`). No new source-of-truth storage, no parametric models, no giant taxonomy until the data earns it.

This is a research *design*. It tells the swarm what to extract, how to tag, how to estimate, how to improve, and how to divide the work. It does not build UI or app code.

---

## 0. The core reframe: there are three clocks (read this first)

The biggest mistake would be to estimate "campaign wall-clock time." That number is dominated by Christian being asleep. Separate three things:

| Clock | Definition | Behaviour | Use it for |
|---|---|---|---|
| **Step active time** | Agent actually working on one step | **Most stable unit.** Right-skewed. The modeling primitive. | The atom every estimate is built from |
| **Inter-step / inter-phase gap** | Time between one step finishing and the next starting | **Bimodal:** ~90s automated relaunch *or* hours (cooldown deferral, overnight, paused) | Run-window vs calendar split |
| **Calendar span** | First event → last event | Gap-dominated. A 6-step run in the corpus spanned **a week**. | Almost nothing for planning |

Two derived outputs, and they answer different questions:

- **Run-window-to-next-boundary** *(the laundry question)* — remaining step active times **+ short automated gaps only**, assuming it runs uninterrupted from now. This is the headline ETA and what maps to the planning buckets.
- **Calendar completion** *(a different question)* — when the whole thing is actually done given the schedule. Only answerable from `rrule` / `schedule_mode` / `cooldown_deferrals` (all in `state.json`). Out of scope for "laundry vs workout"; report separately, flagged.

**Empirical resolution of "separate active from wall-clock":** I measured it. For Codex, `duration_ms` (runner-measured active) ≈ paired `step_completed − step_started` wall-clock (medians 6.5 vs 6.8 min). So **within-step idle is negligible** — the active/wall gap does *not* live inside steps. It lives **between** them. That means we don't need fancy active-time mining; we need honest **gap accounting**. This is the single most important finding for the whole design.

### Ground-truth signal that exists (measured across the full corpus)

| | Runs | Runs with usable per-step timing | Timed steps | Step wall-clock: median / p75 / p90 / max (min) |
|---|---|---|---|---|
| **Claude** | 101 | **97** (`started_at`→`completed_at`) | 664 | 12.9 / 18.1 / 23.6 / **393** |
| **Codex** | 60 | **17** pairable + **18** with `duration_ms` | 170 events, 78 pairable | 6.8 / 9.7 / 11.5 |
| **Combined** | 161 | **114** | **742** | — |

Three facts that drive every decision below:

1. **Backend is a first-order covariate.** Claude steps run ~**2×** longer than Codex (12.9 vs 6.8 median). Never pool them. This is proven, not assumed.
2. **Heavy right skew** (Claude max 393 min = 6.5h). Use **median / p75 / p90**, never mean. The long tail is mostly rework loops, not slow steps → bands must be **asymmetric**.
3. **742 timed steps is plenty for step-level estimation; 114 runs is thin for campaign-level.** So estimate steps confidently and roll up — don't model whole campaigns top-down.

---

## 1. What historical data to extract

Extend `~/.claude/skills/campaign-planner/bin/read-past-campaigns.py`. It already discovers both backends (Claude: `~/.claude-automate/campaigns/<slug>/state.json`; Codex: via the Campaigns registry → `<repo>/reports/campaign-automation/<slug>/state.json`) and already pulls Claude `median_step_min`. We add the timing rows and **stop hardcoding Codex `median_step_min = None`.**

Emit three flat record types to a single `eta-rows.json` (research artifact; the helper keeps emitting its existing summary):

**Per step** (the unit that matters most)
- `slug, backend, model, reasoning_effort` (Codex), `model_tier` (Claude — per-step!)
- `step_id, phase, phase_name, step_name`
- `step_active_min`:
  - Claude: `completed_at − started_at`
  - Codex: `duration_ms / 60000` when present, else `step_completed.ts − step_started.ts` paired by `step_id`
- `step_wall_min`: Codex paired `ts` delta; for Claude this equals active (only one timestamp pair exists)
- `outcome`: `done | failed | reworked`
- **A-priori weight features** (computable *before* the step runs — see §2): `prompt_len`, `required_reading_n`, `acceptance_criteria_n`, `files_named_n`, `has_verify_requirement`, `phase_position`
- **Runtime features** (research/validation only, *not* used for forward prediction): `tool_calls_n`, `patch_events_n` (Codex `step_failed`/`step_completed` literally report "34 tool call(s), 5 patch event(s)"), `had_rework`

**Per gap**
- `gap_min = next.step_started.ts − this.step_completed.ts`
- `gap_class`: `automated` (short relaunch) vs `idle` (deferred / overnight / paused) — using `chain_deferred`, `cooldown_deferrals`, `schedule_mode`, `fast_chain_delay_minutes`, and a learned threshold (§6/A4)

**Per campaign**
- `step_count, phase_count`
- `total_active_min` (Σ step active), `run_window_min` (Σ active + automated gaps), `calendar_span_min` (last − first event)
- schedule fields: `rrule, schedule_mode, fast_chain_delay_minutes, cooldown_deferrals`
- `verdict, reasons[], first_try, rework_count, recover_count, halted` (helper already derives these)

---

## 2. How to classify / tag past and future steps

**The binding constraint:** a tag must be derivable from an *unstarted* step's markdown, not just from a finished run. A tag you can only compute after the fact cannot forecast. So tags come from the **step definition in the campaign markdown** + cheap metadata — never from runtime behaviour.

**Tag = `backend × model` (mandatory, proven 2× lever) + `step_kind` (to be discovered).**

Candidate `step_kind` values, inferred from step name/prompt verbs (the prompt is in `state.json`): `scaffold/setup`, `implement/build`, `refactor`, `test/verify`, `review`, `fix/rework`, `docs`, `research/investigate`, `design/ui`, `data/migration`, `integration`. **This list is a starting hypothesis, not the answer** — §3 discovers the real set.

Within a cell, the a-priori weight features (`prompt_len`, `required_reading_n`, `acceptance_criteria_n`, …) nudge the estimate up or down (a long-prompt implement step → lean toward p75). Runtime features (`tool_calls_n`, `patch_events_n`, `had_rework`) are used **only** to *validate* that the a-priori tags actually separate the duration distributions — never as live inputs, because you don't have them before the step runs.

---

## 3. How many tags / categories — and how to discover them

Constraint: **no giant taxonomy; avoid overfitting.** A category earns its existence only if it clears two bars:

1. **Sample bar:** ≥ ~8–10 steps in the cell.
2. **Separation bar:** its median differs meaningfully from its parent pool (>1.5× or enough to shift a planning bucket).

Otherwise it **collapses up the hierarchy.** Discovery procedure:

1. Cluster step durations (per backend, since backend dominates).
2. Label each cluster by reading the step names/prompts that fell in it → candidate `step_kind`s.
3. Test whether an **a-priori rule** (verbs + weight features) reproduces the clustering on held-out steps. Keep only the granularity that still predicts out-of-sample.

Expected outcome: **~3–6 step-kinds × 2 backends ≈ a handful of cells**, most backed by the 742 steps. Realistic prior: backend split is essential; step-kind probably collapses to a coarse 3–4 (e.g. *light* {docs, review, verify} / *build* {implement, refactor, integration} / *heavy* {scaffold, data-migration, multi-file}). Let the data decide; don't ship more cells than the data supports.

**Hierarchical fallback** (this is also the confidence mechanism): `cell (backend×kind)` → `backend` → `global`. Always estimate from the deepest cell that clears the sample bar.

---

## 4. How to estimate

All estimators are **empirical-quantile lookups** over the rows — no curve fitting. Every output is `(low_min, median_min, high_min, primary_bucket, confidence)`. Bands are asymmetric (right tail wider).

**Buckets** (snap the band to these; the median picks the primary):
`micro 3–8` · `short 10–20` · `medium 25–45` · `long 60–90` · `deep 2h+`

Where typical work lands (from real medians):
- One Codex step ≈ 7 min → **micro**. One Claude step ≈ 13 min → **short**. → *"mid-step, how long till I can check?"* is usually micro/short — the most common question.
- A 2–4 step phase → **short/medium**. Remaining campaign → **medium → deep**.

### Step duration
Look up the step's cell → `(median, p75, p90)`. Fall back up the hierarchy if sparse. Apply within-cell nudge from weight features. Return active minutes (≈ wall at step level, per §0). → snap to bucket.

### Phase duration *(the subtle one)*
Two methods; **backtest both and keep the winner per backend:**
- **(A) Sum of steps** + `(n−1) ×` automated-gap budget. Caveat: **medians don't add** — summing medians underestimates the center slightly and the tail badly.
- **(B) Measured phase wall-clock** quantiles, where ≥ N phases exist.

Default: center = Σ step medians + gap budget; **high end via quadrature** (`√Σ per-step variance`) or method (B)'s p90, whichever backtests better. Always add the explicit inter-step gap budget — it's real time Christian waits.

### Multiple remaining phases / full campaign (run-time)
Σ remaining phase estimates + inter-phase gaps. **Don't add p90s** (they won't all hit p90 — too pessimistic). Center = Σ medians + gaps; band via a cheap **local Monte-Carlo**: sample each remaining step from its cell's empirical distribution a few thousand times, read off p25 / p50 / p90 of the sum. This honestly captures the tail and is trivial locally. Report `[optimistic, likely, pessimistic]`.

### Full campaign (calendar) — separate output
`run-time × schedule adjustment`. If `schedule_mode = fast-chain` → calendar ≈ run-time. If scheduled/deferred → calendar = next slots from `rrule`; flag as schedule-dependent, not a planning window.

### Rework / review risk
The helper already gives `approval_rate`, `first_try_rate`, `rework_rate` per backend + reason tags. Model rework as an **expected-time add**: `P(rework) × (review + rework-loop duration)`. `P(rework)` from `backend × reason-tag` base rates (× step-kind if it separates). **This is why the band is asymmetric** — the long tail is rework loops, not slow steps. Surfaces as a widened high end + an optional "≈X% chance it needs a rework loop (+Y min)" note.

### Confidence level
A 3-level label driven by: (a) sample size in the matched cell, (b) IQR spread, (c) how far down the fallback hierarchy we went.
- **High** = cell-level match, n ≥ N, tight IQR.
- **Medium** = backend-level fallback or moderate spread.
- **Low** = global fallback or n < small.
Render as **band width + label**. Never a bare number. This *is* the honest-low-sample handling the constraints demand.

---

## 5. How estimates improve over time

- **Append → re-quantile.** The estimator is a lookup over ledger rows. New runs append rows → quantiles shift automatically. **No retraining.** This is the local-first, reuse-the-ledger payoff.
- **Compute on read** (helper already runs on demand) or cache the quantile tables in `eta-model.json` (a *cache*, refreshed when new runs land — not new source-of-truth).
- **Closed calibration loop** (the one genuinely new piece of state, kept minimal): log `predicted vs actual` per finished step → track per-cell calibration error → if a cell systematically over/under-predicts, store a per-cell correction multiplier. Signal = actual; reference = predicted; comparator = ratio; correction = multiplier; cadence = per completed step. Also validates coverage: *does the p90 actually contain 90% of actuals?*
- **Cold start:** lean on the hierarchy + wide bands; narrow as cells fill.
- **Later, not now (flag only):** recency weighting — models keep getting faster, so weight recent runs more. Don't build until drift is visible.

---

## 6. How a small agent swarm divides the work

Read-only research. One barrier, then parallel, then synthesis. **(Designed here; not launched — running it is a separate, opt-in step.)**

```
A1  ── barrier ──►  A2 ┐
                    A3 ├─ parallel ─►  A6  (synthesize + critique)
                    A4 │
                    A5 ┘
```

- **A1 — Extractor / schema** *(long pole; everyone depends on it)*: extend `read-past-campaigns.py` to emit the per-step / per-gap / per-campaign rows for **both** backends; produce `eta-rows.json`. Kill the `median_step_min = None` for Codex.
- **A2 — Taxonomy / tagger**: from A1's rows, cluster + label step-kinds, test a-priori predictability, recommend the **minimal** taxonomy and the classification rules (§2/§3).
- **A3 — Estimator / backtest**: build the quantile-lookup + Monte-Carlo; **leave-one-out backtest** at step / phase / campaign level; report accuracy and calibration (p90 coverage); tune bucket thresholds.
- **A4 — Gap & schedule analyst**: characterize automated vs idle gaps; define the idle-exclusion threshold; deliver the **run-window vs calendar** numbers and the schedule-mode adjustment.
- **A5 — Risk / rework analyst**: base rates of rework / halt by `backend × reason × step-kind`; the expected-time-add model; the asymmetric-band rule.
- **A6 — Synthesizer / critic**: merge into one spec; enforce sample-size honesty; **delete overfit tags**; finalize confidence labels; write the integration contract (what the helper outputs; what the app would later consume).

---

## Constraints honored / explicit non-goals

**Honored:** simple (quantile lookups, no ML) · local-first · reuses `read-past-campaigns.py` + `state.json` (only new state = a tiny calibration log + a cache) · no taxonomy without earned cells · median/p75/p90 over averages · low samples handled by hierarchy + wide bands + confidence labels · active vs wall-clock resolved empirically (gaps, not steps) · phase time both summed *and* measured, decided by backtest.

**Non-goals:** stopwatch precision · per-step active-time mining from session logs (unnecessary — §0) · modeling overnight/calendar gaps as "work time" · any UI or app code · launching the swarm (this doc defines it).

**Success test:** for a step or phase about to run, the system returns a bucket + asymmetric range + confidence that, on backtest, has its p90 actually contain ≥90% of real outcomes — accurate enough that "laundry vs workout" is the right call ≥ most of the time, and honestly wide when the data is thin.
