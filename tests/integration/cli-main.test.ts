import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import type { Client } from '@modelcontextprotocol/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main } from '../../src/cli/app.js';
import { collectChecks } from '../../src/cli/doctor.js';
import { runLive } from '../../src/cli/live.js';
import { inputSchema, renderToolsMarkdown } from '../../src/cli/tooldocs.js';
import { createToolRegistry } from '../../src/tools/index.js';
import { TunnelError } from '../../src/server/tunnel.js';
import { VERSION } from '../../src/version.js';
import { type Answer, captureUi, type CapturedUi, fakeTunnelProvider, type FakeTunnelProvider, ScriptedPrompter } from '../helpers/cli.js';
import { openClient, outcome } from '../helpers/harness.js';

let root: string;
let projectDir: string;
let stateDir: string;
const clients: Client[] = [];

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), 'mcpclaude-main-')));
  projectDir = path.join(root, 'project');
  stateDir = path.join(root, 'state');
  await mkdir(projectDir);
});
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close().catch(() => undefined)));
  await rm(root, { recursive: true, force: true });
});

/** A stand-in for the terminal's keyboard: a TTY stream the test can type into. */
function fakeKeyboard(): NodeJS.ReadStream & { raw: boolean[] } {
  const stream = new PassThrough() as unknown as NodeJS.ReadStream & { raw: boolean[] };
  stream.isTTY = true;
  stream.raw = [];
  stream.setRawMode = (mode: boolean) => {
    stream.raw.push(mode);
    return stream;
  };
  return stream;
}

interface Invocation {
  out: CapturedUi;
  err: CapturedUi;
  tunnel: FakeTunnelProvider;
  keyboard: ReturnType<typeof fakeKeyboard>;
  code: Promise<number>;
}

function invoke(argv: string[], settings: { answers?: Answer[]; env?: NodeJS.ProcessEnv; tunnel?: FakeTunnelProvider; tty?: boolean } = {}): Invocation {
  const out = captureUi();
  const err = captureUi();
  const tunnel = settings.tunnel ?? fakeTunnelProvider();
  const keyboard = fakeKeyboard();
  if (settings.tty === false) keyboard.isTTY = false;
  // The wizard only asks questions when both ends are terminals.
  Object.defineProperty(out.ui, 'tty', { value: settings.tty !== false });
  const code = main({
    argv,
    env: { PATH: process.env['PATH'], MCPCLAUDE_HOME: stateDir, ...settings.env },
    cwd: projectDir,
    ui: out.ui,
    errorUi: err.ui,
    prompter: new ScriptedPrompter(settings.answers ?? []),
    tunnelProvider: tunnel,
    stdin: keyboard,
  });
  return { out, err, tunnel, keyboard, code };
}

async function until(condition: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('mcpclaude (informational commands)', () => {
  it('prints help and version', async () => {
    const help = invoke(['--help']);
    expect(await help.code).toBe(0);
    expect(help.out.text()).toContain('Usage\n  mcpclaude [options]');
    const version = invoke(['--version']);
    expect(await version.code).toBe(0);
    expect(version.out.text()).toBe(`${VERSION}\n`);
  });

  it('explains usage errors on standard error and exits with status 2', async () => {
    const bad = invoke(['--mode', 'everything']);
    expect(await bad.code).toBe(2);
    expect(bad.out.text()).toBe('');
    expect(bad.err.text()).toBe('mcpclaude: --mode must be "project" or "full", got "everything".\nRun "mcpclaude --help" for usage.\n');
  });

  it('lists the tools as text, JSON and Markdown', async () => {
    const registry = createToolRegistry();
    const text = invoke(['tools']);
    expect(await text.code).toBe(0);
    for (const tool of registry.all()) expect(text.out.text()).toContain(`  ${tool.name}`);
    expect(text.out.text()).toContain(`${registry.all().length} tools.`);
    expect(text.out.text()).toMatch(/kill_process\s+.*\[full access\]/);

    const json = invoke(['tools', '--format', 'json']);
    expect(await json.code).toBe(0);
    const catalogue = JSON.parse(json.out.text()) as { version: string; tools: { name: string; access: string; input_schema: { type: string; properties: Record<string, { description?: string }> }; examples: unknown[] }[] };
    expect(catalogue.version).toBe(VERSION);
    expect(catalogue.tools.map((t) => t.name)).toEqual(registry.all().map((t) => t.name));
    const runCommand = catalogue.tools.find((t) => t.name === 'run_command');
    expect(runCommand?.input_schema.type).toBe('object');
    expect(runCommand?.input_schema.properties['command']?.description).toContain('Command line');
    expect(runCommand?.examples.length).toBeGreaterThan(0);

    const file = path.join(root, 'TOOLS.md');
    const markdown = invoke(['tools', '--format', 'markdown', '--output', file]);
    expect(await markdown.code).toBe(0);
    expect(markdown.out.text()).toContain(`Wrote ${file} (${registry.all().length} tools)`);
    expect(await readFile(file, 'utf8')).toBe(renderToolsMarkdown(registry));
  });

  it('renders a complete Markdown reference', () => {
    const registry = createToolRegistry();
    const markdown = renderToolsMarkdown(registry);
    for (const tool of registry.all()) {
      expect(markdown).toContain(`### \`${tool.name}\``);
      for (const parameter of Object.keys(inputSchema(tool).properties ?? {})) expect(markdown, `${tool.name}.${parameter}`).toContain(`| \`${parameter}\` |`);
    }
    expect(markdown).toContain('| Parameter | Type | Required | Default | Description |');
    expect(markdown).toMatch(/\| `command` \| string \| yes \| — \|/);
    expect(markdown).toMatch(/\| `timeout_seconds` \| number \(1–220\) \| no \| `60` \|/);
    expect(markdown).toContain(`**${registry.get('kill_process')?.title}** · Full System Access only`);
    expect(markdown).toContain(`**${registry.get('read_file')?.title}** · both permission levels`);
    expect(markdown).toContain('```json\n{\n  "command": "npm test",');
    // Every heading in the table of contents exists.
    for (const anchor of markdown.matchAll(/\]\(#([a-z0-9-]+)\)/g)) {
      const heading = markdown.split('\n').find((line) => line.startsWith('## ') && line.slice(3).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') === anchor[1]);
      expect(heading, anchor[1]).toBeDefined();
    }
    expect(markdown).not.toMatch(/\n{3,}/);
  });

  it('shows saved settings with secrets masked, and deletes them on --reset', async () => {
    const empty = invoke(['config']);
    expect(await empty.code).toBe(0);
    expect(empty.out.text()).toContain('none yet (generated on first start)');

    const started = invoke(['--no-tunnel', '--dir', projectDir, '--mode', 'project'], { tty: false });
    await until(() => started.out.text().includes('Ready.'), 'the server to start');
    process.emit('SIGTERM');
    expect(await started.code).toBe(0);
    const token = /\/mcp\/(mcp_[\w-]+)/.exec(started.out.text())?.[1] as string;

    const shown = invoke(['config']);
    await shown.code;
    expect(shown.out.text()).toContain(`${token.slice(0, 8)}…${token.slice(-2)}  (--show-token prints it)`);
    expect(shown.out.text()).not.toContain(token);
    expect(shown.out.text()).toContain(`Recent projects ${projectDir}`);
    const full = invoke(['config', '--show-token']);
    await full.code;
    expect(full.out.text()).toContain(`Access token    ${token}`);

    const reset = invoke(['config', '--reset']);
    expect(await reset.code).toBe(0);
    const after = invoke(['config']);
    await after.code;
    expect(after.out.text()).toContain('none yet (generated on first start)');
  });
});

describe('mcpclaude doctor', () => {
  it('checks the installation and reports what is missing', async () => {
    const run = invoke(['doctor', '--offline']);
    expect(await run.code).toBe(0);
    const text = run.out.text();
    expect(text).toContain('mcpclaude doctor');
    expect(text).toMatch(/✔ Node\.js\s+v\d+/);
    expect(text).toMatch(/✔ Settings directory\s+/);
    expect(text).toMatch(/✔ ngrok SDK\s+embedded ngrok agent loads on this platform/);
    expect(text).toMatch(/! ngrok authtoken\s+not found; you will be asked for it on first start/);
    expect(text).toContain('→ Get one at https://dashboard.ngrok.com/get-started/your-authtoken');
    expect(text).toMatch(/– Tunnel round trip\s+needs the ngrok SDK and an authtoken/);
    if (process.platform === 'darwin') {
      expect(text).toMatch(/✔ Operating system\s+macOS \d+/);
      expect(text).toMatch(/✔ Command sandbox\s+macOS Seatbelt profile loads/);
    } else {
      expect(text).toMatch(/! Operating system\s+Linux/);
      expect(text).toMatch(/– Command sandbox\s+macOS only/);
    }
    expect(text).toMatch(/No blocking problems, \d warnings?\./);
  });

  const doctorDeps = (tunnel: FakeTunnelProvider, offline = false): Parameters<typeof collectChecks>[0] => ({
    ui: captureUi().ui,
    env: { PATH: process.env['PATH'], NGROK_AUTHTOKEN: 'doctor_token_0123456789abcdefgh' },
    home: root,
    platform: process.platform,
    stateDir,
    offline,
    tunnelProvider: tunnel,
  });

  it('sends a request through the tunnel and back when an authtoken is available', async () => {
    // The fake "tunnel" points straight back at the local port, so the round trip is real HTTP.
    const loopback = fakeTunnelProvider({ url: (options) => `http://127.0.0.1:${options.port}` });
    const checks = await collectChecks(doctorDeps(loopback));
    expect(checks.find((c) => c.name === 'ngrok authtoken')).toMatchObject({ status: 'ok', detail: 'found in NGROK_AUTHTOKEN' });
    const roundTrip = checks.find((c) => c.name === 'Tunnel round trip');
    expect(roundTrip?.status).toBe('ok');
    expect(roundTrip?.detail).toMatch(/reached this Mac through the internet in \d+ ms/);
    expect(loopback.starts).toHaveLength(1);
    expect(loopback.closed).toBe(1);

    const skipped = await collectChecks(doctorDeps(fakeTunnelProvider(), true));
    expect(skipped.find((c) => c.name === 'Tunnel round trip')).toMatchObject({ status: 'skip', detail: 'skipped (--offline)' });
  });

  it('fails with the remedy when the tunnel cannot be opened or does not lead back here', async () => {
    const rejected = fakeTunnelProvider({ failures: [new TunnelError('auth', 'ngrok rejected the authtoken.', 'Copy the current token.', 'ERR_NGROK_105')] });
    const checks = await collectChecks(doctorDeps(rejected));
    expect(checks.find((c) => c.name === 'Tunnel round trip')).toEqual({ name: 'Tunnel round trip', status: 'fail', detail: 'ngrok rejected the authtoken.', fix: 'Copy the current token.' });

    const taken = fakeTunnelProvider({ failures: [new TunnelError('endpoint_in_use', 'That ngrok address is already online from another agent.', 'Stop it.', 'ERR_NGROK_334')] });
    const inUse = (await collectChecks(doctorDeps(taken))).find((c) => c.name === 'Tunnel round trip');
    expect(inUse).toMatchObject({ status: 'warn', fix: 'Stop it.' });
    expect(inUse?.detail).toContain('authtoken and network are fine');

    const elsewhere = fakeTunnelProvider({ url: 'http://127.0.0.1:9' });
    const unreachable = (await collectChecks(doctorDeps(elsewhere))).find((c) => c.name === 'Tunnel round trip');
    expect(unreachable?.status).toBe('fail');
    expect(elsewhere.closed).toBe(1);
  });
});

describe('mcpclaude (server)', () => {
  it('runs the wizard, shows activity, and obeys the pause, info and quit keys', async () => {
    const run = invoke([], {
      env: { NGROK_AUTHTOKEN: 'run_token_0123456789abcdefghijkl' },
      answers: [{ select: 'Current directory' }, { select: 'Project-Only' }],
    });
    await until(() => run.out.text().includes('── Activity'), 'the activity view');
    const text = run.out.text();
    expect(text).toContain(`mcpclaude ${VERSION}  MCP server for remote cloud agents on macOS`);
    expect(text).toContain('Keys: p pause/resume · i connection details · q quit');
    expect(run.keyboard.raw).toEqual([true]);

    const port = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(text)?.[1];
    const token = /\/mcp\/(mcp_[\w-]+)/.exec(text)?.[1];
    const client = await openClient(`http://127.0.0.1:${port}/mcp/${token}`);
    clients.push(client);
    expect(outcome(await client.callTool({ name: 'run_command', arguments: { command: 'echo live' } })).text).toContain('live');
    await until(() => /✔ run_command \{"command":"echo live"\} \d+ms/.test(run.out.text()), 'the tool call in the activity log');
    expect(run.out.text()).toMatch(/● client connected: harness 1\.0\.0 \(127\.0\.0\.1\)/);

    run.keyboard.write('p');
    await until(() => run.out.text().includes('Paused: every tool call is refused until you press p again.'), 'the pause message');
    expect(outcome(await client.callTool({ name: 'run_command', arguments: { command: 'echo no' } })).text).toContain('Error [PAUSED]');
    await until(() => /✖ run_command .* PAUSED: The user has paused this server\./.test(run.out.text()), 'the refused call in the activity log');
    run.keyboard.write('p');
    await until(() => run.out.text().includes('✔ Resumed.'), 'the resume message');
    expect(outcome(await client.callTool({ name: 'run_command', arguments: { command: 'echo yes' } })).isError).toBe(false);

    run.out.clear();
    run.keyboard.write('i');
    await until(() => run.out.text().includes('Connection details'), 'the connection details');
    expect(run.out.text()).toContain(`  https://fake-tunnel.example/mcp/${token}`);

    run.keyboard.write('x');
    run.keyboard.write('q');
    expect(await run.code).toBe(0);
    expect(run.out.text()).toContain('Quitting. Stopping the tunnel and server…');
    expect(run.out.text()).toContain('✔ Stopped. The public URL no longer works.');
    expect(run.tunnel.closed).toBe(1);
    expect(run.keyboard.raw).toEqual([true, false]);
    await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow();
  });

  it('mentions background processes it stops on the way out', async () => {
    const run = invoke(['--no-tunnel', '--dir', projectDir, '--mode', 'project'], { tty: false });
    await until(() => run.out.text().includes('── Activity'), 'the activity view');
    expect(run.out.text()).toContain('Press Ctrl+C to stop.');
    const port = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(run.out.text())?.[1];
    const token = /\/mcp\/(mcp_[\w-]+)/.exec(run.out.text())?.[1];
    const client = await openClient(`http://127.0.0.1:${port}/mcp/${token}`);
    clients.push(client);
    await client.callTool({ name: 'start_process', arguments: { command: 'sleep 300', wait_seconds: 0 } });
    await client.callTool({ name: 'start_process', arguments: { command: 'sleep 300', wait_seconds: 0 } });

    process.emit('SIGINT');
    expect(await run.code).toBe(0);
    expect(run.out.text()).toContain('Signal received. Stopping the tunnel and server and 2 background processes…');
  });

  it('exits with status 130 when the wizard is cancelled, and 1 with an explanation when it cannot start', async () => {
    const cancelled = invoke(['--no-tunnel'], { answers: [{ cancel: true }] });
    expect(await cancelled.code).toBe(130);
    expect(cancelled.out.text()).toContain('Cancelled.');

    const failed = invoke(['--dir', projectDir, '--mode', 'project'], { tty: false });
    expect(await failed.code).toBe(1);
    expect(failed.err.text()).toContain('✖ No ngrok authtoken found.');
    expect(failed.err.text()).toContain('https://dashboard.ngrok.com/get-started/your-authtoken');
  });

  it('keeps showing activity without a keyboard until the session is closed', async () => {
    const ui = captureUi();
    const events: string[] = [];
    const { Runtime } = await import('../../src/core/runtime.js');
    const runtime = new Runtime({ stateDir, authMode: 'none', auditToDisk: false });
    const keyboard = fakeKeyboard();
    keyboard.isTTY = false;
    const session = {
      runtime,
      server: undefined as never,
      tunnel: undefined,
      details: { authMode: 'none' as const, token: undefined, publicBaseUrl: undefined, localBaseUrl: 'http://127.0.0.1:1' },
      close: async () => {
        events.push('closed');
      },
    };
    const live = runLive(session, ui.ui, { stdin: keyboard, signals: false });
    runtime.events.emit('tool', { tool: 'read_file', args: { path: 'a' }, ok: true, durationMs: 4 });
    runtime.events.emit('rpc', { method: 'tools/list', client: 'ChatGPT' });
    runtime.events.emit('rpc', { method: 'ping' });
    expect(ui.text()).toMatch(/✔ read_file \{"path":"a"\} 4ms\n.*● ChatGPT listed the tools\n$/);
    expect(keyboard.raw).toEqual([]);
    // Nothing stops the view here; resolve the promise by hand to end the test.
    void live;
    expect(events).toEqual([]);
  });
});
