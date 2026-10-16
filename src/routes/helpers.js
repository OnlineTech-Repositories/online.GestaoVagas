import { NotFoundError } from '../domain/errors.js';
import { routeId } from '../services/input.js';

/** Id da rota; inválido responde 404, como a restrição {id:guid} das rotas da versão .NET. */
export function idParam(req, name = 'id') {
  const id = routeId(req.params[name]);
  if (!id) throw new NotFoundError('Registro não encontrado.');
  return id;
}

/** Query string com os parâmetros que aceitam vários valores sempre como lista (status=A&status=B). */
export function queryOf(req, multi = []) {
  const out = { ...req.query };
  for (const key of multi) {
    const value = out[key];
    if (value === undefined) continue;
    out[key] = Array.isArray(value) ? value : [value];
  }
  return out;
}

/** Padrão de id nas rotas: separa /api/orders/job-roles de /api/orders/:id. */
export const ID = '([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})';
