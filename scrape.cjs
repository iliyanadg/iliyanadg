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
      return { name, value, domain: '.onlyfans.com', path: '/', httpOnly: false, secure: true };
    });
}

async function extractNumber(page, labelText) {
  // Trova un nodo che contenga la label (es. "Likes") e prendi il numero accanto
  const locator = page.locator(`xpath=//*[contains(normalize-space(.), "${labelText}")]`);
  const count = await locator.first().evaluate((el) => {
    // cerca un numero nella stessa riga / vicino
    const text = el.textContent || '';
    const mSelf = text.match(/\d[\d,.]*/);
    if (mSelf) return mSelf[0];

    // prova nei fratelli
    const sibs = Array.from(el.parentElement?.children || []);
    for (const s of sibs) {
      const t = (s.textContent || '').trim();
      const m = t.match(/\d[\d,.]*/);
      if (m) return m[0];
    }
    // fallback: cerca più in alto
    let p = el.parentElement;
    for (let i = 0; i < 3 && p; i++, p = p.parentElement) {
      const t = (p.textContent || '').trim();
      const m = t.match(/\d[\d,.]*/);
      if (m) return m[0];
    }
    return null;
  }).catch(() => null);

  if (!count) return 0;
  return parseInt(String(count).replace(/[^\d]/g, ''), 10) || 0;
}

(async () => {
  const username = process.env.TARGET_USERNAME;
  const cookieStr = process.env.OF_COOKIE;

  if (!username) throw new Error('Missing TARGET_USERNAME');
  if (!cookieStr) throw new Error('Missing OF_COOKIE');

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext();
  await ctx.addCookies(parseCookieString(cookieStr));
  const page = await ctx.newPage();

  // Vai sul profilo
  await page.goto(`https://onlyfans.com/${username}`, { waitUntil: 'domcontentloaded' });
  // Aspetta che la pagina finisca di caricare roba dinamica
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});

  // Alcuni elementi arrivano tardi: piccola attesa “elastica”
  await page.waitForTimeout(1500);

  // Proviamo varie label comuni. Se non troviamo, restano 0 (meglio che 1 random).
  const likes  = await extractNumber(page, 'Likes');
  const photos = await extractNumber(page, 'Photos');
  const videos = await extractNumber(page, 'Videos');

  // Se likes è ancora 0/1, riprova una volta dopo uno scroll (forza rendering)
  let finalLikes = likes;
  if (finalLikes <= 1) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight / 2));
    await page.waitForTimeout(1200);
    finalLikes = await extractNumber(page, 'Likes');
  }

  const payload = {
    username,
    likes: Number.isFinite(finalLikes) ? finalLikes : 0,
    photos: Number.isFinite(photos) ? photos : 0,
    videos: Number.isFinite(videos) ? videos : 0,
    available: true,
    updatedAt: new Date().toISOString()
  };

  fs.writeFileSync('stats.json', JSON.stringify(payload, null, 2));
  console.log('Saved', payload);

  await browser.close();
})();

