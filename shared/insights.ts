import { groupKey, norm, reconcile, type Reconciliation } from "./reconcile";
import { isIn, isOut, type Check, type Inventory, type Movement, type Rule } from "./types";
import { matchLabel, matchReturn, parseRefs, type MatchResult } from "./match";
import { buildShipments, buildTasks, directionLabel, divergences, isoWeek, sideLabel, stageLabel, type Task } from "./checks";

/** Prazos (em dias) usados pelos alertas. */
export const THRESHOLDS = { transitWarn: 3, transitCritical: 7, returnWarn: 15, returnCritical: 30 };

export type Severity = "critical" | "warning" | "info";
export type Level = Severity | "ok";
export type AlertKind =
  | "NOT_RECEIVED_SUPPLIER" | "NOT_RECEIVED_HD" | "QTY_DIVERGENCE"
  | "RECEIPT_WITHOUT_EXIT" | "AGED_PENDING" | "RETURN_WITHOUT_EXIT" | "DUPLICATE"
  | "RETURN_MISMATCH" | "RETURN_NO_REF" | "RETURN_REF_NOT_FOUND"
  | "CHECK_LOAD_PENDING" | "CHECK_RECEIPT_PENDING" | "CHECK_DIVERGENCE"
  | "INVENTORY_PENDING" | "INVENTORY_DIVERGENCE" | "INVENTORY_NOT_GENERATED";

export type Alert = {
  id: string; severity: Severity; kind: AlertKind; title: string; detail: string;
  nf?: string; pn?: string; days?: number; qty?: number;
};
export type OpenLine = { nf: string; pn: string; date: string; qty: number; days: number; kind: Movement["kind"] };
export type ExternalRow = {
  key: string; sourcePns: string[]; targetPns: string[];
  out: number; returned: number; outside: number;
  transitTo: number; atSupplier: number; transitBack: number;
  oldestDate: string; days: number; level: Level;
  outNfs: string[]; openNfs: string[]; lastDate: string;
};
export type OpenDoc = {
  id: string; nf: string; kind: "OUT_HD" | "OUT_FORNECEDOR"; date: string; days: number; qty: number;
  items: { pn: string; qty: number }[]; location: string; level: Level;
};
export type AgingBucket = { label: string; units: number };

export const daysBetween = (from: string, today: string) =>
  Math.max(0, Math.round((Date.parse(today) - Date.parse(from)) / 86400000));

const transitLevel = (d: number): Level => (d >= THRESHOLDS.transitCritical ? "critical" : d >= THRESHOLDS.transitWarn ? "warning" : "info");
const returnLevel = (d: number): Level => (d >= THRESHOLDS.returnCritical ? "critical" : d >= THRESHOLDS.returnWarn ? "warning" : "ok");
const rank: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };
const sum = (l: { qty: number }[]) => l.reduce((s, x) => s + x.qty, 0);
const addTo = (m: Map<string, number>, k: string, v: number) => m.set(k, (m.get(k) ?? 0) + v);

export type ProcessCount = { key: string; label: string; count: number; tab: "checks" | "inventory" };

export type Insights = {
  returnMatches: MatchResult[];
  tasks: Task[];
  process: ProcessCount[];
  checkStats: { open: number; inProgress: number; doneWeek: number; divergences: number };
  inventoryInfo: { week: string; current: Inventory | null; pending: number; status: "none" | "pending" | "counted"; divergence: number };
  recon: Reconciliation;
  alerts: Alert[];
  external: ExternalRow[];
  openDocs: OpenDoc[];
  totals: { outside: number; transitTo: number; atSupplier: number; transitBack: number; oldestDays: number; pnsOutside: number };
  aging: AgingBucket[];
  activity: { date: string; out: number; back: number }[];
};

export function computeInsights(
  movements: Movement[], rules: Rule[], today: string,
  extra: { checks: Check[]; inventories: Inventory[] } = { checks: [], inventories: [] },
): Insights {
  const recon = reconcile(movements, rules);
  const activeRules = rules.filter(r => r.active !== 0);

  const inForn = new Set(movements.filter(m => m.kind === "IN_FORNECEDOR").map(m => norm(m.nf)));
  const inHd = new Set(movements.filter(m => m.kind === "IN_HD").map(m => norm(m.nf)));
  const outHdNfs = new Set(movements.filter(m => m.kind === "OUT_HD").map(m => norm(m.nf)));

  // ---------- documentos em trânsito ----------
  const docMap = new Map<string, Movement[]>();
  for (const m of movements) {
    if (m.kind === "OUT_HD" && !inForn.has(norm(m.nf))) docMap.set(`H|${norm(m.nf)}`, [...(docMap.get(`H|${norm(m.nf)}`) ?? []), m]);
    if (m.kind === "OUT_FORNECEDOR" && !inHd.has(norm(m.nf))) docMap.set(`F|${norm(m.nf)}`, [...(docMap.get(`F|${norm(m.nf)}`) ?? []), m]);
  }
  const openDocs: OpenDoc[] = Array.from(docMap.entries()).map(([k, lines]) => {
    const date = lines.reduce((d, m) => (m.movementDate < d ? m.movementDate : d), lines[0].movementDate);
    const days = daysBetween(date, today);
    const byPn = new Map<string, number>();
    lines.forEach(m => addTo(byPn, norm(m.pn), m.quantity));
    const toSupplier = k.startsWith("H|");
    return {
      id: k, nf: norm(lines[0].nf), kind: (toSupplier ? "OUT_HD" : "OUT_FORNECEDOR") as OpenDoc["kind"], date, days,
      qty: lines.reduce((s, m) => s + m.quantity, 0),
      items: Array.from(byPn, ([pn, qty]) => ({ pn, qty })),
      location: toSupplier ? "Em trânsito → Fornecedor" : "Em trânsito → HD",
      level: transitLevel(days),
    };
  }).sort((a, b) => b.days - a.days);

  // ---------- estoque externo por grupo (consumo FIFO: retorno abate as saídas mais antigas) ----------
  const outsByGroup = new Map<string, Movement[]>();
  for (const m of movements.filter(x => isOut(x.kind)).sort((a, b) => a.movementDate.localeCompare(b.movementDate) || a.id.localeCompare(b.id))) {
    const { key } = groupKey(norm(m.pn), activeRules);
    outsByGroup.set(key, [...(outsByGroup.get(key) ?? []), m]);
  }
  const backLines = movements.filter(m => m.kind === "OUT_FORNECEDOR" && !inHd.has(norm(m.nf)));

  const external: ExternalRow[] = [];
  const openByGroup = new Map<string, OpenLine[]>();
  for (const g of recon.groups) {
    if (g.pending <= 0) continue;
    let credit = g.returned;
    const open: OpenLine[] = [];
    for (const m of outsByGroup.get(g.key) ?? []) {
      const take = Math.min(credit, m.quantity);
      credit -= take;
      const left = m.quantity - take;
      if (left > 0) open.push({ nf: norm(m.nf), pn: norm(m.pn), date: m.movementDate, qty: left, days: daysBetween(m.movementDate, today), kind: m.kind });
    }
    const transitTo = Math.min(g.pending, sum(open.filter(l => l.kind === "OUT_HD" && !inForn.has(l.nf))));
    const related = new Set([...g.sourcePns, ...g.targetPns]);
    const transitBack = Math.min(g.pending - transitTo, backLines.filter(m => related.has(norm(m.pn))).reduce((s, m) => s + m.quantity, 0));
    const oldest = open[0]?.date ?? g.firstDate;
    const days = daysBetween(oldest, today);
    external.push({
      key: g.key, sourcePns: g.sourcePns, targetPns: g.targetPns, out: g.out, returned: g.returned, outside: g.pending,
      transitTo, transitBack, atSupplier: g.pending - transitTo - transitBack,
      oldestDate: oldest, days, level: returnLevel(days), outNfs: g.outNfs,
      openNfs: Array.from(new Set(open.map(l => l.nf))), lastDate: g.lastDate,
    });
    openByGroup.set(g.key, open);
  }
  external.sort((a, b) => b.days - a.days || b.outside - a.outside);

  const totals = {
    outside: external.reduce((s, r) => s + r.outside, 0),
    transitTo: external.reduce((s, r) => s + r.transitTo, 0),
    atSupplier: external.reduce((s, r) => s + r.atSupplier, 0),
    transitBack: external.reduce((s, r) => s + r.transitBack, 0),
    oldestDays: external.reduce((d, r) => Math.max(d, r.days), 0),
    pnsOutside: new Set(external.flatMap(r => r.sourcePns)).size,
  };

  // ---------- aging do saldo fora (por linha de saída em aberto) ----------
  const buckets = [
    { label: "0–3 dias", max: 3, units: 0 }, { label: "4–7 dias", max: 7, units: 0 },
    { label: "8–15 dias", max: 15, units: 0 }, { label: "16–30 dias", max: 30, units: 0 }, { label: "30+ dias", max: Infinity, units: 0 },
  ];
  for (const g of recon.groups) {
    for (const l of openByGroup.get(g.key) ?? []) {
      buckets.find(b => l.days <= b.max)!.units += l.qty;
    }
  }
  const aging: AgingBucket[] = buckets.map(({ label, units }) => ({ label, units }));

  // ---------- alertas ----------
  const alerts: Alert[] = [];
  for (const d of openDocs) {
    const toSupplier = d.kind === "OUT_HD";
    alerts.push({
      id: `doc-${d.id}`, severity: d.level as Severity, days: d.days, nf: d.nf, qty: d.qty,
      kind: toSupplier ? "NOT_RECEIVED_SUPPLIER" : "NOT_RECEIVED_HD",
      title: toSupplier ? `NF ${d.nf} saiu da HD e não deu entrada no fornecedor` : `NF ${d.nf} saiu do fornecedor e não deu entrada na HD`,
      detail: `${d.qty} un · ${d.items.map(i => i.pn).join(", ")} · ${d.days === 0 ? "saiu hoje" : `há ${d.days} dia(s)`}`,
    });
  }

  // divergência de quantidade entre saída e recebimento da mesma NF
  const pair = (outKind: string, inKind: string, label: string) => {
    const nfs = new Set(movements.filter(m => m.kind === outKind).map(m => norm(m.nf)));
    for (const nf of nfs) {
      const recv = movements.filter(m => m.kind === inKind && norm(m.nf) === nf);
      if (!recv.length) continue;
      const sent = new Map<string, number>(), got = new Map<string, number>();
      movements.filter(m => m.kind === outKind && norm(m.nf) === nf).forEach(m => addTo(sent, norm(m.pn), m.quantity));
      recv.forEach(m => addTo(got, norm(m.pn), m.quantity));
      const diffs = Array.from(new Set([...sent.keys(), ...got.keys()]))
        .filter(pn => (sent.get(pn) ?? 0) !== (got.get(pn) ?? 0))
        .map(pn => `${pn}: enviado ${sent.get(pn) ?? 0}, recebido ${got.get(pn) ?? 0}`);
      if (diffs.length) alerts.push({ id: `div-${outKind}-${nf}`, severity: "critical", kind: "QTY_DIVERGENCE", nf, title: `NF ${nf}: divergência entre ${label}`, detail: diffs.join(" · ") });
    }
  };
  pair("OUT_HD", "IN_FORNECEDOR", "saída da HD e entrada no fornecedor");
  pair("OUT_FORNECEDOR", "IN_HD", "saída do fornecedor e entrada na HD");

  for (const nf of new Set(movements.filter(m => m.kind === "IN_FORNECEDOR").map(m => norm(m.nf)))) {
    if (!outHdNfs.has(nf)) alerts.push({ id: `rwe-${nf}`, severity: "warning", kind: "RECEIPT_WITHOUT_EXIT", nf, title: `NF ${nf} entrou no fornecedor sem saída registrada na HD`, detail: "Lance a saída da HD ou confira se o número da NF foi digitado corretamente." });
  }

  for (const r of external) {
    if (r.atSupplier + r.transitBack <= 0 || r.level === "ok") continue;
    alerts.push({
      id: `age-${r.key}`, severity: r.level as Severity, kind: "AGED_PENDING", days: r.days, qty: r.outside, pn: r.sourcePns.join(" + "),
      title: `${r.sourcePns.join(" + ")} fora há ${r.days} dias sem retorno completo`,
      detail: `${r.outside} un ainda não voltaram (esperado: ${r.targetPns.join(" + ")}) · NF ${r.openNfs.join(", ") || r.outNfs.join(", ")}`,
    });
  }

  for (const o of recon.orphans) {
    alerts.push({
      id: `orf-${o.pn}`, severity: "warning", kind: "RETURN_WITHOUT_EXIT", pn: o.pn, qty: o.quantity,
      title: o.excess ? `${o.pn}: voltou mais do que saiu` : `${o.pn} voltou sem saída correspondente`,
      detail: `${o.quantity} un · NF ${o.nfs.join(", ")} · confira PN digitado ou regra de retrabalho`,
    });
  }

  const seen = new Map<string, number>();
  movements.forEach(m => addTo(seen, `${m.kind}|${norm(m.nf)}|${norm(m.pn)}`, 1));
  for (const [k, n] of seen) {
    if (n < 2) continue;
    const [, nf, pn] = k.split("|");
    alerts.push({ id: `dup-${k}`, severity: "info", kind: "DUPLICATE", nf, pn, title: `Possível lançamento duplicado: NF ${nf} · ${pn}`, detail: `${n} lançamentos iguais (mesmo tipo, NF e PN). Se for engano, exclua na aba Movimentações.` });
  }
  // ---------- NF de saída do fornecedor × NF de referência (entrada) ----------
  const returnMatches: MatchResult[] = Array.from(new Set(movements.filter(m => m.kind === "OUT_FORNECEDOR").map(m => norm(m.nf)))).map(nf => {
    const own = movements.filter(m => m.kind === "OUT_FORNECEDOR" && norm(m.nf) === nf);
    const refs = Array.from(new Set(own.flatMap(m => parseRefs(m.refNf))));
    return matchReturn(movements, rules, nf, refs, own.map(m => ({ pn: norm(m.pn), qty: m.quantity })));
  });
  for (const r of returnMatches) {
    const kind = r.status === "diverge" ? "RETURN_MISMATCH" : r.status === "no_ref" ? "RETURN_NO_REF" : r.status === "ref_not_found" ? "RETURN_REF_NOT_FOUND" : null;
    if (!kind) continue;
    const diffs = [
      ...r.rows.filter(x => x.diff !== 0).map(x => `${x.pns.join(" + ")} → ${x.targets.join(" + ")}: entrada ${x.entry}, devolvido ${x.returned}`),
      ...r.unexpected.map(u => `${u.pn}: ${u.qty} un que não vieram na NF de referência`),
    ];
    alerts.push({
      id: `ret-${r.nf}`, severity: r.status === "diverge" ? "critical" : "warning", kind, nf: r.nf,
      title: r.status === "diverge" ? `NF ${r.nf} (saída Vulcano) não casa com a NF de referência ${r.refs.join(", ")}`
        : r.status === "no_ref" ? `NF ${r.nf} (saída Vulcano) sem NF de referência`
        : `NF ${r.nf}: NF de referência ${r.missingRefs.join(", ")} não encontrada`,
      detail: r.status === "diverge" ? diffs.join(" · ") : r.status === "no_ref" ? "Informe a NF de entrada a que esta saída se refere (edite lançando novamente)." : "Só é possível referenciar NFs que a HD já enviou. Confira o número digitado.",
    });
  }

  // ---------- conferências de NF ----------
  const tasks = buildTasks(buildShipments(movements), extra.checks);
  const sevCheck = (d: number): Severity => (d >= 3 ? "critical" : d >= 1 ? "warning" : "info");
  for (const t of tasks) {
    if (t.status === "done") continue;
    const sh = t.shipment;
    const total = sh.items.reduce((s, i) => s + i.expected, 0);
    const where = `${directionLabel(sh.direction)} · ${total} un · ${sh.items.map(i => i.pn).join(", ")}`;
    const progress = t.status === "draft" ? " (conferência em andamento)" : "";
    if (t.stage === "LOAD") {
      const days = daysBetween(sh.date, today);
      alerts.push({ id: `chk-${t.key}`, severity: sevCheck(days), kind: "CHECK_LOAD_PENDING", nf: sh.nf, days, qty: total,
        title: `NF ${sh.nf} lançada sem conferência de carregamento (${sideLabel(t.side)})${progress}`, detail: where });
    } else {
      const load = tasks.find(x => x.shipment.key === sh.key && x.stage === "LOAD");
      const loaded = load?.status === "done";
      if (!loaded && !sh.hasIn) continue; // ainda não foi carregada: o alerta de carregamento já cobre
      const base = loaded && load?.check?.doneAt ? load.check.doneAt.slice(0, 10) : sh.date;
      const days = daysBetween(base, today);
      alerts.push({ id: `chk-${t.key}`, severity: (sh.hasIn ? sevCheck(days) : transitLevel(days)) as Severity, kind: "CHECK_RECEIPT_PENDING", nf: sh.nf, days, qty: total,
        title: `NF ${sh.nf} sem conferência de recebimento (${sideLabel(t.side)})${progress}`,
        detail: `${where} · ${loaded ? "carregamento conferido" : "entrada lançada"} há ${days} dia(s)` });
    }
  }
  const recent = (iso: string | null) => !!iso && daysBetween(iso.slice(0, 10), today) <= 30;
  for (const c of extra.checks) {
    const d = divergences(c);
    if (c.status === "done" && d.length && recent(c.doneAt)) {
      alerts.push({ id: `cdiv-${c.id}`, severity: "critical", kind: "CHECK_DIVERGENCE", nf: c.nf, pn: c.items[0]?.pn,
        title: `Divergência na conferência de ${stageLabel(c.stage).toLowerCase()} da NF ${c.nf}`,
        detail: d.map(i => `${i.pn}: esperado ${i.expected}, contado ${i.counted}`).join(" · ") });
    }
  }

  // ---------- inventário semanal ----------
  const week = isoWeek(today);
  const current = extra.inventories.find(i => i.week === week.id) ?? null;
  const pendingInv = extra.inventories.filter(i => i.status === "pending");
  let invDivergence = 0;
  for (const inv of pendingInv) {
    const days = daysBetween(inv.generatedAt.slice(0, 10), today);
    alerts.push({ id: `inv-${inv.id}`, severity: days >= 7 ? "critical" : days >= 3 ? "warning" : "info", kind: "INVENTORY_PENDING", days,
      title: `Inventário ${inv.week} aguardando contagem da Vulcano`,
      detail: `${inv.lines.length} item(ns) · ${inv.lines.reduce((s, l) => s + l.expected, 0)} un esperadas · gerado em ${inv.generatedAt.slice(0, 10).split("-").reverse().join("/")}` });
  }
  for (const inv of extra.inventories.filter(i => i.status === "counted" && recent(i.countedAt))) {
    const diff = inv.lines.filter(l => l.counted != null && l.counted !== l.expected);
    if (!diff.length) continue;
    if (inv.week === week.id) invDivergence = diff.length;
    alerts.push({ id: `idiv-${inv.id}`, severity: "critical", kind: "INVENTORY_DIVERGENCE",
      title: `Inventário ${inv.week} contado com divergência`,
      detail: diff.map(l => `${l.label}: esperado ${l.expected}, contado ${l.counted}`).join(" · ") });
  }
  if (!current && totals.atSupplier > 0) {
    alerts.push({ id: `inv-missing-${week.id}`, severity: "info", kind: "INVENTORY_NOT_GENERATED",
      title: `Inventário da semana ${week.id} ainda não foi gerado pela HD`, detail: `Há ${totals.atSupplier} un estimadas na Vulcano. Gere o inventário na aba Inventário.` });
  }

  const open = tasks.filter(t => t.status !== "done");
  const proc = (side: "HD" | "VULCANO", stage: "LOAD" | "RECEIPT") => open.filter(t => t.side === side && t.stage === stage).length;
  const process: ProcessCount[] = [
    { key: "hd-load", label: "Carregamento a conferir (HD)", count: proc("HD", "LOAD"), tab: "checks" },
    { key: "vul-receipt", label: "Recebimento a conferir (Vulcano)", count: tasks.filter(t => t.status !== "done" && t.side === "VULCANO" && t.stage === "RECEIPT" && !t.waitingLoad).length, tab: "checks" },
    { key: "vul-load", label: "Carregamento a conferir (Vulcano)", count: proc("VULCANO", "LOAD"), tab: "checks" },
    { key: "hd-receipt", label: "Recebimento a conferir (HD)", count: tasks.filter(t => t.status !== "done" && t.side === "HD" && t.stage === "RECEIPT" && !t.waitingLoad).length, tab: "checks" },
    { key: "inventory", label: "Inventário aguardando contagem (Vulcano)", count: pendingInv.length, tab: "inventory" },
  ];
  const checkStats = {
    open: open.length,
    inProgress: open.filter(t => t.status === "draft").length,
    doneWeek: extra.checks.filter(c => c.status === "done" && c.doneAt && c.doneAt.slice(0, 10) >= week.start).length,
    divergences: extra.checks.filter(c => c.status === "done" && recent(c.doneAt) && divergences(c).length).length,
  };
  const inventoryInfo = { week: week.id, current, pending: pendingInv.length, status: (current ? current.status : "none") as "none" | "pending" | "counted", divergence: invDivergence };

  alerts.sort((a, b) => rank[a.severity] - rank[b.severity] || (b.days ?? 0) - (a.days ?? 0));

  // ---------- atividade dos últimos 14 dias ----------
  const activity: Insights["activity"] = [];
  for (let i = 13; i >= 0; i--) {
    const date = new Date(Date.parse(today) - i * 86400000).toISOString().slice(0, 10);
    activity.push({
      date,
      out: movements.filter(m => isOut(m.kind) && m.movementDate === date).reduce((s, m) => s + m.quantity, 0),
      back: movements.filter(m => isIn(m.kind) && m.movementDate === date).reduce((s, m) => s + m.quantity, 0),
    });
  }

  return { returnMatches, recon, alerts, external, openDocs, totals, aging, activity, tasks, process, checkStats, inventoryInfo };
}

export { matchLabel };
