import { config } from '../config.js';

/**
 * Modelo visual dos e-mails do sistema (melhoria pedida pelo usuário em 19/10/2026): cabeçalho com a logo e o nome do
 * sistema, saudação, título e resumo do evento, situação em destaque, quadro de informações, providência esperada,
 * botão para o registro e rodapé de mensagem automática.
 *
 * HTML de e-mail, não de página: tabelas e estilos inline (o Outlook ignora <style> e flexbox; o Gmail remove classes),
 * largura máxima de 600 px que encolhe no celular, fonte de sistema e cores da identidade (azul #0f62b4). A logo é
 * imagem hospedada no próprio sistema; onde a imagem é bloqueada (o Outlook bloqueia por padrão), o texto ao lado
 * continua identificando o sistema e a empresa. Todo texto vindo de usuário passa por `esc`.
 */

export const esc = (text) => String(text ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const FONT = "'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const BLUE = '#0f62b4';
const INK = '#1b2430';
const SOFT = '#55606e';
const FAINT = '#8a94a1';
const LINE = '#e3e8ee';

/** Cor de fundo, borda e texto de cada tom de situação (os mesmos significados das etiquetas da tela). */
export const TONES = Object.freeze({
  info: { bg: '#e8f1fb', border: '#bcd8f2', text: '#0b4a8a' },
  success: { bg: '#e6f4ec', border: '#b7dfc5', text: '#1e7a3e' },
  warning: { bg: '#fdf3e2', border: '#f2d39b', text: '#8a5a00' },
  danger: { bg: '#fdecea', border: '#f3c1bb', text: '#a3261a' },
  neutral: { bg: '#eef1f5', border: '#d5dbe3', text: '#455261' },
});

const tone = (name) => TONES[name] ?? TONES.neutral;

/** Etiqueta de situação (texto sempre presente: a cor só reforça). */
const badge = (status) => {
  if (!status?.label) return '';
  const t = tone(status.tone);
  return `<span style="display:inline-block;padding:4px 10px;border-radius:999px;background:${t.bg};border:1px solid ${t.border};`
    + `color:${t.text};font-size:12px;font-weight:600;letter-spacing:.02em">${esc(status.label)}</span>`;
};

/** Quadro de informações: rótulo à esquerda, valor à direita; `strong` destaca valores, prazos e situações. */
function fieldsTable(fields) {
  const rows = (fields ?? []).filter((f) => f && f[1] !== null && f[1] !== undefined && f[1] !== '');
  if (!rows.length) return '';
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
    style="border-collapse:collapse;margin:18px 0 4px;border:1px solid ${LINE};border-radius:8px">
${rows.map(([label, value, options = {}], i) => {
    const t = options.tone ? tone(options.tone) : null;
    return `  <tr>
    <td valign="top" style="padding:10px 14px;${i ? `border-top:1px solid ${LINE};` : ''}width:38%;font-family:${FONT};font-size:13px;color:${SOFT}">${esc(label)}</td>
    <td valign="top" style="padding:10px 14px;${i ? `border-top:1px solid ${LINE};` : ''}font-family:${FONT};font-size:14px;color:${t ? t.text : INK};`
      + `font-weight:${options.strong || t ? 700 : 500}">${esc(value)}</td>
  </tr>`;
  }).join('\n')}
</table>`;
}

/** Providência esperada: quadro com borda colorida, logo depois das informações. */
function actionBox(action, statusTone) {
  if (!action) return '';
  const t = tone(statusTone === 'success' ? 'info' : statusTone ?? 'info');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:16px 0 4px">
  <tr><td style="padding:12px 14px;background:${t.bg};border-left:4px solid ${t.text};border-radius:4px;font-family:${FONT};font-size:14px;color:${INK}">
    <strong style="color:${t.text}">O que fazer:</strong> ${esc(action)}
  </td></tr>
</table>`;
}

/** Botão "à prova de Outlook": célula colorida com o link ocupando a área toda. */
function buttonBlock(label, href) {
  if (!href) return '';
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:22px 0 6px">
  <tr><td align="center" bgcolor="${BLUE}" style="border-radius:6px">
    <a href="${esc(href)}" target="_blank"
      style="display:inline-block;padding:12px 24px;font-family:${FONT};font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:6px">${esc(label || 'Abrir no sistema')}</a>
  </td></tr>
</table>
<p style="margin:6px 0 0;font-family:${FONT};font-size:12px;color:${FAINT}">Se o botão não abrir, copie o endereço:
  <a href="${esc(href)}" style="color:${BLUE};word-break:break-all">${esc(href)}</a></p>`;
}

/**
 * E-mail completo.
 * @param {{ preheader?: string, recipientName: string, title: string, summary?: string,
 *           status?: { label: string, tone?: string }, fields?: Array<[string, any, object?]>, action?: string,
 *           button?: string, link?: string, bodyHtml?: string, footerNote?: string }} m
 */
export function renderLayout(m) {
  const logo = config.baseUrl
    ? `<img src="${esc(`${config.baseUrl}/img/logo-online-gestao.png`)}" width="120" height="49" alt="Online Gestão"
        style="display:block;border:0;outline:none;width:120px;height:auto;font-family:${FONT};font-size:14px;color:${INK}">`
    : `<span style="font-family:${FONT};font-size:16px;font-weight:700;color:${INK}">Online Gestão</span>`;
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>${esc(m.title)}</title>
</head>
<body style="margin:0;padding:0;background:#f3f5f8">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">${esc(m.preheader ?? m.summary ?? '')}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f3f5f8">
<tr><td align="center" style="padding:24px 12px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
    style="max-width:600px;background:#ffffff;border:1px solid ${LINE};border-radius:10px;border-collapse:separate;overflow:hidden">
    <tr><td style="height:5px;line-height:5px;font-size:0;background:${BLUE}">&nbsp;</td></tr>
    <tr><td style="padding:18px 24px;border-bottom:1px solid ${LINE}">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
        <td valign="middle">${logo}</td>
        <td valign="middle" align="right" style="font-family:${FONT}">
          <div style="font-size:15px;font-weight:700;color:${BLUE}">Controle de Vagas</div>
          <div style="font-size:12px;color:${SOFT}">Grupo ON LINE</div>
        </td>
      </tr></table>
    </td></tr>
    <tr><td style="padding:24px 24px 8px;font-family:${FONT};color:${INK}">
      <p style="margin:0 0 16px;font-size:15px">Olá, ${esc(m.recipientName)}.</p>
      ${m.status?.label ? `<div style="margin:0 0 10px">${badge(m.status)}</div>` : ''}
      <h1 style="margin:0 0 8px;font-family:${FONT};font-size:20px;line-height:1.3;color:${INK}">${esc(m.title)}</h1>
      ${m.summary ? `<p style="margin:0;font-size:15px;line-height:1.55;color:${SOFT}">${esc(m.summary)}</p>` : ''}
      ${fieldsTable(m.fields)}
      ${actionBox(m.action, m.status?.tone)}
      ${m.bodyHtml ?? ''}
      ${buttonBlock(m.button, m.link)}
    </td></tr>
    <tr><td style="padding:18px 24px 22px">
      <p style="margin:0;padding-top:14px;border-top:1px solid ${LINE};font-family:${FONT};font-size:12px;line-height:1.5;color:${FAINT}">
        ${esc(m.footerNote ?? 'Mensagem automática do Sistema de Controle de Vagas — Grupo ON LINE.')}
        Não responda este e-mail: as ações são feitas no sistema.
      </p>
    </td></tr>
  </table>
</td></tr>
</table>
</body>
</html>`;
}

/** Tabela de dados no corpo (resumo diário): cabeçalho cinza claro, linhas separadas. */
export function dataTable(headers, rows) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
  style="border-collapse:collapse;margin:6px 0 10px;border:1px solid ${LINE}">
  <tr>${headers.map((h) => `<th align="left" style="padding:8px 10px;background:#f5f7fa;border-bottom:1px solid ${LINE};font-family:${FONT};font-size:12px;color:${SOFT};font-weight:600">${esc(h)}</th>`).join('')}</tr>
  ${rows.map((r) => `<tr>${r.map((v) => `<td valign="top" style="padding:8px 10px;border-top:1px solid ${LINE};font-family:${FONT};font-size:13px;color:${INK}">${esc(v)}</td>`).join('')}</tr>`).join('\n  ')}
</table>`;
}

export const sectionTitle = (text) =>
  `<h2 style="margin:22px 0 4px;font-family:${FONT};font-size:16px;color:${INK}">${esc(text)}</h2>`;

export const mutedText = (text) => `<p style="margin:4px 0 8px;font-family:${FONT};font-size:13px;color:${FAINT}">${esc(text)}</p>`;
