// Textos e formatações usados tanto pelo minerador (Node) quanto pelo relatório (React).

export const NIVEIS = { 4: "Muito alto", 3: "Alto", 2: "Médio", 1: "Baixo", 0: "Sem dados", "-1": "Não medido" };
export const TENDENCIAS = { subindo: "↑ Subindo", caindo: "↓ Caindo", estavel: "→ Estável", parado: "Parado" };

const p2 = (n) => String(n).padStart(2, "0");

// Data ISO do urlscan/banco -> Date (aceita "Z", "+00:00" e "2026-10-03 13:00:00").
// Sem fuso na data: semSufixo = "Z" lê como UTC, "" lê como hora local.
function lerIso(iso, semSufixo) {
  if (!/^\d{4}-\d\d-\d\d([T ]\d\d:\d\d(:\d\d(\.\d+)?)?)?(Z|[+-]\d\d:?\d\d)?$/.test(iso)) return null;
  let s = iso.replace(" ", "T");
  if (s.length === 10) s += "T00:00:00";
  if (!/(Z|[+-]\d\d:?\d\d)$/.test(s)) s += semSufixo;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

// Hora no fuso que veio na própria data (as do urlscan e do banco são UTC).
export function data_br(iso) {
  if (!iso) return "";
  const d = lerIso(iso, "Z");
  if (!d) return iso;
  return `${p2(d.getUTCDate())}/${p2(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`;
}

// '2026-10-03T13:00:00+00:00' -> '2026-10-03' no fuso do PC.
export function dia_local(iso) {
  if (!iso) return "";
  const d = lerIso(iso, "");
  if (!d) return iso.slice(0, 10);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}

export function dia_br(dia) {
  return dia.length === 10 ? `${dia.slice(8, 10)}/${dia.slice(5, 7)}` : dia;
}

export function rank_br(rank) {
  return rank >= 1_000_000 ? "top 1 milhão" : `top ${Math.floor(rank / 1000)} mil`;
}

// ['Alto', 'top 500 mil · 85% celular']
export function texto_trafego(o) {
  const n = o.trafego_nivel, det = [];
  if (o.rank_crux) det.push(rank_br(o.rank_crux));
  else if (n === 1 || n === -1) det.push("fora do top 1 milhão");
  else if (n === 0) det.push("poucas visitas para medir");
  if (o.celular_pct !== null && o.celular_pct !== undefined) det.push(`${o.celular_pct}% celular`);
  return [NIVEIS[n], det.join(" · ")];
}

// urllib.parse.quote do Python (safe='/' por padrão).
export function quote(s, safe = "/") {
  let r = encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
  if (safe.includes("/")) r = r.replace(/%2F/g, "/");
  return r;
}

// Biblioteca de Anúncios da Meta buscando o domínio.
export function link_anuncios(dominio) {
  return ("https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL"
    + "&media_type=all&search_type=keyword_unordered&q=" + quote(dominio.replace(/^www\./, "")));
}

// Central de Transparência de Anúncios do Google buscando o domínio.
export function link_anuncios_google(dominio) {
  return "https://adstransparency.google.com/?region=anywhere&domain=" + quote(dominio.replace(/^www\./, ""));
}
