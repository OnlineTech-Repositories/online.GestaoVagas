# Deploy no Render

Como publicar o Controle de Vagas no Render **sem Docker**, e por que cada ajuste existe. Os ajustes seguem a
aplicação financeira (Compras e Pagamentos), que já roda no Render: `PADRAO-BACK-END.md` e `ARQUITETURA-TECNICA.md`.

## 1. O que mudava entre as duas aplicações

| Ponto | Aplicação financeira (em produção) | Controle de Vagas (antes) | Efeito no Render | Ajuste |
|---|---|---|---|---|
| Runtime | Node 24, nativo no Render | .NET 10, sem runtime nativo no Render | O serviço criado como "Node" não tinha como compilar nem executar a API | `deploy/render-build.sh` instala o SDK do .NET e publica **self-contained** (runtime junto do executável); `deploy/render-start.sh` executa |
| Porta | `PORT`, em `0.0.0.0` | `localhost:5000`/`8080` | O Render não encontrava a porta e o deploy expirava | A API lê `PORT` (`HostingSettings.ApplyPort`) |
| Proxy (HTTPS) | `trust proxy` vindo de configuração | Ignorava `X-Forwarded-*` | Com o cookie `Secure` exigido, **todo GET em `/api` respondia 500**, inclusive `/api/saude`; o limite de login e a auditoria viam o IP do proxy | Proxy confiável quando a variável `RENDER` existe (`Proxy__Trusted` sobrepõe); o token CSRF não é emitido numa requisição HTTP que não passou pelo proxy (o health check interno) |
| Conexão com o banco | `POSTGRES_URL` **ou** `PG*` | Só `Host=...;Database=...` | O Render entrega URL `postgresql://...`; desmontá-la à mão quebrava com caractere especial na senha | Aceita a URL como está, em `ConnectionStrings__Default` ou `DATABASE_URL` (`PostgresConnection`) |
| Banco na partida | Sobe de qualquer forma: 503 com o motivo e reconexão a cada 30 s | Sem banco, a API encerrava | Ciclo de reinício sem o motivo visível | `DatabaseStartupService` + `DatabaseReadinessMiddleware`: 503 com o destino (sem a senha) e o erro, nova tentativa a cada 30 s |
| Migrations | Rodam sempre na subida | Padrão `false` fora de Development | Banco vazio se a variável fosse esquecida | Padrão `true` (`Database__MigrateOnStartup=false` desliga) |
| Disco efêmero | Recusa subir com banco local em Render/App Service | Aceitava banco em memória | Dados apagados a cada deploy ou quando o serviço adormece | Recusa `Database__Provider=InMemory` em plataforma, salvo `Database__AllowEphemeral=true` (só demonstração) |
| Sessão | Tabela `sessoes` no banco | Chaves do cookie no disco do processo | Todos deslogados a cada deploy e a cada vez que o plano gratuito adormece | Chaves do Data Protection no banco (tabela `data_protection_keys`, migration `DataProtectionKeys`) |
| Log de partida | Configuração + alertas de proteção desligada | Nenhum | Configuração errada só aparecia como erro adiante | Linha de configuração (sem senha) e `ALERTA:` para cada proteção desligada |
| Testes antes de publicar | `npm test` no pipeline | — | — | `render-build.sh` roda a suíte .NET; falhou, não publica |

Não mudou: a stack obrigatória da SPEC (.NET, PostgreSQL, EF Core, SendGrid), as regras de negócio, o front-end e a API.

## 2. Configuração do serviço

**Banco:** crie um PostgreSQL no Render, **na mesma região** do Web Service, e copie a **Internal Database URL**.

**Web Service** (conectado ao repositório no GitHub, branch `main`):

| Campo | Valor |
|---|---|
| Language | `Node` (o Node não é usado; é o runtime nativo que permite rodar o script de build) |
| Root Directory | vazio |
| Build Command | `bash deploy/render-build.sh` |
| Start Command | `bash deploy/render-start.sh` |
| Health Check Path | `/api/saude` |

**Environment Variables:** use o botão *Add from .env* com o conteúdo de `deploy/render.env.example`, trocando o que
está entre `<...>`. O mínimo:

| Variável | Valor |
|---|---|
| `ConnectionStrings__Default` | a Internal Database URL, colada como está |
| `App__BaseUrl` | `https://<servico>.onrender.com` |
| `Seed__AdminEmail` / `Seed__AdminPassword` | primeiro ADMIN; senha provisória com 8+ caracteres, maiúscula, número e especial |
| `SendGrid__Enabled` | `false` até ter a chave (`SendGrid__ApiKey`, `SendGrid__FromEmail`) |

Não são mais necessárias: `ASPNETCORE_HTTP_PORTS`, `ASPNETCORE_FORWARDEDHEADERS_ENABLED`, `Database__MigrateOnStartup`.
O Render define `RENDER` e `PORT`, e a API se ajusta por elas.

## 3. Conferência depois do deploy

1. No log, a linha `Controle de Vagas 1.0.0 | ambiente Production | plataforma Render | proxy confiável sim | banco ...`
   e, logo depois, `Banco pronto`. Cada `ALERTA:` acima dela é uma proteção desligada.
2. `https://<servico>.onrender.com/api/saude` responde `{"status":"ok","versao":"1.0.0"}`.
3. Login com o ADMIN inicial, troca de senha obrigatória e navegação pelas telas.
4. Novo deploy (ou *Restart*): a sessão continua aberta.

No primeiro deploy, uma linha `fail: ... SELECT migration_id ... FROM __ef_migrations_history` é esperada: é o EF
Core verificando se o banco já tem migrations.

## 4. Problemas conhecidos

| Sintoma | Causa | Saída |
|---|---|---|
| 503 "Banco de dados indisponível (...)" | URL errada, banco em outra região ou ainda criando | Corrigir a variável; a API tenta de novo sozinha a cada 30 s |
| A API não sobe: "Database__Provider=InMemory em Render" | Banco em memória numa plataforma de disco efêmero | Configurar o PostgreSQL |
| A API não sobe: "Falha ao criar o ADMIN inicial" | Senha provisória fora da política | Trocar `Seed__AdminPassword` |
| Log: "libicu não encontrada" | Imagem sem a biblioteca de globalização | A API segue em modo invariante; nada a fazer |
| Primeiro acesso lento | Plano gratuito adormece após inatividade | Esperado; a rotina diária recupera os dias perdidos ao acordar |

O PostgreSQL gratuito do Render expira em 30 dias e não tem backup: para uso real, plano pago (a seção 12 da SPEC
exige backup diário).

## 5. Validação local feita antes da publicação

Executada na API publicada em modo Production, simulando o Render (`RENDER` e `PORT` definidos, requisições com
`X-Forwarded-Proto: https`), contra um PostgreSQL 17 vazio:

- todas as migrations aplicadas num banco novo (era a primeira vez num PostgreSQL real: até aqui só o banco em memória);
- `/api/saude` responde 200 com e sem o cabeçalho do proxy; cookies `Secure`, `HttpOnly`, `SameSite=Strict`;
- login do ADMIN inicial, bloqueio até a troca de senha, troca com CSRF, POST sem CSRF recusado, listagens;
- sessão e token CSRF continuam válidos depois de reiniciar a API;
- sem banco: 503 com o motivo e sem a senha; banco religado, a API volta sem reiniciar;
- banco em memória com `RENDER` definido: a API recusa subir;
- publicação `linux-x64` self-contained gerada; testes .NET (92) e de telas (16) passando.

Não testado aqui: o build dentro do Render (download do SDK) e a execução em Linux, que só o deploy confirma.
