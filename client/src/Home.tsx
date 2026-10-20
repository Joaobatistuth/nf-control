import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  ArrowDownToLine, ArrowUpFromLine, BarChart3, Check, ChevronRight, CircleAlert, Download, FileSpreadsheet, Filter,
  Clock, Info, KeyRound, LayoutDashboard, LockKeyhole, PackageCheck, Plus, RefreshCcw, Settings2, ShieldCheck, Trash2, TrendingUp,
  Truck, TriangleAlert, Warehouse, X, ClipboardCheck, ClipboardList, History as HistoryIcon,
} from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { errMsg, formatDate, formatNumber, todayStr } from "@/lib/format";
import { ChecksTab } from "@/pages/Checks";
import { HistoryTab } from "@/pages/History";
import { InventoryTab } from "@/pages/Inventory";
import { norm, type Group, type Status } from "@shared/reconcile";
import { matchLabel, matchReturn, parseRefs, type MatchStatus } from "@shared/match";
import { buildShipments } from "@shared/checks";
import { computeInsights, THRESHOLDS, type Alert, type Level, type Severity } from "@shared/insights";
import { isIn, isOut, type Check as CheckRecord, type Inventory, type Kind, type Movement, type Rule } from "@shared/types";

type Tab = "dashboard" | "external" | "checks" | "history" | "inventory" | "movements" | "rules";
type MovementForm = { kind: Kind; nf: string; refNf: string; movementDate: string; items: { pn: string; quantity: string }[]; notes: string };
type RuleForm = { fromPns: string; toPns: string; description: string; active: boolean };

const emptyRule: RuleForm = { fromPns: "", toPns: "", description: "", active: true };
const emptyMovement = (kind: Kind = "OUT_HD"): MovementForm => ({ kind, nf: "", refNf: "", movementDate: todayStr(), items: [{ pn: "", quantity: "" }], notes: "" });

const kindMeta: Record<Kind, { label: string; short: string; tone: "out" | "in" }> = {
  OUT_HD: { label: "Saída HD → Fornecedor", short: "Saída HD", tone: "out" },
  IN_FORNECEDOR: { label: "Entrada no Fornecedor", short: "Entrada Fornecedor", tone: "in" },
  OUT_FORNECEDOR: { label: "Saída Fornecedor → HD", short: "Saída Fornecedor", tone: "out" },
  IN_HD: { label: "Entrada na HD", short: "Entrada HD", tone: "in" },
  OUT: { label: "Saída HD", short: "Saída HD", tone: "out" },
  IN: { label: "Entrada HD", short: "Entrada HD", tone: "in" },
};

const has = (hay: string[] | string, needle: string) => {
  const n = norm(needle);
  return !n || (Array.isArray(hay) ? hay : [hay]).some(h => norm(h).includes(n));
};
// Evita "injeção de fórmula" ao abrir o CSV no Excel.
const csvEscape = (v: unknown) => {
  let t = String(v ?? "");
  if (/^[=+\-@\t\r]/.test(t) && !/^-?\d+([.,]\d+)?$/.test(t)) t = `'${t}`;
  return `"${t.replace(/"/g, '""')}"`;
};

type InvRow = {
  status: "matched" | "pending" | "orphan"; statusLabel: string;
  sourcePn: string; sourceNf: string; sourceQty: number;
  returnPn: string; returnNf: string; returnQty: number; balance: number;
};

export default function Home() {
  const [tab, setTab] = useState<Tab>("dashboard");
  const [movements, setMovements] = useState<Movement[]>([]);
  const [rules, setRules] = useState<Rule[]>([]);
  const [checks, setChecks] = useState<CheckRecord[]>([]);
  const [inventories, setInventories] = useState<Inventory[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [lastSync, setLastSync] = useState<Date | null>(null);
  const [saving, setSaving] = useState(false);

  const [filters, setFilters] = useState({ from: "", to: "", nf: "", pn: "" });
  const [statusFilter, setStatusFilter] = useState<"all" | Status>("all");
  const [alertFilter, setAlertFilter] = useState<"all" | Severity>("all");
  const [showAllAlerts, setShowAllAlerts] = useState(false);
  const [showMovementForm, setShowMovementForm] = useState(false);
  const [movementForm, setMovementForm] = useState<MovementForm>(emptyMovement());

  const [rulesUnlocked, setRulesUnlocked] = useState(false);
  const [password, setPassword] = useState("");
  const [unlocking, setUnlocking] = useState(false);
  const [ruleForm, setRuleForm] = useState<RuleForm>(emptyRule);
  const [editingRuleId, setEditingRuleId] = useState<string | null>(null);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const [m, r, s, c, inv] = await Promise.all([api.listMovements(), api.listRules(), api.rulesStatus(), api.listChecks(), api.listInventories()]);
      setMovements(m); setRules(r); setRulesUnlocked(s.unlocked); setChecks(c); setInventories(inv);
      setLoadError(null); setLastSync(new Date());
    } catch (e) {
      setLoadError(errMsg(e, "Não foi possível carregar os dados."));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);
  // HD e Vulcano usam aparelhos diferentes: atualiza sozinho a cada 60 s (sem mexer nos formulários abertos).
  useEffect(() => {
    const t = setInterval(() => { if (document.visibilityState === "visible") load(true); }, 60000);
    return () => clearInterval(t);
  }, [load]);
  const upsertCheck = (c: CheckRecord) => setChecks(cur => [c, ...cur.filter(x => x.id !== c.id)]);
  const upsertInventory = (i: Inventory) => setInventories(cur => [i, ...cur.filter(x => x.id !== i.id)].sort((a, b) => b.week.localeCompare(a.week)));

  // ---------- derivados ----------
  const insights = useMemo(() => computeInsights(movements, rules, todayStr(), { checks, inventories }), [movements, rules, checks, inventories]);
  const { recon, alerts, external, openDocs, aging, activity, tasks, process, checkStats, inventoryInfo } = insights;
  const ext = insights.totals;
  const alertCount = useMemo(() => ({
    critical: alerts.filter(a => a.severity === "critical").length,
    warning: alerts.filter(a => a.severity === "warning").length,
    info: alerts.filter(a => a.severity === "info").length,
  }), [alerts]);
  const visibleAlerts = alerts.filter(a => alertFilter === "all" || a.severity === alertFilter);

  const filteredExternal = useMemo(() => external.filter(r =>
    (!filters.from || r.lastDate >= filters.from) && (!filters.to || r.lastDate <= filters.to) &&
    has([...r.outNfs, ...r.openNfs], filters.nf) && has([...r.sourcePns, ...r.targetPns], filters.pn)), [external, filters]);
  const filteredDocs = useMemo(() => openDocs.filter(d =>
    (!filters.from || d.date >= filters.from) && (!filters.to || d.date <= filters.to) &&
    has(d.nf, filters.nf) && has(d.items.map(i => i.pn), filters.pn)), [openDocs, filters]);

  const filteredMovements = useMemo(() => movements.filter(m =>
    (!filters.from || m.movementDate >= filters.from) && (!filters.to || m.movementDate <= filters.to) &&
    has(m.nf, filters.nf) && has(m.pn, filters.pn)), [movements, filters]);

  const filteredTasks = useMemo(() => tasks.filter(t =>
    (!filters.from || t.shipment.date >= filters.from) && (!filters.to || t.shipment.date <= filters.to) &&
    has(t.shipment.nf, filters.nf) && has(t.shipment.items.map(i => i.pn), filters.pn)), [tasks, filters]);
  const checkBadge = tasks.filter(t => t.status !== "done" && !t.waitingLoad).length;

  const matchByNf = useMemo(() => new Map(insights.returnMatches.map(r => [r.nf, r])), [insights.returnMatches]);
  const entryNfs = useMemo(() => buildShipments(movements).filter(s => s.direction === "HD_TO_VULCANO").map(s => s.nf), [movements]);
  const draftMatch = useMemo(() => {
    if (!showMovementForm || movementForm.kind !== "OUT_FORNECEDOR") return null;
    const refs = parseRefs(movementForm.refNf);
    if (!refs.length) return null;
    const lines = movementForm.items.map(i => ({ pn: i.pn.trim(), qty: Number(i.quantity) })).filter(i => i.pn && Number.isInteger(i.qty) && i.qty > 0);
    return matchReturn(movements, rules, movementForm.nf, refs, lines);
  }, [showMovementForm, movementForm, movements, rules]);

  const filteredGroups = useMemo(() => recon.groups.filter((g: Group) =>
    (statusFilter === "all" || g.status === statusFilter) &&
    (!filters.from || g.lastDate >= filters.from) && (!filters.to || g.lastDate <= filters.to) &&
    has([...g.outNfs, ...g.returnNfs], filters.nf) && has([...g.sourcePns, ...g.targetPns], filters.pn)), [recon, statusFilter, filters]);

  const inventoryRows: InvRow[] = useMemo(() => {
    const rows: InvRow[] = filteredGroups.map(g => ({
      status: g.pending === 0 ? "matched" : "pending",
      statusLabel: g.pending === 0 ? "Saiu e voltou" : g.returned > 0 ? "Retorno parcial" : "Saiu e não voltou",
      sourcePn: g.sourcePns.join(" + "), sourceNf: g.outNfs.join(" + "), sourceQty: g.out,
      returnPn: g.targetPns.join(" + "), returnNf: g.returnNfs.join(" + ") || "—", returnQty: g.returned, balance: g.pending,
    }));
    if (statusFilter === "all") {
      for (const o of recon.orphans) {
        if ((filters.from && o.lastDate < filters.from) || (filters.to && o.lastDate > filters.to)) continue;
        if (!has(o.nfs, filters.nf) || !has(o.pn, filters.pn)) continue;
        rows.push({
          status: "orphan", statusLabel: o.excess ? "Retorno excedente" : "Voltou sem saída",
          sourcePn: "—", sourceNf: "—", sourceQty: 0, returnPn: o.pn, returnNf: o.nfs.join(" + "), returnQty: o.quantity, balance: 0,
        });
      }
    }
    return rows;
  }, [filteredGroups, recon.orphans, filters, statusFilter]);

  const totals = useMemo(() => {
    const out = movements.filter(m => isOut(m.kind)).reduce((s, m) => s + m.quantity, 0);
    const returnedAll = movements.filter(m => isIn(m.kind)).reduce((s, m) => s + m.quantity, 0);
    const matched = recon.groups.reduce((s, g) => s + g.returned, 0);
    return {
      out, returnedAll, matched,
      pending: recon.groups.reduce((s, g) => s + g.pending, 0),
      complete: recon.groups.filter(g => g.status === "complete").length,
      rate: out ? Math.round((matched / out) * 100) : 0,
    };
  }, [movements, recon]);

  const stats = useMemo(() => ({
    nfs: new Set(movements.map(m => norm(m.nf))).size,
    pns: new Set(movements.map(m => norm(m.pn))).size,
    pendingPns: recon.groups.filter(g => g.pending > 0).length,
    attention: recon.groups.filter(g => g.status !== "complete").length + recon.orphans.length,
    invMatched: inventoryRows.filter(r => r.status === "matched").length,
    invPending: inventoryRows.filter(r => r.status === "pending").length,
    invOrphan: inventoryRows.filter(r => r.status === "orphan").length,
  }), [movements, recon, inventoryRows]);

  const nfTracking = useMemo(() => {
    const inForn = new Set(movements.filter(m => m.kind === "IN_FORNECEDOR").map(m => norm(m.nf)));
    const inHd = new Set(movements.filter(m => m.kind === "IN_HD").map(m => norm(m.nf)));
    return filteredMovements.map(m => {
      const nf = norm(m.nf);
      const status =
        m.kind === "OUT_HD" ? (inForn.has(nf) ? "Recebida fornecedor" : "Aguardando fornecedor")
        : m.kind === "OUT_FORNECEDOR" ? (inHd.has(nf) ? "Recebida HD" : "Aguardando HD")
        : m.kind === "IN_FORNECEDOR" ? "Recebida fornecedor"
        : m.kind === "IN_HD" ? "Recebida HD" : "Registrada";
      return { ...m, status };
    });
  }, [filteredMovements, movements]);

  // ---------- ações ----------
  async function handleMovementSubmit(event: React.FormEvent) {
    event.preventDefault();
    const items = movementForm.items
      .map(i => ({ pn: i.pn.trim(), quantity: Number(i.quantity) }))
      .filter(i => i.pn && Number.isInteger(i.quantity) && i.quantity > 0);
    const incomplete = movementForm.items.some(i => (i.pn.trim() || i.quantity) && !(i.pn.trim() && Number.isInteger(Number(i.quantity)) && Number(i.quantity) > 0));
    if (!movementForm.nf.trim() || !movementForm.movementDate || !items.length) return toast.error("Preencha NF, data e pelo menos um PN com quantidade inteira válida.");
    if (incomplete) return toast.error("Há itens incompletos ou com quantidade inválida. Corrija ou remova a linha.");
    if (movementForm.kind === "OUT_FORNECEDOR") {
      const refs = parseRefs(movementForm.refNf);
      if (!refs.length) return toast.error("Informe a NF de referência (a NF de entrada a que esta saída se refere).");
      const m = matchReturn(movements, rules, movementForm.nf, refs, items.map(i => ({ pn: i.pn, qty: i.quantity })));
      if (m.status === "ref_not_found") return toast.error(`NF de referência não encontrada: ${m.missingRefs.join(", ")}. Lance antes a saída da HD correspondente.`);
      if (m.status === "diverge" && !window.confirm("Os PNs/quantidades NÃO casam com a NF de referência.\n\nSalvar mesmo assim? Será gerado um alerta crítico.")) return;
    }
    setSaving(true);
    try {
      const created = await api.createMovements({ kind: movementForm.kind, nf: movementForm.nf, refNf: movementForm.refNf, movementDate: movementForm.movementDate, items, notes: movementForm.notes });
      setMovements(cur => [...created, ...cur].sort((a, b) => b.movementDate.localeCompare(a.movementDate) || b.id.localeCompare(a.id)));
      setLastSync(new Date());
      toast.success(`${kindMeta[movementForm.kind].short} registrada com ${created.length} PN(s).`);
      setMovementForm(emptyMovement(movementForm.kind));
      setShowMovementForm(false);
    } catch (e) {
      toast.error(errMsg(e, "Não foi possível salvar. Nada foi registrado."));
    } finally {
      setSaving(false);
    }
  }

  async function removeMovement(m: Movement) {
    if (!window.confirm(`Excluir o lançamento ${m.nf} · ${m.pn} · ${formatNumber(m.quantity)} un?\nEsta ação não pode ser desfeita.`)) return;
    try {
      await api.deleteMovement(m.id);
      setMovements(cur => cur.filter(x => x.id !== m.id));
      toast.success("Lançamento excluído.");
    } catch (e) { toast.error(errMsg(e, "Não foi possível excluir.")); }
  }

  async function unlockRules(event: React.FormEvent) {
    event.preventDefault();
    setUnlocking(true);
    try {
      const r = await api.unlock(password);
      if (r.success) { setRulesUnlocked(true); setPassword(""); toast.success("Área de regras liberada por 2 horas."); }
      else toast.error("Senha inválida. Verifique e tente novamente.");
    } catch (e) { toast.error(errMsg(e, "Não foi possível validar a senha agora.")); }
    finally { setUnlocking(false); }
  }

  async function lockRules() {
    try { await api.lock(); } catch { /* ignora */ }
    setRulesUnlocked(false);
  }

  function handleRuleError(e: unknown) {
    if (e instanceof ApiError && e.status === 403) { setRulesUnlocked(false); toast.error("Sessão expirada. Digite a senha novamente."); }
    else toast.error(errMsg(e, "Não foi possível salvar a regra."));
  }

  async function saveRule(event: React.FormEvent) {
    event.preventDefault();
    if (!ruleForm.fromPns.trim() || !ruleForm.toPns.trim()) return toast.error("Informe os PNs de saída e de retorno.");
    const payload = { fromPns: ruleForm.fromPns, toPns: ruleForm.toPns, description: ruleForm.description, active: ruleForm.active ? 1 : 0 };
    try {
      if (editingRuleId) {
        const updated = await api.updateRule(editingRuleId, payload);
        setRules(cur => cur.map(r => (r.id === updated.id ? updated : r)));
        toast.success("Regra atualizada.");
      } else {
        const created = await api.createRule(payload);
        setRules(cur => [created, ...cur]);
        toast.success("Regra cadastrada.");
      }
      setEditingRuleId(null); setRuleForm(emptyRule);
    } catch (e) { handleRuleError(e); }
  }

  async function removeRule(rule: Rule) {
    if (!window.confirm("Excluir esta regra? A conciliação será recalculada sem ela.")) return;
    try {
      await api.deleteRule(rule.id);
      setRules(cur => cur.filter(r => r.id !== rule.id));
      if (editingRuleId === rule.id) { setEditingRuleId(null); setRuleForm(emptyRule); }
      toast.success("Regra removida.");
    } catch (e) { handleRuleError(e); }
  }

  function focusAlert(a: Alert) {
    setFilters({ from: "", to: "", nf: a.nf ?? "", pn: a.pn ? a.pn.split(" + ")[0] : "" });
    setStatusFilter("all");
    setTab(a.kind === "DUPLICATE" || a.kind.startsWith("RETURN_") ? "movements" : a.kind.startsWith("CHECK_") ? "checks" : a.kind.startsWith("INVENTORY_") ? "inventory" : "external");
  }

  function exportCsv() {
    if (tab === "external") {
      const rows = filteredExternal.map(r => [r.sourcePns.join(" + "), r.targetPns.join(" + "), r.out, r.returned, r.outside, r.transitTo, r.atSupplier, r.transitBack, formatDate(r.oldestDate), r.days, r.openNfs.join(" + ")]);
      if (!rows.length) return toast.error("Não há estoque externo com os filtros atuais.");
      return download([["PN enviado", "PN esperado de volta", "Saiu", "Voltou", "Fora da HD", "Em trânsito → Fornecedor", "No fornecedor (estimado)", "Em trânsito → HD", "Saída mais antiga em aberto", "Dias fora", "NF(s) em aberto"], ...rows], "estoque-externo");
    }
    const dash = tab === "dashboard";
    const header = dash
      ? ["Situação", "PN de saída", "NF de saída", "Qtd. saída", "PN relacionado", "NF de retorno", "Qtd. retorno", "Saldo pendente"]
      : ["Tipo", "NF", "Data", "PN", "Quantidade", "Observações"];
    const rows = dash
      ? inventoryRows.map(i => [i.statusLabel, i.sourcePn, i.sourceNf, i.sourceQty, i.returnPn, i.returnNf, i.returnQty, i.balance])
      : filteredMovements.map(m => [kindMeta[m.kind].label, m.nf, formatDate(m.movementDate), m.pn, m.quantity, m.notes ?? ""]);
    if (!rows.length) return toast.error("Não há dados para exportar com os filtros atuais.");
    download([header, ...rows], dash ? "inventario" : "movimentacoes");
  }

  function download(table: unknown[][], name: string) {
    const csv = table.map(r => r.map(csvEscape).join(";")).join("\r\n");
    const url = URL.createObjectURL(new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8;" }));
    const a = document.createElement("a");
    a.href = url; a.download = `nf-control-${name}-${todayStr()}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast.success("Planilha exportada (CSV, abre no Excel).");
  }

  const setLine = (index: number, patch: Partial<{ pn: string; quantity: string }>) =>
    setMovementForm(f => ({ ...f, items: f.items.map((l, i) => (i === index ? { ...l, ...patch } : l)) }));

  const navItems: { id: Tab; label: string; icon: typeof LayoutDashboard; detail: string }[] = [
    { id: "dashboard", label: "Dashboard", icon: LayoutDashboard, detail: "Visão geral" },
    { id: "external", label: "Estoque externo", icon: Warehouse, detail: "Tudo que está fora da HD" },
    { id: "checks", label: "Conferência", icon: ClipboardCheck, detail: "Carregamento e recebimento" },
    { id: "history", label: "Histórico", icon: HistoryIcon, detail: "Conferências enviadas" },
    { id: "inventory", label: "Inventário", icon: ClipboardList, detail: "Contagem semanal" },
    { id: "movements", label: "Movimentações", icon: FileSpreadsheet, detail: "Registrar NFs" },
    { id: "rules", label: "Regras de retrabalho", icon: Settings2, detail: "Área protegida" },
  ];
  const monthLabel = new Date().toLocaleDateString("pt-BR", { month: "long", year: "numeric" }).toUpperCase();
  const online = !loadError;

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand-block">
        <div className="brand-logo-wrap"><Logo /></div>
        <div><strong>NF CONTROL</strong><span>rastreabilidade industrial</span></div>
      </div>
      <div className="workspace-label">CENTRAL OPERACIONAL</div>
      <nav className="side-nav" aria-label="Navegação principal">
        {navItems.map(item => { const Icon = item.icon; return <button key={item.id} className={`nav-item ${tab === item.id ? "active" : ""}`} onClick={() => setTab(item.id)}>
          <Icon size={18} /><span><b>{item.label}</b><small>{item.detail}</small></span>
          {item.id === "dashboard" && alertCount.critical + alertCount.warning > 0 && <em className={`nav-badge ${alertCount.critical ? "critical" : ""}`}>{alertCount.critical + alertCount.warning}</em>}
          {item.id === "checks" && checkBadge > 0 && <em className="nav-badge">{checkBadge}</em>}
          {item.id === "inventory" && inventoryInfo.pending > 0 && <em className="nav-badge">{inventoryInfo.pending}</em>}
          {tab === item.id && <ChevronRight size={15} className="nav-arrow" />}
        </button>; })}
      </nav>
      <div className="sidebar-bottom">
        <div className="status-card"><span className={`status-dot ${online ? "" : "off"}`} /><div><strong>{online ? "Dados sincronizados" : "Sem conexão"}</strong><small>{lastSync ? `Última leitura ${lastSync.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}` : "Aguardando servidor"}</small></div></div>
      </div>
    </aside>

    <main className="main-content">
      <header className="topbar">
        <div className="breadcrumb"><span>NF CONTROL</span><ChevronRight size={14} /><strong>{navItems.find(i => i.id === tab)?.label}</strong></div>
        <div className="topbar-actions">
          <button className="btn btn-sm" onClick={() => load(true).then(() => toast.success("Dados atualizados."))}><RefreshCcw size={14} /> Atualizar</button>
          {(tab === "dashboard" || tab === "external" || tab === "movements") && <button className="btn btn-sm" onClick={exportCsv}><Download size={15} /> Exportar planilha</button>}
        </div>
      </header>

      <div className="content-wrap">
        {loadError && <div className="load-banner"><span><b>Falha ao carregar:</b> {loadError}</span><button className="btn btn-sm" onClick={() => load()}>Tentar novamente</button></div>}

        <section className="page-heading">
          <div>
            <div className="eyebrow">CONTROLE DE FLUXO · {monthLabel}</div>
            <h1>{tab === "dashboard" ? "Painel de inventário: saída, retorno e pendências." : tab === "external" ? "Tudo o que está fora da HD, em tempo real." : tab === "checks" ? "Confira cada NF: carga e recebimento." : tab === "history" ? "Histórico de conferências e inventários." : tab === "inventory" ? "Inventário semanal da Vulcano." : tab === "movements" ? "Registre cada movimentação." : "Mapeie o retrabalho com precisão."}</h1>
            <p>{tab === "dashboard" ? "Alertas, prazos e o casamento entre saída e retorno por PN, NF e quantidade." : tab === "external" ? "Saldo por PN, onde ele está (trânsito ou fornecedor), há quantos dias e quais NFs seguem em aberto." : tab === "checks" ? "Marque os itens conferidos, anexe a foto e envie. Quem emite confere a carga; quem recebe confere o recebimento." : tab === "history" ? "Tudo o que já foi conferido, com responsável, fotos, divergências e comentários salvos." : tab === "inventory" ? "A HD gera o inventário da semana com senha e a Vulcano faz a contagem." : tab === "movements" ? "Mantenha o histórico de saída e entrada dos PNs em um único lugar." : "Defina como um PN se transforma antes de casar as quantidades no dashboard."}</p>
          </div>
          {tab === "movements" && <button className="btn primary-cta" onClick={() => setShowMovementForm(true)}><Plus size={17} /> Registrar movimentação</button>}
          {tab === "rules" && rulesUnlocked && <div style={{ display: "flex", gap: 8 }}>
            <button className="btn" onClick={lockRules}><LockKeyhole size={15} /> Bloquear</button>
            <button className="btn primary-cta" onClick={() => { setEditingRuleId(null); setRuleForm(emptyRule); }}><Plus size={17} /> Nova regra</button>
          </div>}
        </section>

        {tab !== "rules" && tab !== "inventory" && <section className="filters-bar">
          <div className="filter-title"><Filter size={15} /><span>Filtros</span></div>
          <label>De<input type="date" value={filters.from} onChange={e => setFilters({ ...filters, from: e.target.value })} /></label>
          <label>Até<input type="date" value={filters.to} onChange={e => setFilters({ ...filters, to: e.target.value })} /></label>
          <label>NF<input placeholder="Ex.: 45321" value={filters.nf} onChange={e => setFilters({ ...filters, nf: e.target.value })} /></label>
          <label>PN<input placeholder="Ex.: 842-11" value={filters.pn} onChange={e => setFilters({ ...filters, pn: e.target.value })} /></label>
          <button className="clear-filter" onClick={() => { setFilters({ from: "", to: "", nf: "", pn: "" }); setStatusFilter("all"); }}><X size={14} /> Limpar</button>
        </section>}

        {loading && !movements.length ? <div className="panel"><EmptyState text="Carregando dados…" /></div> : <>

        {tab === "dashboard" && <>
          <section className="panel alert-center">
            <div className="panel-header"><div><div className="panel-kicker">CENTRAL DE ALERTAS</div><h2>O que precisa de atenção agora</h2></div>
              <div className="alert-chips">
                <button className={`alert-chip ${alertFilter === "all" ? "on" : ""}`} onClick={() => setAlertFilter("all")}>Todos <b>{alerts.length}</b></button>
                <button className={`alert-chip critical ${alertFilter === "critical" ? "on" : ""}`} onClick={() => setAlertFilter("critical")}>Críticos <b>{alertCount.critical}</b></button>
                <button className={`alert-chip warning ${alertFilter === "warning" ? "on" : ""}`} onClick={() => setAlertFilter("warning")}>Atenção <b>{alertCount.warning}</b></button>
                <button className={`alert-chip info ${alertFilter === "info" ? "on" : ""}`} onClick={() => setAlertFilter("info")}>Informativos <b>{alertCount.info}</b></button>
              </div></div>
            {visibleAlerts.length ? <div className="alert-list">
              {(showAllAlerts ? visibleAlerts : visibleAlerts.slice(0, 6)).map(a => <div className={`alert-row ${a.severity}`} key={a.id}>
                <span className="alert-icon">{a.severity === "info" ? <Info size={15} /> : <TriangleAlert size={15} />}</span>
                <div className="alert-text"><strong>{a.title}</strong><small>{a.detail}</small></div>
                {a.days != null && <span className="alert-days"><Clock size={11} /> {a.days}d</span>}
                <button className="btn btn-sm" onClick={() => focusAlert(a)}>Ver</button>
              </div>)}
            </div> : <div className="alert-ok"><ShieldCheck size={17} /> {alerts.length ? "Nenhum alerta nesta categoria." : "Tudo em dia: nenhuma NF parada, divergência ou retorno atrasado."}</div>}
            {visibleAlerts.length > 6 && <button className="alert-more" onClick={() => setShowAllAlerts(v => !v)}>{showAllAlerts ? "Mostrar menos" : `Ver todos os ${visibleAlerts.length} alertas`}</button>}
            <div className="alert-foot">Prazos: NF em trânsito vira atenção após {THRESHOLDS.transitWarn} dias e crítica após {THRESHOLDS.transitCritical}; saldo sem retorno vira atenção após {THRESHOLDS.returnWarn} dias e crítico após {THRESHOLDS.returnCritical}.</div>
          </section>

          <section className="insight-grid two">
            <div className="panel insight-panel"><div className="panel-kicker">PENDÊNCIAS POR PROCESSO</div><h2>Conferência e inventário</h2>
              <div className="process-list">{process.map(p => <div className="process-row" key={p.key}>
                <span>{p.label}</span><b className={p.count ? "pending-text" : "ok-text"}>{p.count}</b>
                <button className="btn btn-sm" onClick={() => setTab(p.tab)}>Abrir</button></div>)}</div></div>
            <div className="panel insight-panel"><div className="panel-kicker">INDICADORES DE CONFERÊNCIA</div><h2>Situação da semana</h2>
              <div className="turn-summary">
                <div className="summary-row"><span>Conferências em aberto</span><strong className={checkStats.open ? "pending-text" : "ok-text"}>{checkStats.open}</strong></div>
                <div className="summary-row"><span>Em andamento</span><strong>{checkStats.inProgress}</strong></div>
                <div className="summary-row"><span>Conferidas na semana</span><strong className="ok-text">{checkStats.doneWeek}</strong></div>
                <div className="summary-row"><span>Divergências (30 dias)</span><strong className={checkStats.divergences ? "pending-text" : ""}>{checkStats.divergences}</strong></div>
                <div className="summary-row"><span>Inventário {inventoryInfo.week}</span><strong className={inventoryInfo.status === "counted" ? "ok-text" : "pending-text"}>{inventoryInfo.status === "none" ? "Não gerado" : inventoryInfo.status === "pending" ? "Aguardando Vulcano" : inventoryInfo.divergence ? `Contado · ${inventoryInfo.divergence} diverg.` : "Contado"}</strong></div>
              </div></div>
          </section>

          <section className="metric-grid">
            <Metric icon={ArrowUpFromLine} label="Total em saída" value={`${formatNumber(totals.out)} un`} detail="Quantidade enviada" tone="navy" />
            <Metric icon={ArrowDownToLine} label="Total retornado" value={`${formatNumber(totals.returnedAll)} un`} detail={`${formatNumber(totals.matched)} un casadas com saídas`} tone="green" />
            <Metric icon={Warehouse} label="Fora da HD agora" value={`${formatNumber(ext.outside)} un`} detail={`${ext.pnsOutside} PN(s) com saldo aberto`} tone="orange" />
            <Metric icon={Check} label="Taxa de retorno" value={`${totals.rate}%`} detail={`${formatNumber(stats.pns)} PNs · ${formatNumber(stats.nfs)} NFs`} tone="green" />
            <Metric icon={Truck} label="Em trânsito → fornecedor" value={`${formatNumber(ext.transitTo)} un`} detail={`${openDocs.filter(d => d.kind === "OUT_HD").length} NF(s) sem entrada`} tone="orange" />
            <Metric icon={PackageCheck} label="No fornecedor (estimado)" value={`${formatNumber(ext.atSupplier)} un`} detail="Recebido e ainda não devolvido" tone="blue" />
            <Metric icon={Truck} label="Em trânsito → HD" value={`${formatNumber(ext.transitBack)} un`} detail={`${openDocs.filter(d => d.kind === "OUT_FORNECEDOR").length} NF(s) sem entrada`} tone="green" />
            <Metric icon={Clock} label="Saldo mais antigo" value={ext.outside ? `${ext.oldestDays} dias` : "—"} detail={ext.outside ? "Tempo da saída mais antiga em aberto" : "Nada em aberto"} tone={ext.oldestDays >= THRESHOLDS.returnWarn ? "orange" : "navy"} />
          </section>

          <section className="insight-grid">
            <div className="panel insight-panel"><div className="panel-kicker">TEMPO FORA DA HD</div><h2>Saldo por idade</h2><AgingBars aging={aging} /></div>
            <div className="panel insight-panel"><div className="panel-kicker">MAIORES SALDOS FORA</div><h2>Top 5 PNs</h2>
              {external.length ? <div className="bar-list">{[...external].sort((a, b) => b.outside - a.outside).slice(0, 5).map(r => {
                const max = Math.max(...external.map(x => x.outside));
                return <div className="bar-row" key={r.key}><span className="mono bar-label">{r.sourcePns.join(" + ")}</span><div className="bar-track"><i style={{ width: `${(r.outside / max) * 100}%` }} /></div><b>{formatNumber(r.outside)}</b></div>;
              })}</div> : <EmptyState text="Nada fora da HD." />}</div>
            <div className="panel insight-panel"><div className="panel-kicker">ÚLTIMOS 14 DIAS</div><h2>Saídas x retornos</h2><ActivityChart data={activity} /></div>
          </section>

          <section className="inventory-strip">
            <div className="inventory-card matched"><span className="inventory-icon"><Check size={15} /></span><div><small>INVENTÁRIO CASADO</small><strong>{stats.invMatched} posição(ões)</strong><span>Saíram e voltaram</span></div></div>
            <div className="inventory-card pending"><span className="inventory-icon"><CircleAlert size={15} /></span><div><small>INVENTÁRIO PENDENTE</small><strong>{stats.invPending} posição(ões)</strong><span>Saíram e ainda não casaram</span></div></div>
            <div className="inventory-card orphan"><span className="inventory-icon"><ArrowDownToLine size={15} /></span><div><small>RETORNO SEM SAÍDA</small><strong>{stats.invOrphan} posição(ões)</strong><span>Voltaram sem saída correspondente</span></div></div>
          </section>

          <section className="dashboard-grid">
            <div className="panel panel-main">
              <div className="panel-header"><div><div className="panel-kicker">CONCILIAÇÃO POR PN</div><h2>Status das saídas</h2></div>
                <select className="status-select" value={statusFilter} onChange={e => setStatusFilter(e.target.value as "all" | Status)}>
                  <option value="all">Todos os status</option><option value="pending">Pendentes</option><option value="partial">Parciais</option><option value="complete">Concluídos</option>
                </select></div>
              <div className="table-wrap"><table><thead><tr><th>PN enviado</th><th>PN de retorno</th><th>NF(s) saída</th><th>Saída</th><th>Retorno</th><th>Pendente</th><th>Status</th></tr></thead>
                <tbody>{filteredGroups.map(g => <tr key={g.key}>
                  <td><strong className="mono">{g.sourcePns.join(" + ")}</strong><div className="progress-track"><span style={{ width: `${g.progress}%` }} /></div></td>
                  <td><span className="mono target-code">{g.targetPns.join(" + ")}</span></td>
                  <td><span className="mono muted-text">{g.outNfs.join(" + ")}</span></td>
                  <td>{formatNumber(g.out)}</td><td>{formatNumber(g.returned)}</td>
                  <td><strong className={g.pending ? "pending-text" : "ok-text"}>{formatNumber(g.pending)}</strong></td>
                  <td><StatusBadge status={g.status} /></td></tr>)}</tbody></table>
                {!filteredGroups.length && <EmptyState text={movements.length ? "Nenhuma saída encontrada com esses filtros." : "Nenhuma movimentação cadastrada ainda. Use a aba Movimentações."} />}</div>
            </div>
            <aside className="panel activity-panel">
              <div className="panel-kicker">LEITURA RÁPIDA</div><h2>Resumo geral</h2>
              <div className="turn-summary">
                <div className="summary-row"><span>Taxa de retorno</span><strong>{totals.rate}%</strong></div>
                <div className="summary-row"><span>Itens em atenção</span><strong className="pending-text">{stats.attention}</strong></div>
                <div className="summary-row"><span>Regras ativas</span><strong>{rules.filter(r => r.active !== 0).length}</strong></div>
                <div className="summary-row"><span>Lotes concluídos</span><strong>{formatNumber(totals.complete)}</strong></div>
                <div className="summary-row"><span>NFs em trânsito</span><strong className={openDocs.length ? "pending-text" : ""}>{openDocs.length}</strong></div>
              </div>
              <div className="attention-box"><CircleAlert size={17} /><div><strong>Priorize o saldo pendente</strong><p>Use o filtro “Pendentes” para ver só o que saiu e ainda não voltou.</p></div></div>
              <div className="mini-legend"><span><i className="legend-dot orange" /> Pendente</span><span><i className="legend-dot green" /> Concluído</span><span><i className="legend-dot purple" /> Sem saída</span></div>
            </aside>
          </section>

          <section className="dashboard-detail-grid">
            <div className="panel detail-panel">
              <div className="panel-header"><div><div className="panel-kicker">RASTREAMENTO DE DOCUMENTOS</div><h2>Todas as NFs e seus PNs</h2></div><span className="table-count">{nfTracking.length} linhas</span></div>
              <div className="table-wrap"><table><thead><tr><th>NF</th><th>Data</th><th>Etapa</th><th>PN</th><th>Quantidade</th><th>Situação</th></tr></thead>
                <tbody>{nfTracking.map(m => <tr key={m.id}>
                  <td><strong className="mono">{m.nf}</strong></td><td className="muted-text">{formatDate(m.movementDate)}</td>
                  <td><span className={`movement-type ${kindMeta[m.kind].tone}`}>{kindMeta[m.kind].label}</span></td>
                  <td><span className="mono">{m.pn}</span></td><td><strong>{formatNumber(m.quantity)} un</strong></td>
                  <td><span className={`flow-status ${m.status.includes("Aguardando") ? "waiting" : "received"}`}><i />{m.status}</span></td></tr>)}</tbody></table>
                {!nfTracking.length && <EmptyState text="Nenhum documento encontrado com os filtros atuais." />}</div>
            </div>
            <div className="panel detail-panel">
              <div className="panel-header"><div><div className="panel-kicker">CASAMENTO E PENDÊNCIAS</div><h2>PNs que saíram x voltaram</h2></div><span className="table-count"><CircleAlert size={14} /> {stats.pendingPns} pendentes</span></div>
              <div className="table-wrap"><table><thead><tr><th>PN que saiu</th><th>PN que voltou</th><th>Saída</th><th>Retorno</th><th>Saldo</th><th /></tr></thead>
                <tbody>{filteredGroups.map(g => <tr key={`d-${g.key}`}>
                  <td><strong className="mono">{g.sourcePns.join(" + ")}</strong></td><td><span className="mono target-code">{g.targetPns.join(" + ")}</span></td>
                  <td>{formatNumber(g.out)} un</td><td>{formatNumber(g.returned)} un</td>
                  <td><strong className={g.pending ? "pending-text" : "ok-text"}>{g.pending ? `${formatNumber(g.pending)} pendente` : "Casado"}</strong></td>
                  <td><StatusBadge status={g.status} /></td></tr>)}</tbody></table>
                {!filteredGroups.length && <EmptyState text="Nenhum PN encontrado." />}</div>
              <div className="pending-summary"><CircleAlert size={15} /><span><strong>{formatNumber(totals.pending)} unidades</strong> ainda aguardam retorno na conciliação.</span></div>
            </div>
          </section>

          <section className="panel inventory-panel">
            <div className="panel-header"><div><div className="panel-kicker">PAINEL DE CONTROLE DE INVENTÁRIO</div><h2>Controle completo por PN, NF e quantidade</h2>
              <p className="panel-helper">Casamento de saída com retorno, saldo pendente e retornos sem documento de saída correspondente. Esta é a visão exportada na planilha.</p></div>
              <span className="table-count">{inventoryRows.length} posições</span></div>
            <div className="table-wrap"><table className="inventory-table"><thead><tr><th>Situação</th><th>PN que saiu</th><th>NF saída</th><th>Qtd. saída</th><th>PN relacionado que voltou</th><th>NF retorno</th><th>Qtd. retorno</th><th>Saldo</th></tr></thead>
              <tbody>{inventoryRows.map((r, i) => <tr key={`${r.sourcePn}-${r.returnPn}-${i}`}>
                <td><span className={`inventory-status ${r.status}`}><i />{r.statusLabel}</span></td>
                <td><strong className="mono">{r.sourcePn}</strong></td><td><span className="mono muted-text">{r.sourceNf}</span></td><td>{formatNumber(r.sourceQty)} un</td>
                <td><span className="mono target-code">{r.returnPn}</span></td><td><span className="mono muted-text">{r.returnNf}</span></td><td>{formatNumber(r.returnQty)} un</td>
                <td><strong className={r.balance ? "pending-text" : r.status === "orphan" ? "orphan-text" : "ok-text"}>{r.status === "orphan" ? "Sem saída" : r.balance ? `${formatNumber(r.balance)} pendente` : "Casado"}</strong></td></tr>)}</tbody></table>
              {!inventoryRows.length && <EmptyState text="Nenhum item de inventário encontrado com os filtros atuais." />}</div>
          </section>
        </>}

        {tab === "checks" && <ChecksTab tasks={filteredTasks} today={todayStr()} onSaved={upsertCheck} matches={matchByNf} />}
        {tab === "history" && <HistoryTab checks={checks} inventories={inventories} filters={filters} onCheckSaved={upsertCheck} onInventorySaved={upsertInventory} />}
        {tab === "inventory" && <InventoryTab inventories={inventories} external={external} unlocked={rulesUnlocked} today={todayStr()}
          onUnlock={async pw => { const r = await api.unlock(pw); if (r.success) setRulesUnlocked(true); return r.success; }}
          onCreated={upsertInventory} onSaved={upsertInventory} onDeleted={id => setInventories(cur => cur.filter(i => i.id !== id))} />}

        {tab === "external" && <>
          <section className="metric-grid">
            <Metric icon={Warehouse} label="Total fora da HD" value={`${formatNumber(ext.outside)} un`} detail={`${ext.pnsOutside} PN(s) · ${external.length} lote(s)`} tone="orange" />
            <Metric icon={Truck} label="Em trânsito → fornecedor" value={`${formatNumber(ext.transitTo)} un`} detail="Saiu da HD, sem entrada no fornecedor" tone="orange" />
            <Metric icon={PackageCheck} label="No fornecedor (estimado)" value={`${formatNumber(ext.atSupplier)} un`} detail="Recebido e ainda não devolvido" tone="blue" />
            <Metric icon={Truck} label="Em trânsito → HD" value={`${formatNumber(ext.transitBack)} un`} detail="Saiu do fornecedor, sem entrada na HD" tone="green" />
          </section>

          <section className="insight-grid two">
            <div className="panel insight-panel"><div className="panel-kicker">ONDE ESTÁ</div><h2>Distribuição do estoque externo</h2>
              {ext.outside ? <>
                <div className="stack-bar">
                  <i className="s1" style={{ width: `${(ext.transitTo / ext.outside) * 100}%` }} />
                  <i className="s2" style={{ width: `${(ext.atSupplier / ext.outside) * 100}%` }} />
                  <i className="s3" style={{ width: `${(ext.transitBack / ext.outside) * 100}%` }} />
                </div>
                <div className="stack-legend">
                  <span><i className="s1" /> Em trânsito → fornecedor <b>{formatNumber(ext.transitTo)}</b></span>
                  <span><i className="s2" /> No fornecedor <b>{formatNumber(ext.atSupplier)}</b></span>
                  <span><i className="s3" /> Em trânsito → HD <b>{formatNumber(ext.transitBack)}</b></span>
                </div>
                <p className="panel-helper">“No fornecedor” é estimado: saldo fora da HD que não está em nenhuma NF em trânsito.</p>
              </> : <EmptyState text="Nada fora da HD no momento." />}</div>
            <div className="panel insight-panel"><div className="panel-kicker">TEMPO FORA DA HD</div><h2>Saldo por idade</h2><AgingBars aging={aging} /></div>
          </section>

          <section className="panel inventory-panel">
            <div className="panel-header"><div><div className="panel-kicker">ESTOQUE EXTERNO POR PN</div><h2>Tudo que tem fora da HD</h2>
              <p className="panel-helper">O retorno abate sempre as saídas mais antigas; a idade é contada a partir da saída mais antiga ainda em aberto.</p></div>
              <span className="table-count">{filteredExternal.length} lote(s)</span></div>
            <div className="table-wrap"><table className="inventory-table"><thead><tr><th>Situação</th><th>PN enviado</th><th>PN esperado de volta</th><th>Saiu</th><th>Voltou</th><th>Fora da HD</th><th>→ Fornecedor</th><th>No fornecedor</th><th>→ HD</th><th>Dias fora</th><th>NF(s) em aberto</th></tr></thead>
              <tbody>{filteredExternal.map(r => <tr key={r.key}>
                <td><LevelBadge level={r.level} /></td>
                <td><strong className="mono">{r.sourcePns.join(" + ")}</strong></td><td><span className="mono target-code">{r.targetPns.join(" + ")}</span></td>
                <td>{formatNumber(r.out)}</td><td>{formatNumber(r.returned)}</td><td><strong className="pending-text">{formatNumber(r.outside)} un</strong></td>
                <td>{formatNumber(r.transitTo)}</td><td>{formatNumber(r.atSupplier)}</td><td>{formatNumber(r.transitBack)}</td>
                <td><strong>{r.days}</strong> <span className="muted-text">({formatDate(r.oldestDate)})</span></td>
                <td><span className="mono muted-text">{r.openNfs.join(" + ") || "—"}</span></td></tr>)}</tbody></table>
              {!filteredExternal.length && <EmptyState text={external.length ? "Nada encontrado com esses filtros." : "Nada fora da HD: tudo que saiu já voltou."} />}</div>
          </section>

          <section className="panel inventory-panel">
            <div className="panel-header"><div><div className="panel-kicker">DOCUMENTOS EM TRÂNSITO</div><h2>NFs que saíram e ainda não deram entrada</h2>
              <p className="panel-helper">A NF saiu de um lado e não tem entrada correspondente no outro.</p></div>
              <span className="table-count">{filteredDocs.length} NF(s)</span></div>
            <div className="table-wrap"><table><thead><tr><th>Situação</th><th>NF</th><th>Trecho</th><th>Saída</th><th>Dias</th><th>Itens</th><th>Quantidade</th></tr></thead>
              <tbody>{filteredDocs.map(d => <tr key={d.id}>
                <td><LevelBadge level={d.level} /></td><td><strong className="mono">{d.nf}</strong></td>
                <td><span className="movement-type out"><Truck size={13} />{d.location}</span></td><td className="muted-text">{formatDate(d.date)}</td>
                <td><strong>{d.days}</strong></td><td><span className="mono">{d.items.map(i => `${i.pn} × ${formatNumber(i.qty)}`).join(" · ")}</span></td>
                <td><strong>{formatNumber(d.qty)} un</strong></td></tr>)}</tbody></table>
              {!filteredDocs.length && <EmptyState text="Nenhuma NF em trânsito." />}</div>
          </section>
        </>}

        {tab === "movements" && <section className="panel panel-main movements-panel">
          <div className="panel-header"><div><div className="panel-kicker">HISTÓRICO OPERACIONAL</div><h2>Entradas e saídas</h2></div><div className="table-count">{filteredMovements.length} registros</div></div>
          <div className="table-wrap"><table><thead><tr><th>Tipo</th><th>NF</th><th>NF referência</th><th>Data</th><th>PN</th><th>Quantidade</th><th>Observações</th><th /></tr></thead>
            <tbody>{filteredMovements.map(m => <tr key={m.id}>
              <td><span className={`movement-type ${kindMeta[m.kind].tone}`}>{kindMeta[m.kind].tone === "out" ? <ArrowUpFromLine size={13} /> : <ArrowDownToLine size={13} />}{kindMeta[m.kind].label}</span></td>
              <td><strong className="mono">{m.nf}</strong></td>
              <td>{m.kind === "OUT_FORNECEDOR" ? <div><span className="mono">{m.refNf || "—"}</span>{matchByNf.get(norm(m.nf)) && <div style={{ marginTop: 3 }}><MatchBadge status={matchByNf.get(norm(m.nf))!.status} /></div>}</div> : <span className="muted-text">—</span>}</td>
              <td className="muted-text">{formatDate(m.movementDate)}</td><td><span className="mono">{m.pn}</span></td>
              <td><strong>{formatNumber(m.quantity)} un</strong></td><td className="muted-text notes-cell">{m.notes || "—"}</td>
              <td><button className="row-more" aria-label="Excluir lançamento" title="Excluir lançamento" onClick={() => removeMovement(m)}><Trash2 size={15} /></button></td></tr>)}</tbody></table>
            {!filteredMovements.length && <EmptyState text={movements.length ? "Nenhum movimento encontrado com esses filtros." : "Nenhuma movimentação cadastrada ainda."} />}</div>
        </section>}

        {tab === "rules" && (!rulesUnlocked ? <section className="locked-card">
          <div className="lock-orb"><LockKeyhole size={25} /></div><div className="panel-kicker">ÁREA RESTRITA</div><h2>Regras de transformação</h2>
          <p>Esta área altera a lógica de conciliação do sistema. Informe a senha operacional para visualizar e editar as relações entre PNs.</p>
          <form className="unlock-form" onSubmit={unlockRules}><div className="password-field"><KeyRound size={16} />
            <input autoFocus type="password" placeholder="Senha de acesso" value={password} onChange={e => setPassword(e.target.value)} />
            <button type="submit" disabled={unlocking || !password}>{unlocking ? "Validando…" : "Desbloquear"}</button></div></form>
          <div className="security-note"><ShieldCheck size={15} /> A senha é validada no servidor; o acesso dura 2 horas</div>
        </section> : <section className="rules-layout">
          <div className="panel panel-main">
            <div className="panel-header"><div><div className="panel-kicker">MAPA DE TRANSFORMAÇÕES</div><h2>Regras cadastradas</h2></div><span className="table-count"><ShieldCheck size={14} /> Área liberada</span></div>
            <div className="rule-list">{rules.map(rule => <div className="rule-card" key={rule.id}>
              <div className="rule-flow"><div><span className="rule-label">SAI</span><strong className="mono">{rule.fromPns}</strong></div><ChevronRight className="rule-chevron" size={19} /><div><span className="rule-label return-label">VOLTA</span><strong className="mono">{rule.toPns}</strong></div></div>
              <div className="rule-description">{rule.description || "Sem observação cadastrada"}{rule.active === 0 && <span className="badge-off">INATIVA</span>}</div>
              <div className="rule-actions">
                <button onClick={() => { setEditingRuleId(rule.id); setRuleForm({ fromPns: rule.fromPns, toPns: rule.toPns, description: rule.description || "", active: rule.active !== 0 }); }}><Settings2 size={14} /> Editar</button>
                <button className="danger-action" aria-label="Excluir regra" onClick={() => removeRule(rule)}><Trash2 size={14} /></button>
              </div></div>)}
              {!rules.length && <EmptyState text="Nenhuma regra cadastrada." />}</div>
          </div>
          <div className="panel rule-editor">
            <div className="panel-kicker">{editingRuleId ? "EDITAR REGRA" : "NOVA REGRA"}</div><h2>{editingRuleId ? "Atualize a transformação" : "Ligue saída e retorno"}</h2>
            <p>Use <span className="mono">+</span>, vírgula ou uma linha por PN. Aceita 1→1, 1→vários, vários→1 e combinações maiores. As quantidades são casadas unidade a unidade.</p>
            <form onSubmit={saveRule}>
              <label>PN(s) que saem<textarea rows={3} value={ruleForm.fromPns} onChange={e => setRuleForm({ ...ruleForm, fromPns: e.target.value })} placeholder="Ex.: 700-03 + 700-04" /></label>
              <label>PN(s) que voltam<textarea rows={3} value={ruleForm.toPns} onChange={e => setRuleForm({ ...ruleForm, toPns: e.target.value })} placeholder="Ex.: 700-03/04 + 700-03/05" /></label>
              <label>Descrição da regra<textarea rows={3} value={ruleForm.description} onChange={e => setRuleForm({ ...ruleForm, description: e.target.value })} placeholder="Contexto do retrabalho…" /></label>
              <label className="inline-check"><input type="checkbox" checked={ruleForm.active} onChange={e => setRuleForm({ ...ruleForm, active: e.target.checked })} /> Regra ativa</label>
              <button type="submit" className="btn primary-cta"><Check size={16} /> {editingRuleId ? "Salvar alteração" : "Cadastrar regra"}</button>
              {editingRuleId && <button type="button" className="cancel-edit" onClick={() => { setEditingRuleId(null); setRuleForm(emptyRule); }}>Cancelar edição</button>}
            </form>
          </div>
        </section>)}
        </>}
      </div>
    </main>

    {showMovementForm && <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget && !saving) setShowMovementForm(false); }}>
      <div className="modal-card movement-modal">
        <div className="modal-header"><div><div className="panel-kicker">NOVA MOVIMENTAÇÃO</div><h2>Registrar NF com vários PNs</h2><p className="modal-subtitle">Escolha o trecho e lance quantos PNs e quantidades forem necessários.</p></div>
          <button className="icon-close" aria-label="Fechar" onClick={() => setShowMovementForm(false)}><X size={19} /></button></div>
        <div className="movement-kind-grid">{(["OUT_HD", "IN_FORNECEDOR", "OUT_FORNECEDOR", "IN_HD"] as Kind[]).map(kind =>
          <button type="button" key={kind} className={`kind-option ${movementForm.kind === kind ? "selected" : ""} ${kindMeta[kind].tone}`} onClick={() => setMovementForm({ ...movementForm, kind })}>
            {kindMeta[kind].tone === "out" ? <ArrowUpFromLine size={15} /> : <ArrowDownToLine size={15} />}<span>{kindMeta[kind].label}</span></button>)}</div>
        <form className="movement-form" onSubmit={handleMovementSubmit}>
          <div className="form-grid">
            <label>{movementForm.kind === "OUT_FORNECEDOR" ? "NF de saída (emitida pela Vulcano)" : "Nota fiscal"}<input autoFocus value={movementForm.nf} onChange={e => setMovementForm({ ...movementForm, nf: e.target.value })} placeholder="Ex.: NF-45321" /></label>
            <label>Data<input type="date" value={movementForm.movementDate} onChange={e => setMovementForm({ ...movementForm, movementDate: e.target.value })} /></label>
          </div>
          {movementForm.kind === "OUT_FORNECEDOR" && <label>NF de referência (NF de entrada)<input list="entry-nfs" value={movementForm.refNf} onChange={e => setMovementForm({ ...movementForm, refNf: e.target.value })} placeholder="NF que a HD enviou para a Vulcano (várias: separe por +)" />
            <datalist id="entry-nfs">{entryNfs.map(n => <option key={n} value={n} />)}</datalist></label>}
          <div className="items-header"><div><strong>Itens da NF</strong><small>Cadastre livremente vários PNs e quantidades</small></div>
            <button type="button" className="add-item" onClick={() => setMovementForm({ ...movementForm, items: [...movementForm.items, { pn: "", quantity: "" }] })}><Plus size={14} /> Adicionar PN</button></div>
          <div className="movement-lines">{movementForm.items.map((item, index) => <div className="line-row" key={index}>
            <label>PN<input value={item.pn} onChange={e => setLine(index, { pn: e.target.value })} placeholder="Ex.: 842-11" /></label>
            <label>Quantidade<input type="number" min="1" step="1" inputMode="numeric" value={item.quantity} onChange={e => setLine(index, { quantity: e.target.value })} placeholder="0" /></label>
            {movementForm.items.length > 1 ? <button type="button" className="remove-item" aria-label="Remover item" onClick={() => setMovementForm({ ...movementForm, items: movementForm.items.filter((_, i) => i !== index) })}><Trash2 size={15} /></button> : <span />}
          </div>)}</div>
          {draftMatch && <div className={`match-box ${draftMatch.status}`}>
            <div className="match-title"><MatchBadge status={draftMatch.status} /> <small>Casamento com a NF de referência {draftMatch.refs.join(" + ")}</small></div>
            {draftMatch.missingRefs.length > 0 && <p>NF não encontrada: <b>{draftMatch.missingRefs.join(", ")}</b>. Só dá para referenciar NFs que a HD já enviou.</p>}
            {draftMatch.rows.map((r, i) => <div className="match-row" key={i}><span className="mono">{r.pns.join(" + ")} → {r.targets.join(" + ")}</span>
              <span>entrada {formatNumber(r.entry)} · devolvido {formatNumber(r.returned)}</span><b className={r.diff === 0 ? "ok-text" : r.diff > 0 ? "pending-text" : "muted-text"}>{r.diff === 0 ? "OK" : r.diff > 0 ? `+${r.diff} a mais` : `faltam ${-r.diff}`}</b></div>)}
            {draftMatch.unexpected.map(u => <div className="match-row" key={u.pn}><span className="mono">{u.pn}</span><span>{formatNumber(u.qty)} un</span><b className="pending-text">não veio na NF de referência</b></div>)}
          </div>}
          <label>Observações<span className="optional-label">opcional</span><textarea rows={3} value={movementForm.notes} onChange={e => setMovementForm({ ...movementForm, notes: e.target.value })} placeholder="Lote, contexto ou observação operacional…" /></label>
          <div className="form-actions"><button type="button" className="btn" onClick={() => setShowMovementForm(false)} disabled={saving}>Cancelar</button>
            <button type="submit" className="btn primary-cta" disabled={saving}><Check size={16} /> {saving ? "Salvando…" : "Salvar movimentação"}</button></div>
        </form>
      </div>
    </div>}
  </div>;
}

/** Coloque sua logo em client/public/logo.png. Sem o arquivo, aparece o texto "HD". */
function Logo() {
  const [failed, setFailed] = useState(false);
  return failed ? <span className="brand-fallback">HD</span> : <img src="/logo.png" alt="HD Soluções" onError={() => setFailed(true)} />;
}
function Metric({ icon: Icon, label, value, detail, tone }: { icon: typeof ArrowUpFromLine; label: string; value: string; detail: string; tone: string }) {
  return <div className={`metric-card tone-${tone}`}><div className="metric-icon"><Icon size={17} /></div><div><span>{label}</span><strong>{value}</strong><small>{detail}</small></div><TrendingUp size={16} className="metric-trend" /></div>;
}
function StatusBadge({ status }: { status: Status }) {
  const c = status === "complete" ? { label: "Concluído", cls: "complete" } : status === "partial" ? { label: "Parcial", cls: "partial" } : { label: "Pendente", cls: "pending" };
  return <span className={`status-badge ${c.cls}`}><i />{c.label}</span>;
}
function EmptyState({ text }: { text: string }) {
  return <div className="empty-state"><BarChart3 size={20} /><span>{text}</span></div>;
}

const levelMeta: Record<Level, { label: string; cls: string }> = {
  critical: { label: "Crítico", cls: "critical" }, warning: { label: "Atenção", cls: "warning" },
  info: { label: "Em trânsito", cls: "info" }, ok: { label: "No prazo", cls: "ok" },
};
function LevelBadge({ level }: { level: Level }) {
  return <span className={`level-badge ${levelMeta[level].cls}`}><i />{levelMeta[level].label}</span>;
}
function AgingBars({ aging }: { aging: { label: string; units: number }[] }) {
  const max = Math.max(1, ...aging.map(a => a.units));
  const total = aging.reduce((s, a) => s + a.units, 0);
  if (!total) return <EmptyState text="Nada fora da HD." />;
  return <div className="bar-list">{aging.map((a, i) => <div className="bar-row" key={a.label}>
    <span className="bar-label">{a.label}</span><div className="bar-track"><i className={i >= 3 ? "hot" : i === 2 ? "warm" : ""} style={{ width: `${(a.units / max) * 100}%` }} /></div><b>{formatNumber(a.units)}</b></div>)}</div>;
}
function ActivityChart({ data }: { data: { date: string; out: number; back: number }[] }) {
  const max = Math.max(1, ...data.flatMap(d => [d.out, d.back]));
  if (!data.some(d => d.out || d.back)) return <EmptyState text="Sem movimentações nos últimos 14 dias." />;
  return <>
    <div className="activity-chart">{data.map(d => <div className="act-col" key={d.date} title={`${formatDate(d.date)} · saída ${d.out} · retorno ${d.back}`}>
      <div className="act-bars"><i className="out" style={{ height: `${(d.out / max) * 100}%` }} /><i className="back" style={{ height: `${(d.back / max) * 100}%` }} /></div>
      <small>{d.date.slice(8)}</small></div>)}</div>
    <div className="mini-legend" style={{ marginTop: 10 }}><span><i className="legend-dot orange" /> Saídas</span><span><i className="legend-dot green" /> Retornos HD</span></div>
  </>;
}

function MatchBadge({ status }: { status: MatchStatus }) {
  const cls = status === "match" ? "ok" : status === "partial" ? "info" : status === "diverge" ? "critical" : "warning";
  return <span className={`level-badge ${cls}`}><i />{matchLabel[status]}</span>;
}
