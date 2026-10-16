/**
 * Cliente HTTP da API REST: JSON, cookie de sessão, CSRF automático e
 * tradução dos erros (ProblemDetails) para uma exceção que preserva os campos.
 */

/** Erro de API com o mapa campo → mensagem, para marcar cada campo no formulário. */
export class ApiError extends Error {
  constructor(message, { status, fields, code } = {}) {
    super(message);
    this.status = status;
    this.fields = fields ?? {};
    this.code = code;
  }
}

/** Avisa o app.js de sessão expirada (401 fora do login). */
export const events = new EventTarget();

/** Monta a query string descartando valores vazios, nulos e indefinidos. */
export function query(params) {
  if (!params) return '';
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === '' || value === null || value === undefined || value === false) continue;
    if (Array.isArray(value)) value.forEach((v) => search.append(key, v));
    else search.append(key, value);
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

/** Token CSRF emitido pela API no cookie XSRF-TOKEN (double-submit). */
function csrfToken() {
  const match = /(?:^|;\s*)XSRF-TOKEN=([^;]*)/.exec(document.cookie ?? '');
  return match ? decodeURIComponent(match[1]) : '';
}

/** "$.decisionAt", "DecisionAt" ou "request.date" → nome do campo no formulário. */
function fieldName(key) {
  const last = String(key).replace(/^\$\./, '').split('.').pop() ?? '';
  return last ? last[0].toLowerCase() + last.slice(1) : last;
}

function toError(status, problem) {
  const fields = {};
  for (const [key, messages] of Object.entries(problem?.errors ?? {})) {
    fields[fieldName(key)] = Array.isArray(messages) ? messages[0] : String(messages);
  }
  Object.assign(fields, problem?.campos ?? {});

  const fallback = {
    0: 'Não foi possível conectar ao servidor.',
    400: 'Dados inválidos. Revise os campos destacados.',
    401: 'Sessão expirada. Faça login novamente.',
    403: 'Você não tem permissão para executar esta ação.',
    404: 'Registro não encontrado.',
    429: 'Muitas tentativas. Aguarde um minuto e tente novamente.',
  };
  const message = problem?.detail ?? (problem?.errors ? fallback[400] : null) ?? fallback[status]
    ?? 'Ocorreu um erro inesperado. Tente novamente ou contate o administrador.';
  return new ApiError(message, { status, fields, code: problem?.title });
}

async function request(method, path, body) {
  const headers = { Accept: 'application/json' };
  // FormData (arquivo anexado): o navegador monta o multipart com o boundary.
  const isForm = typeof FormData !== 'undefined' && body instanceof FormData;
  if (body !== undefined && !isForm) headers['Content-Type'] = 'application/json';
  if (method !== 'GET') headers['X-XSRF-TOKEN'] = csrfToken();

  let response;
  try {
    response = await fetch(path, {
      method,
      headers,
      credentials: 'same-origin',
      body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
    });
  } catch {
    throw new ApiError('Não foi possível conectar ao servidor. Verifique a rede e tente novamente.', { status: 0 });
  }

  if (response.status === 401 && !path.startsWith('/api/auth/login') && !path.startsWith('/api/auth/me')) {
    events.dispatchEvent(new CustomEvent('session-expired'));
  }

  const text = response.status === 204 ? '' : await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }

  if (!response.ok) throw toError(response.status, data);
  return data;
}

export const api = {
  get: (path, params) => request('GET', path + query(params)),
  post: (path, body = {}) => request('POST', path, body),
  put: (path, body = {}) => request('PUT', path, body),
  /** POST multipart/form-data (campos + arquivo). */
  postForm: (path, formData) => request('POST', path, formData),

  health: () => request('GET', '/api/saude'),
  session: () => request('GET', '/api/auth/me'),
  login: (email, password) => request('POST', '/api/auth/login', { email, password }),
  logout: () => request('POST', '/api/auth/logout', {}),
  changePassword: (currentPassword, newPassword) =>
    request('POST', '/api/auth/change-password', { currentPassword, newPassword }),
};
