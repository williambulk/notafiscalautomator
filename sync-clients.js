const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

async function ensureLoggedIn(page) {
  const loginInput = await page.$('#Inscricao');
  if (loginInput) {
    console.log('[Auth] Logging in...');
    const cnpj = (process.env.cnpj || process.env.CNPJ || '').trim();
    const senha = (process.env.senha || process.env.SENHA || '').trim();
    await page.fill('#Inscricao', cnpj);
    await page.fill('#Senha', senha);
    await page.click('button[type="submit"]');
    await page.waitForNavigation({ waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForTimeout(2000);
  }
}

function formatDate(d) {
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

(async () => {
  const profileDir = path.join(__dirname, '.auth', 'user-data');
  const configPath = path.join(__dirname, 'config.json');

  console.log('Connecting to Emissor Nacional to sync clients...');
  const context = await chromium.launchPersistentContext(profileDir, {
    channel: 'chrome',
    headless: false,
    viewport: { width: 1280, height: 900 },
    args: ['--disable-blink-features=AutomationControlled']
  });

  const page = context.pages()[0] || await context.newPage();
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  await page.goto('https://www.nfse.gov.br/EmissorNacional/Notas/Emitidas', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  await ensureLoggedIn(page);

  const allClients = new Map();

  async function extractRows() {
    return await page.evaluate(() => {
      const rows = [];
      document.querySelectorAll('table.table tbody tr').forEach(tr => {
        const tds = Array.from(tr.querySelectorAll('td')).map(td => td.innerText.trim());
        if (tds.length >= 6) {
          rows.push({
            emitidaPara: tds[1],
            precoServico: tds[4]
          });
        }
      });
      return rows;
    });
  }

  // Iterate backwards in 28-day steps
  let endDate = new Date();
  const minDate = new Date(2023, 0, 1);
  let consecutiveEmpty = 0;

  while (endDate > minDate && consecutiveEmpty < 5) {
    let startDate = new Date(endDate);
    startDate.setDate(startDate.getDate() - 28);

    const sStr = formatDate(startDate);
    const eStr = formatDate(endDate);

    await page.fill('#datainicio', sStr);
    await page.fill('#datafim', eStr);
    await page.click('button:has-text("Filtrar")');
    await page.waitForTimeout(2000);

    const rows = await extractRows();
    if (rows.length > 0) {
      consecutiveEmpty = 0;
      for (const r of rows) {
        if (!allClients.has(r.emitidaPara)) {
          allClients.set(r.emitidaPara, r.precoServico);
        }
      }
    } else {
      consecutiveEmpty++;
    }

    endDate = new Date(startDate);
    endDate.setDate(endDate.getDate() - 1);
  }

  console.log(`Discovered ${allClients.size} unique entries.`);

  const configData = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  if (!configData.clients) configData.clients = {};

  for (const [emitidaPara, preco] of allClients.entries()) {
    const match = emitidaPara.match(/^([\d\.\/\-]+)\s*-\s*(.+)$/);
    if (!match) continue;

    const cnpj = match[1].trim();
    const name = match[2].trim();

    // Check if client already exists by CNPJ
    let existingSlug = Object.keys(configData.clients).find(k =>
      configData.clients[k].cnpj.replace(/\D/g, '') === cnpj.replace(/\D/g, '')
    );

    if (!existingSlug) {
      let slug = name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '_').split('_')[0] || 'cliente';
      let finalSlug = slug;
      let counter = 1;
      while (configData.clients[finalSlug]) {
        finalSlug = `${slug}_${counter++}`;
      }
      existingSlug = finalSlug;
    }

    const valorLimpo = preco.replace('R$', '').trim();
    configData.clients[existingSlug] = {
      name: name,
      cnpj: cnpj,
      default_value: valorLimpo,
      description: configData.clients[existingSlug]?.description || configData.servico_padrao.descricao_padrao
    };
  }

  fs.writeFileSync(configPath, JSON.stringify(configData, null, 2), 'utf8');
  console.log('✅ Client sync complete!');
  await context.close();
})();
