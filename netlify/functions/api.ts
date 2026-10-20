import { getStore } from "@netlify/blobs";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { isoWeek } from "../../shared/checks";
import { KINDS, type Check, type CheckItem, type Comment, type Direction, type Inventory, type InventoryLine, type Kind, type Movement, type Rule, type Stage } from "../../shared/types";

/**
 * API do NF Control (Netlify Functions v2 + Netlify Blobs).
 * Variáveis de ambiente opcionais (Site settings → Environment variables):
 *   RULES_PASSWORD  senha da aba de regras (padrão: Cd21092425)
 *   SESSION_SECRET  segredo para assinar o cookie de acesso (recomendado)
 */

export const config = { path: "/api/*" };

export type KV = {
  get(key: string): Promise<unknown | null>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  keys(prefix: string): Promise<string[]>;
};

export function blobKV(name: string): KV {
  const store = getStore({ name, consistency: "strong" });
  return {
    get: key => store.get(key, { type: "json" }) as Promise<unknown | null>,
    set: async (key, value) => { await store.setJSON(key, value); },
    delete: key => store.delete(key),
    keys: async prefix => (await store.list({ prefix })).blobs.map(b => b.key),
  };
}

export type PhotoStore = {
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<{ bytes: Uint8Array; contentType: string } | null>;
};
export type DB = { movements: KV; rules: KV; checks: KV; inventories: KV; photos: PhotoStore };

export function blobPhotos(name: string): PhotoStore {
  const store = getStore({ name, consistency: "strong" });
  return {
    put: async (key, bytes, contentType) => {
      const copy = new Uint8Array(bytes); // ArrayBuffer próprio, sem offset
      await store.set(key, copy.buffer as ArrayBuffer, { metadata: { contentType } });
    },
    get: async key => {
      const r = await store.getWithMetadata(key, { type: "arrayBuffer" });
      return r ? { bytes: new Uint8Array(r.data), contentType: String(r.metadata?.contentType ?? "image/jpeg") } : null;
    },
  };
}

const COOKIE = "nf_rules_access";
const SESSION_MS = 2 * 60 * 60 * 1000;
const DEFAULT_PASSWORD = "Cd21092425";

const password = () => process.env.RULES_PASSWORD || DEFAULT_PASSWORD;
const secret = () => process.env.SESSION_SECRET || `nf-control:${password()}`;
const sign = (payload: string) => createHmac("sha256", secret()).update(payload).digest("hex");

function safeEqual(a: string, b: string) {
  const ba = Buffer.from(a), bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}
function makeToken() {
  const exp = String(Date.now() + SESSION_MS);
  return `${exp}.${sign(exp)}`;
}
function hasAccess(req: Request) {
  const raw = req.headers.get("cookie") ?? "";
  const part = raw.split(";").map(s => s.trim()).find(s => s.startsWith(`${COOKIE}=`));
  if (!part) return false;
  const [exp, sig] = part.slice(COOKIE.length + 1).split(".");
  return !!exp && !!sig && Number(exp) > Date.now() && safeEqual(sig, sign(exp));
}
const cookieHeader = (value: string, maxAge: number) =>
  `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers } });
const fail = (status: number, message: string) => json({ error: message }, status);

const newId = () => `${Date.now().toString(36).padStart(9, "0")}-${randomBytes(3).toString("hex")}`;
const clean = (v: unknown, max: number) => (typeof v === "string" ? v.trim().replace(/\s+/g, " ").slice(0, max) : "");

async function readAll<T>(kv: KV, prefix: string): Promise<T[]> {
  const keys = await kv.keys(prefix);
  const out: T[] = [];
  for (let i = 0; i < keys.length; i += 40) {
    const chunk = await Promise.all(keys.slice(i, i + 40).map(k => kv.get(k)));
    for (const item of chunk) if (item) out.push(item as T);
  }
  return out;
}

export async function handle(req: Request, db: DB): Promise<Response> {
  const url = new URL(req.url);
  const parts = url.pathname.replace(/^\/(\.netlify\/functions\/api|api)\/?/, "").split("/").filter(Boolean);
  const [resource, id] = parts;
  const method = req.method.toUpperCase();
  let body: any = {};
  if (method === "POST" || method === "PUT") {
    try { body = await req.json(); } catch { body = {}; }
  }

  try {
    // ---------- health ----------
    if (resource === "health") return json({ status: "ok" });

    // ---------- movimentações ----------
    if (resource === "movements") {
      if (method === "GET" && !id) {
        const all = await readAll<Movement>(db.movements, "m/");
        all.sort((a, b) => b.movementDate.localeCompare(a.movementDate) || b.id.localeCompare(a.id));
        return json(all);
      }
      if (method === "POST" && !id) {
        const kind = body.kind as Kind;
        const nf = clean(body.nf, 64).toUpperCase();
        const date = clean(body.movementDate, 10);
        const notes = clean(body.notes, 1000) || null;
        const items = Array.isArray(body.items) ? body.items : [];
        if (!KINDS.includes(kind)) return fail(400, "Tipo de movimentação inválido.");
        if (!nf) return fail(400, "Informe a nota fiscal.");
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) return fail(400, "Data inválida.");
        const refNf = kind === "OUT_FORNECEDOR"
          ? clean(body.refNf, 200).toUpperCase().split(/[+,;]/).map(x => x.trim()).filter(Boolean).join(" + ") : "";
        if (kind === "OUT_FORNECEDOR" && !refNf) return fail(400, "Informe a NF de referência (NF de entrada) da saída do fornecedor.");
        const lines = items
          .map((i: any) => ({ pn: clean(i?.pn, 128).toUpperCase(), quantity: Number(i?.quantity) }))
          .filter((i: { pn: string; quantity: number }) => i.pn && Number.isInteger(i.quantity) && i.quantity > 0);
        if (!lines.length) return fail(400, "Informe ao menos um PN com quantidade inteira maior que zero.");
        if (lines.length > 200) return fail(400, "Máximo de 200 itens por NF.");
        const created: Movement[] = [];
        for (const line of lines) {
          const m: Movement = { id: newId(), kind, nf, movementDate: date, pn: line.pn, quantity: line.quantity, notes, refNf: refNf || null, createdAt: new Date().toISOString() };
          await db.movements.set(`m/${m.id}`, m);
          created.push(m);
        }
        return json(created, 201);
      }
      if (method === "DELETE" && id) {
        await db.movements.delete(`m/${id}`);
        return json({ success: true });
      }
    }


    // ---------- fotos ----------
    if (resource === "photos") {
      if (method === "POST" && !id) {
        const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(typeof body.dataUrl === "string" ? body.dataUrl : "");
        if (!m) return fail(400, "Imagem inválida. Envie JPG, PNG ou WEBP.");
        const bytes = new Uint8Array(Buffer.from(m[2], "base64"));
        if (!bytes.length || bytes.length > 3 * 1024 * 1024) return fail(400, "A foto deve ter até 3 MB.");
        const photoId = newId();
        await db.photos.put(`p/${photoId}`, bytes, m[1]);
        return json({ id: photoId }, 201);
      }
      if (method === "GET" && id && /^[a-z0-9-]{8,40}$/.test(id)) {
        const p = await db.photos.get(`p/${id}`);
        if (!p) return fail(404, "Foto não encontrada.");
        return new Response(p.bytes as unknown as BodyInit, { headers: { "Content-Type": p.contentType, "Cache-Control": "private, max-age=31536000, immutable" } });
      }
    }

    // ---------- conferência de NF ----------
    if (resource === "checks") {
      if (method === "GET" && !id) {
        const all = await readAll<Check>(db.checks, "c/");
        all.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        return json(all);
      }
      if (method === "POST" && (id === "save" || id === "comment")) {
        const direction = body.direction as Direction, stage = body.stage as Stage;
        const nf = clean(body.nf, 64).toUpperCase();
        if (!["HD_TO_VULCANO", "VULCANO_TO_HD"].includes(direction) || !["LOAD", "RECEIPT"].includes(stage) || !nf) return fail(400, "Conferência inválida.");
        const key = `c/${direction}.${stage}.${Buffer.from(nf).toString("base64url")}`;
        const now = new Date().toISOString();
        const current = ((await db.checks.get(key)) as Check | null) ?? {
          id: key.slice(2), direction, stage, nf, items: [], status: "draft", checkedBy: null, doneAt: null, photoIds: [], comments: [], createdAt: now, updatedAt: now,
        } as Check;

        if (id === "comment") {
          const text = clean(body.text, 1000), author = clean(body.author, 60);
          if (!text) return fail(400, "Escreva o comentário.");
          if (!author) return fail(400, "Informe seu nome para comentar.");
          if (current.comments.length >= 200) return fail(400, "Limite de comentários atingido.");
          current.comments.push({ id: newId(), text, author, at: now });
          current.updatedAt = now;
          await db.checks.set(key, current);
          return json(current);
        }

        if (current.status === "done") return fail(409, "Esta conferência já foi enviada e não pode mais ser alterada.");
        const rawItems = Array.isArray(body.items) ? body.items.slice(0, 300) : [];
        const items: CheckItem[] = [];
        for (const i of rawItems as any[]) {
          const pn = clean(i?.pn, 128).toUpperCase(), expected = Number(i?.expected);
          const counted = i?.counted === null || i?.counted === undefined || i?.counted === "" ? null : Number(i.counted);
          if (!pn || !Number.isInteger(expected) || expected < 0 || (counted !== null && (!Number.isInteger(counted) || counted < 0))) return fail(400, "Item de conferência inválido (quantidade deve ser inteira).");
          items.push({ pn, expected, counted, checked: i?.checked === true });
        }
        const photoIds = (Array.isArray(body.photoIds) ? body.photoIds : []).filter((p: unknown) => typeof p === "string" && /^[a-z0-9-]{8,40}$/.test(p)).slice(0, 5) as string[];
        const checkedBy = clean(body.checkedBy, 60) || null;
        const submit = body.submit === true;
        if (submit) {
          if (!items.length || items.some(i => !i.checked)) return fail(400, "Marque todos os itens como conferidos antes de enviar.");
          if (!photoIds.length) return fail(400, "Anexe ao menos uma foto antes de enviar.");
          if (!checkedBy) return fail(400, "Informe o nome de quem conferiu.");
        }
        Object.assign(current, { items, photoIds, checkedBy, updatedAt: now });
        if (submit) Object.assign(current, { status: "done", doneAt: now, items: items.map(i => ({ ...i, counted: i.counted ?? i.expected })) });
        await db.checks.set(key, current);
        return json(current);
      }
    }

    // ---------- inventário semanal ----------
    if (resource === "inventories") {
      if (method === "GET" && !id) {
        const all = await readAll<Inventory>(db.inventories, "i/");
        all.sort((a, b) => b.week.localeCompare(a.week));
        return json(all);
      }
      if (method === "POST" && !id) {
        if (!hasAccess(req)) return fail(403, "Somente a HD (com senha) pode gerar o inventário.");
        const date = clean(body.date, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) return fail(400, "Data inválida.");
        const w = isoWeek(date);
        if (await db.inventories.get(`i/${w.id}`)) return fail(409, `Já existe inventário para a semana ${w.id}. Exclua o pendente para gerar outro.`);
        const lines: InventoryLine[] = [];
        for (const l of (Array.isArray(body.lines) ? body.lines.slice(0, 300) : []) as any[]) {
          const label = clean(l?.label, 200).toUpperCase(), expected = Number(l?.expected);
          if (!label || !Number.isInteger(expected) || expected < 0) return fail(400, "Linha de inventário inválida.");
          lines.push({ key: clean(l?.key, 200) || label, label, targets: clean(l?.targets, 200).toUpperCase(), expected, counted: null });
        }
        const now = new Date().toISOString();
        const inv: Inventory = { id: w.id, week: w.id, weekStart: w.start, weekEnd: w.end, status: "pending", lines, generatedAt: now, countedBy: null, countedAt: null, photoIds: [], comments: [], updatedAt: now };
        await db.inventories.set(`i/${w.id}`, inv);
        return json(inv, 201);
      }
      if (method === "DELETE" && id) {
        if (!hasAccess(req)) return fail(403, "Somente a HD (com senha) pode excluir o inventário.");
        const inv = (await db.inventories.get(`i/${id}`)) as Inventory | null;
        if (!inv) return fail(404, "Inventário não encontrado.");
        if (inv.status === "counted") return fail(409, "Inventário já contado não pode ser excluído.");
        await db.inventories.delete(`i/${id}`);
        return json({ success: true });
      }
      if (method === "POST" && (id === "save" || id === "comment")) {
        const invId = clean(body.id, 20);
        const inv = (await db.inventories.get(`i/${invId}`)) as Inventory | null;
        if (!inv) return fail(404, "Inventário não encontrado.");
        const now = new Date().toISOString();
        if (id === "comment") {
          const text = clean(body.text, 1000), author = clean(body.author, 60);
          if (!text) return fail(400, "Escreva o comentário.");
          if (!author) return fail(400, "Informe seu nome para comentar.");
          if (inv.comments.length >= 200) return fail(400, "Limite de comentários atingido.");
          inv.comments.push({ id: newId(), text, author, at: now } as Comment);
          inv.updatedAt = now;
          await db.inventories.set(`i/${invId}`, inv);
          return json(inv);
        }
        if (inv.status === "counted") return fail(409, "Este inventário já foi enviado e não pode mais ser alterado.");
        const lines: InventoryLine[] = [];
        for (const l of (Array.isArray(body.lines) ? body.lines.slice(0, 400) : []) as any[]) {
          const counted = l?.counted === null || l?.counted === undefined || l?.counted === "" ? null : Number(l.counted);
          if (counted !== null && (!Number.isInteger(counted) || counted < 0)) return fail(400, "Quantidade contada deve ser inteira e não negativa.");
          const original = inv.lines.find(x => x.key === l?.key && !x.extra);
          if (original) lines.push({ ...original, counted });
          else if (l?.extra === true) {
            const label = clean(l?.label, 200).toUpperCase();
            if (!label) return fail(400, "Informe o PN do item não listado.");
            lines.push({ key: `extra-${lines.length}-${label}`, label, targets: "", expected: 0, counted, extra: true });
          }
        }
        for (const o of inv.lines) if (!lines.some(l => l.key === o.key)) lines.push(o); // nunca perde linha gerada pela HD
        const countedBy = clean(body.countedBy, 60) || null;
        const photoIds = (Array.isArray(body.photoIds) ? body.photoIds : []).filter((p: unknown) => typeof p === "string" && /^[a-z0-9-]{8,40}$/.test(p)).slice(0, 5) as string[];
        if (body.submit === true) {
          if (lines.some(l => l.counted === null)) return fail(400, "Informe a quantidade contada de todos os itens (use 0 quando não houver).");
          if (!countedBy) return fail(400, "Informe o nome de quem contou.");
        }
        Object.assign(inv, { lines, countedBy, photoIds, updatedAt: now });
        if (body.submit === true) Object.assign(inv, { status: "counted", countedAt: now });
        await db.inventories.set(`i/${invId}`, inv);
        return json(inv);
      }
    }

    // ---------- regras ----------
    if (resource === "rules") {
      if (id === "status" && method === "GET") return json({ unlocked: hasAccess(req) });
      if (id === "unlock" && method === "POST") {
        if (typeof body.password !== "string" || !safeEqual(body.password, password())) {
          await new Promise(r => setTimeout(r, 600)); // freia tentativas de força bruta
          return json({ success: false });
        }
        return json({ success: true }, 200, { "Set-Cookie": cookieHeader(makeToken(), SESSION_MS / 1000) });
      }
      if (id === "lock" && method === "POST") return json({ success: true }, 200, { "Set-Cookie": cookieHeader("", 0) });

      // Leitura liberada: o dashboard precisa das regras para conciliar.
      if (method === "GET" && !id) {
        const all = await readAll<Rule>(db.rules, "r/");
        all.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        return json(all);
      }

      // Escrita: somente com a senha liberada
      if (!hasAccess(req)) return fail(403, "Acesso às regras não autorizado. Digite a senha novamente.");
      const fields = () => {
        const fromPns = clean(body.fromPns, 1000), toPns = clean(body.toPns, 1000);
        if (!fromPns || !toPns) return null;
        return { fromPns, toPns, description: clean(body.description, 255) || null, active: body.active === 0 ? 0 : 1 };
      };
      if (method === "POST" && !id) {
        const f = fields();
        if (!f) return fail(400, "Informe os PNs de saída e de retorno.");
        const now = new Date().toISOString();
        const rule: Rule = { id: newId(), ...f, createdAt: now, updatedAt: now };
        await db.rules.set(`r/${rule.id}`, rule);
        return json(rule, 201);
      }
      if (method === "PUT" && id) {
        const current = (await db.rules.get(`r/${id}`)) as Rule | null;
        if (!current) return fail(404, "Regra não encontrada.");
        const f = fields();
        if (!f) return fail(400, "Informe os PNs de saída e de retorno.");
        const rule: Rule = { ...current, ...f, updatedAt: new Date().toISOString() };
        await db.rules.set(`r/${id}`, rule);
        return json(rule);
      }
      if (method === "DELETE" && id) {
        await db.rules.delete(`r/${id}`);
        return json({ success: true });
      }
    }

    return fail(404, "Rota não encontrada.");
  } catch (error) {
    console.error("[api]", error);
    return fail(500, "Erro interno ao acessar o armazenamento.");
  }
}

export default async (req: Request) =>
  handle(req, { movements: blobKV("nf-movements"), rules: blobKV("nf-rules"), checks: blobKV("nf-checks"), inventories: blobKV("nf-inventories"), photos: blobPhotos("nf-photos") });
