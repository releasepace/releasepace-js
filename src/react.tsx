/**
 * releasepace-js/react — React hooks and provider
 *
 * Usage:
 *   import { ReleasePaceProvider, useFlag, useFlags } from 'releasepace-js/react';
 *
 *   <ReleasePaceProvider apiKey="rp_live_xxx" environment="production">
 *     <App />
 *   </ReleasePaceProvider>
 *
 *   function MyComponent() {
 *     const enabled = useFlag('new-checkout');
 *     const bannerText = useFlag('banner-text', 'Default text');
 *   }
 */

import React, {
  createContext,
  useContext,
  useEffect,
  useState,
  useRef,
  ReactNode,
} from "react";
import { ReleasePace, ReleasePaceOptions, Flag } from "./index";

// ── Context ─────────────────────────────────────────────────
interface ReleasePaceContextValue {
  client: ReleasePace | null;
  flags: Map<string, Flag>;
  loading: boolean;
  error: Error | null;
}

const ReleasePaceContext = createContext<ReleasePaceContextValue>({
  client: null,
  flags: new Map(),
  loading: true,
  error: null,
});

// ── Provider ─────────────────────────────────────────────────
interface ReleasePaceProviderProps extends ReleasePaceOptions {
  children: ReactNode;
  loadingComponent?: ReactNode;
}

export function ReleasePaceProvider({
  children,
  loadingComponent,
  ...opts
}: ReleasePaceProviderProps) {
  const [flags, setFlags] = useState<Map<string, Flag>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const clientRef = useRef<ReleasePace | null>(null);

  useEffect(() => {
    const client = new ReleasePace({
      ...opts,
      onFlagsUpdated: (all) => {
        setFlags(new Map(all.map((f) => [f.key, f])));
        opts.onFlagsUpdated?.(all);
      },
      onError: (e) => {
        setError(e);
        opts.onError?.(e);
      },
    });

    clientRef.current = client;

    client.connect().then((snap) => {
      setFlags(new Map(snap.features.map((f) => [f.key, f])));
      setLoading(false);
    }).catch((e) => {
      setError(e);
      setLoading(false);
    });

    return () => client.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts.apiKey, opts.environment]);

  if (loading && loadingComponent) return <>{loadingComponent}</>;

  return (
    <ReleasePaceContext.Provider value={{ client: clientRef.current, flags, loading, error }}>
      {children}
    </ReleasePaceContext.Provider>
  );
}

// ── Hooks ────────────────────────────────────────────────────

/** Returns whether a boolean flag is enabled */
export function useFlag(key: string): boolean;
/** Returns the flag value (any type) with a default */
export function useFlag<T>(key: string, defaultValue: T): T;
export function useFlag<T>(key: string, defaultValue?: T): boolean | T {
  const { flags } = useContext(ReleasePaceContext);
  const flag = flags.get(key);
  if (!flag || !flag.enabled) return defaultValue !== undefined ? defaultValue : false as any;
  if (defaultValue !== undefined) return (flag.value as T) ?? defaultValue;
  return flag.enabled;
}

/** Returns all flags */
export function useFlags(): Map<string, Flag> {
  return useContext(ReleasePaceContext).flags;
}

/** Returns the ReleasePace client instance */
export function useReleasePaceClient(): ReleasePace | null {
  return useContext(ReleasePaceContext).client;
}

/** Returns loading/error state */
export function useReleasePaceStatus(): { loading: boolean; error: Error | null } {
  const { loading, error } = useContext(ReleasePaceContext);
  return { loading, error };
}
