import { useCallback, useState } from 'react';

interface ApiState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
}

/**
 * Safely parse JSON response, checking Content-Type first.
 */
async function parseJsonSafe(
  res: Response
): Promise<{ json: unknown; parseError: string | null }> {
  const ct = res.headers.get('content-type') ?? '';
  const isJson = ct.includes('application/json');

  if (!isJson) {
    // Non-JSON response - return text as error context
    const text = await res.text();
    return {
      json: null,
      parseError: text.slice(0, 200) || `Non-JSON response: ${res.status}`,
    };
  }

  try {
    const json = await res.json();
    return { json, parseError: null };
  } catch {
    return { json: null, parseError: 'Invalid JSON response' };
  }
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

        const { json, parseError } = await parseJsonSafe(res);

        if (parseError) {
          setState({ data: null, loading: false, error: parseError });
          return null;
        }

        if (!res.ok) {
          const apiError = json as { error?: { message?: string } };
          const msg =
            apiError.error?.message || `Request failed: ${res.status}`;
          setState({ data: null, loading: false, error: msg });
          return null;
        }

        setState({ data: json as T, loading: false, error: null });
        return json as T;
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

    const { json, parseError } = await parseJsonSafe(res);

    if (parseError) {
      return { data: null, error: parseError };
    }

    if (!res.ok) {
      const apiError = json as { error?: { message?: string } };
      return {
        data: null,
        error: apiError.error?.message || `Request failed: ${res.status}`,
      };
    }

    return { data: json as T, error: null };
  } catch (err) {
    return {
      data: null,
      error: err instanceof Error ? err.message : 'Network error',
    };
  }
}
