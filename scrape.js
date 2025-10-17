// scrape.js — robusto: network JSON + HTML + testo, con fallback
const fs = require("fs");
const { chromium, devices } = require("playwright");

// env
const USERNAME = process.env.TARGET_USERNAME;   // es. iliyanadg
const COOKIE = process.env.OF_COOKIE || "";     // cookie account viewer

// --- util ---
function parseCookieHeader(h) {
  return h
    .split(";")
    .map(s => s.trim())
    .filter(Boolean)
    .map(kv => {
      const i = kv.indexOf("=");
      if (i === -1) return null;
      return { name: kv.slice(0, i), value: kv.slice(i + 1) };
    })
    .filter(Boolean);
}
const toNum = s => {
  if (!s) return 0;
  const n = String(s).replace(/\./g, "").replace(",", ".");
  const v = Number(n);
  return Number.isFinite(v) ? v : 0;
};
function pickFrom(source, regs) {
  for (const r of regs) {
    const m = source.match(r);
    if (m && m[1]) return toNum(m[1]);
  }
  return 0;
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    ...devices["iPhone 12 Pro"],
    locale: "it-IT",
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 14_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.0 Mobile/15E148 Safari/604.1",
  });

  // cookies (viewer)
  if (COOKIE) {
    const cookies = parseCookieHeader(COOKIE).map(c => ({
      ...c,
      domain: ".onlyfans.com",
      path: "/",
      secure: true,
    }));
    if (cookies.length) await ctx.addCookies(cookies);
  }

  const page = await ctx.newPage();

  // cattura tutte le risposte XHR/Fetch per cercare JSON con counts
  const netBuckets = [];
  page.on("response", async (res) => {
    try {
      const reqType = res.request().resourceType();
      if (reqType === "xhr" || reqType === "fetch") {
        const ct = res.headers()["content-type"] || "";
        if (ct.includes("application/json")) {
          const j = await res.json();
          netBuckets.push(JSON.stringify(j));
        } else {
          // come fallback prova a leggere testo (a volte JSON senza header giusto)
          const t = await res.text();
          if (t && /count|photos|videos|posts|likes/i.test(t)) {
            netBuckets.push(t);
          }
        }
      }
    } catch (_) {}
  });

  const url = `https://onlyfans.com/${USERNAME}`;
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });

  // prova a chiudere banner cookie/consenso, senza bloccare
  try {
    await page.locator('button:has-text("Accetta")').first().click({ timeout: 1500 });
  } catch {}
  try {
    await page.locator('button:has-text("Accept")').first().click({ timeout: 1500 });
  } catch {}

  // attendi idratazione + scroll per triggerare caricamenti
  await page.waitForLoadState("networkidle", { timeout: 45000 }).catch(()=>{});
  await page.waitForTimeout(2500);
  await page.evaluate(async () => {
    window.scrollTo(0, document.body.scrollHeight);
    await new Promise(r => setTimeout(r, 1500));
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(1500);

  // raccogli fonti: network JSON, HTML, testo
  const html = await page.evaluate(() => document.documentElement.innerHTML || "");
  const text = await page.evaluate(() => document.body.innerText || "");
  const bucket = [html, text, ...netBuckets].join("\n");

  // regex su JSON (chiavi spesso presenti negli state interni)
  const photosFromJson = pickFrom(bucket, [
    /"photosCount"\s*:\s*(\d+)/i,
    /"photos"\s*:\s*(\d+)/i,
    /"media_photos_count"\s*:\s*(\d+)/i,
  ]);
  const videosFromJson = pickFrom(bucket, [
    /"videosCount"\s*:\s*(\d+)/i,
    /"videos"\s*:\s*(\d+)/i,
    /"media_videos_count"\s*:\s*(\d+)/i,
  ]);
  const likesFromJson = pickFrom(bucket, [
    /"likesCount"\s*:\s*(\d+)/i,
    /"favoritesCount"\s*:\s*(\d+)/i,
    /"posts_likes_count"\s*:\s*(\d+)/i,
  ]);
  const postsFromJson = pickFrom(bucket, [
    /"postsCount"\s*:\s*(\d+)/i,
    /"posts"\s*:\s*(\d+)/i,
  ]);
  const onlineJson = /"isOnline"\s*:\s*true/i.test(bucket);

  // fallback su testo visibile IT/EN
  const likesFromText = pickFrom(text, [
    /(\d[\d\.,]*)\s*(?:mi\s*piace|likes?)/i,
    /❤\s*(\d[\d\.,]*)/i,
  ]);
  const photosFromText = pickFrom(text, [
    /(\d[\d\.,]*)\s*(?:foto|photos?)/i,
    /🖼️\s*(\d[\d\.,]*)/i,
  ]);
  const videosFromText = pickFrom(text, [
    /(\d[\d\.,]*)\s*(?:video|videos?)/i,
    /🎥\s*(\d[\d\.,]*)/i,
  ]);

  // scegli il meglio tra sorgenti
  const likes  = Math.max(likesFromJson, likesFromText);
  const photos = Math.max(photosFromJson, photosFromText);
  const videos = Math.max(videosFromJson, videosFromText);

  // se tutto zero, prova a stimare da "media" / "posts"
  let finalPhotos = photos;
  let finalVideos = videos;
  if (finalPhotos === 0 && finalVideos === 0) {
    // alcuni profili espongono solo "post totali"
    const postsFromText = pickFrom(text, [
      /(\d[\d\.,]*)\s*(?:post|posts)/i,
    ]) || postsFromJson;

    // se abbiamo solo il totale, lascia foto=tot, video=0 (meglio mostrare un numero che 0/0)
    if (postsFromText > 0) {
      finalPhotos = postsFromText;
      finalVideos = 0;
    }
  }

  const data = {
    username: USERNAME,
    likes: likes,
    photos: finalPhotos,
    videos: finalVideos,
    available: onlineJson || /online|disponibile|available/i.test(text),
    updatedAt: new Date().toISOString(),
  };

  fs.writeFileSync("stats.json", JSON.stringify(data, null, 2));
  console.log("Saved", data);

  await browser.close();
})().catch(err => {
  console.error(err);
  process.exit(1);
});

