// Tests only: a stand-in for `api` (./api.js) that answers, records or fails calls without a server.
import type { Api } from "./api.js";

export type FakeCallInput = { params?: Record<string, string>; query?: unknown; body?: unknown };

export const fakeApi = (answer: (endpoint: string, input?: FakeCallInput) => unknown) =>
  (async (endpoint: string, input?: FakeCallInput) => answer(endpoint, input)) as unknown as Api;
