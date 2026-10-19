-- Schema do Controle de Vagas: FONTE ÚNICA para SQLite (desenvolvimento e testes) e PostgreSQL (produção).
--
-- Só tipos comuns aos dois bancos: TEXT, INTEGER, NUMERIC(12,2) e BLOB (trocado por BYTEA no PostgreSQL ao aplicar,
-- em src/db/migrations.js). Datas são TEXT ISO: 'AAAA-MM-DD' (data) e 'AAAA-MM-DDTHH:MM:SS.sssZ' (instante, UTC),
-- que comparam e ordenam corretamente como texto nos dois bancos. Booleanos são INTEGER 0/1.
--
-- Ids são UUID v7 gerados na aplicação (ordenados pelo tempo). Toda tabela de negócio tem `version`: o UPDATE leva
-- `WHERE version = ?` e recusa com 409 quando outra pessoa gravou antes (ver src/db/unit-of-work.js).
--
-- Gatilhos (somente inclusão no log de auditoria, sem exclusão física — RN-26) ficam em migrations.js, porque a
-- sintaxe é diferente em cada banco.

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  must_change_password INTEGER NOT NULL DEFAULT 1,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  lockout_end TEXT,
  created_at TEXT NOT NULL,
  created_by TEXT,
  updated_at TEXT,
  updated_by TEXT,
  version INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_users_email ON users (email);

CREATE TABLE IF NOT EXISTS user_roles (
  user_id TEXT NOT NULL REFERENCES users (id),
  role TEXT NOT NULL,
  PRIMARY KEY (user_id, role)
);

-- Sessão: o cookie leva o token; aqui fica só o hash dele (vazar o banco não entrega sessões abertas).
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id),
  created_at TEXT NOT NULL,
  last_access TEXT NOT NULL,
  ip TEXT,
  user_agent TEXT
);
CREATE INDEX IF NOT EXISTS ix_sessions_user ON sessions (user_id);

CREATE TABLE IF NOT EXISTS group_entities (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  cnpj TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, created_by TEXT, updated_at TEXT, updated_by TEXT, version INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_group_entities_cnpj ON group_entities (cnpj);

CREATE TABLE IF NOT EXISTS clients (
  id TEXT PRIMARY KEY,
  legal_name TEXT NOT NULL,
  cnpj TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  has_multiple_units INTEGER NOT NULL DEFAULT 0,
  -- Bandeira/marca: identificação comercial que reúne unidades; o CNPJ central é opcional (vazio = não informado).
  is_brand INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, created_by TEXT, updated_at TEXT, updated_by TEXT, version INTEGER NOT NULL DEFAULT 0
);
-- CNPJ único só quando informado: várias bandeiras podem ficar sem o CNPJ central.
CREATE UNIQUE INDEX IF NOT EXISTS ux_clients_cnpj_informed ON clients (cnpj) WHERE cnpj <> '';

CREATE TABLE IF NOT EXISTS job_roles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, created_by TEXT, updated_at TEXT, updated_by TEXT, version INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_job_roles_name ON job_roles (name);

-- Local de trabalho: sem cliente = local geral (ADMIN); com cliente = unidade do cliente (loja, filial).
CREATE TABLE IF NOT EXISTS work_locations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  client_id TEXT REFERENCES clients (id),
  active INTEGER NOT NULL DEFAULT 1,
  code TEXT,
  cnpj TEXT,
  removed_at TEXT,
  created_at TEXT NOT NULL, created_by TEXT, updated_at TEXT, updated_by TEXT, version INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_work_locations_client ON work_locations (client_id);

CREATE TABLE IF NOT EXISTS pause_reasons (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, created_by TEXT, updated_at TEXT, updated_by TEXT, version INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_pause_reasons_name ON pause_reasons (name);

CREATE TABLE IF NOT EXISTS sla_targets (
  id TEXT PRIMARY KEY,
  modality TEXT NOT NULL,
  demand_type TEXT NOT NULL,
  days INTEGER NOT NULL CHECK (days > 0),
  valid_from TEXT NOT NULL,
  created_at TEXT NOT NULL, created_by TEXT, updated_at TEXT, updated_by TEXT, version INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_sla_targets ON sla_targets (modality, demand_type, valid_from);

CREATE TABLE IF NOT EXISTS system_parameters (
  id TEXT PRIMARY KEY,
  param_key TEXT NOT NULL,
  param_value TEXT NOT NULL,
  description TEXT,
  created_at TEXT NOT NULL, created_by TEXT, updated_at TEXT, updated_by TEXT, version INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_system_parameters_key ON system_parameters (param_key);

-- Contrato. `name` = código interno gerado (CT-AAAA-UNIDADE-SEQUENCIAL), nunca muda. `modalities` = lista "MOT,MOE".
CREATE TABLE IF NOT EXISTS contracts (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients (id),
  contracting_unit_id TEXT REFERENCES work_locations (id),
  name TEXT NOT NULL,
  group_entity_id TEXT NOT NULL REFERENCES group_entities (id),
  modalities TEXT NOT NULL CHECK (modalities <> ''),
  start_date TEXT NOT NULL,
  end_date TEXT,
  commercial_owner_id TEXT NOT NULL REFERENCES users (id),
  sla_new_days INTEGER,
  sla_replacement_days INTEGER,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL, created_by TEXT, updated_at TEXT, updated_by TEXT, version INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_contracts_name ON contracts (name);

-- Valor mensal de venda por cargo no contrato, versionado por valid_from (RN-20 a RN-22).
CREATE TABLE IF NOT EXISTS contract_rates (
  id TEXT PRIMARY KEY,
  contract_id TEXT NOT NULL REFERENCES contracts (id),
  job_role_id TEXT NOT NULL REFERENCES job_roles (id),
  monthly_value NUMERIC(12,2),
  fee_value NUMERIC(12,2),
  valid_from TEXT NOT NULL,
  status TEXT NOT NULL,
  validated_by TEXT,
  validated_at TEXT,
  rejection_reason TEXT,
  created_at TEXT NOT NULL, created_by TEXT, updated_at TEXT, updated_by TEXT, version INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_contract_rates ON contract_rates (contract_id, job_role_id, valid_from);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  number INTEGER NOT NULL,
  contract_id TEXT NOT NULL REFERENCES contracts (id),
  modality TEXT NOT NULL,
  job_role_id TEXT NOT NULL REFERENCES job_roles (id),
  quantity INTEGER NOT NULL CHECK (quantity >= 1),
  work_location_id TEXT NOT NULL REFERENCES work_locations (id),
  client_request_date TEXT NOT NULL,
  desired_start_date TEXT NOT NULL,
  term_type TEXT NOT NULL,
  term_end_date TEXT,
  term_duration_days INTEGER,
  notes TEXT,
  job_description TEXT,
  is_legacy INTEGER NOT NULL DEFAULT 0,
  registered_at TEXT NOT NULL,
  approval_status TEXT NOT NULL,
  client_decision_date TEXT,
  approval_recorded_at TEXT,
  approval_recorded_by TEXT,
  not_approved_reason TEXT,
  jobconvo_published INTEGER,
  jobconvo_code TEXT,
  jobconvo_published_at TEXT,
  jobconvo_notes TEXT,
  jobconvo_recorded_at TEXT,
  jobconvo_recorded_by TEXT,
  created_at TEXT NOT NULL, created_by TEXT, updated_at TEXT, updated_by TEXT, version INTEGER NOT NULL DEFAULT 0,
  CHECK (desired_start_date >= client_request_date)
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_orders_number ON orders (number);

-- Posição: cada vaga individual do pedido. slot_number = número da vaga; cycle = 1 (vaga nova) ou 2+ (reposições).
-- termination_id não tem chave estrangeira: positions e terminations se referenciam mutuamente.
CREATE TABLE IF NOT EXISTS positions (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders (id),
  sequence INTEGER NOT NULL,
  slot_number INTEGER NOT NULL,
  cycle INTEGER NOT NULL DEFAULT 1,
  demand_type TEXT NOT NULL,
  origin_position_id TEXT REFERENCES positions (id),
  termination_id TEXT,
  status TEXT NOT NULL,
  previous_status TEXT,
  desired_start_date TEXT NOT NULL,
  opened_at TEXT,
  candidate_approved_at TEXT,
  admission_at TEXT,
  admission_registration TEXT,
  first_day_at TEXT,
  employee_name TEXT,
  employee_registration TEXT,
  first_day_justification TEXT,
  first_day_confirmed_at TEXT,
  first_day_confirmed_by TEXT,
  closed_at TEXT,
  cancellation_reason TEXT,
  term_type TEXT NOT NULL,
  term_end_date TEXT,
  term_duration_days INTEGER,
  term_adjust_justification TEXT,
  rate_id TEXT REFERENCES contract_rates (id),
  sla_target_days INTEGER,
  sla_target_source TEXT NOT NULL,
  has_retroactive_dates INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, created_by TEXT, updated_at TEXT, updated_by TEXT, version INTEGER NOT NULL DEFAULT 0,
  CHECK (demand_type = 'NEW' OR (origin_position_id IS NOT NULL AND termination_id IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_positions_sequence ON positions (order_id, sequence);
CREATE UNIQUE INDEX IF NOT EXISTS ux_positions_slot_cycle ON positions (order_id, slot_number, cycle);
CREATE INDEX IF NOT EXISTS ix_positions_status ON positions (status);
CREATE INDEX IF NOT EXISTS ix_positions_registration ON positions (employee_registration);

-- Desligamento: no máximo um por posição de origem (RN-12).
CREATE TABLE IF NOT EXISTS terminations (
  id TEXT PRIMARY KEY,
  origin_position_id TEXT NOT NULL REFERENCES positions (id),
  last_worked_day TEXT NOT NULL,
  source TEXT NOT NULL,
  termination_type TEXT NOT NULL,
  notes TEXT,
  client_decision TEXT,
  client_decision_at TEXT,
  registered_at TEXT NOT NULL,
  created_at TEXT NOT NULL, created_by TEXT, updated_at TEXT, updated_by TEXT, version INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_terminations_origin ON terminations (origin_position_id);

-- Pausa: espera por responsabilidade do cliente; no máximo uma ativa por posição (RN-17).
CREATE TABLE IF NOT EXISTS pauses (
  id TEXT PRIMARY KEY,
  position_id TEXT NOT NULL REFERENCES positions (id),
  reason_id TEXT NOT NULL REFERENCES pause_reasons (id),
  start_date TEXT NOT NULL,
  end_date TEXT,
  created_at TEXT NOT NULL, created_by TEXT, updated_at TEXT, updated_by TEXT, version INTEGER NOT NULL DEFAULT 0,
  CHECK (end_date IS NULL OR end_date >= start_date)
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_pauses_one_active ON pauses (position_id) WHERE end_date IS NULL;
CREATE INDEX IF NOT EXISTS ix_pauses_position ON pauses (position_id);

-- Analistas de RH responsáveis pelo pedido; remoção lógica forma o histórico.
CREATE TABLE IF NOT EXISTS order_rh_analysts (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders (id),
  user_id TEXT NOT NULL REFERENCES users (id),
  user_name TEXT NOT NULL,
  assigned_at TEXT NOT NULL,
  assigned_by TEXT,
  removed_at TEXT,
  removed_by TEXT,
  created_at TEXT NOT NULL, created_by TEXT, updated_at TEXT, updated_by TEXT, version INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_order_rh_analysts_active ON order_rh_analysts (order_id, user_id) WHERE removed_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_order_rh_analysts_order ON order_rh_analysts (order_id);

-- Candidato selecionado (um ativo por posição); quem desistiu fica com withdrawn_at.
CREATE TABLE IF NOT EXISTS candidates (
  id TEXT PRIMARY KEY,
  position_id TEXT NOT NULL REFERENCES positions (id),
  full_name TEXT NOT NULL,
  birth_date TEXT NOT NULL,
  sex TEXT NOT NULL,
  cpf TEXT NOT NULL,
  approved_at TEXT NOT NULL,
  withdrawn_at TEXT,
  withdrawal_reason TEXT,
  created_at TEXT NOT NULL, created_by TEXT, updated_at TEXT, updated_by TEXT, version INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_candidates_one_active ON candidates (position_id) WHERE withdrawn_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_candidates_cpf ON candidates (cpf);

-- Conteúdo das evidências (fora do log de auditoria); os metadados ficam em position_evidences.
CREATE TABLE IF NOT EXISTS evidence_files (
  id TEXT PRIMARY KEY,
  content BLOB NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS position_evidences (
  id TEXT PRIMARY KEY,
  position_id TEXT NOT NULL REFERENCES positions (id),
  kind TEXT NOT NULL,
  file_name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  storage_key TEXT NOT NULL,
  created_at TEXT NOT NULL, created_by TEXT, updated_at TEXT, updated_by TEXT, version INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_position_evidences_position ON position_evidences (position_id);

-- Log de auditoria: somente inclusão (gatilho). Uma linha por criação e por campo alterado.
CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  occurred_at TEXT NOT NULL,
  ip TEXT,
  entity TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,
  field TEXT,
  old_value TEXT,
  new_value TEXT,
  justification TEXT
);
CREATE INDEX IF NOT EXISTS ix_audit_logs_entity ON audit_logs (entity_id, occurred_at);
CREATE INDEX IF NOT EXISTS ix_audit_logs_occurred ON audit_logs (occurred_at);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id),
  type TEXT NOT NULL,
  entity_id TEXT,
  message TEXT NOT NULL,
  read_at TEXT,
  created_at TEXT NOT NULL, created_by TEXT, updated_at TEXT, updated_by TEXT, version INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_notifications_user ON notifications (user_id, read_at);

-- Caixa de saída de e-mails: enviada em segundo plano; falha no envio não desfaz a operação.
CREATE TABLE IF NOT EXISTS email_messages (
  id TEXT PRIMARY KEY,
  to_address TEXT NOT NULL,
  subject TEXT NOT NULL,
  html_body TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  sent_at TEXT,
  created_at TEXT NOT NULL, created_by TEXT, updated_at TEXT, updated_by TEXT, version INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_email_messages_status ON email_messages (status);

-- Alertas da rotina diária já disparados (seção 10.1): a mudança de situação notifica UMA vez, nunca a cada execução.
-- Em risco e Vencido: uma vez por posição (reference vazio). Vaga parada: uma vez por período sem atualização
-- (reference = instante da última atualização; se a posição andar e parar de novo, é outro alerta).
CREATE TABLE IF NOT EXISTS position_alerts (
  id TEXT PRIMARY KEY,
  position_id TEXT NOT NULL REFERENCES positions (id),
  kind TEXT NOT NULL,
  reference TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_position_alerts ON position_alerts (position_id, kind, reference);

CREATE TABLE IF NOT EXISTS job_runs (
  id TEXT PRIMARY KEY,
  job_name TEXT NOT NULL,
  run_date TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  summary TEXT,
  created_at TEXT NOT NULL, created_by TEXT, updated_at TEXT, updated_by TEXT, version INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_job_runs ON job_runs (job_name, run_date);
