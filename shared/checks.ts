import { norm } from "./reconcile";
import type { Check, Direction, Kind, Movement, Side, Stage } from "./types";

const OUT_KINDS = new Set<Kind>(["OUT_HD", "OUT", "OUT_FORNECEDOR"]);

/** HD → Vulcano: OUT_HD / IN_FORNECEDOR. Vulcano → HD: OUT_FORNECEDOR / IN_HD. */
export const directionOf = (k: Kind): Direction => (k === "OUT_HD" || k === "IN_FORNECEDOR" || k === "OUT" ? "HD_TO_VULCANO" : "VULCANO_TO_HD");

/** Quem emite a NF confere o carregamento; quem recebe confere o recebimento. */
export const sideOf = (d: Direction, s: Stage): Side => ((d === "HD_TO_VULCANO") === (s === "LOAD") ? "HD" : "VULCANO");

export const stageLabel = (s: Stage) => (s === "LOAD" ? "Carregamento" : "Recebimento");
export const directionLabel = (d: Direction) => (d === "HD_TO_VULCANO" ? "HD → Vulcano" : "Vulcano → HD");
export const sideLabel = (s: Side) => (s === "HD" ? "HD" : "Vulcano");

export const checkKey = (d: Direction, s: Stage, nf: string) => `${d}|${s}|${norm(nf)}`;

export type Shipment = {
  key: string; direction: Direction; nf: string; date: string;
  items: { pn: string; expected: number }[]; hasOut: boolean; hasIn: boolean;
};

export function buildShipments(movements: Movement[]): Shipment[] {
  const map = new Map<string, Movement[]>();
  for (const m of movements) {
    const k = `${directionOf(m.kind)}|${norm(m.nf)}`;
    map.set(k, [...(map.get(k) ?? []), m]);
  }
  return Array.from(map, ([key, lines]) => {
    const outLines = lines.filter(m => OUT_KINDS.has(m.kind));
    const base = outLines.length ? outLines : lines;
    const byPn = new Map<string, number>();
    base.forEach(m => byPn.set(norm(m.pn), (byPn.get(norm(m.pn)) ?? 0) + m.quantity));
    return {
      key, direction: directionOf(lines[0].kind), nf: norm(lines[0].nf),
      date: base.reduce((d, m) => (m.movementDate < d ? m.movementDate : d), base[0].movementDate),
      items: Array.from(byPn, ([pn, expected]) => ({ pn, expected })),
      hasOut: outLines.length > 0, hasIn: lines.some(m => !OUT_KINDS.has(m.kind)),
    };
  }).sort((a, b) => b.date.localeCompare(a.date) || a.nf.localeCompare(b.nf));
}

export type TaskStatus = "pending" | "draft" | "done";
export type Task = {
  key: string; shipment: Shipment; stage: Stage; side: Side; status: TaskStatus;
  check: Check | null; waitingLoad: boolean;
};

export function buildTasks(shipments: Shipment[], checks: Check[]): Task[] {
  const byKey = new Map(checks.map(c => [checkKey(c.direction, c.stage, c.nf), c]));
  const tasks: Task[] = [];
  for (const sh of shipments) {
    const loadCheck = byKey.get(checkKey(sh.direction, "LOAD", sh.nf)) ?? null;
    for (const stage of ["LOAD", "RECEIPT"] as Stage[]) {
      const check = byKey.get(checkKey(sh.direction, stage, sh.nf)) ?? null;
      const status: TaskStatus = check?.status === "done" ? "done" : check?.items.some(i => i.checked || i.counted != null) ? "draft" : "pending";
      tasks.push({
        key: checkKey(sh.direction, stage, sh.nf), shipment: sh, stage, side: sideOf(sh.direction, stage), status, check,
        waitingLoad: stage === "RECEIPT" && loadCheck?.status !== "done" && !sh.hasIn,
      });
    }
  }
  return tasks;
}

export const divergences = (c: Check) => c.items.filter(i => i.counted != null && i.counted !== i.expected);

/** Semana ISO (segunda a domingo) de uma data YYYY-MM-DD. */
export function isoWeek(date: string) {
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const d = new Date(`${date}T00:00:00Z`);
  const monday = new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * 86400000);
  const year = new Date(monday.getTime() + 3 * 86400000).getUTCFullYear();
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const week1 = new Date(jan4.getTime() - ((jan4.getUTCDay() + 6) % 7) * 86400000);
  const week = Math.round((monday.getTime() - week1.getTime()) / (7 * 86400000)) + 1;
  return { id: `${year}-W${String(week).padStart(2, "0")}`, start: iso(monday), end: iso(new Date(monday.getTime() + 6 * 86400000)) };
}
