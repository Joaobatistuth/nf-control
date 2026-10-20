import type { Check, Direction, Inventory, Movement, Rule, Kind, Stage, CheckItem } from "@shared/types";

export class ApiError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api/${path}`, {
      ...init,
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    });
  } catch {
    throw new ApiError("Sem conexão com o servidor.", 0);
  }
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* resposta não-JSON (ex.: função não publicada) */ }
  if (!res.ok || data === null) {
    throw new ApiError(data?.error ?? "Servidor indisponível. Verifique se as Functions da Netlify estão publicadas.", res.status || 500);
  }
  return data as T;
}

export const api = {
  listMovements: () => request<Movement[]>("movements"),
  createMovements: (input: { kind: Kind; nf: string; refNf: string; movementDate: string; items: { pn: string; quantity: number }[]; notes: string }) =>
    request<Movement[]>("movements", { method: "POST", body: JSON.stringify(input) }),
  deleteMovement: (id: string) => request<{ success: true }>(`movements/${id}`, { method: "DELETE" }),

  listRules: () => request<Rule[]>("rules"),
  rulesStatus: () => request<{ unlocked: boolean }>("rules/status"),
  unlock: (password: string) => request<{ success: boolean }>("rules/unlock", { method: "POST", body: JSON.stringify({ password }) }),
  lock: () => request<{ success: boolean }>("rules/lock", { method: "POST" }),
  createRule: (data: { fromPns: string; toPns: string; description: string; active: number }) =>
    request<Rule>("rules", { method: "POST", body: JSON.stringify(data) }),
  updateRule: (id: string, data: { fromPns: string; toPns: string; description: string; active: number }) =>
    request<Rule>(`rules/${id}`, { method: "PUT", body: JSON.stringify(data) }),
  deleteRule: (id: string) => request<{ success: true }>(`rules/${id}`, { method: "DELETE" }),

  listChecks: () => request<Check[]>("checks"),
  saveCheck: (b: { direction: Direction; stage: Stage; nf: string; items: CheckItem[]; checkedBy: string; photoIds: string[]; submit: boolean }) =>
    request<Check>("checks/save", { method: "POST", body: JSON.stringify(b) }),
  commentCheck: (b: { direction: Direction; stage: Stage; nf: string; text: string; author: string }) =>
    request<Check>("checks/comment", { method: "POST", body: JSON.stringify(b) }),

  listInventories: () => request<Inventory[]>("inventories"),
  createInventory: (b: { date: string; lines: { key: string; label: string; targets: string; expected: number }[] }) =>
    request<Inventory>("inventories", { method: "POST", body: JSON.stringify(b) }),
  saveInventory: (b: { id: string; lines: { key: string; label?: string; counted: number | null; extra?: boolean }[]; countedBy: string; photoIds: string[]; submit: boolean }) =>
    request<Inventory>("inventories/save", { method: "POST", body: JSON.stringify(b) }),
  commentInventory: (b: { id: string; text: string; author: string }) =>
    request<Inventory>("inventories/comment", { method: "POST", body: JSON.stringify(b) }),
  deleteInventory: (id: string) => request<{ success: true }>(`inventories/${id}`, { method: "DELETE" }),

  uploadPhoto: (dataUrl: string) => request<{ id: string }>("photos", { method: "POST", body: JSON.stringify({ dataUrl }) }),
};

export const photoUrl = (id: string) => `/api/photos/${id}`;
