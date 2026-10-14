#!/bin/bash
# Roda o minerador e abre o relatório. Dois cliques no Finder.
cd "$(dirname "$0")" || exit 1

fechar() { echo; read -r -p "Aperte Enter para fechar esta janela."; exit "${1:-0}"; }

# Procura um Node 22.13+ (nodejs.org, Homebrew ou o que estiver no PATH).
acha_node() {
  for c in /usr/local/bin/node /opt/homebrew/bin/node "$(command -v node)" "$HOME"/.nvm/versions/node/*/bin/node; do
    [ -n "$c" ] && [ -x "$c" ] && "$c" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)' 2>/dev/null \
      && { echo "$c"; return 0; }
  done
  return 1
}

NODE="$(acha_node)"
if [ -z "$NODE" ]; then
  echo "Precisa do Node.js 22.13 ou mais novo (versão LTS de nodejs.org)."
  echo "Veja o passo 1 do COMO-INSTALAR-MAC.txt."
  fechar 1
fi
export PATH="$(dirname "$NODE"):$PATH"

# Primeira vez: instala as dependências e monta o relatório em React.
if [ ! -d node_modules ]; then
  echo "Instalando as dependências (só na primeira vez)..."
  npm install --no-audit --no-fund || fechar 1
fi
if [ ! -f dist/index.html ]; then
  echo "Montando o relatório (só na primeira vez)..."
  npm run build || fechar 1
fi

"$NODE" --no-warnings=ExperimentalWarning minerador/minerador.mjs "$@"
[ -f saida/relatorio.html ] && open saida/relatorio.html
fechar 0
