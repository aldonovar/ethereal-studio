import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const main = read('electron/main.cjs');
const authModule = read('electron/desktop-auth.cjs');
const authStore = read('stores/authStore.ts');
const supabase = read('services/supabase.ts');
const launcher = read('scripts/launch-dawfi-desktop.sh');
const packageJson = JSON.parse(read('package.json'));
const failures = [];

const requireSnippet = (source, snippet, message) => {
  if (!source.includes(snippet)) failures.push(message);
};

const forbidSnippet = (source, snippet, message) => {
  if (source.includes(snippet)) failures.push(message);
};

requireSnippet(main, "const AUTH_PROTOCOL = 'dawfi';", 'DAW-fi protocol is not the primary auth protocol.');
requireSnippet(main, 'safeStorage', 'Electron safeStorage is not used for Desktop auth persistence.');
requireSnippet(main, 'createAuthorizationRequest({', 'Desktop auth does not start with an OAuth authorization request.');
requireSnippet(main, 'exchangeAuthorizationCode({', 'Desktop auth does not exchange the one-time code in main.');
requireSnippet(authModule, "code_challenge_method', 'S256'", 'Desktop OAuth does not require S256 PKCE.');
requireSnippet(authModule, "new Set(['code', 'state'])", 'Successful callbacks are not restricted to code and state.');
requireSnippet(supabase, 'detectSessionInUrl: false', 'Renderer URL session detection is still enabled.');
requireSnippet(supabase, "flowType: 'pkce'", 'Supabase renderer client is not configured for PKCE.');
requireSnippet(launcher, "read_public_env_value 'DAWFI_DESKTOP_OAUTH_CLIENT_ID'", 'The launcher cannot load the public Desktop OAuth client identifier.');

forbidSnippet(main, 'DESKTOP_AUTH_BRIDGE_URL', 'The legacy web auth bridge is still active.');
forbidSnippet(main, "webContents.send('desktop-auth-callback', url)", 'A raw callback URL is still sent to the renderer.');
forbidSnippet(authStore, 'hashParams.get(\'access_token\')', 'Renderer still reads an access token from a URL fragment.');
forbidSnippet(authStore, 'hashParams.get(\'refresh_token\')', 'Renderer still reads a refresh token from a URL fragment.');
forbidSnippet(authStore, 'exchangeCodeForSession(code)', 'Renderer still exchanges a callback code outside the main-process broker.');
forbidSnippet(supabase, 'document.cookie', 'Supabase sessions are still persisted in JavaScript cookies.');
forbidSnippet(launcher, 'source "${env_file}"', 'The launcher sources the entire env file into the privileged process.');

const registeredSchemes = packageJson.build?.protocols
  ?.flatMap((protocol) => protocol.schemes ?? []) ?? [];
if (!registeredSchemes.includes('dawfi')) {
  failures.push('The packaged application does not register the primary dawfi:// protocol.');
}
if (!registeredSchemes.includes('hollowbits')) {
  failures.push('The packaged application does not register the transitional hollowbits:// protocol.');
}

if (failures.length > 0) {
  console.error('Desktop auth hardening gate failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log('Desktop auth hardening OK: PKCE code handoff, strict callback and encrypted persistence are wired.');
}
