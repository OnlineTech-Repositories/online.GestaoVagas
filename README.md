# Sistema de Controle de Vagas — Grupo ON LINE

Registra cada vaga demandada pelos clientes e mede, em **dias** e em **R$**, quanto tempo cada posto fica sem cobertura.
A especificação completa está em [docs/SPEC_controle_vagas.md](docs/SPEC_controle_vagas.md).

## Stack

No padrão da aplicação financeira (Compras e Pagamentos), que já roda no Render: **Node.js 24, módulos ESM, Express, SQL
escrito à mão, sem etapa de build e com quatro dependências de runtime** (`express`, `pg`, `multer`, `nodemailer`).

| Camada | Tecnologia |
|---|---|
| Front-end | JavaScript puro (módulos ESM nativos), sem framework e sem build, no padrão de front-end da aplicação financeira |
| API | Node.js 24 + Express 4 (REST, JSON), servindo também o front-end |
| Banco | PostgreSQL em produção; SQLite (`node:sqlite`) em desenvolvimento e testes — o mesmo SQL nos dois |
| E-mail | SMTP (`nodemailer`, como na aplicação financeira) ou a API do MailerSend/SendGrid via `fetch`, com caixa de saída (outbox) e novas tentativas |
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
| `BASE_URL` (ou `URL_BASE`) | Endereço público, usado nos links dos e-mails |
| `ADMIN_EMAIL` / `ADMIN_SENHA` | Primeiro ADMIN, criado se não houver nenhum (troca de senha obrigatória no 1º acesso) |
| `SMTP_ATIVO` (ou `EMAIL_ATIVO`) | Liga o e-mail; desligado, os e-mails só aparecem no log |
| `SMTP_HOST` / `SMTP_PORTA` / `SMTP_SEGURO` | Servidor SMTP (MailerSend: `smtp.mailersend.net`, `587`, `false` = STARTTLS, que é exigido) |
| `SMTP_USUARIO` / `SMTP_SENHA` | Credenciais SMTP (no MailerSend, as do domínio verificado) |
| `SMTP_REMETENTE` (ou `EMAIL_REMETENTE`) | `Nome <email@dominio>` ou só o e-mail; precisa ser de domínio verificado no provedor |
| `MAILERSEND_API_KEY` / `EMAIL_PROVEDOR` | Alternativa ao SMTP: envio pela API do MailerSend (`EMAIL_PROVEDOR` = `smtp`, `mailersend` ou `sendgrid`; opcional) |
| `DADOS_DEMO` / `SENHA_DEMO` | Dados fictícios de demonstração (só desenvolvimento) |
| `PROXY_CONFIAVEL` | Confia em `X-Forwarded-*` (padrão: ligado no Render e no App Service) |
| `PROXY_SALTOS` | Quantos proxies ficam na frente da aplicação, para achar o IP do usuário (padrão: 2 no Render — Cloudflare e balanceador —, 1 nas demais) |
| `LIMITE_LOGIN_POR_MINUTO` | Tentativas de login por IP em 1 minuto (padrão: 60; o bloqueio por conta continua em 5 erros) |

Os nomes da versão .NET (`ConnectionStrings__Default`, `App__BaseUrl`, `Seed__AdminEmail`, `Seed__AdminPassword`,
`SendGrid__*`) e os `SENDGRID_*` anteriores continuam aceitos, para não quebrar um serviço já configurado.

Para conferir a configuração de e-mail sem esperar a rotina, `npm run email:teste -- --para voce@empresa.com.br` envia
um e-mail na hora e mostra o motivo exato se o provedor recusar.

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

Para criar ou atualizar o banco do servidor sem depender da partida, use `producao/criar-banco-postgres.sql`. Ele é
**gerado** das mesmas fontes (não edite à mão), é idempotente e roda numa transação:

```bash
psql "postgresql://usuario:senha@servidor/banco" -v ON_ERROR_STOP=1 -f producao/criar-banco-postgres.sql
```

Depois de mudar `schema.sql` ou `migrations.js`, gere de novo com `npm run script:producao`. O teste
`test/production-script.test.js` recusa o arquivo desatualizado. Parâmetros padrão e o primeiro ADMIN continuam sendo
criados pela aplicação na primeira partida.

## Aplicativo instalável (PWA)

`public/manifest.json` e os ícones de `public/icons/` fazem o sistema instalar como aplicativo (menu do Chrome →
"Instalar app" ou "Adicionar à tela inicial"), com a logo e sem o selo do navegador. Os ícones são gerados da logo
(`public/img/logo.png`) pelo System.Drawing do Windows, sem instalar nada:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/generate-pwa-icons.ps1 -Origem public/img/logo.png
```

Saem os tamanhos 192 e 512 px, a versão *maskable* (logo na zona segura, para o recorte redondo do Android), o ícone
do iPhone (180 px) e o favicon. `test/pwa.test.js` confere o manifesto contra os arquivos.

## Usuários pela linha de comando

Para a carga inicial, ou quando nenhum ADMIN consegue acessar a tela, `scripts/users.js` cria usuários com o mesmo
serviço da tela de Administração: política de senha, e-mail único, perfis válidos, troca de senha no primeiro acesso e
registro no log de auditoria (como "Sistema", origem `script`). O banco é o de `DATABASE_URL` (ambiente ou `.env`), e o
destino aparece antes de qualquer gravação.

```bash
npm run usuarios -- criar --nome "Maria Silva" --email maria@empresa.com.br --perfis NACC,DP
```

```bash
npm run usuarios -- listar
```

Sem `--senha`, uma senha provisória forte é gerada e mostrada uma única vez. Perfis: `COMMERCIAL`, `NACC`, `DP`, `RH`,
`RH_MANAGER`, `MANAGER`, `CONTROLLERSHIP`, `ADMIN` (vários separados por vírgula).

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
   Avisos: a Controladoria é avisada do valor novo e da correção (com o texto de correção); a **rejeição e a validação**
   avisam quem cadastrou e quem corrigiu por último. O aviso de validação não está na SPEC (10.1) e foi pedido pelo
   usuário em 16/10/2026. Quem cadastrou **ou corrigiu** a versão em análise não pode validá-la nem rejeitá-la.
7. **Sem valor cadastrado:** a posição mostra "Sem valor cadastrado" e fica fora dos totais. Se o valor for cadastrado depois com
   vigência anterior à abertura, as posições abertas sem valor passam a usá-lo.
8. **Rotina diária** roda de segunda a sexta (sem calendário de feriados) e recupera os dias perdidos; a data de encerramento por fim
   de vigência não depende do dia em que o job rodou.
9. **Datas futuras** são bloqueadas para marcos, exceto o último dia trabalhado (RN-13).
10. **Anexo de evidência no SharePoint (D4)** não foi implementado (fora das fases 1–3; parâmetro `REQUEST_EVIDENCE_REQUIRED = false`).
11. **E-mail via MailerSend por SMTP** (por decisão do usuário em 16/10/2026), com as mesmas variáveis `SMTP_*` da
    aplicação financeira; a API do MailerSend e o SendGrid continuam aceitos. A SPEC citava Microsoft 365. Limite do
    provedor (429 ou SMTP 4xx), login recusado ou falta de conexão pausam a caixa de saída **sem gastar tentativa**: no
    plano gratuito do MailerSend (100 e-mails por dia), o limite diário descartava os avisos em minutos.
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
21. **Avisos e resumo da rotina diária (fase 2, seções 10.1 e 10.2):**
    - *Em risco* avisa a equipe de RH do pedido (analistas responsáveis e Gestores de RH). *Vencido* escala para Gestor
      de RH (Coordenação de RH), Gestor (Diretor Comercial) e Controladoria. Cada um dispara **uma vez por posição**
      (tabela `position_alerts`); quem passa direto a Vencido recebe só o escalonamento.
    - *Posição parada* (`STALE_DAYS` sem atualização): avisa quem responde pela próxima ação — NACC (decisão do cliente,
      1º dia), responsável comercial do contrato (aprovação do cliente), equipe de RH (publicação, seleção, admissão) e
      DP junto na matrícula. Uma vez por período parado. Posição **pausada não gera esse alerta** (a espera é do cliente);
      ela aparece no resumo em "Pausas sem fim".
    - *Resumo diário*: um e-mail por pessoa dos perfis COMMERCIAL, NACC, DP, RH, RH_MANAGER, MANAGER e CONTROLLERSHIP,
      na primeira execução do dia, **sem valores em R$** (o mesmo e-mail para todos). Sem posição aberta, não é enviado.
    - Os avisos não trazem R$ e saem como notificação interna e e-mail (com `EMAIL_ATIVO=0`, só a notificação e o log).
22. **Relatórios e KPIs (fase 3, seção 11; 1ª etapa, decidida com o usuário em 18/10/2026):** tela Relatórios com posições
    em aberto, SLA por período, faturamento perdido e reposições, os 8 KPIs e exportação para Excel (abas Indicadores,
    Resumo, Detalhe e Filtros, gerador próprio sem dependência, adaptado da aplicação financeira).
    - *Período*: em aberto = foto de hoje (o período vale só para os KPIs); SLA = posições preenchidas (1º dia) no
      período; faturamento = dias descobertos que caem dentro do período; reposições = desligamentos com último dia
      trabalhado no período.
    - *Cortes*: os da seção 11, com "responsável" em dois filtros: analista de RH do pedido e responsável comercial do
      contrato. O resumo agrupa pelo corte escolhido.
    - *R$ (seção 4.2)*: por posição só para Comercial, Controladoria e Admin; o Gestor vê totais e somas por grupo;
      NACC, DP e RH veem dias. Valor não validado fica fora dos totais e aparece como pendente (RN-21).
    - *Metas dos KPIs*: parâmetros `KPI_TARGET_*`, vazios = "sem meta"; com meta, o KPI mostra dentro ou fora dela.
    - Toda exportação vai para o log de auditoria (`EXPORT_REPORT`). A tela de auditoria de dados é a 2ª etapa.
23. **Candidatos em lote por planilha (melhoria pedida pelo usuário em 19/10/2026):** na tela do pedido, o RH responsável
    (analista do pedido ou Gestor de RH) baixa o modelo e importa os candidatos selecionados.
    - *Modelo (.xlsx)*: uma linha por posição apta — em recrutamento, de pedido aprovado, no ciclo atual e sem
      candidato —, com Pedido e Vaga preenchidos e bloqueados (aba protegida), identificadores em colunas ocultas, Sexo em
      lista, validação de data, CPF em formato texto e a aba "Orientações".
    - *Prévia*: valida tudo sem gravar e aponta linha, campo e motivo. Cada linha passa pela mesma função de domínio do
      cadastro individual (simulação descartada), mais as conferências da planilha: pedido certo, posições do pedido e
      ainda aptas, linhas fora do modelo, CPF repetido no arquivo ou já usado em outra posição aberta.
    - *Confirmação* (decisões do usuário): com qualquer linha com erro, nada é gravado; linha totalmente em branco é
      ignorada e a posição continua pendente. Grava numa transação, cada candidato com a própria justificativa no log, e
      registra a importação (quem, quando, quantos e o arquivo).
    - O `.xlsx` enviado é lido por `src/services/xlsx-reader.js`, sem dependência, com teto de tamanho e de linhas.
      Testado com arquivo salvo pelo Excel 16.
24. **Painel de RH (melhoria pedida pelo usuário em 19/10/2026):** tela própria no grupo Gestão (o Painel continua
    igual), com o acompanhamento dos pedidos, das vagas e das demandas por analista.
    - *Acesso* (decisões do usuário): Gestor de RH, Gestor e Admin veem a equipe toda; o Analista de RH vê só os pedidos
      atribuídos a ele, com o filtro de analista fixo. Comercial, NACC, DP e Controladoria não acessam (403).
    - *Escopo*: por padrão, os pedidos em andamento (alguma vaga pendente), de qualquer data; o período filtra pela data
      da solicitação do cliente e há a opção de incluir os concluídos. Os filtros (período, cliente, unidade contratante,
      contrato, cargo, analista, etapa e situação do SLA) valem para cards, gráficos e tabelas, e ficam no endereço.
    - *Etapas*: Aberta, Em recrutamento, Candidato selecionado, Em admissão, Aguardando 1º dia e Preenchida; pausa e
      reposição aguardando a decisão do cliente contam como pendentes, mas em etapa própria. SLA das pendentes: no prazo,
      em risco, vencida, sem meta e não iniciado (sem data de abertura), pelo mesmo cálculo da seção 8 (pausas descontadas).
    - Uma linha por vaga: o ciclo atual (a reposição ocupa a vaga do desligado); canceladas ficam de fora. Pedido com mais
      de um analista aparece como "compartilhado" na linha de cada um; o total conta cada pedido e cada vaga uma vez.
    - Gráficos de barras empilhadas em HTML (sem biblioteca, por causa da CSP), com dica ao passar o mouse, legenda e a
      tabela correspondente. Clicar no pedido ou num segmento abre a lista de posições filtrada (pedido, etapa e SLA).
25. **Datas flexíveis com avisos (melhoria pedida pelo usuário em 19/10/2026):** datas passadas, futuras e fora da
    sequência das etapas não bloqueiam mais: a API responde 422 com `avisos` sem gravar, a tela mostra cada aviso (data
    e motivo) e "Salvar mesmo assim" reenvia com o cabeçalho `X-Confirm-Warnings: 1`. Na importação de candidatos, os
    avisos aparecem por linha na prévia e não impedem a confirmação.
    - *Retroativo* (decisão do usuário): fora da carga inicial, continua exigindo justificativa (RN-24), pedida na
      própria janela de avisos; na carga inicial, só o aviso.
    - *Continua bloqueando* o impossível no próprio registro: fim antes do início (pausa, vigência, contrato), início
      desejado antes da solicitação (o banco também confere), pausas sobrepostas, nascimento futuro, formato e
      obrigatório.
    - *Indicadores*: tempos contados até o evento já ocorrido ou até hoje (nunca negativos); 1º dia ou cancelamento
      futuros contam como agendados; só os dias de pausa entre a abertura e o 1º dia descontam do SLA; abertura futura
      = "SLA não iniciado".
    - *Selos* calculados a cada leitura (`src/domain/date-checks.js`): "Data futura" (some quando a data chega) e "Fora
      de sequência", na lista e no detalhe da posição, no filtro "Datas" e em dois cards do Painel de RH.
