// Denkzettel – läuft jede Minute und verschickt alle fälligen Erinnerungen per Push.
import { getStore } from '@netlify/blobs';
import webpush from 'web-push';

const LATE_LIMIT = 6 * 3600 * 1000;      // älter als 6 h: nicht mehr nachschicken
const KEEP_LIMIT = 2 * 86400 * 1000;     // erledigte Erinnerungen nach 2 Tagen aufräumen

const store = () => getStore({ name: 'denkzettel', consistency: 'strong' });

async function configuredWebPush(s) {
  let v = await s.get('config/vapid', { type: 'json' });
  if (!v || !v.publicKey || !v.privateKey) {
    v = webpush.generateVAPIDKeys();
    await s.setJSON('config/vapid', v);
  }
  const origin = process.env.URL || (await s.get('config/origin', { type: 'text' }));
  const subject = origin && origin.startsWith('https://') ? origin : 'mailto:denkzettel@example.com';
  webpush.setVapidDetails(subject, v.publicKey, v.privateKey);
  return webpush;
}

export async function sendDue(s, wp, now = Date.now()) {
  const { blobs } = await s.list({ prefix: 'devices/' });
  let sent = 0, removed = 0;

  for (const { key } of blobs) {
    const dev = await s.get(key, { type: 'json' });
    if (!dev || !dev.subscription || !Array.isArray(dev.reminders)) continue;

    const already = new Set(dev.sent || []);
    const due = dev.reminders
      .filter((r) => r.at <= now + 20000 && r.at > now - LATE_LIMIT && !already.has(r.id))
      .sort((a, b) => a.at - b.at);
    if (!due.length) continue;

    const newlySent = [];
    let gone = false;
    for (const r of due) {
      try {
        await wp.sendNotification(dev.subscription, JSON.stringify({
          title: '🔔 ' + r.title,
          body: r.body,
          tag: r.id,
        }), { TTL: 6 * 3600, urgency: 'high' });
        newlySent.push(r.id);
        sent++;
      } catch (e) {
        if (e.statusCode === 404 || e.statusCode === 410) { gone = true; break; }
        console.error('Push fehlgeschlagen', key, e.statusCode, e.body);
      }
    }

    if (gone) { // Abo existiert nicht mehr (App gelöscht o. Ä.)
      await s.delete(key);
      removed++;
      continue;
    }

    // Frisch lesen und nur "verschickt" ergänzen, damit eine gleichzeitige
    // Synchronisierung vom Handy nicht überschrieben wird.
    const fresh = (await s.get(key, { type: 'json' })) || dev;
    fresh.sent = [...new Set([...(fresh.sent || []), ...newlySent])].slice(-500);
    fresh.reminders = (fresh.reminders || []).filter((r) => r.at > now - KEEP_LIMIT);
    await s.setJSON(key, fresh);
  }
  return { sent, removed, devices: blobs.length };
}

export default async () => {
  const s = store();
  const result = await sendDue(s, await configuredWebPush(s));
  if (result.sent || result.removed) console.log('Denkzettel:', JSON.stringify(result));
};

export const config = { schedule: '* * * * *' };
