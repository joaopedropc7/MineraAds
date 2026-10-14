#!/bin/bash
# Desliga a rodada automática das 9h criada pelo agendar_9h.command.
PLIST="$HOME/Library/LaunchAgents/com.minerador.react.plist"
launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null
rm -f "$PLIST"
echo "Rodada automática desligada. O minerar.command continua funcionando normalmente."
echo
read -r -p "Aperte Enter para fechar esta janela."
