import { parentPort } from 'node:worker_threads';
import vm from 'node:vm';

const useragent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const vm_cache = new Map();

function createBrowserSandbox() {
  const createStub = (name = 'stub') => {
    const fn = function () { };
    return new Proxy(fn, {
      get(target, prop) {
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
    createElement: () => ({ setAttribute: () => {}, getAttribute: () => null, style: {} }),
    getElementsByTagName: () => [],
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    head: {},
    body: {},
    cookie: '',
    addEventListener: () => {},
    removeEventListener: () => {},
    location: location
  }, {
    get(target, prop) {
      if (prop in target) return target[prop];
      return createStub(`document.${String(prop)}`);
    }
  });

  const globals = {
    location: location,
    navigator: { userAgent: useragent },
    document: document,
    XMLHttpRequest: class XMLHttpRequest {},
    addEventListener: () => {},
    removeEventListener: () => {},
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

const MAX_PLAYER_CACHE = 5;

function load_player(player_url, hooked_code, sts) {
  if (vm_cache.size >= MAX_PLAYER_CACHE) {
    const oldest_key = vm_cache.keys().next().value;
    vm_cache.delete(oldest_key);
  }

  const sandbox = createBrowserSandbox();
  vm.runInContext(hooked_code, sandbox, { timeout: 5000 });

  const solver = sandbox.__solve_url;
  if (typeof solver !== 'function') {
    throw new Error(`failed to bind player challenge solver in worker for ${player_url}`);
  }

  function resolve_format(url, sp = 'sig', encrypted_sig = null) {
    const url_obj = solver(url, sp, encrypted_sig || '');
    const sig = url_obj.get(sp);
    const deciphered_sig = sig ? decodeURIComponent(sig) : null;
    const deciphered_n_param = url_obj.get('n') || null;

    let resolved_url = typeof url_obj.url === 'string' && url_obj.url.startsWith('http') ? url_obj.url : null;

    if (!resolved_url && typeof url_obj.rC === 'function') {
      try {
        const val = url_obj.rC();
        if (typeof val === 'string' && val.startsWith('http')) resolved_url = val;
      } catch {}
    }

    if (!resolved_url) {
      const proto = Object.getPrototypeOf(url_obj);
      for (const method of Object.getOwnPropertyNames(proto)) {
        if (typeof url_obj[method] === 'function' && method !== 'constructor' && method !== 'set' && method !== 'get' && method !== 'clone') {
          try {
            const val = url_obj[method]();
            if (typeof val === 'string' && val.startsWith('http')) {
              resolved_url = val;
              break;
            }
          } catch {}
        }
      }
    }

    if (resolved_url) {
      resolved_url = resolved_url.replace(/([?&])alr=yes&?/, '$1').replace(/[?&]$/, '');
    }

    return {
      resolved_url,
      resolvedUrl: resolved_url,
      sig: deciphered_sig,
      n: deciphered_n_param,
      sp
    };
  }

  function decrypt_signature(encrypted_sig, n_param) {
    const url = n_param
      ? `https://www.googlevideo.com/videoplayback?n=${encodeURIComponent(n_param)}`
      : 'https://www.googlevideo.com/videoplayback';
    const url_obj = solver(url, 'sig', encrypted_sig || '');

    const sig = url_obj.get('sig');
    return {
      decrypted_signature: sig ? decodeURIComponent(sig) : '',
      decrypted_n_sig: url_obj.get('n') || ''
    };
  }

  const vm_config = {
    player_url,
    sts,
    solver,
    resolve_format,
    resolveFormat: resolve_format,
    decrypt_signature,
    decryptSignature: decrypt_signature
  };

  vm_cache.set(player_url, vm_config);
  return vm_config;
}

const loadPlayer = load_player;

parentPort.on('message', (msg) => {
  const player_url = msg.player_url || msg.playerUrl;
  const hooked_code = msg.hooked_code || msg.hookedCode;
  const { id, type, sts, payload } = msg;

  try {
    if (type === 'LOAD_PLAYER') {
      load_player(player_url, hooked_code, sts);
      parentPort.postMessage({ id, ok: true });
      return;
    }

    const inst = vm_cache.get(player_url);
    if (!inst) {
      throw new Error(`player not initialized in worker: ${player_url}`);
    }

    if (type === 'decrypt_signature') {
      const result = inst.decrypt_signature(payload.encrypted_signature, payload.n_param);
      parentPort.postMessage({ id, ok: true, result });
    } else if (type === 'resolve_url') {
      let url = payload.stream_url;
      if (payload.n_param && !url.includes('n=')) {
        const sep = url.includes('?') ? '&' : '?';
        url += `${sep}n=${encodeURIComponent(payload.n_param)}`;
      }
      const res = inst.resolve_format(url, payload.signature_key || 'sig', payload.encrypted_signature);
      parentPort.postMessage({ id, ok: true, result: { resolved_url: res.resolved_url } });
    } else if (type === 'get_sts') {
      parentPort.postMessage({ id, ok: true, result: { sts: inst.sts } });
    } else {
      parentPort.postMessage({ id, ok: false, error: `unknown task type: ${type}` });
    }
  } catch (err) {
    parentPort.postMessage({ id, ok: false, error: err.message });
  }
});
