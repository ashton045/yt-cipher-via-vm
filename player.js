import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { Worker } from 'node:worker_threads';
import { parseScript } from 'meriyah';

if (typeof process.loadEnvFile === "function") {
  try {
    process.loadEnvFile();
  } catch { }
}

const useragent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
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

async function fetchPlayerCode(player_url) {

  const filePath = path.join(path.resolve("player_cache"), `${crypto.createHash('sha256').update(player_url).digest('hex')}.js`);

  if (fs.existsSync(filePath)) {
    return fs.readFileSync(filePath, 'utf8');
  }

  const res = await fetch(player_url, {
    headers: { 'User-Agent': useragent }
  });

  if (!res.ok) {
    throw new Error(`failed to fetch player script: ${res.status} ${res.statusText} (${player_url})`);
  }

  const code = await res.text();
  fs.writeFileSync(filePath, code, 'utf8');
  return code;
}

function hookSolverFunction(code) {
  const ast = parseScript(code, { ranges: true, next: true });

  let target_fn = null;

  function isUrlSolverFunction(fn_node) {
    if (!fn_node || !fn_node.body || fn_node.body.type !== 'BlockStatement') return false;
    if (fn_node.async || fn_node.generator) return false;

    const return_st = fn_node.body.body.find(s => s.type === 'ReturnStatement');
    if (!return_st || !return_st.argument) return false;

    const fn_code = code.slice(fn_node.range[0], fn_node.range[1]);
    if (!fn_code.includes('!0') || fn_code.includes('this.') || fn_code.includes('Promise')) return false;

    return true;
  }

  function next(node, enclosing_named_fn) {
    if (!node || typeof node !== 'object') return;

    let current_named_fn = enclosing_named_fn;

    if (node.type === 'FunctionDeclaration' && node.id) {
      current_named_fn = { node, name: node.id.name, isDecl: true };
    } else if (
      node.type === 'AssignmentExpression' &&
      node.left &&
      node.left.type === 'Identifier' &&
      node.right &&
      (node.right.type === 'FunctionExpression' || node.right.type === 'ArrowFunctionExpression')
    ) {
      current_named_fn = { node: node.right, name: node.left.name, isDecl: false };
    } else if (
      node.type === 'VariableDeclarator' &&
      node.id &&
      node.id.type === 'Identifier' &&
      node.init &&
      (node.init.type === 'FunctionExpression' || node.init.type === 'ArrowFunctionExpression')
    ) {
      current_named_fn = { node: node.init, name: node.id.name, isDecl: false };
    }

    if (
      node.type === 'CallExpression' &&
      node.callee &&
      node.callee.type === 'MemberExpression' &&
      node.callee.property &&
      (node.callee.property.name === 'set' || node.callee.property.value === 'set') &&
      node.arguments &&
      node.arguments.length >= 2 &&
      node.arguments[0].value === 'alr' &&
      node.arguments[1].value === 'yes'
    ) {
      if (current_named_fn && isUrlSolverFunction(current_named_fn.node)) {
        target_fn = current_named_fn;
        return;
      }
    }

    for (const key of Object.keys(node)) {
      if (target_fn) return;
      const child = node[key];
      if (Array.isArray(child)) {
        for (let i = 0; i < child.length; i++) {
          next(child[i], current_named_fn);
          if (target_fn) return;
        }
      } else if (child && typeof child === 'object') {
        next(child, current_named_fn);
        if (target_fn) return;
      }
    }
  }

  next(ast, null);

  if (target_fn) {
    const fn_node = target_fn.node;
    const [start, end] = fn_node.range;
    const snippet = code.slice(start, end);
    const name = target_fn.name;

    if (target_fn.isDecl) {
      return code.slice(0, start) + `var ${name}=(globalThis.__solve_url=${snippet})` + code.slice(end);
    } else {
      return code.slice(0, start) + `(globalThis.__solve_url=${snippet})` + code.slice(end);
    }
  }

  return code;
}

const MAX_THREADS = Math.max(1, process.env.MAX_THREADS ? parseInt(process.env.MAX_THREADS, 10) : Math.min(os.availableParallelism?.() || 2, 4));

const player_data_cache = new Map();
const workers = [];
const pending_tasks = new Map();
let task_seq = 0;
let round_robin = 0;
const loaded_in_workers = new Map();

let is_terminating = false;

function spawnWorker(index) {
  const w = new Worker(new URL('./worker.js', import.meta.url));
  w.on('message', (msg) => {
    const task = pending_tasks.get(msg.id);
    if (task) {
      pending_tasks.delete(msg.id);
      if (msg.ok) task.resolve(msg.result);
      else task.reject(new Error(msg.error));
    }
  });
  w.on('error', (err) => {
    console.error(`Worker ${index} error:`, err);
  });
  w.on('exit', (code) => {
    if (code !== 0 && !is_terminating) {
      console.warn(`Worker ${index} exited with code ${code}. Replacing...`);
      loaded_in_workers.delete(index);
      workers[index] = spawnWorker(index);
    }
  });
  return w;
}

if (MAX_THREADS > 0) {
  for (let i = 0; i < MAX_THREADS; i++) {
    workers.push(spawnWorker(i));
  }
}

const MAX_PLAYER_CACHE = 5;

export async function getPlayerData(target_url = null) {
  const player_url = target_url ? toNormalUrl(target_url) : await getActivePlayerUrl();

  if (target_url) {
    current_player = player_url;
    last_player_found = Date.now();
  }

  const file_path = path.join(path.resolve("player_cache"), `${crypto.createHash('sha256').update(player_url).digest('hex')}.js`);

  if (player_data_cache.has(player_url)) {
    const cached = player_data_cache.get(player_url);
    if (!fs.existsSync(file_path) && cached.code) {
      try {
        fs.writeFileSync(file_path, cached.code, 'utf8');
      } catch { }
    }
    return cached;
  }

  if (player_data_cache.size >= MAX_PLAYER_CACHE) {
    const oldest = player_data_cache.keys().next().value;
    player_data_cache.delete(oldest);
  }

  const code = await fetchPlayerCode(player_url);
  const sts_match = code.match(/(?:signatureTimestamp|sts)\s*:\s*(\d+)/);
  if (!sts_match || !sts_match[1]) {
    throw new Error(`Signature timestamp (sts) not found in player script: ${player_url}`);
  }
  const sts = sts_match[1];
  const hooked_code = hookSolverFunction(code);

  const data = { player_url, sts, hooked_code, code };
  player_data_cache.set(player_url, data);
  return data;
}

async function dispatchToWorker(type, player_url, payload) {
  const player_data = await getPlayerData(player_url);
  const url = player_data.player_url;

  const worker_idx = round_robin++ % workers.length;
  const w = workers[worker_idx];

  let loaded_set = loaded_in_workers.get(worker_idx);
  if (!loaded_set) {
    loaded_set = new Set();
    loaded_in_workers.set(worker_idx, loaded_set);
  }

  if (!loaded_set.has(url)) {
    await new Promise((resolve, reject) => {
      const id = ++task_seq;
      pending_tasks.set(id, { resolve, reject });
      w.postMessage({ id, type: 'LOAD_PLAYER', player_url: url, hooked_code: player_data.hooked_code, sts: player_data.sts });
    });
    loaded_set.add(url);
  }

  return new Promise((resolve, reject) => {
    const id = ++task_seq;
    pending_tasks.set(id, { resolve, reject });
    w.postMessage({ id, type, player_url: url, payload });
  });
}

export async function resolveUrl({ stream_url, encrypted_signature, signature_key, player_url, n_param }) {
  if (!stream_url) {
    throw new Error('stream_url is required');
  }

  return dispatchToWorker('resolve_url', player_url, { stream_url, encrypted_signature, signature_key, n_param });
}

export async function decryptSignature({ encrypted_signature, n_param, player_url }) {
  if (!encrypted_signature && !n_param) {
    throw new Error("either encrypted_signature or n_param must be provided");
  }

  return dispatchToWorker('decrypt_signature', player_url, { encrypted_signature, n_param });
}

export async function getSts({ player_url } = {}) {
  const player_data = await getPlayerData(player_url);

  if (workers.length > 0) {
    for (let i = 0; i < workers.length; i++) {
      let loaded_set = loaded_in_workers.get(i);
      if (!loaded_set) {
        loaded_set = new Set();
        loaded_in_workers.set(i, loaded_set);
      }
      if (!loaded_set.has(player_data.player_url)) {
        const id = ++task_seq;
        workers[i].postMessage({
          id,
          type: 'LOAD_PLAYER',
          player_url: player_data.player_url,
          hooked_code: player_data.hooked_code,
          sts: player_data.sts
        });
        loaded_set.add(player_data.player_url);
      }
    }
  }

  return {
    sts: player_data.sts
  };
}

export async function terminatePool() {
  is_terminating = true;
  await Promise.all(workers.map(w => w.terminate()));
  workers.length = 0;
}
