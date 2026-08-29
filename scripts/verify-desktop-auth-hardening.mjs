import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const main = read('electron/main.cjs');
const authModule = read('electron/desktop-auth.cjs');
const authCallbackCoordinator = read('electron/desktop-auth-callback-coordinator.cjs');
const preload = read('electron/preload.cjs');
const desktopRoot = read('DesktopRoot.tsx');
const desktopAuthUi = read('components/desktop/DesktopAuth.tsx');
const authStore = read('stores/authStore.ts');
const supabase = read('services/supabase.ts');
const authContractModule = read('services/authContract.ts');
const authContract = JSON.parse(read('config/dawfi-auth.json'));
const envExample = read('.env.example');
const launcher = read('scripts/launch-dawfi-desktop.sh');
const linuxDesktopEntry = read('packaging/linux/daw-fi.desktop');
const packageJson = JSON.parse(read('package.json'));
const failures = [];

const requireSnippet = (source, snippet, message) => {
  if (!source.includes(snippet)) failures.push(message);
};

const forbidSnippet = (source, snippet, message) => {
  if (source.includes(snippet)) failures.push(message);
};

requireSnippet(main, 'DAWFI_AUTH_CONTRACT.desktopRedirectUri', 'DAW-fi protocol is not read from the shared auth contract.');
requireSnippet(main, 'safeStorage', 'Electron safeStorage is not used for Desktop auth persistence.');
requireSnippet(main, 'createAuthorizationRequest({', 'Desktop auth does not start with an OAuth authorization request.');
requireSnippet(main, 'exchangeAuthorizationCode({', 'Desktop auth does not exchange the one-time code in main.');
requireSnippet(main, 'authCallbackCoordinator.run(', 'Desktop auth callbacks are not serialized by state.');
requireSnippet(authCallbackCoordinator, 'const entries = new Map()', 'Desktop callback coordinator has no per-state registry.');
requireSnippet(authCallbackCoordinator, 'return existing.promise', 'Duplicate callbacks do not share the same exchange promise.');
requireSnippet(authModule, "code_challenge_method', 'S256'", 'Desktop OAuth does not require S256 PKCE.');
requireSnippet(authModule, 'DAWFI_AUTH_CONTRACT.socialAuthorizationPath', 'Desktop still depends on a separately registered OAuth Server client.');
requireSnippet(authModule, 'DAWFI_AUTH_CONTRACT.desktopBridgeUrl', 'Desktop social login does not use the protected HTTPS bridge.');
requireSnippet(authModule, "authorizeUrl.searchParams.set('provider', 'google')", 'Desktop does not use the restored Google social provider.');
requireSnippet(authModule, "payload?.role === 'anon'", 'Desktop does not reject privileged Supabase keys.');
requireSnippet(authModule, 'normalizeDawfiSupabaseOrigin', 'Desktop OAuth does not reject another Supabase project.');
requireSnippet(authModule, "new Set(['code', 'state'])", 'Successful callbacks are not restricted to code and state.');
requireSnippet(supabase, 'detectSessionInUrl: false', 'Renderer URL session detection is still enabled.');
requireSnippet(supabase, "flowType: 'pkce'", 'Supabase renderer client is not configured for PKCE.');
requireSnippet(supabase, 'isDawfiSupabaseUrl', 'The renderer does not fail closed on a mismatched Supabase project.');
requireSnippet(preload, "ipcRenderer.on('desktop-auth-callback', handler)", 'Preload does not forward the sanitized Desktop auth result.');
requireSnippet(desktopRoot, 'window.electron?.onAuthCallback?', 'Desktop root does not subscribe to the auth handoff.');
requireSnippet(desktopRoot, 'void handleAuthCallback(url).then((success)', 'Desktop root does not await the renderer auth store result.');
requireSnippet(authStore, "result.errorCode === 'AUTH_DESKTOP_HANDOFF_REPLAYED' && get().session", 'A late replay warning can overwrite an established Desktop session.');
requireSnippet(desktopAuthUi, 'buildDesktopEmailConfirmationRedirectUrl()', 'Desktop email signup bypasses the explicit callback exchange.');
requireSnippet(authContractModule, 'DAWFI_AUTH_CONTRACT.authCallbackPath', 'Desktop email confirmation does not use the shared callback path.');
requireSnippet(launcher, "read_public_env_value 'VITE_SUPABASE_ANON_KEY'", 'The launcher cannot load the public Supabase key used for PKCE exchange.');
requireSnippet(launcher, '--password-store=gnome-libsecret', 'The Linux launcher does not select Secret Service when the compositor cannot infer a secure store.');
requireSnippet(launcher, 'org.freedesktop.secrets', 'The Linux launcher does not verify that Secret Service is active.');
requireSnippet(launcher, '"$@"', 'The launcher discards custom-protocol callback arguments.');
requireSnippet(linuxDesktopEntry, 'Exec=/home/aldonovar/.local/bin/daw-fi %u', 'The Linux launcher does not accept a callback URL.');
requireSnippet(linuxDesktopEntry, 'MimeType=x-scheme-handler/dawfi;x-scheme-handler/hollowbits;', 'The Linux desktop entry does not register DAW-fi callback protocols.');

forbidSnippet(main, 'DAWFI_DESKTOP_OAUTH_CLIENT_ID', 'Desktop still blocks on a manually registered OAuth Server client.');
forbidSnippet(envExample, 'DAWFI_DESKTOP_OAUTH_CLIENT_ID', 'The sample environment still asks for a separate Desktop OAuth client.');
forbidSnippet(main, "webContents.send('desktop-auth-callback', url)", 'A raw callback URL is still sent to the renderer.');
forbidSnippet(authStore, 'hashParams.get(\'access_token\')', 'Renderer still reads an access token from a URL fragment.');
forbidSnippet(authStore, 'hashParams.get(\'refresh_token\')', 'Renderer still reads a refresh token from a URL fragment.');
forbidSnippet(authStore, 'exchangeCodeForSession(code)', 'Renderer still exchanges a callback code outside the main-process broker.');
forbidSnippet(desktopAuthUi, "searchParams.set('verified'", 'Desktop email confirmation still skips the explicit callback exchange.');
forbidSnippet(supabase, 'document.cookie', 'Supabase sessions are still persisted in JavaScript cookies.');
forbidSnippet(launcher, 'source "${env_file}"', 'The launcher sources the entire env file into the privileged process.');

if (authContract.projectRef !== 'xnmkoybfuyivmiuckpxs') {
  failures.push('The shared auth contract points to the wrong Supabase project.');
}
if (authContract.supabaseUrl !== 'https://xnmkoybfuyivmiuckpxs.supabase.co') {
  failures.push('The shared auth contract contains the wrong Supabase origin.');
}
if (authContract.socialAuthorizationPath !== '/auth/v1/authorize') {
  failures.push('The shared auth contract does not use Supabase social login for Desktop.');
}
if (authContract.desktopBridgeUrl !== 'https://www.hollowbits.com/desktop-auth') {
  failures.push('The shared auth contract contains the wrong Desktop HTTPS bridge.');
}
requireSnippet(authContractModule, 'assertDawfiSupabaseUrl', 'The shared auth contract has no strict project assertion.');

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
