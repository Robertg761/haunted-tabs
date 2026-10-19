// Turns the Chrome build into a Firefox build (Firefox, Zen, LibreWolf, ...).
// The code is shared; only the manifest differs:
// - Firefox runs MV3 background code as an event page (`scripts`), not a service worker.
// - There is no `favicon` permission; the code falls back to icons tabs already hold.
// - Firefox wants an add-on id and a data collection declaration (none).
import { cpSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

const from = 'dist/chrome';
const to = 'dist/firefox';
rmSync(to, { recursive: true, force: true });
cpSync(from, to, { recursive: true });

const manifest = JSON.parse(readFileSync(`${from}/manifest.json`, 'utf8'));
delete manifest.minimum_chrome_version;
manifest.background = { scripts: ['background.js'], type: 'module' };
manifest.permissions = manifest.permissions.filter((p) => p !== 'favicon');
manifest.browser_specific_settings = {
  gecko: {
    id: 'haunted-tabs@robertg761',
    strict_min_version: '128.0',
    data_collection_permissions: { required: ['none'] },
  },
};
writeFileSync(`${to}/manifest.json`, JSON.stringify(manifest, null, 2) + '\n');
console.log(`Firefox build written to ${to}`);
