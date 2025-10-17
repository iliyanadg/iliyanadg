#!/usr/bin/env node
const fs = require('fs');
const { chromium } = require('playwright');

const USERNAME = process.env.TARGET_USERNAME;
const COOKIE_STR = process.env.OF_COOKIE;

// Trasforma "a=b; c=d" in array di cookie Playwright
function parseCookieString(str) {
  if (!str) return [];
  return str
    .split(';')
    .map(p => p.trim())
    .filter(Boolean)
    .map(pair => {
      const eq = pair.indexOf('=');
      const name = pair.slice(0, eq);
      const value = pair.slice(eq + 1);
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

// Converte "2,3K" / "1.2M" / "446" in numero
function toNumber(str) {
  if (!str) return 0;
  let s = str.replace(/\s/g, '').replace(',', '.');
  const m = s.match(/^([\d.]+)([kKmM]?)$/);
  if (!m) return parseInt(s.replace(/[^\d]/g, '')) || 0;
  let num = parseFloat(m[1]);
  const suf = m[2].toLowerCase();
  if (suf === 'k') num *= 1e3;
  if (suf === 'm') num *= 1e6;
  return Math.round(num);
}

// Trova "numero" vicino all'etichetta (supporta IT/EN)
function pickByLabels(text, labels) {
  for (const label of labels) {
    // es.: "446 Mi piace" oppure "Likes 446"
    const re1 = new RegExp(`(\\d[\\d\\.,\\s]*[kKmM]?)\\s*${label}`, 'i');
    const re2 = new RegExp(`${label}\\s*(\\d[\\d\\.,\\s]*[kKmM]?)`, 'i');
    const m = text.match(re1) || text.match(re2);
    if (m) return toNumber(m[1]);
  }
  return 0;
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();

  // Applica i cookie (se presenti)
  if (COOKIE_STR) {
    const cookies = parseCookieString(COOKIE_STR);
    if (cookies.length) await context.addCookies(cookies);
  }

  const page = await context.newPage();
  await page.goto(`https://onlyfans.com/${USERNAME}`, { waitUntil: 'domcontentloaded' });
  // Piccola attesa perché i contatori compaiano
  await page.waitForTimeout(2000);

  // Prendiamo tutto il testo visibile per essere robusti a layout diversi e lingua
  const allText = await page.evaluate(() => document.body.innerText);

  const likes  = pickByLabels(allText, ['Mi piace', 'Likes']);
  const photos = pickByLabels(allText, ['Foto', 'Photos']);
  const videos = pickByLabels(allText, ['Video', 'Videos']);
  // fallback extra, se vuoi anche Posts/Media
  const media  = pickByLabels(allText, ['Media']);

  const out = {
    username: USERNAME,
    likes,
    photos: photos || media, // se non trova "Foto", prova "Media"
    videos,
    available: /online|disponibile|available/i.test(allText),
    updatedAt: new Date().toISOString(),
  };

  fs.writeFileSync('stats.json', JSON.stringify(out, null, 2));
  console.log('Saved', out);

  await browser.close();
})();

