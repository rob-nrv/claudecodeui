import type { CliOutput } from '@/shared/types.js';
import { terminalTextStyles } from '@/shared/utils.js';
import type {
  RuntimeController,
  RuntimeRestartResult,
  RuntimeRestartService,
  RuntimeStartResult,
  RuntimeStartService,
  RuntimeStatus,
  RuntimeStopResult,
} from '@/modules/runtime/index.js';

type RuntimeCommandDependencies = {
  controller: RuntimeController;
  restartService: RuntimeRestartService;
  startService: RuntimeStartService;
  output: CliOutput;
  /** Probed only when no marker exists, so a marker-less server is still found. */
  fallbackHealthUrl: string;
};

export type RuntimeCommandService = {
  execute(argumentsList: string[]): Promise<number>;
};

type ParsedRuntimeArguments = {
  subcommand: string;
  json: boolean;
  timeoutMs?: number;
};

function parseRuntimeArguments(argumentsList: string[]): ParsedRuntimeArguments {
  const parsed: ParsedRuntimeArguments = { subcommand: '', json: false };

  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === '--json') {
      parsed.json = true;
    } else if (argument === '--timeout') {
      parsed.timeoutMs = Number.parseInt(argumentsList[++index] ?? '', 10);
    } else if (argument.startsWith('--timeout=')) {
      parsed.timeoutMs = Number.parseInt(argument.slice('--timeout='.length), 10);
    } else if (!argument.startsWith('-') && !parsed.subcommand) {
      parsed.subcommand = argument;
    }
  }

  return parsed;
}

/**
 * Human-readable explanations of every state the resolver can report. The reason
 * codes stay machine-readable for `--json` consumers; these are what a person
 * reading a terminal needs instead.
 */
const STATUS_EXPLANATIONS: Record<RuntimeStatus['reason'], string> = {
  'no-runtime': 'CloudCLI is not running.',
  'foreign-instance': 'A CloudCLI server is running, but this install has no record of starting it.',
  verified: 'Running, and confirmed to be this installation.',
  'unverified-identity': 'A CloudCLI server is running, but it is too old to confirm its identity.',
  'instance-mismatch': 'A different CloudCLI instance is using this port.',
  'stale-marker': 'The previous server is gone; only its leftover record remains.',
  'stale-marker-unverified': 'No server responded, and its record looks left over from an earlier run.',
  'awaiting-health': 'Starting up — it has not answered a health check yet.',
  'health-timeout': 'The process is running but never became healthy.',
  'start-pending': 'Starting up.',
  'start-timeout': 'It did not finish starting in time.',
  'stop-pending': 'Stopping.',
  'stop-timeout': 'It did not stop in time.',
};

function styleForState(state: RuntimeStatus['state']): (value: string) => string {
  if (state === 'online') return terminalTextStyles.ok;
  if (state === 'error') return terminalTextStyles.error;
  if (state === 'stopped') return terminalTextStyles.dim;
  return terminalTextStyles.warn;
}

function printStatus(output: CliOutput, status: RuntimeStatus): void {
  output.log(`\n${terminalTextStyles.bright('CloudCLI Runtime')}\n`);
  output.log(`  State:    ${styleForState(status.state)(status.state.toUpperCase())}`);
  output.log(`  ${STATUS_EXPLANATIONS[status.reason]}`);
  if (status.url) output.log(`\n  Address:  ${terminalTextStyles.dim(status.url)}`);
  if (status.pid) output.log(`  Process:  ${terminalTextStyles.dim(String(status.pid))}`);
  if (status.instanceId) output.log(`  Instance: ${terminalTextStyles.dim(status.instanceId)}`);
  output.log('');
}

function describeStopOutcome(result: RuntimeStopResult, timeoutMs: number): string {
  switch (result.outcome) {
    case 'already-stopped':
      return `${terminalTextStyles.ok('[OK]')} CloudCLI was not running.`;
    case 'stopped':
      return `${terminalTextStyles.ok('[OK]')} CloudCLI stopped.`;
    case 'refused-not-owned':
      return `${terminalTextStyles.warn('[WARN]')} A CloudCLI server is running, but this install cannot confirm it started it, so it was left alone.`;
    case 'signal-failed':
      return `${terminalTextStyles.error('[ERROR]')} Could not signal the CloudCLI process (${result.signalled?.pid}).`;
    case 'timeout':
      return `${terminalTextStyles.error('[ERROR]')} CloudCLI did not stop within ${Math.round(timeoutMs / 1000)}s.`;
  }
}

function describeStartOutcome(result: RuntimeStartResult, timeoutMs: number): string {
  switch (result.outcome) {
    case 'started':
      return `${terminalTextStyles.ok('[OK]')} CloudCLI started.`;
    case 'already-running':
      return `${terminalTextStyles.ok('[OK]')} CloudCLI was already running.`;
    case 'already-starting':
      return `${terminalTextStyles.warn('[WARN]')} CloudCLI is already starting; check status instead of starting again.`;
    case 'blocked-foreign-instance':
      return `${terminalTextStyles.error('[ERROR]')} A different, unverified process is using this port. Refusing to start a second server on it.`;
    case 'launch-failed':
      return `${terminalTextStyles.error('[ERROR]')} Could not start CloudCLI: ${result.launchError}`;
    case 'start-timeout':
      return `${terminalTextStyles.error('[ERROR]')} CloudCLI did not come up within ${Math.round(timeoutMs / 1000)}s.`;
  }
}

function describeRestartOutcome(result: RuntimeRestartResult, timeoutMs: number): string {
  switch (result.outcome) {
    case 'restarted':
      return `${terminalTextStyles.ok('[OK]')} CloudCLI restarted.`;
    case 'started':
      return `${terminalTextStyles.ok('[OK]')} CloudCLI started (nothing was running).`;
    case 'stop-failed':
      return `${terminalTextStyles.error('[ERROR]')} Could not stop the running CloudCLI, so nothing was restarted.`;
    case 'launch-failed':
      return `${terminalTextStyles.error('[ERROR]')} Could not start CloudCLI: ${result.launchError}`;
    case 'start-timeout':
      return `${terminalTextStyles.error('[ERROR]')} CloudCLI did not come back within ${Math.round(timeoutMs / 1000)}s.`;
    case 'same-instance':
      return `${terminalTextStyles.error('[ERROR]')} The previous CloudCLI is still running; the restart did not take effect.`;
  }
}

function showRuntimeHelp(output: CliOutput): void {
  output.log(`
Usage:
  cloudcli runtime status  [--json]
  cloudcli runtime start   [--json] [--timeout <ms>]
  cloudcli runtime stop    [--json] [--timeout <ms>]
  cloudcli runtime restart [--json] [--timeout <ms>]

  status   Report the runtime state. Always exits 0; the state is in the output.
  start    Launch the runtime detached from this process, and confirm it became
           healthy. A no-op if it is already online. Does not build; run
           "npm run build" first if you changed server code. Exits 0 on success,
           1 otherwise.
  stop     Gracefully stop the runtime this installation started.
           Exits 0 once stopped, 1 otherwise.
  restart  Stop, then start a replacement detached from this process, and confirm
           a different instance answered. Does not build; run "npm run build" first
           if you changed server code. Exits 0 on success, 1 otherwise.
`);
}

/**
 * Presents the runtime controller as CLI commands. This is the seam an Android
 * or NAS wrapper drives: `--json` emits the RuntimeStatus contract verbatim, so
 * a wrapper never has to parse human text or inspect processes itself.
 */
export function createRuntimeCommandService(
  dependencies: RuntimeCommandDependencies,
): RuntimeCommandService {
  const { controller, output, fallbackHealthUrl } = dependencies;

  return {
    async execute(argumentsList) {
      const parsed = parseRuntimeArguments(argumentsList);

      if (parsed.subcommand === 'status') {
        const status = await controller.status({ fallbackHealthUrl });
        if (parsed.json) {
          output.log(JSON.stringify(status));
        } else {
          printStatus(output, status);
        }
        return 0;
      }

      if (parsed.subcommand === 'start') {
        const timeoutMs = Number.isInteger(parsed.timeoutMs) && parsed.timeoutMs! > 0
          ? parsed.timeoutMs
          : undefined;
        const result = await dependencies.startService.start({ fallbackHealthUrl, timeoutMs });
        if (parsed.json) {
          output.log(JSON.stringify(result));
        } else {
          output.log(describeStartOutcome(result, timeoutMs ?? 90_000));
        }
        return result.outcome === 'started' || result.outcome === 'already-running' ? 0 : 1;
      }

      if (parsed.subcommand === 'stop') {
        const timeoutMs = Number.isInteger(parsed.timeoutMs) && parsed.timeoutMs! > 0
          ? parsed.timeoutMs
          : undefined;
        const result = await controller.stop({ fallbackHealthUrl, timeoutMs });
        if (parsed.json) {
          output.log(JSON.stringify(result));
        } else {
          output.log(describeStopOutcome(result, timeoutMs ?? 15_000));
        }
        return result.outcome === 'stopped' || result.outcome === 'already-stopped' ? 0 : 1;
      }

      if (parsed.subcommand === 'restart') {
        const timeoutMs = Number.isInteger(parsed.timeoutMs) && parsed.timeoutMs! > 0
          ? parsed.timeoutMs
          : undefined;
        const result = await dependencies.restartService.restart({ fallbackHealthUrl, timeoutMs });
        if (parsed.json) {
          output.log(JSON.stringify(result));
        } else {
          output.log(describeRestartOutcome(result, timeoutMs ?? 90_000));
        }
        return result.outcome === 'restarted' || result.outcome === 'started' ? 0 : 1;
      }

      output.error(`\n❌ Unknown runtime command: ${parsed.subcommand || '(none)'}`);
      showRuntimeHelp(output);
      return 1;
    },
  };
}
