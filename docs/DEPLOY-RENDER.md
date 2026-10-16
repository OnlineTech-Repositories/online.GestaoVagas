# Deploy no Render

O Controle de Vagas roda no Render como **Web Service Node**, sem Docker, no mesmo modelo da aplicação financeira
(Compras e Pagamentos), que já está em produção ali.

## 1. Por que Node

A primeira versão era .NET. O Render não tem runtime .NET nativo, e o caminho sem Docker exigia instalar o SDK a cada
build. A aplicação foi reescrita em Node.js 24 + Express, no padrão de `PADRAO-BACK-END.md`. As regras, as rotas e o
JSON da API são os mesmos, e o front-end não mudou.

| Ponto | Como ficou |
|---|---|
| Runtime | Node 24 (`engines` no package.json e `.node-version`), nativo no Render |
| Build | `npm ci`: quatro dependências de runtime (`express`, `pg`, `multer`, `nodemailer`), sem etapa de build |
| Porta | Lida de `PORT`, que o Render define (10000), escutando em `0.0.0.0` |
| HTTPS atrás do proxy | Proxy confiável detectado pela variável `RENDER`: cookies `Secure` e IP real na auditoria |
| Banco | PostgreSQL por `DATABASE_URL`, a URL que o Render entrega, colada como está |
| Migrações | Na partida, idempotentes (`src/db/migrations.js`): o push basta para publicar mudança de estrutura |
| Sem banco | O servidor sobe mesmo assim, responde 503 com o motivo (sem a senha) e tenta reconectar a cada 30 s |
| Disco efêmero | Nada fica em disco: sessões, evidências e dados no PostgreSQL. SQLite no Render é recusado na partida |
| Log de partida | Versão, ambiente, banco (sem senha), proxy e e-mail, com um `ATENÇÃO` para cada proteção desligada |

## 2. Configuração do serviço

**Banco:** um PostgreSQL do Render, **na mesma região** do Web Service. Use a **Internal Database URL**.

> O banco usado pela tentativa com .NET não serve: a versão Node usa outro schema e recusa subir num banco que tenha a
> tabela `__ef_migrations_history`. Crie um banco novo, ou apague o anterior se ele não tiver dados reais.

**Web Service** (repositório no GitHub, branch `main`):

| Campo | Valor |
|---|---|
| Language | `Node` |
| Root Directory | vazio |
| Build Command | `npm ci` |
| Start Command | `npm start` |
| Health Check Path | `/api/saude` |

**Environment Variables:**

| Variável | Valor |
|---|---|
| `DATABASE_URL` | a Internal Database URL do banco, colada como está |
| `BASE_URL` | `https://<servico>.onrender.com` (links dos e-mails) |
| `ADMIN_EMAIL` / `ADMIN_SENHA` | o primeiro ADMIN; a senha é provisória: 8+ caracteres, maiúscula, número e especial |
| `SMTP_ATIVO` | `true` com `SMTP_HOST=smtp.mailersend.net`, `SMTP_PORTA=587`, `SMTP_SEGURO=false`, `SMTP_USUARIO`, `SMTP_SENHA` e `SMTP_REMETENTE` (`Nome <e-mail>` de domínio verificado no MailerSend) |

**Variáveis antigas:** as da configuração anterior podem ficar, porque os nomes da versão .NET continuam aceitos
(`ConnectionStrings__Default`, `App__BaseUrl`, `Seed__AdminEmail`, `Seed__AdminPassword`, `SendGrid__*`). As que não
têm efeito podem ser apagadas: `ASPNETCORE_*` e `Database__*`. Não defina `NODE_ENV`, porque o padrão já é
`production`.

**Script do banco (opcional):** a aplicação cria e atualiza a estrutura sozinha na partida. Para preparar o banco
antes do deploy, ou conferir a estrutura, execute `producao/criar-banco-postgres.sql` com a **External Database URL**
(a interna só é acessível de dentro do Render), a partir da raiz do repositório:

```bash
psql "<External Database URL>" -v ON_ERROR_STOP=1 -f producao/criar-banco-postgres.sql
```

O script serve para banco novo e para atualização: não apaga nem altera dados, roda numa transação e recusa o banco da
versão .NET. O primeiro ADMIN e os parâmetros padrão são criados pela aplicação na primeira partida.

**Usuários (opcional):** além da tela de Administração, os usuários podem ser criados da sua máquina, apontando para o
banco do Render pela External Database URL:

```bash
DATABASE_URL="<External Database URL>" npm run usuarios -- criar --nome "Maria Silva" --email maria@empresa.com.br --perfis NACC,DP
```

No PowerShell, defina antes `$env:DATABASE_URL = "<External Database URL>"` e rode o `npm run usuarios -- ...`. A senha
provisória gerada aparece uma única vez, e o usuário a troca no primeiro acesso.

## 3. Conferência depois do deploy

1. No log, o bloco "Controle de Vagas — Grupo ON LINE" deve mostrar `plataforma Render`, o banco PostgreSQL (sem a
   senha), `Estado: operando` e `Proxy: confiável`. Cada `ATENÇÃO:` é uma proteção desligada.
2. `https://<servico>.onrender.com/api/saude` responde `{"status":"ok","versao":"1.0.0"}`.
3. Faça login com o ADMIN inicial, troque a senha obrigatoriamente e navegue pelas telas.
4. Faça um novo deploy ou um *Restart*: a sessão continua aberta, porque fica no banco.

## 4. Problemas conhecidos

| Sintoma | Causa | Saída |
|---|---|---|
| 503 "Banco de dados indisponível (...)" | URL errada, banco em outra região ou ainda sendo criado | Corrigir a variável; a reconexão é automática a cada 30 s |
| 503 "criado pela versão .NET" | `DATABASE_URL` aponta para o banco da tentativa anterior | Usar um banco novo |
| O serviço não sobe: "SQLite em Render" | `DATABASE_URL` ausente | Configurar o PostgreSQL |
| O serviço não sobe: "Falha ao criar o ADMIN inicial" | Senha provisória fora da política | Trocar `ADMIN_SENHA` |
| Primeiro acesso lento | O plano gratuito adormece depois de um tempo sem uso | Esperado. A rotina diária recupera os dias perdidos ao acordar |

O PostgreSQL gratuito do Render expira em 30 dias e não tem backup. Para uso real é preciso um plano pago, porque a
seção 12 da SPEC exige backup diário.

## 5. Validação local feita antes da publicação

- **`npm test`:** 114 testes, todos passando no SQLite e no PostgreSQL 17. Cobrem a máquina de estados e os casos T1–T12
  da seção 8.7, a API de ponta a ponta pelo HTTP real e a montagem das telas.
- **API de ponta a ponta:** segurança, fluxo completo da vaga até a reposição, evidência do 1º dia, LGPD, concorrência
  (409), gatilhos do banco e rotina diária.
- **Telas:** as 16 que existiam contra a API .NET passam iguais contra a API Node.
- **Simulação do Render:** a partida foi testada com as variáveis `RENDER` e `PORT` e o proxy. Ainda não foi testado o
  build no próprio Render, que só o deploy confirma.
