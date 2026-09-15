# CobaltRoute V9 — Release Hardening

Built by Cobalt.

This document defines the release-facing contract for the CobaltRoute fork. It deliberately avoids renaming upstream runtime/package internals during V9 so that the inherited OmniRoute build graph, CLI entrypoints, workspace imports, and release tooling remain stable.

## Identity contract

CobaltRoute is the product/repository identity. OmniRoute remains the upstream runtime foundation and must remain credited.

During V9:

- Repository identity: **CobaltRoute**.
- Public Cobalt documentation: **CobaltRoute-first**.
- Upstream lineage: explicitly preserved and linked.
- Internal package name/bin names: remain `omniroute` for compatibility.
- Final package/tag naming: deferred to the final packaging milestone.
- Cobalt-specific source/docs should carry `Built by Cobalt.` naturally.
- `AGENTS.md` and `CLAUDE.md` must not be tracked in this fork.

## Production policy presets

All presets assume the existing provider credentials/configuration are supplied through the inherited OmniRoute mechanisms. The Cobalt preset file never contains secrets.

### balanced-free — recommended

Use the values in `config/cobalt/cobaltroute.env.example` unchanged.

Purpose:

- free-first whenever explicitly free capacity exists,
- adaptive task learning enabled,
- reset-aware quota intelligence enabled,
- free-model probation/qualification enabled,
- protocol compatibility repair enabled,
- bounded verified racing enabled,
- local/cloud hybrid routing enabled with balanced policy.

Recommended routing entrypoint: `auto/hybrid`.

### local-first

Start from the recommended preset and set:

```text
COBALTROUTE_HYBRID_POLICY=local-first
```

Optionally add custom OpenAI-compatible local provider IDs:

```text
COBALTROUTE_LOCAL_PROVIDER_IDS=openai-compatible-home,my-lan-model
```

Only use IDs that truly point to local/self-hosted capacity. CobaltRoute intentionally does not persist endpoint URLs in hybrid telemetry.

### cloud-quality

Start from the recommended preset and set:

```text
COBALTROUTE_HYBRID_POLICY=cloud-first
```

This does **not** disable free-first. When `COBALTROUTE_FREE_ONLY=1`, paid candidates still cannot bypass an available explicitly free lane just because cloud-first is selected.

## Routing benchmark

Run:

```bash
DISABLE_SQLITE_AUTO_BACKUP=true \
node --import tsx/esm \
  --import ./open-sse/utils/setupPolyfill.ts \
  scripts/cobalt/benchmark-routing.ts
```

The benchmark compares the inherited `rules` strategy against the Cobalt adaptive/hybrid stack on deterministic synthetic scenarios. It reports policy-goal hits for both paths.

It is intentionally **not** a claim that one LLM is smarter than another. No network requests are made. Use the inherited `npm run eval:router` replay/evaluation tooling for real observation corpora.

## Release audit

Run:

```bash
node scripts/cobalt/release-audit.mjs
```

The audit is intentionally fail-closed for CobaltRoute release invariants and fail-open for upstream package identity. It checks that the internal package still identifies as `omniroute` and reports that as an intentional compatibility state rather than an error.

## V1–V9 release checklist

A merge candidate should satisfy all of the following:

- V1 adaptive learning tests pass.
- V2 Router Brain tests pass.
- V3 deterministic coding feedback tests pass.
- V4 free quota intelligence tests pass.
- V5 race tests pass.
- V6 free-model qualification tests pass.
- V7 protocol compatibility tests pass.
- V8 hybrid local/cloud tests pass.
- V9 release-hardening tests pass.
- Open-SSE typecheck passes its frozen baseline gate.
- Dashboard typecheck introduces no new errors beyond the frozen upstream baseline.
- Cobalt-targeted ESLint passes.
- Git diff check passes.
- GitHub Actions security/CI checks pass.
- Release audit passes.

## Upstream sync discipline

CobaltRoute `main` follows the chosen OmniRoute release lineage, not upstream `main`. Do not use GitHub's generic **Sync fork / Discard commits** flow. Review and merge upstream release changes manually so Cobalt-specific routing layers are not silently discarded.

## Privacy release invariant

CobaltRoute-specific learning/telemetry must not persist or expose:

- prompts,
- model responses,
- API credentials,
- authorization headers,
- endpoint URLs,
- connection IDs.

Aggregate task/provider/model statistics are allowed where already documented by the corresponding Cobalt layer.

## What remains after V9

V9 should leave only the final release/package milestone:

1. decide final package/bin naming and migration compatibility,
2. choose a release version/tag,
3. run the complete release audit and CI matrix,
4. produce final release notes and installation instructions,
5. tag/publish only after those checks are green.

Built by Cobalt.
