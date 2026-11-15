import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Server } from 'socket.io';
import { buildApp } from './app.js';
import { openDb } from './db.js';

if (fs.existsSync('.env')) process.loadEnvFile('.env');

const dataDir = path.resolve('.data');

function resolveSecret(): string {
  if (process.env.APP_SECRET) {
    // A chave assina os logins e cifra as senhas das integrações: curta ou de exemplo = qualquer um forja acesso.
    if (process.env.NODE_ENV === 'production' && (process.env.APP_SECRET.length < 32 || /^(troque|changeme|secret|exemplo|example)/i.test(process.env.APP_SECRET))) {
      throw new Error('APP_SECRET fraca: use 32 caracteres ou mais (openssl rand -hex 32)');
    }
    return process.env.APP_SECRET;
  }
  if (process.env.NODE_ENV === 'production') throw new Error('Defina APP_SECRET em produção');
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'dev-secret');
  if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(32).toString('hex'));
  return fs.readFileSync(file, 'utf8');
}

const port = Number(process.env.PORT ?? 3333);
const db = await openDb(process.env.DATABASE_URL, process.env.DATABASE_URL ? undefined : path.join(dataDir, 'pg'));
if (process.env.NODE_ENV === 'production' && process.env.PUBLIC_URL && !/^https:\/\/|^http:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(process.env.PUBLIC_URL)) {
  console.warn(JSON.stringify({ security: 'aviso', detail: 'PUBLIC_URL sem HTTPS em produção: use HTTPS (Caddy/Tailscale) antes de expor na internet' }));
}
const { app, core } = await buildApp({
  db, secret: resolveSecret(),
  publicUrl: (process.env.PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/$/, ''),
  internalUrl: process.env.INTERNAL_URL?.replace(/\/$/, ''),
  distDir: path.resolve('dist'),
});

await app.listen({ port, host: process.env.HOST ?? '127.0.0.1' });

const publicUrl = (process.env.PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/$/, '');
const io = new Server(app.server, {
  path: '/socket.io',
  // Sem CORS aberto: só o próprio site (ou clientes sem Origin) conecta.
  allowRequest: (req, cb) => {
    const origin = req.headers.origin;
    let same = !origin;
    try { same ||= new URL(origin!).host === req.headers.host || origin === publicUrl; } catch { /* Origin inválido: recusa */ }
    cb(null, same);
  },
});
io.use(async (socket, next) => {
  try {
    const user = app.jwt.verify<{ uid: string; aid: string }>(socket.handshake.auth.token);
    // O token vale 7 dias, mas quem saiu da empresa não pode mais receber as conversas dela.
    const [m] = await db.query('SELECT 1 FROM memberships WHERE user_id = $1 AND account_id = $2', [user.uid, user.aid]);
    if (!m) return next(new Error('unauthorized'));
    socket.join(`account:${user.aid}`);
    next();
  } catch { next(new Error('unauthorized')); }
});
core.emit = (accountId, event, data) => void io.to(`account:${accountId}`).emit(event, data);
core.startWorker();

console.log(`MAGTRON em http://localhost:${port}`);
