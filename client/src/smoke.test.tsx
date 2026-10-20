// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import Home from "./Home";
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const d = (n: number) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
const mv = (id: string, kind: string, nf: string, pn: string, quantity: number, date: string) => ({ id, kind, nf, pn, quantity, movementDate: date, notes: null, createdAt: "" });
const data = [mv("1", "OUT_HD", "NF1", "A", 100, d(12)), mv("2", "OUT_HD", "NF2", "A", 50, d(1)), mv("3", "IN_FORNECEDOR", "NF1", "A", 90, d(10)), mv("4", "OUT_FORNECEDOR", "NF9", "B", 10, d(2)), mv("5", "IN_HD", "NF7", "Z", 5, d(1))];

describe("smoke", () => {
  it("renderiza dashboard e estoque externo com dados", async () => {
    globalThis.fetch = vi.fn(async (u: any) => {
      const url = String(u);
      const body = url.includes("movements") ? data : url.includes("rules/status") ? { unlocked: false } : [];
      return new Response(JSON.stringify(body), { status: 200 });
    }) as any;
    const el = document.createElement("div"); document.body.appendChild(el);
    await act(async () => { createRoot(el).render(<Home />); });
    await act(async () => { await new Promise(r => setTimeout(r, 20)); });
    expect(el.textContent).toContain("CENTRAL DE ALERTAS");
    expect(el.textContent).toContain("divergência");
    expect(el.textContent).toContain("PENDÊNCIAS POR PROCESSO");
    expect(el.textContent).toContain("sem conferência de carregamento");
    const nav = Array.from(el.querySelectorAll("button.nav-item")).find(b => b.textContent?.includes("Estoque externo")) as HTMLElement;
    await act(async () => { nav.click(); });
    expect(el.textContent).toContain("Tudo que tem fora da HD");
    expect(el.textContent).toContain("DOCUMENTOS EM TRÂNSITO");
    expect(el.textContent).toContain("NF2");
    const go = async (label: string) => { const b = Array.from(el.querySelectorAll("button.nav-item")).find(x => x.textContent?.includes(label)) as HTMLElement; await act(async () => { b.click(); }); };
    await go("Conferência");
    expect(el.textContent).toContain("NFs aguardando conferência");
    const row = Array.from(el.querySelectorAll("tr.clickable")).find(r => r.textContent?.includes("NF2")) as HTMLElement;
    await act(async () => { row.click(); });
    expect(el.querySelector("tr.check-expand")).toBeTruthy();
    expect(el.textContent).toContain("PNs da NF NF2");
    expect(el.textContent).toContain("Enviar conferência");
    await act(async () => { row.click(); });
    expect(el.querySelector("tr.check-expand")).toBeNull();
    await go("Histórico");
    expect(el.textContent).toContain("Conferências e inventários enviados");
    await go("Inventário");
    expect(el.textContent).toContain("Gerar inventário da semana");
  });
});
