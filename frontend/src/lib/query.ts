// Minimal data-fetching hook: in-memory cache keyed by URL+params (stale-while-revalidate),
// request cancellation on unmount/param change, and manual reload/mutate.
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api } from "./api";

type Params = Record<string, string | number | boolean | null | undefined>;

const cache = new Map<string, unknown>();
const listeners = new Map<string, Set<() => void>>();

function keyOf(path: string, params?: Params): string {
  return path + JSON.stringify(params ?? {});
}

/** Drop cached entries whose key starts with a prefix (after a mutation). */
export function invalidate(prefix: string): void {
  for (const key of Array.from(cache.keys())) {
    if (key.startsWith(prefix)) {
      cache.delete(key);
      listeners.get(key)?.forEach((fn) => fn());
    }
  }
}

export interface QueryState<T> {
  data: T | undefined;
  error: ApiError | null;
  loading: boolean;
  reload: () => void;
  mutate: (next: T | ((prev: T | undefined) => T)) => void;
}

export function useQuery<T>(path: string | null, params?: Params): QueryState<T> {
  const key = path ? keyOf(path, params) : "";
  const [data, setData] = useState<T | undefined>(() => (key ? (cache.get(key) as T | undefined) : undefined));
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState<boolean>(Boolean(path) && !cache.has(key));
  const [tick, setTick] = useState(0);
  const paramsRef = useRef(params);
  paramsRef.current = params;

  useEffect(() => {
    if (!path) {
      setData(undefined);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    const cached = cache.get(key) as T | undefined;
    setData(cached);
    setLoading(cached === undefined);
    setError(null);
    api
      .get<T>(path, paramsRef.current, controller.signal)
      .then((result) => {
        cache.set(key, result);
        setData(result);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if ((err as Error).name === "AbortError") return;
        setError(err instanceof ApiError ? err : new ApiError(0, "unknown", "Something went wrong."));
        setLoading(false);
      });
    const listener = () => setTick((n) => n + 1);
    if (!listeners.has(key)) listeners.set(key, new Set());
    listeners.get(key)!.add(listener);
    return () => {
      controller.abort();
      listeners.get(key)?.delete(listener);
    };
  }, [key, path, tick]);

  const reload = useCallback(() => {
    cache.delete(key);
    setTick((n) => n + 1);
  }, [key]);

  const mutate = useCallback(
    (next: T | ((prev: T | undefined) => T)) => {
      setData((prev) => {
        const value = typeof next === "function" ? (next as (p: T | undefined) => T)(prev) : next;
        cache.set(key, value);
        return value;
      });
    },
    [key],
  );

  return { data, error, loading, reload, mutate };
}

/** Debounce a fast-changing value (search-as-you-type). */
export function useDebounced<T>(value: T, delay = 250): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(id);
  }, [value, delay]);
  return debounced;
}
