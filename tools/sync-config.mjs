import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const site = JSON.parse(readFileSync(join(root, 'config/site.json'), 'utf8'));

const problems = [];
if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(site.domain)) problems.push(`domain "${site.domain}" is not a bare hostname`);
if (!/^[a-z0-9-]+$/.test(site.apiSubdomain)) problems.push('apiSubdomain must be a single DNS label');
for (const key of ['apiWorkerName', 'siteWorkerName']) {
  if (!/^[a-z0-9-]+$/.test(site.cloudflare[key] ?? '')) problems.push(`cloudflare.${key} must be lowercase letters, numbers and dashes`);
}
if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(site.github.sourceRepo)) problems.push('github.sourceRepo must look like owner/repo');
if (problems.length) {
  console.error(`config/site.json has problems:\n- ${problems.join('\n- ')}`);
  process.exit(1);
}

const values = {
  apiWorkerName: site.cloudflare.apiWorkerName,
  siteWorkerName: site.cloudflare.siteWorkerName,
  siteHost: site.domain,
  apiHost: `${site.apiSubdomain}.${site.domain}`,
  githubClientId: site.github.appClientId,
  // A placeholder keeps the build check working before the database exists.
  d1DatabaseId: site.cloudflare.d1DatabaseId || '00000000-0000-0000-0000-000000000000',
};

function render(templatePath, outPath) {
  const template = readFileSync(join(root, templatePath), 'utf8');
  const out = template
    .replace(/^# Generated.*\r?\n/,'# Generated from config/site.json by tools/sync-config.mjs. Do not edit by hand.\n')
    .replace(/\{\{(\w+)\}\}/g, (_, key) => {
      if (!(key in values)) throw new Error(`Unknown template key ${key} in ${templatePath}`);
      return String(values[key]).replace(/["\\\n]/g, '');
    });
  writeFileSync(join(root, outPath), out);
}

render('worker/wrangler.template.toml', 'worker/wrangler.toml');
render('web/wrangler.template.toml', 'web/wrangler.toml');
console.log(`wrangler configs synced for ${values.siteHost} and ${values.apiHost}`);
