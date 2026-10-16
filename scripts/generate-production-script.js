import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { config } from '../src/config.js';
import { buildProductionScript, PRODUCTION_SCRIPT_PATH } from '../src/db/production-script.js';

/** Gera producao/criar-banco-postgres.sql (ver src/db/production-script.js). Uso: npm run script:producao */
const target = join(config.root, PRODUCTION_SCRIPT_PATH);
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, buildProductionScript(), 'utf8');
console.log(`Gerado: ${PRODUCTION_SCRIPT_PATH}`);
