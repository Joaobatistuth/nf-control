export type Kind = "OUT_HD" | "IN_FORNECEDOR" | "OUT_FORNECEDOR" | "IN_HD" | "OUT" | "IN";
export const KINDS: Kind[] = ["OUT_HD", "IN_FORNECEDOR", "OUT_FORNECEDOR", "IN_HD", "OUT", "IN"];

export type Movement = {
  id: string;
  kind: Kind;
  nf: string;
  movementDate: string; // YYYY-MM-DD
  pn: string;
  quantity: number;
  notes: string | null;
  /** Só em OUT_FORNECEDOR: NF(s) de entrada (enviadas pela HD) a que esta NF de saída se refere, separadas por " + ". */
  refNf?: string | null;
  createdAt: string;
};

export type Rule = {
  id: string;
  fromPns: string; // "A + B"
  toPns: string; // "C + D"
  description: string | null;
  active: number; // 1 | 0
  createdAt: string;
  updatedAt: string;
};

export const isOut = (k: Kind) => k === "OUT_HD" || k === "OUT";
export const isIn = (k: Kind) => k === "IN_HD" || k === "IN";

// ---------- Conferência de NF e inventário semanal ----------
export type Direction = "HD_TO_VULCANO" | "VULCANO_TO_HD";
export type Stage = "LOAD" | "RECEIPT";
export type Side = "HD" | "VULCANO";

export type Comment = { id: string; text: string; author: string; at: string };
export type CheckItem = { pn: string; expected: number; counted: number | null; checked: boolean };
export type Check = {
  id: string; direction: Direction; stage: Stage; nf: string;
  items: CheckItem[]; status: "draft" | "done";
  checkedBy: string | null; doneAt: string | null; photoIds: string[]; comments: Comment[];
  createdAt: string; updatedAt: string;
};
export type InventoryLine = { key: string; label: string; targets: string; expected: number; counted: number | null; extra?: boolean };
export type Inventory = {
  id: string; week: string; weekStart: string; weekEnd: string;
  status: "pending" | "counted"; lines: InventoryLine[];
  generatedAt: string; countedBy: string | null; countedAt: string | null;
  photoIds: string[]; comments: Comment[]; updatedAt: string;
};
