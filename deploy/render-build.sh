#!/usr/bin/env bash
# Build do Controle de Vagas no Render, no runtime nativo (sem Docker).
#
# O Render não tem runtime de .NET: o serviço é criado com o runtime "Node" e este script instala o SDK do .NET 10
# pelo instalador oficial da Microsoft. A publicação é self-contained (o runtime vai junto do executável em
# ./publish), então a execução não depende de nada instalado aqui — o Render só preserva a pasta do projeto entre o
# build e a execução.
#
# Como na aplicação financeira, a suíte de testes roda antes de publicar e o deploy depende dela.
# SKIP_TESTS=1 pula os testes (só para diagnóstico).
set -euo pipefail
cd "$(dirname "$0")/.."

export DOTNET_ROOT="${DOTNET_ROOT:-$HOME/.dotnet}"
export PATH="$DOTNET_ROOT:$PATH"
export DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1 DOTNET_SKIP_FIRST_TIME_EXPERIENCE=1

echo "[build] instalando o SDK do .NET 10 em $DOTNET_ROOT"
curl -sSL --retry 3 https://dot.net/v1/dotnet-install.sh -o /tmp/dotnet-install.sh
bash /tmp/dotnet-install.sh --channel 10.0 --install-dir "$DOTNET_ROOT" --no-path
dotnet --version

if [ "${SKIP_TESTS:-0}" != "1" ]; then
  echo "[build] testes"
  dotnet test backend/tests/VacancyControl.Tests/VacancyControl.Tests.csproj -c Release
fi

echo "[build] publicando a API (linux-x64, self-contained) em ./publish"
rm -rf publish
dotnet publish backend/src/VacancyControl.Api/VacancyControl.Api.csproj \
  -c Release -r linux-x64 --self-contained true -o publish
echo "[build] concluído"
