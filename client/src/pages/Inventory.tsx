import { useState } from "react";
import { ClipboardList, KeyRound, Plus, Send, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import { AUTHOR_KEY, CommentsBox, PhotoPicker } from "@/components/Shared";
import { errMsg, formatDate, formatDateTime, formatNumber, readLocal, writeLocal } from "@/lib/format";
import { isoWeek } from "@shared/checks";
import type { ExternalRow } from "@shared/insights";
import type { Comment, Inventory, InventoryLine } from "@shared/types";

export function InventoryTab({ inventories, external, unlocked, today, onUnlock, onCreated, onSaved, onDeleted }: {
  inventories: Inventory[]; external: ExternalRow[]; unlocked: boolean; today: string;
  onUnlock: (password: string) => Promise<boolean>; onCreated: (i: Inventory) => void; onSaved: (i: Inventory) => void; onDeleted: (id: string) => void;
}) {
  const week = isoWeek(today);
  const current = inventories.find(i => i.week === week.id) ?? null;
  const [askPassword, setAskPassword] = useState(false);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [counting, setCounting] = useState<string | null>(null);
  const lines = external.filter(r => r.atSupplier > 0).map(r => ({ key: r.key, label: r.sourcePns.join(" + "), targets: r.targetPns.join(" + "), expected: r.atSupplier }));

  async function generate() {
    setBusy(true);
    try {
      onCreated(await api.createInventory({ date: today, lines }));
      toast.success(`Inventário ${week.id} gerado. Aguardando contagem da Vulcano.`);
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) { setAskPassword(true); } else toast.error(errMsg(e, "Não foi possível gerar o inventário."));
    } finally { setBusy(false); }
  }
  async function start() {
    if (!unlocked) return setAskPassword(true);
    if (!lines.length && !window.confirm("Não há estoque estimado na Vulcano. Gerar um inventário vazio (a Vulcano poderá lançar itens encontrados)?")) return;
    await generate();
  }
  async function submitPassword(e: React.FormEvent) {
    e.preventDefault(); setBusy(true);
    try {
      if (await onUnlock(password)) { setPassword(""); setAskPassword(false); toast.success("Senha validada."); await generate(); }
      else toast.error("Senha inválida.");
    } catch (err) { toast.error(errMsg(err, "Não foi possível validar a senha.")); }
    finally { setBusy(false); }
  }
  async function remove(inv: Inventory) {
    if (!window.confirm(`Excluir o inventário ${inv.week} pendente? Você poderá gerar outro.`)) return;
    try { await api.deleteInventory(inv.id); onDeleted(inv.id); toast.success("Inventário excluído."); }
    catch (e) { toast.error(errMsg(e, "Não foi possível excluir.")); }
  }
  const target = inventories.find(i => i.id === counting) ?? null;

  return <>
    <section className="panel panel-main">
      <div className="panel-header"><div><div className="panel-kicker">INVENTÁRIO SEMANAL</div><h2>Semana {week.id} · {formatDate(week.start)} a {formatDate(week.end)}</h2>
        <p className="panel-helper">A HD gera o inventário da semana (exige senha) com o que deveria estar na Vulcano; a Vulcano faz a contagem e envia.</p></div>
        {!current && <button className="btn primary-cta" onClick={start} disabled={busy}><Plus size={16} /> Gerar inventário da semana</button>}</div>
      <div className="table-wrap"><table><thead><tr><th>Semana</th><th>Período</th><th>Gerado em</th><th>Itens</th><th>Esperado</th><th>Situação</th><th /></tr></thead>
        <tbody>{inventories.map(i => {
          const diff = i.lines.filter(l => l.counted != null && l.counted !== l.expected).length;
          return <tr key={i.id}>
            <td><strong className="mono">{i.week}</strong></td><td className="muted-text">{formatDate(i.weekStart)} a {formatDate(i.weekEnd)}</td><td className="muted-text">{formatDateTime(i.generatedAt)}</td>
            <td>{i.lines.length}</td><td>{formatNumber(i.lines.reduce((s, l) => s + l.expected, 0))} un</td>
            <td>{i.status === "pending" ? <span className="level-badge warning"><i />Aguardando contagem da Vulcano</span>
              : diff ? <span className="level-badge critical"><i />Contado · {diff} divergência(s)</span> : <span className="level-badge ok"><i />Contado · sem divergência</span>}</td>
            <td style={{ display: "flex", gap: 6 }}>
              {i.status === "pending" && <button className="btn btn-sm primary-cta" onClick={() => setCounting(i.id)}><ClipboardList size={14} /> Contar</button>}
              {i.status === "pending" && <button className="btn btn-sm" aria-label="Excluir inventário" onClick={() => remove(i)}><Trash2 size={14} /></button>}
              {i.status === "counted" && <span className="muted-text" style={{ fontSize: 10 }}>Veja no Histórico</span>}</td></tr>;
        })}</tbody></table>
        {!inventories.length && <div className="empty-state"><span>Nenhum inventário gerado ainda.</span></div>}</div>
    </section>

    {askPassword && <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) setAskPassword(false); }}>
      <div className="modal-card" style={{ maxWidth: 420 }}>
        <div className="modal-header"><div><div className="panel-kicker">SOMENTE HD</div><h2>Senha para gerar o inventário</h2></div><button className="icon-close" aria-label="Fechar" onClick={() => setAskPassword(false)}><X size={19} /></button></div>
        <form className="unlock-form" onSubmit={submitPassword}><div className="password-field"><KeyRound size={16} />
          <input autoFocus type="password" placeholder="Senha de acesso" value={password} onChange={e => setPassword(e.target.value)} />
          <button type="submit" disabled={busy || !password}>{busy ? "Validando…" : "Gerar"}</button></div></form>
      </div></div>}
    {target && <CountModal inv={target} onClose={() => setCounting(null)} onSaved={onSaved} />}
  </>;
}

function CountModal({ inv, onClose, onSaved }: { inv: Inventory; onClose: () => void; onSaved: (i: Inventory) => void }) {
  const [lines, setLines] = useState<InventoryLine[]>(inv.lines);
  const [by, setBy] = useState(inv.countedBy ?? readLocal(AUTHOR_KEY));
  const [photoIds, setPhotoIds] = useState<string[]>(inv.photoIds);
  const [comments, setComments] = useState<Comment[]>(inv.comments);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);

  const patch = (i: number, p: Partial<InventoryLine>) => { setLines(cur => cur.map((l, k) => (k === i ? { ...l, ...p } : l))); setDirty(true); };
  const left = lines.filter(l => l.counted == null).length;
  const missing = [left && `informar a contagem de ${left} item(ns) (use 0 se não houver)`, !by.trim() && "informar o nome de quem contou"].filter(Boolean) as string[];

  async function save(submit: boolean) {
    setBusy(true);
    try {
      const rec = await api.saveInventory({ id: inv.id, lines: lines.map(l => ({ key: l.key, label: l.label, counted: l.counted, extra: l.extra })), countedBy: by, photoIds, submit });
      writeLocal(AUTHOR_KEY, by.trim()); onSaved(rec); setDirty(false);
      toast.success(submit ? "Contagem enviada e registrada no histórico." : "Progresso salvo.");
      if (submit) onClose(); else setLines(rec.lines);
    } catch (e) { toast.error(errMsg(e, "Não foi possível salvar.")); }
    finally { setBusy(false); }
  }
  const close = () => { if (dirty && !window.confirm("Há alterações não salvas. Fechar mesmo assim?")) return; onClose(); };

  return <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget && !busy) close(); }}>
    <div className="modal-card movement-modal">
      <div className="modal-header"><div><div className="panel-kicker">CONTAGEM · VULCANO</div><h2>Inventário {inv.week}</h2><p className="modal-subtitle">Conte fisicamente cada item e informe a quantidade encontrada.</p></div>
        <button className="icon-close" aria-label="Fechar" onClick={close}><X size={19} /></button></div>
      <div className="check-items">{lines.map((l, i) => {
        const diff = l.counted != null && l.counted !== l.expected;
        return <div className={`check-item ${l.counted != null ? "checked" : ""} ${diff ? "diff" : ""}`} key={l.key}>
          <div className="check-info" style={{ flex: 1 }}>{l.extra
            ? <input className="mono" placeholder="PN encontrado" value={l.label} onChange={e => patch(i, { label: e.target.value })} />
            : <><strong className="mono">{l.label}</strong><small>{l.targets ? `volta como ${l.targets} · ` : ""}esperado {formatNumber(l.expected)} un</small></>}</div>
          <label className="check-qty">Contado<input type="number" min="0" step="1" inputMode="numeric" value={l.counted ?? ""} placeholder="0"
            onChange={e => patch(i, { counted: e.target.value === "" ? null : Number(e.target.value) })} /></label>
          {diff && <span className="level-badge critical">{l.counted! - l.expected > 0 ? "+" : ""}{l.counted! - l.expected}</span>}
          {l.extra && <button type="button" className="remove-item" aria-label="Remover item" onClick={() => { setLines(cur => cur.filter((_, k) => k !== i)); setDirty(true); }}><Trash2 size={15} /></button>}
        </div>;
      })}</div>
      <button type="button" className="add-item" style={{ marginBottom: 14 }} onClick={() => { setLines(cur => [...cur, { key: `new-${Date.now()}`, label: "", targets: "", expected: 0, counted: null, extra: true }]); setDirty(true); }}><Plus size={14} /> Item encontrado que não está na lista</button>
      <div className="movement-form">
        <label>Quem contou<input value={by} onChange={e => { setBy(e.target.value); setDirty(true); }} placeholder="Nome do responsável" maxLength={60} /></label>
        <div><div className="items-header" style={{ marginTop: 0 }}><div><strong>Fotos da contagem</strong><small>Opcional</small></div></div><PhotoPicker ids={photoIds} onChange={ids => { setPhotoIds(ids); setDirty(true); }} /></div>
        <div><div className="items-header" style={{ marginTop: 0 }}><div><strong>Comentários</strong><small>Ficam salvos no histórico</small></div></div>
          <CommentsBox comments={comments} onAdd={async (text, author) => { const rec = await api.commentInventory({ id: inv.id, text, author }); setComments(rec.comments); onSaved(rec); }} /></div>
        {!!missing.length && <div className="security-note" style={{ justifyContent: "flex-start" }}>Para enviar falta: {missing.join(", ")}.</div>}
        <div className="form-actions"><button type="button" className="btn" onClick={() => save(false)} disabled={busy}>Salvar progresso</button>
          <button type="button" className="btn primary-cta" onClick={() => save(true)} disabled={busy || !!missing.length}><Send size={15} /> {busy ? "Enviando…" : "Enviar contagem"}</button></div>
      </div>
    </div>
  </div>;
}
