/**
 * Script utilitário para envio manual ou teste de e-mail de NFS-e já emitida.
 * Uso: node send-email.js --client igreja [--pdf caminho/para/danfse.pdf]
 */

const path = require('path');
const fs = require('fs');
const configPath = fs.existsSync(path.join(__dirname, 'config.json'))
  ? path.join(__dirname, 'config.json')
  : path.join(__dirname, 'config.example.json');
const config = require(configPath);
const { sendInvoiceEmail, sendAdminNotification } = require('./mailer');

function parseArgs() {
  const args = process.argv.slice(2);
  const options = { client: 'igreja', pdf: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--client' && args[i + 1]) options.client = args[++i];
    if (args[i] === '--pdf' && args[i + 1]) options.pdf = args[++i];
  }
  return options;
}

async function run() {
  const options = parseArgs();
  const clientKey = options.client.toLowerCase();
  const clientInfo = config.clients[clientKey];

  if (!clientInfo) {
    console.error(`❌ Cliente '${clientKey}' não encontrado no config.json.`);
    process.exit(1);
  }

  let pdfPath = options.pdf;
  if (!pdfPath) {
    // Buscar a nota fiscal mais recente do cliente na pasta invoices/
    const invoicesDir = path.join(__dirname, 'invoices');
    if (fs.existsSync(invoicesDir)) {
      const files = fs.readdirSync(invoicesDir)
        .filter(f => f.endsWith('.pdf'))
        .map(f => ({ name: f, time: fs.statSync(path.join(invoicesDir, f)).mtime.getTime() }))
        .sort((a, b) => b.time - a.time);

      if (files.length > 0) {
        pdfPath = path.join(invoicesDir, files[0].name);
      }
    }
  }

  if (!pdfPath || !fs.existsSync(pdfPath)) {
    console.error(`❌ Nenhum PDF encontrado para envio em: ${pdfPath || 'invoices/'}`);
    process.exit(1);
  }

  console.log(`Enviando última nota encontrada: ${pdfPath}`);
  const result = await sendInvoiceEmail({
    clientKey,
    clientInfo,
    pdfPath,
    competencia: null
  });

  if (result.sent) {
    console.log(`🎉 Sucesso! E-mail entregue ao servidor para: ${result.recipient}`);
  } else {
    console.error(`Falha: ${result.reason || result.error}`);
  }

  // Notificar admin
  await sendAdminNotification({
    clientKey,
    clientInfo,
    pdfPath,
    competencia: null,
    invoiceValue: clientInfo.default_value,
    clientEmailResult: result
  });
}

run();
