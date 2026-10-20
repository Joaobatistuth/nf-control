import { describe, expect, it } from "vitest";
import { computeInsights } from "./insights";
import type { Check, Kind, Movement } from "./types";

let n = 0;
const mv = (kind: Kind, nf: string, pn: string, quantity: number, movementDate: string): Movement => ({ id: String(++n).padStart(4, "0"), kind, nf, movementDate, pn, quantity, notes: null, createdAt: "" });
const TODAY = "2026-10-20";

describe("insights", () => {
  it("alerta NF que saiu da HD e não entrou no fornecedor, com severidade por dias", () => {
    const i = computeInsights([mv("OUT_HD", "1", "A", 10, "2026-10-10"), mv("OUT_HD", "2", "A", 5, "2026-10-19")], [], TODAY);
    const a = i.alerts.filter(x => x.kind === "NOT_RECEIVED_SUPPLIER");
    expect(a.map(x => [x.nf, x.severity])).toEqual([["1", "critical"], ["2", "info"]]);
    expect(i.openDocs).toHaveLength(2);
  });
  it("NF recebida some dos alertas de trânsito; divergência de quantidade é crítica", () => {
    const i = computeInsights([mv("OUT_HD", "1", "A", 10, "2026-10-10"), mv("IN_FORNECEDOR", "1", "A", 8, "2026-10-12")], [], TODAY);
    expect(i.alerts.some(x => x.kind === "NOT_RECEIVED_SUPPLIER")).toBe(false);
    expect(i.alerts.find(x => x.kind === "QTY_DIVERGENCE")).toMatchObject({ severity: "critical", nf: "1" });
  });
  it("divide o estoque externo em trânsito ida, no fornecedor e trânsito volta", () => {
    const i = computeInsights([
      mv("OUT_HD", "1", "A", 100, "2026-10-01"), mv("IN_FORNECEDOR", "1", "A", 100, "2026-10-02"),
      mv("OUT_HD", "2", "A", 50, "2026-10-18"),
      mv("OUT_FORNECEDOR", "9", "A", 30, "2026-10-15"),
      mv("IN_HD", "7", "A", 20, "2026-10-16"),
    ], [], TODAY);
    expect(i.totals.outside).toBe(130);
    expect(i.totals.transitTo).toBe(50);
    expect(i.totals.transitBack).toBe(30);
    expect(i.totals.atSupplier).toBe(50);
  });
  it("retorno abate as saídas mais antigas (aging)", () => {
    const i = computeInsights([mv("OUT_HD", "1", "A", 10, "2026-09-01"), mv("OUT_HD", "2", "A", 10, "2026-10-18"), mv("IN_HD", "5", "A", 10, "2026-10-19")], [], TODAY);
    expect(i.external[0].oldestDate).toBe("2026-10-18");
    expect(i.aging.find(b => b.label === "0–3 dias")!.units).toBe(10);
    expect(i.aging.find(b => b.label === "30+ dias")!.units).toBe(0);
  });
  it("detecta recebimento sem saída e duplicidade", () => {
    const i = computeInsights([mv("IN_FORNECEDOR", "8", "A", 1, "2026-10-19"), mv("OUT_HD", "3", "B", 2, "2026-10-19"), mv("OUT_HD", "3", "B", 2, "2026-10-19")], [], TODAY);
    expect(i.alerts.some(x => x.kind === "RECEIPT_WITHOUT_EXIT")).toBe(true);
    expect(i.alerts.some(x => x.kind === "DUPLICATE")).toBe(true);
  });

  it("alerta NF lançada sem conferência e inventário pendente; divergência de conferência é crítica", () => {
    const base: Omit<Check, "status" | "items" | "doneAt"> = { id: "c1", direction: "HD_TO_VULCANO", stage: "LOAD", nf: "1", checkedBy: "Ana", photoIds: ["p"], comments: [], createdAt: "", updatedAt: "" };
    const movs = [mv("OUT_HD", "1", "A", 10, "2026-10-10"), mv("OUT_HD", "2", "A", 5, "2026-10-19")];
    const done: Check = { ...base, status: "done", doneAt: "2026-10-11T10:00:00Z", items: [{ pn: "A", expected: 10, counted: 8, checked: true }] };
    const inv = { id: "2026-W43", week: "2026-W43", weekStart: "2026-10-19", weekEnd: "2026-10-25", status: "pending" as const, lines: [{ key: "k", label: "A", targets: "A", expected: 4, counted: null }], generatedAt: "2026-10-19T10:00:00Z", countedBy: null, countedAt: null, photoIds: [], comments: [], updatedAt: "" };
    const i = computeInsights(movs, [], TODAY, { checks: [done], inventories: [inv] });
    expect(i.alerts.find(a => a.kind === "CHECK_LOAD_PENDING")).toMatchObject({ nf: "2" });
    expect(i.alerts.some(a => a.kind === "CHECK_LOAD_PENDING" && a.nf === "1")).toBe(false);
    expect(i.alerts.find(a => a.kind === "CHECK_RECEIPT_PENDING" && a.nf === "1")).toBeTruthy();
    expect(i.alerts.find(a => a.kind === "CHECK_DIVERGENCE")?.severity).toBe("critical");
    expect(i.alerts.find(a => a.kind === "INVENTORY_PENDING")).toBeTruthy();
    expect(i.checkStats.divergences).toBe(1);
    expect(i.inventoryInfo.status).toBe("pending");
  });

  it("alerta saída do fornecedor que não casa com a NF de referência, sem referência ou com referência inexistente", () => {
    const ret = (nf: string, pn: string, q: number, ref: string | null) => ({ ...mv("OUT_FORNECEDOR", nf, pn, q, "2026-10-15"), refNf: ref });
    const base = [mv("OUT_HD", "100", "A", 10, "2026-10-01")];
    const kinds = (m: Movement[]) => computeInsights(m, [], TODAY).alerts.filter(a => a.kind.startsWith("RETURN_")).map(a => `${a.kind}:${a.nf}`);
    expect(kinds([...base, ret("900", "A", 12, "100")])).toEqual(["RETURN_MISMATCH:900"]);
    expect(kinds([...base, ret("900", "A", 10, "100")])).toEqual([]);
    expect(kinds([...base, ret("900", "A", 10, null)])).toEqual(["RETURN_NO_REF:900"]);
    expect(kinds([...base, ret("900", "A", 10, "555")])).toEqual(["RETURN_REF_NOT_FOUND:900"]);
  });
});
