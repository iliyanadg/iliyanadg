// scrape.cjs
const { chromium } = require('playwright');
const fs = require('fs');

function parseCookieString(cookieStr) {
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

// Cerca un numero vicino a una o più parole-chiave (prima o dopo la label)
function numberNear(html, words) {
  const joined = words.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const rx = new RegExp(
    `(?:(${joined})[^\\d]{0,15}(\\d[\\d.,]*)|(\\d[\\d.,]*)[^\\d]{0,15}(${joined}))`,
    'i'
  );
  const m = html.match(rx);
  if (!m) return 0;
  const raw = m[2] || m[3];
  const n = parseInt(String(raw).replace(/[^\d]/g, ''), 10);
  return Number.isFinite(n) ? n : 0;
}

// Heuristica "online"
function detectOnline(html) {
  // parole comuni EN/IT/ES
  const words = [
    'online', 'active now', 'currently active',
    'attivo ora', 'attiva ora', 'online adesso',
    'en línea', 'en linea', 'activo ahora'
  ];
  const s = html.toLowerCase();
  return words.some(w => s.includes(w));
}

(async () => {
  const username = process.env.TARGET_USERNAME;
  const cookieStr = process.env.OF_COOKIE;

  if (!username) throw new Error('Missing TARGET_USERNAME');
  if (!cookieStr) throw new Error('Missing OF_COOKIE');

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  await ctx.addCookies(parseCookieString(cookieStr));
  const page = await ctx.newPage();

  await page.goto(`https://onlyfans.com/${username}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  // lascia il tempo alla UI di idratarsi
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(1500);

  // DEBUG: salva schermata e HTML che vediamo (li carichiamo come artifact da Actions)
  try {
    await page.screenshot({ path: 'debug-profile.png', fullPage: true });
    const html = await page.content();
    fs.writeFileSync('debug-profile.html', html);
  } catch {}

  // Usa l'HTML per estrarre i numeri in modo “elastico”
  const html = await page.content();

  const likes = numberNear(html, ['likes', 'mi piace', 'me gusta']);
  const photos = numberNear(html, ['photos', 'foto', 'fotos', 'photographs']);
  const videos = numberNear(html, ['videos', 'video']);

  // Online/offline
  const available = detectOnline(html);

  const payload = {
    username,
    likes,
    photos,
    videos,
    available,
    updatedAt: new Date().toISOString()
  };

  fs.writeFileSync('stats.json', JSON.stringify(payload, null, 2));
  console.log('Saved', payload);

  await browser.close();
})();

