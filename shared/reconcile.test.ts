import { describe, expect, it } from "vitest";
import { reconcile, transit } from "./reconcile";
import type { Kind, Movement, Rule } from "./types";

let n = 0;
const mv = (kind: Kind, nf: string, pn: string, quantity: number, movementDate = "2026-10-01"): Movement => ({
  id: String(++n).padStart(4, "0"), kind, nf, movementDate, pn, quantity, notes: null, createdAt: "",
});
const rule = (id: string, fromPns: string, toPns: string): Rule => ({ id, fromPns, toPns, description: null, active: 1, createdAt: "", updatedAt: "" });

describe("reconcile", () => {
  it("casa o mesmo PN sem regra, ignorando maiúsculas/espaços", () => {
    const r = reconcile([mv("OUT_HD", "nf-1", "abc-1", 10), mv("IN_HD", "NF-9", " ABC-1 ", 10)], []);
    expect(r.groups[0]).toMatchObject({ out: 10, returned: 10, pending: 0, status: "complete" });
    expect(r.orphans).toHaveLength(0);
  });
  it("um PN vira outro (1→1) com retorno parcial", () => {
    const r = reconcile([mv("OUT_HD", "1", "A", 100), mv("IN_HD", "2", "A-R", 40)], [rule("r1", "A", "A-R")]);
    expect(r.groups[0]).toMatchObject({ returned: 40, pending: 60, status: "partial" });
  });
  it("vários viram um (N→1)", () => {
    const r = reconcile([mv("OUT_HD", "1", "A", 60), mv("OUT_HD", "2", "B", 60), mv("IN_HD", "3", "AB", 120)], [rule("r1", "A + B", "AB")]);
    expect(r.groups).toHaveLength(1);
    expect(r.groups[0]).toMatchObject({ out: 120, returned: 120, status: "complete" });
  });
  it("um vira vários (1→N)", () => {
    const r = reconcile([mv("OUT_HD", "1", "A", 100), mv("IN_HD", "2", "X", 60), mv("IN_HD", "3", "Y", 40)], [rule("r1", "A", "X + Y")]);
    expect(r.groups[0]).toMatchObject({ returned: 100, pending: 0 });
    expect(r.groups[0].returnNfs.sort()).toEqual(["2", "3"]);
  });
  it("não conta a mesma unidade retornada duas vezes para grupos que apontam ao mesmo PN", () => {
    const r = reconcile([mv("OUT_HD", "1", "A", 50), mv("OUT_HD", "2", "B", 50), mv("IN_HD", "3", "Z", 60)], [rule("r1", "A", "Z"), rule("r2", "B", "Z")]);
    expect(r.groups.reduce((s, g) => s + g.returned, 0)).toBe(60);
  });
  it("retorno sem saída e excedente viram órfãos", () => {
    const r = reconcile([mv("OUT_HD", "1", "A", 10), mv("IN_HD", "2", "A", 15), mv("IN_HD", "3", "Q", 5)], []);
    expect(r.orphans.find(o => o.pn === "A")).toMatchObject({ quantity: 5, excess: true });
    expect(r.orphans.find(o => o.pn === "Q")).toMatchObject({ quantity: 5, excess: false });
  });
  it("regra inativa é ignorada", () => {
    const r = reconcile([mv("OUT_HD", "1", "A", 10), mv("IN_HD", "2", "A-R", 10)], [{ ...rule("r1", "A", "A-R"), active: 0 }]);
    expect(r.groups[0].status).toBe("pending");
    expect(r.orphans[0].pn).toBe("A-R");
  });
});

describe("transit", () => {
  it("lista NFs sem confirmação de chegada", () => {
    const t = transit([mv("OUT_HD", "1", "A", 1), mv("OUT_HD", "2", "A", 1), mv("IN_FORNECEDOR", " 1", "A", 1), mv("OUT_FORNECEDOR", "5", "A", 1)]);
    expect(t).toEqual({ toSupplier: ["2"], toHd: ["5"] });
  });
});
