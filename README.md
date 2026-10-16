# Sistema de Controle de Vagas — Grupo ON LINE

Registra cada vaga demandada pelos clientes e mede, em **dias** e em **R$**, quanto tempo cada posto fica sem cobertura.
A especificação completa está em [docs/SPEC_controle_vagas.md](docs/SPEC_controle_vagas.md).

## Stack

No padrão da aplicação financeira (Compras e Pagamentos), que já roda no Render: **Node.js 24, módulos ESM, Express, SQL
escrito à mão, sem etapa de build e com três dependências de runtime** (`express`, `pg`, `multer`).

| Camada | Tecnologia |
|---|---|
| Front-end | JavaScript puro (módulos ESM nativos), sem framework e sem build, no padrão de front-end da aplicação financeira |
| API | Node.js 24 + Express 4 (REST, JSON), servindo também o front-end |
| Banco | PostgreSQL em produção; SQLite (`node:sqlite`) em desenvolvimento e testes — o mesmo SQL nos dois |
| E-mail | API do SendGrid via `fetch` nativo, com caixa de saída (outbox) e novas tentativas |
| Testes | `node --test` (domínio, API pelo HTTP real e montagem de cada tela), nos dois bancos |

## Estrutura

```
server.js                 partida resiliente (sobe sem banco, responde 503 e reconecta), sinais, log de configuração
src/
  app.js                  montagem do Express: middlewares e rotas; prepara o banco e os dados mínimos
  config.js               ÚNICO módulo que lê process.env (com leitor de .env) e as guardas de partida
  middleware.js           cookies, sessão, CSRF, cabeçalhos de segurança, limite de login e tratamento de erro
  routes/                 a camada HTTP (mesmas rotas e o mesmo JSON da API .NET anterior)
  services/               casos de uso: pedidos, posições, desligamentos, cadastros, usuários, painel, rotinas
  domain/                 regras puras: máquina de estados da posição, pedido, cálculos da seção 8, validações
  db/                     drivers (SQLite e PostgreSQL), schema.sql, migrações, unidade de trabalho e leituras
public/                   front-end: index.html, css/app.css, js/app.js, api.js, ui.js e views/ (uma tela por arquivo)
test/                     testes (node --test), DOM mínimo e o cliente HTTP dos testes
docs/                     especificação e guia de deploy
frontend/                 SPA Angular anterior — substituída pelo front em public/, aguardando remoção
```

- Direção das dependências: `routes → services → domain`, e `services → db`. O domínio não sabe de HTTP nem de SQL.
- **Unidade de trabalho** (`src/db/unit-of-work.js`): os serviços mudam objetos simples e chamam `save()`; ela grava
  numa transação, com o log de auditoria campo a campo e `WHERE version = ?` em todo UPDATE (409 se outra pessoa
  gravou antes).
- O front-end segue o `PADRAO-FRONT-END.md` da aplicação financeira: classes CSS em português, `ui.js` como única forma
  de criar DOM (sem `innerHTML`), roteamento por hash e erro de validação marcado no próprio campo (a API devolve
  `campos`). Identificadores de JavaScript em inglês (SPEC, seção 0).

## Configuração

Nenhuma credencial fica no código. Localmente, um arquivo `.env` (fora do Git; modelo em [.env.example](.env.example));
em produção, as variáveis de ambiente do serviço. `src/config.js` é o único lugar que lê o ambiente.

| Variável | Uso |
|---|---|
| `DATABASE_URL` | PostgreSQL (`postgresql://usuario:senha@host:5432/banco`). Sem ela, SQLite em `dados/` |
| `NODE_ENV` | `development` localmente (cookies sem `Secure`); vazio = `production` |
| `PORTA` / `PORT` | Porta HTTP (o Render informa `PORT`) |
| `BASE_URL` | Endereço público, usado nos links dos e-mails |
| `ADMIN_EMAIL` / `ADMIN_SENHA` | Primeiro ADMIN, criado se não houver nenhum (troca de senha obrigatória no 1º acesso) |
| `SENDGRID_ATIVO` / `SENDGRID_API_KEY` / `SENDGRID_REMETENTE` | E-mail; desligado, os e-mails só aparecem no log |
| `DADOS_DEMO` / `SENHA_DEMO` | Dados fictícios de demonstração (só desenvolvimento) |
| `PROXY_CONFIAVEL` | Confia em `X-Forwarded-*` (padrão: ligado no Render e no App Service) |

Os nomes da versão .NET (`ConnectionStrings__Default`, `App__BaseUrl`, `Seed__AdminEmail`, `Seed__AdminPassword`,
`SendGrid__*`) continuam aceitos, para não quebrar um serviço já configurado.

## Executar em desenvolvimento

```bash
npm ci
```

```bash
npm start
```

Com `NODE_ENV=development` no `.env`. Acesse http://localhost:5067: a própria API serve o front-end, na mesma origem.
Sem `DATABASE_URL`, os dados ficam em `dados/controle-vagas.db` (SQLite) e sobrevivem ao reinício; apague o arquivo para
começar do zero. Com `DADOS_DEMO=1` e `SENHA_DEMO`, um banco vazio recebe dados fictícios e um usuário por perfil.

Não há etapa de build: editar um arquivo em `public/` e recarregar a página basta (servidos com `Cache-Control: no-cache`).

## Banco de dados

`src/db/schema.sql` é a fonte única para os dois bancos (só tipos comuns; datas como texto ISO). As migrações rodam na
partida (`src/db/migrations.js`): criam o que falta, acrescentam colunas novas (`ADDED_COLUMNS`) e instalam os gatilhos
que tornam o log de auditoria somente inclusão e bloqueiam `DELETE` nas tabelas de negócio (RN-26). O backup diário
(seção 12) é responsabilidade da hospedagem.

## Testes

```bash
npm test
```

Domínio (máquina de estados e os casos T1–T12 da seção 8.7), a API de ponta a ponta pelo HTTP real e a montagem de cada
tela (DOM mínimo, sem navegador). Cada arquivo sobe a aplicação em porta efêmera com banco próprio, então rodam em
paralelo. Para rodar no PostgreSQL (cada arquivo cria e descarta um schema próprio):

```bash
DB_DRIVER=postgres DATABASE_URL=postgresql://usuario:senha@localhost:5432/banco_de_teste npm test
```

## Deploy

No Render, como Web Service Node (sem Docker): ver [docs/DEPLOY-RENDER.md](docs/DEPLOY-RENDER.md).

## Segurança

- Senha com no mínimo 8 caracteres, maiúscula, número e caractere especial (scrypt, salt por usuário, comparação em tempo
  constante). Bloqueio de 15 minutos após 5 tentativas e limite de 10 tentativas de login por minuto por IP.
- Sessão em tabela própria (no banco fica só o hash do token), cookie `HttpOnly`, `Secure` e `SameSite=Strict`,
  expirando após 30 minutos de inatividade. Perfil alterado ou usuário inativado valem na requisição seguinte.
  Proteção CSRF com o par `XSRF-TOKEN` / `X-XSRF-TOKEN`.
- Log de auditoria de toda criação, alteração, transição e correção, com valor anterior, valor novo, justificativa,
  usuário e IP; somente inclusão, garantido por gatilho no banco.

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
    desde o início desejado. O valor por cargo é o vigente no registro do pedido. Pedidos avulsos (D1) já nascem aprovados.
13. **Publicação no JobConvo no pedido:** o RH registra uma vez por pedido (publicado: código e data; não publicado: justificativa).
    Todas as posições abertas passam a "Em recrutamento"; as acrescentadas e as reposições confirmadas depois herdam.
    Atualizar a publicação reflete em todas as posições.
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
    (`position_evidences` com os metadados e `evidence_files` com o conteúdo, separados para migrar ao SharePoint). Download só para
    RH do pedido, NACC, DP e Gestor.
17. **Nome e matrícula do 1º dia bloqueados:** a confirmação do 1º dia não recebe nome nem matrícula; o servidor grava o
    nome do candidato selecionado e a matrícula da admissão (precisam existir). A matrícula é informada ou corrigida em
    `PUT /api/positions/{id}/admission-registration` (RH do pedido ou DP, só "Em admissão"); posição sem candidato
    (anterior à regra) recebe o candidato por `PUT /api/positions/{id}/candidate` (RH do pedido).
18. **Status da admissão:** novo status `AWAITING_FIRST_DAY` ("Aguardando 1º dia") = admissão concluída, com matrícula
    (informada na admissão ou depois, pelo RH do pedido ou DP); sem matrícula a posição fica "Em admissão". Só
    "Aguardando 1º dia" permite confirmar o 1º dia. "Candidato aprovado" passou a "Candidato selecionado" e o botão a
    "Adicionar Candidato".
19. **Reposição como ciclo da vaga:** a posição ganhou `slot_number` (vaga, fixo) e `cycle` (1 = vaga nova; 2+ =
    reposições); a reposição herda a vaga da origem. O pedido mostra uma linha por vaga (ciclo atual, `IsCurrentCycle`
    = sem desligamento) com "Ver histórico de ocupantes"; a lista de posições mostra só o ciclo atual, salvo
    `allCycles=true`. Status do pedido e "preenchidas" olham o ciclo atual. Cada ciclo mantém SLA, dias e valor próprios.
20. **Back-end em Node.js** (no lugar de .NET, por decisão do usuário em 16/10/2026), no padrão da aplicação financeira
    que já roda no Render: Express, SQL manuscrito, SQLite local e PostgreSQL em produção, sem build. As rotas e o JSON
    da API ficaram iguais, e o front-end não mudou. O banco PostgreSQL da versão .NET não é aproveitado: a aplicação
    recusa subir num banco com o schema anterior.
