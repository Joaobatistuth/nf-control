import { describe, expect, it } from "vitest";
import { matchReturn, parseRefs } from "./match";
import type { Kind, Movement, Rule } from "./types";

let n = 0;
const mv = (kind: Kind, nf: string, pn: string, quantity: number, refNf: string | null = null): Movement => ({ id: String(++n), kind, nf, movementDate: "2026-10-01", pn, quantity, notes: null, refNf, createdAt: "" });
const rule = (fromPns: string, toPns: string): Rule => ({ id: `r-${fromPns}`, fromPns, toPns, description: null, active: 1, createdAt: "", updatedAt: "" });
const entry = [mv("OUT_HD", "100", "A", 60), mv("OUT_HD", "100", "B", 40)];
const L = (...a: [string, number][]) => a.map(([pn, qty]) => ({ pn, qty }));

describe("casamento NF de saída × NF de referência", () => {
  it("casa quando PNs e quantidades batem", () => {
    expect(matchReturn(entry, [], "900", ["100"], L(["A", 60], ["B", 40])).status).toBe("match");
  });
  it("devolução parcial e depois completa em duas NFs", () => {
    const first = [...entry, mv("OUT_FORNECEDOR", "900", "A", 60, "100")];
    expect(matchReturn(first, [], "900", ["100"], L(["A", 60])).status).toBe("partial");
    const both = [...first, mv("OUT_FORNECEDOR", "901", "B", 40, "100")];
    expect(matchReturn(both, [], "901", ["100"], L(["B", 40])).status).toBe("match");
  });
  it("devolver mais do que entrou ou PN que não veio é divergência", () => {
    expect(matchReturn(entry, [], "900", ["100"], L(["A", 70], ["B", 40])).status).toBe("diverge");
    const r = matchReturn(entry, [], "900", ["100"], L(["A", 60], ["Z", 5]));
    expect(r.status).toBe("diverge");
    expect(r.unexpected).toEqual([{ pn: "Z", qty: 5 }]);
  });
  it("usa as regras de retrabalho (PN que entra ≠ PN que volta)", () => {
    expect(matchReturn(entry, [rule("A", "A-R"), rule("B", "B-R")], "900", ["100"], L(["A-R", 60], ["B-R", 40])).status).toBe("match");
    expect(matchReturn(entry, [], "900", ["100"], L(["A-R", 60])).status).toBe("diverge");
  });
  it("sem referência ou referência inexistente", () => {
    expect(matchReturn(entry, [], "900", [], L(["A", 1])).status).toBe("no_ref");
    const r = matchReturn(entry, [], "900", ["555"], L(["A", 1]));
    expect(r.status).toBe("ref_not_found");
    expect(r.missingRefs).toEqual(["555"]);
  });
  it("aceita várias referências", () => {
    expect(parseRefs("nf-1 + nf-2, nf-3")).toEqual(["NF-1", "NF-2", "NF-3"]);
    const two = [...entry, mv("OUT_HD", "101", "A", 10)];
    expect(matchReturn(two, [], "900", ["100", "101"], L(["A", 70], ["B", 40])).status).toBe("match");
  });
});
