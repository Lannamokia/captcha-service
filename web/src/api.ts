export class ApiError extends Error {
  constructor(public status: number, public code: string, public payload: Record<string, unknown> = {}) {
    super(code);
  }
}

export async function api<T>(path: string, options: RequestInit = {}, token?: string): Promise<T> {
  const response = await fetch(path, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  });
  const payload = await response.json().catch(() => ({})) as Record<string, unknown> & { error?: string };
  if (!response.ok) throw new ApiError(response.status, payload.error || "REQUEST_FAILED", payload);
  return payload as T;
}
