# releasepace-js

Official JavaScript / TypeScript SDK for [ReleasePace](https://releasepace.pages.dev) — production-grade feature flags.

Works in: **Browser · Node.js 18+ · Deno · Bun · Cloudflare Workers · React**

[![npm](https://img.shields.io/npm/v/releasepace-js)](https://www.npmjs.com/package/releasepace-js)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

---

## Installation

```bash
npm install releasepace-js
# or
yarn add releasepace-js
# or
pnpm add releasepace-js
```

---

## Quick start

```ts
import { ReleasePace } from 'releasepace-js'

const rp = new ReleasePace({
  apiKey:      'rp_srv_xxxxxxxxxxxx',   // server SDK key; use rp_live_ in browser/React
  environment: 'production',
})

await rp.connect()   // fetches flags, starts 30s polling

// Boolean flag
if (rp.isEnabled('new-checkout')) {
  renderNewCheckout()
}

// String, number, JSON flags
const label = rp.getString('cta-label',  'Get started')
const limit = rp.getNumber('rate-limit', 100)
const cfg   = rp.getJSON('feature-config', {})
```

---

## React

Browser keys (rp_live_) use remote evaluation. Only flags marked "Expose to browser and mobile SDKs" in the dashboard are returned to them.

```tsx
import { ReleasePaceProvider, useFlag } from 'releasepace-js/react'

function App() {
  return (
    <ReleasePaceProvider apiKey="rp_live_xxx" environment="production">
      <MyApp />
    </ReleasePaceProvider>
  )
}

function Checkout() {
  const newFlow  = useFlag('new-checkout')           // boolean
  const ctaLabel = useFlag('cta-label', 'Buy now')   // string with default

  return newFlow ? <NewFlow label={ctaLabel} /> : <OldFlow />
}
```

---

## API reference

### `new ReleasePace(options)`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `apiKey` | `string` | required | SDK key from your dashboard |
| `environment` | `string` | `"production"` | Environment slug |
| `apiUrl` | `string` | `https://api-prod.releasepace.workers.dev` | Override API URL |
| `pollInterval` | `number` | `30000` | Poll interval in ms |
| `disablePolling` | `boolean` | `false` | Disable background polling |
| `context` | `Record<string,string>` | `{}` | Evaluation context (userId, country…) |
| `onFlagsUpdated` | `(flags: Flag[]) => void` | — | Called when flags change |
| `onError` | `(error: Error) => void` | — | Called on fetch errors |

### Methods

| Method | Returns | Description |
|--------|---------|-------------|
| `connect()` | `Promise<Snapshot>` | Fetch flags and start polling |
| `disconnect()` | `void` | Stop polling |
| `refresh()` | `Promise<void>` | Force immediate re-fetch |
| `isEnabled(key, context?)` | `boolean` | Check boolean flag with optional request context |
| `explain(key, context?)` | `EvalResult` | Explain local evaluation with optional request context |
| `getString(key, default)` | `string` | Get string flag value |
| `getNumber(key, default)` | `number` | Get number flag value |
| `getJSON<T>(key, default)` | `T` | Get JSON flag value |
| `getValue(key, default)` | `unknown` | Get any flag value |
| `getAllFlags()` | `Flag[]` | Get all flags |
| `getSnapshot()` | `Snapshot \| null` | Last successful response |
| `setContext(ctx)` | `void` | Merge evaluation context |

### Gradual rollouts

Flags with a `rollout_pct` (0–100) use sticky bucketing by `userId`:

```ts
rp.setContext({ userId: 'user-123' })
// Same user always gets the same result for the same flag
if (rp.isEnabled('new-feature')) { ... }
```

For a shared server client, pass context to each evaluation so concurrent
requests cannot retain one another's attributes:

```ts
const enabled = rp.isEnabled('new-feature', {
  userId: session.user.id,
  tenantId: session.organization.id,
})
```

---

## React hooks

| Hook | Description |
|------|-------------|
| `useFlag(key)` | Returns `boolean` |
| `useFlag<T>(key, default)` | Returns flag value with default |
| `useFlags()` | Returns `Map<string, Flag>` |
| `useReleasePaceClient()` | Returns the `ReleasePace` instance |
| `useReleasePaceStatus()` | Returns `{ loading, error }` |

---

## Self-hosting

Point the SDK at your own ReleasePace instance:

```ts
const rp = new ReleasePace({
  apiKey:  'rp_live_xxx',
  apiUrl:  'https://api.yourdomain.com',   // your Cloudflare Worker URL
})
```

---


## Author

**[Aryaa Tiwari](https://github.com/AryaaTiwari)** — [LinkedIn](https://www.linkedin.com/in/aryaa-tiwari/)

## License

MIT © [ReleasePace](https://releasepace.pages.dev)
