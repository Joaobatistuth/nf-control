import { Fragment, useMemo, useState } from "react";
import { Check as CheckIcon, ChevronDown, ChevronRight, ClipboardCheck, Clock, Send, Truck } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { AUTHOR_KEY, CommentsBox, PhotoPicker } from "@/components/Shared";
import { errMsg, formatDate, formatNumber, readLocal, writeLocal } from "@/lib/format";
import { directionLabel, sideLabel, stageLabel, type Task } from "@shared/checks";
import { daysBetween } from "@shared/insights";
import { matchLabel, type MatchResult } from "@shared/match";
import type { Check, CheckItem, Comment, Side } from "@shared/types";

type SideFilter = "ALL" | Side;
const matchCls = (s: MatchResult["status"]) => (s === "match" ? "ok" : s === "partial" ? "info" : s === "diverge" ? "critical" : "warning");

export function ChecksTab({ tasks, today, onSaved, matches }: { tasks: Task[]; today: string; onSaved: (c: Check) => void; matches: Map<string, MatchResult> }) {
  const [side, setSide] = useState<SideFilter>((readLocal("nf_side", "ALL") as SideFilter) || "ALL");
  const [selected, setSelected] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const open = useMemo(() => tasks.filter(t => t.status !== "done" && (side === "ALL" || t.side === side))
    .sort((a, b) => Number(a.waitingLoad) - Number(b.waitingLoad) || a.shipment.date.localeCompare(b.shipment.date)), [tasks, side]);
  const choose = (s: SideFilter) => { setSide(s); writeLocal("nf_side", s); };
  const count = (s: SideFilter) => tasks.filter(t => t.status !== "done" && !t.waitingLoad && (s === "ALL" || t.side === s)).length;
  const toggle = (key: string) => {
    if (dirty && !window.confirm("Há alterações não salvas nesta NF. Fechar mesmo assim?")) return;
    setDirty(false); setSelected(selected === key ? null : key);
  };

  return <section className="panel panel-main">
    <div className="panel-header"><div><div className="panel-kicker">FILA DE CONFERÊNCIA</div><h2>NFs aguardando conferência</h2>
      <p className="panel-helper">Clique na NF para abrir a lista de PNs e ir dando o check em cada item. Quem emite a NF confere o carregamento; quem recebe confere o recebimento.</p></div>
      <div className="alert-chips">
        {(["ALL", "HD", "VULCANO"] as SideFilter[]).map(s => <button key={s} className={`alert-chip ${side === s ? "on" : ""}`} onClick={() => choose(s)}>
          {s === "ALL" ? "Todas" : s === "HD" ? "Sou da HD" : "Sou da Vulcano"} <b>{count(s)}</b></button>)}
      </div></div>
    <div className="table-wrap"><table><thead><tr><th /><th>Idade</th><th>NF</th><th>Trecho</th><th>Etapa</th><th>Quem confere</th><th>Itens</th><th>Quantidade</th><th>Situação</th></tr></thead>
      <tbody>{open.map(t => {
        const days = daysBetween(t.shipment.date, today);
        const isOpen = selected === t.key;
        return <Fragment key={t.key}>
          <tr className={`clickable ${isOpen ? "row-open" : ""}`} onClick={() => toggle(t.key)}>
            <td>{isOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}</td>
            <td><span className={`level-badge ${days >= 3 ? "critical" : days >= 1 ? "warning" : "info"}`}><Clock size={11} /> {days === 0 ? "hoje" : `${days}d`}</span></td>
            <td><strong className="mono">{t.shipment.nf}</strong><div className="muted-text" style={{ fontSize: 10 }}>{formatDate(t.shipment.date)}</div></td>
            <td><span className="movement-type out"><Truck size={13} />{directionLabel(t.shipment.direction)}</span></td>
            <td><strong>{stageLabel(t.stage)}</strong></td><td>{sideLabel(t.side)}</td>
            <td>{t.shipment.items.length} PN(s)</td><td><strong>{formatNumber(t.shipment.items.reduce((s, i) => s + i.expected, 0))} un</strong></td>
            <td>{t.waitingLoad ? <span className="level-badge info"><i />Aguardando carregamento</span>
              : t.status === "draft" ? <span className="level-badge warning"><i />Em andamento</span> : <span className="level-badge critical"><i />Pendente</span>}</td>
          </tr>
          {isOpen && <tr className="check-expand"><td colSpan={9}>
            <CheckPanel task={t} match={matches.get(t.shipment.nf) ?? null} onSaved={onSaved} onDirty={setDirty} onDone={() => { setDirty(false); setSelected(null); }} />
          </td></tr>}
        </Fragment>;
      })}</tbody></table>
      {!open.length && <div className="empty-state"><CheckIcon size={20} /><span>{tasks.length ? "Nenhuma conferência pendente para este filtro. Tudo conferido!" : "Nenhuma NF lançada ainda. Registre em Movimentações."}</span></div>}
    </div>
  </section>;
}

function CheckPanel({ task, match, onSaved, onDirty, onDone }: { task: Task; match: MatchResult | null; onSaved: (c: Check) => void; onDirty: (d: boolean) => void; onDone: () => void }) {
  const sh = task.shipment;
  const [items, setItems] = useState<CheckItem[]>(() => sh.items.map(it => {
    const saved = task.check?.items.find(x => x.pn === it.pn);
    return { pn: it.pn, expected: it.expected, counted: saved?.counted ?? null, checked: saved?.checked ?? false };
  }));
  const [photoIds, setPhotoIds] = useState<string[]>(task.check?.photoIds ?? []);
  const [by, setBy] = useState(task.check?.checkedBy ?? readLocal(AUTHOR_KEY));
  const [comments, setComments] = useState<Comment[]>(task.check?.comments ?? []);
  const [busy, setBusy] = useState(false);

  const patch = (i: number, p: Partial<CheckItem>) => { setItems(cur => cur.map((it, k) => (k === i ? { ...it, ...p } : it))); onDirty(true); };
  const toggle = (i: number) => patch(i, { checked: !items[i].checked, counted: items[i].counted ?? items[i].expected });
  const markAll = () => { setItems(cur => cur.map(it => ({ ...it, checked: true, counted: it.counted ?? it.expected }))); onDirty(true); };
  const done = items.filter(i => i.checked).length;
  const diffs = items.filter(i => i.counted != null && i.counted !== i.expected).length;
  const missing = [
    done < items.length && `marcar os ${items.length - done} item(ns) restantes`,
    !photoIds.length && "anexar ao menos uma foto",
    !by.trim() && "informar o nome de quem conferiu",
  ].filter(Boolean) as string[];

  async function save(submit: boolean) {
    setBusy(true);
    try {
      const rec = await api.saveCheck({ direction: sh.direction, stage: task.stage, nf: sh.nf, items, checkedBy: by, photoIds, submit });
      writeLocal(AUTHOR_KEY, by.trim());
      onSaved(rec); onDirty(false);
      toast.success(submit ? "Conferência enviada e registrada no histórico." : "Progresso salvo.");
      if (submit) onDone();
    } catch (e) { toast.error(errMsg(e, "Não foi possível salvar. Nada foi alterado.")); }
    finally { setBusy(false); }
  }

  return <div className="check-panel">
    {match && <div className={`match-box ${match.status}`}>
      <div className="match-title"><span className={`level-badge ${matchCls(match.status)}`}><i />{matchLabel[match.status]}</span>
        <small>NF de referência (entrada): <b className="mono">{match.refs.join(" + ") || "—"}</b></small></div>
      {match.rows.map((r, i) => <div className="match-row" key={i}><span className="mono">{r.pns.join(" + ")} → {r.targets.join(" + ")}</span>
        <span>entrada {formatNumber(r.entry)} · devolvido {formatNumber(r.returned)}</span></div>)}
    </div>}

    <div className="items-header" style={{ marginTop: 0 }}><div><strong>PNs da NF {sh.nf}</strong><small>{done} de {items.length} conferidos{diffs ? ` · ${diffs} com divergência` : ""}</small></div>
      <button type="button" className="add-item" onClick={markAll}><CheckIcon size={14} /> Marcar todos</button></div>
    <div className="progress-track" style={{ margin: "0 0 12px" }}><span style={{ width: `${items.length ? (done / items.length) * 100 : 0}%` }} /></div>

    <div className="check-items">{items.map((it, i) => {
      const diff = it.counted != null && it.counted !== it.expected;
      return <div className={`check-item ${it.checked ? "checked" : ""} ${diff ? "diff" : ""}`} key={it.pn}>
        <label className="check-box"><input type="checkbox" checked={it.checked} onChange={() => toggle(i)} aria-label={`Conferido: ${it.pn}`} /><span /></label>
        <div className="check-info"><strong className="mono">{it.pn}</strong><small>Esperado: {formatNumber(it.expected)} un</small></div>
        <label className="check-qty">Contado<input type="number" min="0" step="1" inputMode="numeric" value={it.counted ?? ""} placeholder={String(it.expected)}
          onChange={e => patch(i, { counted: e.target.value === "" ? null : Number(e.target.value) })} /></label>
        {diff && <span className="level-badge critical">{it.counted! - it.expected > 0 ? "+" : ""}{it.counted! - it.expected}</span>}
      </div>;
    })}</div>

    <div className="check-foot">
      <div className="movement-form">
        <label>Quem conferiu<input value={by} onChange={e => { setBy(e.target.value); onDirty(true); }} placeholder="Nome do conferente" maxLength={60} /></label>
        <div><div className="items-header" style={{ marginTop: 0 }}><div><strong>Foto da conferência</strong><small>Obrigatória para enviar</small></div></div>
          <PhotoPicker ids={photoIds} onChange={ids => { setPhotoIds(ids); onDirty(true); }} /></div>
      </div>
      <div className="movement-form">
        <div><div className="items-header" style={{ marginTop: 0 }}><div><strong>Comentários</strong><small>Ficam salvos no histórico</small></div></div>
          <CommentsBox comments={comments} onAdd={async (text, author) => { const rec = await api.commentCheck({ direction: sh.direction, stage: task.stage, nf: sh.nf, text, author }); setComments(rec.comments); onSaved(rec); }} /></div>
      </div>
    </div>
    {!!missing.length && <div className="security-note" style={{ justifyContent: "flex-start" }}>Para enviar falta: {missing.join(", ")}.</div>}
    <div className="form-actions">
      <button type="button" className="btn" onClick={() => save(false)} disabled={busy}>Salvar progresso</button>
      <button type="button" className="btn primary-cta" onClick={() => save(true)} disabled={busy || !!missing.length}><Send size={15} /> {busy ? "Enviando…" : "Enviar conferência"}</button>
    </div>
  </div>;
}
