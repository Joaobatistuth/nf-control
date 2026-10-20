import { useRef, useState } from "react";
import { Camera, Loader2, Send, X } from "lucide-react";
import { toast } from "sonner";
import { api, photoUrl } from "@/lib/api";
import { errMsg, formatDateTime, readLocal, writeLocal } from "@/lib/format";
import { fileToDataUrl } from "@/lib/image";
import type { Comment } from "@shared/types";

export const AUTHOR_KEY = "nf_author";

export function PhotoGallery({ ids }: { ids: string[] }) {
  if (!ids.length) return <div className="muted-text" style={{ fontSize: 11 }}>Nenhuma foto anexada.</div>;
  return <div className="photo-grid">{ids.map(id => <a key={id} href={photoUrl(id)} target="_blank" rel="noreferrer"><img src={photoUrl(id)} alt="Foto da conferência" loading="lazy" /></a>)}</div>;
}

export function PhotoPicker({ ids, onChange, disabled, max = 3 }: { ids: string[]; onChange: (ids: string[]) => void; disabled?: boolean; max?: number }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  async function pick(files: FileList | null) {
    if (!files?.length) return;
    setBusy(true);
    try {
      const next = [...ids];
      for (const file of Array.from(files).slice(0, max - ids.length)) {
        const { id } = await api.uploadPhoto(await fileToDataUrl(file));
        next.push(id);
      }
      onChange(next);
    } catch (e) {
      toast.error(errMsg(e, "Não foi possível enviar a foto. Tente novamente."));
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  }

  return <div className="photo-picker">
    <div className="photo-grid">
      {ids.map(id => <div className="photo-thumb" key={id}>
        <a href={photoUrl(id)} target="_blank" rel="noreferrer"><img src={photoUrl(id)} alt="Foto anexada" /></a>
        {!disabled && <button type="button" aria-label="Remover foto" onClick={() => onChange(ids.filter(x => x !== id))}><X size={12} /></button>}
      </div>)}
      {!disabled && ids.length < max && <button type="button" className="photo-add" disabled={busy} onClick={() => input.current?.click()}>
        {busy ? <Loader2 size={18} className="spin" /> : <Camera size={18} />}<span>{busy ? "Enviando…" : "Tirar / anexar foto"}</span>
      </button>}
    </div>
    <input ref={input} type="file" accept="image/*" capture="environment" multiple hidden onChange={e => pick(e.target.files)} />
  </div>;
}

export function CommentsBox({ comments, onAdd }: { comments: Comment[]; onAdd: (text: string, author: string) => Promise<void> }) {
  const [text, setText] = useState("");
  const [author, setAuthor] = useState(readLocal(AUTHOR_KEY));
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!text.trim()) return toast.error("Escreva o comentário.");
    if (!author.trim()) return toast.error("Informe seu nome para comentar.");
    setBusy(true);
    try { await onAdd(text, author); writeLocal(AUTHOR_KEY, author.trim()); setText(""); toast.success("Comentário salvo."); }
    catch (e) { toast.error(errMsg(e, "Não foi possível salvar o comentário.")); }
    finally { setBusy(false); }
  }

  return <div className="comments-box">
    {comments.length ? <div className="comment-list">{comments.map(c => <div className="comment" key={c.id}>
      <div><strong>{c.author}</strong><small>{formatDateTime(c.at)}</small></div><p>{c.text}</p></div>)}</div>
      : <div className="muted-text" style={{ fontSize: 11 }}>Nenhum comentário ainda.</div>}
    <div className="comment-form">
      <input placeholder="Seu nome" value={author} onChange={e => setAuthor(e.target.value)} maxLength={60} />
      <textarea rows={2} placeholder="Escreva um comentário (fica salvo no histórico)…" value={text} onChange={e => setText(e.target.value)} maxLength={1000} />
      <button type="button" className="btn btn-sm" onClick={submit} disabled={busy}><Send size={13} /> {busy ? "Salvando…" : "Comentar"}</button>
    </div>
  </div>;
}
