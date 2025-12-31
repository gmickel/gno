import { useCallback, useState } from 'react';

interface ApiState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
}

export function useApi<T>() {
  const [state, setState] = useState<ApiState<T>>({
    data: null,
    loading: false,
    error: null,
  });

  const request = useCallback(
    async (endpoint: string, options?: RequestInit): Promise<T | null> => {
      setState({ data: null, loading: true, error: null });

      try {
        const res = await fetch(endpoint, {
          headers: { 'Content-Type': 'application/json' },
          ...options,
        });

        const json = await res.json();

        if (!res.ok) {
          const msg = json.error?.message || `Request failed: ${res.status}`;
          setState({ data: null, loading: false, error: msg });
          return null;
        }

        setState({ data: json, loading: false, error: null });
        return json;
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Network error';
        setState({ data: null, loading: false, error: msg });
        return null;
      }
    },
    []
  );

  return { ...state, request };
}

export async function apiFetch<T>(
  endpoint: string,
  options?: RequestInit
): Promise<{ data: T | null; error: string | null }> {
  try {
    const res = await fetch(endpoint, {
      headers: { 'Content-Type': 'application/json' },
      ...options,
    });

    const json = await res.json();

    if (!res.ok) {
      return {
        data: null,
        error: json.error?.message || `Request failed: ${res.status}`,
      };
    }

    return { data: json, error: null };
  } catch (err) {
    return {
      data: null,
      error: err instanceof Error ? err.message : 'Network error',
    };
  }
}
