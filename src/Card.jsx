import { memo, useState } from "react";
import { IconeCopiar, IconeEstrela } from "./icones.jsx";
import { copiarTexto } from "./copiar.js";
import {
  TENDENCIAS, data_br, dia_br, link_anuncios, link_anuncios_google, texto_trafego,
} from "./shared/formato.js";

function BotaoCopiar({ texto }) {
  const [ok, setOk] = useState(false);
  const clicar = () => copiarTexto(texto, () => {
    setOk(true);
    setTimeout(() => setOk(false), 1200);
  }, true);
  return (
    <button className={"copy" + (ok ? " ok" : "")} type="button" title="copiar domínio" onClick={clicar}>
      <IconeCopiar />
    </button>
  );
}

function Card({ o, ult, oculto, seguida, fixo, aoSeguir, aoGrupo }) {
  const [semPrint, setSemPrint] = useState(false);
  const [rotulo, detalhe] = texto_trafego(o);
  const titulo = o.titulo || "";
  const tend = o.tendencia;
  const idade = o.idade_dominio === null || o.idade_dominio === undefined ? "–" : `${o.idade_dominio}d`;
  const grupos = o.tam_oferta > 1 || o.tam_dono > 1;
  const tituloEstrela = fixo ? "acompanhando (está no acompanhar.txt)"
    : seguida ? "deixar de acompanhar" : "acompanhar esta oferta";

  return (
    <article className={"card" + (seguida ? " seguida" : "")} hidden={oculto}>
      <a className={"shot" + (semPrint ? " semprint" : "")} href={o.urlscan} target="_blank" rel="noreferrer"
        title="ver o scan completo no urlscan">
        <img loading="lazy" src={o.screenshot} alt="" onError={() => setSemPrint(true)} />
        {o.desc === ult && <span className="selo">NOVA</span>}
        <span className="score" title="score">{o.score}</span>
      </a>
      <div className="info">
        <div className="a">
          <h3 title={titulo}>{titulo || "(sem título)"}</h3>
          <div className="dom">
            <span title={o.dominio}>{o.dominio}</span>
            <BotaoCopiar texto={o.dominio} />
            <button className={"seguir" + (seguida ? " on" : "")} type="button" aria-pressed={String(seguida)}
              title={tituloEstrela} onClick={() => aoSeguir(o.dominio)}>
              <IconeEstrela />
            </button>
          </div>
          <div className="chips">
            {o.paises.map((x) => <span key={"p" + x} className="chip pais" title="país do servidor">{x}</span>)}
            {o.idiomas.map((x) => <span key={"i" + x} className="chip idioma" title="idioma da página">{x}</span>)}
            {o.google_ads && (
              <span className="chip gads" title="a página carrega a tag do Google Ads: anuncia ou anunciou no Google">Google Ads</span>
            )}
            {o.via_ct && (
              <span className="chip ct" title="achada pelo vigia de certificados (subdomínio novo de uma oferta conhecida)">via certificado</span>
            )}
            {o.fontes.map((x) => <span key={"f" + x} className="chip" title="fonte (o que a página carrega)">{x}</span>)}
          </div>
          {grupos && (
            <div className="grupos">
              {o.tam_oferta > 1 && (
                <button className="grupo" type="button" onClick={() => aoGrupo("o:" + o.membros_oferta[0])}
                  title={"mesmo player de vídeo ou mesmo produto no checkout: " + o.membros_oferta.slice(0, 15).join(", ")}>
                  Mesma oferta em <b>{o.tam_oferta} domínios</b>
                </button>
              )}
              {o.tam_dono > 1 && (
                <button className="grupo" type="button" onClick={() => aoGrupo("d:" + o.membros_dono[0])}
                  title={"mesmo pixel da Meta ou mesma conta do Google Ads: " + o.membros_dono.slice(0, 15).join(", ")}>
                  Mesmo dono em <b>{o.tam_dono} domínios</b>
                </button>
              )}
            </div>
          )}
        </div>
        <div className="b">
          <p className={`tend t-${tend}`} title="scans no urlscan: semana anterior → esta semana">
            <b>{TENDENCIAS[tend]}</b><small>{o.sem_ant} → {o.sem_atual} scans/semana</small>
          </p>
          <div className={`traf n${o.trafego_nivel}`} title="tráfego de usuários reais do Chrome nos últimos 28 dias (Google CrUX)">
            <span className="barras"><i></i><i></i><i></i><i></i></span><b>{rotulo}</b><small>{detalhe}</small>
          </div>
          <dl className="nums">
            <div><dt>scans</dt><dd>{o.scans}</dd></div>
            <div><dt>dias</dt><dd>{o.dias_vistos}</dd></div>
            <div><dt>URLs</dt><dd>{o.urls_distintas}</dd></div>
            <div><dt>idade dom.</dt><dd>{idade}</dd></div>
          </dl>
          <p className="quando">Achada em {dia_br(o.desc)}{o.scans ? " · último scan " + data_br(o.ultimo) : ""}</p>
          {o.checkout.length > 0 && (
            <details className="chk">
              <summary>{o.checkout.length} links de checkout</summary>
              <ul>
                {o.checkout.slice(0, 8).map((c) => (
                  <li key={c}><a href={c.startsWith("http") ? c : "https://" + c} target="_blank" rel="noreferrer">{Array.from(c).slice(0, 90).join("")}</a></li>
                ))}
              </ul>
            </details>
          )}
        </div>
      </div>
      <div className="acts">
        <a className="btn pri" href={o.url || ""} target="_blank" rel="noreferrer">Abrir página</a>
        <a className="btn" href={o.urlscan} target="_blank" rel="noreferrer">urlscan</a>
        <a className="btn" href={link_anuncios(o.apex)} target="_blank" rel="noreferrer"
          title={`Biblioteca de Anúncios da Meta buscando ${o.apex}`}>Anúncios Meta</a>
        <a className="btn" href={link_anuncios_google(o.apex)} target="_blank" rel="noreferrer"
          title={`Central de Transparência de Anúncios do Google buscando ${o.apex}`}>Anúncios Google</a>
      </div>
    </article>
  );
}

export default memo(Card);
