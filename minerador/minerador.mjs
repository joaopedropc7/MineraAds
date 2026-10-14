#!/usr/bin/env node
/*
Minerador de ofertas local usando a API grátis do urlscan.io.

Ideia: o urlscan registra TODOS os domínios que uma página carrega. Então dá para
achar landing pages / VSLs procurando quem carrega o player da VTurb, o pixel do
ClickBank, o script da UTMify, o checkout da BuyGoods etc. Cada rodada salva tudo num SQLite local
(minerador.db), e com o tempo você vê quais domínios aparecem mais vezes
(sinal de que estão rodando tráfego).

Uso rápido:
    npm run minerar                                   # todas as fontes, últimos 7 dias
    npm run minerar -- --dias 3 --fontes vturb,buygoods
    npm run minerar -- --pais US,CA --idioma en       # filtra por localização
    npm run minerar -- --dominio claritywake.com,leanbodytonic.com  # monitora domínios
    npm run minerar -- --q 'page.title:"blood sugar"' # busca livre
    npm run minerar -- --detalhar 30                  # puxa links/checkout (precisa de API key)
    npm run minerar -- --so-relatorio                 # só regera os relatórios do banco

Saídas (na pasta saida/):
    relatorio.html   -> o relatório em React (cards com print, país, idioma, fontes, contagem de scans)
    dados.json       -> os dados que o relatório mostra (usado pelo `npm run dev`)
    ofertas.csv      -> separado por ';' para abrir no Sheets/Excel pt-BR
    para_claude.txt  -> resumo compacto para colar no Claude e pedir análise
*/

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

import * as analise from "./analise.mjs";
import { Banco, agora_iso, agora_sql, corta, dormir, pyRound, strftimeUtc } from "./util.mjs";
import {
  NIVEIS, TENDENCIAS, data_br, dia_br, dia_local, link_anuncios, link_anuncios_google, quote, texto_trafego,
} from "../src/shared/formato.js";

const BASE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DB_PATH = path.join(BASE, "minerador.db");
const OUT_DIR = path.join(BASE, "saida");
const MODELO_HTML = path.join(BASE, "dist", "index.html");
const API = "https://urlscan.io/api/v1";

// --------------------------------------------------------------------------
// Fontes = "assinaturas" de oferta. A busca domain:X acha páginas que carregaram
// algum recurso de X. Edite/adicione à vontade.
// --------------------------------------------------------------------------
const FONTES = {
  vturb: "domain:converteai.net OR domain:vturb.com OR domain:vturb.com.br",
  utmify: "domain:utmify.com.br",
  panda: "domain:pandavideo.com.br",
  clickbank: "domain:clickbank.net",
  digistore: "domain:digistore24.com OR domain:checkout-ds24.com OR domain:digistore24-app.com",
  buygoods: "domain:buygoods.com",
  maxweb: "domain:maxweb.com",
  checkoutchamp: "domain:checkoutchamp.com",
  cartpanda: "domain:mycartpanda.com",
  hotmart: "domain:pay.hotmart.com",
  kiwify: "domain:pay.kiwify.com.br",
};

// Domínios das próprias plataformas, que só poluem o resultado.
const RUIDO = [
  "converteai.net", "vturb.com", "vturb.com.br", "pandavideo.com.br",
  "clickbank.net", "clickbank.com", "digistore24.com", "checkout-ds24.com",
  "buygoods.com", "maxweb.com", "checkoutchamp.com", "mycartpanda.com",
  "cartpanda.com", "hotmart.com", "kiwify.com.br", "ds25.io", "utmify.com.br", "google.com",
];

// Padrões úteis para achar checkout / afiliado nos links da página (--detalhar).
const CHECKOUT_RE = analise.CHECKOUT_RE;

const ordenar = (lista) => lista.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
const semWww = (d) => d.replace(/^www\./, "");

// Counter.most_common do Python: maior contagem primeiro, empate na ordem em que apareceu.
function contar(itens) {
  const c = new Map();
  for (const x of itens) c.set(x, (c.get(x) || 0) + 1);
  return c;
}
const maisComuns = (c) => [...c.entries()].sort((a, b) => b[1] - a[1]);

// --------------------------------------------------------------------------
// HTTP
// --------------------------------------------------------------------------
function ler_env(nome) {
  const valor = (process.env[nome] || "").trim();
  if (valor) return valor;
  const env = path.join(BASE, ".env");
  if (fs.existsSync(env)) {
    for (const linha of fs.readFileSync(env, "utf-8").split(/\r?\n/)) {
      if (linha.trim().startsWith(nome + "=")) {
        return linha.split("=").slice(1).join("=").trim().replace(/^"+|"+$/g, "").replace(/^'+|'+$/g, "");
      }
    }
  }
  return "";
}

class ErroHttp extends Error {}

class Urlscan {
  constructor(apiKey) {
    this.api_key = apiKey;
  }

  async get(url, tentativas = 5) {
    const headers = { "Accept": "application/json", "User-Agent": "minerador-local/1.0" };
    if (this.api_key) headers["API-Key"] = this.api_key;
    for (let t = 0; t < tentativas; t++) {
      let r;
      try {
        r = await fetch(url, { headers, signal: AbortSignal.timeout(60000) });
      } catch {
        await dormir(5);
        continue;
      }
      if (r.status === 429) {
        const espera = parseFloat(r.headers.get("X-Rate-Limit-Reset-After") || "30") + 1;
        console.log(`   limite atingido (429), aguardando ${espera.toFixed(0)}s...`);
        await dormir(espera);
        continue;
      }
      if ([500, 502, 503, 504].includes(r.status)) {
        await dormir(5);
        continue;
      }
      if (!r.ok) {
        const corpo = corta(await r.text().catch(() => ""), 300);
        throw new ErroHttp(`HTTP ${r.status} em ${url}\n${corpo}`);
      }
      let dados;
      try {
        dados = await r.json();
      } catch {
        await dormir(5);
        continue;
      }
      // Se a cota da janela acabou, espera antes da próxima chamada.
      const restante = r.headers.get("X-Rate-Limit-Remaining");
      const reset = r.headers.get("X-Rate-Limit-Reset-After");
      if (restante !== null && parseInt(restante, 10) <= 0 && reset) {
        const espera = parseFloat(reset) + 1;
        console.log(`   cota da janela zerada, aguardando ${espera.toFixed(0)}s...`);
        await dormir(espera);
      }
      return dados;
    }
    throw new ErroHttp(`falhou após ${tentativas} tentativas: ${url}`);
  }

  async *buscar(query, maxPaginas = 5, tamanho = 100) {
    let searchAfter = null;
    for (let p = 0; p < maxPaginas; p++) {
      const params = new URLSearchParams({ q: query, size: String(tamanho) });
      if (searchAfter) params.set("search_after", searchAfter);
      const dados = await this.get(`${API}/search/?${params}`);
      const resultados = dados.results || [];
      if (!resultados.length) return;
      yield* resultados;
      if (!dados.has_more && resultados.length < tamanho) return;
      searchAfter = (resultados[resultados.length - 1].sort || []).map(String).join(",");
      if (!searchAfter) return;
    }
  }

  resultado(uuid) {
    return this.get(`${API}/result/${uuid}/`);
  }
}

// --------------------------------------------------------------------------
// Banco
// --------------------------------------------------------------------------
function abrir_db() {
  const con = new Banco(DB_PATH);
  con.exec(`
    CREATE TABLE IF NOT EXISTS scans (
        uuid TEXT PRIMARY KEY,
        time TEXT,
        dominio TEXT,
        apex TEXT,
        url TEXT,
        titulo TEXT,
        pais TEXT,
        ip TEXT,
        asn TEXT,
        servidor TEXT,
        idade_dominio INTEGER,
        status TEXT,
        origem_scan TEXT,
        minerado_em TEXT,
        idioma TEXT
    );
    CREATE TABLE IF NOT EXISTS scan_fontes (
        uuid TEXT,
        fonte TEXT,
        PRIMARY KEY (uuid, fonte)
    );
    CREATE TABLE IF NOT EXISTS detalhes (
        uuid TEXT PRIMARY KEY,
        dominio TEXT,
        dominios_carregados TEXT,
        links_checkout TEXT,
        buscado_em TEXT
    );
    CREATE TABLE IF NOT EXISTS trafego (
        dominio TEXT PRIMARY KEY,
        rank_top INTEGER,   -- faixa no top 1 milhão do Chrome (1000 ... 1000000)
        top_em TEXT,
        crux INTEGER,       -- API do CrUX: 1 = tem visitantes medidos, 0 = não tem
        celular REAL,       -- fração das visitas vindas de celular
        api_em TEXT
    );
    CREATE INDEX IF NOT EXISTS ix_scans_dom ON scans(dominio);
  `);
  // Bancos criados antes da coluna de idioma.
  if (!con.all("PRAGMA table_info(scans)").some((r) => r.name === "idioma")) {
    con.exec("ALTER TABLE scans ADD COLUMN idioma TEXT");
  }
  analise.criar_tabelas(con);
  return con;
}

function salvar_scan(con, r, fonte) {
  const page = r.page || {}, task = r.task || {};
  const uuid = r._id || task.uuid;
  if (!uuid || !page.domain) return false;
  const novo = !con.get("SELECT 1 FROM scans WHERE uuid=?", uuid);
  con.run(
    `INSERT INTO scans VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(uuid) DO UPDATE SET idioma=excluded.idioma, pais=excluded.pais`,
    uuid, task.time, (page.domain || "").toLowerCase(),
    (page.apexDomain || "").toLowerCase(), page.url, page.title,
    page.country, page.ip, page.asnname, page.server,
    page.domainAgeDays, page.status === undefined || page.status === null ? null : String(page.status),
    task.source || task.method, agora_iso(), page.language,
  );
  con.run("INSERT OR IGNORE INTO scan_fontes VALUES (?,?)", uuid, fonte);
  return novo;
}

// --------------------------------------------------------------------------
// Mineração
// --------------------------------------------------------------------------
function lista(txt) {
  return (txt || "").split(",").map((x) => x.trim()).filter(Boolean);
}

function montar_query(base, dias, paises = [], idiomas = [], comRuido = true) {
  let q = `(${base})`;
  if (comRuido) q += " AND NOT (" + RUIDO.map((d) => `page.domain:${d}`).join(" OR ") + ")";
  if (paises.length) q += " AND page.country:(" + paises.map((x) => x.toUpperCase()).join(" OR ") + ")";
  if (idiomas.length) q += " AND page.language:(" + idiomas.map((x) => x.toLowerCase()).join(" OR ") + ")";
  if (dias) q += ` AND date:>now-${dias}d`;
  return q;
}

async function minerar(cli, con, fontes, dias, maxPaginas, queryLivre = null, dominios = [], paises = [], idiomas = []) {
  let alvos;
  if (dominios.length) {
    // page.domain:X também pega os subdomínios de X.
    alvos = dominios.map((d) => [`dominio:${d}`, `page.domain:${d}`]);
  } else if (queryLivre) {
    alvos = [["livre", queryLivre]];
  } else {
    alvos = [...new Set(fontes)].map((f) => [f, FONTES[f]]);
  }
  let totalNovos = 0;
  for (const [nome, base] of alvos) {
    const q = montar_query(base, dias, paises, idiomas, !dominios.length);
    console.log(`-> [${nome}] ${q.slice(0, 110)}${q.length > 110 ? "..." : ""}`);
    let vistos = 0, novos = 0;
    try {
      for await (const r of cli.buscar(q, maxPaginas)) {
        vistos += 1;
        novos += salvar_scan(con, r, nome) ? 1 : 0;
      }
    } catch (e) {
      if (!(e instanceof ErroHttp)) throw e;
      console.log(`   ERRO: ${e.message}`);
    }
    con.commit();
    totalNovos += novos;
    console.log(`   ${vistos} scans, ${novos} novos`);
    await dormir(2.2);  // 30 buscas/min sem chave
  }
  if (!(dominios.length || queryLivre)) {
    totalNovos += await marcar_google_ads(cli, con, fontes, dias, maxPaginas, paises, idiomas);
  }
  return totalNovos;
}

// Endereços que a tag do Google Ads chama quando a landing abre. Indica que o dono
// anuncia (ou anunciou) no Google; a confirmação é na Central de Transparência.
const GOOGLE_ADS = "domain:googleads.g.doubleclick.net OR domain:googleadservices.com";

// Uma busca só: qualquer assinatura das fontes E a tag do Google Ads.
async function marcar_google_ads(cli, con, fontes, dias, maxPaginas, paises = [], idiomas = []) {
  const base = "(" + fontes.map((f) => `(${FONTES[f]})`).join(" OR ") + `) AND (${GOOGLE_ADS})`;
  const q = montar_query(base, dias, paises, idiomas);
  console.log("-> [googleads] assinaturas + tag do Google Ads");
  let vistos = 0, novos = 0;
  try {
    for await (const r of cli.buscar(q, maxPaginas)) {
      vistos += 1;
      novos += salvar_scan(con, r, "googleads") ? 1 : 0;
    }
  } catch (e) {
    if (!(e instanceof ErroHttp)) throw e;
    console.log(`   ERRO: ${e.message}`);
  }
  con.commit();
  console.log(`   ${vistos} scans com tag do Google Ads, ${novos} novos`);
  return novos;
}

async function detalhar(cli, con, limite) {
  if (!cli.api_key) {
    console.log("--detalhar precisa de API key (o endpoint /result/ do urlscan exige login). Pulando.");
    return;
  }
  // Último scan de cada domínio que ainda não foi detalhado, priorizando os mais vistos.
  const linhas = con.all(
    `SELECT s.dominio, MAX(s.time) t, COUNT(*) n,
            (SELECT uuid FROM scans s2 WHERE s2.dominio=s.dominio ORDER BY time DESC LIMIT 1) uuid
     FROM scans s
     WHERE s.dominio NOT IN (SELECT dominio FROM detalhes)
     GROUP BY s.dominio ORDER BY n DESC, t DESC LIMIT ?`,
    limite,
  );
  console.log(`-> detalhando ${linhas.length} domínios...`);
  for (let i = 1; i <= linhas.length; i++) {
    const l = linhas[i - 1];
    let d;
    try {
      d = await cli.resultado(l.uuid);
    } catch (e) {
      if (!(e instanceof ErroHttp)) throw e;
      console.log(`   ${l.dominio}: ${e.message}`);
      continue;
    }
    const listas = d.lists || {}, data = d.data || {};
    const carregados = ordenar([...new Set(listas.domains || [])]);
    let links = (data.links || []).filter((x) => x && typeof x === "object" && !Array.isArray(x)).map((x) => x.href || "");
    links = links.concat(listas.linkDomains || []);
    const checkout = ordenar([...new Set(links.filter((x) => x && CHECKOUT_RE.test(x)))]).slice(0, 25);
    // Tudo o que a página carregou (inclusive scripts que o HTML puro não mostra).
    const pedidos = (data.requests || []).map((r) => r?.request?.request?.url || "");
    const texto = pedidos.concat(links, listas.urls || []).join("\n");
    analise.mesclar_dna(con, l.dominio, analise.extrair_dna(texto));
    con.run(
      "INSERT OR REPLACE INTO detalhes VALUES (?,?,?,?,?)",
      l.uuid, l.dominio, JSON.stringify(carregados), JSON.stringify(checkout), agora_iso(),
    );
    con.commit();
    if (i % 25 === 0 || i === linhas.length) {
      console.log(`   [${i}/${linhas.length}] ${l.dominio}: ${carregados.length} domínios, ${checkout.length} links de checkout`);
    }
    await dormir(3.1);  // ~20 retrieves/min
  }
}

// Oferta confirmada pelo vigia de certificados: entra como um "scan" próprio (ct:host)
// até o urlscan escanear o domínio de verdade.
function salvar_oferta_ct(con, host, apex, url, titulo, assinaturas) {
  const agora = new Date();
  const uuid = `ct:${host}`;
  con.run(
    `INSERT OR IGNORE INTO scans (uuid, time, dominio, apex, url, titulo, origem_scan, minerado_em)
       VALUES (?,?,?,?,?,?,?,?)`,
    uuid, strftimeUtc(agora) + ".000Z", host, apex, url, titulo, "ct", agora_iso(),
  );
  for (const f of [...assinaturas, "ct"]) con.run("INSERT OR IGNORE INTO scan_fontes VALUES (?,?)", uuid, f);
}

// --------------------------------------------------------------------------
// Tráfego (Chrome UX Report, do Google)
// O Google mede quais sites têm visitantes reais no Chrome (últimos 28 dias).
//  - Lista do top 1 milhão: grátis, sem chave, dá a faixa de popularidade.
//  - API do CrUX (chave grátis, CRUX_API_KEY no .env): diz se sites menores
//    também têm visitantes medidos e quanto do tráfego vem de celular.
// Não existe número exato de acessos de fora; isso é uma faixa.
// --------------------------------------------------------------------------
const CRUX_TOP_URL = "https://raw.githubusercontent.com/zakird/crux-top-lists/main/data/global/current.csv.gz";
const CRUX_TOP_ARQ = path.join(BASE, "cache", "crux_top1m.csv.gz");
const CRUX_API = "https://chromeuxreport.googleapis.com/v1/records:queryRecord";

// Baixa a lista de novo quando a cópia local tem mais de 7 dias.
async function baixar_top_crux() {
  const arq = CRUX_TOP_ARQ;
  if (fs.existsSync(arq) && Date.now() - fs.statSync(arq).mtimeMs < 7 * 86400_000) return arq;
  fs.mkdirSync(path.dirname(arq), { recursive: true });
  try {
    console.log("-> baixando a lista top 1 milhão do Chrome (~9 MB)...");
    const r = await fetch(CRUX_TOP_URL, {
      headers: { "User-Agent": "minerador-local/1.0" }, signal: AbortSignal.timeout(180000),
    });
    if (!r.ok) throw new Error(`HTTP Error ${r.status}`);
    const tmp = arq + ".tmp";
    fs.writeFileSync(tmp, Buffer.from(await r.arrayBuffer()));
    fs.renameSync(tmp, arq);
  } catch (e) {
    console.log(`   não deu para baixar (${e.message}); usando a cópia antiga, se houver`);
  }
  return fs.existsSync(arq) ? arq : null;
}

class ErroChave extends Error {}

// [tem_dados, fração_celular], ou null se deu erro temporário.
async function consultar_crux(chave, dominio) {
  const corpo = JSON.stringify({ origin: `https://${dominio}` });
  for (let t = 0; t < 3; t++) {
    let r;
    try {
      r = await fetch(CRUX_API, {
        method: "POST", body: corpo, signal: AbortSignal.timeout(30000),
        headers: { "Content-Type": "application/json", "X-goog-api-key": chave },
      });
    } catch {
      await dormir(5);
      continue;
    }
    if (r.ok) {
      const rec = (await r.json()).record || {};
      const fracoes = rec.metrics?.form_factors?.fractions || {};
      return [true, fracoes.phone ?? null];
    }
    if (r.status === 404) return [false, null];  // o Google não tem visitantes suficientes para medir
    if (r.status === 429) {
      await dormir(30);
      continue;
    }
    const msg = await r.text().catch(() => "");
    if (r.status === 403 || msg.includes("API key") || msg.includes("API_KEY")) {
      throw new ErroChave(`chave do CrUX recusada (HTTP ${r.status}): ${corta(msg, 200)}`);
    }
    if (r.status === 400) return [false, null];  // origem inválida
    await dormir(5);
  }
  return null;
}

async function atualizar_trafego(con, chaveCrux, maxApi = 1500) {
  const doms = con.all("SELECT DISTINCT dominio FROM scans").map((r) => r.dominio);
  // x.com e www.x.com são o mesmo site para essa conta.
  const porHost = new Map();
  for (const d of doms) {
    const h = semWww(d);
    if (!porHost.has(h)) porHost.set(h, []);
    porHost.get(h).push(d);
  }

  const arq = await baixar_top_crux();
  if (arq) {
    const ranks = new Map();
    const texto = zlib.gunzipSync(fs.readFileSync(arq)).toString("utf-8");
    let inicio = texto.indexOf("\n") + 1;  // pula o cabeçalho
    while (inicio > 0 && inicio < texto.length) {
      let fim = texto.indexOf("\n", inicio);
      if (fim < 0) fim = texto.length;
      const linha = texto.slice(inicio, fim).trim();
      inicio = fim + 1;
      const v = linha.lastIndexOf(",");
      const origem = v < 0 ? "" : linha.slice(0, v), rank = parseInt(linha.slice(v + 1), 10);
      const p = origem.indexOf("://");
      const host = p < 0 ? "" : semWww(origem.slice(p + 3));
      for (const d of porHost.get(host) || []) ranks.set(d, Math.min(ranks.get(d) ?? rank, rank));
    }
    const agora = agora_sql();
    for (const d of doms) {
      con.run(
        `INSERT INTO trafego (dominio, rank_top, top_em) VALUES (?,?,?)
           ON CONFLICT(dominio) DO UPDATE SET rank_top=excluded.rank_top, top_em=excluded.top_em`,
        d, ranks.get(d) ?? null, agora,
      );
    }
    con.commit();
    console.log(`-> tráfego: ${ranks.size} domínios estão no top 1 milhão do Chrome`);
  }

  if (!chaveCrux) {
    console.log("   (sem CRUX_API_KEY no .env: sites fora do top 1 milhão ficam como 'não medido')");
    return;
  }
  // Nunca consultados, ou consultados há mais de 3 dias e ainda ativos (site novo ganha tráfego).
  const pendentes = con.all(
    `SELECT s.dominio FROM (SELECT dominio, MAX(time) t FROM scans GROUP BY dominio) s
       LEFT JOIN trafego tr ON tr.dominio = s.dominio
       WHERE tr.api_em IS NULL
          OR (tr.api_em < datetime('now', '-3 days') AND s.t >= datetime('now', '-14 days'))
       ORDER BY s.t DESC LIMIT ?`, maxApi).map((r) => r.dominio);
  if (!pendentes.length) return;
  console.log(`-> tráfego: consultando ${pendentes.length} domínios na API do CrUX...`);
  let com = 0;
  for (let i = 1; i <= pendentes.length; i++) {
    const dom = pendentes[i - 1];
    let res;
    try {
      res = await consultar_crux(chaveCrux, dom);
    } catch (e) {
      if (!(e instanceof ErroChave)) throw e;
      console.log(`   ERRO: ${e.message}`);
      break;
    }
    if (res !== null) {
      com += res[0] ? 1 : 0;
      con.run(
        `INSERT INTO trafego (dominio, crux, celular, api_em) VALUES (?,?,?,?)
           ON CONFLICT(dominio) DO UPDATE SET crux=excluded.crux, celular=excluded.celular, api_em=excluded.api_em`,
        dom, Number(res[0]), res[1], agora_sql(),
      );
    }
    if (i % 100 === 0) {
      con.commit();
      console.log(`   ${i}/${pendentes.length}`);
    }
    await dormir(0.45);  // limite da API: 150 consultas/min
  }
  con.commit();
  console.log(`   ${com} com visitantes reais medidos`);
}

// --------------------------------------------------------------------------
// Agregação e relatórios
// --------------------------------------------------------------------------
// 4 = top 100 mil, 3 = top 500 mil, 2 = top 1 milhão, 1 = medido fora do top,
// 0 = o Google não tem visitantes suficientes, -1 = não consultado na API.
function nivel_trafego(t) {
  if (t && t.rank_top) return t.rank_top <= 100_000 ? 4 : t.rank_top <= 500_000 ? 3 : 2;
  if (t && t.crux !== null && t.crux !== undefined) return t.crux ? 1 : 0;
  return -1;
}

// Caminho da URL como o urllib.parse.urlsplit do Python ("" -> "/").
function caminhoUrl(url) {
  let s = url || "";
  const esquema = /^[A-Za-z][A-Za-z0-9+.-]*:/.exec(s);
  if (esquema) s = s.slice(esquema[0].length);
  if (s.startsWith("//")) {
    const m = /[/?#]/.exec(s.slice(2));
    s = m ? s.slice(2 + m.index) : "";
  }
  const fim = /[?#]/.exec(s);
  return (fim ? s.slice(0, fim.index) : s) || "/";
}

function agregar(con, diasRelatorio = null) {
  let filtro = "", params = [];
  if (diasRelatorio) {
    filtro = "WHERE s.time >= datetime('now', ?)";
    params = [`-${diasRelatorio} days`];
  }
  const linhas = con.all(
    `SELECT s.*, GROUP_CONCAT(f.fonte) fontes FROM scans s
       LEFT JOIN scan_fontes f ON f.uuid=s.uuid ${filtro} GROUP BY s.uuid`,
    ...params,
  );
  const det = new Map(con.all("SELECT * FROM detalhes").map((r) => [r.dominio, r]));
  const paginas = new Map(con.all("SELECT * FROM paginas").map((r) => [r.dominio, r]));
  // Quando o minerador viu o domínio pela 1ª vez (vale o banco todo, não só o filtro).
  const descoberta = new Map(con.all("SELECT dominio, MIN(minerado_em) m FROM scans GROUP BY dominio").map((r) => [r.dominio, r.m]));
  const traf = new Map(con.all("SELECT * FROM trafego").map((r) => [r.dominio, r]));
  const [grupoOferta, grupoDono, , principal] = analise.calcular_grupos(con);

  // Tendência: scans desta semana contra a anterior (banco todo, mesmo com --relatorio-dias).
  const agora = Date.now();
  const corte1 = strftimeUtc(new Date(agora - 7 * 86400_000));
  const corte2 = strftimeUtc(new Date(agora - 14 * 86400_000));
  const tempos = new Map();
  for (const r of con.all("SELECT dominio, time FROM scans WHERE uuid NOT LIKE 'ct:%'")) {
    if (!tempos.has(r.dominio)) tempos.set(r.dominio, []);
    tempos.get(r.dominio).push(r.time || "");
  }

  const porDom = new Map();
  for (const r of linhas) {
    if (!porDom.has(r.dominio)) porDom.set(r.dominio, []);
    porDom.get(r.dominio).push(r);
  }

  const ofertas = [];
  for (const [dom, scans] of porDom) {
    // "ct:..." é a entrada criada pelo vigia de certificados, não um scan do urlscan.
    const reais = scans.filter((r) => !r.uuid.startsWith("ct:"));
    const base = [...(reais.length ? reais : scans)].sort((a, b) => {
      const ta = a.time || "", tb = b.time || "";
      return ta < tb ? 1 : ta > tb ? -1 : 0;
    });
    const ult = base[0];
    const marcas = new Set(scans.flatMap((r) => (r.fontes || "").split(",").filter(Boolean)));
    // "googleads" e "ct" são sinais, não fontes: não entram no score.
    const fontes = ordenar([...marcas].filter((f) => f !== "googleads" && f !== "ct"));
    const dias = new Set(reais.map((r) => (r.time || "").slice(0, 10)));
    const urls = new Set(reais.map((r) => r.url));
    const pg = paginas.get(dom);
    const dna = pg && pg.dna ? JSON.parse(pg.dna) : {};
    const titulos = maisComuns(contar(base.filter((r) => r.titulo).map((r) => r.titulo)));
    const titulo = titulos.length ? titulos[0][0] : (pg && pg.titulo ? pg.titulo : "");
    const paths = new Set(scans.map((r) => caminhoUrl(r.url)));
    if (pg && pg.url) paths.add(caminhoUrl(pg.url));
    const ts = tempos.get(dom) || [];
    const semAtual = ts.filter((t) => t >= corte1).length;
    const semAnt = ts.filter((t) => corte2 <= t && t < corte1).length;
    const membrosO = grupoOferta.get(dom) || [], membrosD = grupoDono.get(dom) || [];
    const tamO = new Set(membrosO.map(principal)).size;
    const tamD = new Set(membrosD.map(principal)).size;
    const d = det.get(dom);
    let checkout = d ? JSON.parse(d.links_checkout) : [];
    if (!checkout.length && pg && pg.checkout) checkout = JSON.parse(pg.checkout);
    // Score: frequência + dias distintos + variações de URL + fontes combinadas
    // + domínios rodando a mesma oferta (sinal forte de escala).
    const score = (reais.length + 2 * dias.size + Math.min(urls.size, 10) + 3 * Math.max(fontes.length - 1, 0)
      + 2 * Math.min(Math.max(tamO - 1, 0), 10));
    const url = ult.url || (pg ? pg.url : "") || `https://${dom}/`;
    let screenshot, linkUrlscan;
    if (reais.length) {
      screenshot = `https://urlscan.io/screenshots/${ult.uuid}.png`;
      linkUrlscan = `https://urlscan.io/result/${ult.uuid}/`;
    } else {  // ainda não escaneada pelo urlscan: print do serviço grátis do WordPress
      screenshot = "https://s0.wp.com/mshots/v1/" + quote(url, "") + "?w=800";
      linkUrlscan = "https://urlscan.io/search/#" + quote(`page.domain:${dom}`);
    }
    const tr = traf.get(dom);
    const tempo = base.filter((r) => r.time).map((r) => r.time);
    ofertas.push({
      dominio: dom,
      // Domínio principal (allfeams.com em vez de try.allfeams.com); as bibliotecas de anúncios
      // só acham pelo principal. Em vercel.app/pages.dev o urlscan já devolve o subdomínio.
      apex: ult.apex || dom,
      titulo,
      fontes,
      google_ads: marcas.has("googleads") || Boolean(dna.gads && dna.gads.length),
      via_ct: marcas.has("ct"),
      scans: reais.length,
      dias_vistos: dias.size,
      urls_distintas: urls.size,
      paths,
      sem_ant: semAnt,
      sem_atual: semAtual,
      tendencia: analise.tendencia(semAnt, semAtual),
      dna,
      membros_oferta: membrosO,
      membros_dono: membrosD,
      tam_oferta: tamO,
      tam_dono: tamD,
      paises: ordenar([...new Set(base.filter((r) => r.pais).map((r) => r.pais))]),
      idiomas: ordenar([...new Set(base.filter((r) => r.idioma).map((r) => r.idioma))]),
      primeiro: tempo.length ? tempo.reduce((a, b) => (b < a ? b : a)) : "",
      ultimo: ult.time,
      descoberto: descoberta.get(dom) || "",
      trafego_nivel: nivel_trafego(tr),
      rank_crux: tr ? tr.rank_top : null,
      celular_pct: tr && tr.celular !== null ? pyRound(tr.celular * 100) : null,
      idade_dominio: ult.idade_dominio,
      servidor: ult.servidor || "",
      url,
      uuid: ult.uuid,
      screenshot,
      urlscan: linkUrlscan,
      checkout,
      score,
    });
  }
  ofertas.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    const ua = a.ultimo || "", ub = b.ultimo || "";
    return ua < ub ? 1 : ua > ub ? -1 : 0;
  });
  return ofertas;
}

function ultima_rodada(ofertas) {
  let ult = "";
  for (const o of ofertas) {
    const d = dia_local(o.descoberto);
    if (d > ult) ult = d;
  }
  return ult;
}

function texto_dna(dna) {
  return ordenar(Object.keys(dna)).map((t) => `${analise.NOMES_DNA[t] || t}: ${dna[t].join(", ")}`).join("; ");
}

function gerar_csv(ofertas, caminho) {
  const cols = ["score", "dominio", "titulo", "tendencia", "scans_semana_anterior", "scans_semana",
    "tam_grupo_oferta", "grupo_oferta", "tam_grupo_dono", "grupo_dono", "dna",
    "trafego", "rank_crux", "celular", "paises", "idiomas", "fontes", "via_certificado",
    "scans", "dias_vistos", "urls_distintas", "idade_dominio", "primeiro", "ultimo", "descoberto", "url",
    "google_ads", "urlscan", "anuncios_meta", "anuncios_google", "screenshot", "checkout"];

  const cel = (v) => {
    const s = String(v).replace(/"/g, '""');
    return /[;"\n]/.test(s) ? `"${s}"` : s;
  };

  const saida = [cols.join(";")];
  for (const o of ofertas) {
    const extra = {
      tendencia: TENDENCIAS[o.tendencia],
      scans_semana_anterior: o.sem_ant,
      scans_semana: o.sem_atual,
      tam_grupo_oferta: o.tam_oferta || "",
      grupo_oferta: o.membros_oferta,
      tam_grupo_dono: o.tam_dono || "",
      grupo_dono: o.membros_dono,
      dna: texto_dna(o.dna),
      via_certificado: o.via_ct ? "sim" : "",
      trafego: NIVEIS[o.trafego_nivel],
      celular: o.celular_pct === null ? "" : `${o.celular_pct}%`,
      anuncios_meta: link_anuncios(o.apex),
      anuncios_google: link_anuncios_google(o.apex),
      google_ads: o.google_ads ? "tag" : "",
    };
    const linha = cols.map((c) => {
      let v = c in extra ? extra[c] : o[c];
      if (Array.isArray(v)) v = v.join(", ");
      else if (["primeiro", "ultimo", "descoberto"].includes(c)) v = data_br(v);
      else if (v === null || v === undefined) v = "";
      return cel(v);
    });
    saida.push(linha.join(";"));
  }
  fs.writeFileSync(caminho, "﻿" + saida.join("\n") + "\n", "utf-8");
}

function agoraBr(comAs = false) {
  const d = new Date(), p2 = (n) => String(n).padStart(2, "0");
  return `${p2(d.getDate())}/${p2(d.getMonth() + 1)}/${d.getFullYear()}${comAs ? " às" : ""} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

function gerar_md_claude(ofertas, caminho, topNovas = 50, topGeral = 40, topGrupos = 15) {
  const ult = ultima_rodada(ofertas);
  const novas = ofertas.filter((o) => dia_local(o.descoberto) === ult);
  const velhas = ofertas.filter((o) => dia_local(o.descoberto) !== ult);
  const linhas = [
    "# Ofertas mineradas (urlscan)",
    "",
    `Gerado em ${agoraBr()}. ${ofertas.length} domínios no total, `
    + `${novas.length} novos na última rodada (${dia_br(ult)}).`,
    "Score = scans + 2×dias vistos + URLs distintas + 3×(fontes extras) + 2×(outros domínios com a mesma oferta). "
    + "Fontes = assinatura que a página carrega (player VTurb, ClickBank, BuyGoods etc).",
    "",
    "País = onde o servidor está hospedado (vazio quando atrás da Cloudflare); idioma = idioma da página.",
    "Tráfego = faixa de popularidade entre usuários reais do Chrome nos últimos 28 dias (Google CrUX): "
    + "Muito alto = top 100 mil sites, Alto = top 500 mil, Médio = top 1 milhão, Baixo = fora do top mas medido, "
    + "Sem dados = visitas abaixo do mínimo do Google, Não medido = fora do top 1 milhão e não consultado.",
    "TAG GOOGLE ADS (na coluna fontes) = a landing carrega a tag do Google Ads: o dono anuncia ou anunciou no Google.",
    "Tendência = scans da semana anterior → desta semana. Grupo = quantos domínios rodam a mesma oferta "
    + "(mesmo player de vídeo ou mesmo produto no checkout).",
    "",
    "Pedido sugerido: aponte quais estão escalando (grupos grandes, tendência subindo), para qual mercado cada "
    + "uma parece rodar e o ângulo/promessa de cada uma pelo título.",
    "",
  ];

  const grupos = new Map();
  for (const o of ofertas) {
    const chave = o.membros_oferta.join("\u0000");
    if (o.tam_oferta > 1 && !grupos.has(chave)) grupos.set(chave, o);
  }
  if (grupos.size) {
    linhas.push("", `## Mesma oferta em vários domínios: top ${Math.min(topGrupos, grupos.size)} de ${grupos.size}`, "",
      "| domínios | título | membros |", "|---|---|---|");
    const ordenados = [...grupos.values()].sort((a, b) => b.tam_oferta - a.tam_oferta).slice(0, topGrupos);
    for (const o of ordenados) {
      const membros = o.membros_oferta;
      const tit = corta((o.titulo || "").replace(/\|/g, "/"), 80);
      linhas.push(`| ${o.tam_oferta} | ${tit} | ${membros.slice(0, 12).join(", ")}${membros.length > 12 ? " ..." : ""} |`);
    }
  }

  const tabela = (titulo, lista) => {
    linhas.push("", `## ${titulo}`, "",
      "| score | domínio | título | tendência | grupo | tráfego | país | idioma | fontes | scans | dias | achada em | checkout |",
      "|---|---|---|---|---|---|---|---|---|---|---|---|---|");
    for (const o of lista) {
      const tit = corta((o.titulo || "").replace(/\|/g, "/"), 90);
      const chk = o.checkout.slice(0, 3).join(", ").replace(/\|/g, "/");
      const [rotulo, det] = texto_trafego(o);
      const fontes = [...o.fontes, ...(o.google_ads ? ["TAG GOOGLE ADS"] : []), ...(o.via_ct ? ["via certificado"] : [])];
      linhas.push(
        `| ${o.score} | ${o.dominio} | ${tit} | ${TENDENCIAS[o.tendencia]} (${o.sem_ant}→${o.sem_atual}) | `
        + `${o.tam_oferta > 1 ? o.tam_oferta + " dom." : ""} | ${rotulo}${det ? ` (${det})` : ""} | `
        + `${o.paises.join(", ")} | ${o.idiomas.join(", ")} | ${fontes.join(", ")} | `
        + `${o.scans} | ${o.dias_vistos} | ${dia_br(dia_local(o.descoberto))} | ${chk} |`,
      );
    }
  };

  tabela(`Novas na última rodada (${dia_br(ult)}): top ${Math.min(topNovas, novas.length)} de ${novas.length}`, novas.slice(0, topNovas));
  tabela(`Já vistas antes: top ${Math.min(topGeral, velhas.length)} por score`, velhas.slice(0, topGeral));
  fs.writeFileSync(caminho, linhas.join("\n") + "\n", "utf-8");
}

// Só o que o relatório em React usa de cada oferta.
function oferta_para_relatorio(o) {
  return {
    dominio: o.dominio, apex: o.apex, titulo: o.titulo, fontes: o.fontes, google_ads: o.google_ads,
    via_ct: o.via_ct, scans: o.scans, dias_vistos: o.dias_vistos, urls_distintas: o.urls_distintas,
    sem_ant: o.sem_ant, sem_atual: o.sem_atual, tendencia: o.tendencia,
    membros_oferta: o.membros_oferta.slice(0, 15), membros_dono: o.membros_dono.slice(0, 15),
    tam_oferta: o.tam_oferta, tam_dono: o.tam_dono, paises: o.paises, idiomas: o.idiomas,
    ultimo: o.ultimo, desc: dia_local(o.descoberto), trafego_nivel: o.trafego_nivel, rank_crux: o.rank_crux,
    celular_pct: o.celular_pct, idade_dominio: o.idade_dominio, url: o.url, urlscan: o.urlscan,
    screenshot: o.screenshot, checkout: o.checkout, score: o.score,
  };
}

// Dados do relatório: vão para saida/dados.json e embutidos no saida/relatorio.html.
function gerar_html(ofertas, pasta, chaveCrux = false, eventos = [], fixos = []) {
  const doms = new Set(ofertas.map((o) => o.dominio));
  const ev = eventos.filter((x) => doms.has(x.dominio)).map((x) => ({
    d: x.dominio, q: dia_br(dia_local(x.quando.replace(" ", "T") + "+00:00")), x: x.texto,
  }));
  const dados = {
    atualizado: agoraBr(true),
    chave_crux: chaveCrux,
    ult: ultima_rodada(ofertas),
    ofertas: ofertas.map(oferta_para_relatorio),
    eventos: ev,
    fixos: ordenar([...fixos]),
  };
  const json = JSON.stringify(dados);
  fs.writeFileSync(path.join(pasta, "dados.json"), json, "utf-8");

  if (!fs.existsSync(MODELO_HTML)) {
    console.log("\nAVISO: falta o build do relatório (pasta dist/). Rode `npm run build` e depois "
      + "`npm run minerar -- --so-relatorio --sem-dna --sem-ct --sem-trafego`.");
    return;
  }
  const marcador = '<script id="dados" type="application/json">null</script>';
  const modelo = fs.readFileSync(MODELO_HTML, "utf-8");
  if (!modelo.includes(marcador)) {
    console.log("\nAVISO: o dist/index.html não tem o lugar dos dados; rode `npm run build` de novo.");
    return;
  }
  // "<" escapado: nenhum texto das páginas consegue fechar a tag <script>.
  const seguro = json.replace(/</g, "\\u003c").replace(/[\u2028\u2029]/g, (c) => "\\u" + c.charCodeAt(0).toString(16));
  const doc = modelo.replace(marcador, () => `<script id="dados" type="application/json">${seguro}</script>`);
  fs.writeFileSync(path.join(pasta, "relatorio.html"), doc, "utf-8");
}

// Domínios do acompanhar.txt (um por linha, # para comentário): ficam sempre marcados.
function ler_acompanhar() {
  const arq = path.join(BASE, "acompanhar.txt");
  if (!fs.existsSync(arq)) return [];
  const doms = new Set(fs.readFileSync(arq, "utf-8").split(/\r?\n/).map((l) => l.split("#")[0].trim().toLowerCase()));
  doms.delete("");
  return ordenar([...doms]);
}

function gerar_relatorios(con, dominios = [], paises = [], idiomas = [], diasRelatorio = null, chaveCrux = false) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  let ofertas = agregar(con, diasRelatorio);
  analise.registrar_mudancas(con, ofertas, NIVEIS);
  if (dominios.length) ofertas = ofertas.filter((o) => dominios.some((d) => o.dominio === d || o.dominio.endsWith("." + d)));
  if (paises.length) {
    const ps = new Set(paises.map((x) => x.toUpperCase()));
    ofertas = ofertas.filter((o) => o.paises.some((p) => ps.has(p)));
  }
  if (idiomas.length) {
    const is = new Set(idiomas.map((x) => x.toLowerCase()));
    ofertas = ofertas.filter((o) => o.idiomas.some((i) => is.has(i)));
  }
  gerar_html(ofertas, OUT_DIR, chaveCrux, analise.eventos_recentes(con), ler_acompanhar());
  gerar_csv(ofertas, path.join(OUT_DIR, "ofertas.csv"));
  gerar_md_claude(ofertas, path.join(OUT_DIR, "para_claude.txt"));
  const cont = contar(ofertas.flatMap((o) => (o.paises.length ? o.paises : ["?"])));
  console.log(`\n${ofertas.length} domínios no relatório  ` + maisComuns(cont).slice(0, 8).map(([k, v]) => `${k}:${v}`).join("  "));
  const niveis = contar(ofertas.map((o) => NIVEIS[o.trafego_nivel]));
  console.log("tráfego: " + [4, 3, 2, 1, 0, -1].map((n) => `${NIVEIS[n]}:${niveis.get(NIVEIS[n]) || 0}`).join("  "));
  const tend = contar(ofertas.map((o) => o.tendencia));
  console.log(`grupos: ${ofertas.filter((o) => o.tam_oferta > 1).length} domínios em ofertas repetidas, `
    + `${ofertas.filter((o) => o.tam_dono > 1).length} com dono repetido  |  tendência: `
    + maisComuns(tend).map(([k, v]) => `${TENDENCIAS[k]}:${v}`).join("  "));
  console.log(`  ${path.join(OUT_DIR, "relatorio.html")}\n  ${path.join(OUT_DIR, "ofertas.csv")}\n  ${path.join(OUT_DIR, "para_claude.txt")}`);
  console.log("\nTop 10:");
  for (const o of ofertas.slice(0, 10)) {
    const loc = [...o.paises, ...o.idiomas].join(",") || "?";
    console.log(`  ${String(o.score).padStart(4)}  ${loc.padEnd(8)} ${o.dominio.padEnd(40)} ${corta(o.titulo || "", 55)}`);
  }
}

// --------------------------------------------------------------------------
const OPCOES = [
  ["dias", "int", 7, "janela de busca em dias (padrão 7)"],
  ["fontes", "str", Object.keys(FONTES).join(","), `lista separada por vírgula: ${Object.keys(FONTES).join(",")}`],
  ["q", "str", null, "query livre do urlscan (ignora --fontes)"],
  ["max-paginas", "int", 5, "páginas de 100 por fonte (padrão 5)"],
  ["detalhar", "int", 200, "com chave do urlscan: puxa o scan completo de até N domínios por rodada (padrão 200)"],
  ["dominio", "str", null, "busca só esses domínios (e subdomínios), separados por vírgula"],
  ["pais", "str", null, "país do servidor, ex: US,CA,BR (vazio quando atrás da Cloudflare)"],
  ["idioma", "str", null, "idioma da página, ex: en,pt,es"],
  ["relatorio-dias", "int", null, "relatório só com scans dos últimos N dias (padrão: tudo do banco)"],
  ["so-relatorio", "bool", false, "não busca nada, só regera relatórios"],
  ["trafego", "bool", false, "com --so-relatorio: atualiza o tráfego mesmo assim"],
  ["sem-trafego", "bool", false, "pula a checagem de tráfego (CrUX)"],
  ["dna", "bool", false, "com --so-relatorio: analisa o HTML das landings mesmo assim"],
  ["sem-dna", "bool", false, "pula a análise do HTML das landings"],
  ["max-dna", "int", 500, "landings analisadas por rodada (padrão 500)"],
  ["ct", "bool", false, "com --so-relatorio: roda o vigia de certificados mesmo assim"],
  ["sem-ct", "bool", false, "pula o vigia de certificados"],
  ["max-ct", "int", 0, "domínios vigiados no CertSpotter por rodada (padrão: 10 sem chave, 100 com)"],
];

function uso() {
  return "uso: npm run minerar -- [opções]\n\nMinerador de ofertas via urlscan.io\n\nopções:\n"
    + "  -h, --help            mostra esta ajuda\n"
    + OPCOES.map(([n, t, , h]) => `  --${n}${t === "bool" ? "" : " " + n.toUpperCase().replace(/-/g, "_")}`.padEnd(24) + h).join("\n");
}

function erroArgs(msg) {
  console.error(uso().split("\n")[0]);
  console.error(`minerador: erro: ${msg}`);
  process.exit(2);
}

function lerArgs(argv) {
  const a = Object.fromEntries(OPCOES.map(([n, , padrao]) => [n.replace(/-/g, "_"), padrao]));
  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      console.log(uso());
      process.exit(0);
    }
    if (!arg.startsWith("--")) erroArgs(`argumento não reconhecido: ${arg}`);
    let valor = null;
    const eq = arg.indexOf("=");
    if (eq >= 0) {
      valor = arg.slice(eq + 1);
      arg = arg.slice(0, eq);
    }
    const nome = arg.slice(2);
    // Como o argparse: aceita o começo do nome quando não é ambíguo (--so-rel).
    const achadas = OPCOES.filter(([n]) => n === nome).length ? OPCOES.filter(([n]) => n === nome)
      : OPCOES.filter(([n]) => n.startsWith(nome));
    if (achadas.length !== 1) erroArgs(achadas.length ? `opção ambígua: ${arg}` : `argumento não reconhecido: ${arg}`);
    const [n, tipo] = achadas[0];
    const chave = n.replace(/-/g, "_");
    if (tipo === "bool") {
      if (valor !== null) erroArgs(`argumento --${n}: não aceita valor`);
      a[chave] = true;
      continue;
    }
    if (valor === null) {
      if (i + 1 >= argv.length) erroArgs(`argumento --${n}: precisa de um valor`);
      valor = argv[++i];
    }
    if (tipo === "int") {
      if (!/^-?\d+$/.test(valor.trim())) erroArgs(`argumento --${n}: número inválido: '${valor}'`);
      a[chave] = parseInt(valor, 10);
    } else {
      a[chave] = valor;
    }
  }
  return a;
}

async function main() {
  const a = lerArgs(process.argv.slice(2));

  const fontes = lista(a.fontes), dominios = lista(a.dominio).map((d) => d.toLowerCase());
  const paises = lista(a.pais), idiomas = lista(a.idioma);
  const invalidas = fontes.filter((f) => !(f in FONTES));
  if (invalidas.length && !(a.q || dominios.length)) erroArgs(`fontes desconhecidas: ${invalidas.join(", ")}`);

  const con = abrir_db();
  const cli = new Urlscan(ler_env("URLSCAN_API_KEY"));
  if (!a.so_relatorio) {
    console.log(`API key: ${cli.api_key ? "sim" : "não (limite menor, 30 buscas/min por IP)"}\n`);
    const novos = await minerar(cli, con, fontes, a.dias, a.max_paginas, a.q, dominios, paises, idiomas);
    console.log(`\n${novos} scans novos salvos em ${path.basename(DB_PATH)}`);
    if (cli.api_key && a.detalhar) await detalhar(cli, con, a.detalhar);
  }
  if ((a.dna || !a.so_relatorio) && !a.sem_dna) await analise.analisar_paginas(con, a.max_dna);
  if ((a.ct || !a.so_relatorio) && !a.sem_ct) {
    const chaveCt = ler_env("CERTSPOTTER_API_KEY");
    await analise.vigiar_ct(con, a.max_ct || (chaveCt ? 100 : 10), (...x) => salvar_oferta_ct(con, ...x),
      ler_acompanhar(), chaveCt || null);
  }
  const chaveCrux = ler_env("CRUX_API_KEY");
  if ((a.trafego || !a.so_relatorio) && !a.sem_trafego) await atualizar_trafego(con, chaveCrux);
  gerar_relatorios(con, dominios, paises, idiomas, a.relatorio_dias, Boolean(chaveCrux));
  con.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
