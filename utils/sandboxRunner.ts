import { hasExecutableStatements, instrumentCode } from './instrumenter';
import { findBeginnerMistake, type BeginnerCheckOptions } from './beginnerChecks';
import type { DataVariant } from './levelData';
import type { Direction, RobotPos } from './robotEngine';

export type SandboxMode =
  | 'basic'
  | 'conditional'
  | 'single-key'
  | 'key-door'
  | 'multi-key'
  | 'dom';

export interface SandboxDomState {
  terminalUnlocked: boolean;
  doorOpen: boolean;
  platformActive: boolean;
  buttonClicked: boolean;
  /** Background colours set through element.style, by element id (terminal, door, platform, button). */
  colors?: Record<string, string>;
}

const SAFE_CSS_COLOR = /^(?:[a-zA-Z]{3,20}|#[0-9a-fA-F]{3,8}|(?:rgb|rgba|hsl|hsla)\([0-9.,%\s/a-z-]{1,60}\))$/;

/** A colour value that is safe to put into a style: a name, #hex or rgb()/hsl(), never a url(). */
export function isSafeCssColor(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 64 && SAFE_CSS_COLOR.test(value);
}

export type SandboxEvent =
  | { type: 'line'; line: number }
  | {
      type: 'robot';
      action: 'move' | 'turn' | 'blocked' | 'out-of-bounds' | 'key' | 'death' | 'door';
      pos: RobotPos;
      step: number;
      cell?: string;
      message?: string;
    }
  | { type: 'dom'; state: SandboxDomState; message: string }
  | { type: 'console'; message: string };

export interface SandboxRequest {
  code: string;
  gridMap: string[][];
  initialPos: { x: number; y: number; dir: Direction };
  mode: SandboxMode;
  throwOnOutOfBounds?: boolean;
  maxSteps?: number;
  maxOperations?: number;
  timeoutMs?: number;
  /** Values the level passes to the code as variables (levels 5 and 6: route, instructions). */
  data?: Record<string, unknown>;
  /** Hidden boards with their own data, on which the same code also runs (see levelData.ts). */
  variants?: DataVariant[];
}

/** How the code did on one hidden variant. */
export interface SandboxVariantResult {
  ok: boolean;
  errorCode?: string;
  finalPos: RobotPos;
  collectedKeys: string[];
  steps: number;
}

export interface SandboxResult {
  ok: boolean;
  errorCode?:
    | 'COMPILE_ERROR'
    | 'RUNTIME_ERROR'
    | 'TIMEOUT'
    | 'WORKER_ERROR'
    | 'OUT_OF_BOUNDS'
    | 'KILLED'
    | 'STEP_LIMIT'
    | 'OPERATION_LIMIT';
  error?: string;
  events: SandboxEvent[];
  path: RobotPos[];
  finalPos: RobotPos;
  steps: number;
  loopIterations?: number;
  activeLoopIterations?: number;
  /** Same as loopActions (kept for older callers). */
  loopRobotActions?: number;
  /**
   * Robot actions made inside a loop iteration: the body, condition or update of a loop, a callback
   * of a built-in iteration method (however it is called) or an action of repeat().
   */
  loopActions?: number;
  /** Robot actions made while one of the learner's own functions was running. */
  userFunctionRobotActions?: number;
  /** One entry per request.variants, when the real run succeeded. */
  variants?: SandboxVariantResult[];
  collectedKeys: string[];
  hasKey: boolean;
  doorOpened: boolean;
  isDead: boolean;
  domState: SandboxDomState;
}

/** Hand-written robot commands tolerated next to the loop (e.g. a final manual turn). */
export const MAX_UNBACKED_ACTIONS = 7;

/** The code reached the goal with every key on each hidden variant, i.e. it follows the level's data. */
export function followsLevelData(result: SandboxResult, variants: readonly DataVariant[]): boolean {
  return variants.every((variant, index) => {
    const outcome = result.variants?.[index];
    return !!outcome
      && outcome.ok
      && variant.gridMap[outcome.finalPos.y]?.[outcome.finalPos.x] === 'goal'
      && outcome.collectedKeys.length === variant.keys;
  });
}

/** The robot's moves were made in loop iterations, apart from a few hand-written ones. */
export function movesInLoop(result: SandboxResult): boolean {
  const minIterations = result.steps > 1 ? 2 : 1;
  if (typeof result.loopIterations === 'number' && result.loopIterations < minIterations) {
    return false;
  }
  if (typeof result.activeLoopIterations === 'number' && result.activeLoopIterations < minIterations) {
    return false;
  }
  const loopActions = result.loopActions ?? 0;
  return loopActions >= 1 && result.steps - loopActions <= MAX_UNBACKED_ACTIONS;
}

/**
 * Levels 5 and 6: the robot must be driven by the level's command data in a loop. Decided from what
 * the code does, not from how it is written: the moves happen in loop iterations, and the same code
 * given other data (hidden variants) follows that data to its goal as well, which a route copied
 * into the code by hand, in any form, cannot do.
 */
export function isDataDrivenLoopRun(result: SandboxResult, variants: readonly DataVariant[]): boolean {
  return movesInLoop(result) && followsLevelData(result, variants);
}

const MAX_CODE_LENGTH = 50_000;
const DEFAULT_TIMEOUT_MS = 2_000;

function emptyResult(request: SandboxRequest, errorCode: SandboxResult['errorCode'], error: string): SandboxResult {
  const initialPos = { ...request.initialPos };
  return {
    ok: false,
    errorCode,
    error,
    events: [],
    path: [initialPos],
    finalPos: initialPos,
    steps: 0,
    loopIterations: 0,
    activeLoopIterations: 0,
    loopRobotActions: 0,
    loopActions: 0,
    userFunctionRobotActions: 0,
    collectedKeys: [],
    hasKey: false,
    doorOpened: false,
    isDead: false,
    domState: {
      terminalUnlocked: false,
      doorOpen: false,
      platformActive: false,
      buttonClicked: false,
    },
  };
}

function isSandboxResult(value: unknown): value is SandboxResult {
  if (!value || typeof value !== 'object') return false;
  const result = value as Partial<SandboxResult>;
  return (
    typeof result.ok === 'boolean' &&
    Array.isArray(result.events) &&
    Array.isArray(result.path) &&
    typeof result.steps === 'number' &&
    !!result.finalPos &&
    typeof result.finalPos === 'object'
  );
}

/**
 * Checks whether the learner's code can be compiled, contains at least one executable statement and
 * has none of the typical beginner mistakes (see beginnerChecks.ts) before spending an attempt or
 * deducting a life.
 */
export function checkRunnableCode(
  code: string,
  providedNames: string[] = [],
  options: Omit<BeginnerCheckOptions, 'providedNames'> = {},
): string | null {
  if (code.length > MAX_CODE_LENGTH) {
    return 'Код завеликий. Максимум — 50 000 символів.';
  }
  try {
    instrumentCode(code, { providedNames });
  } catch (error) {
    const rawMsg = error instanceof Error ? error.message : String(error);
    if (error instanceof SyntaxError || /\(\d+:\d+\)\s*$/.test(rawMsg)) {
      const lineMatch = rawMsg.match(/\((\d+):\d+\)\s*$/);
      const linePart = lineMatch ? ` (рядок ${lineMatch[1]})` : '';
      return `Помилка синтаксису${linePart}: перевір дужки (), {}, лапки або назви команд. (${rawMsg})`;
    }
    return rawMsg;
  }
  if (!hasExecutableStatements(code)) {
    return 'Спочатку напиши або розкоментуй код у редакторі, а потім натискай «Запустити»!';
  }
  return findBeginnerMistake(code, { ...options, providedNames });
}

/**
 * Executes learner code in a dedicated, terminable Worker.
 *
 * The worker response is served with a restrictive CSP (see next.config.ts),
 * so it cannot open network connections. Worker globals also have no access to
 * the page DOM, localStorage, or Clerk's browser session.
 */
export function runCodeInSandbox(request: SandboxRequest): Promise<SandboxResult> {
  if (typeof window === 'undefined' || typeof Worker === 'undefined') {
    return Promise.resolve(emptyResult(request, 'WORKER_ERROR', 'Ізольований виконавець недоступний у цьому браузері.'));
  }

  if (request.code.length > MAX_CODE_LENGTH) {
    return Promise.resolve(emptyResult(request, 'COMPILE_ERROR', 'Код завеликий. Максимум — 50 000 символів.'));
  }

  const rand = () => Math.random().toString(36).slice(2, 10);
  const traceIdentifier = `__jsQuestTrace_${rand()}`;
  const hookIdentifiers = {
    enterFn: `__jsQuestEnterFn_${rand()}`,
    exitFn: `__jsQuestExitFn_${rand()}`,
    enterLoop: `__jsQuestEnterLoop_${rand()}`,
    exitLoop: `__jsQuestExitLoop_${rand()}`,
  };

  let instrumentedCode: string;
  try {
    instrumentedCode = instrumentCode(request.code, {
      traceIdentifier,
      hookIdentifiers,
      providedNames: Object.keys(request.data ?? {}),
    });
  } catch (error) {
    return Promise.resolve(
      emptyResult(
        request,
        'COMPILE_ERROR',
        error instanceof Error ? error.message : String(error),
      ),
    );
  }

  return new Promise((resolve) => {
    let worker: Worker;
    try {
      worker = new Worker('/code-runner.worker.js', { name: 'js-quest-code-runner' });
    } catch {
      resolve(emptyResult(request, 'WORKER_ERROR', 'Не вдалося запустити ізольований виконавець.'));
      return;
    }
    const runId =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let settled = false;

    const finish = (result: SandboxResult) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeoutId);
      worker.terminate();
      resolve(result);
    };

    const timeoutId = window.setTimeout(() => {
      finish(
        emptyResult(
          request,
          'TIMEOUT',
          'Виконання зупинено: код працював надто довго або містить нескінченний цикл.',
        ),
      );
    }, request.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    let messageCount = 0;
    const MAX_EXPECTED_MESSAGES = 1;

    worker.addEventListener('message', (event: MessageEvent) => {
      messageCount += 1;
      if (messageCount > MAX_EXPECTED_MESSAGES) {
        finish(
          emptyResult(
            request,
            'OPERATION_LIMIT',
            'Виконання зупинено: отримано надмірну кількість повідомлень від ізольованого процесу.',
          ),
        );
        return;
      }

      const payload = event.data as { type?: string; runId?: string; result?: unknown };
      if (payload?.type !== 'result' || payload.runId !== runId || !isSandboxResult(payload.result)) {
        finish(
          emptyResult(
            request,
            'WORKER_ERROR',
            'Отримано некоректну відповідь від ізольованого виконавця.',
          ),
        );
        return;
      }
      finish(payload.result);
    });

    worker.addEventListener('error', () => {
      finish(emptyResult(request, 'WORKER_ERROR', 'Не вдалося запустити ізольований виконавець.'));
    });

    worker.postMessage({
      type: 'run',
      runId,
      traceIdentifier,
      hookIdentifiers,
      instrumentedCode,
      config: {
        gridMap: request.gridMap,
        initialPos: request.initialPos,
        mode: request.mode,
        throwOnOutOfBounds: request.throwOnOutOfBounds ?? false,
        maxSteps: request.maxSteps ?? 2_000,
        maxOperations: request.maxOperations ?? 10_000,
        data: request.data,
        variants: request.variants?.map(({ gridMap, initialPos, data }) => ({ gridMap, initialPos, data })),
      },
    });
  });
}

export function createSandboxGenerator(
  events: SandboxEvent[],
  onEvent: (event: SandboxEvent) => void,
): Generator<{ type: 'line'; line: number } | void, void, unknown> {
  return (function* sandboxTrace() {
    for (let i = 0; i < events.length; i += 1) {
      const event = events[i];
      onEvent(event);
      if (event.type === 'line') {
        let consumedRobot = false;
        while (i + 1 < events.length && events[i + 1].type !== 'line') {
          if (events[i + 1].type === 'robot') {
            if (consumedRobot) break;
            consumedRobot = true;
          }
          i += 1;
          onEvent(events[i]);
        }
        yield { type: 'line', line: event.line };
      } else {
        yield;
      }
    }
  })();
}

const MAX_PLAYBACK_EVENTS = 150;

/**
 * Limit failures are reported immediately instead of replaying thousands of
 * trace events. Short physical failures still animate so learners can see the
 * move that hit an enemy or left the board. Long successful runs are capped so
 * execution animation never blocks the UI for minutes, while preserving any
 * key pickup, door opening, or DOM state-change events from the skipped middle.
 */
export function getSandboxPlaybackEvents(result: SandboxResult): SandboxEvent[] {
  const limit = result.ok ? MAX_PLAYBACK_EVENTS : 100;
  if (result.events.length <= limit) return result.events;
  const headCount = result.ok ? 50 : 30;
  const baseTailCount = limit - headCount;
  const middle = result.events.slice(headCount, -baseTailCount);
  const criticalMiddle = middle
    .filter(e => e.type === 'dom' || (e.type === 'robot' && (e.action === 'key' || e.action === 'door')))
    .slice(0, Math.max(0, baseTailCount - 10));
  const tailCount = baseTailCount - criticalMiddle.length;
  return [
    ...result.events.slice(0, headCount),
    ...criticalMiddle,
    ...result.events.slice(-tailCount),
  ];
}

export function getSandboxPlaybackPath(result: SandboxResult): RobotPos[] {
  if (!result.ok && result.path.length === 0) {
    return [{ ...result.finalPos }];
  }
  const limit = result.ok ? MAX_PLAYBACK_EVENTS : 100;
  if (result.path.length <= limit) return result.path;
  const headCount = result.ok ? 50 : 30;
  const baseTailCount = limit - headCount;
  const middle = result.path.slice(headCount, -baseTailCount);
  const keyStepsInMiddle = middle
    .filter(p => Boolean(p.keyPicked))
    .slice(0, Math.max(0, baseTailCount - 10));
  const tailCount = baseTailCount - keyStepsInMiddle.length;
  return [
    ...result.path.slice(0, headCount),
    ...keyStepsInMiddle,
    ...result.path.slice(-tailCount),
  ];
}

