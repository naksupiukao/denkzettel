// Denkzettel – Schnittstelle für die App
//   GET  /api/vapid      öffentlicher Schlüssel fürs Push-Abo
//   POST /api/sync       Push-Abo + anstehende Erinnerungen speichern
//   POST /api/test-push  sofort eine Test-Nachricht schicken
import { getStore } from '@netlify/blobs';
import webpush from 'web-push';

const MAX_REMINDERS = 500;
const store = () => getStore({ name: 'denkzettel', consistency: 'strong' });

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

// VAPID-Schlüssel werden beim ersten Aufruf automatisch erzeugt und gespeichert.
async function getVapid() {
  const s = store();
  let v = await s.get('config/vapid', { type: 'json' });
  if (!v || !v.publicKey || !v.privateKey) {
    const keys = webpush.generateVAPIDKeys();
    await s.setJSON('config/vapid', keys);
    v = (await s.get('config/vapid', { type: 'json' })) || keys;
  }
  return v;
}

async function rememberOrigin(req) {
  try {
    const origin = new URL(req.url).origin;
    if (!origin.startsWith('https://')) return;
    const s = store();
    if ((await s.get('config/origin', { type: 'text' })) !== origin) await s.set('config/origin', origin);
  } catch (_) { /* egal */ }
}

async function configuredWebPush() {
  const v = await getVapid();
  const origin = process.env.URL || (await store().get('config/origin', { type: 'text' }));
  const subject = origin && origin.startsWith('https://') ? origin : 'mailto:denkzettel@example.com';
  webpush.setVapidDetails(subject, v.publicKey, v.privateKey);
  return webpush;
}

async function sha256(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Buffer.from(buf).toString('hex');
}

// Nur echte Push-Dienste der Browser-Hersteller zulassen.
const PUSH_HOSTS = [/\.push\.apple\.com$/, /^fcm\.googleapis\.com$/, /\.push\.services\.mozilla\.com$/, /\.notify\.windows\.com$/];

function cleanSubscription(sub) {
  if (!sub || typeof sub !== 'object' || typeof sub.endpoint !== 'string') return null;
  let url;
  try { url = new URL(sub.endpoint); } catch (_) { return null; }
  if (url.protocol !== 'https:' || !PUSH_HOSTS.some((re) => re.test(url.hostname))) return null;
  const keys = sub.keys || {};
  if (typeof keys.p256dh !== 'string' || typeof keys.auth !== 'string') return null;
  if (keys.p256dh.length > 200 || keys.auth.length > 100) return null;
  return { endpoint: sub.endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } };
}

async function loadAuthorizedDevice(deviceId, token) {
  const valid = typeof deviceId === 'string' && /^[A-Za-z0-9_]{6,64}$/.test(deviceId) &&
    typeof token === 'string' && /^[a-f0-9]{32,128}$/.test(token);
  if (!valid) return { error: json({ error: 'ungültige Anmeldung' }, 400) };
  const key = 'devices/' + deviceId;
  const dev = await store().get(key, { type: 'json' });
  const hash = await sha256(token);
  if (dev && dev.tokenHash !== hash) return { error: json({ error: 'nicht erlaubt' }, 403) };
  return { key, dev, hash };
}

async function readBody(req) {
  try { return (await req.json()) || {}; } catch (_) { return null; }
}

async function handleVapid(req) {
  await rememberOrigin(req);
  const { publicKey } = await getVapid();
  return json({ publicKey });
}

async function handleSync(req) {
  const body = await readBody(req);
  if (!body) return json({ error: 'ungültige Daten' }, 400);
  const auth = await loadAuthorizedDevice(body.deviceId, body.token);
  if (auth.error) return auth.error;
  const sub = cleanSubscription(body.subscription);
  if (!sub) return json({ error: 'ungültiges Push-Abo' }, 400);

  const clean = (Array.isArray(body.reminders) ? body.reminders : [])
    .slice(0, MAX_REMINDERS)
    .map((r) => ({
      id: String(r && r.id || '').slice(0, 64),
      at: Number(r && r.at),
      title: String(r && r.title || '').slice(0, 200),
      body: String(r && r.body || '').slice(0, 200),
    }))
    .filter((r) => r.id && Number.isFinite(r.at));

  const prev = auth.dev || {};
  await store().setJSON(auth.key, {
    tokenHash: auth.hash,
    subscription: sub,
    reminders: clean,
    sent: Array.isArray(prev.sent) ? prev.sent.slice(-MAX_REMINDERS) : [],
    created: prev.created || Date.now(),
    updated: Date.now(),
  });
  await rememberOrigin(req);
  return json({ ok: true, count: clean.length });
}

async function handleTestPush(req) {
  const body = await readBody(req);
  if (!body) return json({ error: 'ungültige Daten' }, 400);
  const auth = await loadAuthorizedDevice(body.deviceId, body.token);
  if (auth.error) return auth.error;
  if (!auth.dev || !auth.dev.subscription) return json({ error: 'Gerät nicht registriert' }, 404);
  const wp = await configuredWebPush();
  try {
    await wp.sendNotification(auth.dev.subscription, JSON.stringify({
      title: '🔔 Denkzettel',
      body: 'Push funktioniert. So kommen deine Erinnerungen an.',
      tag: 'test',
    }), { TTL: 600, urgency: 'high' });
    return json({ ok: true });
  } catch (e) {
    return json({ error: 'Push fehlgeschlagen', status: e.statusCode || null }, 502);
  }
}

export default async (req) => {
  const path = new URL(req.url).pathname.replace(/\/+$/, '');
  if (path === '/api/vapid') return handleVapid(req);
  if (req.method !== 'POST') return json({ error: 'nur POST' }, 405);
  if (path === '/api/sync') return handleSync(req);
  if (path === '/api/test-push') return handleTestPush(req);
  return json({ error: 'unbekannt' }, 404);
};

export const config = { path: ['/api/vapid', '/api/sync', '/api/test-push'] };
