/**
 * Módulo de Resolução Automática de Captcha (hCaptcha)
 * Suporta CapSolver, 2Captcha e Anti-Captcha.
 */

require('dotenv').config();

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getActiveProvider() {
  if (process.env.CAPSOLVER_API_KEY) {
    return { name: 'CapSolver', key: process.env.CAPSOLVER_API_KEY.trim() };
  }
  if (process.env.TWOCAPTCHA_API_KEY || process.env['2CAPTCHA_API_KEY']) {
    return {
      name: '2Captcha',
      key: (process.env.TWOCAPTCHA_API_KEY || process.env['2CAPTCHA_API_KEY']).trim()
    };
  }
  if (process.env.ANTICAPTCHA_API_KEY) {
    return { name: 'AntiCaptcha', key: process.env.ANTICAPTCHA_API_KEY.trim() };
  }
  if (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) {
    return {
      name: 'GeminiVision',
      key: (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY).trim()
    };
  }
  return null;
}

async function solveWithCapSolver(apiKey, websiteUrl, siteKey) {
  console.log('[Captcha] Enviando desafio hCaptcha para o CapSolver...');

  const createRes = await fetch('https://api.capsolver.com/createTask', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientKey: apiKey,
      task: {
        type: 'HCaptchaTaskProxyLess',
        websiteURL: websiteUrl,
        websiteKey: siteKey
      }
    })
  });

  const createData = await createRes.json();
  if (createData.errorId !== 0) {
    throw new Error(`CapSolver erro ao criar tarefa: ${createData.errorDescription || JSON.stringify(createData)}`);
  }

  const taskId = createData.taskId;
  console.log(`[Captcha] Tarefa CapSolver criada: ${taskId}. Aguardando resolução...`);

  // Polling a cada 2.5s (tempo médio no CapSolver: 4 a 10s)
  const maxAttempts = 30; // 75s
  for (let i = 0; i < maxAttempts; i++) {
    await sleep(2500);

    const checkRes = await fetch('https://api.capsolver.com/getTaskResult', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientKey: apiKey,
        taskId: taskId
      })
    });

    const checkData = await checkRes.json();
    if (checkData.errorId !== 0) {
      throw new Error(`CapSolver erro na resolução: ${checkData.errorDescription || JSON.stringify(checkData)}`);
    }

    if (checkData.status === 'ready') {
      const token = checkData.solution?.gRecaptchaResponse || checkData.solution?.userToken;
      console.log('✅ [Captcha] hCaptcha resolvido com sucesso pelo CapSolver!');
      return token;
    }

    process.stdout.write('.');
  }

  throw new Error('CapSolver tempo limite excedido (75s).');
}

async function solveWith2Captcha(apiKey, websiteUrl, siteKey) {
  console.log('[Captcha] Enviando desafio hCaptcha para o 2Captcha...');

  const createRes = await fetch('https://2captcha.com/in.php', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      key: apiKey,
      method: 'hcaptcha',
      sitekey: siteKey,
      pageurl: websiteUrl,
      json: 1
    })
  });

  const createData = await createRes.json();
  if (createData.status !== 1) {
    throw new Error(`2Captcha erro ao criar tarefa: ${createData.request || JSON.stringify(createData)}`);
  }

  const requestId = createData.request;
  console.log(`[Captcha] Tarefa 2Captcha criada: ${requestId}. Aguardando resolução...`);

  // Polling a cada 4s (tempo médio no 2Captcha: 30 a 120s)
  const maxAttempts = 60; // 240s (4 min)
  for (let i = 0; i < maxAttempts; i++) {
    await sleep(4000);

    const checkRes = await fetch(`https://2captcha.com/res.php?key=${apiKey}&action=get&id=${requestId}&json=1`);
    const checkData = await checkRes.json();

    if (checkData.status === 1) {
      console.log(`\n✅ [Captcha] hCaptcha resolvido com sucesso pelo 2Captcha (${(i + 1) * 4}s)!`);
      return checkData.request;
    }

    if (checkData.request !== 'CAPCHA_NOT_READY') {
      throw new Error(`2Captcha erro na resolução: ${checkData.request}`);
    }

    if ((i + 1) % 5 === 0) {
      process.stdout.write(` [${(i + 1) * 4}s] `);
    } else {
      process.stdout.write('.');
    }
  }

  throw new Error('2Captcha tempo limite excedido (240s).');
}

async function solveWithAntiCaptcha(apiKey, websiteUrl, siteKey) {
  console.log('[Captcha] Enviando desafio hCaptcha para o Anti-Captcha...');

  const createRes = await fetch('https://api.anti-captcha.com/createTask', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientKey: apiKey,
      task: {
        type: 'HCaptchaTaskProxyless',
        websiteURL: websiteUrl,
        websiteKey: siteKey
      }
    })
  });

  const createData = await createRes.json();
  if (createData.errorId !== 0) {
    throw new Error(`Anti-Captcha erro ao criar tarefa: ${createData.errorDescription}`);
  }

  const taskId = createData.taskId;
  console.log(`[Captcha] Tarefa Anti-Captcha criada: ${taskId}. Aguardando resolução...`);

  const maxAttempts = 25;
  for (let i = 0; i < maxAttempts; i++) {
    await sleep(3500);

    const checkRes = await fetch('https://api.anti-captcha.com/getTaskResult', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientKey: apiKey,
        taskId: taskId
      })
    });

    const checkData = await checkRes.json();
    if (checkData.errorId !== 0) {
      throw new Error(`Anti-Captcha erro na resolução: ${checkData.errorDescription}`);
    }

    if (checkData.status === 'ready') {
      console.log('✅ [Captcha] hCaptcha resolvido com sucesso pelo Anti-Captcha!');
      return checkData.solution?.gRecaptchaResponse;
    }

    process.stdout.write('.');
  }

  throw new Error('Anti-Captcha tempo limite excedido.');
}

/**
 * Resolução visual de hCaptcha utilizando Gemini 2.5 Flash
 * Captura o print do iframe do desafio, envia ao Gemini, clica nas células correspondentes e confirma.
 */
async function solveWithGeminiVision(page) {
  const geminiKey = (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '').trim();
  if (!geminiKey) {
    console.log('[Gemini Captcha] GEMINI_API_KEY não configurada no .env. Fallback visual indisponível.');
    return false;
  }

  console.log('\n🤖 [Gemini Captcha] Iniciando resolução visual com Gemini Vision...');

  // Se o iframe de desafio ainda não está aberto, tentar clicar no checkbox do hCaptcha
  let challengeFrame = page.frames().find(f => f.url().includes('hcaptcha.com') && (f.url().includes('challenge') || f.url().includes('frame=challenge')));

  if (!challengeFrame) {
    console.log('[Gemini Captcha] Procurando checkbox do hCaptcha para exibir o desafio visual...');
    const checkboxFrame = page.frames().find(f => f.url().includes('hcaptcha.com') && (f.url().includes('checkbox') || f.url().includes('frame=checkbox')));
    if (checkboxFrame) {
      const checkbox = await checkboxFrame.$('#anchor, #checkbox, [role="checkbox"], .anchor-inner');
      if (checkbox) {
        console.log('[Gemini Captcha] Clicando no checkbox...');
        await checkbox.click().catch(() => {});
        await sleep(3000);
      }
    }
  }

  // Aguardar até 10s pelo carregamento do iframe de desafio
  for (let i = 0; i < 10; i++) {
    challengeFrame = page.frames().find(f => f.url().includes('hcaptcha.com') && (f.url().includes('challenge') || f.url().includes('frame=challenge')));
    if (challengeFrame) {
      const hasGrid = await challengeFrame.$('.task-grid, .task-image, [role="checkbox"], .prompt-text').catch(() => null);
      if (hasGrid) break;
    }
    await sleep(1000);
  }

  if (!challengeFrame) {
    console.warn('[Gemini Captcha] Iframe do desafio visual não foi encontrado.');
    return false;
  }

  // hCaptcha geralmente exige 1 a 3 rodadas de seleção
  for (let round = 1; round <= 3; round++) {
    console.log(`[Gemini Captcha] Processando rodada ${round}/3...`);
    await sleep(1500);

    const promptEl = await challengeFrame.$('.prompt-text, .challenge-header, h2');
    if (!promptEl) {
      console.log('[Gemini Captcha] Desafio visual concluído.');
      break;
    }

    const promptText = await promptEl.innerText().catch(() => '');
    console.log(`[Gemini Captcha] Instrução da rodada: "${promptText.trim()}"`);

    // Capturar print do frame do desafio
    const frameEl = await page.$('iframe[src*="hcaptcha.com"][src*="challenge"], iframe[title*="challenge"], iframe[title*="desafio"]');
    const screenshotBuffer = frameEl ? await frameEl.screenshot() : await page.screenshot();
    const base64Image = screenshotBuffer.toString('base64');

    console.log('[Gemini Captcha] Enviando screenshot para Gemini 2.5 Flash...');
    let solution = null;
    try {
      const geminiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              {
                text: `You are an AI assistant helping to solve an accessibility verification puzzle (hCaptcha).
Analyze the screenshot. Read the prompt instruction at the top and the numbered grid of image tiles (cells 1 to 9, numbered row by row: top row is 1,2,3; middle row is 4,5,6; bottom row is 7,8,9).
Which cell numbers contain the object asked for in the instruction?
Return ONLY a valid JSON object with the matching cell numbers:
{"indices": [1, 3, 7]}`
              },
              {
                inlineData: {
                  mimeType: 'image/png',
                  data: base64Image
                }
              }
            ]
          }],
          generationConfig: {
            responseMimeType: 'application/json',
            temperature: 0.1
          }
        })
      });

      const geminiData = await geminiRes.json();
      if (geminiData.error) {
        throw new Error(geminiData.error.message || JSON.stringify(geminiData.error));
      }
      const rawText = geminiData.candidates?.[0]?.content?.parts?.[0]?.text;
      solution = JSON.parse(rawText);
    } catch (gErr) {
      console.warn(`[Gemini Captcha] Erro ao consultar Gemini: ${gErr.message}`);
      return false;
    }

    const indices = solution?.indices || [];
    console.log(`[Gemini Captcha] Gemini selecionou as células: [${indices.join(', ')}]`);

    const tiles = await challengeFrame.$$('.task-image, [role="checkbox"], .image, .task-image-border');
    for (const idx of indices) {
      if (idx >= 1 && idx <= tiles.length) {
        console.log(`[Gemini Captcha] Clicando na célula ${idx}...`);
        await tiles[idx - 1].click().catch(() => {});
        await sleep(350);
      }
    }

    await sleep(600);

    const btnSubmit = await challengeFrame.$('.button-submit, button:has-text("Verificar"), button:has-text("Próximo"), button:has-text("Avançar"), button:has-text("Verify"), button:has-text("Next")');
    if (btnSubmit) {
      console.log('[Gemini Captcha] Clicando no botão Verificar/Avançar...');
      await btnSubmit.click().catch(() => {});
      await sleep(2500);
    }

    // Verificar se o desafio foi concluído
    const stillActive = await challengeFrame.$('.prompt-text').catch(() => null);
    if (!stillActive) {
      console.log('✅ [Gemini Captcha] Desafio visual resolvido!');
      break;
    }
  }

  await sleep(1500);

  // Clica no botão de download do modal
  const modalBtn = page.locator(
    '.modal.in button[type="submit"], .modal.show button[type="submit"], .modal button:has-text("Baixar"), .modal button:has-text("Download"), .modal button:has-text("Confirmar"), .modal button:has-text("Gerar"), .modal button:has-text("DANFSE"), .modal a:has-text("DANFSE"), .modal a:has-text("Baixar"), button:has-text("Baixar"), button:has-text("Confirmar"), a:has-text("Baixar"), input[type="submit"][value*="Baixar"], input[type="submit"][value*="DANFSE"]'
  );
  if (await modalBtn.first().isVisible({ timeout: 3000 }).catch(() => false)) {
    console.log('[Gemini Captcha] Clicando no botão de confirmação/download do modal...');
    await modalBtn.first().click().catch(() => {});
  }

  return true;
}

/**
 * Tenta resolver o hCaptcha na página usando o provedor configurado no .env
 * Retorna true se foi resolvido automaticamente, ou false se nenhum provedor está configurado.
 */
async function autoSolveHCaptchaIfConfigured(page) {
  const provider = getActiveProvider();
  if (!provider) {
    return false;
  }

  console.log(`\n🤖 [Captcha] Provedor detectado: ${provider.name}. Iniciando resolução automática...`);

  if (provider.name === 'GeminiVision') {
    return await solveWithGeminiVision(page);
  }

  // Detectar sitekey dinamicamente da página ou iframes
  let siteKey = null;
  for (let i = 0; i < 15; i++) {
    siteKey = await page.evaluate(() => {
      const el = document.querySelector('[data-sitekey]');
      if (el && el.getAttribute('data-sitekey')) return el.getAttribute('data-sitekey');
      const iframe = document.querySelector('iframe[src*="hcaptcha.com"]');
      if (iframe && iframe.src) {
        const match = iframe.src.match(/sitekey=([a-f0-9\-]+)/i);
        if (match) return match[1];
      }
      return null;
    });

    if (!siteKey) {
      for (const frame of page.frames()) {
        try {
          const frameUrl = frame.url();
          if (frameUrl.includes('hcaptcha.com')) {
            const match = frameUrl.match(/sitekey=([a-f0-9\-]+)/i);
            if (match) {
              siteKey = match[1];
              break;
            }
          }
        } catch (e) {}
      }
    }

    if (siteKey) break;
    await sleep(1000);
  }

  if (!siteKey) {
    console.warn('[Captcha] Não foi possível extrair a sitekey do hCaptcha na página.');
    // Tentar Gemini Vision como fallback direto
    if (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) {
      return await solveWithGeminiVision(page);
    }
    return false;
  }

  console.log(`[Captcha] SiteKey identificado: ${siteKey}`);
  const websiteUrl = page.url();

  let token = null;
  try {
    if (provider.name === 'CapSolver') {
      token = await solveWithCapSolver(provider.key, websiteUrl, siteKey);
    } else if (provider.name === '2Captcha') {
      token = await solveWith2Captcha(provider.key, websiteUrl, siteKey);
    } else if (provider.name === 'AntiCaptcha') {
      token = await solveWithAntiCaptcha(provider.key, websiteUrl, siteKey);
    }
  } catch (providerErr) {
    console.warn(`[Captcha] ⚠️ Falha no provedor ${provider.name}: ${providerErr.message}`);
    // Fallback: tentar resolução visual com Gemini se configurado
    if (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) {
      console.log('[Captcha] Acionando fallback visual: Gemini Vision...');
      const geminiSuccess = await solveWithGeminiVision(page);
      if (geminiSuccess) return true;
    }
    throw providerErr;
  }

  if (!token) {
    // Tentar fallback Gemini Vision
    if (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) {
      return await solveWithGeminiVision(page);
    }
    throw new Error('Nenhum token foi retornado pelo serviço de captcha.');
  }

  console.log('[Captcha] Injetando token de verificação na página...');
  await page.evaluate((solToken) => {
    // 1. Preenche os campos textareas do hCaptcha
    const fields = document.querySelectorAll(
      'textarea[name="h-captcha-response"], textarea[name="g-recaptcha-response"], [name="h-captcha-response"], [name="g-recaptcha-response"]'
    );
    fields.forEach(el => {
      el.value = solToken;
      el.innerHTML = solToken;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });

    // 2. Aciona o callback do hCaptcha se existir no elemento
    const hEl = document.querySelector('.h-captcha, [data-sitekey]');
    if (hEl) {
      const cbName = hEl.getAttribute('data-callback');
      if (cbName && typeof window[cbName] === 'function') {
        try {
          window[cbName](solToken);
        } catch (e) {
          console.error('Erro ao chamar callback do hCaptcha:', e);
        }
      }
    }

    // 3. Habilita qualquer botão que esteja desabilitado aguardando o captcha
    document.querySelectorAll('.modal button:disabled, .modal input[type="submit"]:disabled, button:disabled').forEach(btn => {
      btn.removeAttribute('disabled');
      btn.classList.remove('disabled');
    });
  }, token);

  await sleep(1500);

  // 4. Clica no botão de download/confirmação dentro do modal, se existir
  const modalBtn = page.locator(
    '.modal.in button[type="submit"], .modal.show button[type="submit"], .modal button:has-text("Baixar"), .modal button:has-text("Download"), .modal button:has-text("Confirmar"), .modal button:has-text("Gerar"), .modal button:has-text("DANFSE"), .modal a:has-text("DANFSE"), .modal a:has-text("Baixar"), button:has-text("Baixar"), button:has-text("Confirmar"), a:has-text("Baixar"), input[type="submit"][value*="Baixar"], input[type="submit"][value*="DANFSE"]'
  );
  if (await modalBtn.first().isVisible({ timeout: 3000 }).catch(() => false)) {
    console.log('[Captcha] Clicando no botão de confirmação/download do modal...');
    await modalBtn.first().click().catch(() => {});
  } else {
    // Tenta submeter formulário do modal se houver
    await page.evaluate(() => {
      const modalForm = document.querySelector('.modal form, form[action*="Danfse"], form[action*="DANFSE"]');
      if (modalForm) modalForm.submit();
    }).catch(() => {});
  }

  return true;
}

module.exports = {
  getActiveProvider,
  autoSolveHCaptchaIfConfigured
};
