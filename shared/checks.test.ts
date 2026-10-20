import { describe, expect, it } from "vitest";
import { buildShipments, buildTasks, isoWeek, sideOf } from "./checks";
import type { Check, Kind, Movement } from "./types";

let n = 0;
const mv = (kind: Kind, nf: string, pn: string, quantity: number, d = "2026-10-01"): Movement => ({ id: String(++n), kind, nf, movementDate: d, pn, quantity, notes: null, createdAt: "" });

describe("conferência", () => {
  it("quem emite confere o carregamento, quem recebe confere o recebimento", () => {
    expect(sideOf("HD_TO_VULCANO", "LOAD")).toBe("HD");
    expect(sideOf("HD_TO_VULCANO", "RECEIPT")).toBe("VULCANO");
    expect(sideOf("VULCANO_TO_HD", "LOAD")).toBe("VULCANO");
    expect(sideOf("VULCANO_TO_HD", "RECEIPT")).toBe("HD");
  });
  it("toda NF lançada gera duas conferências (carregamento e recebimento)", () => {
    const s = buildShipments([mv("OUT_HD", "nf-1", "a", 5), mv("OUT_HD", "NF-1", "B", 2), mv("OUT_FORNECEDOR", "NF-1", "A", 1)]);
    expect(s).toHaveLength(2); // mesma NF em sentidos diferentes são remessas diferentes
    const t = buildTasks(s, []);
    expect(t).toHaveLength(4);
    expect(t.filter(x => x.status === "pending")).toHaveLength(4);
  });
  it("entrada lançada sem saída usa as linhas da entrada; saída tem prioridade", () => {
    expect(buildShipments([mv("IN_FORNECEDOR", "9", "A", 7)])[0].items).toEqual([{ pn: "A", expected: 7 }]);
    expect(buildShipments([mv("OUT_HD", "9", "A", 10), mv("IN_FORNECEDOR", "9", "A", 8)])[0].items).toEqual([{ pn: "A", expected: 10 }]);
  });
  it("status: pendente, em andamento, concluída", () => {
    const s = buildShipments([mv("OUT_HD", "1", "A", 5)]);
    const base: Omit<Check, "status" | "items"> = { id: "x", direction: "HD_TO_VULCANO", stage: "LOAD", nf: "1", checkedBy: null, doneAt: null, photoIds: [], comments: [], createdAt: "", updatedAt: "" };
    const draft: Check = { ...base, status: "draft", items: [{ pn: "A", expected: 5, counted: 5, checked: true }] };
    expect(buildTasks(s, [draft]).find(t => t.stage === "LOAD")!.status).toBe("draft");
    expect(buildTasks(s, [{ ...draft, status: "done" }]).find(t => t.stage === "LOAD")!.status).toBe("done");
    expect(buildTasks(s, [{ ...draft, items: [] }]).find(t => t.stage === "LOAD")!.status).toBe("pending");
  });
  it("semana ISO", () => {
    expect(isoWeek("2026-10-16")).toEqual({ id: "2026-W42", start: "2026-10-12", end: "2026-10-18" });
    expect(isoWeek("2026-01-01").id).toBe("2026-W01");
    expect(isoWeek("2027-01-01").id).toBe("2026-W53");
  });
});
