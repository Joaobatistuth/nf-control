import { useMemo, useState } from "react";
import { Camera, MessageSquare, X } from "lucide-react";
import { api } from "@/lib/api";
import { CommentsBox, PhotoGallery } from "@/components/Shared";
import { formatDate, formatDateTime, formatNumber } from "@/lib/format";
import { directionLabel, divergences, sideLabel, sideOf, stageLabel } from "@shared/checks";
import { norm } from "@shared/reconcile";
import type { Check, Inventory } from "@shared/types";

type Filters = { from: string; to: string; nf: string; pn: string };
type Row = { id: string; type: "check" | "inventory"; at: string; title: string; subtitle: string; by: string; items: number; diffs: number; photos: number; comments: number };

const invDiffs = (inv: Inventory) => inv.lines.filter(l => l.counted != null && l.counted !== l.expected);

export function HistoryTab({ checks, inventories, filters, onCheckSaved, onInventorySaved }: {
  checks: Check[]; inventories: Inventory[]; filters: Filters; onCheckSaved: (c: Check) => void; onInventorySaved: (i: Inventory) => void;
}) {
  const [type, setType] = useState<"all" | "check" | "inventory">("all");
  const [onlyDiff, setOnlyDiff] = useState(false);
  const [selected, setSelected] = useState<{ type: "check" | "inventory"; id: string } | null>(null);

  const rows = useMemo(() => {
    const has = (hay: string[], n: string) => !n.trim() || hay.some(h => norm(h).includes(norm(n)));
    const list: Row[] = [];
    for (const c of checks.filter(c => c.status === "done")) {
      list.push({ id: c.id, type: "check", at: c.doneAt ?? c.updatedAt, title: `NF ${c.nf}`, subtitle: `${stageLabel(c.stage)} · ${directionLabel(c.direction)}`,
        by: `${c.checkedBy ?? "—"} (${sideLabel(sideOf(c.direction, c.stage))})`, items: c.items.length, diffs: divergences(c).length, photos: c.photoIds.length, comments: c.comments.length });
    }
    for (const i of inventories.filter(i => i.status === "counted")) {
      list.push({ id: i.id, type: "inventory", at: i.countedAt ?? i.updatedAt, title: `Inventário ${i.week}`, subtitle: `${formatDate(i.weekStart)} a ${formatDate(i.weekEnd)}`,
        by: `${i.countedBy ?? "—"} (Vulcano)`, items: i.lines.length, diffs: invDiffs(i).length, photos: i.photoIds.length, comments: i.comments.length });
    }
    return list.filter(r => {
      const day = r.at.slice(0, 10);
      const src = r.type === "check" ? checks.find(c => c.id === r.id) : null;
      const inv = r.type === "inventory" ? inventories.find(i => i.id === r.id) : null;
      return (type === "all" || r.type === type) && (!onlyDiff || r.diffs > 0) &&
        (!filters.from || day >= filters.from) && (!filters.to || day <= filters.to) &&
        has(src ? [src.nf] : [r.title], filters.nf) && has(src ? src.items.map(i => i.pn) : inv ? inv.lines.map(l => l.label) : [], filters.pn);
    }).sort((a, b) => b.at.localeCompare(a.at));
  }, [checks, inventories, filters, type, onlyDiff]);

  const check = selected?.type === "check" ? checks.find(c => c.id === selected.id) : null;
  const inv = selected?.type === "inventory" ? inventories.find(i => i.id === selected.id) : null;

  return <>
    <section className="panel panel-main">
      <div className="panel-header"><div><div className="panel-kicker">HISTÓRICO DE CONFERÊNCIAS</div><h2>Conferências e inventários enviados</h2></div>
        <div className="alert-chips">
          {([["all", "Todos"], ["check", "NFs"], ["inventory", "Inventários"]] as const).map(([k, l]) => <button key={k} className={`alert-chip ${type === k ? "on" : ""}`} onClick={() => setType(k)}>{l}</button>)}
          <button className={`alert-chip critical ${onlyDiff ? "on" : ""}`} onClick={() => setOnlyDiff(v => !v)}>Só divergências</button>
        </div></div>
      <div className="table-wrap"><table><thead><tr><th>Enviada em</th><th>Documento</th><th>Detalhe</th><th>Conferido por</th><th>Itens</th><th>Divergência</th><th>Fotos</th><th>Comentários</th><th /></tr></thead>
        <tbody>{rows.map(r => <tr key={`${r.type}-${r.id}`}>
          <td className="muted-text">{formatDateTime(r.at)}</td><td><strong className="mono">{r.title}</strong></td><td className="muted-text">{r.subtitle}</td><td>{r.by}</td><td>{r.items}</td>
          <td>{r.diffs ? <span className="level-badge critical"><i />{r.diffs} item(ns)</span> : <span className="level-badge ok"><i />Sem divergência</span>}</td>
          <td><Camera size={12} /> {r.photos}</td><td><MessageSquare size={12} /> {r.comments}</td>
          <td><button className="btn btn-sm" onClick={() => setSelected({ type: r.type, id: r.id })}>Abrir</button></td></tr>)}</tbody></table>
        {!rows.length && <div className="empty-state"><span>Nenhuma conferência enviada com esses filtros.</span></div>}</div>
    </section>

    {(check || inv) && <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) setSelected(null); }}>
      <div className="modal-card movement-modal">
        <div className="modal-header"><div>
          <div className="panel-kicker">{check ? `${stageLabel(check.stage).toUpperCase()} · ${directionLabel(check.direction)}` : `INVENTÁRIO ${inv!.week}`}</div>
          <h2>{check ? `NF ${check.nf}` : `Semana ${formatDate(inv!.weekStart)} a ${formatDate(inv!.weekEnd)}`}</h2>
          <p className="modal-subtitle">{check ? `Conferido por ${check.checkedBy} em ${formatDateTime(check.doneAt)}` : `Contado por ${inv!.countedBy} em ${formatDateTime(inv!.countedAt)}`}</p></div>
          <button className="icon-close" aria-label="Fechar" onClick={() => setSelected(null)}><X size={19} /></button></div>
        <div className="table-wrap"><table><thead><tr><th>{check ? "PN" : "Item"}</th><th>Esperado</th><th>Contado</th><th>Diferença</th></tr></thead><tbody>
          {(check ? check.items.map(i => ({ k: i.pn, label: i.pn, e: i.expected, c: i.counted })) : inv!.lines.map(l => ({ k: l.key, label: l.extra ? `${l.label} (não listado)` : l.label, e: l.expected, c: l.counted }))).map(r => {
            const d = (r.c ?? 0) - r.e;
            return <tr key={r.k}><td><strong className="mono">{r.label}</strong></td><td>{formatNumber(r.e)}</td><td>{r.c == null ? "—" : formatNumber(r.c)}</td>
              <td>{d === 0 ? <span className="ok-text">OK</span> : <strong className="pending-text">{d > 0 ? "+" : ""}{formatNumber(d)}</strong>}</td></tr>;
          })}</tbody></table></div>
        <div className="movement-form">
          <div><div className="items-header" style={{ marginTop: 0 }}><div><strong>Fotos</strong></div></div><PhotoGallery ids={(check ?? inv)!.photoIds} /></div>
          <div><div className="items-header" style={{ marginTop: 0 }}><div><strong>Comentários</strong></div></div>
            <CommentsBox comments={(check ?? inv)!.comments} onAdd={async (text, author) => {
              if (check) onCheckSaved(await api.commentCheck({ direction: check.direction, stage: check.stage, nf: check.nf, text, author }));
              else onInventorySaved(await api.commentInventory({ id: inv!.id, text, author }));
            }} /></div>
        </div>
      </div>
    </div>}
  </>;
}
