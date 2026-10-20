import { groupKey, norm, parsePns } from "./reconcile";
import { buildShipments } from "./checks";
import type { Movement, Rule } from "./types";

export type MatchStatus = "match" | "partial" | "diverge" | "no_ref" | "ref_not_found";
export type MatchRow = { pns: string[]; targets: string[]; entry: number; returned: number; diff: number };
export type MatchResult = {
  nf: string; refs: string[]; missingRefs: string[];
  rows: MatchRow[]; unexpected: { pn: string; qty: number }[];
  status: MatchStatus;
};

export const parseRefs = (v: string | null | undefined) => parsePns(v ?? "");

/**
 * Casa a NF de saída do fornecedor (Vulcano → HD) com a(s) NF(s) de referência (NF de entrada, HD → Vulcano).
 * Respeita as regras de retrabalho (PN que entra → PN que volta) e soma as outras NFs de saída que
 * referenciam a mesma entrada (devolução em partes). `movements` pode ou não conter a própria NF.
 */
export function matchReturn(movements: Movement[], rules: Rule[], nf: string, refs: string[], lines: { pn: string; qty: number }[]): MatchResult {
  const base = { nf: norm(nf), refs };
  if (!refs.length) return { ...base, missingRefs: [], rows: [], unexpected: [], status: "no_ref" };

  const active = rules.filter(r => r.active !== 0);
  const entries = buildShipments(movements).filter(s => s.direction === "HD_TO_VULCANO" && refs.includes(s.nf));
  const missingRefs = refs.filter(r => !entries.some(s => s.nf === r));

  const groups = new Map<string, MatchRow>();
  for (const s of entries) {
    for (const it of s.items) {
      const { key, rule } = groupKey(it.pn, active);
      const g = groups.get(key) ?? { pns: [], targets: rule ? parsePns(rule.toPns) : [it.pn], entry: 0, returned: 0, diff: 0 };
      if (!g.pns.includes(it.pn)) g.pns.push(it.pn);
      g.entry += it.expected;
      groups.set(key, g);
    }
  }
  const rows = Array.from(groups.values());

  const siblings = movements
    .filter(m => m.kind === "OUT_FORNECEDOR" && norm(m.nf) !== norm(nf) && parseRefs(m.refNf).some(r => refs.includes(r)))
    .map(m => ({ pn: norm(m.pn), qty: m.quantity }));
  const unexpected: MatchResult["unexpected"] = [];
  const own = lines.map(l => ({ pn: norm(l.pn), qty: l.qty }));
  for (const l of [...siblings, ...own]) {
    const g = rows.find(r => r.targets.includes(l.pn));
    if (g) g.returned += l.qty;
    else if (own.includes(l)) unexpected.push(l);
  }
  rows.forEach(r => { r.diff = r.returned - r.entry; });

  const status: MatchStatus = missingRefs.length ? "ref_not_found"
    : unexpected.length || rows.some(r => r.returned > r.entry) ? "diverge"
    : rows.every(r => r.returned === r.entry) ? "match" : "partial";
  return { ...base, missingRefs, rows, unexpected, status };
}

export const matchLabel: Record<MatchStatus, string> = {
  match: "Casou com a NF de referência", partial: "Devolução parcial", diverge: "Não casa com a NF de referência",
  no_ref: "Sem NF de referência", ref_not_found: "NF de referência não encontrada",
};
