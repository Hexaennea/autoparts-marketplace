// Same-origin JSON client. Sends the CSRF token on every write, retries once after a token refresh,
// and turns the API's error envelope into a typed ApiError.

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly fields: Record<string, string>;
  readonly requestId: string | undefined;

  constructor(status: number, code: string, message: string, fields: Record<string, string> = {}, requestId?: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.fields = fields;
    this.requestId = requestId;
  }
}

type Query = Record<string, string | number | boolean | null | undefined>;

let csrfToken = "";
let onUnauthenticated: (() => void) | null = null;

export function setCsrf(token: string): void {
  csrfToken = token;
}

export function onSessionExpired(handler: () => void): void {
  onUnauthenticated = handler;
}

function readCookie(name: string): string {
  const match = document.cookie.split("; ").find((c) => c.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : "";
}

export function buildQuery(query?: Query): string {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "" || value === false) continue;
    params.set(key, String(value));
  }
  const text = params.toString();
  return text ? `?${text}` : "";
}

interface Options {
  query?: Query;
  body?: unknown;
  form?: FormData;
  signal?: AbortSignal;
}

async function request<T>(method: string, path: string, options: Options = {}, retried = false): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  const unsafe = method !== "GET";
  if (unsafe) headers["X-CSRF-Token"] = csrfToken || readCookie("pp_csrf");
  let body: BodyInit | undefined;
  if (options.form) body = options.form;
  else if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(options.body);
  }
  let response: Response;
  try {
    response = await fetch(path + buildQuery(options.query), {
      method, headers, body, credentials: "same-origin", signal: options.signal ?? null,
    });
  } catch (error) {
    if ((error as Error).name === "AbortError") throw error;
    throw new ApiError(0, "network", "Can't reach PartPilot. Check your connection and try again.");
  }
  const isJson = response.headers.get("content-type")?.includes("application/json");
  const payload = isJson ? await response.json().catch(() => null) : null;
  if (!response.ok) {
    const err = payload?.error ?? {};
    if (response.status === 403 && err.code === "csrf_failed" && !retried) {
      const session = await request<{ csrf: string }>("GET", "/api/auth/session");
      setCsrf(session.csrf);
      return request<T>(method, path, options, true);
    }
    if (response.status === 401 && onUnauthenticated) onUnauthenticated();
    throw new ApiError(
      response.status,
      err.code ?? "http_error",
      err.message ?? "Something went wrong. Please try again.",
      err.fields ?? {},
      err.request_id,
    );
  }
  return (payload?.data ?? null) as T;
}

export const api = {
  get: <T>(path: string, query?: Query, signal?: AbortSignal) => request<T>("GET", path, { query, signal }),
  post: <T>(path: string, body?: unknown, query?: Query) => request<T>("POST", path, { body: body ?? {}, query }),
  put: <T>(path: string, body?: unknown) => request<T>("PUT", path, { body: body ?? {} }),
  patch: <T>(path: string, body?: unknown) => request<T>("PATCH", path, { body: body ?? {} }),
  del: <T>(path: string) => request<T>("DELETE", path, {}),
  upload: <T>(path: string, file: File, query?: Query) => {
    const form = new FormData();
    form.append("file", file);
    return request<T>("POST", path, { form, query });
  },
};

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return "Something went wrong. Please try again.";
}
