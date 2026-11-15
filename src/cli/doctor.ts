import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ConfigStore } from '../config/store.js';
import { which } from '../core/exec.js';
import { platformSummary } from '../core/platform.js';
import { Runtime } from '../core/runtime.js';
import { buildSeatbeltProfile, checkSandbox } from '../core/sandbox.js';
import { AuthGate } from '../server/auth.js';
import { HttpServer } from '../server/http.js';
import { classifyNgrokError, findNgrokAuthtoken, NGROK_URLS, type TunnelProvider } from '../server/tunnel.js';
import { ToolRegistry } from '../tools/registry.js';
import type { Ui } from './ui.js';

export interface CheckResult {
  name: string;
  status: 'ok' | 'warn' | 'fail' | 'skip';
  detail: string;
  /** What the user can do about a warning or failure. */
  fix?: string;
}

export interface DoctorDeps {
  ui: Ui;
  env: NodeJS.ProcessEnv;
  home: string;
  platform: NodeJS.Platform;
  stateDir: string;
  offline: boolean;
  tunnelProvider: TunnelProvider;
  /** Additional checks (desktop control on macOS). */
  extraChecks?: () => Promise<CheckResult[]>;
}

async function checkStateDir(stateDir: string): Promise<CheckResult> {
  try {
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    const probe = path.join(stateDir, `.doctor-${process.pid}`);
    await writeFile(probe, '');
    await rm(probe);
    return { name: 'Settings directory', status: 'ok', detail: stateDir };
  } catch (err) {
    return { name: 'Settings directory', status: 'fail', detail: `${stateDir} is not writable: ${(err as Error).message}`, fix: 'Fix its permissions or set MCPCLAUDE_HOME to a writable directory.' };
  }
}

async function checkSandboxWorks(stateDir: string): Promise<CheckResult> {
  const project = await realpath(await mkdtemp(path.join(stateDir, 'doctor-')));
  try {
    const result = await checkSandbox(buildSeatbeltProfile({ projectDir: project, readWriteDirs: [], readOnlyDirs: [], readOnlyFiles: [] }));
    return result.ok
      ? { name: 'Command sandbox', status: 'ok', detail: 'macOS Seatbelt profile loads; Project-Only mode can confine commands' }
      : { name: 'Command sandbox', status: 'fail', detail: result.detail ?? 'sandbox-exec failed', fix: 'Project-Only mode cannot confine commands here. Use Full System Access, or --unsafe-no-sandbox.' };
  } finally {
    await rm(project, { recursive: true, force: true });
  }
}

/** Open a real tunnel to a throwaway server and fetch its health endpoint through the internet. */
async function checkTunnelRoundTrip(deps: DoctorDeps, authtoken: string, domain: string | undefined): Promise<CheckResult> {
  const name = 'Tunnel round trip';
  const runtime = new Runtime({ stateDir: deps.stateDir, authMode: 'none', auditToDisk: false, platform: deps.platform, env: deps.env, home: deps.home });
  const server = new HttpServer({ runtime, registry: new ToolRegistry([]), auth: new AuthGate({ mode: 'none' }), port: 0 });
  let tunnel;
  try {
    const port = await server.listen();
    const started = Date.now();
    tunnel = await deps.tunnelProvider.start({ port, authtoken, ...(domain ? { domain } : {}) });
    server.allowHost(new URL(tunnel.url).hostname);
    const response = await fetch(`${tunnel.url}/health`, { headers: { 'ngrok-skip-browser-warning': '1' }, signal: AbortSignal.timeout(20_000) });
    const body = (await response.json().catch(() => undefined)) as { status?: string } | undefined;
    if (response.status === 200 && body?.status === 'ok') {
      return { name, status: 'ok', detail: `${tunnel.url} reached this Mac through the internet in ${Date.now() - started} ms` };
    }
    return { name, status: 'fail', detail: `${tunnel.url}/health answered HTTP ${response.status}`, fix: 'Something between ngrok and this Mac altered the response; check proxies and security software.' };
  } catch (err) {
    const failure = classifyNgrokError(err);
    // ngrok accepted the authtoken and the network works; only the address is taken, often by the user's own running mcpclaude.
    if (failure.kind === 'endpoint_in_use') return { name, status: 'warn', detail: `${failure.message} The authtoken and network are fine.`, fix: failure.hint };
    return { name, status: 'fail', detail: failure.message, fix: failure.hint };
  } finally {
    await tunnel?.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  }
}

export async function collectChecks(deps: DoctorDeps): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const major = Number(process.versions.node.split('.')[0]);
  results.push(
    major >= 22
      ? { name: 'Node.js', status: 'ok', detail: process.version }
      : { name: 'Node.js', status: 'fail', detail: `${process.version} is too old`, fix: 'Install Node.js 22 or newer.' },
  );
  const os = await platformSummary(deps.platform);
  results.push(
    deps.platform === 'darwin'
      ? { name: 'Operating system', status: 'ok', detail: `macOS ${os.version} (${os.arch})` }
      : { name: 'Operating system', status: 'warn', detail: `${os.os} ${os.version}: desktop control and the command sandbox need macOS`, fix: 'Run mcpclaude on a Mac for the full feature set.' },
  );
  results.push(await checkStateDir(deps.stateDir));

  const config = new ConfigStore(deps.stateDir);
  await config.load().catch(() => undefined);
  const token = await findNgrokAuthtoken({ env: deps.env, config: config.value, home: deps.home, platform: deps.platform });
  let sdkLoads = true;
  try {
    await import('@ngrok/ngrok');
    results.push({ name: 'ngrok SDK', status: 'ok', detail: 'embedded ngrok agent loads on this platform' });
  } catch (err) {
    sdkLoads = false;
    results.push({ name: 'ngrok SDK', status: 'fail', detail: (err as Error).message.split('\n')[0] ?? 'failed to load', fix: 'Reinstall mcpclaude on this machine (npm install) so the matching ngrok binary is installed.' });
  }
  results.push(
    token
      ? { name: 'ngrok authtoken', status: 'ok', detail: `found in ${token.description}` }
      : { name: 'ngrok authtoken', status: 'warn', detail: 'not found; you will be asked for it on first start', fix: `Get one at ${NGROK_URLS.authtoken}` },
  );
  if (!token || !sdkLoads) results.push({ name: 'Tunnel round trip', status: 'skip', detail: 'needs the ngrok SDK and an authtoken' });
  else if (deps.offline) results.push({ name: 'Tunnel round trip', status: 'skip', detail: 'skipped (--offline)' });
  else results.push(await checkTunnelRoundTrip(deps, token.token, config.value.ngrokDomain));

  results.push(deps.platform === 'darwin' ? await checkSandboxWorks(deps.stateDir) : { name: 'Command sandbox', status: 'skip', detail: 'macOS only' });
  results.push(
    (await which('git', deps.env))
      ? { name: 'git', status: 'ok', detail: 'installed' }
      : { name: 'git', status: 'warn', detail: 'not found on PATH', fix: 'Install the Xcode Command Line Tools: xcode-select --install' },
  );
  if (deps.extraChecks) results.push(...(await deps.extraChecks()));
  return results;
}

/** `mcpclaude doctor`: print every check and return the process exit code. */
export async function runDoctor(deps: DoctorDeps): Promise<number> {
  const { ui } = deps;
  ui.heading('mcpclaude doctor');
  const spinner = ui.spinner('Running checks…');
  const results = await collectChecks(deps);
  spinner.stop();
  const width = Math.max(...results.map((r) => r.name.length));
  const marks = { ok: ui.paint('✔', 'green'), warn: ui.paint('!', 'yellow', 'bold'), fail: ui.paint('✖', 'red'), skip: ui.paint('–', 'dim') };
  for (const result of results) {
    ui.line(`${marks[result.status]} ${result.name.padEnd(width)}  ${result.detail}`);
    if (result.fix && result.status !== 'ok') ui.line(`  ${' '.repeat(width)}  ${ui.paint(`→ ${result.fix}`, 'dim')}`);
  }
  const failures = results.filter((r) => r.status === 'fail').length;
  const warnings = results.filter((r) => r.status === 'warn').length;
  ui.line();
  if (failures > 0) ui.error(`${failures} problem${failures === 1 ? '' : 's'} found${warnings ? `, ${warnings} warning${warnings === 1 ? '' : 's'}` : ''}.`);
  else if (warnings > 0) ui.warn(`No blocking problems, ${warnings} warning${warnings === 1 ? '' : 's'}.`);
  else ui.success('Everything looks good.');
  return failures > 0 ? 1 : 0;
}
