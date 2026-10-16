/**
 * SQL portável entre SQLite (desenvolvimento e testes) e PostgreSQL (produção).
 *
 * A aplicação financeira escreveu o SQL no dialeto do SQLite e traduz funções de data no envio. Aqui a regra é mais
 * simples, porque o sistema nasceu com os dois bancos: as consultas usam só SQL comum aos dois, e toda conta de
 * datas é feita em JavaScript (as datas são texto ISO: 'AAAA-MM-DD' e 'AAAA-MM-DDTHH:MM:SS.sssZ', que ordenam e
 * comparam corretamente como texto nos dois bancos). A tradução se resume aos parâmetros: ? → $1, $2...
 *
 * O que é exclusivo de um dos bancos é recusado aqui, com a alternativa — melhor falhar no teste em SQLite do que
 * chegar ao PostgreSQL de produção com "função inexistente".
 */

const SQLITE_ONLY = [
  [/COLLATE\s+NOCASE/i, 'COLLATE NOCASE', 'compare lower() dos dois lados'],
  [/\bIFNULL\s*\(/i, 'IFNULL', 'use COALESCE'],
  [/\bINSTR\s*\(/i, 'INSTR', 'use LIKE'],
  [/\bdatetime\s*\(/i, "datetime()", 'calcule a data em JavaScript e passe como parâmetro'],
  [/\bjulianday\s*\(/i, 'julianday()', 'calcule a diferença de datas em JavaScript'],
  [/\bstrftime\s*\(/i, 'strftime()', 'formate a data em JavaScript'],
  [/\bGROUP_CONCAT\s*\(/i, 'GROUP_CONCAT', 'agregue em JavaScript'],
  [/\bROWID\b/i, 'ROWID', 'use a coluna id'],
];

const POSTGRES_ONLY = [
  [/::\w/, 'conversão com ::', 'use CAST(x AS tipo)'],
  [/\bILIKE\b/i, 'ILIKE', 'use lower(campo) LIKE lower(?)'],
  [/\$\d/, 'parâmetro $n', 'use ?'],
  [/\bnow\s*\(\)/i, 'now()', 'passe o instante como parâmetro'],
];

/** Recusa construções que só existem num dos bancos (vale para os dois drivers). */
export function assertPortable(sql) {
  for (const [pattern, name, alternative] of [...SQLITE_ONLY, ...POSTGRES_ONLY]) {
    if (pattern.test(stripLiterals(sql))) {
      throw new Error(`SQL não portável: "${name}" não existe nos dois bancos — ${alternative}.\nConsulta: ${sql.trim().slice(0, 200)}`);
    }
  }
}

/** Troca ? por $1, $2... fora dos literais de texto. */
export function toPostgres(sql) {
  let index = 0;
  let inText = false;
  let out = '';
  for (let i = 0; i < sql.length; i += 1) {
    const c = sql[i];
    if (inText) {
      out += c;
      if (c === "'") {
        if (sql[i + 1] === "'") {
          out += "'";
          i += 1;
        } else inText = false;
      }
      continue;
    }
    if (c === "'") {
      inText = true;
      out += c;
    } else if (c === '?') {
      index += 1;
      out += `$${index}`;
    } else out += c;
  }
  return out;
}

/** O texto dos literais não conta para a verificação de portabilidade ('?' ou '::' dentro de uma mensagem). */
function stripLiterals(sql) {
  return sql.replace(/'(?:[^']|'')*'/g, "''");
}
