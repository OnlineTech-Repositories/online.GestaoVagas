# Imagem da API + front-end (wwwroot) para hospedagem em container (ex.: Render, runtime Docker).
# Configuração (connection string, seed do ADMIN, SendGrid etc.) vem de variáveis de ambiente — ver README.

# ---------------------------------------------------------------- build
FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src

# Restaura primeiro só com os .csproj para aproveitar o cache de camadas.
COPY backend/src/VacancyControl.Application/VacancyControl.Application.csproj backend/src/VacancyControl.Application/
COPY backend/src/VacancyControl.Infrastructure/VacancyControl.Infrastructure.csproj backend/src/VacancyControl.Infrastructure/
COPY backend/src/VacancyControl.Api/VacancyControl.Api.csproj backend/src/VacancyControl.Api/
RUN dotnet restore backend/src/VacancyControl.Api/VacancyControl.Api.csproj

COPY backend/src/ backend/src/
RUN dotnet publish backend/src/VacancyControl.Api/VacancyControl.Api.csproj -c Release -o /app --no-restore

# ---------------------------------------------------------------- runtime
FROM mcr.microsoft.com/dotnet/aspnet:10.0
WORKDIR /app

# "Hoje" é calculado no fuso America/Sao_Paulo (SPEC, seção 0): garante a base de fusos horários no container.
RUN apt-get update \
    && apt-get install -y --no-install-recommends tzdata \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /app .

# O Render encaminha o tráfego para a porta 10000 (variável PORT padrão).
ENV ASPNETCORE_HTTP_PORTS=10000
EXPOSE 10000

USER $APP_UID
ENTRYPOINT ["dotnet", "VacancyControl.Api.dll"]
