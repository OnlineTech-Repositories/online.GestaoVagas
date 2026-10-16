import { parseArgs } from 'node:util';
import { config, emailMissing, emailProviderName } from '../src/config.js';
import { formatBr, localTime, today } from '../src/domain/dates.js';
import { closeSmtp, sendEmail } from '../src/services/email.js';

/**
 * Envia um e-mail de teste NA HORA, pelo provedor configurado, sem passar pela caixa de saída — para conferir a
 * configuração (chave, remetente verificado) antes de depender dos avisos da rotina diária.
 *
 *   npm run email:teste -- --para voce@empresa.com.br
 *
 * Lê a mesma configuração da aplicação (variáveis de ambiente ou .env; ENV_FILE aponta outro arquivo).
 */
const { values } = parseArgs({ options: { para: { type: 'string' } } });
const to = values.para?.trim();
if (!to || !/^[^\s@]+@[^\s@]+$/.test(to)) {
  console.error('\n  Uso: npm run email:teste -- --para voce@empresa.com.br\n');
  process.exit(1);
}

const { provider, fromEmail, fromName, smtp } = config.email;
const name = emailProviderName(provider);
console.log(`\n  Provedor:  ${name}${provider === 'smtp' ? ` (${smtp.host || 'SMTP_HOST vazio'}:${smtp.port}, `
  + `${smtp.secure ? 'TLS direto' : 'STARTTLS obrigatório'}, usuário ${smtp.user || '(nenhum)'})` : ' (API)'}`);
console.log(`  Remetente: ${fromName} <${fromEmail || '(remetente vazio)'}>`);
const missing = emailMissing();
if (missing.length) {
  console.error(`\n  O envio está desligado. Falta configurar: ${missing.join(', ')}.\n`);
  process.exit(1);
}

try {
  await sendEmail(to, '[Controle de Vagas] E-mail de teste',
    `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;color:#222">
  <p>Este é um e-mail de teste do Sistema de Controle de Vagas, enviado em ${formatBr(today())} às ${localTime()}.</p>
  <p>Se ele chegou, os avisos e o resumo diário também vão chegar.</p></div>`);
  console.log(`\n  Aceito pelo ${name} para ${to}. Confira a caixa de entrada (e o spam, no primeiro envio).\n`);
} catch (error) {
  console.error(`\n  O ${name} recusou o envio: ${error.message}\n`);
  process.exitCode = 1;
} finally {
  closeSmtp();
}
