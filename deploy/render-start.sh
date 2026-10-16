#!/usr/bin/env bash
# Execução do Controle de Vagas no Render (runtime nativo). A porta vem da variável PORT, lida pela própria API.
set -euo pipefail
cd "$(dirname "$0")/.."

# O .NET usa a libicu do sistema para globalização e encerra na partida se ela faltar. A API não depende de cultura
# (datas e números são formatados no front-end e com InvariantCulture no servidor); sem a libicu, segue em modo
# invariante em vez de não subir.
if ! ls /usr/lib/x86_64-linux-gnu/libicuuc.so.* /usr/lib64/libicuuc.so.* /usr/lib/libicuuc.so.* >/dev/null 2>&1; then
  echo "[partida] libicu não encontrada: usando globalização invariante"
  export DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1
fi

exec ./publish/VacancyControl.Api
