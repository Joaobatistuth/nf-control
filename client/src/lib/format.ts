import { ApiError } from "./api";

// Data local (não UTC): à noite no Brasil o UTC já é "amanhã".
export const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
export const formatDate = (v: string) => (v ? v.slice(0, 10).split("-").reverse().join("/") : "—");
export const formatDateTime = (iso: string | null) => (iso ? new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—");
export const formatNumber = (v: number) => new Intl.NumberFormat("pt-BR").format(v);
export const errMsg = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);

export const readLocal = (key: string, fallback = "") => { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } };
export const writeLocal = (key: string, value: string) => { try { localStorage.setItem(key, value); } catch { /* ignora */ } };
