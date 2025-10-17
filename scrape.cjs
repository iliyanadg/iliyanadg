// scrape.cjs
const { chromium } = require('playwright');
const fs = require('fs');

function parseCookieString(cookieStr) {
  // "key1=val1; key2=val2; ..."
  return cookieStr
    .split(';')
    .map(x => x.trim())
    .filter(Boolean)
    .map(pair => {
      const i = pair.indexOf('=');
      const name = pair.slice(0, i).trim();
      const value = pair.slice(i + 1).trim();
      return {
        name,
        value,
        domain: '.onlyfans.com',
        path: '/',
        httpOnly: false,
        secure: true,
      };
    });
}

// Sanifica un numero tipo "32.8K", "446", "12,345"
function toInt(n) {
  if (!n) return 0;
  const s = String(n).trim();
  // gestisci notazioni tipo 32.8K / 1.2M
  const k = s.match(/^(\d+(?:[.,]\d+)?)\s*[kK]$/);
  const m = s.match(/^(\d+(?:[.,]\d+)?)\s*[mM]$/);
  if (k) return Math.round(parseFloat(k[1].replace(',', '.')) * 1_000);
  if (m) return Math.round(parseFloat(m[1].replace(',', '.')) * 1_000_000);
  return parseInt(s.replace(/[^\d]/g, ''), 10) || 0;
}

// Cerca un numero vicino alla/e label fornite (sia prima che dopo la label)
async function extractByKeywords(page, keywords) {
  const bodyText = await page.evaluate(() => document.body.innerText);
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const alt = keywords.map(esc).join('|');

  // numero PRIMA della label: "446 Likes"
  let re = new RegExp(`(?:^|\\D)(\\d[\\d.,]*\\s*[kKmM]?)\\s*(?:${alt})\\b`, 'i');
  let m = bodyText.match(re);
  if (m) return toInt(m[1]);

  // numero DOPO la label: "Likes 446" o "Likes: 446"
  re = new RegExp(`\\b(?:${alt})\\s*[:•-]?\\s*(\\d[\\d.,]*\\s*[kKmM]?)\\b`, 'i');
  m = bodyText.match(re);
  if (m) return toInt(m[1]);

  return 0;
}

// Prova anche via DOM: etichetta visibile + numero vicino
async function extractNearLabel(page, labelText) {
  const locator = page.locator(`xpath=//*[contains(normalize-space(.), "${labelText}")]`).first();
  if (!(await locator.count())) return 0;

  const found = await locator.evaluate((el) => {
    // 1) prova nel nodo stesso
    const self = (el.textContent || '').trim();
    let m = self.match(/(\d[\d.,]*\s*[kKmM]?)/);
    if (m) return m[1];

    // 2) prova nei fratelli
    const sibs = Array.from(el.parentElement?.children || []);
    for (const s of sibs) {
      const t = (s.textContent || '').trim();
      m = t.match(/(\d[\d.,]*\s*[kKmM]?)/);
      if (m) return m[1];
    }

    // 3) prova risalendo di un paio di livelli
    let p = el.parentElement;
    for (let i = 0; i < 3 && p; i++, p = p.parentElement) {
      const t = (p.textContent || '').trim();
      m = t.match(/(\d[\d.,]*\s*[kKmM]?)/);
      if (m) return m[1];
    }

    return null;
  }).catch(() => null);

  return toInt(found);
}

async function extractStat(page, labels) {
  // 1) testo pagina (multilingua)
  const v1 = await extractByKeywords(page, labels);
  if (v1) return v1;

  // 2) vicino all'etichetta nel DOM
  for (const l of labels) {
    const v2 = await extractNearLabel(page, l);
    if (v2) return v2;
  }

  return 0;
}

(async () => {
  const username = process.env.TARGET_USERNAME;
  const cookieStr = process.env.OF_COOKIE;

  if (!username) throw new Error('Missing TARGET_USERNAME');
  if (!cookieStr) throw new Error('Missing OF_COOKIE');

  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-dev-shm-usage'],
  });

  const ctx = await browser.newContext();
  await ctx.addCookies(parseCookieString(cookieStr));
  const page = await ctx.newPage();

  // Vai sul profilo
  await page.goto(`https://onlyfans.com/${username}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  // Attendi un minimo che SPA finisca di portare giù roba
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(1500);

  // DEBUG: salva screenshot + html per eventuale artifact
  try {
    await page.screenshot({ path: 'debug-profile.png', fullPage: true });
    fs.writeFileSync('debug-profile.html', await page.content());
  } catch (_) {}

  // Heuristic: capiamo se siamo loggati
  const bodyText = await page.evaluate(() => document.body.innerText || '');
  const looksLoggedOut = /\b(sign in|log in|iscriviti|accedi)\b/i.test(bodyText);

  // --- Estrazione numeri ----------------------------------------------------
  // Label possibili (ENG/IT + un paio di altre varianti comuni)
  const likesLabels  = ['Likes', 'Mi piace', 'Apreciaciones', 'Gefällt mir'];
  const photosLabels = ['Photos', 'Foto', 'Fotos', 'Photosets'];
  const videosLabels = ['Videos', 'Video', 'Vídeos'];

  let likes  = 0;
  let photos = 0;
  let videos = 0;

  if (!looksLoggedOut) {
    likes  = await extractStat(page, likesLabels);
    photos = await extractStat(page, photosLabels);
    videos = await extractStat(page, videosLabels);

    // Se i likes sono ancora 0/1 e sulla pagina c'è scritto "Likes", prova dopo scroll
    if (likes <= 1 && /likes|mi piace/i.test(bodyText)) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight / 2));
      await page.waitForTimeout(1200);
      likes = await extractStat(page, likesLabels);
    }
  }

  // --- Disponibilità/online --------------------------------------------------
  // Default PRUDENTE: false. Mettiamo true solo se troviamo un chiaro segnale.
  let available = false;
  try {
    // Cerca stringhe tipo "Available", "Disponibile", "Online" in zone vicine al nome
    const nearName = await page.evaluate(() => {
      const hCandidates = Array.from(document.querySelectorAll('h1,h2,[role="heading"]'));
      let snippet = '';
      if (hCandidates.length) {
        const h = hCandidates[0];
        const block = h.closest('section,header,div') || h.parentElement || document.body;
        snippet = (block.innerText || '').slice(0, 600);
      } else {
        snippet = (document.body.innerText || '').slice(0, 1200);
      }
      return snippet;
    });

    if (/\b(available|disponibile|online)\b/i.test(nearName)) {
      available = true;
    }
  } catch (_) {
    available = false;
  }

  const payload = {
    username,
    likes: Number.isFinite(likes) ? likes : 0,
    photos: Number.isFinite(photos) ? photos : 0,
    videos: Number.isFinite(videos) ? videos : 0,
    available,
    updatedAt: new Date().toISOString(),
    // opzionale: indica se parevamo loggati
    _loggedOutGuess: looksLoggedOut,
  };

  fs.writeFileSync('stats.json', JSON.stringify(payload, null, 2));
  console.log('Saved', payload);

  await browser.close();
})().catch(async (err) => {
  console.error('SCRAPER_ERROR:', err && err.stack || err);
  // In caso di errore, scrivi comunque un file valido (non bloccare commit)
  try {
    const fallback = {
      username: process.env.TARGET_USERNAME || 'unknown',
      likes: 0,
      photos: 0,
      videos: 0,
      available: false,
      updatedAt: new Date().toISOString(),
      _error: String(err && err.message || err),
    };
    fs.writeFileSync('stats.json', JSON.stringify(fallback, null, 2));
  } catch {}
  process.exit(0); // non fallire il workflow
});

