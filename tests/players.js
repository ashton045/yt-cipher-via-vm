import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { parseScript } from 'meriyah';
import { sliceSolver, findSolverFunction, hookSolverFunction, terminatePool } from '../player.js';

const dir = 'player_cache';
const useragent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0 Safari/537.36';

const variants = [
  { name: 'player_ias', file: '76804a9c2175cbf36cfee87afb332cc2f12cd5bb48af5c4ba75354a584fd4995.js', url: 'https://www.youtube.com/s/player/8ab5c328/player_ias.vflset/en_US/base.js' },
  { name: 'player_ias_tcc', file: 'aefcffc747f1dea901db6d564fbf00c5aa9c33e7407053bbada3cab535cb7b1d.js', url: 'https://www.youtube.com/s/player/8ab5c328/player_ias_tcc.vflset/en_US/base.js' },
  { name: 'player_ias_tce', file: '16382257e0f3f9e7c3960b67468a6a6ab7f50d6989b1b355a7aebaa64126653c.js', url: 'https://www.youtube.com/s/player/8ab5c328/player_ias_tce.vflset/en_US/base.js' },
  { name: 'player_es6', file: '87e5f4c32f1411b3b9b0096a079bc66335ea0a74b19fff75ae40ab5ebed53262.js', url: 'https://www.youtube.com/s/player/8ab5c328/player_es6.vflset/en_US/base.js' },
  { name: 'player_es6_tcc', file: '7d009fb8904c39bc24e7c916664c057e76726703d9fccb19ad88b257b2d7f1a1.js', url: 'https://www.youtube.com/s/player/8ab5c328/player_es6_tcc.vflset/en_US/base.js' },
  { name: 'player_es6_tce', file: 'dbbc92a11a2806fa36ad4e309e90f9e74589fef09ce78475a01b63da9ff59092.js', url: 'https://www.youtube.com/s/player/8ab5c328/player_es6_tce.vflset/en_US/base.js' },
  { name: 'player_phone', file: '66a5abd2a4596ca176a76125684f9ccbd274cdf57383665dd95eb9fe88f19b5a.js', url: 'https://www.youtube.com/s/player/8ab5c328/player-plasma-ias-phone-en_US.vflset/base.js' },
  { name: 'player_tv', file: 'ea2cf252cbfa51c86cea0059d8fe91485241534d9f2b1aad6d992ccd8ec86cf6.js', url: 'https://www.youtube.com/s/player/8ab5c328/tv-player-ias.vflset/tv-player-ias.js' },
  { name: 'player_tv_es6', file: '3ad82e278024ed8fd4968786628eaf172088febf957dbb917e08728985555b35.js', url: 'https://www.youtube.com/s/player/8ab5c328/tv-player-es6.vflset/tv-player-es6.js' },
  { name: 'player_embed', file: 'a6090142ded2dd62b7738048688d92fe472e0a13fba83498af912590d28b66d4.js', url: 'https://www.youtube.com/s/player/8ab5c328/player_embed.vflset/en_US/base.js' },
  { name: 'player_embed_es6', file: 'ae9873fe6fc0638ea5487be2b88d37ac22c49bfc1d2d733f7c13d109f7e22822.js', url: 'https://www.youtube.com/s/player/8ab5c328/player_embed_es6.vflset/en_US/base.js' },
  { name: 'player_house', file: '9814e7c96badcab844df159aa947e8826cd808946468d0e20ebb1417766b6c83.js', url: 'https://www.youtube.com/s/player/8ab5c328/house_brand_player.vflset/en_US/base.js' },
  { name: 'player_tv_tcl', file: '43837ceb0a412cc42cd97045cfe3d52d2eecaac1aacce2c77be8994188a0b1e0.js', fallbackFile: 'tests/tcl_player.js' }
];

function createBrowserSandbox() {
  const createStub = (name = 'stub') => {
    const fn = function () { };
    return new Proxy(fn, {
      get(_, prop) {
        if (prop === Symbol.toPrimitive) return () => '';
        if (prop === 'toString' || prop === 'valueOf') return () => `[${name}]`;
        if (prop === 'prototype') return {};
        return createStub(`${name}.${String(prop)}`);
      },
      apply() { return createStub(`${name}()`); },
      construct() { return createStub(`new ${name}`); }
    });
  };

  const location = {
    href: 'https://www.youtube.com/',
    origin: 'https://www.youtube.com',
    host: 'www.youtube.com',
    hostname: 'www.youtube.com',
    protocol: 'https:',
    pathname: '/',
    search: '',
    hash: '',
    port: ''
  };

  const document = new Proxy({
    createElement: () => ({ setAttribute: () => { }, getAttribute: () => null, style: {} }),
    getElementsByTagName: () => [],
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    head: {},
    body: {},
    cookie: '',
    addEventListener: () => { },
    removeEventListener: () => { },
    location: location
  }, {
    get(target, prop) {
      if (prop in target) return target[prop];
      return createStub(`document.${String(prop)}`);
    }
  });

  const globals = {
    location: location,
    navigator: { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0 Safari/537.36' },
    document: document,
    XMLHttpRequest: class XMLHttpRequest { },
    addEventListener: () => { },
    removeEventListener: () => { },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval
  };

  const windowProxy = new Proxy(globals, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (typeof prop === 'string' && (prop === 'window' || prop === 'self' || prop === 'globalThis')) return windowProxy;
      if (prop in globalThis) return globalThis[prop];
      return undefined;
    }
  });

  globals.window = windowProxy;
  globals.self = windowProxy;
  globals.globalThis = windowProxy;

  return vm.createContext(windowProxy);
}

const testSig = 'gA8wRAIgP0WqV1Qz8u5ZJqCq2G9e0jG2pU0N2sQ4n4M4k4X4u4MCIC2Q8m2f8k2v0N4j0L2u0R8y4L0v4e2Z8w2P0r4e2Z';
const testN = 'abcdef123456';

async function main() {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  for (const v of variants) {
    const filePath = path.join(dir, v.file);

    if (!fs.existsSync(filePath)) {
      if (v.fallbackFile && fs.existsSync(v.fallbackFile)) {
        fs.copyFileSync(v.fallbackFile, filePath);
      } else if (v.url) {
        try {
          const res = await fetch(v.url, { headers: { 'User-Agent': useragent } });
          if (res.ok) {
            const body = await res.text();
            fs.writeFileSync(filePath, body, 'utf8');
          }
        } catch {}
      }
    }

    if (!fs.existsSync(filePath)) continue;

    const code = fs.readFileSync(filePath, 'utf8');
    const ast = parseScript(code, { ranges: true, next: true });
    const target_fn = findSolverFunction(ast, code);
    const isTv = v.name.startsWith('player_tv') || v.file.includes('tcl') || target_fn?.isTcl;
    const sliced_code = !isTv ? (sliceSolver(code, ast, target_fn) || hookSolverFunction(code, ast, target_fn)) : hookSolverFunction(code, ast, target_fn);

    const sandbox = createBrowserSandbox();
    vm.runInContext(sliced_code, sandbox, { timeout: 5000 });
    const solver = sandbox.__solve_url;

    const url = `https://www.googlevideo.com/videoplayback?n=${encodeURIComponent(testN)}`;
    const urlObj = solver(url);
    const sig = urlObj.get('sig');
    const deciphered_s = sig ? decodeURIComponent(sig) : '';
    const deciphered_n = urlObj.get('n') || '';

    const actualSize = `${(code.length / (1024 * 1024)).toFixed(2)} MB`;
    const formalSize = `${(sliced_code.length / (1024 * 1024)).toFixed(2)} MB`;
    const stsMatch = code.match(/(?:signatureTimestamp|sts)\s*:\s*(\d+)/);
    const sts = stsMatch ? stsMatch[1] : '';

    console.log(`${v.name}: actual player size: ${actualSize} after modification: ${formalSize} sts: ${sts}`);
    console.log(`deciphered s: ${deciphered_s}, n: ${deciphered_n}`);
  }

  await terminatePool();
}

main().catch(async (err) => {
  console.error(err);
  await terminatePool();
  process.exit(1);
});
