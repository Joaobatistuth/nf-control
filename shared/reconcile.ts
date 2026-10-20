import { isIn, isOut, type Movement, type Rule } from "./types";

/** Normaliza PN/NF: remove espaços nas pontas e padroniza em maiúsculas. */
export const norm = (v: string) => v.trim().replace(/\s+/g, " ").toUpperCase();

export function parsePns(value: string): string[] {
  return value.split(/[+,\n;]/).map(norm).filter(Boolean);
}

export type Status = "complete" | "partial" | "pending";

export type Group = {
  key: string;
  sourcePns: string[];
  targetPns: string[];
  out: number;
  returned: number;
  pending: number;
  progress: number;
  status: Status;
  outNfs: string[];
  returnNfs: string[];
  firstDate: string;
  lastDate: string;
  ruleId: string | null;
};

export type Orphan = {
  pn: string;
  quantity: number;
  nfs: string[];
  lastDate: string;
  /** true quando o PN é destino de alguma saída, mas voltou além do que saiu */
  excess: boolean;
};

/** Grupo ao qual uma saída pertence: regra ativa que contém o PN em "fromPns" ou o próprio PN. */
export function groupKey(pn: string, activeRules: Rule[]) {
  const rule = activeRules.find(r => parsePns(r.fromPns).includes(pn));
  return { key: rule ? `rule:${rule.id}` : `pn:${pn}`, rule };
}

export type Reconciliation = { groups: Group[]; orphans: Orphan[] };

/**
 * Conciliação por consumo de quantidades:
 *  - Cada SAÍDA (OUT_HD/OUT) pertence a um grupo: o da regra ativa que contém o PN em "fromPns"
 *    (regras 1→1, 1→N e N→1 ficam todas no mesmo grupo) ou, sem regra, o próprio PN.
 *  - Cada ENTRADA (IN_HD/IN) forma um "estoque" por PN que é consumido pelos grupos
 *    (cada unidade retornada só pode casar uma vez, mesmo que dois grupos apontem ao mesmo PN).
 *  - Sobra de estoque = retorno sem saída correspondente (ou excedente).
 */
export function reconcile(movements: Movement[], rules: Rule[]): Reconciliation {
  const activeRules = rules.filter(r => r.active !== 0);
  const outs = movements.filter(m => isOut(m.kind));
  const ins = movements.filter(m => isIn(m.kind));

  const groups = new Map<string, Group>();
  for (const m of [...outs].sort((a, b) => a.movementDate.localeCompare(b.movementDate) || a.id.localeCompare(b.id))) {
    const pn = norm(m.pn);
    const { key, rule } = groupKey(pn, activeRules);
    let g = groups.get(key);
    if (!g) {
      g = {
        key,
        sourcePns: rule ? parsePns(rule.fromPns) : [pn],
        targetPns: rule ? parsePns(rule.toPns) : [pn],
        out: 0, returned: 0, pending: 0, progress: 0, status: "pending",
        outNfs: [], returnNfs: [], firstDate: m.movementDate, lastDate: m.movementDate, ruleId: rule ? rule.id : null,
      };
      groups.set(key, g);
    }
    g.out += m.quantity;
    const nf = norm(m.nf);
    if (!g.outNfs.includes(nf)) g.outNfs.push(nf);
    if (m.movementDate > g.lastDate) g.lastDate = m.movementDate;
    if (m.movementDate < g.firstDate) g.firstDate = m.movementDate;
  }

  const pool = new Map<string, number>();
  for (const m of ins) pool.set(norm(m.pn), (pool.get(norm(m.pn)) ?? 0) + m.quantity);

  const list = Array.from(groups.values());
  for (const g of list) {
    let need = g.out;
    for (const pn of g.targetPns) {
      if (need <= 0) break;
      const available = pool.get(pn) ?? 0;
      if (available <= 0) continue;
      const take = Math.min(available, need);
      pool.set(pn, available - take);
      need -= take;
      g.returned += take;
      for (const m of ins) {
        if (norm(m.pn) === pn) {
          const nf = norm(m.nf);
          if (!g.returnNfs.includes(nf)) g.returnNfs.push(nf);
        }
      }
    }
    g.pending = Math.max(g.out - g.returned, 0);
    g.progress = g.out ? Math.min(Math.round((g.returned / g.out) * 100), 100) : 0;
    g.status = g.pending === 0 ? "complete" : g.returned > 0 ? "partial" : "pending";
  }

  const targetSet = new Set(list.flatMap(g => g.targetPns));
  const orphans: Orphan[] = [];
  for (const [pn, qty] of pool) {
    if (qty <= 0) continue;
    const rel = ins.filter(m => norm(m.pn) === pn);
    orphans.push({
      pn, quantity: qty,
      nfs: Array.from(new Set(rel.map(m => norm(m.nf)))),
      lastDate: rel.reduce((d, m) => (m.movementDate > d ? m.movementDate : d), ""),
      excess: targetSet.has(pn),
    });
  }
  return { groups: list, orphans };
}

/** Trânsito HD ⇄ Fornecedor, por NF (comparação normalizada). */
export function transit(movements: Movement[]) {
  const set = (k: string) => new Set(movements.filter(m => m.kind === k).map(m => norm(m.nf)));
  const outHd = set("OUT_HD"), inForn = set("IN_FORNECEDOR"), outForn = set("OUT_FORNECEDOR"), inHd = set("IN_HD");
  return {
    toSupplier: Array.from(outHd).filter(nf => !inForn.has(nf)),
    toHd: Array.from(outForn).filter(nf => !inHd.has(nf)),
  };
}
