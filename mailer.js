/**
 * Módulo de Envio de E-mail Automático de NFS-e (Nodemailer - Gmail SMTP)
 * Inclui templates personalizados por cliente e notificação de auditoria para o administrador.
 */

const nodemailer = require('nodemailer');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const MONTH_NAMES = [
  'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
  'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'
];

/**
 * Retorna mês e ano por extenso a partir da data de competência (DD/MM/AAAA) ou data atual
 */
function getCompetenciaDetails(competenciaStr) {
  let date = new Date();
  if (competenciaStr) {
    const parts = competenciaStr.split('/');
    if (parts.length === 3) {
      date = new Date(parseInt(parts[2], 10), parseInt(parts[1], 10) - 1, parseInt(parts[0], 10));
    }
  }
  return {
    mes: MONTH_NAMES[date.getMonth()],
    mesNumero: String(date.getMonth() + 1).padStart(2, '0'),
    ano: date.getFullYear()
  };
}

/**
 * Cria o transporte SMTP do Gmail
 */
function getTransporter() {
  const user = (process.env.GMAIL_USER || process.env.EMAIL_USER || 'wearebulkdesign@gmail.com').trim();
  const pass = (process.env.GMAIL_APP_PASSWORD || process.env.GMAIL_APP_PASS || process.env.GMAIL_PASS || process.env.EMAIL_PASS || '').trim();

  if (!pass) {
    return null;
  }

  return {
    user,
    transporter: nodemailer.createTransport({
      service: 'gmail',
      auth: { user, pass }
    })
  };
}

/**
 * Envia o e-mail da NFS-e para o cliente caso configurado
 * @param {object} params
 * @param {string} params.clientKey - ex: 'igreja'
 * @param {object} params.clientInfo - dados do cliente do config.json
 * @param {string} params.pdfPath - caminho completo do arquivo PDF gerado
 * @param {string} params.competencia - data de competência DD/MM/AAAA
 * @returns {Promise<{ sent: boolean, recipient?: string, subject?: string, error?: string }>}
 */
async function sendInvoiceEmail({ clientKey, clientInfo, pdfPath, competencia }) {
  if (!clientInfo || !clientInfo.email || !clientInfo.email.enabled) {
    console.log(`[Email] Cliente '${clientKey}' não possui envio automático de e-mail ativado.`);
    return { sent: false, reason: 'not_configured' };
  }

  const emailConfig = clientInfo.email;
  const recipient = emailConfig.to;
  if (!recipient) {
    console.warn(`[Email] Cliente '${clientKey}' está com e-mail ativado mas sem endereço 'to'.`);
    return { sent: false, reason: 'no_recipient' };
  }

  if (!fs.existsSync(pdfPath)) {
    throw new Error(`Arquivo PDF do DANFSE não encontrado para envio: ${pdfPath}`);
  }

  const mailAuth = getTransporter();
  if (!mailAuth) {
    console.warn('\n⚠️ [Email] GMAIL_APP_PASSWORD não encontrada no arquivo .env.');
    console.warn('[Email] O envio do e-mail não pôde ser realizado automaticamente.');
    return { sent: false, reason: 'no_credentials' };
  }

  const { mes, ano } = getCompetenciaDetails(competencia);

  // Renderizar templates de Assunto e Corpo
  let subject = emailConfig.subject || 'Nota Fiscal - {{mes}} de {{ano}}';
  subject = subject.replace(/{{mes}}/g, mes).replace(/{{ano}}/g, ano);

  let bodyHtml = emailConfig.body || 'Olá, tudo bem?<br><br>Segue a nota fiscal deste mês.<br><br>Obrigado!';
  bodyHtml = bodyHtml.replace(/{{mes}}/g, mes).replace(/{{ano}}/g, ano);
  const bodyText = bodyHtml.replace(/<br\s*[\/]?>/gi, '\n').replace(/<[^>]+>/g, '');

  const fromAddress = (process.env.EMAIL_FROM || 'william@bulkdesign.com.br').trim();

  console.log(`\n====================================================`);
  console.log(`📧 ENVIANDO E-MAIL COM DANFSE ANEXADO...`);
  console.log(`====================================================`);
  console.log(`De:       "William Kunitake" <${fromAddress}>`);
  console.log(`Para:     ${recipient}`);
  if (emailConfig.cc) console.log(`Cc:       ${emailConfig.cc}`);
  console.log(`Assunto:  ${subject}`);
  console.log(`Anexo:    ${path.basename(pdfPath)}`);
  console.log(`====================================================\n`);

  try {
    const info = await mailAuth.transporter.sendMail({
      from: `"William Kunitake" <${fromAddress}>`,
      replyTo: fromAddress,
      to: recipient,
      cc: emailConfig.cc || undefined,
      subject: subject,
      text: bodyText,
      html: bodyHtml,
      attachments: [
        {
          filename: path.basename(pdfPath),
          path: pdfPath
        }
      ]
    });

    console.log(`✅ [Email] E-mail enviado para o cliente com sucesso! MessageID: ${info.messageId}`);

    return {
      sent: true,
      recipient,
      subject,
      messageId: info.messageId
    };
  } catch (err) {
    console.error(`❌ [Email] Erro ao enviar e-mail para o cliente:`, err.message);
    return {
      sent: false,
      error: err.message
    };
  }
}

/**
 * Envia um e-mail de notificação com log de detalhes para o William (admin)
 */
async function sendAdminNotification({ clientKey, clientInfo, pdfPath, competencia, invoiceValue, clientEmailResult }) {
  const adminEmail = (process.env.ADMIN_NOTIFY_EMAIL || 'william.kunitake@gmail.com').trim();
  const mailAuth = getTransporter();
  if (!mailAuth) {
    console.warn('[Notificação Admin] Não foi possível enviar notificação: credenciais SMTP ausentes.');
    return;
  }

  const fromAddress = (process.env.EMAIL_FROM || 'william@bulkdesign.com.br').trim();
  const { mes, ano } = getCompetenciaDetails(competencia);
  const now = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });

  const subject = `[Sucesso] NFS-e Emitida e Enviada - ${clientInfo.name} (${mes}/${ano})`;

  const emailStatusText = clientEmailResult && clientEmailResult.sent
    ? `<span style="color: #2e7d32; font-weight: bold;">✅ Enviado com sucesso</span> para <code>${clientEmailResult.recipient}</code><br><small style="color: #777;">ID: ${clientEmailResult.messageId}</small>`
    : (clientInfo.email && clientInfo.email.enabled
        ? `<span style="color: #c62828; font-weight: bold;">⚠️ Falha no envio</span>: ${clientEmailResult?.error || 'Erro desconhecido'}`
        : `<span style="color: #555;">ℹ️ Envio de e-mail não ativado para este cliente</span>`);

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; line-height: 1.6; color: #222; max-width: 620px; margin: 20px auto; border: 1px solid #e1e4e8; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.05);">
      <div style="background: linear-gradient(135deg, #0f4c81, #1e70ba); color: white; padding: 22px; text-align: center;">
        <h2 style="margin: 0; font-size: 20px; font-weight: 600;">🚀 NFS-e Emitida e Processada</h2>
        <p style="margin: 6px 0 0; opacity: 0.9; font-size: 14px;">Relatório de Operação Automática</p>
      </div>

      <div style="padding: 24px; background: #ffffff;">
        <p style="margin-top: 0; font-size: 15px;">Olá, <strong>William</strong>,</p>
        <p style="font-size: 14px; color: #444;">A automação concluiu a emissão da NFS-e oficial e o download do DANFSE com sucesso. Segue o relatório detalhado da operação:</p>

        <table style="width: 100%; border-collapse: collapse; margin: 20px 0; font-size: 14px;">
          <tr style="border-bottom: 1px solid #f0f0f0;">
            <td style="padding: 10px 0; color: #666; width: 35%;">Tomador (Cliente):</td>
            <td style="padding: 10px 0; font-weight: 600; color: #111;">${clientInfo.name}</td>
          </tr>
          <tr style="border-bottom: 1px solid #f0f0f0;">
            <td style="padding: 10px 0; color: #666;">CNPJ do Tomador:</td>
            <td style="padding: 10px 0; font-family: monospace;">${clientInfo.cnpj}</td>
          </tr>
          <tr style="border-bottom: 1px solid #f0f0f0;">
            <td style="padding: 10px 0; color: #666;">Valor Total:</td>
            <td style="padding: 10px 0; color: #2e7d32; font-weight: bold; font-size: 16px;">R$ ${invoiceValue || clientInfo.default_value || '150,00'}</td>
          </tr>
          <tr style="border-bottom: 1px solid #f0f0f0;">
            <td style="padding: 10px 0; color: #666;">Competência:</td>
            <td style="padding: 10px 0;">${mes} de ${ano}</td>
          </tr>
          <tr style="border-bottom: 1px solid #f0f0f0;">
            <td style="padding: 10px 0; color: #666;">Disparo de E-mail:</td>
            <td style="padding: 10px 0;">${emailStatusText}</td>
          </tr>
          <tr style="border-bottom: 1px solid #f0f0f0;">
            <td style="padding: 10px 0; color: #666;">Data / Hora:</td>
            <td style="padding: 10px 0;">${now}</td>
          </tr>
          <tr>
            <td style="padding: 10px 0; color: #666;">Arquivo DANFSE:</td>
            <td style="padding: 10px 0; font-family: monospace; font-size: 12px; color: #0f4c81;">${path.basename(pdfPath)}</td>
          </tr>
        </table>

        <div style="background-color: #f7fafc; border: 1px solid #e2e8f0; border-radius: 6px; padding: 14px; margin-top: 15px; font-size: 13px; color: #4a5568;">
          <strong style="color: #2d3748;">📌 Log de Execução:</strong>
          <ul style="margin: 8px 0 0; padding-left: 20px; color: #4a5568;">
            <li>Login no Emissor Nacional via sessão autenticada</li>
            <li>Formulário de 4 etapas preenchido e validado pela Receita Federal</li>
            <li>NFS-e gerada no portal da Receita Federal</li>
            <li>hCaptcha resolvido via API 2Captcha em segundo plano (headless)</li>
            <li>DANFSE PDF interceptado e armazenado na pasta <code>invoices/</code></li>
            <li>Cópia do DANFSE anexada a esta mensagem para seu arquivo</li>
          </ul>
        </div>
      </div>

      <div style="background-color: #f8fafc; padding: 14px; text-align: center; font-size: 12px; color: #718096; border-top: 1px solid #edf2f7;">
        Automação de NFS-e • Bulk Design • Enviado para ${adminEmail}
      </div>
    </div>
  `;

  console.log(`\n====================================================`);
  console.log(`📨 ENVIANDO NOTIFICAÇÃO DE SUCESSO PARA O ADMIN...`);
  console.log(`====================================================`);
  console.log(`De:       "NFS-e Automador" <${fromAddress}>`);
  console.log(`Para:     ${adminEmail}`);
  console.log(`Assunto:  ${subject}`);
  console.log(`====================================================\n`);

  try {
    const info = await mailAuth.transporter.sendMail({
      from: `"NFS-e Automador" <${fromAddress}>`,
      replyTo: fromAddress,
      to: adminEmail,
      subject: subject,
      html: html,
      attachments: fs.existsSync(pdfPath) ? [{ filename: path.basename(pdfPath), path: pdfPath }] : []
    });

    console.log(`✅ [Notificação Admin] E-mail de confirmação entregue com sucesso! MessageID: ${info.messageId}`);
    return { sent: true, messageId: info.messageId };
  } catch (err) {
    console.error(`❌ [Notificação Admin] Erro ao enviar confirmação para ${adminEmail}:`, err.message);
    return { sent: false, error: err.message };
  }
}

module.exports = {
  sendInvoiceEmail,
  sendAdminNotification,
  getCompetenciaDetails
};
