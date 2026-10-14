import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import Card from "./Card.jsx";
import { IconeEstrela } from "./icones.jsx";
import { copiarTexto } from "./copiar.js";
import { dia_br } from "./shared/formato.js";

const PADRAO = { q: "", per: "", tend: "", tra: "-1", gads: "", gru: "", seg: "", dias: "0", pais: "", idi: "", fon: "", grp: "" };
const EXTRAS = ["seg", "dias", "pais", "idi", "fon"];
const CHAVES = Object.keys(PADRAO);

function guardar(k, v) {
  try { localStorage.setItem("minerador." + k, v); } catch (e) { /* sem armazenamento */ }
}
function ler(k) {
  try { return localStorage.getItem("minerador." + k); } catch (e) { return null; }
}
const num = (n) => n.toLocaleString("pt-BR");
const comparar = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// Mesmas ordenações do relatório original; sempre partindo da ordem do minerador (score).
const CMP = {
  score: (a, b) => b.score - a.score,
  sub: (a, b) => (b.sem_atual - b.sem_ant) - (a.sem_atual - a.sem_ant) || b.score - a.score,
  grupo: (a, b) => b.tam_oferta - a.tam_oferta || b.score - a.score,
  traf: (a, b) => b.trafego_nivel - a.trafego_nivel || b.score - a.score,
  desc: (a, b) => b.desc.localeCompare(a.desc) || b.score - a.score,
  ult: (a, b) => (b.ultimo || "").localeCompare(a.ultimo || ""),
};

function Selecao({ id, rotulo, valor, aoMudar, children }) {
  return (
    <label className="campo"><span>{rotulo}</span>
      <select id={id} value={valor} onChange={(e) => aoMudar(e.target.value)}>{children}</select>
    </label>
  );
}

export default function App({ dados }) {
  const { ofertas, eventos, ult, atualizado, chave_crux: chaveCrux } = dados;
  const fixos = useMemo(() => new Set(dados.fixos), [dados.fixos]);
  const gridRef = useRef(null);

  // Opções do período: "desde dia X" acumula tudo que foi achado do dia X para cá.
  const { porDia, dias } = useMemo(() => {
    const porDia = new Map();
    for (const o of ofertas) porDia.set(o.desc, (porDia.get(o.desc) || 0) + 1);
    return { porDia, dias: [...porDia.keys()].filter(Boolean).sort(comparar).reverse() };
  }, [ofertas]);
  const ULT = dias.length ? dias[0] : "";
  const atalhos = useMemo(() => ({
    novas: { per: ULT }, subindo: { tend: "subindo" }, grupo: { gru: "o" },
    gads: { gads: "1" }, trafego: { tra: "1" }, seguindo: { seg: "1" },
  }), [ULT]);

  const opcoes = useCallback((campo) => {
    const cont = new Map();
    for (const o of ofertas) for (const x of o[campo]) cont.set(x, (cont.get(x) || 0) + 1);
    return [...cont.entries()].sort((a, b) => b[1] - a[1] || comparar(a[0], b[0]));
  }, [ofertas]);
  const [opPais, opIdi, opFon] = useMemo(() => [opcoes("paises"), opcoes("idiomas"), opcoes("fontes")], [opcoes]);

  const [f, setF] = useState(() => ({ ...PADRAO, per: ULT }));
  const aplicar = useCallback((v) => setF(Object.fromEntries(CHAVES.map((k) => [k, v[k] ?? PADRAO[k]]))), []);
  const mudar = (k) => (v) => setF((x) => ({ ...x, [k]: v }));

  const [ord, setOrd] = useState(() => {
    const o = ler("ord");
    return o && CMP[o] ? o : "score";
  });
  const ordem = useMemo(() => [...ofertas].sort(CMP[ord] || CMP.score), [ofertas, ord]);
  const ordenar = (v) => {
    setOrd(v);
    guardar("ord", v);
  };

  const [vista, setVista] = useState(() => (ler("vista") === "lista" ? "lista" : "cards"));
  useEffect(() => guardar("vista", vista), [vista]);
  const [mais, setMais] = useState(() => ler("mais") === "1");
  useEffect(() => guardar("mais", mais ? "1" : "0"), [mais]);

  const [seguidos, setSeguidos] = useState(() => {
    try { return new Set(JSON.parse(ler("acompanhar") || "[]")); } catch (e) { return new Set(); }
  });
  const segue = useCallback((d) => fixos.has(d) || seguidos.has(d), [fixos, seguidos]);
  const aoSeguir = useCallback((d) => {
    if (fixos.has(d)) return;
    setSeguidos((atual) => {
      const novo = new Set(atual);
      if (novo.has(d)) novo.delete(d); else novo.add(d);
      guardar("acompanhar", JSON.stringify([...novo]));
      return novo;
    });
  }, [fixos]);

  const irPara = useCallback((v) => {
    flushSync(() => aplicar(v));
    gridRef.current.scrollIntoView({ behavior: "smooth" });
  }, [aplicar]);
  const aoGrupo = useCallback((grp) => irPara({ grp }), [irPara]);

  // Filtro
  const t = f.q.trim().toLowerCase(), tra = +f.tra, minDias = +f.dias, grp = f.grp;
  const tem = (v, lista) => !v || lista.includes(v);
  const visivel = (o) => (!t || (o.dominio + " " + (o.titulo || "")).toLowerCase().includes(t))
    && (!f.per || o.desc >= f.per) && (!f.tend || o.tendencia === f.tend)
    && (o.trafego_nivel >= tra) && (!f.gads || String(Number(o.google_ads)) === f.gads)
    && (!f.gru || (f.gru === "o" ? o.tam_oferta > 1 : o.tam_dono > 1))
    && (!f.seg || segue(o.dominio)) && (o.dias_vistos >= minDias)
    && (!grp || (grp[0] === "o" ? (o.membros_oferta[0] || "") === grp.slice(2) : (o.membros_dono[0] || "") === grp.slice(2)))
    && tem(f.pais, o.paises) && tem(f.idi, o.idiomas) && tem(f.fon, o.fontes);
  const visiveis = new Set(ofertas.filter(visivel));
  const n = visiveis.size;

  const estado = CHAVES.map((k) => f[k]).join("|");
  const alvo = (a) => CHAVES.map((k) => atalhos[a][k] ?? PADRAO[k]).join("|");
  const ativos = EXTRAS.filter((k) => f[k] !== PADRAO[k]).length;
  // Como no original, a pílula escondida guarda o último grupo mostrado.
  const pilula = useRef("");
  if (grp) pilula.current = (grp[0] === "o" ? "Mesma oferta de " : "Mesmo dono de ") + grp.slice(2);

  const nTraf = ofertas.filter((o) => o.trafego_nivel >= 1).length;
  const nGads = ofertas.filter((o) => o.google_ads).length;
  const nSub = ofertas.filter((o) => o.tendencia === "subindo").length;
  const nGrp = ofertas.filter((o) => o.tam_oferta > 1).length;

  // Novidades das que você acompanha
  const domsSeguidos = new Set([...fixos, ...seguidos]);
  const evSeguidos = eventos.filter((e) => domsSeguidos.has(e.d));
  const [copiado, setCopiado] = useState(false);
  const copiarLista = () => {
    const txt = [...domsSeguidos].sort(comparar).join("\n");
    copiarTexto(txt, () => {
      setCopiado(true);
      setTimeout(() => setCopiado(false), 1200);
    });
  };

  const stat = (atalho, valor, texto, id) => (
    <button className={"stat" + (alvo(atalho) === estado ? " on" : "")} type="button" onClick={() => aplicar(atalhos[atalho])}>
      <b id={id}>{valor}</b><span>{texto}</span>
    </button>
  );

  return (
    <>
      <header className="wrap topo">
        <h1>Minerador de ofertas</h1>
        <p>Atualizado em {atualizado} · busca automática todo dia às 9h</p>
        <div className="stats">
          {stat("novas", porDia.get(ult) || 0, `novas na última rodada (${dia_br(ult)})`)}
          {stat("subindo", nSub, "com scans subindo esta semana")}
          {stat("grupo", nGrp, "rodando em vários domínios")}
          {stat("gads", nGads, "com tag do Google Ads")}
          {stat("trafego", nTraf, "com tráfego real medido")}
          {stat("seguindo", num(domsSeguidos.size), "que você acompanha", "n-seg")}
        </div>
        {!chaveCrux && (
          <p className="aviso"><b>Tráfego parcial.</b> Sem a chave do CrUX, só dá para medir os sites que estão no top 1 milhão do Chrome; os outros aparecem como &quot;Não medido&quot;. O passo a passo para ativar (grátis) está no LEIA-ME.</p>
        )}
        <section className="alertas" aria-labelledby="alertas-tit">
          <h2 id="alertas-tit"><IconeEstrela />Novidades das ofertas que você acompanha <button id="copiar-lista" className="limpar" type="button" title="copia os domínios para colar no acompanhar.txt" onClick={copiarLista}>{copiado ? "Copiado" : "Copiar lista"}</button></h2>
          <div id="alertas-lista">
            {!domsSeguidos.size ? (
              <p className="dica">Clique na estrela de um card para acompanhar a oferta. As novidades dela (página nova, domínio novo com a mesma oferta, tráfego, scans subindo) aparecem aqui.</p>
            ) : !evSeguidos.length ? (
              <p className="dica">Nada novo nas {num(domsSeguidos.size)} ofertas que você acompanha nos últimos 30 dias.</p>
            ) : (
              <ul>
                {evSeguidos.slice(0, 60).map((e, i) => (
                  <li key={i}>
                    <span className="q">{e.q}</span>
                    <button type="button" className="ir" title="ver o card" onClick={() => irPara({ q: e.d })}>{e.d}</button>
                    <span>{e.x}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      </header>
      <nav className="filtros"><div className="wrap">
        <div className="linha">
          <label className="campo busca"><span>Buscar</span>
            <input id="q" type="search" placeholder="domínio ou título" autoComplete="off" value={f.q} onChange={(e) => mudar("q")(e.target.value)} />
          </label>
          <Selecao id="per" rotulo="Período" valor={f.per} aoMudar={mudar("per")}>
            {dias.map((d) => (
              <option key={d} value={d}>
                {d === ult ? `Novas da última rodada (${dia_br(d)}) · ${porDia.get(d)}`
                  : `Achadas desde ${dia_br(d)} · ${dias.filter((x) => x >= d).reduce((s, x) => s + porDia.get(x), 0)}`}
              </option>
            ))}
            <option value="">Todas as datas · {ofertas.length}</option>
          </Selecao>
          <Selecao id="tend" rotulo="Tendência" valor={f.tend} aoMudar={mudar("tend")}>
            <option value="">Qualquer</option><option value="subindo">↑ Subindo</option><option value="estavel">→ Estável</option><option value="caindo">↓ Caindo</option><option value="parado">Parado</option>
          </Selecao>
          <Selecao id="gru" rotulo="Grupo" valor={f.gru} aoMudar={mudar("gru")}>
            <option value="">Qualquer</option><option value="o">Mesma oferta em 2+ domínios</option><option value="d">Mesmo dono em 2+ domínios</option>
          </Selecao>
          <Selecao id="tra" rotulo="Tráfego" valor={f.tra} aoMudar={mudar("tra")}>
            <option value="-1">Qualquer</option><option value="1">Com tráfego real</option><option value="2">Médio ou mais</option><option value="3">Alto ou mais</option>
          </Selecao>
          <Selecao id="gads" rotulo="Google Ads" valor={f.gads} aoMudar={mudar("gads")}>
            <option value="">Qualquer</option><option value="1">Com tag do Google Ads</option><option value="0">Sem tag</option>
          </Selecao>
          <Selecao id="ord" rotulo="Ordenar" valor={ord} aoMudar={ordenar}>
            <option value="score">Maior score</option><option value="sub">Subindo mais</option><option value="grupo">Mais domínios na oferta</option><option value="traf">Mais tráfego</option><option value="desc">Achadas mais recentes</option><option value="ult">Último scan</option>
          </Selecao>
          <div className="campo"><span>Exibir</span>
            <div className="vista">
              <button type="button" aria-pressed={String(vista === "cards")} onClick={() => setVista("cards")}>Cards</button>
              <button type="button" aria-pressed={String(vista === "lista")} onClick={() => setVista("lista")}>Lista</button>
            </div>
          </div>
          <button className="mais" id="mais" type="button" aria-expanded={String(mais)} aria-controls="extra" onClick={() => setMais(!mais)}>
            {"Mais filtros" + (ativos ? " (" + ativos + ")" : "")}
          </button>
          <button className="limpar" id="limpar" type="button" onClick={() => aplicar({})}>Limpar filtros</button>
          <span className="cont" id="cont"><b>{num(n)}</b> de {num(ofertas.length)} ofertas</span>
        </div>
        <div className="linha" id="extra" hidden={!mais}>
          <Selecao id="seg" rotulo="Acompanhando" valor={f.seg} aoMudar={mudar("seg")}>
            <option value="">Todas</option><option value="1">Só as que acompanho</option>
          </Selecao>
          <Selecao id="dias" rotulo="Dias vistos" valor={f.dias} aoMudar={mudar("dias")}>
            <option value="0">Qualquer</option><option value="2">2 ou mais</option><option value="3">3 ou mais</option><option value="5">5 ou mais</option>
          </Selecao>
          <Selecao id="pais" rotulo="País" valor={f.pais} aoMudar={mudar("pais")}>
            <option value="">Todos</option>
            {opPais.map(([x, c]) => <option key={x} value={x}>{x} ({c})</option>)}
          </Selecao>
          <Selecao id="idi" rotulo="Idioma" valor={f.idi} aoMudar={mudar("idi")}>
            <option value="">Todos</option>
            {opIdi.map(([x, c]) => <option key={x} value={x}>{x} ({c})</option>)}
          </Selecao>
          <Selecao id="fon" rotulo="Fonte" valor={f.fon} aoMudar={mudar("fon")}>
            <option value="">Todas</option>
            {opFon.map(([x, c]) => <option key={x} value={x}>{x} ({c})</option>)}
          </Selecao>
        </div>
      </div></nav>
      <main className="wrap">
        <p id="pilula" className="pilula" hidden={!grp} style={{ margin: "16px 0 0" }}>
          <span id="pilula-txt">{pilula.current}</span>
          <button id="pilula-x" type="button" title="mostrar todas" onClick={() => setF((x) => ({ ...x, grp: "" }))}>✕</button>
        </p>
        <div id="grid" ref={gridRef} className={"grade" + (vista === "lista" ? " lista" : "")}>
          {ordem.map((o) => (
            <Card key={o.dominio} o={o} ult={ult} oculto={!visiveis.has(o)} seguida={segue(o.dominio)}
              fixo={fixos.has(o.dominio)} aoSeguir={aoSeguir} aoGrupo={aoGrupo} />
          ))}
        </div>
        <p id="vazio" className="vazio" hidden={n > 0}>Nenhuma oferta com esses filtros.</p>
        <section className="rodape">
          <h2>Como ler o relatório</h2>
          <dl>
            <dt>Score</dt><dd>scans + 2×dias vistos + URLs distintas (até 10) + 3×fontes extras + 2×outros domínios com a mesma oferta (até 10). Domínio que aparece todo dia, com várias URLs e em vários domínios, provavelmente está escalando.</dd>
            <dt>Mesma oferta</dt><dd>Domínios com o mesmo player de vídeo (VTurb/Panda) ou o mesmo produto no checkout (ClickBank, Digistore, BuyGoods, Hotmart, Kiwify, CartPanda). Ninguém sobe vários domínios para uma oferta que não vende. Clique no botão para ver todos.</dd>
            <dt>Mesmo dono</dt><dd>Domínios com o mesmo pixel da Meta, pixel da UTMify ou conta do Google Ads: a mesma pessoa ou empresa, mesmo que em ofertas diferentes. IDs que aparecem em mais de 25 domínios são ignorados (template ou agência).</dd>
            <dt>Tendência</dt><dd>Scans no urlscan na semana anterior → nesta semana. Subindo = pelo menos o dobro (e 2 ou mais); Caindo = metade ou menos.</dd>
            <dt>Acompanhar</dt><dd>A estrela marca a oferta (fica salva neste navegador). As novidades das marcadas aparecem no topo: página nova, título novo, domínio novo com a mesma oferta ou do mesmo dono, vídeo/produto trocado, tráfego mudou, scans subindo, subdomínio novo. Domínios no arquivo acompanhar.txt ficam sempre marcados.</dd>
            <dt>Via certificado</dt><dd>Subdomínio novo de uma oferta conhecida, achado nos certificados de segurança emitidos (CertSpotter) e confirmado como oferta pelo HTML. O print vem de um serviço grátis até o urlscan escanear.</dd>
            <dt>Tráfego</dt><dd>Popularidade entre usuários reais do Chrome nos últimos 28 dias (Google CrUX). Muito alto = top 100 mil sites; Alto = top 500 mil; Médio = top 1 milhão; Baixo = fora do top 1 milhão, mas com visitas suficientes para o Google medir; Sem dados = visitas abaixo do mínimo do Google; Não medido = fora do top 1 milhão e ainda não consultado. É uma faixa, não o número exato de acessos.</dd>
            <dt>Google Ads</dt><dd>O selo aparece quando a landing carrega a tag do Google Ads: o dono anuncia ou anunciou no Google. Não garante que está rodando hoje; confirme no botão &quot;Anúncios Google&quot;.</dd>
            <dt>Anúncios</dt><dd>&quot;Anúncios Meta&quot; abre a Biblioteca de Anúncios da Meta e &quot;Anúncios Google&quot; abre a Central de Transparência do Google, as duas já buscando o domínio principal.</dd>
            <dt>País e idioma</dt><dd>País = onde o servidor está hospedado (vazio quando está atrás da Cloudflare). Idioma = idioma da página, a melhor pista do mercado-alvo.</dd>
            <dt>Achada em</dt><dd>Dia em que o minerador viu o domínio pela primeira vez. O selo NOVA marca as achadas na última rodada.</dd>
          </dl>
        </section>
      </main>
    </>
  );
}
