import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'));
const viteConfig = fs.readFileSync(path.join(repositoryRoot, 'vite.config.ts'), 'utf8');
const distDirectory = path.join(repositoryRoot, 'dist');
const failures = [];

if (packageJson.dependencies?.['@google/genai']) {
  failures.push('package.json still declares the browser provider SDK');
}

if (viteConfig.includes('GEMINI_API_KEY')) {
  failures.push('vite.config.ts still references the provider secret identifier');
}

if (!fs.existsSync(distDirectory)) {
  failures.push('dist is missing; build before running the client security gate');
}

const bundleIndicators = [
  { name: 'provider environment identifier', pattern: /GEMINI_API_KEY/ },
  { name: 'provider SDK package marker', pattern: /@google\/genai/ },
  { name: 'provider API endpoint', pattern: /generativelanguage\.googleapis\.com/ },
  { name: 'Google-style API credential', pattern: /AIza[0-9A-Za-z_-]{20,}/ },
  { name: 'Supabase privileged key identifier', pattern: /SUPABASE_SERVICE_ROLE_KEY/ },
  { name: 'Stripe secret key identifier', pattern: /STRIPE_SECRET_KEY/ },
  { name: 'Cloudflare API token identifier', pattern: /CLOUDFLARE_API_TOKEN/ }
];

const visit = (directory) => {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      visit(absolutePath);
      continue;
    }

    if (!/\.(?:css|html|js|map)$/.test(entry.name)) continue;

    const contents = fs.readFileSync(absolutePath, 'utf8');
    for (const indicator of bundleIndicators) {
      if (indicator.pattern.test(contents)) {
        failures.push(`${path.relative(repositoryRoot, absolutePath)} contains ${indicator.name}`);
      }
    }
  }
};

if (fs.existsSync(distDirectory)) visit(distDirectory);

if (failures.length > 0) {
  console.error('Client bundle security gate failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log('Client bundle security gate OK: no provider SDK or secret indicators detected.');
}
