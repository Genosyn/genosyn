async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    credentials: "same-origin",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const msg = (data && (data.error || data.message)) || res.statusText;
    throw new Error(msg);
  }
  return data as T;
}

export const api = {
  get: <T>(url: string) => request<T>("GET", url),
  post: <T>(url: string, body?: unknown) => request<T>("POST", url, body),
  put: <T>(url: string, body?: unknown) => request<T>("PUT", url, body),
  patch: <T>(url: string, body?: unknown) => request<T>("PATCH", url, body),
  del: <T>(url: string) => request<T>("DELETE", url),
};

export type Me = { id: string; email: string; name: string };
export type Company = { id: string; name: string; slug: string; role?: string };
export type Employee = {
  id: string;
  companyId: string;
  name: string;
  slug: string;
  role: string;
};
export type Skill = { id: string; employeeId: string; name: string; slug: string };
export type Routine = {
  id: string;
  employeeId: string;
  name: string;
  slug: string;
  cronExpr: string;
  enabled: boolean;
  lastRunAt: string | null;
};
export type Provider = "claude-code" | "codex" | "opencode";
export type AuthMode = "subscription" | "apikey";
export type AIModel = {
  id: string;
  employeeId: string;
  provider: Provider;
  model: string;
  authMode: AuthMode;
  connectedAt: string | null;
  status: "not_connected" | "connected";
  apiKeyMasked: string | null;
  configDir: string;
  configDirEnv: string;
  loginCommand: string;
  apiKeyEnv: string | null;
  supportsApiKey: boolean;
};
export type ModelOverviewRow = {
  employeeId: string;
  employeeName: string;
  employeeSlug: string;
  role: string;
  model: AIModel | null;
};
export type Member = { userId: string; role: string; email: string | null; name: string | null };
