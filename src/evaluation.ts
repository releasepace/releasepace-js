/**
 * Flag evaluation.
 *
 * This module is the single source of truth for evaluation order and
 * MUST be mirrored exactly by every SDK:
 *
 *   1. Global kill switch   – state.enabled = false wins over everything
 *   2. Targeting rules      – ordered, first match wins
 *   3. Rule rollout         – bucketed, so a rule can itself be partial
 *   4. Default rollout      – the flag's baseline for everyone else
 *
 * Every result carries a `reason`, so the dashboard can answer
 * "why is this on for Acme?" without anyone guessing.
 */

import { inRollout } from "./bucketing";

export type BucketBy = "userId" | "tenantId";

export type Operator =
  | "in"
  | "not_in"
  | "in_segment"
  | "not_in_segment"
  | "equals"
  | "contains"
  | "starts_with"
  | "semver_gte";

export interface Condition {
  attribute: string;
  op: Operator;
  /** Used by in / not_in. */
  values?: string[];
  /** Used by every single-operand operator, including segment keys. */
  value?: string;
}

export interface TargetingRule {
  id: string;
  description?: string;
  conditions: Condition[];
  serve: { enabled: boolean; value?: unknown };
  /** Optional partial rollout *within* the matched audience. */
  rollout_pct?: number | null;
  bucket_by?: BucketBy | null;
}

export interface FlagStateInput {
  key: string;
  type: string;
  enabled: boolean;
  value: unknown;
  rollout_pct: number | null;
  bucket_by: BucketBy | null;
  targeting_rules: TargetingRule[];
}

/** Attributes the caller knows about the current request. */
export type EvalContext = Record<string, string | undefined>;

/** segment key -> explicit member entity keys */
export type SegmentIndex = Record<string, Set<string>>;

export type EvalReason =
  | "KILL_SWITCH"
  | "TARGETING_MATCH"
  | "TARGETING_MATCH_ROLLOUT_EXCLUDED"
  | "DEFAULT_ROLLOUT_INCLUDED"
  | "DEFAULT_ROLLOUT_EXCLUDED"
  | "DEFAULT"
  | "MISSING_BUCKET_ATTRIBUTE";

export interface EvalResult {
  key: string;
  enabled: boolean;
  value: unknown;
  reason: EvalReason;
  /** Which rule decided this, when one did. */
  rule_id?: string;
  /** Set when bucket_by asked for an attribute the context did not carry. */
  missing_attribute?: string;
}

/** The identifier a rollout is bucketed by. */
function bucketKeyFor(ctx: EvalContext, bucketBy: BucketBy): string | undefined {
  const raw = bucketBy === "tenantId" ? ctx.tenantId : ctx.userId;
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}

function matchesCondition(
  cond: Condition,
  ctx: EvalContext,
  segments: SegmentIndex
): boolean {
  const actual = ctx[cond.attribute];

  switch (cond.op) {
    case "in_segment":
    case "not_in_segment": {
      const hit =
        actual !== undefined &&
        (segments[cond.value ?? ""]?.has(actual) ?? false);
      return cond.op === "in_segment" ? hit : !hit;
    }
    case "not_in":
      // A missing attribute is genuinely "not in" the list.
      if (actual === undefined) return true;
      return !(cond.values ?? []).includes(actual);
  }

  // Every remaining operator needs a present attribute.
  if (actual === undefined) return false;

  switch (cond.op) {
    case "in":
      return (cond.values ?? []).includes(actual);
    case "equals":
      return actual === cond.value;
    case "contains":
      return cond.value !== undefined && actual.includes(cond.value);
    case "starts_with":
      return cond.value !== undefined && actual.startsWith(cond.value);
    case "semver_gte":
      return cond.value !== undefined && compareSemver(actual, cond.value) >= 0;
    default:
      // Unknown operator from a newer dashboard: fail closed, never match.
      return false;
  }
}

/** All conditions in a rule are ANDed. */
function matchesRule(
  rule: TargetingRule,
  ctx: EvalContext,
  segments: SegmentIndex
): boolean {
  if (!rule.conditions?.length) return false;
  return rule.conditions.every((c) => matchesCondition(c, ctx, segments));
}

export function evaluate(
  state: FlagStateInput,
  ctx: EvalContext,
  segments: SegmentIndex = {}
): EvalResult {
  const base = { key: state.key };

  // ── 1. Global kill switch ──────────────────────────────────
  // Deliberately above targeting: an operator flipping a flag off
  // during an incident must not be overridden by a rule that says
  // "always on for Acme".
  if (!state.enabled) {
    return { ...base, enabled: false, value: null, reason: "KILL_SWITCH" };
  }

  // ── 2. Targeting rules, first match wins ───────────────────
  for (const rule of state.targeting_rules ?? []) {
    if (!matchesRule(rule, ctx, segments)) continue;

    const served = rule.serve?.value !== undefined ? rule.serve.value : state.value;

    // ── 3. Optional rollout within the matched audience ──────
    const pct = rule.rollout_pct;
    if (pct !== null && pct !== undefined && pct < 100) {
      const bucketBy = rule.bucket_by ?? state.bucket_by ?? "userId";
      const bucketKey = bucketKeyFor(ctx, bucketBy);

      if (!bucketKey) return missingAttribute(state, bucketBy);

      const included = inRollout(state.key, bucketKey, pct);
      return {
        ...base,
        enabled: included ? rule.serve.enabled : false,
        value: included ? served : null,
        reason: included ? "TARGETING_MATCH" : "TARGETING_MATCH_ROLLOUT_EXCLUDED",
        rule_id: rule.id,
      };
    }

    return {
      ...base,
      enabled: rule.serve.enabled,
      value: rule.serve.enabled ? served : null,
      reason: "TARGETING_MATCH",
      rule_id: rule.id,
    };
  }

  // ── 4. Default rollout for everyone else ───────────────────
  const pct = state.rollout_pct;
  if (pct !== null && pct !== undefined && pct < 100) {
    const bucketBy = state.bucket_by ?? "userId";
    const bucketKey = bucketKeyFor(ctx, bucketBy);

    if (!bucketKey) return missingAttribute(state, bucketBy);

    const included = inRollout(state.key, bucketKey, pct);
    return {
      ...base,
      enabled: included,
      value: included ? state.value : null,
      reason: included ? "DEFAULT_ROLLOUT_INCLUDED" : "DEFAULT_ROLLOUT_EXCLUDED",
    };
  }

  return { ...base, enabled: true, value: state.value, reason: "DEFAULT" };
}

/**
 * bucket_by named an attribute the context did not carry.
 *
 * Falling back to the other attribute would silently produce exactly
 * the scattered per-user split that tenant bucketing exists to avoid,
 * and it would be invisible. Serve off, name the missing attribute,
 * and let the caller surface it as an integration warning.
 */
function missingAttribute(state: FlagStateInput, bucketBy: BucketBy): EvalResult {
  return {
    key: state.key,
    enabled: false,
    value: null,
    reason: "MISSING_BUCKET_ATTRIBUTE",
    missing_attribute: bucketBy,
  };
}

/** Numeric semver compare. Pre-release tags are ignored. */
function compareSemver(a: string, b: string): number {
  const parse = (v: string) =>
    v
      .replace(/^v/, "")
      .split("-")[0]
      .split(".")
      .map((n) => parseInt(n, 10) || 0);

  const pa = parse(a);
  const pb = parse(b);

  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}
