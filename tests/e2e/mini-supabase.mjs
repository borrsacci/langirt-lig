// Yerel uçtan uca test için Supabase'in uygulamanın kullandığı kısmını taklit eden
// küçük bir sunucu: Auth (kullanıcı adı/şifre, JWT), REST (tablo okuma + RPC) ve
// Edge Function yönlendirmesi. Sorgular gerçek Postgres'te, gerçek RLS ve rollerle çalışır.
// Sadece test içindir; üretimde gerçek Supabase kullanılır.
import { createHmac, randomUUID, scryptSync } from 'node:crypto';
import http from 'node:http';
import pg from 'pg';

const PORT = Number(process.env.PORT ?? 54321);
const SECRET = 'local-test-secret';
const FN_PORTS = JSON.parse(process.env.FN_PORTS ?? '{}'); // { "create-match": 54401 }
const pool = new pg.Pool({ host: process.env.PGHOST ?? '/tmp', port: Number(process.env.PGPORT ?? 55432), user: 'postgres', database: process.env.PGDATABASE ?? 'e2e' });

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
export function sign(payload) {
  const h = b64({ alg: 'HS256', typ: 'JWT' });
  const p = b64(payload);
  return `${h}.${p}.${createHmac('sha256', SECRET).update(`${h}.${p}`).digest('base64url')}`;
}
function verify(tok) {
  const [h, p, s] = (tok ?? '').split('.');
  if (!s || createHmac('sha256', SECRET).update(`${h}.${p}`).digest('base64url') !== s) return null;
  const c = JSON.parse(Buffer.from(p, 'base64url').toString());
  if (c.exp && c.exp < Date.now() / 1000) return null;
  return c;
}
export const ANON = sign({ role: 'anon' });
export const SERVICE = sign({ role: 'service_role' });

const passwords = new Map(); // email → hash
const refresh = new Map(); // token → user id
const hash = (pw) => scryptSync(pw, 'salt', 32).toString('hex');

async function userById(id) {
  const r = await pool.query('select id, email, raw_user_meta_data, created_at from auth.users where id=$1', [id]);
  const u = r.rows[0];
  return u && { id: u.id, aud: 'authenticated', role: 'authenticated', email: u.email, user_metadata: u.raw_user_meta_data, app_metadata: {}, created_at: u.created_at };
}
async function session(id) {
  const user = await userById(id);
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const rt = randomUUID();
  refresh.set(rt, id);
  return { access_token: sign({ sub: id, role: 'authenticated', aud: 'authenticated', exp }), token_type: 'bearer', expires_in: 3600, expires_at: exp, refresh_token: rt, user };
}

// ---------- REST ----------
let fks = null; // [{table, column, ref}]
async function loadFks() {
  fks ??= (await pool.query(`
    select tc.table_name as t, kcu.column_name as c, ccu.table_name as ref
    from information_schema.table_constraints tc
    join information_schema.key_column_usage kcu on kcu.constraint_name = tc.constraint_name
    join information_schema.constraint_column_usage ccu on ccu.constraint_name = tc.constraint_name
    where tc.constraint_type = 'FOREIGN KEY' and tc.table_schema = 'public'`)).rows;
  return fks;
}
function splitTop(s) {
  const out = []; let depth = 0, cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
const ident = (x) => { if (!/^[a-z_][a-z0-9_]*$/.test(x)) throw new Error('bad ident ' + x); return `"${x}"`; };
let aliasN = 0;
function projection(table, alias, select) {
  const cols = [];
  for (const item of splitTop(select)) {
    if (item === '*') { cols.push(`${alias}.*`); continue; }
    const m = item.match(/^(?:([a-z_]+):)?([a-z_]+)\((.*)\)$/);
    if (!m) { cols.push(`${alias}.${ident(item)}`); continue; }
    const [, as, rel, inner] = m;
    const a = `r${++aliasN}`;
    const toOne = fks.find((f) => f.t === table && f.ref === rel);
    const toMany = fks.find((f) => f.t === rel && f.ref === table);
    if (toOne) cols.push(`(select to_json(x) from (select ${projection(rel, a, inner)} from public.${ident(rel)} ${a} where ${a}.id = ${alias}.${ident(toOne.c)}) x) as ${ident(as ?? rel)}`);
    else if (toMany) cols.push(`(select coalesce(json_agg(x), '[]') from (select ${projection(rel, a, inner)} from public.${ident(rel)} ${a} where ${a}.${ident(toMany.c)} = ${alias}.id) x) as ${ident(as ?? rel)}`);
    else throw new Error('no relation ' + table + '→' + rel);
  }
  return cols.join(', ');
}

async function withRole(claims, fn) {
  const c = await pool.connect();
  try {
    await c.query('begin');
    const role = claims?.role ?? 'anon';
    await c.query(`set local role ${role === 'service_role' ? 'service_role' : role === 'authenticated' ? 'authenticated' : 'anon'}`);
    await c.query(`select set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claim.role', $2, true)`, [claims?.sub ?? '', role]);
    const r = await fn(c);
    await c.query('commit');
    return r;
  } catch (e) {
    await c.query('rollback').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

async function tableGet(claims, table, q, wantObject) {
  await loadFks();
  const where = [], params = [];
  let order = '', limit = '';
  for (const [k, v] of q) {
    if (k === 'select') continue;
    if (k === 'order') {
      order = 'order by ' + v.split(',').map((o) => { const [c, d] = o.split('.'); return `${ident(c)} ${d === 'desc' ? 'desc' : 'asc'}`; }).join(', ');
    } else if (k === 'limit') limit = `limit ${Number(v)}`;
    else if (v.startsWith('eq.')) { params.push(v.slice(3)); where.push(`t.${ident(k)}::text = $${params.length}`); }
    else if (v.startsWith('in.(')) {
      const vals = v.slice(4, -1).split(',').map((x) => x.replace(/^"|"$/g, ''));
      params.push(vals); where.push(`t.${ident(k)}::text = any($${params.length})`);
    } else throw new Error('unsupported filter ' + k + '=' + v);
  }
  const sql = `select coalesce(json_agg(x), '[]') as j from (select ${projection(table, 't', q.get('select') ?? '*')} from public.${ident(table)} t ${where.length ? 'where ' + where.join(' and ') : ''} ${order} ${limit}) x`;
  const rows = await withRole(claims, (c) => c.query(sql, params).then((r) => r.rows[0].j));
  if (!wantObject) return [200, rows];
  if (rows.length === 1) return [200, rows[0]];
  return [406, { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned', details: `The result contains ${rows.length} rows`, hint: null }];
}

async function rpcCall(claims, fn, args) {
  const meta = (await pool.query(
    `select p.proargnames as names, p.pronargs as n, p.proretset as set, t.typtype as tt,
            array(select format_type(x, null) from unnest(p.proargtypes) x) as types
     from pg_proc p join pg_type t on t.oid = p.prorettype join pg_namespace s on s.oid = p.pronamespace
     where s.nspname = 'public' and p.proname = $1`, [fn])).rows[0];
  if (!meta) return [404, { message: `Could not find the function public.${fn}` }];
  const names = (meta.names ?? []).slice(0, meta.n);
  const parts = [], params = [];
  names.forEach((nm, i) => {
    if (!(nm in args)) return;
    const v = args[nm];
    params.push(v !== null && typeof v === 'object' ? JSON.stringify(v) : v);
    parts.push(`${ident(nm)} := $${params.length}::${meta.types[i]}`);
  });
  const call = `public.${ident(fn)}(${parts.join(', ')})`;
  const sql = meta.set ? `select coalesce(json_agg(x), '[]') as j from ${call} x` : `select to_json(${call}) as j`;
  return [200, await withRole(claims, (c) => c.query(sql, params).then((r) => r.rows[0].j))];
}

// ---------- HTTP ----------
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
  'Access-Control-Expose-Headers': '*',
};
const send = (res, status, body) => {
  res.writeHead(status, { ...cors, 'Content-Type': 'application/json' });
  res.end(body === undefined ? '' : JSON.stringify(body));
};
const readBody = (req) => new Promise((r) => { let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => r(d)); });

http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204);
  const url = new URL(req.url, 'http://x');
  const tok = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '') || req.headers.apikey;
  const claims = verify(tok);
  try {
    const raw = await readBody(req);
    const body = raw ? JSON.parse(raw) : {};
    const p = url.pathname;
    // --- auth ---
    if (p === '/auth/v1/signup') {
      const exists = await pool.query('select 1 from auth.users where email=$1', [body.email]);
      if (exists.rowCount) return send(res, 422, { code: 422, error_code: 'user_already_exists', msg: 'User already registered' });
      if ((body.password ?? '').length < 6) return send(res, 422, { code: 422, error_code: 'weak_password', msg: 'Password should be at least 6 characters.' });
      const id = randomUUID();
      try {
        await pool.query('insert into auth.users (id, email, raw_user_meta_data) values ($1,$2,$3)', [id, body.email, body.data ?? {}]);
      } catch (e) {
        return send(res, 500, { code: 500, error_code: 'unexpected_failure', msg: 'Database error saving new user' });
      }
      passwords.set(body.email, hash(body.password));
      return send(res, 200, await session(id));
    }
    if (p === '/auth/v1/token') {
      const gt = url.searchParams.get('grant_type');
      if (gt === 'password') {
        const u = await pool.query('select id from auth.users where email=$1', [body.email]);
        if (!u.rowCount || passwords.get(body.email) !== hash(body.password ?? ''))
          return send(res, 400, { code: 400, error_code: 'invalid_credentials', msg: 'Invalid login credentials' });
        return send(res, 200, await session(u.rows[0].id));
      }
      if (gt === 'refresh_token') {
        const id = refresh.get(body.refresh_token);
        if (!id) return send(res, 400, { code: 400, error_code: 'refresh_token_not_found', msg: 'Invalid Refresh Token' });
        return send(res, 200, await session(id));
      }
    }
    if (p === '/auth/v1/user') {
      if (!claims?.sub) return send(res, 401, { code: 401, msg: 'invalid JWT' });
      return send(res, 200, await userById(claims.sub));
    }
    if (p === '/auth/v1/logout') return send(res, 204);
    const adm = p.match(/^\/auth\/v1\/admin\/users\/([0-9a-f-]+)$/);
    if (adm && req.method === 'PUT') {
      if (claims?.role !== 'service_role') return send(res, 403, { msg: 'not admin' });
      const u = await pool.query('select email from auth.users where id=$1', [adm[1]]);
      if (body.password) passwords.set(u.rows[0].email, hash(body.password));
      return send(res, 200, await userById(adm[1]));
    }
    // --- rest ---
    const rp = p.match(/^\/rest\/v1\/rpc\/([a-z_]+)$/);
    if (rp) {
      const [st, out] = await rpcCall(claims, rp[1], body);
      return send(res, st, out);
    }
    const tp = p.match(/^\/rest\/v1\/([a-z_]+)$/);
    if (tp && req.method === 'GET') {
      const [st, out] = await tableGet(claims, tp[1], url.searchParams, (req.headers.accept ?? '').includes('vnd.pgrst.object'));
      return send(res, st, out);
    }
    // --- functions ---
    const fp = p.match(/^\/functions\/v1\/([a-z-]+)$/);
    if (fp && FN_PORTS[fp[1]]) {
      const r = await fetch(`http://127.0.0.1:${FN_PORTS[fp[1]]}/`, { method: req.method, headers: { authorization: req.headers.authorization ?? '', 'content-type': 'application/json' }, body: raw || undefined });
      res.writeHead(r.status, { ...cors, 'Content-Type': 'application/json' });
      return res.end(await r.text());
    }
    return send(res, 404, { message: 'not found ' + p });
  } catch (e) {
    const perm = /permission denied/.test(e.message);
    return send(res, perm ? 403 : 400, { code: e.code ?? 'XX000', message: e.message, details: null, hint: null });
  }
}).listen(PORT, () => console.log(`mini-supabase :${PORT}\nANON=${ANON}\nSERVICE=${SERVICE}`));
