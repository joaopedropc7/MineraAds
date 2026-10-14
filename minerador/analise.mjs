/*
Análise das landing pages, usada pelo minerador.mjs:

- DNA técnico: baixa o HTML da landing (sem rodar nada da página) e tira os IDs que
  denunciam a mesma oferta (player da VTurb/Panda, produto no checkout) ou o mesmo
  dono (pixel da Meta, conta do Google Ads, pixel da UTMify).
- Grupos: domínios que compartilham esses IDs.
- Vigia de certificados (Certificate Transparency, via CertSpotter): subdomínios novos
  das ofertas conhecidas. Só entra o que tiver assinatura de oferta no HTML.
- Alertas: compara o estado de cada oferta com a rodada anterior e registra o que mudou.
*/

import { decodeHTML } from "entities";
import { agora_sql, corta, dormir, mapaLimitado, strftimeUtc } from "./util.mjs";

const UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
  + "(KHTML, like Gecko) Chrome/140.0 Safari/537.36");

// O que a página precisa carregar para contar como oferta (mesmas fontes do minerador).
export const ASSINATURAS = {
  vturb: /converteai\.net|vturb\.com/i,
  panda: /pandavideo\.com\.br/i,
  utmify: /utmify\.com\.br/i,
  clickbank: /clickbank\.net/i,
  digistore: /digistore24\.com|checkout-ds24\.com|digistore24-app\.com/i,
  buygoods: /buygoods\.com/i,
  maxweb: /maxweb\.com/i,
  checkoutchamp: /checkoutchamp\.com/i,
  cartpanda: /mycartpanda\.com/i,
  hotmart: /pay\.hotmart\.com/i,
  kiwify: /pay\.kiwify\.com\.br/i,
};

export const ASSINATURAS_FRACAS = new Set(["utmify"]);

// [tipo, regex com o ID no 1º grupo]. Os tipos de "oferta" dizem que é o mesmo produto/vídeo;
// os de "dono" dizem que é a mesma pessoa/empresa rodando.
const PADROES_DNA = [
  ["vturb", String.raw`converteai\.net/[0-9a-f-]{8,}/players/([0-9a-f]{24})`],
  ["vturb", String.raw`\bvid[-_]([0-9a-f]{24})\b`],
  ["panda", String.raw`pandavideo\.com\.br/embed/?\?v=([0-9a-f-]{36})`],
  ["cb", String.raw`//([a-z0-9]{3,})\.hop\.clickbank\.net`],
  ["cb", String.raw`clickbank\.net[^"'\s<>]*?[?&](?:amp;)?vendor=([a-z0-9]{3,})`],
  ["ds24", String.raw`(?:digistore24\.com|checkout-ds24\.com)/(?:product|redir)/(\d{4,})`],
  ["bg", String.raw`buygoods\.com[^"'\s<>]*?[?&](?:amp;)?product(?:_codename)?=([A-Za-z0-9_-]{3,})`],
  ["hotmart", String.raw`pay\.hotmart\.com/([A-Z][A-Z0-9]{7,11})`],
  ["kiwify", String.raw`pay\.kiwify\.com\.br/([A-Za-z0-9]{5,12})`],
  ["cartpanda", String.raw`//([a-z0-9-]{3,})\.mycartpanda\.com`],
  ["pixel", String.raw`fbq\(\s*['"]init['"]\s*,\s*['"]?(\d{12,17})`],
  ["pixel", String.raw`facebook\.com/tr/?\?id=(\d{12,17})`],
  ["utmify", String.raw`pixelId\s*=\s*['"]([0-9a-f]{24})['"]`],
  ["gads", String.raw`\bAW-(\d{9,11})\b`],
  ["gads", String.raw`googleads\.g\.doubleclick\.net/pagead/viewthroughconversion/(\d{9,11})`],
].map(([t, p]) => [t, new RegExp(p, "gi")]);
export const TIPOS_OFERTA = new Set(["vturb", "panda", "cb", "ds24", "bg", "hotmart", "kiwify", "cartpanda"]);
export const TIPOS_DONO = new Set(["pixel", "utmify", "gads"]);
export const NOMES_DNA = {
  vturb: "player VTurb", panda: "player Panda", cb: "vendor ClickBank",
  ds24: "produto Digistore", bg: "produto BuyGoods", hotmart: "produto Hotmart",
  kiwify: "produto Kiwify", cartpanda: "loja CartPanda", pixel: "pixel da Meta",
  utmify: "pixel UTMify", gads: "conta Google Ads",
};

// Um ID que aparece em mais domínios que isso é genérico (template, agência, a própria
// plataforma) e não serve para agrupar.
const MAX_DOMINIOS_POR_ID = 25;

export const CHECKOUT_RE = new RegExp(
  String.raw`hop\.clickbank\.net|clickbank\.net|digistore24\.com|checkout-ds24\.com|buygoods\.com|`
  + String.raw`maxweb\.com|checkoutchamp|cartpanda|pay\.hotmart\.com|pay\.kiwify|/checkout|/order|/buy`,
  "i",
);

// Hospedagens em que cada cliente é um subdomínio: o "domínio principal" é o próprio subdomínio,
// e não adianta vigiar certificados (eles usam certificado coringa).
const HOSPEDAGEM_COMPARTILHADA = [
  "vercel.app", "pages.dev", "netlify.app", "github.io", "web.app", "firebaseapp.com",
  "onrender.com", "herokuapp.com", "wixsite.com", "myshopify.com", "carrd.co", "glitch.me",
  "replit.app", "lovable.app", "surge.sh", "blogspot.com", "wordpress.com", "azurewebsites.net",
  "amplifyapp.com", "webflow.io", "framer.website", "framer.app", "squarespace.com",
  "godaddysites.com", "hostingersite.com", "arkedigital.app", "code.run", "hosted.app",
];

const ordenar = (lista) => lista.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
const semWww = (d) => d.replace(/^www\./, "");

export function criar_tabelas(con) {
  con.exec(`
    CREATE TABLE IF NOT EXISTS paginas (
        dominio TEXT PRIMARY KEY,
        url TEXT,
        status TEXT,
        titulo TEXT,
        assinaturas TEXT,   -- json: fontes achadas no HTML
        dna TEXT,           -- json: {tipo: [ids]}
        checkout TEXT,      -- json: links de checkout achados no HTML
        buscado_em TEXT
    );
    CREATE TABLE IF NOT EXISTS ct_vigia (
        apex TEXT PRIMARY KEY,
        ultimo_id TEXT,     -- última emissão já vista no CertSpotter
        verificado_em TEXT
    );
    CREATE TABLE IF NOT EXISTS estado (
        dominio TEXT PRIMARY KEY,
        dados TEXT,         -- json com o que a oferta era na rodada anterior
        atualizado_em TEXT
    );
    CREATE TABLE IF NOT EXISTS eventos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        dominio TEXT,
        quando TEXT,
        tipo TEXT,
        texto TEXT
    );
    CREATE INDEX IF NOT EXISTS ix_eventos_dom ON eventos(dominio);
  `);
}

// --------------------------------------------------------------------------
// HTML da landing
// --------------------------------------------------------------------------
async function lerAte(resp, limite) {
  if (!resp.body) return new Uint8Array();
  const reader = resp.body.getReader(), partes = [];
  let total = 0;
  while (total < limite) {
    const { done, value } = await reader.read();
    if (done) break;
    partes.push(value);
    total += value.length;
  }
  await reader.cancel().catch(() => {});
  const saida = new Uint8Array(Math.min(total, limite));
  let pos = 0;
  for (const p of partes) {
    const n = Math.min(p.length, saida.length - pos);
    saida.set(p.subarray(0, n), pos);
    pos += n;
    if (pos >= saida.length) break;
  }
  return saida;
}

// [status, url_final, html]. Não executa nada da página, só lê o texto.
export async function baixar_html(url, timeout = 15, limite = 1_500_000) {
  try {
    const r = await fetch(url, {
      headers: {
        "User-Agent": UA,
        "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9,pt-BR;q=0.8",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(timeout * 1000),
    });
    if (!r.ok) {
      r.body?.cancel().catch(() => {});
      return [String(r.status), url, ""];
    }
    const corpo = await lerAte(r, limite);
    const cs = /charset\s*=\s*["']?([\w-]+)/i.exec(r.headers.get("content-type") || "");
    return [String(r.status), r.url || url, decodificar(corpo, cs ? cs[1] : null)];
  } catch (e) {  // DNS, SSL, timeout, conexão recusada...
    const nome = e?.name === "TimeoutError" || e?.name === "AbortError" ? "TimeoutError" : "URLError";
    return [`erro ${nome}`, url, ""];
  }
}

// Subdomínios das próprias plataformas (CDN, API...), que não identificam loja nem vendor.
const GENERICOS = new Set(["assets", "cdn", "static", "api", "app", "www", "js", "img", "images", "media", "files",
  "checkout", "pay", "secure", "accounts", "my", "hop", "cdnjs", "scripts", "player"]);

export function extrair_dna(texto) {
  const dna = new Map();
  for (const [tipo, rx] of PADROES_DNA) {
    for (const m of texto.matchAll(rx)) {
      let valor = m[1];
      if (["cb", "vturb", "panda", "cartpanda"].includes(tipo)) valor = valor.toLowerCase();
      if ((tipo === "cb" || tipo === "cartpanda") && GENERICOS.has(valor)) continue;
      if (!dna.has(tipo)) dna.set(tipo, new Set());
      dna.get(tipo).add(valor);
    }
  }
  const saida = {};
  for (const [t, v] of dna) saida[t] = ordenar([...v]);
  return saida;
}

// UTF-8 quando der; senão o charset da página (meta) ou o do cabeçalho; senão Windows-1252.
function decodificar(corpo, charsetCabecalho) {
  const candidatos = [];
  const inicio = Buffer.from(corpo.subarray(0, 4096)).toString("latin1");
  const m = /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(inicio);
  if (m) candidatos.push(m[1]);
  if (charsetCabecalho) candidatos.push(charsetCabecalho);
  for (const cs of ["utf-8", ...candidatos, "cp1252"]) {
    try {
      return new TextDecoder(cs, { fatal: true }).decode(corpo);
    } catch {
      continue;
    }
  }
  return new TextDecoder("utf-8").decode(corpo);
}

export function analisar_html(texto) {
  const assinaturas = ordenar(Object.keys(ASSINATURAS).filter((n) => ASSINATURAS[n].test(texto)));
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(texto);
  const titulo = m ? corta(decodeHTML(m[1].replace(/\s+/g, " ")).trim(), 200) : "";
  const hrefs = [...texto.matchAll(/href\s*=\s*["']([^"']+)["']/gi)].map((x) => x[1]);
  const checkout = ordenar([...new Set(hrefs.filter((h) => CHECKOUT_RE.test(h) && h.startsWith("http"))
    .map((h) => decodeHTML(h)))]).slice(0, 25);
  return [assinaturas, extrair_dna(texto), checkout, titulo];
}

export function salvar_pagina(con, dominio, url, status, titulo, assinaturas, dna, checkout) {
  con.run(
    `INSERT INTO paginas VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(dominio) DO UPDATE SET url=excluded.url, status=excluded.status,
         titulo=excluded.titulo, assinaturas=excluded.assinaturas, dna=excluded.dna,
         checkout=excluded.checkout, buscado_em=excluded.buscado_em`,
    dominio, url, status, titulo, JSON.stringify(assinaturas), JSON.stringify(dna),
    JSON.stringify(checkout), agora_sql(),
  );
}

// Junta IDs vindos de outra fonte (ex.: resultado completo do urlscan) aos que já temos.
export function mesclar_dna(con, dominio, dnaNovo) {
  if (!Object.keys(dnaNovo).length) return;
  const linha = con.get("SELECT dna FROM paginas WHERE dominio=?", dominio);
  const atual = linha && linha.dna ? JSON.parse(linha.dna) : {};
  for (const [tipo, ids] of Object.entries(dnaNovo)) {
    atual[tipo] = ordenar([...new Set([...(atual[tipo] || []), ...ids])]);
  }
  if (linha) {
    con.run("UPDATE paginas SET dna=? WHERE dominio=?", JSON.stringify(atual), dominio);
  } else {
    con.run("INSERT INTO paginas (dominio, dna, buscado_em) VALUES (?,?,?)",
      dominio, JSON.stringify(atual), agora_sql());
  }
}

// Baixa o HTML das landings ainda não analisadas (ou analisadas há mais de 7 dias
// e ainda ativas) e guarda assinaturas, DNA e links de checkout.
export async function analisar_paginas(con, limite = 500, workers = 8) {
  const pendentes = con.all(
    `SELECT s.dominio,
            (SELECT url FROM scans s2 WHERE s2.dominio = s.dominio ORDER BY time DESC LIMIT 1) url
     FROM (SELECT dominio, MAX(time) t FROM scans GROUP BY dominio) s
     LEFT JOIN paginas p ON p.dominio = s.dominio
     WHERE p.buscado_em IS NULL
        OR (p.buscado_em < datetime('now', '-7 days') AND s.t >= datetime('now', '-14 days'))
     ORDER BY s.t DESC LIMIT ?`,
    limite,
  );
  if (!pendentes.length) return;
  console.log(`-> DNA: analisando o HTML de ${pendentes.length} landings...`);

  let comDna = 0, i = 0;
  await mapaLimitado(pendentes, workers, async (linha) => {
    const dominio = linha.dominio, url = linha.url || `https://${dominio}/`;
    const [status, final, texto] = await baixar_html(url);
    return [dominio, final, status, texto ? analisar_html(texto) : [[], {}, [], ""]];
  }, ([dominio, final, status, [assin, dna, checkout, titulo]]) => {
    i += 1;
    salvar_pagina(con, dominio, final, status, titulo, assin, dna, checkout);
    comDna += Object.keys(dna).length ? 1 : 0;
    if (i % 100 === 0) {
      con.commit();
      console.log(`   ${i}/${pendentes.length}`);
    }
  });
  con.commit();
  console.log(`   ${comDna} com IDs de oferta/dono`);
}

// --------------------------------------------------------------------------
// Grupos
// --------------------------------------------------------------------------
// Devolve [grupo_oferta, grupo_dono, ids_por_dominio, principal].
// grupo_* = Map {dominio: [membros do grupo]}, só para grupos com 2+ domínios principais.
export function calcular_grupos(con) {
  const apex = new Map(con.all("SELECT dominio, MAX(apex) apex FROM scans GROUP BY dominio").map((r) => [r.dominio, r.apex]));
  const porId = new Map();
  const idsPorDom = new Map();
  for (const r of con.all("SELECT dominio, dna FROM paginas WHERE dna IS NOT NULL")) {
    const dna = r.dna ? JSON.parse(r.dna) : {};
    idsPorDom.set(r.dominio, dna);
    for (const [tipo, ids] of Object.entries(dna)) {
      for (const i of ids) {
        if ((tipo === "cb" || tipo === "cartpanda") && GENERICOS.has(i)) continue;
        const chave = tipo + "\u0000" + i;
        if (!porId.has(chave)) porId.set(chave, { tipo, doms: new Set() });
        porId.get(chave).doms.add(r.dominio);
      }
    }
  }

  const principal = (d) => semWww(apex.get(d) || d);

  function unir(tipos) {
    const pai = new Map();
    const raiz = (x) => {
      if (!pai.has(x)) pai.set(x, x);
      while (pai.get(x) !== x) {
        pai.set(x, pai.get(pai.get(x)));
        x = pai.get(x);
      }
      return x;
    };
    for (const { tipo, doms } of porId.values()) {
      if (!tipos.has(tipo) || doms.size < 2) continue;
      if (new Set([...doms].map(principal)).size > MAX_DOMINIOS_POR_ID) continue;
      const lista = ordenar([...doms]);
      for (const d of lista.slice(1)) pai.set(raiz(d), raiz(lista[0]));
    }
    const grupos = new Map();
    for (const d of [...pai.keys()]) {
      const r = raiz(d);
      if (!grupos.has(r)) grupos.set(r, new Set());
      grupos.get(r).add(d);
    }
    const saida = new Map();
    for (const membros of grupos.values()) {
      // x.com e www.x.com, ou try.x.com e x.com, são o mesmo site: não contam como grupo.
      if (new Set([...membros].map(principal)).size < 2) continue;
      const ordenados = ordenar([...membros]);
      for (const d of membros) saida.set(d, ordenados);
    }
    return saida;
  }

  return [unir(TIPOS_OFERTA), unir(TIPOS_DONO), idsPorDom, principal];
}

// --------------------------------------------------------------------------
// Vigia de certificados (Certificate Transparency via CertSpotter, grátis sem chave)
// --------------------------------------------------------------------------
const CERTSPOTTER = "https://api.certspotter.com/v1/issuances";

function compartilhada(apex) {
  return HOSPEDAGEM_COMPARTILHADA.some((h) => apex === h || apex.endsWith("." + h));
}

// Certificados emitidos para o domínio e subdomínios. null se bateu no limite
// (grátis: 10 consultas por hora; plano pago: 100).
async function emissoes(apex, depois = null, paginas = 5, chave = null) {
  let saida = [], ultimo = depois;
  for (let p = 0; p < paginas; p++) {
    const q = new URLSearchParams({ domain: apex, include_subdomains: "true", expand: "dns_names" });
    if (ultimo) q.set("after", ultimo);
    const cab = { "User-Agent": "minerador-local/1.0" };
    if (chave) cab.Authorization = `Bearer ${chave}`;
    let lote;
    try {
      const r = await fetch(`${CERTSPOTTER}?${q}`, { headers: cab, signal: AbortSignal.timeout(30000) });
      if (r.status === 429) return null;
      if (!r.ok) return saida;
      lote = await r.json();
    } catch {
      return saida;
    }
    if (!lote || !lote.length) break;
    saida = saida.concat(lote);
    ultimo = lote[lote.length - 1].id;
    if (lote.length < 100) break;
  }
  return saida;
}

// Ordem de vigia: as que você acompanha, as que rodam em vários domínios e as com
// mais scans na semana (o limite grátis do CertSpotter é pequeno).
function prioridade_ct(con, acompanhar = []) {
  const apex = new Map(con.all("SELECT dominio, MAX(apex) apex FROM scans GROUP BY dominio").map((r) => [r.dominio, r.apex]));
  let ordem = acompanhar.map((d) => apex.get(d) || d);
  const [grupoOferta, grupoDono] = calcular_grupos(con);
  ordem = ordem.concat(ordenar([...new Set([...grupoOferta.keys(), ...grupoDono.keys()])]).map((d) => apex.get(d) || d));
  ordem = ordem.concat(con.all(
    `SELECT apex FROM scans WHERE apex != '' AND uuid NOT LIKE 'ct:%'
     AND time >= strftime('%Y-%m-%dT%H:%M:%S', 'now', '-7 days')
     GROUP BY apex ORDER BY COUNT(*) DESC`).map((r) => r.apex));
  return [...new Set(ordem.filter(Boolean).map(semWww))];
}

// Para as ofertas mais importantes, procura subdomínios novos nos certificados emitidos
// e só aceita os que têm player de VSL ou checkout no HTML. aoAchar(host, apex, final,
// titulo, assinaturas) grava a oferta nova.
export async function vigiar_ct(con, limite = 10, aoAchar = null, acompanhar = [], chave = null) {
  const conhecidos = new Set(con.all("SELECT DISTINCT dominio FROM scans").map((r) => r.dominio));
  const recentes = new Set(con.all(
    "SELECT apex FROM ct_vigia WHERE verificado_em >= datetime('now', '-3 days')").map((r) => r.apex));
  const apexes = prioridade_ct(con, acompanhar).filter((a) => !recentes.has(a) && !compartilhada(a)).slice(0, limite);
  if (!apexes.length) return 0;
  console.log(`-> certificados: vigiando ${apexes.length} domínios de ofertas no CertSpotter...`);
  const corte = strftimeUtc(new Date(Date.now() - 30 * 86400_000));
  const candidatos = new Map();
  let consultados = 0;
  for (const apex of apexes) {
    const antes = con.get("SELECT ultimo_id FROM ct_vigia WHERE apex=?", apex);
    const lote = await emissoes(apex, antes ? antes.ultimo_id : null, 5, chave);
    if (lote === null) {
      console.log(`   CertSpotter pediu pausa depois de ${consultados} consultas (limite por hora); continua na próxima rodada`);
      break;
    }
    consultados += 1;
    const ultimo = lote.length ? lote[lote.length - 1].id : (antes ? antes.ultimo_id : null);
    con.run("INSERT OR REPLACE INTO ct_vigia VALUES (?,?,?)", apex, ultimo, agora_sql());
    for (const e of lote) {
      // Na primeira consulta de um domínio vem o histórico todo: só interessa o recente.
      if (!antes && (e.not_before || "") < corte) continue;
      for (let nome of e.dns_names || []) {
        nome = nome.toLowerCase().replace(/^\.+|\.+$/g, "");
        if (nome.startsWith("*.") || conhecidos.has(nome) || conhecidos.has(semWww(nome))) continue;
        if (!candidatos.has(nome)) candidatos.set(nome, apex);
      }
    }
    await dormir(1.2);
  }
  con.commit();
  if (!candidatos.size) {
    console.log(`   ${consultados} consultados, nenhum subdomínio novo`);
    return 0;
  }
  console.log(`   ${candidatos.size} subdomínios novos; conferindo quais são ofertas...`);

  let achadas = 0;
  await mapaLimitado([...candidatos.entries()].slice(0, 300), 8, async ([host, apex]) => {
    const [status, final, texto] = await baixar_html(`https://${host}/`);
    return [host, apex, status, final, texto ? analisar_html(texto) : null];
  }, ([host, apex, status, final, analise]) => {
    if (!analise) return;
    const [assin, dna, checkout, titulo] = analise;
    // Só entra com player de VSL ou checkout de oferta. Rastreador sozinho (UTMify)
    // aparece também em cardápio, aula e site institucional.
    if (!assin.some((a) => !ASSINATURAS_FRACAS.has(a))) return;
    salvar_pagina(con, host, final, status, titulo, assin, dna, checkout);
    if (aoAchar) aoAchar(host, apex, final, titulo, assin);
    registrar_evento(con, [...conhecidos].filter((d) => d === apex || d.endsWith("." + apex)).slice(0, 20),
      "subdominio", `Subdomínio novo com oferta (certificado): ${host}`);
    achadas += 1;
  });
  con.commit();
  console.log(`   ${achadas} ofertas novas confirmadas por certificado`);
  return achadas;
}

// --------------------------------------------------------------------------
// Tendência e alertas
// --------------------------------------------------------------------------
export function tendencia(semanaAnterior, semanaAtual) {
  if (semanaAtual >= 2 && semanaAtual >= 2 * Math.max(semanaAnterior, 1)) return "subindo";
  if (semanaAnterior >= 2 && semanaAtual * 2 <= semanaAnterior) return "caindo";
  if (semanaAnterior || semanaAtual) return "estavel";
  return "parado";
}

export function registrar_evento(con, dominios, tipo, texto) {
  const hoje = agora_sql().slice(0, 10);
  for (const d of dominios) {
    const ja = con.get("SELECT 1 FROM eventos WHERE dominio=? AND texto=? AND quando >= ?", d, texto, hoje);
    if (!ja) {
      con.run("INSERT INTO eventos (dominio, quando, tipo, texto) VALUES (?,?,?,?)", d, agora_sql(), tipo, texto);
    }
  }
}

function _lista(itens, n = 3) {
  itens = ordenar([...itens]);
  return itens.slice(0, n).join(", ") + (itens.length > n ? ` e mais ${itens.length - n}` : "");
}

// Compara cada oferta com a rodada anterior e grava o que mudou em `eventos`.
// Na primeira vez só guarda o estado (não tem com o que comparar).
export function registrar_mudancas(con, ofertas, niveis) {
  const antes = new Map(con.all("SELECT dominio, dados FROM estado").map((r) => [r.dominio, JSON.parse(r.dados)]));
  const primeira = antes.size === 0;
  for (const o of ofertas) {
    const atual = {
      t: o.titulo || "",
      p: ordenar([...o.paths]).slice(0, 60),
      n: o.trafego_nivel,
      g: o.google_ads,
      go: o.membros_oferta,
      gd: o.membros_dono,
      dna: Object.fromEntries(Object.entries(o.dna).filter(([t]) => TIPOS_OFERTA.has(t))),
      tend: o.tendencia,
    };
    const a = antes.get(o.dominio);
    if (a && Object.keys(a).length && !primeira) {
      const ev = [];
      const pAntes = new Set(a.p || []);
      const novas = atual.p.filter((x) => !pAntes.has(x));
      if (novas.length && (a.p || []).length) ev.push(["pagina", `Página nova: ${_lista(novas)}`]);
      if (a.t && atual.t && a.t !== atual.t) {
        ev.push(["titulo", `Título mudou: “${corta(a.t, 60)}” → “${corta(atual.t, 60)}”`]);
      }
      const nAntes = a.n === undefined ? -1 : a.n;
      if (a.n !== atual.n && Math.max(nAntes, atual.n) >= 1) {
        ev.push(["trafego", `Tráfego: ${niveis[a.n] ?? "?"} → ${niveis[atual.n]}`]);
      }
      if (atual.g && !a.g) ev.push(["gads", "Começou a carregar a tag do Google Ads"]);
      const goAntes = new Set(a.go || []);
      const novosGo = atual.go.filter((x) => !goAntes.has(x) && x !== o.dominio);
      if (novosGo.length) ev.push(["grupo", `A mesma oferta apareceu em: ${_lista(novosGo)}`]);
      const gdAntes = new Set(a.gd || []), goAtual = new Set(atual.go);
      const novosGd = atual.gd.filter((x) => !gdAntes.has(x) && !goAtual.has(x) && x !== o.dominio);
      if (novosGd.length) ev.push(["dono", `O mesmo dono (pixel/conta Google) está em: ${_lista(novosGd)}`]);
      for (const [tipo, ids] of Object.entries(atual.dna)) {
        const velhos = new Set((a.dna || {})[tipo] || []);
        if (velhos.size && ids.some((x) => !velhos.has(x))) ev.push(["dna", `Trocou ou adicionou ${NOMES_DNA[tipo] || tipo}`]);
      }
      if (atual.tend === "subindo" && a.tend !== "subindo") {
        ev.push(["alta", `Scans subindo: ${o.sem_ant} → ${o.sem_atual} por semana`]);
      }
      for (const [tipo, texto] of ev) registrar_evento(con, [o.dominio], tipo, texto);
    }
    con.run("INSERT OR REPLACE INTO estado VALUES (?,?,?)", o.dominio, JSON.stringify(atual), agora_sql());
  }
  con.run("DELETE FROM eventos WHERE quando < datetime('now', '-60 days')");
  con.commit();
}

export function eventos_recentes(con, dias = 30) {
  return con.all(
    "SELECT dominio, quando, tipo, texto FROM eventos WHERE quando >= datetime('now', ?) ORDER BY quando DESC",
    `-${dias} days`,
  );
}
