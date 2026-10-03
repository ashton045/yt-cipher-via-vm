import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { JSDOM } from 'jsdom';


if (typeof process.loadEnvFile === "function") {
  try {
    process.loadEnvFile();
  } catch { }
}

const useragent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const vm_cache = new Map();
let current_player = null;
let last_player_found = 0;

if (!fs.existsSync(path.resolve("player_cache"))) fs.mkdirSync(path.resolve("player_cache"), { recursive: true });

function formatVariant(variant) {
  if (!variant) return "player_es6.vflset";

  let v = variant.trim();

  if (!v.startsWith("player_")) {
    v = `player_${v.toLowerCase()}`;
  }

  if (!v.endsWith(".vflset")) {
    v = `${v}.vflset`;
  }

  return v;
}

function toNormalUrl(url) {

  if (!url || typeof url !== "string") return '';

  url = url.trim();

  if (!url.startsWith("http")) {
    url = `https://www.youtube.com${url.startsWith("/") ? "" : '/'}${url}`;
  }

  return url;
}

export async function getActivePlayerUrl() {
  const now = Date.now();

  if (current_player && (now - last_player_found < 30 * 60 * 1000))
    return current_player;

  const variant = formatVariant(process.env.OVERRIDE_PLAYER_VARIANT || "player_es6.vflset");
  const reg = (process.env.OVERRIDE_REGION || "en_US").trim();

  try {

    const res = await fetch("https://www.youtube.com", {
      headers: {
        'User-Agent': useragent
      }
    });

    if (res.ok) {
      const html = await res.text();
      const match = html.match(/"PLAYER_JS_URL"\s*:\s*"([^"]+)"/);

      if (match) {
        const fullUrl = `https://www.youtube.com${match[1]}`;

        if (process.env.OVERRIDE_PLAYER_VARIANT || process.env.OVERRIDE_REGION) {

          const idMatch = fullUrl.match(/\/player\/([a-zA-Z0-9_-]+)\//);
          const id = idMatch ? idMatch[1] : '';

          current_player = `https://www.youtube.com/s/player/${id}/${variant}/${reg}/base.js`;

        } else {
          current_player = toNormalUrl(fullUrl);
        }

        last_player_found = now;
        return current_player;
      }
    }

  } catch (err) {
    console.error(err)
  }

  try {

    const res = await fetch("https://www.youtube.com/embed/", {
      headers: { 'User-Agent': useragent }
    });

    if (res.ok) {

      const html = await res.text();
      const match = html.match(/"(?:PLAYER_JS_URL|jsUrl)"\s*:\s*"([^"]+)"/) || html.match(/src="(\/s\/player\/[^"]+\/base\.js)"/);

      if (match) {
        const fullUrl = `https://www.youtube.com${match[1]}`;

        if (process.env.OVERRIDE_PLAYER_VARIANT || process.env.OVERRIDE_REGION) {

          const idMatch = fullUrl.match(/\/player\/([a-zA-Z0-9_-]+)\//);
          const id = idMatch ? idMatch[1] : '';

          current_player = `https://www.youtube.com/s/player/${id}/${variant}/${reg}/base.js`;

        } else {
          current_player = toNormalUrl(fullUrl);
        }

        last_player_found = now;
        return current_player;

      }
    }
  } catch (err) {
    console.error(err);
  }

  try {

    const res = await fetch("https://www.youtube.com/iframe_api", {
      headers: { 'User-Agent': useragent }
    });

    if (res.ok) {

      const text = await res.text();
      const unescaped = text.replace(/\\\//g, '/');
      const match = unescaped.match(/\/s\/player\/([a-zA-Z0-9_-]+)\//);

      if (match) {
        const id = match[1];

        if (current_player && !process.env.OVERRIDE_PLAYER_VARIANT && !process.env.OVERRIDE_REGION) {

          current_player = current_player.replace(/\/player\/[a-zA-Z0-9_-]+\//, `/player/${id}/`);

        } else {
          current_player = `https://www.youtube.com/s/player/${id}/${variant}/${reg}/base.js`;
        }

        last_player_found = now;
        return current_player;
      }
    }
  } catch (err) {
    console.error(err);
  }

  if (current_player) {
    return current_player;
  }

  throw new Error("failed to discover active youtbe player script url");
}

async function fetchPlayerCode(playerUrl) {

  const filePath = path.join(path.resolve("player_cache"), `${crypto.createHash('sha256').update(playerUrl).digest('hex')}.js`);

  if (fs.existsSync(filePath)) {
    return fs.readFileSync(filePath, 'utf8');
  }

  const res = await fetch(playerUrl, {
    headers: { 'User-Agent': useragent }
  });

  if (!res.ok) {
    throw new Error(`failed to fetch player script: ${res.status} ${res.statusText} (${playerUrl})`);
  }

  const code = await res.text();
  fs.writeFileSync(filePath, code, 'utf8');
  return code;
}

export async function getPlayerVM(targetUrl = null) {
  const playerUrl = targetUrl ? toNormalUrl(targetUrl) : await getActivePlayerUrl();

  if (vm_cache.has(playerUrl)) {
    return vm_cache.get(playerUrl);
  }

  const code = await fetchPlayerCode(playerUrl);

  const stsMatch = code.match(/(?:signatureTimestamp|sts)\s*:\s*(\d+)/);

  if (!stsMatch || !stsMatch[1]) {
    throw new Error(`Signature timestamp (sts) not found in player script: ${playerUrl}`);
  }
  const sts = stsMatch[1];

  let updated = code;
  const match = updated.match(/([a-zA-Z0-9_$]+)\s*=\s*(function\b[^{]*\{[^}]*set\("alr"\s*,\s*"yes"\)[^}]*return\s+[^}]+;?\})/);

  if (match) {
    const fnName = match[1];
    updated = updated.replace(match[0], `${fnName}=(window.__solve_url=${match[2]})`);
  }

  const dom = new JSDOM('<!DOCTYPE html><html><head></head><body></body></html>', {
    url: 'https://www.youtube.com',
    referrer: 'https://www.youtube.com/',
    runScripts: 'dangerously'
  });

  dom.window.eval(updated);

  const solver = dom.window.__solve_url;
  if (typeof solver !== "function") {
    throw new Error(`failed to bind player url challenge solver in VM for ${playerUrl}`);
  }

  const vm_config = {
    playerUrl,
    sts,
    dom,
    solver,
    resolveFormat(url, sp = 'sig', encryptedSig = null) {

      const urlObj = solver(url, sp, encryptedSig || '');
      const sig = urlObj.get(sp);
      const decipheredSig = sig ? decodeURIComponent(sig) : null;
      const decipheredN = urlObj.get('n') || null;

      let resolvedUrl = null;
      const proto = Object.getPrototypeOf(urlObj);
      for (const method of Object.getOwnPropertyNames(proto)) {
        if (typeof urlObj[method] === 'function' && method !== 'constructor' && method !== 'set' && method !== 'get' && method !== 'clone') {
          try {
            const val = urlObj[method]();
            if (typeof val === 'string' && val.startsWith('http')) {
              resolvedUrl = val;
              break;
            }
          } catch { }
        }
      }

      if (!resolvedUrl && typeof urlObj.url === 'string' && urlObj.url.startsWith('http')) {
        resolvedUrl = urlObj.url;
      }

      if (resolvedUrl) {
        resolvedUrl = resolvedUrl.replace(/([?&])alr=yes&?/, '$1').replace(/[?&]$/, '');
      }

      return {
        resolvedUrl,
        sig: decipheredSig,
        n: decipheredN,
        sp
      };
    },
    decryptSignature(encryptedSig, nParam) {
      const targetUrl = nParam
        ? `https://www.googlevideo.com/videoplayback?n=${encodeURIComponent(nParam)}`
        : 'https://www.googlevideo.com/videoplayback';
      const urlObj = solver(targetUrl, 'sig', encryptedSig || '');

      const sig = urlObj.get('sig');
      const decryptedSig = sig ? decodeURIComponent(sig) : '';
      const decryptedN = urlObj.get('n') || '';

      return {
        decrypted_signature: decryptedSig,
        decrypted_n_sig: decryptedN
      };
    }
  };

  vm_cache.set(playerUrl, vm_config);
  return vm_config;
}

export async function resolveUrl({ stream_url, encrypted_signature, signature_key, player_url }) {
  if (!stream_url) {
    throw new Error('stream_url is required');
  }

  const vm = await getPlayerVM(player_url);
  const result = vm.resolveFormat(stream_url, signature_key || 'sig', encrypted_signature);

  return {
    resolved_url: result.resolvedUrl
  };
}

export async function decryptSignature({ encrypted_signature, n_sig, player_url }) {
  if (!encrypted_signature && !n_sig) {
    throw new Error("either encrypted_signature or n_sig must be provided");
  }

  const vm = await getPlayerVM(player_url);

  return vm.decryptSignature(encrypted_signature, n_sig);
}

export async function getSts({ player_url } = {}) {
  const vm = await getPlayerVM(player_url);

  return {
    sts: vm.sts
  };
}
