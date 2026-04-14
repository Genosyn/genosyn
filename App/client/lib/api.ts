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
  defaultModelId: string | null;
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
  modelId: string | null;
};
export type AIModel = {
  id: string;
  companyId: string;
  name: string;
  provider: "claude-code" | "codex" | "opencode";
  model: string;
  configJson: string;
};
export type Member = { userId: string; role: string; email: string | null; name: string | null };
