import { chromium } from "playwright";
import fs from "fs-extra";

const USER = process.env.TARGET_USERNAME;          // es. iliyanadg
const COOKIE = process.env.OF_COOKIE;              // "name=value; name2=value2; ..."
const OUT = "stats.json";

const parseNum = (s) => {
  if (!s) return 0;
  const k = s.toLowerCase().trim();
  if (k.endsWith("k")) return Math.round(parseFloat(k)*1000);
  if (k.endsWith("m")) return Math.round(parseFloat(k)*1_000_000);
  return Math.round(parseFloat(k.replace(/[^\d.]/g,""))||0);
};

(async () => {
  if (!USER) throw new Error("TARGET_USERNAME mancante");
  if (!COOKIE) throw new Error("OF_COOKIE mancante");
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();

  const cookies = COOKIE.split(";").map(s => {
    const [name, ...rest] = s.trim().split("=");
    return { name, value: rest.join("="), domain: ".onlyfans.com", path: "/" };
  });
  await context.addCookies(cookies);

  const page = await context.newPage();
  await page.goto(`https://onlyfans.com/${USER}`, { waitUntil: "domcontentloaded", timeout: 120000 });
  await page.waitForTimeout(4000);

  const txt = await page.evaluate(() => document.body.innerText);

  const likes  = parseNum((txt.match(/likes?:?\s*([0-9.,kKmM]+)/) || [])[1]);
  const photos = parseNum((txt.match(/photos?:?\s*([0-9.,kKmM]+)/) || [])[1]);
  const videos = parseNum((txt.match(/videos?:?\s*([0-9.,kKmM]+)/) || [])[1]);
  const available = /online|available|last seen/i.test(txt);

  const data = {
    username: USER,
    likes, photos, videos,
    available,
    updatedAt: new Date().toISOString()
  };

  await fs.writeJson(OUT, data, { spaces: 2 });
  await browser.close();
  console.log("Saved", data);
})();
