// Thin fetch wrapper for the local Fastify API, shared by main.tsx and the note draft controller.

export class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export async function api<T>(url: string, options?: RequestInit): Promise<T> {
  const headers = options?.body ? { "content-type": "application/json" } : undefined;
  const response = await fetch(url, { ...options, headers });
  const payload = await response.json();
  if (!response.ok) throw new ApiError(payload.error ?? `Request failed: ${response.status}`, response.status);
  return payload as T;
}
