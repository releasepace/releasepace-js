import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ReleasePace } from '../index'

// ── Mock fetch globally ───────────────────────────────────────
const mockFlags = [
  { key: 'bool-on',    name: 'Bool On',    type: 'boolean', enabled: true,  value: null,       rollout_pct: null, strategies: [] },
  { key: 'bool-off',   name: 'Bool Off',   type: 'boolean', enabled: false, value: null,       rollout_pct: null, strategies: [] },
  { key: 'str-flag',   name: 'Str Flag',   type: 'string',  enabled: true,  value: 'hello',    rollout_pct: null, strategies: [] },
  { key: 'num-flag',   name: 'Num Flag',   type: 'number',  enabled: true,  value: 42,         rollout_pct: null, strategies: [] },
  { key: 'json-flag',  name: 'JSON Flag',  type: 'json',    enabled: true,  value: { a: 1 },   rollout_pct: null, strategies: [] },
  { key: 'rollout-50', name: 'Rollout 50', type: 'boolean', enabled: true,  value: null,       rollout_pct: 50,   strategies: [] },
]

function mockFetch(flags = mockFlags) {
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ version: 1, environment: 'test', features: flags }),
  } as Response)
}

function mockFetchError(status = 401) {
  global.fetch = vi.fn().mockResolvedValue({
    ok: false,
    status,
    text: async () => 'Unauthorized',
  } as Response)
}

describe('ReleasePace client', () => {
  let rp: ReleasePace

  beforeEach(() => {
    mockFetch()
    rp = new ReleasePace({ apiKey: 'rp_live_test', environment: 'test', disablePolling: true })
  })

  afterEach(() => {
    rp.disconnect()
    vi.restoreAllMocks()
  })

  // ── connect ────────────────────────────────────────────────
  it('connects and returns snapshot', async () => {
    const snap = await rp.connect()
    expect(snap.features).toHaveLength(mockFlags.length)
    expect(snap.environment).toBe('test')
    expect(snap.version).toBe(1)
  })

  it('calls the correct API URL with auth header', async () => {
    await rp.connect()
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/client/features'),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer rp_live_test',
        }),
      })
    )
  })

  // ── isEnabled ──────────────────────────────────────────────
  it('isEnabled returns true for enabled boolean flag', async () => {
    await rp.connect()
    expect(rp.isEnabled('bool-on')).toBe(true)
  })

  it('isEnabled returns false for disabled flag', async () => {
    await rp.connect()
    expect(rp.isEnabled('bool-off')).toBe(false)
  })

  it('isEnabled returns false for unknown flag', async () => {
    await rp.connect()
    expect(rp.isEnabled('does-not-exist')).toBe(false)
  })

  // ── getValue ───────────────────────────────────────────────
  it('getString returns string value', async () => {
    await rp.connect()
    expect(rp.getString('str-flag', 'default')).toBe('hello')
  })

  it('getString returns default when flag disabled', async () => {
    await rp.connect()
    expect(rp.getString('bool-off', 'fallback')).toBe('fallback')
  })

  it('getNumber returns numeric value', async () => {
    await rp.connect()
    expect(rp.getNumber('num-flag', 0)).toBe(42)
  })

  it('getJSON returns object value', async () => {
    await rp.connect()
    expect(rp.getJSON('json-flag', {})).toEqual({ a: 1 })
  })

  // ── getAllFlags ────────────────────────────────────────────
  it('getAllFlags returns all flags', async () => {
    await rp.connect()
    const all = rp.getAllFlags()
    expect(all).toHaveLength(mockFlags.length)
  })

  // ── Rollout ────────────────────────────────────────────────
  it('rollout_pct=50 is consistent for same userId', async () => {
    await rp.connect()
    rp.setContext({ userId: 'user-abc' })
    const result1 = rp.isEnabled('rollout-50')
    const result2 = rp.isEnabled('rollout-50')
    expect(result1).toBe(result2) // sticky
  })

  it('rollout_pct=0 is always false', async () => {
    mockFetch([{ key: 'rollout-0', name: 'Off', type: 'boolean', enabled: true, value: null, rollout_pct: 0, strategies: [] }])
    await rp.connect()
    expect(rp.isEnabled('rollout-0')).toBe(false)
  })

  it('rollout_pct=100 is always true', async () => {
    mockFetch([{ key: 'rollout-100', name: 'Full', type: 'boolean', enabled: true, value: null, rollout_pct: 100, strategies: [] }])
    await rp.connect()
    expect(rp.isEnabled('rollout-100')).toBe(true)
  })

  // ── Error handling ─────────────────────────────────────────
  it('calls onError when API returns error status', async () => {
    mockFetchError(401)
    const onError = vi.fn()
    const client = new ReleasePace({ apiKey: 'bad', environment: 'test', disablePolling: true, onError })
    await client.connect().catch(() => {})
    expect(onError).toHaveBeenCalled()
    client.disconnect()
  })

  it('keeps existing cache after a failed refresh', async () => {
    await rp.connect()
    expect(rp.isEnabled('bool-on')).toBe(true)

    // Now fail the next fetch
    mockFetchError(500)
    await rp.refresh()

    // Cache should still be intact
    expect(rp.isEnabled('bool-on')).toBe(true)
  })

  // ── Context ────────────────────────────────────────────────
  it('setContext merges new keys', async () => {
    await rp.connect()
    await rp.setContext({ userId: 'u1', country: 'IN' })
    await rp.setContext({ plan: 'pro' })
    // Context is no longer appended to the features URL as ctx_* query
    // params — the API never read them, so it was silently discarded.
    // In local mode it is applied here; in remote mode it is POSTed
    // to /evaluate. Either way it now actually affects the outcome.
    expect(rp.getEvaluationMode()).toBe('local')
    await rp.refresh()
    const url = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.at(-1)[0] as string
    expect(url).not.toContain('ctx_userId')
  })

  // ── Snapshot ───────────────────────────────────────────────
  it('getSnapshot returns last successful snapshot', async () => {
    await rp.connect()
    const snap = rp.getSnapshot()
    expect(snap).not.toBeNull()
    expect(snap?.fetchedAt).toBeInstanceOf(Date)
  })

  it('getSnapshot returns null before connect', () => {
    expect(rp.getSnapshot()).toBeNull()
  })
})
