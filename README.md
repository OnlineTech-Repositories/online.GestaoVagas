# Sistema de Controle de Vagas — Grupo ON LINE

Registra cada vaga demandada pelos clientes e mede, em **dias** e em **R$**, quanto tempo cada posto fica sem cobertura.
A especificação completa está em [docs/SPEC_controle_vagas.md](docs/SPEC_controle_vagas.md).

## Stack

| Camada | Tecnologia |
|---|---|
| Front-end | JavaScript puro (módulos ESM nativos), sem framework e sem build, no padrão de front-end da aplicação financeira |
| API | .NET 10 / ASP.NET Core (controllers REST, JSON, HTTPS) |
| Banco | PostgreSQL + Entity Framework Core 10 (Npgsql, nomes em snake_case) |
| E-mail | SendGrid, atrás da interface `IEmailSender` e com caixa de saída (outbox) |

## Estrutura (3 camadas)

```
backend/
  src/VacancyControl.Api             Presentation: controllers, autenticação (cookie), CSRF, erros (ProblemDetails)
  src/VacancyControl.Application     Business: entidades, máquina de estados, cálculos (seção 8), serviços e regras
  src/VacancyControl.Infrastructure  Data: EF Core/PostgreSQL, repositórios, auditoria, Identity, SendGrid, rotina diária
  src/VacancyControl.Api/wwwroot     Front-end: index.html, css/app.css, js/app.js, api.js, ui.js e views/ (uma tela por arquivo)
  tests/VacancyControl.Tests         Testes T1–T12 da seção 8.7 e da máquina de estados
  tests/frontend                     Teste de telas sem navegador (dom-minimo.js + screens.test.js)
frontend/                            SPA Angular anterior — substituída pelo front em wwwroot, aguardando remoção
docs/                                Especificação
```

- A camada **Application** não conhece o EF Core: acessa dados por interfaces de repositório, implementadas na Infrastructure.
- As funções de cálculo (`PositionCalculator`) são puras e as transições de status ficam na entidade `Position`.
- A autorização é verificada **no backend** em toda ação: perfil (matriz 4.1) + status da posição (seção 6).
- O front-end segue o `PADRAO-FRONT-END.md` da aplicação financeira: mesma folha de estilo (classes em português),
  `ui.js` como única forma de criar DOM (sem `innerHTML`), roteamento por hash, nenhuma tela importando outra e erro de
  validação marcado no próprio campo (a API devolve `campos` no ProblemDetails). Identificadores de JavaScript em inglês (SPEC, seção 0).

## Configuração

Nenhuma credencial fica no código. Em desenvolvimento, use **user-secrets**; em produção, **variáveis de ambiente**
(o separador de seção é `__`, por exemplo `ConnectionStrings__Default`).

| Chave | Uso |
|---|---|
| `ConnectionStrings:Default` | Conexão PostgreSQL: `Host=...;Database=...` ou a URL `postgresql://...` (também lida de `DATABASE_URL`) |
| `SendGrid:ApiKey` / `SendGrid:FromEmail` | Envio de e-mails (com `SendGrid:Enabled=false`, só registra em log) |
| `Seed:AdminEmail` / `Seed:AdminPassword` | Cria o primeiro ADMIN se não houver nenhum (troca de senha obrigatória no 1º acesso) |
| `App:BaseUrl` | URL da aplicação, usada nos links dos e-mails (`<BaseUrl>/#/posicoes/<id>`) |
| `App:AllowedOrigins` | Origens permitidas no CORS (só quando front e API estão em origens diferentes) |
| `Database:MigrateOnStartup` | Aplica as migrations ao subir (padrão: `true`) |
| `PORT` | Porta informada pela plataforma; a API escuta em `0.0.0.0:<PORT>` |
| `Proxy:Trusted` | Confia em `X-Forwarded-For/Proto` (padrão: `true` quando `RENDER` ou `WEBSITE_SITE_NAME` existem) |
| `Database:AllowEphemeral` | Permite banco em memória no Render/App Service (só demonstração; padrão: recusa subir) |

```bash
cd backend/src/VacancyControl.Api
dotnet user-secrets set "ConnectionStrings:Default" "Host=localhost;Database=controle_vagas;Username=...;Password=..."
dotnet user-secrets set "Seed:AdminEmail" "admin@empresa.com.br"
dotnet user-secrets set "Seed:AdminPassword" "<senha forte provisória>"
dotnet user-secrets set "SendGrid:ApiKey" "<api key>"
dotnet user-secrets set "SendGrid:FromEmail" "nao-responda@empresa.com.br"
```

## Avaliação local sem PostgreSQL

Em `Development`, `Database:Provider = InMemory` usa um banco em memória e `Seed:DemoData = true` cria dados fictícios e
um usuário por perfil. Os dados voltam ao estado inicial sempre que a API reinicia. As senhas vêm de
`Seed:AdminPassword` e `Seed:DemoPassword` (variáveis de ambiente/user-secrets). Para usar o PostgreSQL, defina
`Database:Provider = PostgreSQL` e a connection string.

## Deploy

No Render, sem Docker: ver [docs/DEPLOY-RENDER.md](docs/DEPLOY-RENDER.md) (configuração do serviço, variáveis e
conferência pós-deploy). Sem banco, a API sobe mesmo assim e responde 503 com o motivo, tentando reconectar a cada 30 s.

## Executar em desenvolvimento

```bash
dotnet run --project backend/src/VacancyControl.Api --launch-profile http
```

Acesse http://localhost:5067: a própria API serve o front-end (`wwwroot`), na mesma origem, sem CORS e sem servidor
de front separado. Localmente roda sem HTTPS; fora de Development os cookies exigem HTTPS. A documentação da API fica
em http://localhost:5067/swagger.

Não há etapa de build do front: editar um arquivo em `wwwroot` e recarregar a página basta (os arquivos são servidos
com `Cache-Control: no-cache`). Publicar é copiar arquivos — o `dotnet publish` já leva o `wwwroot`.

## Banco de dados

```bash
dotnet ef migrations add <Nome> -p backend/src/VacancyControl.Infrastructure -s backend/src/VacancyControl.Api -o Persistence/Migrations
```

```bash
dotnet ef database update -p backend/src/VacancyControl.Infrastructure -s backend/src/VacancyControl.Api
```

O banco também se protege sozinho: um trigger torna `audit_logs` somente inclusão e outros triggers bloqueiam `DELETE`
nas tabelas de negócio (RN-26). O backup diário (seção 12) é responsabilidade da infraestrutura de hospedagem.

## Testes

```bash
dotnet test backend
```

Teste de telas (monta cada tela de verdade contra a API em execução, com dados de demonstração):

```bash
node --test "backend/tests/frontend/*.test.js"
```

Exige a variável `DEMO_PASSWORD` (senha dos usuários de demonstração) e a API em `http://localhost:5067`
(ou em `API_URL`). Sem elas, os testes são marcados como ignorados.

## Segurança

- Senha com no mínimo 8 caracteres, maiúscula, número e caractere especial (hash PBKDF2 do ASP.NET Core Identity).
  Bloqueio de 15 minutos após 5 tentativas e limite de 10 tentativas de login por minuto por IP.
- Sessão em cookie `HttpOnly`, `Secure` e `SameSite=Strict`, expirando após 30 minutos de inatividade.
  Proteção CSRF com o par `XSRF-TOKEN` / `X-XSRF-TOKEN`.
- Usuário inativado ou com perfil alterado perde a sessão em até 1 minuto.
- AuditLog de toda criação, alteração, transição e correção, com valor anterior, valor novo, justificativa, usuário e IP.

## Decisões assumidas (confirmar com a Controladoria)

Pontos sem regra explícita na SPEC, implementados com o padrão abaixo:

1. **Data de registro editável** no pedido e no desligamento: padrão hoje; pode ser retroativa durante a carga inicial
   ou, depois dela, com justificativa (RN-24). Ela é a base do tempo de cadastro, do tempo de comunicação e da abertura de vaga nova.
2. **Carga inicial:** o NACC pode criar pedidos enquanto `INITIAL_LOAD_OPEN = true` (seção 13). Depois, só o COMMERCIAL.
3. **Aumento de quantidade (RN-05):** as novas posições têm a própria data de início desejada e abrem na data do acréscimo.
4. **Pausa ativa** é encerrada automaticamente quando a posição é cancelada ou encerrada pelo job.
5. **Valor da reposição** herda o valor da posição de origem (RN-14).
6. **Valor rejeitado** pode ser corrigido pelo COMMERCIAL e volta para "Pendente". Valor validado não se altera; cadastra-se nova versão.
7. **Sem valor cadastrado:** a posição mostra "Sem valor cadastrado" e fica fora dos totais. Se o valor for cadastrado depois com
   vigência anterior à abertura, as posições abertas sem valor passam a usá-lo.
8. **Rotina diária** roda de segunda a sexta (sem calendário de feriados) e recupera os dias perdidos; a data de encerramento por fim
   de vigência não depende do dia em que o job rodou.
9. **Datas futuras** são bloqueadas para marcos, exceto o último dia trabalhado (RN-13).
10. **Anexo de evidência no SharePoint (D4)** não foi implementado (fora das fases 1–3; parâmetro `REQUEST_EVIDENCE_REQUIRED = false`).
11. **E-mail via SendGrid**, conforme as diretrizes técnicas do projeto (a SPEC citava Microsoft 365).
12. **Aprovação do cliente:** todo pedido nasce "Aguardando aprovação do cliente"; o Comercial ou a Controladoria registra a
    aprovação (data informada, padrão hoje; retroativa exige justificativa) ou "Cliente não aprovou" (encerra as posições sem perda).
    O RH avança só até "Em recrutamento" antes da aprovação; o SLA começa na data da aprovação e os dias descobertos/R$ contam
    desde o início desejado. O valor por cargo é o vigente no registro do pedido. Pedidos avulsos (D1) e os já existentes na
    migração `OrderApproval` ficam aprovados.
13. **Publicação no JobConvo no pedido:** o RH registra uma vez por pedido (publicado: código e data; não publicado: justificativa).
    Todas as posições abertas passam a "Em recrutamento"; as acrescentadas e as reposições confirmadas depois herdam.
    Atualizar a publicação reflete em todas as posições. A migração `OrderJobconvoPublication` leva para o pedido o código
    da primeira posição que entrou em recrutamento.
14. **Perfis de RH e responsáveis pelo pedido:** novo perfil `RH_MANAGER` (Gestor de RH); `RH` passa a ser o Analista de RH.
    O Gestor de RH define os analistas responsáveis do pedido (histórico com remoção lógica, tabela `order_rh_analysts`);
    o analista executa o recrutamento só nos pedidos atribuídos, e o Gestor de RH em qualquer pedido. Quem entra ou sai
    da equipe é avisado; os avisos ao RH sobre o pedido vão para os responsáveis e os gestores de RH. Pedido com posição
    aberta e sem responsável fica "Aguardando atribuição do RH".
15. **Candidato selecionado por posição:** "Aprovar candidato" registra nome, nascimento (não futuro), sexo e CPF
    (dígitos verificadores) na tabela `candidates`, um candidato ativo por posição; o mesmo CPF não pode estar em duas
    posições abertas. O RH do pedido corrige os dados (quem e quando no cadastro e no log de auditoria). Desistência e não
    comparecimento guardam o candidato como anterior. CPF, nascimento e sexo completos só para o RH do pedido, NACC e DP;
    os demais veem o nome e o CPF mascarado, inclusive no histórico.
16. **Confirmação do 1º dia com evidência:** a admissão aceita a matrícula (opcional), que preenche a confirmação do
    1º dia junto com o nome do candidato. A justificativa do 1º dia é obrigatória; a evidência (PDF, JPG ou PNG até
    10 MB, tipo conferido pelo conteúdo) vai em multipart/form-data na mesma requisição e fica no banco
    (`position_evidences` + `evidence_files`, atrás de `IEvidenceStorage` para migrar ao SharePoint). Download só para
    RH do pedido, NACC, DP e Gestor.
17. **Nome e matrícula do 1º dia bloqueados:** a confirmação do 1º dia não recebe nome nem matrícula; o servidor grava o
    nome do candidato selecionado e a matrícula da admissão (precisam existir). A matrícula é informada ou corrigida em
    `PUT /api/positions/{id}/admission-registration` (RH do pedido ou DP, só "Em admissão"); posição sem candidato
    (anterior à regra) recebe o candidato por `PUT /api/positions/{id}/candidate` (RH do pedido).
18. **Status da admissão:** novo status `AWAITING_FIRST_DAY` ("Aguardando 1º dia") = admissão concluída, com matrícula
    (informada na admissão ou depois, pelo RH do pedido ou DP); sem matrícula a posição fica "Em admissão". Só
    "Aguardando 1º dia" permite confirmar o 1º dia. "Candidato aprovado" passou a "Candidato selecionado" e o botão a
    "Adicionar Candidato". A migração `PositionAwaitingFirstDay` converte as posições em admissão que já têm matrícula.
19. **Reposição como ciclo da vaga:** a posição ganhou `slot_number` (vaga, fixo) e `cycle` (1 = vaga nova; 2+ =
    reposições); a reposição herda a vaga da origem. O pedido mostra uma linha por vaga (ciclo atual, `IsCurrentCycle`
    = sem desligamento) com "Ver histórico de ocupantes"; a lista de posições mostra só o ciclo atual, salvo
    `allCycles=true`. Status do pedido e "preenchidas" olham o ciclo atual. Cada ciclo mantém SLA, dias e valor próprios.
    A migração `PositionSlots` renumera as vagas e encadeia as reposições existentes.
