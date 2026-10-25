import { BusinessRuleError, ForbiddenError } from './errors.js';
import { Roles, SEE_AGGREGATED_VALUES, SEE_DETAILED_VALUES } from './enums.js';

/** CNPJ: só os 14 dígitos, com os dígitos verificadores conferidos. */
export const Cnpj = {
  normalize: (value) => String(value ?? '').replace(/\D/g, ''),
  isValid(value) {
    const d = Cnpj.normalize(value);
    if (d.length !== 14 || new Set(d).size === 1) return false;
    const check = (digits, weights) => {
      const rest = [...digits].reduce((sum, c, i) => sum + Number(c) * weights[i], 0) % 11;
      return rest < 2 ? 0 : 11 - rest;
    };
    const first = check(d.slice(0, 12), [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
    const second = check(d.slice(0, 12) + first, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
    return Number(d[12]) === first && Number(d[13]) === second;
  },
  require(value, field = null) {
    if (!Cnpj.isValid(value)) throw new BusinessRuleError('CNPJ inválido.', field);
    return Cnpj.normalize(value);
  },
};

/** CPF: só os 11 dígitos, com os dígitos verificadores conferidos. */
/**
 * Telefone com DDD (melhoria de 25/10/2026): fixo com 8 dígitos (começando de 2 a 5) ou celular com 9 (começando
 * por 9). Grava só os dígitos; aceita o 0 de longa distância e o +55 na digitação ou na planilha.
 */
export const Phone = {
  normalize(value) {
    let d = String(value ?? '').replace(/\D/g, '');
    if (d.length >= 12 && d.startsWith('55')) d = d.slice(2);
    if (d.length >= 11 && d.startsWith('0')) d = d.slice(1);
    return d;
  },
  isValid(value) {
    const d = Phone.normalize(value);
    return /^[1-9]{2}(?:9\d{8}|[2-5]\d{7})$/.test(d);
  },
  require(value, field = null) {
    if (value === null || value === undefined || String(value).trim() === '') {
      throw new BusinessRuleError('Informe o telefone com DDD.', field);
    }
    if (!Phone.isValid(value)) {
      throw new BusinessRuleError('Telefone inválido: informe o DDD e o número (celular com 9 dígitos, fixo com 8).', field);
    }
    return Phone.normalize(value);
  },
  /** (11) 91234-5678 ou (11) 3123-4567. */
  format(value) {
    const d = String(value ?? '');
    if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
    if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
    return d;
  },
};

export const Cpf = {
  normalize: (value) => String(value ?? '').replace(/\D/g, ''),
  isValid(value) {
    const d = Cpf.normalize(value);
    if (d.length !== 11 || new Set(d).size === 1) return false;
    const check = (digits) => {
      const rest = [...digits].reduce((sum, c, i) => sum + Number(c) * (digits.length + 1 - i), 0) % 11;
      return rest < 2 ? 0 : 11 - rest;
    };
    const first = check(d.slice(0, 9));
    const second = check(d.slice(0, 9) + first);
    return Number(d[9]) === first && Number(d[10]) === second;
  },
  require(value, field = null) {
    if (value === null || value === undefined || String(value).trim() === '') {
      throw new BusinessRuleError('Informe o CPF.', field);
    }
    if (!Cpf.isValid(value)) throw new BusinessRuleError('CPF inválido: confira os dígitos.', field);
    return Cpf.normalize(value);
  },
  format: (d) => (d.length === 11 ? `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}` : d),
  /** CPF mascarado para quem não vê os dados completos (LGPD): ***.456.789-**. */
  mask(value) {
    const d = Cpf.normalize(value);
    return d.length === 11 ? `***.${d.slice(3, 6)}.${d.slice(6, 9)}-**` : '***';
  },
};

/** Validações de datas de marcos (RN-24 e bloqueio de datas futuras). */
export const DateGuard = {
  notFuture(date, today, label, field = null) {
    if (date > today) throw new BusinessRuleError(`${label} não pode ser uma data futura.`, field);
  },
  /**
   * RN-24: com a carga inicial encerrada, data de marco anterior a hoje exige justificativa.
   * Devolve true quando a data é retroativa (para sinalizar a posição).
   */
  checkRetroactive(date, today, initialLoadOpen, justification, label) {
    if (initialLoadOpen || date >= today) return false;
    if (!clean(justification)) {
      throw new BusinessRuleError(`${label} é anterior à data de hoje. Informe uma justificativa.`, 'justification');
    }
    return true;
  },
  clean,
  requireText(text, message, field = null) {
    const value = clean(text);
    if (!value) throw new BusinessRuleError(message, field);
    return value;
  },
};

/** Texto livre: vazio vira nulo, espaços das pontas saem. */
export function clean(text) {
  if (text === null || text === undefined) return null;
  const value = String(text).trim();
  return value === '' ? null : value;
}

/** Texto de várias linhas: quebras padronizadas e pontas limpas; vazio = nulo. */
export function cleanMultiline(text) {
  if (text === null || text === undefined || String(text).trim() === '') return null;
  return String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
}

export const JOB_DESCRIPTION_MAX_LENGTH = 4000;

/** O usuário da operação: id, perfis e IP. */
export const hasRole = (user, role) => Boolean(user?.roles?.includes(role));
export const hasAnyRole = (user, roles) => roles.some((r) => hasRole(user, r));

export const Permissions = {
  require(user, ...roles) {
    if (!hasAnyRole(user, roles)) throw new ForbiddenError();
  },
  canSeeDetailedValues: (user) => hasAnyRole(user, SEE_DETAILED_VALUES),
  canSeeAggregatedValues: (user) => hasAnyRole(user, SEE_AGGREGATED_VALUES),
};

/** Quem executa o recrutamento do pedido: o Gestor de RH (qualquer pedido) ou um analista responsável por ele. */
export const RhAccess = {
  canAct: (user, order) => hasRole(user, Roles.RhManager)
    || (hasRole(user, Roles.Rh) && Boolean(user.id) && isRhAnalyst(order, user.id)),
  require(user, order) {
    if (RhAccess.canAct(user, order)) return;
    throw hasRole(user, Roles.Rh)
      ? new ForbiddenError('Você não está entre os analistas de RH responsáveis por este pedido.')
      : new ForbiddenError();
  },
};

export const isRhAnalyst = (order, userId) => (order.rhAnalysts ?? []).some((a) => !a.removedAt && a.userId === userId);

/**
 * Código interno do contrato: CT-AAAA-UNIDADE-SEQUENCIAL (ex.: CT-2026-LJ-001-0001). UNIDADE = código da unidade
 * contratante ou, sem unidade, o nome do cliente; SEQUENCIAL = 4 dígitos por ano e unidade. Gerado uma vez, nunca muda.
 */
export const ContractCode = {
  SEGMENT_MAX_LENGTH: 20,
  prefix: (year, segment) => `CT-${year}-${segment}-`,
  build: (year, segment, sequence) => `${ContractCode.prefix(year, segment)}${String(sequence).padStart(4, '0')}`,
  /** Maiúsculas, sem acentos, letras e dígitos separados por hífen, até 20 caracteres, cortando entre palavras. */
  segment(text) {
    const plain = String(text ?? '').normalize('NFD').replace(/\p{Mn}/gu, '')
      .replace(/[^A-Za-z0-9]/g, ' ').toUpperCase();
    const words = plain.split(' ').filter(Boolean);
    if (words.length === 0) return 'CLIENTE';
    let segment = words[0].slice(0, ContractCode.SEGMENT_MAX_LENGTH);
    for (const word of words.slice(1)) {
      if (segment.length + 1 + word.length > ContractCode.SEGMENT_MAX_LENGTH) break;
      segment += `-${word}`;
    }
    return segment;
  },
  /** Próximo sequencial a partir dos códigos já existentes com o mesmo prefixo. */
  nextSequence(prefix, codes) {
    let max = 0;
    for (const code of codes) {
      if (!code.startsWith(prefix)) continue;
      const tail = code.slice(prefix.length);
      const n = /^\d+$/.test(tail) ? Number(tail) : 0;
      if (n > max) max = n;
    }
    return max + 1;
  },
};

/** Anexos de evidência: PDF, JPG ou PNG de até 10 MB, conferidos pelo conteúdo do arquivo. */
export const EvidenceFiles = {
  MAX_BYTES: 10 * 1024 * 1024,
  FILE_NAME_MAX_LENGTH: 255,
  /** Valida e devolve o nome limpo e o tipo detectado pelo CONTEÚDO (não pelo que o navegador informou). */
  validate({ fileName, content }) {
    if (!content?.length) throw new BusinessRuleError('O arquivo de evidência está vazio.', 'evidence');
    if (content.length > EvidenceFiles.MAX_BYTES) throw new BusinessRuleError('A evidência deve ter no máximo 10 MB.', 'evidence');
    const type = detect(content);
    if (!type) throw new BusinessRuleError('Anexe um arquivo PDF, JPG ou PNG.', 'evidence');
    let name = String(fileName ?? '').replace(/\\/g, '/').split('/').pop() ?? '';
    name = [...name].filter((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127).join('').trim();
    if (!name) name = `evidencia${{ 'application/pdf': '.pdf', 'image/jpeg': '.jpg' }[type] ?? '.png'}`;
    if (name.length > EvidenceFiles.FILE_NAME_MAX_LENGTH) name = name.slice(-EvidenceFiles.FILE_NAME_MAX_LENGTH);
    return { fileName: name, contentType: type };
  },
};

function detect(c) {
  if (c.length >= 5 && c[0] === 0x25 && c[1] === 0x50 && c[2] === 0x44 && c[3] === 0x46 && c[4] === 0x2d) return 'application/pdf';
  if (c.length >= 3 && c[0] === 0xff && c[1] === 0xd8 && c[2] === 0xff) return 'image/jpeg';
  if (c.length >= 8 && c[0] === 0x89 && c[1] === 0x50 && c[2] === 0x4e && c[3] === 0x47 && c[4] === 0x0d
    && c[5] === 0x0a && c[6] === 0x1a && c[7] === 0x0a) return 'image/png';
  return null;
}
