import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const SKIP = new Set(['sw.js', '_headers', '404.html', 'lost.css', 'robots.txt', 'sitemap.xml']);

// Pages are cached by their extensionless URL: the host redirects the .html form, and one failed file fails the whole install.
export function precacheList(dist: string): string[] {
  const urls: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else {
        const rel = relative(dist, full).split(sep).join('/');
        if (SKIP.has(rel) || rel.startsWith('.')) continue;
        urls.push(rel === 'index.html' ? '/' : rel.endsWith('.html') ? `/${rel.slice(0, -5)}` : `/${rel}`);
      }
    }
  };
  walk(dist);
  return urls.sort();
}

export function buildVersion(dist: string, urls: string[]): string {
  const h = createHash('sha256');
  for (const u of urls) {
    h.update(u);
    const file = u === '/' ? 'index.html' : u.slice(1);
    h.update(readFileSync(join(dist, existsSync(join(dist, file)) ? file : `${file}.html`)));
  }
  return h.digest('hex').slice(0, 12);
}

export interface PushOptions {
  title: string;
  icon: string;
}

function pushSource(push: PushOptions): string {
  return `
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  const title = typeof data.title === 'string' && data.title.length > 0 ? data.title : ${JSON.stringify(push.title)};
  const options = {
    body: typeof data.body === 'string' ? data.body : '',
    tag: typeof data.tag === 'string' ? data.tag : 'default',
    icon: ${JSON.stringify(push.icon)},
    badge: ${JSON.stringify(push.icon)},
    renotify: true,
    vibrate: data.vibrate === false ? [0] : [180, 80, 180],
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      if (new URL(client.url).origin === self.location.origin) return client.focus();
    }
    return self.clients.openWindow('/');
  })());
});
`;
}

export function serviceWorkerSource(app: string, urls: string[], version: string, push?: PushOptions): string {
  return `const CACHE = '${app}-${version}';
const FILES = ${JSON.stringify(urls)};

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(FILES.map((url) => new Request(url, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(async () => (await caches.match(request)) || (await caches.match('/')) || Response.error()),
    );
    return;
  }
  event.respondWith(caches.match(request).then((hit) => hit || fetch(request)));
});
${push ? pushSource(push) : ''}`;
}
