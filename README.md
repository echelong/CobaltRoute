# CobaltRoute

**Adaptive free-first AI routing built on OmniRoute, with persistent task learning, quota intelligence, verified multi-model racing, automatic free-model qualification, protocol repair, and hybrid local + cloud execution.**

**Built by Cobalt.**

> CobaltRoute is an independent fork of [OmniRoute](https://github.com/diegosouzapw/OmniRoute), currently based on OmniRoute `3.8.51`. The original upstream README is preserved verbatim as [`UPSTREAM_README.md`](UPSTREAM_README.md). Upstream remains credited under the existing MIT license and notices.
>
> For compatibility with the upstream runtime and packaging graph, internal package/bin identifiers still use `omniroute` in this development line. CobaltRoute branding, routing behavior, docs, release checks, and repository identity are separate; package renaming is intentionally deferred to the final packaging milestone.

## Why CobaltRoute

OmniRoute already provides a large provider catalog, OpenAI-compatible APIs, translation layers, free-tier support, fallback, observability, and a broad gateway surface. CobaltRoute keeps that foundation and adds an opinionated intelligence layer designed around one question:

**Which available model should handle this specific task right now, while spending as little as possible and preserving quality?**

CobaltRoute is free-first by default when explicitly free capacity exists. It learns from outcomes, understands expiring quota, can race a small set of free models, qualifies newly discovered free models before trusting them, repairs common protocol/tool incompatibilities, and can offload suitable work to local models with automatic cloud fallback.

## CobaltRoute intelligence stack

| Milestone | Capability | What it adds |
| --- | --- | --- |
| V1 | Persistent adaptive router | Task-specific `task × provider × model` learning with UCB-style exploration |
| V2 | Router Brain | Automatic outcome learning plus aggregate routing observability |
| V3 | Deterministic coding feedback | Test/build/typecheck/lint/schema/tool/patch outcomes teach the router |
| V4 | Free quota intelligence | Reset-aware free quota treated as expiring inventory |
| V5 | Verified multi-model race | 2–3 free contenders, first verified answer wins, losers are cancelled |
| V6 | Free-model discovery | Newly synced free models enter probation, promote on evidence, quarantine on repeated semantic failures |
| V7 | Protocol compatibility repair | Repairs tool/request/response quirks and learns provider/model incompatibilities |
| V8 | Hybrid local + cloud | Task-aware local offload with free-first cloud fallback and shared adaptive learning |
| V9 | Release hardening | CobaltRoute identity, production presets, deterministic benchmark, and release audit |

## Recommended routing modes

- `auto/hybrid` — recommended general CobaltRoute mode when local/self-hosted models are available.
- `auto/race` — verified free-model race for tasks where parallel attempts are worth the extra free quota.
- `routerStrategy=adaptive` or `routerStrategy=cobalt` — task-aware Cobalt adaptive routing for custom combos.
- Existing OmniRoute strategies remain available for compatibility and comparison.

Router Brain is available at `/dashboard/router-brain` and exposes aggregate-only Cobalt telemetry panels for adaptive outcomes, coding verification, free quota intelligence, race behavior, free-model qualification, protocol compatibility, and hybrid local/cloud routing.

## Quick start from source

```bash
git clone https://github.com/echelong/CobaltRoute.git
cd CobaltRoute
npm install
cp config/cobalt/cobaltroute.env.example .env.cobaltroute
npm run dev
```

The upstream runtime remains the underlying application, so existing OmniRoute installation and provider configuration concepts still apply. See [`UPSTREAM_README.md`](UPSTREAM_README.md) for the full inherited provider/runtime documentation.

## Recommended production preset

Start with [`config/cobalt/cobaltroute.env.example`](config/cobalt/cobaltroute.env.example). The default preset keeps CobaltRoute free-first and enables all V1–V8 intelligence layers while avoiding any embedded credentials.

Three useful policy shapes are documented in [`docs/cobalt/RELEASE_HARDENING.md`](docs/cobalt/RELEASE_HARDENING.md):

- **balanced-free** — recommended default; free-first adaptive + hybrid routing.
- **local-first** — maximize local/self-hosted execution when competitive.
- **cloud-quality** — keep hybrid intelligence but bias toward cloud quality when the local lane is weaker.

## Deterministic routing benchmark

CobaltRoute includes a zero-network benchmark that compares the inherited `rules` baseline against the Cobalt adaptive stack across deterministic policy scenarios:

```bash
DISABLE_SQLITE_AUTO_BACKUP=true \
node --import tsx/esm \
  --import ./open-sse/utils/setupPolyfill.ts \
  scripts/cobalt/benchmark-routing.ts
```

This benchmark measures **routing-policy correctness**, not model intelligence. It does not call external LLMs and should not be presented as a real-world quality benchmark. For replay/evaluation against actual routing observations, use the inherited `npm run eval:router` tooling.

## Release audit

Before a CobaltRoute release or merge candidate:

```bash
node scripts/cobalt/release-audit.mjs
```

The audit checks CobaltRoute identity, required V1–V9 files, production preset coverage, upstream attribution, package-identity compatibility, and repository hygiene including the rule that `AGENTS.md` and `CLAUDE.md` are not tracked.

## Privacy model

CobaltRoute routing telemetry is deliberately aggregate-oriented. The Cobalt intelligence layers are designed not to persist prompts, responses, credentials, endpoint URLs, or connection IDs. Persistent adaptive state stores aggregate task/provider/model outcome statistics only.

## Upstream compatibility and attribution

CobaltRoute does not erase its upstream lineage. OmniRoute remains the base gateway/runtime and retains its license, notices, contributor history, and original documentation. The complete upstream README from the fork base is preserved in [`UPSTREAM_README.md`](UPSTREAM_README.md), while this README documents CobaltRoute-specific behavior.

- Upstream project: https://github.com/diegosouzapw/OmniRoute
- CobaltRoute repository: https://github.com/echelong/CobaltRoute
- License: [MIT](LICENSE)
- Third-party notices: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)

## Development status

CobaltRoute V1–V8 are merged on `main`. V9 is the release-hardening milestone. A final packaging/tag/release audit remains before the project is declared `100%` public-release ready.

**Built by Cobalt.**
