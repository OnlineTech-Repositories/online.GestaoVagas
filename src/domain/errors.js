/**
 * Exceções de domínio, traduzidas em respostas HTTP num lugar só (middleware.js → handleErrors).
 *
 * O contrato de erro é o mesmo da API .NET (ProblemDetails): { status, title, detail, campos? }. O front-end lê
 * `detail` para a mensagem e `campos` para marcar cada campo recusado no formulário.
 */

/** Regra de negócio violada (422). `field` = campo do formulário que a tela deve marcar. */
export class BusinessRuleError extends Error {
  constructor(message, field = null) {
    super(message);
    this.field = field;
    this.status = 422;
    this.title = 'Regra de negócio';
  }
}

/** Entrada malformada (400): acumula os campos inválidos para a tela corrigir tudo de uma vez. */
export class ValidationError extends Error {
  constructor(fields, message = null) {
    const first = Object.values(fields)[0];
    super(message ?? (Object.keys(fields).length === 1 ? first : 'Dados inválidos. Revise os campos destacados.'));
    this.fields = fields;
    this.status = 400;
    this.title = 'Requisição inválida';
  }
}

export class NotFoundError extends Error {
  constructor(message) {
    super(message);
    this.status = 404;
    this.title = 'Não encontrado';
  }
}

/** Usuário autenticado sem permissão para a ação (403). */
export class ForbiddenError extends Error {
  constructor(message = 'Você não tem permissão para executar esta ação.') {
    super(message);
    this.status = 403;
    this.title = 'Acesso negado';
  }
}

/**
 * Outra pessoa gravou o mesmo registro entre a leitura e a gravação (409). Sem esta verificação, duas ações
 * concorrentes sobre a mesma posição respondiam sucesso às duas e a segunda apagava a primeira sem ninguém notar.
 */
export class ConflictError extends Error {
  constructor(message = 'O registro foi alterado por outra pessoa enquanto esta tela estava aberta. Recarregue e tente novamente.') {
    super(message);
    this.status = 409;
    this.title = 'Conflito';
  }
}
