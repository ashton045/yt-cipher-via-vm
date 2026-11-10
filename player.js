import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import { Worker } from "node:worker_threads";
import { parseScript } from "meriyah";

if (typeof process.loadEnvFile === "function") {
  try {
    process.loadEnvFile();
  } catch {}
}

const useragent =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
let current_player = null;
let last_player_found = 0;

if (!fs.existsSync(path.resolve("player_cache")))
  fs.mkdirSync(path.resolve("player_cache"), { recursive: true });

function formatVariant(variant) {
  if (!variant) return "player_es6.vflset";

  let v = variant.trim();
  const lower = v.toLowerCase();

  if (lower === "house" || lower === "house_brand_player") {
    return "house_brand_player.vflset";
  }

  if (lower === "tv_tcl" || lower === "tv-tcl" || lower === "tv-player-ias-tcl") {
    return "tv-player-ias-tcl.vflset";
  }

  if (lower === "tcl") {
    return "player_ias_tcl.vflset";
  }

  if (
    v.startsWith("tv-player-") ||
    v.startsWith("player-plasma-") ||
    v.startsWith("house_brand_player")
  ) {
    if (!v.endsWith(".vflset")) v = `${v}.vflset`;
    return v;
  }

  if (!v.startsWith("player_")) {
    v = `player_${v.toLowerCase()}`;
  }

  if (!v.endsWith(".vflset")) {
    v = `${v}.vflset`;
  }

  return v;
}

function toNormalUrl(url) {
  if (!url || typeof url !== "string") return "";

  url = url.trim();

  if (!url.startsWith("http")) {
    url = `https://www.youtube.com${url.startsWith("/") ? "" : "/"}${url}`;
  }

  return url;
}

export async function getActivePlayerUrl() {
  const now = Date.now();

  if (current_player && now - last_player_found < 30 * 60 * 1000)
    return current_player;

  const variant = formatVariant(
    process.env.OVERRIDE_PLAYER_VARIANT || "player_es6.vflset",
  );
  const reg = (process.env.OVERRIDE_REGION || "en_US").trim();

  try {
    const res = await fetch("https://www.youtube.com", {
      headers: {
        "User-Agent": useragent,
      },
    });

    if (res.ok) {
      const html = await res.text();
      const match = html.match(/"PLAYER_JS_URL"\s*:\s*"([^"]+)"/);

      if (match) {
        const fullUrl = `https://www.youtube.com${match[1]}`;

        if (
          process.env.OVERRIDE_PLAYER_VARIANT ||
          process.env.OVERRIDE_REGION
        ) {
          const idMatch = fullUrl.match(/\/player\/([a-zA-Z0-9_-]+)\//);
          const id = idMatch ? idMatch[1] : "";

          if (variant.includes("-tcl")) {
            current_player = `https://www.youtube.com/s/player/${id}/${variant}/${variant.replace(".vflset", ".js")}`;
          } else {
            current_player = `https://www.youtube.com/s/player/${id}/${variant}/${reg}/base.js`;
          }
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
    const res = await fetch("https://www.youtube.com/embed/", {
      headers: { "User-Agent": useragent },
    });

    if (res.ok) {
      const html = await res.text();
      const match =
        html.match(/"(?:PLAYER_JS_URL|jsUrl)"\s*:\s*"([^"]+)"/) ||
        html.match(/src="(\/s\/player\/[^"]+\/base\.js)"/);

      if (match) {
        const fullUrl = `https://www.youtube.com${match[1]}`;

        if (
          process.env.OVERRIDE_PLAYER_VARIANT ||
          process.env.OVERRIDE_REGION
        ) {
          const idMatch = fullUrl.match(/\/player\/([a-zA-Z0-9_-]+)\//);
          const id = idMatch ? idMatch[1] : "";

          if (variant.includes("-tcl")) {
            current_player = `https://www.youtube.com/s/player/${id}/${variant}/${variant.replace(".vflset", ".js")}`;
          } else {
            current_player = `https://www.youtube.com/s/player/${id}/${variant}/${reg}/base.js`;
          }
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
      headers: { "User-Agent": useragent },
    });

    if (res.ok) {
      const text = await res.text();
      const unescaped = text.replace(/\\\//g, "/");
      const match = unescaped.match(/\/s\/player\/([a-zA-Z0-9_-]+)\//);

      if (match) {
        const id = match[1];

        if (
          current_player &&
          !process.env.OVERRIDE_PLAYER_VARIANT &&
          !process.env.OVERRIDE_REGION
        ) {
          current_player = current_player.replace(
            /\/player\/[a-zA-Z0-9_-]+\//,
            `/player/${id}/`,
          );
        } else {
          if (variant.includes("-tcl")) {
            current_player = `https://www.youtube.com/s/player/${id}/${variant}/${variant.replace(".vflset", ".js")}`;
          } else {
            current_player = `https://www.youtube.com/s/player/${id}/${variant}/${reg}/base.js`;
          }
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
  const filePath = path.join(
    path.resolve("player_cache"),
    `${crypto.createHash("sha256").update(player_url).digest("hex")}.js`,
  );

  if (fs.existsSync(filePath)) {
    return fs.readFileSync(filePath, "utf8");
  }

  const res = await fetch(player_url, {
    headers: { "User-Agent": useragent },
  });

  if (!res.ok) {
    throw new Error(
      `failed to fetch player script: ${res.status} ${res.statusText} (${player_url})`,
    );
  }

  const code = await res.text();
  fs.writeFileSync(filePath, code, "utf8");
  return code;
}

function isUrlSolverFunction(fn_node, code) {
  if (!fn_node || !fn_node.body || fn_node.body.type !== "BlockStatement")
    return false;
  if (fn_node.async || fn_node.generator) return false;

  const return_st = fn_node.body.body.find((s) => s.type === "ReturnStatement");
  if (!return_st || !return_st.argument) return false;

  const fn_code = code.slice(fn_node.range[0], fn_node.range[1]);
  if (
    !fn_code.includes("!0") ||
    fn_code.includes("this.") ||
    fn_code.includes("Promise")
  )
    return false;

  return true;
}

function findTclXorSolver(ast) {
  try {
    let pool = null;
    const iife_body = ast.body[0]?.expression?.callee?.object?.body 
                   || ast.body[0]?.expression?.callee?.body;
    if (iife_body && iife_body.body) {
      for (const stmt of iife_body.body.slice(0, 20)) {
        if (stmt.type === 'VariableDeclaration' && stmt.declarations) {
          for (const decl of stmt.declarations) {
            if (decl.init) {
              if (decl.init.type === 'CallExpression' && decl.init.callee?.property?.name === 'split') {
                const str = decl.init.callee.object?.value;
                const delim = decl.init.arguments[0]?.value;
                if (typeof str === 'string' && typeof delim === 'string') {
                  pool = str.split(delim);
                  break;
                }
              }
              if (decl.init.type === 'ArrayExpression' && decl.init.elements.length > 500) {
                pool = decl.init.elements.map(el => (el && el.type === 'Literal' ? el.value : ''));
                break;
              }
            }
          }
          if (pool) break;
        }
      }
    }
    if (!pool) return null;

    const actualSet = pool.indexOf('set');
    const actualAlr = pool.indexOf('alr');
    const actualYes = pool.indexOf('yes');
    if (actualSet === -1 || actualAlr === -1 || actualYes === -1) return null;

    const delta1 = actualSet ^ actualAlr;
    const delta2 = actualAlr ^ actualYes;

    function getXorNumber(node) {
      if (!node || node.type !== 'MemberExpression' || !node.computed) return null;
      const prop = node.property;
      if (prop && prop.type === 'BinaryExpression' && prop.operator === '^') {
        if (prop.right.type === 'Literal' && typeof prop.right.value === 'number') {
          return { num: prop.right.value, varName: prop.left.name };
        }
        if (prop.left.type === 'Literal' && typeof prop.left.value === 'number') {
          return { num: prop.left.value, varName: prop.right.name };
        }
      }
      return null;
    }

    let found = null;
    function walk(node, enclosingFn) {
      if (!node || typeof node !== 'object' || found) return;

      let currentFn = enclosingFn;
      if (node.type === 'FunctionDeclaration' && node.id) {
        currentFn = { name: node.id.name, node };
      } else if (
        node.type === 'AssignmentExpression' &&
        node.left &&
        node.left.type === 'Identifier' &&
        node.right &&
        (node.right.type === 'FunctionExpression' || node.right.type === 'ArrowFunctionExpression')
      ) {
        currentFn = { name: node.left.name, node: node.right };
      } else if (
        node.type === 'VariableDeclarator' &&
        node.id &&
        node.id.type === 'Identifier' &&
        node.init &&
        (node.init.type === 'FunctionExpression' || node.init.type === 'ArrowFunctionExpression')
      ) {
        currentFn = { name: node.id.name, node: node.init };
      }

      if (
        node.type === 'CallExpression' &&
        node.callee &&
        node.callee.type === 'MemberExpression' &&
        node.callee.computed &&
        node.arguments &&
        node.arguments.length === 2
      ) {
        const k1 = getXorNumber(node.callee.property);
        const k2 = getXorNumber(node.arguments[0]);
        const k3 = getXorNumber(node.arguments[1]);
        if (k1 && k2 && k3) {
          if ((k1.num ^ k2.num) === delta1 && (k2.num ^ k3.num) === delta2) {
            const solvedKey = k1.num ^ actualSet;
            if (currentFn && currentFn.name && (!currentFn.node?.params || currentFn.node.params.length === 5)) {
              found = {
                name: currentFn.name,
                solvedKey,
                isTcl: true,
                isXor: true
              };
              return;
            }
          }
        }
      }

      for (const k of Object.keys(node)) {
        if (found) return;
        const c = node[k];
        if (Array.isArray(c)) {
          for (let i = 0; i < c.length; i++) walk(c[i], currentFn);
        } else if (c && typeof c === 'object') {
          walk(c, currentFn);
        }
      }
    }

    walk(ast, null);
    if (found) {
      let callArgs = null;
      function findCall(node) {
        if (!node || typeof node !== 'object' || callArgs) return;
        if (
          node.type === 'CallExpression' &&
          node.callee &&
          node.callee.type === 'Identifier' &&
          node.callee.name === found.name &&
          node.arguments &&
          node.arguments.length >= 3
        ) {
          const a0 = node.arguments[0];
          const a1 = node.arguments[1];
          if (
            a0 && a0.type === 'Literal' && typeof a0.value === 'number' &&
            a1 && a1.type === 'Literal' && typeof a1.value === 'number'
          ) {
            if ((a0.value ^ a1.value) === found.solvedKey) {
              callArgs = [a0.value, a1.value];
              return;
            }
            if (!callArgs) {
              callArgs = [a0.value, a1.value];
            }
          }
        }
        for (const k of Object.keys(node)) {
          if (callArgs) return;
          const c = node[k];
          if (Array.isArray(c)) {
            for (let i = 0; i < c.length; i++) findCall(c[i]);
          } else if (c && typeof c === 'object') {
            findCall(c);
          }
        }
      }
      findCall(ast);
      found.arg1 = callArgs ? callArgs[0] : 0;
      found.arg2 = callArgs ? callArgs[1] : found.solvedKey;
    }
    return found;
  } catch {
    return null;
  }
}

function findSolverFunction(ast, code) {
  let target_fn = null;
  let tcl_solver = null;

  function next(node, enclosing_named_fn) {
    if (!node || typeof node !== "object") return;

    let current_named_fn = enclosing_named_fn;

    if (node.type === "FunctionDeclaration" && node.id) {
      current_named_fn = { node, name: node.id.name, isDecl: true };
    } else if (
      node.type === "AssignmentExpression" &&
      node.left &&
      node.left.type === "Identifier" &&
      node.right &&
      (node.right.type === "FunctionExpression" ||
        node.right.type === "ArrowFunctionExpression")
    ) {
      current_named_fn = {
        node: node.right,
        name: node.left.name,
        isDecl: false,
      };
    } else if (
      node.type === "VariableDeclarator" &&
      node.id &&
      node.id.type === "Identifier" &&
      node.init &&
      (node.init.type === "FunctionExpression" ||
        node.init.type === "ArrowFunctionExpression")
    ) {
      current_named_fn = { node: node.init, name: node.id.name, isDecl: false };
    }

    if (
      node.type === "CallExpression" &&
      node.callee &&
      node.callee.type === "MemberExpression" &&
      node.callee.property &&
      (node.callee.property.name === "set" ||
        node.callee.property.value === "set") &&
      node.arguments &&
      node.arguments.length >= 2 &&
      node.arguments[0].value === "alr" &&
      node.arguments[1].value === "yes"
    ) {
      if (
        current_named_fn &&
        isUrlSolverFunction(current_named_fn.node, code)
      ) {
        target_fn = current_named_fn;
        return;
      }
    }

    const items =
      node.expressions || (node.type === "BlockStatement" ? node.body : null);
    if (items && !tcl_solver) {
      for (let i = 0; i < items.length; i++) {
        const stmt = items[i];
        const expr =
          stmt.type === "ExpressionStatement" ? stmt.expression : stmt;
        if (
          expr &&
          expr.type === "AssignmentExpression" &&
          expr.left &&
          expr.left.property &&
          (expr.left.property.name === "lastModified" ||
            expr.left.property.value === "lastModified")
        ) {
          for (let j = i + 1; j < items.length; j++) {
            const nextStmt = items[j];
            const nextExpr =
              nextStmt.type === "ExpressionStatement"
                ? nextStmt.expression
                : nextStmt;
            if (
              nextExpr &&
              nextExpr.type === "AssignmentExpression" &&
              nextExpr.right &&
              nextExpr.right.type === "CallExpression" &&
              nextExpr.right.callee &&
              nextExpr.right.callee.type === "Identifier" &&
              nextExpr.right.arguments &&
              nextExpr.right.arguments.length >= 3 &&
              nextExpr.right.arguments[0].type === "Literal" &&
              typeof nextExpr.right.arguments[0].value === "number" &&
              nextExpr.right.arguments[1].type === "Literal" &&
              typeof nextExpr.right.arguments[1].value === "number"
            ) {
              tcl_solver = {
                name: nextExpr.right.callee.name,
                arg1: nextExpr.right.arguments[0].value,
                arg2: nextExpr.right.arguments[1].value,
                isTcl: true,
              };
              break;
            }
          }
        }
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
      } else if (child && typeof child === "object") {
        next(child, current_named_fn);
        if (target_fn) return;
      }
    }
  }

  next(ast, null);
  if (target_fn) return target_fn;
  const xor_solver = findTclXorSolver(ast);
  return xor_solver || tcl_solver;
}

function hookSolverFunction(code, ast = null, target_fn = null) {
  if (!ast) ast = parseScript(code, { ranges: true, next: true });
  if (!target_fn) target_fn = findSolverFunction(ast, code);

  if (target_fn) {
    if (target_fn.isTcl) {
      const stmt = ast.body && ast.body[0];
      const fn =
        stmt &&
        stmt.expression &&
        stmt.expression.callee &&
        stmt.expression.callee.object;
      if (fn && fn.body && fn.body.range) {
        const insertPos = fn.body.range[1] - 1;
        return (
          code.slice(0, insertPos) +
          `globalThis.__solve_url = function(url, sp, s) { return ${target_fn.name}(${target_fn.arg1}, ${target_fn.arg2}, url, sp || "sig", s); };\n` +
          code.slice(insertPos)
        );
      }
      return code.replace(
        /\}\)\.call\(this\);?\s*$/,
        `globalThis.__solve_url = function(url, sp, s) { return ${target_fn.name}(${target_fn.arg1}, ${target_fn.arg2}, url, sp || "sig", s); };\n}).call(this);`,
      );
    }

    const fn_node = target_fn.node;
    const [start, end] = fn_node.range;
    const snippet = code.slice(start, end);
    const name = target_fn.name;

    if (target_fn.isDecl) {
      return (
        code.slice(0, start) +
        `var ${name}=(globalThis.__solve_url=${snippet})` +
        code.slice(end)
      );
    } else {
      return (
        code.slice(0, start) +
        `(globalThis.__solve_url=${snippet})` +
        code.slice(end)
      );
    }
  }

  return code;
}

function sliceSolver(code, ast = null, target_fn = null) {
  if (!ast) ast = parseScript(code, { ranges: true, next: true });
  if (!target_fn) target_fn = findSolverFunction(ast, code);

  if (!target_fn || target_fn.isTcl || code.includes("tv-player-")) return null;

  let iife_body = null;
  let iife_param = "g";
  for (const stmt of ast.body) {
    if (
      stmt.type === "ExpressionStatement" &&
      stmt.expression.type === "CallExpression"
    ) {
      const callee = stmt.expression.callee;
      if (
        callee.type === "FunctionExpression" &&
        callee.body.type === "BlockStatement"
      ) {
        iife_body = callee.body;
        if (
          callee.params &&
          callee.params[0] &&
          callee.params[0].type === "Identifier"
        ) {
          iife_param = callee.params[0].name;
        }
        break;
      }
    }
  }

  if (!iife_body) return null;

  let target_stmt_index = -1;
  const target_start = target_fn.node.range[0];
  const target_end = target_fn.node.range[1];

  for (let i = 0; i < iife_body.body.length; i++) {
    const s = iife_body.body[i];
    if (s.range[0] <= target_start && s.range[1] >= target_end) {
      target_stmt_index = i;
      break;
    }
  }

  if (target_stmt_index === -1) return null;

  function getNodeName(node) {
    if (!node) return null;
    if (node.type === "Identifier") return node.name;
    if (node.type === "MemberExpression") {
      const obj = getNodeName(node.object);
      const prop =
        node.property.type === "Identifier" && !node.computed
          ? node.property.name
          : node.property.type === "Literal"
            ? node.property.value
            : null;
      if (obj && prop) return obj + "." + prop;
    }
    return null;
  }

  function getAssignmentRoot(node) {
    if (!node) return null;
    if (node.type === "Identifier") return node.name;
    if (node.type === "MemberExpression") {
      let curr = node;
      const parts = [];
      while (curr && curr.type === "MemberExpression") {
        parts.unshift(curr);
        curr = curr.object;
      }
      if (curr && curr.type === "Identifier") {
        if (curr.name === iife_param && parts.length > 0) {
          const first = parts[0];
          const p = first.property;
          const name =
            p.type === "Identifier" && !first.computed
              ? p.name
              : p.type === "Literal"
                ? p.value
                : null;
          if (name) return iife_param + "." + name;
        }
        return curr.name;
      }
    }
    return null;
  }

  const protoAliases = new Set();
  const classToProtoStmts = new Map();
  let currentProtoAlias = null;
  let currentProtoClass = null;

  for (let i = 0; i < iife_body.body.length; i++) {
    const stmt = iife_body.body[i];
    if (
      stmt.type === "ExpressionStatement" &&
      stmt.expression.type === "AssignmentExpression"
    ) {
      const assign = stmt.expression;
      if (
        assign.right.type === "MemberExpression" &&
        (assign.right.property.name === "prototype" ||
          assign.right.property.value === "prototype")
      ) {
        const lhsName = getNodeName(assign.left);
        const rhsClass = getNodeName(assign.right.object);
        if (lhsName && rhsClass) {
          protoAliases.add(lhsName);
          currentProtoAlias = lhsName;
          currentProtoClass = rhsClass;
          if (!classToProtoStmts.has(currentProtoClass))
            classToProtoStmts.set(currentProtoClass, []);
          classToProtoStmts.get(currentProtoClass).push(i);
        }
      } else if (currentProtoAlias) {
        const root = getNodeName(assign.left);
        if (root && root.startsWith(currentProtoAlias + ".")) {
          if (!classToProtoStmts.has(currentProtoClass))
            classToProtoStmts.set(currentProtoClass, []);
          classToProtoStmts.get(currentProtoClass).push(i);
        } else if (root === currentProtoAlias) {
          currentProtoAlias = null;
          currentProtoClass = null;
        }
      }
    }
  }

  const stmt_defs = [];
  for (let i = 0; i < iife_body.body.length; i++) {
    const stmt = iife_body.body[i];
    const defs = new Set();

    function findDefs(n) {
      if (!n || typeof n !== "object") return;
      if (n.type === "VariableDeclarator") {
        if (n.id.type === "Identifier") defs.add(n.id.name);
      } else if (n.type === "FunctionDeclaration") {
        if (n.id) defs.add(n.id.name);
      } else if (n.type === "AssignmentExpression") {
        const root = getAssignmentRoot(n.left);
        if (root) defs.add(root);
      }
      if (
        n !== stmt &&
        (n.type === "FunctionExpression" ||
          n.type === "FunctionDeclaration" ||
          n.type === "ArrowFunctionExpression")
      ) {
        return;
      }
      for (const k of Object.keys(n)) {
        const c = n[k];
        if (Array.isArray(c)) c.forEach(findDefs);
        else if (c && typeof c === "object") findDefs(c);
      }
    }

    findDefs(stmt);
    stmt_defs.push({ index: i, stmt, defs });
  }

  const id_to_stmts = new Map();
  for (const item of stmt_defs) {
    for (const def of item.defs) {
      if (!id_to_stmts.has(def)) id_to_stmts.set(def, []);
      id_to_stmts.get(def).push(item.index);
    }
  }

  function getReferences(rootNode) {
    let hasUncertain = false;
    const refs = new Set();
    const localScopes = [];

    function enterScope(params) {
      const s = new Set();
      if (params) {
        for (const p of params) {
          if (p.type === "Identifier") s.add(p.name);
          else if (
            p.type === "AssignmentPattern" &&
            p.left.type === "Identifier"
          )
            s.add(p.left.name);
        }
      }
      localScopes.push(s);
    }

    function exitScope() {
      localScopes.pop();
    }

    function isLocal(id) {
      for (let i = localScopes.length - 1; i >= 0; i--) {
        if (localScopes[i].has(id)) return true;
      }
      return false;
    }

    function walk(n) {
      if (!n || typeof n !== "object" || hasUncertain) return;

      if (
        n.type === "CallExpression" &&
        n.callee &&
        n.callee.type === "Identifier" &&
        n.callee.name === "eval"
      ) {
        hasUncertain = true;
        return;
      }
      if (
        n.type === "NewExpression" &&
        n.callee &&
        n.callee.type === "Identifier" &&
        n.callee.name === "Function"
      ) {
        hasUncertain = true;
        return;
      }

      if (
        n.type === "FunctionDeclaration" ||
        n.type === "FunctionExpression" ||
        n.type === "ArrowFunctionExpression"
      ) {
        enterScope(n.params);
        if (n.id && n.id.type === "Identifier")
          localScopes[localScopes.length - 1].add(n.id.name);
        walk(n.body);
        exitScope();
        return;
      }
      if (n.type === "VariableDeclarator") {
        if (n.id.type === "Identifier" && localScopes.length > 0) {
          localScopes[localScopes.length - 1].add(n.id.name);
        }
        if (n.init) walk(n.init);
        return;
      }
      if (n.type === "Identifier") {
        if (!isLocal(n.name)) refs.add(n.name);
        return;
      }
      if (n.type === "MemberExpression") {
        if (
          n.object.type === "Identifier" &&
          n.object.name === iife_param &&
          n.property.type === "Identifier" &&
          !n.computed
        ) {
          refs.add(iife_param + "." + n.property.name);
        }
        walk(n.object);
        if (n.computed) walk(n.property);
        return;
      }
      for (const k of Object.keys(n)) {
        const c = n[k];
        if (Array.isArray(c)) c.forEach(walk);
        else if (c && typeof c === "object") walk(c);
      }
    }

    walk(rootNode);
    return { refs, hasUncertain };
  }

  const neededStmtIndices = new Set([target_stmt_index]);
  const visitedIdentifiers = new Set();
  const worklist = [];

  function addIdentifier(id) {
    if (protoAliases.has(id)) return;
    if (!visitedIdentifiers.has(id)) {
      visitedIdentifiers.add(id);
      worklist.push(id);
    }
  }

  function addStmt(sIdx) {
    if (neededStmtIndices.has(sIdx)) return true;
    neededStmtIndices.add(sIdx);
    const analyzed = getReferences(iife_body.body[sIdx]);
    if (analyzed.hasUncertain) return false;
    for (const ref of analyzed.refs) {
      addIdentifier(ref);
    }
    return true;
  }

  const targetAnalyzed = getReferences(iife_body.body[target_stmt_index]);
  if (targetAnalyzed.hasUncertain) return null;
  for (const ref of targetAnalyzed.refs) {
    addIdentifier(ref);
  }

  const processedClasses = new Set();

  while (worklist.length > 0) {
    const id = worklist.shift();

    if (classToProtoStmts.has(id) && !processedClasses.has(id)) {
      processedClasses.add(id);
      const protoStmts = classToProtoStmts.get(id);
      for (const sIdx of protoStmts) {
        if (!addStmt(sIdx)) return null;
      }
    }

    const stmts = id_to_stmts.get(id) || [];
    for (const sIdx of stmts) {
      if (!addStmt(sIdx)) return null;
    }
  }

  const sortedIndices = [...neededStmtIndices].sort((a, b) => a - b);

  const pieces = [];
  pieces.push("var _yt_player = {};\n");
  pieces.push(`(function(${iife_param}) {\n`);
  pieces.push("  var window = this;\n");

  for (const idx of sortedIndices) {
    const stmt = iife_body.body[idx];
    let stmtCode = code.slice(stmt.range[0], stmt.range[1]);
    if (idx === target_stmt_index) {
      const fnNode = target_fn.node;
      const [start, end] = fnNode.range;
      const relStart = start - stmt.range[0];
      const relEnd = end - stmt.range[0];
      const snippet = stmtCode.slice(relStart, relEnd);
      if (target_fn.isDecl) {
        stmtCode =
          stmtCode.slice(0, relStart) +
          `var ${target_fn.name}=(globalThis.__solve_url=${snippet})` +
          stmtCode.slice(relEnd);
      } else {
        stmtCode =
          stmtCode.slice(0, relStart) +
          `(globalThis.__solve_url=${snippet})` +
          stmtCode.slice(relEnd);
      }
    }
    pieces.push(stmtCode + "\n");
  }

  pieces.push(`})(_yt_player);\n`);
  return pieces.join("");
}

const MAX_THREADS = Math.max(
  1,
  process.env.MAX_THREADS
    ? parseInt(process.env.MAX_THREADS, 10)
    : Math.min(os.availableParallelism?.() || 2, 4),
);

const player_data_cache = new Map();
const workers = [];
const pending_tasks = new Map();
let task_seq = 0;
let round_robin = 0;
const loaded_in_workers = new Map();

let is_terminating = false;

function spawnWorker(index) {
  const w = new Worker(new URL("./worker.js", import.meta.url));
  w.on("message", (msg) => {
    const task = pending_tasks.get(msg.id);
    if (task) {
      pending_tasks.delete(msg.id);
      if (msg.ok) task.resolve(msg.result);
      else task.reject(new Error(msg.error));
    }
  });
  w.on("error", (err) => {
    console.error(`Worker ${index} error:`, err);
  });
  w.on("exit", (code) => {
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
  const player_url = target_url
    ? toNormalUrl(target_url)
    : await getActivePlayerUrl();

  if (target_url) {
    current_player = player_url;
    last_player_found = Date.now();
  }

  const file_path = path.join(
    path.resolve("player_cache"),
    `${crypto.createHash("sha256").update(player_url).digest("hex")}.js`,
  );

  if (player_data_cache.has(player_url)) {
    const cached = player_data_cache.get(player_url);
    if (!fs.existsSync(file_path) && cached.code) {
      try {
        fs.writeFileSync(file_path, cached.code, "utf8");
      } catch {}
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
    throw new Error(
      `Signature timestamp (sts) not found in player script: ${player_url}`,
    );
  }
  const sts = sts_match[1];
  const ast = parseScript(code, { ranges: true, next: true });
  const target_fn = findSolverFunction(ast, code);
  const full_code = hookSolverFunction(code, ast, target_fn);
  const is_tv = player_url.includes("tv-player-") || Boolean(target_fn?.isTcl);
  let sliced_code = null;
  if (!is_tv) {
    try {
      sliced_code = sliceSolver(code, ast, target_fn);
    } catch {}
  }
  const hooked_code = sliced_code || full_code;

  const data = { player_url, sts, hooked_code, fallback_code: full_code, code };
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
      w.postMessage({
        id,
        type: "LOAD_PLAYER",
        player_url: url,
        hooked_code: player_data.hooked_code,
        fallback_code: player_data.fallback_code,
        sts: player_data.sts,
      });
    });
    loaded_set.add(url);
  }

  return new Promise((resolve, reject) => {
    const id = ++task_seq;
    pending_tasks.set(id, { resolve, reject });
    w.postMessage({ id, type, player_url: url, payload });
  });
}

export async function resolveUrl({
  stream_url,
  encrypted_signature,
  signature_key,
  player_url,
  n_param,
}) {
  if (!stream_url) {
    throw new Error("stream_url is required");
  }

  return dispatchToWorker("resolve_url", player_url, {
    stream_url,
    encrypted_signature,
    signature_key,
    n_param,
  });
}

export async function decryptSignature({
  encrypted_signature,
  n_param,
  player_url,
}) {
  if (!encrypted_signature && !n_param) {
    throw new Error("either encrypted_signature or n_param must be provided");
  }

  return dispatchToWorker("decrypt_signature", player_url, {
    encrypted_signature,
    n_param,
  });
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
          type: "LOAD_PLAYER",
          player_url: player_data.player_url,
          hooked_code: player_data.hooked_code,
          fallback_code: player_data.fallback_code,
          sts: player_data.sts,
        });
        loaded_set.add(player_data.player_url);
      }
    }
  }

  return {
    sts: player_data.sts,
  };
}

export async function terminatePool() {
  is_terminating = true;
  await Promise.all(workers.map((w) => w.terminate()));
  workers.length = 0;
}

export {
  sliceSolver,
  findSolverFunction,
  hookSolverFunction,
  isUrlSolverFunction,
};
