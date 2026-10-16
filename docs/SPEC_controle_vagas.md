# SPEC — Sistema de Controle de Vagas (Grupo ON LINE)

> Versão 1.0 · Outubro/2026 · Origem: Documento de Escopo Funcional v1.0 (Controladoria)
> Este arquivo é a especificação de implementação para o Claude Code.

---

## 0. Instruções para o Claude Code

1. **Leia o arquivo inteiro antes de começar.** Implemente por fases (seção 14), na ordem.
2. **Não invente regras de negócio.** Se algo não estiver aqui, pergunte. Itens marcados como `DECISÃO PENDENTE` (seção 15) devem ser implementados com o **padrão indicado** e ficar **configuráveis**.
3. **Stack:** reutilize o stack, a autenticação, a gestão de usuários, as notificações e o log de auditoria do sistema **SC/SP** (Solicitação de Compras e Pagamentos) do Grupo ON LINE. Se não tiver acesso a esse código, **pergunte antes de escolher um stack**.
4. **Idioma:** interface, mensagens e e-mails em **português do Brasil**. Identificadores de código em inglês, conforme a tabela de mapeamento (seção 16).
5. **Datas:** todos os campos de data são `DATE` (sem hora), fuso `America/Sao_Paulo`. Toda conta de dias é **diferença simples entre datas, em dias corridos** (seção 8).
6. **Testes:** os casos da seção 8.7 devem virar testes automatizados das funções de cálculo.
7. **Nada é excluído fisicamente.** Registros são encerrados ou inativados, com log.

---

## 1. Contexto e objetivo

Clientes solicitam vagas (demandas de profissionais) por e-mail, telefone e WhatsApp, sem registro consolidado. A empresa não mede o tempo de preenchimento das vagas iniciais nem das **reposições** de colaboradores desligados. Cada dia em que um posto contratado fica sem profissional é faturamento perdido.

**Objetivo do sistema:** registrar cada vaga demandada e medir, em **dias** e em **R$**, quanto tempo cada posto fica sem cobertura. Os pontos de atraso são separados por etapa: comunicação interna, espera do cliente e recrutamento.

**Exemplo-base:** um cliente contrata 10 estoquistas temporários por 30 dias. Cinco pedem demissão na primeira semana. Se a reposição leva 10 dias, são 50 dias-posto sem faturamento.

---

## 2. Escopo

**Dentro:**
- Cadastros de clientes, contratos e valores por cargo.
- Pedidos e posições.
- Desligamentos e reposições.
- Marcos de atendimento e pausas.
- SLA e impacto financeiro.
- Notificações, escalonamento e resumo diário.
- Painel, relatórios e log de auditoria.

**Fora:**
- Recrutamento e seleção, que continuam no **JobConvo**.
- Admissão, folha e rescisão, que continuam no **Domínio**.
- Faturamento e cobrança.
- Acesso do cliente ao sistema.
- Integrações automáticas com JobConvo e Domínio.

**Fronteira com o JobConvo:** este sistema controla a **demanda do cliente e o prazo**. O JobConvo executa o recrutamento. O único vínculo é o **código da vaga JobConvo**, digitado manualmente pelo RH.

---

## 3. Premissas técnicas

- Aplicação web, com login e senha individuais. Entre 10 e 25 usuários internos. O cliente não acessa o sistema.
- Banco relacional.
- E-mail via Microsoft 365 (SMTP ou Graph API), mais notificações internas no painel.
- SharePoint apenas para anexos opcionais (ver seção 15, item D4).
- Uma rotina diária agendada (job) recalcula o SLA, encerra posições por fim de vigência e envia o resumo diário (seção 10.2).
- O faturamento perdido é um **indicador gerencial**. Não é base de cobrança.

---

## 4. Perfis (roles) e permissões

Um usuário pode ter vários perfis. Segregação obrigatória: **quem cadastra valores (COMMERCIAL) não os valida**. Só a CONTROLLERSHIP valida.

| Código | Perfil | Quem é |
|---|---|---|
| `COMMERCIAL` | Comercial | Recebe pedidos dos clientes |
| `NACC` | NACC | Atendimento ao cliente |
| `DP` | DP | Departamento Pessoal |
| `RH` | RH / R&S | Executa o recrutamento no JobConvo |
| `MANAGER` | Gestor | Coordenação de RH, Diretor Comercial |
| `CONTROLLERSHIP` | Controladoria | Valida valores e acompanha o impacto financeiro |
| `ADMIN` | Administrador | Usuários e parâmetros |

### 4.1 Matriz de ações

| Ação | COMMERCIAL | NACC | DP | RH | MANAGER | CONTROLLERSHIP | ADMIN |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| Cadastrar/editar cliente e contrato | ✓ | | | | | | ✓ |
| Cadastrar valor por cargo | ✓ | | | | | | |
| Validar/rejeitar valor por cargo | | | | | | ✓ | |
| Criar pedido | ✓ | | | | | | |
| Definir tipo de vigência (no pedido) | ✓ | | | | | | |
| Ajustar vigência da posição (com justificativa) | | ✓ | | | | | |
| Registrar desligamento | | ✓ | ✓ | | | | |
| Registrar decisão do cliente (repor/não repor) | | ✓ | | | | | |
| Informar código JobConvo / aprovado / admissão | | | | ✓ | | | |
| Registrar/encerrar pausa | | ✓ | | | | | |
| Confirmar 1º dia efetivo | | ✓ | | | | | |
| Cancelar posição (Cliente cancelou) | ✓ | ✓ | | | | | |
| Corrigir datas (com justificativa) | autor do marco | autor do marco | autor do marco | autor do marco | | | ✓ |
| Painel e relatórios | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Parâmetros, metas de SLA, motivos de pausa, usuários | | | | | | | ✓ |
| Abrir/fechar período de carga inicial | | | | | | | ✓ |
| Relatório de auditoria de dados | | | | | ✓ | ✓ | ✓ |

### 4.2 Visibilidade de valores em R$ (`DECISÃO PENDENTE` D2, padrão abaixo)

| Perfil | Valores de contrato | R$ por posição | R$ agregado no painel |
|---|:-:|:-:|:-:|
| COMMERCIAL | ✓ | ✓ | ✓ |
| CONTROLLERSHIP | ✓ | ✓ | ✓ |
| ADMIN | ✓ | ✓ | ✓ |
| MANAGER | | | ✓ |
| NACC, DP, RH | | | |

Os perfis sem acesso a R$ veem **dias descobertos**, mas não valores.

---

## 5. Modelo de dados

Convenções: toda tabela tem `id`, `created_at`, `created_by`, `updated_at` e `updated_by`. Valores monetários em `DECIMAL(12,2)`.

### 5.1 Enums

```
Modality          = RS | MOT | MOE | FAC            # R&S, Mão de Obra Temporária, Mão de Obra Efetiva, Facilities
DemandType        = NEW | REPLACEMENT
TermType          = FIXED_END | PRESERVED_DURATION | INDEFINITE
PositionStatus    = AWAITING_CONFIRMATION | OPEN | RECRUITING | CANDIDATE_APPROVED
                  | IN_ADMISSION | PAUSED | FILLED | CLOSED_CLIENT_CANCELLED | CLOSED_CONTRACT_ENDED
OrderStatus       = IN_PROGRESS | FULFILLED | CANCELLED          # calculado, não persistido
SlaSituation      = ON_TIME | AT_RISK | OVERDUE | NO_TARGET     # calculado
RateStatus        = PENDING | VALIDATED | REJECTED
TerminationSource = DP | NACC | CLIENT
TerminationType   = RESIGNATION | DISMISSAL | CONTRACT_END | ABANDONMENT | OTHER
ClientDecision    = REPLACE | NOT_REPLACE
ContractStatus    = ACTIVE | CLOSED
```

### 5.2 Entidades

**GroupEntity** (CNPJs do Grupo ON LINE; parâmetro)
| Campo | Tipo | Obrig. | Regra |
|---|---|:-:|---|
| name | string | ✓ | |
| cnpj | string | ✓ | único; valida dígito |
| active | bool | ✓ | |

**Client**
| Campo | Tipo | Obrig. | Regra |
|---|---|:-:|---|
| legal_name | string | ✓ | razão social |
| cnpj | string | ✓ | único; valida dígito verificador |
| active | bool | ✓ | |

**Contract**
| Campo | Tipo | Obrig. | Regra |
|---|---|:-:|---|
| client_id | FK Client | ✓ | |
| name | string | ✓ | identificador do contrato |
| group_entity_id | FK GroupEntity | ✓ | CNPJ do Grupo responsável |
| modalities | Modality[] | ✓ | ao menos uma |
| start_date | date | ✓ | |
| end_date | date | | |
| commercial_owner_id | FK User (COMMERCIAL) | ✓ | |
| sla_new_days | int | | meta contratual para vaga nova |
| sla_replacement_days | int | | meta contratual para reposição |
| status | ContractStatus | ✓ | |

**JobRole** (cargo; parâmetro): `name`, `active`
**WorkLocation** (local de trabalho; parâmetro): `name`, `client_id` (opcional), `active`

**ContractRate** (valor por cargo no contrato, versionado)
| Campo | Tipo | Obrig. | Regra |
|---|---|:-:|---|
| contract_id | FK | ✓ | |
| job_role_id | FK | ✓ | |
| monthly_value | decimal | ✓ exceto RS | base do valor diário |
| fee_value | decimal | | só R&S; informativo |
| valid_from | date | ✓ | única por (contract, job_role, valid_from) |
| status | RateStatus | ✓ | inicia PENDING |
| validated_by / validated_at | FK / datetime | | preenchidos pela CONTROLLERSHIP |
| rejection_reason | text | se REJECTED | |

**Order** (pedido)
| Campo | Tipo | Obrig. | Regra |
|---|---|:-:|---|
| contract_id | FK | ✓ | contrato ACTIVE |
| modality | Modality | ✓ | deve estar em `contract.modalities` |
| job_role_id | FK | ✓ | |
| quantity | int ≥ 1 | ✓ | |
| work_location_id | FK | ✓ | |
| client_request_date | date | ✓ | data em que o cliente pediu |
| desired_start_date | date | ✓ | ≥ client_request_date |
| term_type | TermType | ✓ | |
| term_end_date | date | se FIXED_END | ≥ desired_start_date |
| term_duration_days | int | se PRESERVED_DURATION | |
| notes | text | | |
| is_legacy | bool | ✓ | true quando criado por desligamento avulso (D1) |

**Position** (posição; unidade de controle)
| Campo | Tipo | Obrig. | Regra |
|---|---|:-:|---|
| order_id | FK | ✓ | |
| demand_type | DemandType | ✓ | |
| origin_position_id | FK Position | se REPLACEMENT | |
| termination_id | FK Termination | se REPLACEMENT | |
| status | PositionStatus | ✓ | |
| previous_status | PositionStatus | se PAUSED | para retornar ao fim da pausa |
| opened_at | date | | NEW: data de registro do pedido. REPLACEMENT: data da decisão REPLACE |
| jobconvo_code | string | para RECRUITING | |
| jobconvo_opened_at | date | | |
| candidate_approved_at | date | | |
| admission_at | date | | |
| first_day_at | date | para FILLED | 1º dia efetivo no posto |
| employee_name | string | para FILLED | |
| employee_registration | string | para FILLED | matrícula |
| closed_at | date | se CLOSED_* | |
| term_type / term_end_date / term_duration_days | | ✓ | copiados do pedido (ou da origem, na reposição); ajustáveis pelo NACC até FILLED |
| term_adjust_justification | text | se ajustada | |
| rate_id | FK ContractRate | | versão vigente em `opened_at` (snapshot) |
| sla_target_days | int | | meta gravada na abertura (snapshot) |
| sla_target_source | enum CONTRACT \| DEFAULT \| NONE | ✓ | |
| has_retroactive_dates | bool | ✓ | sinalização (RN-24) |

**Termination** (desligamento)
| Campo | Tipo | Obrig. | Regra |
|---|---|:-:|---|
| origin_position_id | FK Position | ✓ | posição FILLED; **único** (RN-12) |
| last_worked_day | date | ✓ | pode ser futura |
| source | TerminationSource | ✓ | |
| termination_type | TerminationType | ✓ | |
| notes | text | | |
| client_decision | ClientDecision | | registrada pelo NACC |
| client_decision_at | date | | |

**Pause**
| Campo | Tipo | Obrig. | Regra |
|---|---|:-:|---|
| position_id | FK | ✓ | |
| reason_id | FK PauseReason | ✓ | |
| start_date | date | ✓ | |
| end_date | date | | ≥ start_date; sem sobreposição com outras pausas da posição |

**PauseReason** (parâmetro): `name`, `active`. Apenas motivos de responsabilidade do cliente.

**SlaTarget** (meta padrão)
| Campo | Tipo | Obrig. |
|---|---|:-:|
| modality | Modality | ✓ |
| demand_type | DemandType | ✓ |
| days | int | ✓ |
| valid_from | date | ✓ |

**SystemParameter** (chave/valor; ADMIN)
| Chave | Padrão | Uso |
|---|---|---|
| `AT_RISK_DAYS` | 2 *(provisório)* | dias antes do prazo para virar AT_RISK |
| `STALE_DAYS` | 3 *(provisório)* | posição sem atualização gera alerta |
| `EARLY_REPLACEMENT_WINDOW_DAYS` | 30 *(provisório)* | janela da taxa de reposição precoce |
| `INITIAL_LOAD_OPEN` | true | período de carga inicial aberto |
| `ALLOW_LEGACY_TERMINATION` | true | desligamento avulso (D1) |
| `LOSS_ON_CANCEL_AFTER_OPEN` | true | D3 |
| `DAILY_DIGEST_TIME` | 07:00 | horário do resumo diário |

**User**: `name`, `email` (único), `password_hash`, `roles` (Role[]), `active`.
**AuditLog** (append-only, sem UPDATE/DELETE): `user_id`, `timestamp`, `ip`, `entity`, `entity_id`, `action`, `field`, `old_value`, `new_value`, `justification`.
**Notification**: `user_id`, `type`, `entity_id`, `message`, `read_at`.

---

## 6. Máquina de estados da posição

```
                        (REPLACEMENT)
  Termination ──► AWAITING_CONFIRMATION ──NOT_REPLACE──► CLOSED_CLIENT_CANCELLED
                        │ REPLACE
  (NEW) Order ──►      OPEN ──► RECRUITING ──► CANDIDATE_APPROVED ──► IN_ADMISSION ──► FILLED
                        │           │                 │                     │
                        └─────── PAUSED (de qualquer estado aberto; volta ao previous_status) ───┘
  Qualquer estado aberto ──cancelamento──► CLOSED_CLIENT_CANCELLED
  Qualquer estado aberto ──job diário (FIXED_END e hoje > term_end_date)──► CLOSED_CONTRACT_ENDED
```

"Estado aberto" = qualquer status exceto `FILLED` e `CLOSED_*`.

| De | Para | Gatilho | Ator | Condições |
|---|---|---|---|---|
| — | OPEN | criar pedido (NEW) | COMMERCIAL | `opened_at` = data de registro |
| — | AWAITING_CONFIRMATION | registrar desligamento | DP, NACC | origem FILLED; sem Termination existente |
| AWAITING_CONFIRMATION | OPEN | decisão REPLACE | NACC | `opened_at` = `client_decision_at` |
| AWAITING_CONFIRMATION | CLOSED_CLIENT_CANCELLED | decisão NOT_REPLACE | NACC | perda = 0 |
| OPEN | RECRUITING | informar JobConvo | RH | `jobconvo_code` obrigatório |
| RECRUITING | CANDIDATE_APPROVED | aprovar candidato | RH | `candidate_approved_at` |
| CANDIDATE_APPROVED | IN_ADMISSION | registrar admissão | RH | `admission_at` |
| IN_ADMISSION | FILLED | confirmar 1º dia | NACC | `first_day_at` ≥ `opened_at`; nome e matrícula |
| CANDIDATE_APPROVED | RECRUITING | candidato desistiu | RH | limpa `candidate_approved_at` (fica no log) |
| IN_ADMISSION | RECRUITING | admitido não compareceu | RH, NACC | limpa `admission_at` (fica no log) |
| aberto | PAUSED | iniciar pausa | NACC | grava `previous_status`; sem pausa ativa |
| PAUSED | previous_status | encerrar pausa | NACC | `end_date` |
| aberto | CLOSED_CLIENT_CANCELLED | cancelar | COMMERCIAL, NACC | `closed_at`; motivo obrigatório |
| aberto | CLOSED_CONTRACT_ENDED | job diário | Sistema | FIXED_END e hoje > `term_end_date`; `closed_at` = `term_end_date` + 1 |

> As duas transições de retorno (desistência e não comparecimento) não constam explicitamente no escopo funcional. Foram incluídas por serem necessárias ao fluxo real. **Confirmar com o usuário.**

**Status do pedido (calculado):**
- `IN_PROGRESS`: há ao menos uma posição aberta.
- `FULFILLED`: todas as posições estão `FILLED` ou `CLOSED_*`, com ao menos uma `FILLED`.
- `CANCELLED`: todas as posições estão `CLOSED_*`.

---

## 7. Regras de negócio

### 7.1 Pedidos e posições
- **RN-01:** Pedido só em contrato `ACTIVE`; a modalidade deve pertencer ao contrato.
- **RN-02:** Pedido com `quantity = N` gera N posições `NEW` com status `OPEN`.
- **RN-03:** Campos obrigatórios do pedido conforme seção 5.2. `term_end_date` é obrigatório se `FIXED_END`; `term_duration_days`, se `PRESERVED_DURATION`.
- **RN-04:** `desired_start_date ≥ client_request_date`.
- **RN-05:** Aumentar a quantidade gera novas posições. Reduzir só por cancelamento de posições.
- **RN-06:** `RECRUITING` exige `jobconvo_code`.
- **RN-07:** `FILLED` exige `first_day_at`, `employee_name` e `employee_registration`, registrados pelo NACC.
- **RN-08:** `first_day_at ≥ opened_at`.
- **RN-09:** Falta de candidato **não** encerra a posição.
- **RN-10:** Encerramento sem preenchimento só por `CLOSED_CLIENT_CANCELLED` ou `CLOSED_CONTRACT_ENDED`.

### 7.2 Desligamentos e reposições
- **RN-11:** Desligamento só pelos perfis DP e NACC, vinculado a uma posição `FILLED`.
- **RN-12:** Um único desligamento por posição de origem (constraint única + validação na interface).
- **RN-13:** `last_worked_day` é o último dia trabalhado e pode ser futuro.
- **RN-14:** O desligamento cria uma posição `REPLACEMENT` no mesmo pedido, status `AWAITING_CONFIRMATION`, herdando vigência e valor da origem.
- **RN-15:** O NACC registra a decisão do cliente. `NOT_REPLACE` encerra como `CLOSED_CLIENT_CANCELLED`, com perda 0.

### 7.3 SLA e pausas
- **RN-16:** Dias corridos.
- **RN-17:** Pausa só com motivo cadastrado, pelo NACC, sem sobreposição e com no máximo uma pausa ativa por posição.
- **RN-18:** Pausas descontam do tempo de preenchimento, **não** dos dias descobertos.
- **RN-19:** Meta gravada na abertura (`sla_target_days`). Precedência: meta do contrato pelo tipo de demanda → `SlaTarget` (modality + demand_type) vigente em `opened_at` → sem meta. Alterações posteriores não afetam posições já abertas.

### 7.4 Valores e vigência
- **RN-20:** `daily_value = monthly_value / 30`.
- **RN-21:** O valor entra nos totais oficiais só se `ContractRate.status = VALIDATED`. Caso contrário, o R$ aparece como "pendente de validação" e fica fora dos totais.
- **RN-22:** Perda conforme a vigência (seção 8.5). `RS` nunca tem cálculo em R$.
- **RN-23:** O NACC pode alterar a vigência da posição até `FILLED`, com justificativa obrigatória e log.

### 7.5 Integridade
- **RN-24:** Com `INITIAL_LOAD_OPEN = false`, qualquer data de marco anterior à data de registro exige justificativa e marca `has_retroactive_dates = true`.
- **RN-25:** Corrigir data já registrada exige justificativa. O valor anterior fica no AuditLog.
- **RN-26:** Sem exclusão física de pedidos, posições, desligamentos ou valores.

---

## 8. Cálculos

Todas as funções são puras, recebem a posição e `today`, e retornam inteiros (dias) ou decimais (R$). `d2 - d1` = número de dias corridos entre duas datas.

### 8.1 Início e fim da janela descoberta

```
uncovered_start(p):
    NEW         → order.desired_start_date
    REPLACEMENT → termination.last_worked_day + 1

uncovered_end_exclusive(p, today):
    FILLED                    → p.first_day_at
    CLOSED_CONTRACT_ENDED     → p.term_end_date + 1
    CLOSED_CLIENT_CANCELLED   → p.closed_at        # e ver regra de perda 8.5
    aberta, FIXED_END         → min(today, p.term_end_date + 1)
    aberta                    → today

uncovered_days(p, today) = max(0, uncovered_end_exclusive - uncovered_start)
```

### 8.2 Dias em pausa
```
paused_days(p, today) = Σ (coalesce(pause.end_date, today) - pause.start_date)
```

### 8.3 Indicadores de tempo
```
registration_time (NEW)          = order.created_at::date - order.client_request_date
communication_time (REPLACEMENT) = max(0, termination.created_at::date - termination.last_worked_day)
confirmation_time (REPLACEMENT)  = termination.client_decision_at - termination.created_at::date
fill_time (SLA, ambos)           = (coalesce(first_day_at, today) - opened_at) - paused_days
```

### 8.4 Situação do SLA (posições abertas a partir de OPEN)
```
if sla_target_days is null                    → NO_TARGET
deadline = opened_at + sla_target_days + paused_days
if FILLED:  fill_time <= sla_target_days      → ON_TIME, senão OVERDUE
if today > deadline                           → OVERDUE
if today >= deadline - AT_RISK_DAYS           → AT_RISK
else                                          → ON_TIME
```
`AWAITING_CONFIRMATION` não tem SLA do RH (aparece como "Aguardando cliente").

### 8.5 Impacto financeiro
```
daily_value = rate.monthly_value / 30

if modality == RS                                   → lost = 0, deferred = 0 (não exibir R$)
if REPLACEMENT and client_decision == NOT_REPLACE   → lost = 0
if CLOSED_CLIENT_CANCELLED and not LOSS_ON_CANCEL_AFTER_OPEN → lost = 0
if term_type == PRESERVED_DURATION                  → lost = 0; deferred = uncovered_days * daily_value
else (FIXED_END | INDEFINITE)                       → lost = uncovered_days * daily_value; deferred = 0
```

### 8.6 Taxa de reposição precoce
```
early = count(Termination t where t.last_worked_day - origin.first_day_at <= EARLY_REPLACEMENT_WINDOW_DAYS)
rate  = early / count(posições FILLED no período)
```

### 8.7 Casos de teste (valor mensal R$ 3.000,00 → diário R$ 100,00)

| # | Cenário | Entradas | Resultado esperado |
|---|---|---|---|
| T1 | Reposição, INDEFINITE | último dia 2026-11-10; desligamento registrado 11-12; REPLACE em 11-14; pausa 11-18→11-20; 1º dia 11-24 | comunicação 2; confirmação 2; fill_time 8; uncovered_days 13; lost R$ 1.300,00 |
| T2 | Nova, PRESERVED_DURATION | desejado 2026-12-01; 1º dia 12-05 | uncovered 4; lost 0; deferred R$ 400,00 |
| T3 | Nova, FIXED_END 12-31 | desejado 12-01; 1º dia 12-05 | uncovered 4; lost R$ 400,00 |
| T4 | Nova, FIXED_END não preenchida | desejado 12-01; fim 12-31; job em 2027-01-01 | status CLOSED_CONTRACT_ENDED; closed_at 2027-01-01; uncovered 31; lost R$ 3.100,00 |
| T5 | Reposição, NOT_REPLACE | último dia 11-10; decisão 11-12 | CLOSED_CLIENT_CANCELLED; lost 0 |
| T6 | Modalidade RS | qualquer | lost 0; R$ não exibido; SLA calculado normalmente |
| T7 | Reposição antecipada | último dia (futuro) 11-30; 1º dia do substituto 12-01 | uncovered 0; lost 0 |
| T8 | Substituto começa antes da saída | último dia 11-30; 1º dia 11-28 | uncovered 0 (max 0) |
| T9 | Cancelada depois de aberta, INDEFINITE | último dia 11-10; cancelada 11-20 | uncovered 9; lost R$ 900,00 (com LOSS_ON_CANCEL_AFTER_OPEN = true) |
| T10 | SLA | aberta 11-14; meta 10; pausa de 2 dias; hoje 11-24; AT_RISK_DAYS 2 | deadline 11-26 → AT_RISK |
| T11 | Valor pendente | rate PENDING | R$ calculado, marcado "pendente", fora dos totais |
| T12 | Desligamento duplicado | segundo registro para a mesma origem | bloqueado com mensagem |

---

## 9. Telas

| Tela | Perfis | Conteúdo principal |
|---|---|---|
| Login | todos | usuário e senha; política de senha |
| Painel | todos | cards: posições abertas, vencidas, em risco, aguardando cliente, dias descobertos no mês, R$ perdido/postergado no mês (se permitido); lista de vencidas/em risco ordenada por dias descobertos |
| Posições (lista) | todos | filtros: período, cliente, contrato, modalidade, cargo, tipo de demanda, CNPJ do Grupo, local, status, situação do SLA; cor por situação (verde/amarelo/vermelho/cinza) |
| Detalhe da posição | todos | linha do tempo dos marcos; pausas; indicadores (seção 8); botões apenas das ações permitidas ao perfil no status atual; histórico (AuditLog) |
| Novo pedido | COMMERCIAL | formulário (RN-03); prévia das N posições |
| Pedido (detalhe) | todos | posições do pedido e status calculado |
| Registrar desligamento | DP, NACC | busca do colaborador por nome/matrícula entre as posições FILLED; avulso se D1 ativo |
| Clientes e contratos | COMMERCIAL, ADMIN | CRUD (inativação, sem exclusão) |
| Valores por cargo | COMMERCIAL, CONTROLLERSHIP | lista versionada; fila de validação para a CONTROLLERSHIP |
| Relatórios | conforme seção 11 | exportação para Excel |
| Administração | ADMIN | usuários e perfis; parâmetros; metas de SLA; motivos de pausa; cargos; locais; CNPJs do Grupo; período de carga |
| Auditoria de dados | MANAGER, CONTROLLERSHIP, ADMIN | datas retroativas, correções, ajustes de vigência, pausas |

---

## 10. Notificações e rotina diária

### 10.1 Eventos (e-mail + notificação interna)

| Evento | Destinatários |
|---|---|
| Pedido criado | RH, NACC |
| Desligamento registrado | NACC |
| Decisão REPLACE | RH |
| Admissão registrada | NACC |
| Pausa iniciada/encerrada | RH |
| Posição entra em AT_RISK | RH, MANAGER (Coordenação de RH) |
| Posição entra em OVERDUE (escalonamento) | MANAGER (Coordenação de RH, Diretor Comercial), CONTROLLERSHIP |
| Posição sem atualização há `STALE_DAYS` | responsável pela próxima ação (seção 6) |
| ContractRate PENDING criado | CONTROLLERSHIP |
| ContractRate REJECTED | autor do cadastro |
| CLOSED_CONTRACT_ENDED pelo job | COMMERCIAL (dono do contrato), NACC |

Notificações de mudança de situação disparam **uma vez** por transição, nunca a cada execução do job.

### 10.2 Job diário (dias úteis, `DAILY_DIGEST_TIME`)
1. Encerrar posições `FIXED_END` vencidas (`CLOSED_CONTRACT_ENDED`).
2. Recalcular a situação do SLA e disparar as notificações de transição.
3. Enviar o resumo diário para os perfis operacionais e de gestão: posições abertas por status e cliente; vencidas e em risco; reposições aguardando cliente; pausas sem fim; posições sem atualização.

---

## 11. Relatórios e KPIs

| Relatório | Conteúdo | Acesso |
|---|---|---|
| Posições em aberto | status, dias em aberto, situação do SLA | todos |
| SLA por período | comunicação, confirmação, preenchimento e total, com médias por corte | todos |
| Faturamento perdido | dias descobertos, R$ perdido e postergado por cliente, contrato e cargo | conforme 4.2 |
| Reposições | desligamentos por tipo, tempo de reposição, taxa de reposição precoce | todos |
| Auditoria de dados | datas retroativas, correções, ajustes de vigência, pausas | MANAGER, CONTROLLERSHIP, ADMIN |

**KPIs** (metas a definir; exibir "sem meta" enquanto não houver):
- Tempo médio de comunicação.
- Tempo médio de preenchimento.
- Tempo médio total descoberto.
- % no SLA.
- Dias-posto descobertos.
- Faturamento perdido.
- Backlog vencido.
- Taxa de reposição precoce.

**Cortes** disponíveis em todos os relatórios: período, cliente/contrato, modalidade, cargo, tipo de demanda, CNPJ do Grupo, local e responsável.

---

## 12. Segurança, auditoria e LGPD

- Senha com no mínimo 8 caracteres, maiúscula, número e caractere especial; hash bcrypt (ou equivalente).
- Timeout de sessão por inatividade de 30 minutos.
- Autorização verificada **no backend** em toda ação (não só na interface), conforme a matriz 4.1 e as regras de status da seção 6.
- AuditLog append-only em toda criação, alteração, transição e correção, com valor anterior, valor novo e justificativa.
- Dados de colaboradores restritos a nome e matrícula. Sem CPF.
- Backup diário do banco.
- Disponibilidade em horário comercial (segunda a sexta, 08h às 18h).

---

## 13. Carga inicial

Ordem obrigatória, todos os registros manuais (sem importação de planilha):
1. ADMIN: parâmetros, cargos, locais, CNPJs do Grupo, motivos de pausa, usuários.
2. COMMERCIAL: clientes, contratos, valores por cargo.
3. CONTROLLERSHIP: validação dos valores.
4. COMMERCIAL e NACC: pedidos e posições em aberto, com as datas originais (`INITIAL_LOAD_OPEN = true` permite datas retroativas sem justificativa).
5. ADMIN: fecha o período de carga (`INITIAL_LOAD_OPEN = false`).

---

## 14. Fases de entrega e critérios de aceite

### Fase 1 — MVP
Autenticação, perfis e AuditLog; cadastros e parâmetros; pedidos e posições; desligamentos e reposições (com D1); marcos, pausas e máquina de estados; funções de cálculo (seção 8) com todos os testes T1–T12 passando; notificações de eventos por e-mail; painel de posições abertas e vencidas; job de encerramento por fim de vigência.

**Aceite:**
- Um pedido de 10 posições percorre todo o fluxo até FILLED.
- Um desligamento gera reposição e o cálculo bate com T1.
- Um usuário sem permissão recebe erro 403 no backend.

### Fase 2 — Gestão
Metas de SLA e situação AT_RISK/OVERDUE; escalonamento; resumo diário; filtros avançados; tela de validação de valores.

**Aceite:**
- Uma meta cadastrada afeta só as posições abertas depois dela.
- O escalonamento dispara uma única vez por posição.

### Fase 3 — Consolidação
Relatórios e KPIs completos com exportação; auditoria de dados; ajustes de usabilidade.

**Aceite:**
- Os totais do relatório de faturamento perdido batem com a soma das posições.
- Valores pendentes ficam fora dos totais.

---

## 15. Decisões pendentes (implementar o padrão, de forma configurável)

| ID | Tema | Padrão a implementar | Configuração |
|---|---|---|---|
| D1 | Desligamento sem posição de origem | Permitir **desligamento avulso**: o usuário informa contrato, cargo, nome, matrícula e último dia; o sistema cria um Order `is_legacy = true` (quantity 1) e uma posição FILLED de origem (`first_day_at` opcional), depois segue RN-14 | `ALLOW_LEGACY_TERMINATION` |
| D2 | Visibilidade de R$ | Matriz da seção 4.2 | permissões por perfil |
| D3 | Perda em cancelamento após abertura | Contar os dias descobertos até `closed_at` | `LOSS_ON_CANCEL_AFTER_OPEN` |
| D4 | Evidência da solicitação do cliente | Anexo **opcional** no pedido (SharePoint) | `REQUEST_EVIDENCE_REQUIRED` = false |
| D5 | Parâmetros numéricos | Valores provisórios da seção 5.2 | SystemParameter |
| D6 | Motivos de pausa | Cadastro vazio, mantido pelo ADMIN | PauseReason |
| D7 | Metas de SLA | Nenhuma meta inicial; tudo NO_TARGET | SlaTarget |

---

## 16. Glossário e mapeamento de nomes

| Termo (pt-BR, interface) | Código | Definição |
|---|---|---|
| Pedido | Order | Solicitação do cliente: cargo e quantidade |
| Posição | Position | Cada vaga individual do pedido |
| Vaga nova / Reposição | NEW / REPLACEMENT | Tipo de demanda |
| Desligamento | Termination | Saída de colaborador de uma posição preenchida |
| Pausa | Pause | Espera por responsabilidade do cliente |
| Vigência | term_type | Data fim fixa / Duração preservada / Indeterminado |
| Valor por cargo | ContractRate | Valor mensal de venda, versionado |
| Dias descobertos | uncovered_days | Dias em que o posto deveria estar ocupado e não estava |
| Tempo de preenchimento | fill_time | SLA do RH, descontadas as pausas |
| Faturamento perdido / postergado | lost / deferred | Ver seção 8.5 |
| Aguardando confirmação | AWAITING_CONFIRMATION | Reposição aguardando decisão do cliente |
| Aberta | OPEN | |
| Em recrutamento | RECRUITING | |
| Candidato aprovado | CANDIDATE_APPROVED | |
| Em admissão | IN_ADMISSION | |
| Pausada | PAUSED | |
| Preenchida | FILLED | |
| Encerrada: cliente cancelou | CLOSED_CLIENT_CANCELLED | |
| Encerrada: contrato encerrou | CLOSED_CONTRACT_ENDED | |
| No prazo / Em risco / Vencido / Sem meta | ON_TIME / AT_RISK / OVERDUE / NO_TARGET | Situação do SLA |
| NACC | NACC | Equipe de atendimento ao cliente |
| R&S, MOT, MOE, Facilities | RS, MOT, MOE, FAC | Modalidades |
