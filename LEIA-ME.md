# Minerador urlscan (versão React)

Mesma ferramenta do `minerador_urlscan`, com o relatório refeito em **React** e o motor em **Node.js**.
Acha landing pages/VSLs recentes pelo que elas carregam (player VTurb, script UTMify, pixel ClickBank,
checkout BuyGoods/Digistore/MaxWeb/CheckoutChamp/CartPanda, Hotmart, Kiwify) usando a API
grátis do urlscan.io. Tudo fica num banco local (`minerador.db`), que vai acumulando a cada rodada.
O banco é o mesmo da versão em Python: dá para copiar o `minerador.db` de lá para cá e continuar de onde parou.

Cada rodada (todo dia às 9h): busca no urlscan → busca Google Ads → DNA das landings → vigia de
certificados → tráfego → relatório.

## Pastas
- `minerador/`: o motor (Node.js). `minerador.mjs` faz a busca, o tráfego e os relatórios; `analise.mjs` faz DNA,
  grupos, certificados e alertas.
- `src/`: o relatório em React (`App.jsx` com topo, filtros e rodapé; `Card.jsx` com cada oferta).
- `dist/`: o relatório montado (`npm run build`), num arquivo só. O minerador coloca os dados dentro dele e grava
  em `saida/relatorio.html`, que abre com dois cliques, sem servidor.

## Rodar
Dois cliques em `minerar.command` (na primeira vez ele instala as dependências e monta o relatório), ou:

    npm run minerar                                        # todas as fontes, 7 dias
    npm run minerar -- --dias 2 --fontes vturb,buygoods,clickbank
    npm run minerar -- --idioma en --pais US,CA            # filtra por localização
    npm run minerar -- --dominio claritywake.com --dias 30 # monitora domínios específicos
    npm run minerar -- --q 'page.title:"blood sugar" AND date:>now-30d'
    npm run minerar -- --so-relatorio --idioma en          # só regera o relatório, sem internet
    npm run minerar -- --so-relatorio --dna --ct           # regera + DNA + certificados
    npm run minerar -- --sem-dna --sem-ct --sem-trafego    # só a busca no urlscan
    npm run minerar -- --help                              # todas as opções

## Na nuvem (GitHub Actions + Vercel)
O `.github/workflows/minerar.yml` roda o minerador todo dia às 9h (Brasília) no GitHub Actions, salva o
`minerador.db` e o `public/dados.json` no repositório e faz push; a Vercel publica o relatório de novo com os
dados novos. Para rodar na hora: aba **Actions** do GitHub → **Minerar** → **Run workflow**.

- Chaves: no GitHub, **Settings → Secrets and variables → Actions → New repository secret** com os nomes
  `URLSCAN_API_KEY`, `CRUX_API_KEY` e `CERTSPOTTER_API_KEY` (só as que tiver).
- Antes de rodar no Mac, dê `git pull` para não sobrescrever o banco da nuvem. Não use o `agendar_9h.command`
  junto com a rodada na nuvem: são dois bancos que se separam.
- O `acompanhar.txt` só vale na nuvem se estiver commitado no repositório.

## Mexer no relatório (React)
    npm run dev      # abre o relatório em modo de desenvolvimento (lê saida/dados.json da última rodada)
    npm run build    # monta o dist/; depois rode `npm run minerar -- --so-relatorio --sem-dna --sem-ct --sem-trafego`

## Saída (`saida/`)
- `relatorio.html`: cards com print, tendência, grupo, tráfego e selos. Abre mostrando só as **novas da última
  rodada** (selo NOVA). Os quadros do topo são atalhos: novas, subindo, rodando em vários domínios, Google Ads,
  com tráfego real e as que você acompanha. Filtros principais na barra; país, idioma, fonte, dias vistos e
  "só as que acompanho" ficam em **Mais filtros**. Cada card tem: Abrir página, urlscan, Anúncios Meta,
  Anúncios Google, copiar domínio e a **estrela** para acompanhar.

País = onde o servidor está hospedado (fica vazio quando a página está atrás da Cloudflare).
Idioma = idioma da página, o melhor indicador do mercado-alvo.
- `ofertas.csv`: separado por `;`, abre direto no Sheets/Excel pt-BR
- `para_claude.txt`: top 50 das novas da última rodada + top 40 das já vistas, em tabela, com um pedido de análise pronto. O atalho `copiar_para_claude.command` já copia o conteúdo; é só colar no Claude.
- `dados.json`: os mesmos dados do relatório, usados pelo `npm run dev`
- `ultimo_log.txt`: saída da última rodada automática (agendada todo dia às 9h)

## Score
scans + 2×dias distintos + URLs distintas (até 10) + 3×fontes extras + 2×outros domínios com a mesma
oferta (até 10). Domínio que aparece todo dia, com várias URLs e em vários domínios, provavelmente está escalando.

## DNA e grupos
O minerador baixa o HTML de cada landing (só lê o texto, não executa nada) e tira os IDs:

| tipo | IDs | quer dizer |
|---|---|---|
| mesma oferta | player VTurb/Panda, vendor ClickBank, produto Digistore/BuyGoods/Hotmart/Kiwify, loja CartPanda | o mesmo VSL ou produto rodando em outro domínio |
| mesmo dono | pixel da Meta, pixel da UTMify, conta do Google Ads | a mesma pessoa/empresa, mesmo em ofertas diferentes |

No card aparece "Mesma oferta em N domínios" / "Mesmo dono em N domínios"; clicando, o relatório mostra só o
grupo. Domínios do mesmo site (`x.com`, `www.x.com`, `try.x.com`) contam como um. IDs que aparecem em mais
de 25 domínios são ignorados (template, agência). Cada landing é baixada de novo a cada 7 dias enquanto estiver
ativa. Com a chave do urlscan, o minerador também lê o scan completo (inclui scripts que só carregam depois).

## Tendência
Scans no urlscan na semana anterior → nesta semana. **Subindo** = pelo menos o dobro (e 2 ou mais);
**Caindo** = metade ou menos; **Estável** = o resto; **Parado** = nenhum scan nas duas semanas.

## Acompanhar e alertas
A estrela do card marca a oferta (fica salva no navegador). No topo do relatório, **Novidades das ofertas que
você acompanha** lista o que mudou nos últimos 30 dias: página nova, título novo, a mesma oferta em domínio novo,
o mesmo dono em domínio novo, troca de vídeo/produto, tag do Google Ads nova, mudança de tráfego, scans subindo
e subdomínio novo achado por certificado.

As estrelas ficam só naquele navegador. Para fixar uma lista (ou usar outro navegador), clique em
**Copiar lista** e cole no arquivo `acompanhar.txt` desta pasta, um domínio por linha. Os domínios desse
arquivo ficam sempre marcados e são os primeiros na vigia de certificados.

## Certificados (Certificate Transparency)
Todo site com HTTPS registra o certificado num log público no dia em que nasce. O minerador consulta esses
logs pelo CertSpotter para achar **subdomínios novos das ofertas conhecidas** (ex.: `order.x.com`, `vsl2.x.com`)
e só aceita os que têm player de VSL ou checkout de oferta no HTML. Rastreador sozinho (UTMify) não basta,
porque aparece também em cardápio e site institucional. Os achados ganham o selo "via certificado"; o print
vem do serviço grátis mShots (WordPress) até o urlscan escanear o domínio.

Limite grátis do CertSpotter: 10 domínios por hora. Por isso cada rodada vigia ~10 domínios, nesta ordem:
os do `acompanhar.txt`, os que rodam em vários domínios e os com mais scans na semana. Cada domínio é
vigiado de novo a cada 3 dias. O plano pago (US$ 50/mês, chave `CERTSPOTTER_API_KEY` no `.env`) sobe para 100.

Busca de domínios novos por palavra-chave ("gluco", "keto"...) não ficou viável de graça: o crt.sh é lento e
devolve resultados incompletos, e o CertStream público parou de transmitir. Numa VPS dá para rodar um servidor
CertStream próprio.

## Google Ads
Toda rodada faz uma busca extra: páginas com qualquer uma das assinaturas **e** a tag do Google Ads
(`googleads.g.doubleclick.net` / `googleadservices.com`). Essas ganham o selo **Google Ads** no relatório
(filtro e quadro próprios). O selo quer dizer que o dono anuncia **ou anunciou** no Google; para confirmar
se está rodando agora, use o botão "Anúncios Google" (Central de Transparência). Ofertas rastreadas só pela
UTMify/RedTrack, sem a tag do Google na página, não ganham o selo.

Os botões "Anúncios Meta" e "Anúncios Google" buscam pelo domínio principal (`allfeams.com`, não
`try.allfeams.com`), porque as bibliotecas de anúncios não acham pelo subdomínio.

## Tráfego
Não existe como ver o número exato de acessos de fora; o relatório mostra uma **faixa** de popularidade entre
usuários reais do Chrome nos últimos 28 dias (Chrome UX Report, do Google):

| nível | significa |
|---|---|
| Muito alto | top 100 mil sites |
| Alto | top 500 mil |
| Médio | top 1 milhão |
| Baixo | fora do top 1 milhão, mas com visitas suficientes para o Google medir |
| Sem dados | visitas abaixo do mínimo do Google |
| Não medido | fora do top 1 milhão e ainda não consultado (falta a chave abaixo) |

O top 1 milhão é baixado sozinho (1×/semana, pasta `cache/`). Para medir os sites menores e ver quanto do
tráfego vem de celular, crie a chave grátis da API do CrUX:

1. Entre em https://console.cloud.google.com com sua conta Google e crie um projeto (qualquer nome).
2. Em "APIs e serviços > Biblioteca", procure **Chrome UX Report API** e clique em **Ativar**.
3. Em "APIs e serviços > Credenciais", clique em **Criar credenciais > Chave de API** e copie a chave.
   (Opcional: em "Restringir chave", limite à Chrome UX Report API.)
4. Abra o arquivo `.env` desta pasta (se não existir, copie o `.env.example` com o nome `.env`) e cole na linha
   `CRUX_API_KEY=` a chave.

Não precisa de cartão. A primeira rodada com a chave consulta todos os domínios (~10 min); depois só os novos e
os ativos que não foram checados nos últimos 3 dias. Para atualizar sem buscar ofertas:
`npm run minerar -- --so-relatorio --trafego`.

## Chave do urlscan (recomendada, grátis)
Crie a conta em urlscan.io → Settings & API → New API key. Copie `.env.example` para `.env` e cole a chave em
`URLSCAN_API_KEY=`. Com ela, cada rodada lê o scan completo de até 200 domínios (`--detalhar N` muda o número):
links de checkout e IDs de scripts que o HTML puro não mostra. Sem chave: 30 buscas/min por IP e só o HTML.
Fontes e domínios de ruído ficam no topo do `minerador/minerador.mjs` e dá para editar.
