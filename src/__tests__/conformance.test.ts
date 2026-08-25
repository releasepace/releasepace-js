import { describe, it, expect } from 'vitest'
import { murmur3_32, bucketOf, inRollout } from '../bucketing'
import { evaluate, FlagStateInput } from '../evaluation'
import vectors from '../../fixtures/bucketing-vectors.json'

/**
 * Cross-SDK conformance.
 *
 * This fixture is byte-identical to the one asserted by the API and by
 * the Python, Go and Java SDKs. If any implementation drifts, the same
 * user is enabled in the browser and disabled in the backend.
 *
 * Do not "fix" a failure here by editing the fixture.
 */
describe('bucketing conformance', () => {
  it('matches the published MurmurHash3 x86_32 reference values', () => {
    for (const kat of vectors.known_answer_tests) {
      expect(murmur3_32(kat.input), JSON.stringify(kat.input)).toBe(kat.hash)
    }
  })

  it('reproduces every shared vector exactly', () => {
    for (const v of vectors.vectors) {
      expect(murmur3_32(`${v.flag_key}:${v.entity_id}`)).toBe(v.hash)
      expect(bucketOf(v.flag_key, v.entity_id)).toBe(v.bucket)
    }
  })

  it('never removes anyone when a rollout ramps up', () => {
    for (let i = 0; i < 3000; i++) {
      if (inRollout('ramp', `u${i}`, 20)) {
        expect(inRollout('ramp', `u${i}`, 60)).toBe(true)
      }
    }
  })
})

function state(over: Partial<FlagStateInput> = {}): FlagStateInput {
  return {
    key: 'new-checkout',
    type: 'boolean',
    enabled: true,
    value: null,
    rollout_pct: null,
    bucket_by: null,
    targeting_rules: [],
    ...over,
  }
}

describe('SDK-side evaluation', () => {
  it('turns a flag on for a targeted tenant only', () => {
    const flag = state({
      targeting_rules: [
        {
          id: 'r1',
          conditions: [{ attribute: 'tenantId', op: 'in', values: ['acme-corp'] }],
          serve: { enabled: true },
        },
      ],
      enabled: true,
      rollout_pct: 0,
    })
    expect(evaluate(flag, { tenantId: 'acme-corp' }).enabled).toBe(true)
    expect(evaluate(flag, { tenantId: 'globex' }).enabled).toBe(false)
  })

  it('keeps a whole tenant together under tenant bucketing', () => {
    const flag = state({ rollout_pct: 50, bucket_by: 'tenantId' })
    const decisions = new Set(
      Array.from({ length: 50 }, (_, i) =>
        evaluate(flag, { tenantId: 'acme-corp', userId: `u${i}` }).enabled
      )
    )
    expect(decisions.size).toBe(1)
  })

  it('serves off rather than guessing when the bucket attribute is absent', () => {
    const r = evaluate(state({ rollout_pct: 50, bucket_by: 'tenantId' }), { userId: 'u1' })
    expect(r.enabled).toBe(false)
    expect(r.reason).toBe('MISSING_BUCKET_ATTRIBUTE')
  })

  it('no longer collapses a partial rollout when userId is absent', () => {
    // Regression: the old djb2 path fell back to the flag key itself,
    // so every user hashed to the same bucket and a 20% rollout became
    // all-or-nothing across the entire user base.
    const flag = state({ rollout_pct: 20, bucket_by: 'userId' })
    const decisions = new Set(
      Array.from({ length: 500 }, (_, i) => evaluate(flag, { userId: `u${i}` }).enabled)
    )
    expect(decisions.size).toBe(2)
  })
})
