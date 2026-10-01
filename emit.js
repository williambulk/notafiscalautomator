/**
 * Automador de Emissão de NFS-e (Portal Nacional - Emissor Nacional)
 * Suporta modo Dry-Run (conferência) e Emissão Oficial com download do DANFSE PDF.
 */

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const configPath = fs.existsSync(path.join(__dirname, 'config.json'))
  ? path.join(__dirname, 'config.json')
  : path.join(__dirname, 'config.example.json');
const config = require(configPath);
const { autoSolveHCaptchaIfConfigured, getActiveProvider } = require('./captcha-solver');
const { sendInvoiceEmail, sendAdminNotification } = require('./mailer');

function parseArgs() {
  const args = process.argv.slice(2);
  const provider = getActiveProvider();
  const options = {
    client: 'igreja',
    all: false,
    value: null,
    description: null,
    date: null,
    dryRun: false,
    loginOnly: false,
    headless: args.includes('--headless') ? true : false
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--emit') options.dryRun = false;
    else if (arg === '--login-only') options.loginOnly = true;
    else if (arg === '--all') options.all = true;
    else if (arg === '--headless') options.headless = true;
    else if (arg === '--headed') options.headless = false;
    else if (arg === '--client' && args[i + 1]) options.client = args[++i];
    else if (arg === '--value' && args[i + 1]) options.value = args[++i];
    else if (arg === '--description' && args[i + 1]) options.description = args[++i];
    else if (arg === '--date' && args[i + 1]) options.date = args[++i];
  }

  if (options.client === 'all') options.all = true;
  return options;
}

function resolveClient(clientKey) {
  const normalizedKey = clientKey.toLowerCase().trim();
  if (config.clients[normalizedKey]) {
    return config.clients[normalizedKey];
  }

  // Check if raw CNPJ was passed
  const cleanedInput = clientKey.replace(/\D/g, '');
  for (const key of Object.keys(config.clients)) {
    const c = config.clients[key];
    if (c.cnpj.replace(/\D/g, '') === cleanedInput) {
      return c;
    }
  }

  // Fallback as new/ad-hoc client
  return {
    name: clientKey,
    cnpj: clientKey,
    default_value: '150,00',
    description: config.servico_padrao.descricao_padrao
  };
}

function formatCurrency(val) {
  if (!val) return '150,00';
  let clean = String(val).trim().replace('R$', '').trim();
  if (clean.includes('.')) {
    const parts = clean.split('.');
    if (parts[1].length === 2) {
      return `${parts[0]},${parts[1]}`;
    }
  }
  if (!clean.includes(',')) {
    return `${clean},00`;
  }
  return clean;
}

async function navigateWithRetry(page, url, maxRetries = 4) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`[Portal] Navegando para ${url} (tentativa ${attempt}/${maxRetries})...`);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(2000);

      const content = await page.content();
      if (content.includes('The service is unavailable') || content.includes('503 Service Unavailable')) {
        console.warn(`[Portal] Instabilidade temporária detectada (503). Aguardando 4s antes de retentar...`);
        await page.waitForTimeout(4000);
        continue;
      }

      return;
    } catch (err) {
      console.warn(`[Portal] Erro de rede: ${err.message}. Retentando em 4s...`);
      await page.waitForTimeout(4000);
    }
  }
  throw new Error(`Não foi possível conectar ao Emissor Nacional após ${maxRetries} tentativas.`);
}

async function ensureLoggedIn(page) {
  const loginInput = await page.$('#Inscricao');
  if (loginInput) {
    console.log('[Auth] Formulário de login detectado. Autenticando com credenciais do .env...');
    const cnpj = (process.env.cnpj || process.env.CNPJ || '').trim();
    const senha = (process.env.senha || process.env.SENHA || '').trim();

    if (!cnpj || !senha) {
      throw new Error('Credenciais não encontradas. Certifique-se de preencher cnpj e senha no arquivo .env.');
    }

    await page.fill('#Inscricao', cnpj);
    await page.fill('#Senha', senha);
    await page.click('button[type="submit"]');
    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(2500);

    const errorEl = await page.$('.alert-danger, .field-validation-error');
    if (errorEl) {
      const msg = await errorEl.innerText();
      throw new Error(`Falha no login do Emissor Nacional: ${msg.trim()}`);
    }
    console.log('[Auth] Login realizado com sucesso!');
  }
}

async function emitInvoiceForClient(page, context, clientKey, options, dirs) {
  const { screenshotsDir, invoicesDir } = dirs;
  const clientInfo = resolveClient(clientKey);
  const invoiceValue = formatCurrency(options.value || clientInfo.default_value);
  const serviceDesc = options.description || clientInfo.description || config.servico_padrao.descricao_padrao;

  const today = new Date();
  const competencia = options.date || `${String(today.getDate()).padStart(2, '0')}/${String(today.getMonth() + 1).padStart(2, '0')}/${today.getFullYear()}`;

  console.log('\n====================================================');
  console.log(`📄 EMISSÃO DE NFS-e: ${clientInfo.name}`);
  console.log('====================================================');
  console.log(`👤 Prestador:  ${config.prestador.nome} (${config.prestador.cnpj})`);
  console.log(`🏢 Tomador:    ${clientInfo.name} (${clientInfo.cnpj})`);
  console.log(`💰 Valor:      R$ ${invoiceValue}`);
  console.log(`📅 Data:       ${competencia}`);
  console.log(`📝 Descrição:  ${serviceDesc}`);
  console.log(`⚙️  Modo:       ${options.dryRun ? 'DRY-RUN (Simulação/Conferência)' : 'EMISSÃO OFICIAL'}`);
  console.log('====================================================\n');

  try {
    // Garantir sessão ativa no Dashboard antes de navegar para emissão
    await navigateWithRetry(page, 'https://www.nfse.gov.br/EmissorNacional/Dashboard');
    await ensureLoggedIn(page);

    // Passo 1: Informações Gerais e Pessoas (com retry resiliente contra instabilidade do Serpro)
    let step1Success = false;
    for (let step1Attempt = 1; step1Attempt <= 4; step1Attempt++) {
      try {
        console.log(`[Passo 1/4] Carregando tela de Pessoas (tentativa ${step1Attempt}/4)...`);
        await navigateWithRetry(page, 'https://www.nfse.gov.br/EmissorNacional/DPS/Pessoas');
        await ensureLoggedIn(page);

        // Aguardar o Serpro resolver o cadastro do contribuinte
        let contribuinteOk = false;
        for (let waitContr = 0; waitContr < 5; waitContr++) {
          await page.waitForTimeout(2000);
          const hasContribuinteError = await page.evaluate(() => {
            const text = document.body ? document.body.innerText : '';
            return text.includes('Não foi possível recuperar informações do contribuinte');
          });
          if (hasContribuinteError) {
            console.warn(`[Passo 1/4] ⚠️ Serpro ainda não carregou o cadastro. Aguardando 3s...`);
            await page.waitForTimeout(3000);
            await page.reload({ waitUntil: 'domcontentloaded' });
            await ensureLoggedIn(page);
          } else {
            contribuinteOk = true;
            break;
          }
        }

        if (!contribuinteOk) {
          throw new Error('Não foi possível recuperar informações do contribuinte após aguardar.');
        }

        console.log('[Passo 1/4] Preenchendo Informações Gerais e Pessoas...');

        // 1. IBS/CBS = Não
        const naoLabel = await page.locator('label', { hasText: 'Não' }).first();
        if (await naoLabel.isVisible()) {
          await naoLabel.click();
        } else {
          await page.check('input[name="PreencherInfoIBSCBS"][value="0"]', { force: true });
        }
        await page.waitForTimeout(500);

        // 2. Data de Competência
        await page.fill('#DataCompetencia', competencia);
        await page.keyboard.press('Tab');
        await page.waitForTimeout(500);

        // 3. Tomador CNPJ/CPF
        console.log(`[Passo 1/4] Consultando tomador: ${clientInfo.cnpj}...`);
        await page.fill('#Tomador_Inscricao', clientInfo.cnpj);
        await page.waitForTimeout(300);
        await page.click('#btn_Tomador_Inscricao_pesquisar');
        await page.waitForTimeout(2500);

        const tomadorResolvido = await page.$eval('#Tomador_Nome', el => el.value).catch(() => '');
        if (tomadorResolvido) {
          console.log(`[Passo 1/4] ✅ Tomador confirmado pela Receita: ${tomadorResolvido}`);
        }

        // Avançar para o Passo 2: Serviço
        console.log('[Passo 1/4] Avançando para Passo 2 (Serviço)...');
        await page.locator('#btnAvancar').click({ noWaitAfter: true });
        await page.waitForURL('**/DPS/Servico**', { waitUntil: 'domcontentloaded', timeout: 25000 });
        step1Success = true;
        break;
      } catch (err) {
        console.warn(`[Passo 1/4] Falha na tentativa ${step1Attempt}: ${err.message}. Retentando Passo 1 em 4s...`);
        await page.waitForTimeout(4000);
      }
    }

    if (!step1Success) {
      throw new Error('Não foi possível concluir o Passo 1 após múltiplas tentativas devido à instabilidade do portal.');
    }
    await page.waitForTimeout(2000);

    // Passo 2: Serviço
    console.log('[Passo 2/4] Preenchendo dados do Serviço prestado...');

    // 1. Município (Select2)
    const munCity = config.servico_padrao.municipio_prestacao || 'Curitiba';
    console.log(`[Passo 2/4] Selecionando município: ${munCity}...`);
    const munSelect2 = page.locator('span[aria-labelledby*="LocalPrestacao_CodigoMunicipioPrestacao"]');
    await munSelect2.click();
    await page.waitForTimeout(500);
    await page.keyboard.type(munCity);
    await page.waitForTimeout(1000);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1500);

    // 2. Código de Tributação Nacional (Select2)
    const tribCode = config.servico_padrao.codigo_tributacao_nacional || '01.03.02';
    console.log(`[Passo 2/4] Selecionando código de tributação: ${tribCode}...`);
    const tribSelect2 = page.locator('span[aria-labelledby*="ServicoPrestado_CodigoTributacaoNacional"]');
    await tribSelect2.waitFor({ state: 'visible' });
    await tribSelect2.click();
    await page.waitForTimeout(500);
    await page.keyboard.type(tribCode);
    await page.waitForTimeout(1000);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(2000);

    // 3. Imunidade / Exportação: Não
    console.log('[Passo 2/4] Selecionando Imunidade: Não...');
    await page.evaluate(() => {
      const radio = document.querySelector('input#ServicoPrestado_HaExportacaoImunidadeNaoIncidencia[value="0"]');
      if (radio) {
        radio.checked = true;
        if (window.jQuery) window.jQuery(radio).trigger('change');
        else radio.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
    await page.waitForTimeout(1000);

    // 4. Descrição do Serviço
    console.log('[Passo 2/4] Preenchendo descrição do serviço...');
    await page.evaluate(() => {
      const textarea = document.querySelector('#ServicoPrestado_Descricao');
      if (textarea) {
        textarea.removeAttribute('readonly');
        textarea.removeAttribute('disabled');
      }
    });
    await page.fill('#ServicoPrestado_Descricao', serviceDesc);
    await page.waitForTimeout(500);

    // Avançar para Passo 3: Tributação / Valores
    console.log('[Passo 2/4] Avançando para Passo 3 (Tributação/Valores)...');
    await page.locator('button[type="submit"]:has-text("Avançar")').click({ noWaitAfter: true });
    await page.waitForURL('**/DPS/Tributacao**', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);

    // Passo 3: Tributação / Valores
    console.log(`[Passo 3/4] Preenchendo valor total do serviço: R$ ${invoiceValue}...`);
    await page.fill('#Valores_ValorServico', invoiceValue);
    await page.keyboard.press('Tab');
    await page.waitForTimeout(500);

    console.log('[Passo 3/4] Selecionando opção de estimativa de tributos (Decreto 8.264/2014)...');
    await page.evaluate(() => {
      const radio = document.querySelector('input#ValorTributos_TipoValorTributos[value="3"]');
      if (radio) {
        radio.checked = true;
        if (window.jQuery) window.jQuery(radio).trigger('change');
        else radio.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
    await page.waitForTimeout(500);

    // Avançar para Passo 4: Conferência
    console.log('[Passo 3/4] Avançando para Passo 4 (Conferência)...');
    await page.locator('button[type="submit"]:has-text("Avançar")').click({ noWaitAfter: true });
    await page.waitForURL('**/DPS/EmitirNFSe**', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);

    console.log('[Passo 4/4] 📋 Tela de Conferência alcançada com sucesso!');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const screenshotConferencia = path.join(screenshotsDir, `conferencia_${timestamp}.png`);
    await page.screenshot({ path: screenshotConferencia, fullPage: true });
    console.log(`[Passo 4/4] Screenshot salvo em: ${screenshotConferencia}`);

    const domInfo = await page.evaluate(() => {
      const forms = Array.from(document.querySelectorAll('form')).map(f => ({
        id: f.id,
        action: f.action,
        method: f.method,
        className: f.className
      }));
      const buttons = Array.from(document.querySelectorAll('button, a.btn, input[type="submit"], input[type="button"], a[role="button"]')).map(b => ({
        tagName: b.tagName,
        id: b.id,
        className: b.className,
        text: b.innerText ? b.innerText.trim() : '',
        onclick: b.getAttribute('onclick'),
        type: b.getAttribute('type'),
        href: b.getAttribute('href')
      }));
      return { forms, buttons };
    });
    console.log('[Passo 4/4] Formulários detectados:', JSON.stringify(domInfo.forms, null, 2));
    console.log('[Passo 4/4] Botões detectados:', JSON.stringify(domInfo.buttons, null, 2));

    const btnDetails = await page.evaluate(() => {
      const btn = document.querySelector('#btnProsseguir');
      if (!btn) return { error: 'btn not found' };
      const jqEvents = (window.jQuery && window.jQuery._data(btn, 'events')) ? Object.keys(window.jQuery._data(btn, 'events')) : null;
      let clickHandlerString = null;
      if (jqEvents && jqEvents.includes('click')) {
        const handlers = window.jQuery._data(btn, 'events').click;
        clickHandlerString = handlers.map(h => h.handler.toString()).join('\n---\n');
      }
      return {
        href: btn.getAttribute('href'),
        onclick: btn.getAttribute('onclick'),
        jqEvents,
        clickHandlerString
      };
    });
    console.log('[Passo 4/4] Detalhes do botão #btnProsseguir:', JSON.stringify(btnDetails, null, 2));

    if (options.dryRun) {
      console.log('\n====================================================');
      console.log('✅ DRY-RUN CONCLUÍDO COM SUCESSO!');
      console.log('Todos os dados foram validados e preenchidos no portal.');
      console.log('NENHUMA NOTA FISCAL FOI EMITIDA (modo simulação).');
      console.log('----------------------------------------------------');
      console.log(`👤 Prestador:  ${config.prestador.nome} (${config.prestador.cnpj})`);
      console.log(`🏢 Tomador:    ${clientInfo.name} (${clientInfo.cnpj})`);
      console.log(`💰 Valor:      R$ ${invoiceValue}`);
      console.log(`📅 Data:       ${competencia}`);
      console.log(`📝 Descrição:  ${serviceDesc}`);
      console.log(`🖼️  Conferência: ${screenshotConferencia}`);
      console.log('====================================================\n');
      return { dryRun: true, clientKey, screenshot: screenshotConferencia };
    }

    // Modo de Emissão Oficial
    console.log('\n====================================================');
    console.log('⚠️  EMITINDO NFS-e OFICIAL...');
    console.log('====================================================');

    const btnProsseguir = page.locator('#btnProsseguir, a:has-text("Emitir NFS-e"), button:has-text("Emitir NFS-e")').first();
    await btnProsseguir.waitFor({ state: 'visible' });

    console.log('[Emissão] Obtendo link e preparando emissão...');
    const targetHref = await page.$eval('#btnProsseguir', el => el.getAttribute('href')).catch(() => null);
    const targetUrl = targetHref ? new URL(targetHref, page.url()).href : null;
    console.log(`[Emissão] URL de destino da emissão: ${targetUrl || 'não identificada'}`);

    await btnProsseguir.scrollIntoViewIfNeeded();
    await page.waitForTimeout(500);

    // Clicar no botão e aguardar navegação para fora de /DPS/EmitirNFSe
    try {
      await Promise.all([
        page.waitForURL(url => !url.href.includes('/DPS/EmitirNFSe'), { timeout: 20000 }),
        btnProsseguir.click({ force: true })
      ]);
    } catch (clickErr) {
      console.warn(`[Emissão] Clique direto não navegou imediatamente: ${clickErr.message}`);

      // Verificar se há modal aberto
      const btnConfirmModal = page.locator('.modal.in .btn-primary, .modal.show .btn-primary, button:has-text("Sim"), .jconfirm-buttons button.btn-blue, button.btn-primary:has-text("Sim")');
      if (await btnConfirmModal.first().isVisible({ timeout: 2000 }).catch(() => false)) {
        console.log('[Confirmação] Modal de confirmação detectado. Confirmando...');
        await btnConfirmModal.first().click().catch(() => {});
        await page.waitForTimeout(2000);
      }

      // Se ainda estiver na página de conferência (/DPS/EmitirNFSe) e tiver targetUrl, navegar diretamente
      if (page.url().includes('/DPS/EmitirNFSe') && targetUrl) {
        console.log(`[Emissão] Navegando diretamente para a URL de emissão da nota: ${targetUrl}...`);
        await navigateWithRetry(page, targetUrl);
      }
    }

    await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(3000);

    // Verificar se ainda está na página de conferência
    if (page.url().includes('/DPS/EmitirNFSe')) {
      const errScreenshot = path.join(screenshotsDir, `failed_nav_${Date.now()}.png`);
      await page.screenshot({ path: errScreenshot, fullPage: true }).catch(() => {});
      throw new Error(`A emissão não avançou da tela de conferência. URL atual: ${page.url()}`);
    }

    const emissionAlert = await page.evaluate(() => {
      const err = document.querySelector('.alert-danger, .validation-summary-errors');
      return err ? err.innerText.trim() : '';
    });
    if (emissionAlert) {
      throw new Error(`Erro retornado na emissão da NFS-e: ${emissionAlert}`);
    }

    console.log('[Sucesso] NFS-e gerada no portal! URL atual:', page.url());
    const screenshotFinal = path.join(screenshotsDir, `emitida_${timestamp}.png`);
    await page.screenshot({ path: screenshotFinal, fullPage: true });
    console.log(`[Sucesso] Screenshot pós-emissão salvo: ${screenshotFinal}`);

    // Preparar promessa de download antes de disparar o clique (suporta mesma página e pop-up/nova aba)
    const downloadPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Tempo limite excedido aguardando o download (5 min).')), 300000);
      page.on('download', d => { clearTimeout(timer); resolve(d); });
      context.on('page', newPage => {
        newPage.on('download', d => { clearTimeout(timer); resolve(d); });
      });
    });

    // Clicar no botão de download do DANFSE se disponível para abrir o modal de captcha
    const btnDanfse = page.locator('a:has-text("DANFSE"), button:has-text("DANFSE"), a:has-text("Download"), a:has-text("PDF"), a[href*="Danfse"], a[href*="DANFSE"], a[href*="VisualizarDanfse"], a[href*="VisualizarDANFSE"], button[title*="DANFSE"]');
    console.log('[Download] Aguardando botão DANFSE...');
    await btnDanfse.first().waitFor({ state: 'visible', timeout: 30000 }).catch(() => {});
    if (await btnDanfse.first().isVisible().catch(() => false)) {
      console.log('[Download] Clicando no botão DANFSE para abrir o modal de Captcha...');
      await btnDanfse.first().click().catch(() => {});
      await page.waitForTimeout(2500);
    } else {
      console.warn('[Download] Botão DANFSE não foi localizado diretamente.');
    }

    const captchaProvider = getActiveProvider();
    if (captchaProvider) {
      console.log(`[Captcha] 🤖 Provedor de resolução automática ativo: ${captchaProvider.name}.`);
      try {
        await autoSolveHCaptchaIfConfigured(page);
      } catch (captchaErr) {
        console.warn(`[Captcha] ⚠️ Falha na resolução automática: ${captchaErr.message}.`);
        console.warn('[Captcha] Por favor, resolva o hCaptcha na janela para prosseguir.');
      }
    } else {
      console.log('\n----------------------------------------------------');
      console.log('👉 [AÇÃO DO USUÁRIO]:');
      console.log('Nenhuma chave de API de Captcha (CAPSOLVER_API_KEY ou TWOCAPTCHA_API_KEY) configurada no .env.');
      console.log('Por favor, resolva o hCaptcha na janela aberta do Chrome para iniciar o download.');
      console.log('O script está monitorando e salvará o arquivo automaticamente...');
      console.log('----------------------------------------------------\n');
    }

    // Aguardar o download disparado (pelo solver automático ou pelo usuário)
    const download = await downloadPromise;

    const safeClientName = clientInfo.name.replace(/[^a-zA-Z0-9]/g, '_');
    const safeDate = competencia.replace(/\//g, '-');
    const fileName = `NFSe_${safeDate}_${safeClientName}_R$${invoiceValue}.pdf`;
    const targetPdfPath = path.join(invoicesDir, fileName);
    await download.saveAs(targetPdfPath);

    console.log('\n====================================================');
    console.log('🎉 DOWNLOAD DO DANFSE CONCLUÍDO COM SUCESSO!');
    console.log(`📄 Arquivo salvo em: ${targetPdfPath}`);
    console.log('====================================================\n');

    // Envio automático de e-mail se configurado para o cliente
    const emailResult = await sendInvoiceEmail({
      clientKey,
      clientInfo,
      pdfPath: targetPdfPath,
      competencia
    });

    if (emailResult.sent) {
      console.log(`\n📬 Notificação: E-mail com a NFS-e enviado com sucesso para ${emailResult.recipient}!`);
    }

    // Enviar e-mail de notificação de sucesso com log para William (william.kunitake@gmail.com)
    await sendAdminNotification({
      clientKey,
      clientInfo,
      pdfPath: targetPdfPath,
      competencia,
      invoiceValue,
      clientEmailResult: emailResult
    });

    return {
      success: true,
      clientKey,
      pdfPath: targetPdfPath,
      emailSent: emailResult.sent
    };
  } catch (error) {
    console.error(`\n❌ Erro durante o processo para ${clientKey}:`, error.message);
    const errScreenshot = path.join(screenshotsDir, `error_${clientKey}_${Date.now()}.png`);
    await page.screenshot({ path: errScreenshot, fullPage: true }).catch(() => {});
    console.error(`Screenshot do erro salvo em: ${errScreenshot}`);
    throw error;
  }
}

async function run() {
  const options = parseArgs();
  const profileDir = path.join(__dirname, '.auth', 'user-data');
  const screenshotsDir = path.join(__dirname, 'screenshots');
  const invoicesDir = path.join(__dirname, 'invoices');

  if (!fs.existsSync(profileDir)) fs.mkdirSync(profileDir, { recursive: true });
  if (!fs.existsSync(screenshotsDir)) fs.mkdirSync(screenshotsDir, { recursive: true });
  if (!fs.existsSync(invoicesDir)) fs.mkdirSync(invoicesDir, { recursive: true });

  console.log('====================================================');
  console.log('🚀 AUTOMADOR DE NOTA FISCAL (NFS-e NACIONAL)');
  console.log('====================================================');
  console.log(`👤 Prestador:  ${config.prestador.nome} (${config.prestador.cnpj})`);
  console.log(`⚙️  Modo:       ${options.dryRun ? 'DRY-RUN (Simulação/Conferência)' : 'EMISSÃO OFICIAL'}`);
  console.log(`🖥️  Browser:    ${options.headless ? 'Headless (invisível)' : 'Headed (janela visível no iMac)'}`);
  console.log('====================================================\n');

  console.log('[Browser] Iniciando navegador Chrome...');
  const context = await chromium.launchPersistentContext(profileDir, {
    channel: 'chrome',
    headless: options.headless,
    viewport: { width: 1280, height: 900 },
    args: ['--disable-blink-features=AutomationControlled']
  });

  const page = context.pages()[0] || await context.newPage();
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  // Aceitar automaticamente todos os diálogos nativos do navegador
  page.on('dialog', async dialog => {
    console.log(`[Dialog] ${dialog.type().toUpperCase()}: "${dialog.message()}". Confirmando automaticamente...`);
    await dialog.accept().catch(e => console.warn(`[Dialog] Erro ao aceitar diálogo: ${e.message}`));
  });

  try {
    if (options.loginOnly) {
      await navigateWithRetry(page, 'https://www.nfse.gov.br/EmissorNacional/Dashboard');
      await ensureLoggedIn(page);
      console.log('✅ Login verificado com sucesso no Dashboard!');
      await page.screenshot({ path: path.join(screenshotsDir, 'dashboard.png') });
      await context.close();
      return;
    }

    const dirs = { screenshotsDir, invoicesDir };
    const clientsToProcess = options.all ? Object.keys(config.clients) : [options.client];

    console.log(`\n📋 Lista de processamento: ${clientsToProcess.length} cliente(s) [${clientsToProcess.join(', ')}]\n`);

    const summary = [];
    for (let i = 0; i < clientsToProcess.length; i++) {
      const clientKey = clientsToProcess[i];
      console.log(`\n----------------------------------------------------`);
      console.log(`▶️ [${i + 1}/${clientsToProcess.length}] Processando: ${clientKey.toUpperCase()}`);
      console.log(`----------------------------------------------------`);

      try {
        const res = await emitInvoiceForClient(page, context, clientKey, options, dirs);
        summary.push({ client: clientKey, success: true, ...res });
      } catch (err) {
        summary.push({ client: clientKey, success: false, error: err.message });
      }
    }

    console.log('\n====================================================');
    console.log('🏁 RESUMO GERAL DO PROCESSAMENTO:');
    console.log('====================================================');
    summary.forEach(s => {
      const icon = s.success ? '✅ SUCESSO' : '❌ ERRO';
      const fileInfo = s.pdfPath ? `-> Arquivo: ${path.basename(s.pdfPath)}` : (s.dryRun ? '-> Simulação OK' : '');
      const errInfo = s.error ? `-> Erro: ${s.error}` : '';
      console.log(`${icon} [${s.client}] ${fileInfo} ${errInfo}`);
    });
    console.log('====================================================\n');

    await context.close();
  } catch (fatalErr) {
    console.error('\n❌ Erro crítico:', fatalErr.message);
    await context.close();
    process.exit(1);
  }
}

run();
