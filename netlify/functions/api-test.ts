import { describe, expect, it } from "vitest";
import { handle, type DB, type KV } from "./api";

const mem = (): KV => {
  const m = new Map<string, unknown>();
  return {
    get: async k => m.get(k) ?? null,
    set: async (k, v) => { m.set(k, JSON.parse(JSON.stringify(v))); },
    delete: async k => { m.delete(k); },
    keys: async p => [...m.keys()].filter(k => k.startsWith(p)),
  };
};
const mkdb = (): DB => {
  const files = new Map<string, { bytes: Uint8Array; contentType: string }>();
  return { movements: mem(), rules: mem(), checks: mem(), inventories: mem(), photos: { put: async (k, b, c) => { files.set(k, { bytes: b, contentType: c }); }, get: async k => files.get(k) ?? null } };
};
const call = (db: any, method: string, path: string, body?: unknown, cookie?: string) =>
  handle(new Request(`https://x.test/api/${path}`, { method, body: body ? JSON.stringify(body) : undefined, headers: cookie ? { cookie } : {} }), db);

describe("api", () => {
  it("cria movimentos com vários PNs, normaliza e lista", async () => {
    const db = mkdb();
    const r = await call(db, "POST", "movements", { kind: "OUT_HD", nf: " nf-1 ", movementDate: "2026-10-01", items: [{ pn: "a-1", quantity: 5 }, { pn: "b", quantity: "7" }] });
    expect(r.status).toBe(201);
    const list = await (await call(db, "GET", "movements")).json();
    expect(list).toHaveLength(2);
    expect(list[0].nf).toBe("NF-1");
    expect(list.map((m: any) => m.pn).sort()).toEqual(["A-1", "B"]);
  });
  it("rejeita dados inválidos", async () => {
    const db = mkdb();
    expect((await call(db, "POST", "movements", { kind: "X", nf: "1", movementDate: "2026-10-01", items: [{ pn: "a", quantity: 1 }] })).status).toBe(400);
    expect((await call(db, "POST", "movements", { kind: "IN_HD", nf: "1", movementDate: "2026-13-45", items: [{ pn: "a", quantity: 1 }] })).status).toBe(400);
    expect((await call(db, "POST", "movements", { kind: "IN_HD", nf: "1", movementDate: "2026-10-01", items: [{ pn: "a", quantity: 0 }] })).status).toBe(400);
  });
  it("protege escrita de regras com senha", async () => {
    const db = mkdb();
    expect((await call(db, "POST", "rules", { fromPns: "A", toPns: "B" })).status).toBe(403);
    expect((await (await call(db, "POST", "rules/unlock", { password: "errada" })).json()).success).toBe(false);
    const ok = await call(db, "POST", "rules/unlock", { password: "Cd21092425" });
    const cookie = ok.headers.get("set-cookie")!.split(";")[0];
    expect((await (await call(db, "GET", "rules/status", undefined, cookie)).json()).unlocked).toBe(true);
    const created = await (await call(db, "POST", "rules", { fromPns: "A + B", toPns: "C" }, cookie)).json();
    expect(created.fromPns).toBe("A + B");
    expect((await call(db, "PUT", `rules/${created.id}`, { fromPns: "A", toPns: "D" }, cookie)).status).toBe(200);
    expect((await (await call(db, "GET", "rules")).json())[0].toPns).toBe("D");
    expect((await call(db, "DELETE", `rules/${created.id}`, undefined, cookie)).status).toBe(200);
    expect(await (await call(db, "GET", "rules")).json()).toEqual([]);
  });
  it("cookie forjado não libera", async () => {
    const db = mkdb();
    expect((await call(db, "POST", "rules", { fromPns: "A", toPns: "B" }, `nf_rules_access=${Date.now() + 99999}.deadbeef`)).status).toBe(403);
  });

  const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
  const checkBody = (extra: object = {}) => ({ direction: "HD_TO_VULCANO", stage: "LOAD", nf: " nf-7 ", items: [{ pn: "a", expected: 10, counted: 10, checked: true }], checkedBy: "Ana", photoIds: [], ...extra });

  it("conferência: rascunho, validações de envio, foto, comentário e bloqueio após enviar", async () => {
    const db = mkdb();
    expect((await call(db, "POST", "checks/save", checkBody())).status).toBe(200);
    expect((await call(db, "POST", "checks/save", checkBody({ submit: true }))).status).toBe(400); // sem foto
    expect((await call(db, "POST", "checks/save", checkBody({ submit: true, items: [{ pn: "a", expected: 10, counted: 10, checked: false }], photoIds: ["abcdefgh1"] }))).status).toBe(400); // item não conferido
    const photo = await (await call(db, "POST", "photos", { dataUrl: PNG })).json();
    expect((await call(db, "POST", "photos", { dataUrl: "data:text/html;base64,AAAA" })).status).toBe(400);
    const img = await call(db, "GET", `photos/${photo.id}`);
    expect(img.headers.get("content-type")).toBe("image/png");
    const ok = await call(db, "POST", "checks/save", checkBody({ submit: true, photoIds: [photo.id] }));
    const done = await ok.json();
    expect(done).toMatchObject({ status: "done", nf: "NF-7", checkedBy: "Ana" });
    expect((await call(db, "POST", "checks/save", checkBody())).status).toBe(409);
    expect((await call(db, "POST", "checks/comment", { direction: "HD_TO_VULCANO", stage: "LOAD", nf: "NF-7", text: "Caixa amassada", author: "João" })).status).toBe(200);
    expect((await call(db, "POST", "checks/comment", { direction: "HD_TO_VULCANO", stage: "LOAD", nf: "NF-7", text: "x", author: "" })).status).toBe(400);
    const list = await (await call(db, "GET", "checks")).json();
    expect(list).toHaveLength(1);
    expect(list[0].comments[0]).toMatchObject({ text: "Caixa amassada", author: "João" });
  });

  it("inventário: só a HD (senha) gera; Vulcano conta; semana única; contagem trava", async () => {
    const db = mkdb();
    const gen = { date: "2026-10-16", lines: [{ key: "g1", label: "a", targets: "b", expected: 40 }] };
    expect((await call(db, "POST", "inventories", gen)).status).toBe(403);
    const cookie = (await call(db, "POST", "rules/unlock", { password: "Cd21092425" })).headers.get("set-cookie")!.split(";")[0];
    const created = await (await call(db, "POST", "inventories", gen, cookie)).json();
    expect(created).toMatchObject({ id: "2026-W42", status: "pending" });
    expect((await call(db, "POST", "inventories", gen, cookie)).status).toBe(409);
    const countLines = [{ key: "g1", counted: 38 }, { extra: true, label: "z-9", counted: 3 }];
    expect((await call(db, "POST", "inventories/save", { id: "2026-W42", lines: countLines, submit: true })).status).toBe(400); // sem nome
    const res = await (await call(db, "POST", "inventories/save", { id: "2026-W42", lines: countLines, countedBy: "Carlos", submit: true })).json();
    expect(res.status).toBe("counted");
    expect(res.lines.map((l: any) => [l.label, l.expected, l.counted])).toEqual([["A", 40, 38], ["Z-9", 0, 3]]);
    expect((await call(db, "POST", "inventories/save", { id: "2026-W42", lines: countLines })).status).toBe(409);
    expect((await call(db, "DELETE", "inventories/2026-W42", undefined, cookie)).status).toBe(409);
  });

  it("saída do fornecedor exige NF de referência e normaliza várias referências", async () => {
    const db = mkdb();
    const body = { kind: "OUT_FORNECEDOR", nf: "900", movementDate: "2026-10-01", items: [{ pn: "a", quantity: 5 }] };
    expect((await call(db, "POST", "movements", body)).status).toBe(400);
    const ok = await call(db, "POST", "movements", { ...body, refNf: " nf-100 , nf-101" });
    expect(ok.status).toBe(201);
    expect((await ok.json())[0].refNf).toBe("NF-100 + NF-101");
    const other = await (await call(db, "POST", "movements", { kind: "OUT_HD", nf: "1", movementDate: "2026-10-01", items: [{ pn: "a", quantity: 1 }], refNf: "x" })).json();
    expect(other[0].refNf).toBeNull();
  });
});
