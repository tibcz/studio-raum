// Builds the app into dist/ and writes the service worker that keeps it usable offline.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { build } from 'vite';
import { buildVersion, precacheList, serviceWorkerSource } from './service-worker';

const root = join(import.meta.dirname, '..');
const dist = join(root, 'dist');
await build({ root, logLevel: 'info' });
const files = precacheList(dist);
writeFileSync(join(dist, 'sw.js'), serviceWorkerSource('studio-raum', files, buildVersion(dist, files), { title: 'Studio Raum', icon: '/icon-192.png' }));
console.log(`service worker: ${files.length} files cached for offline use`);
