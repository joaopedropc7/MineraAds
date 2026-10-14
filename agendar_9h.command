#!/bin/bash
# Agenda o minerador para rodar sozinho todo dia às 9h (agendador do macOS, launchd).
# Se o Mac estiver dormindo às 9h, roda assim que ele acordar.
cd "$(dirname "$0")" || exit 1
PASTA="$(pwd)"
ROTULO="com.minerador.react"
PLIST="$HOME/Library/LaunchAgents/$ROTULO.plist"

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
  echo "Precisa do Node.js 22.13 ou mais novo, instalado pelo nodejs.org (passo 1 do COMO-INSTALAR-MAC.txt)."
  fechar 1
fi

# O macOS não deixa tarefas automáticas mexerem nessas pastas.
case "$PASTA" in
  "$HOME/Documents"*|"$HOME/Desktop"*|"$HOME/Downloads"*|"$HOME/Library/Mobile Documents"*)
    echo "O macOS bloqueia tarefas automáticas em Documentos, Mesa, Downloads e iCloud."
    echo "Arraste a pasta minerador_react para a sua pasta de usuário (a da casinha,"
    echo "$HOME) e rode este agendar_9h.command de novo de lá."
    fechar 1;;
esac

if [ ! -f dist/index.html ]; then
  echo "Rode o minerar.command uma vez antes de agendar (ele monta o relatório)."
  fechar 1
fi

xml() { sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }
NODE_XML="$(printf '%s' "$NODE" | xml)"
PASTA_XML="$(printf '%s' "$PASTA" | xml)"

mkdir -p "$HOME/Library/LaunchAgents" "$PASTA/saida"
cat > "$PLIST" <<FIM
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$ROTULO</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>-c</string>
    <string>exec "\$0" --no-warnings=ExperimentalWarning minerador/minerador.mjs &gt; saida/ultimo_log.txt 2&gt;&amp;1</string>
    <string>$NODE_XML</string>
  </array>
  <key>WorkingDirectory</key><string>$PASTA_XML</string>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>9</integer><key>Minute</key><integer>0</integer></dict>
</dict>
</plist>
FIM

launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null
if launchctl bootstrap "gui/$(id -u)" "$PLIST"; then
  echo "Pronto! O minerador vai rodar sozinho todo dia às 9h."
  echo "A saída de cada rodada fica em saida/ultimo_log.txt."
  echo "Para desligar, dê dois cliques em remover_agendamento.command."
else
  echo "Não consegui agendar."
fi
fechar 0
