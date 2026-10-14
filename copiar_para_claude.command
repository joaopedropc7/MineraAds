#!/bin/bash
# Copia o resumo das ofertas para colar no Claude.
cd "$(dirname "$0")" || exit 1
if [ ! -f saida/para_claude.txt ]; then
  echo "Ainda não tem resumo. Rode o minerar.command primeiro."
else
  LANG=en_US.UTF-8 pbcopy < saida/para_claude.txt
  echo "Copiado! Abra o Claude e cole com Cmd+V."
fi
sleep 3
