const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

function loadTsModule(relativePath) {
  const filename = path.isAbsolute(relativePath)
    ? relativePath
    : path.join(__dirname, '..', relativePath);
  const dir = path.dirname(filename);
  const source = fs.readFileSync(filename, 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.React,
      esModuleInterop: true,
      downlevelIteration: true,
    },
    fileName: filename,
  }).outputText;
  const localModule = { exports: {} };
  const evaluateModule = new Function('require', 'module', 'exports', compiled);
  evaluateModule(
    (specifier) => {
      if (specifier === '@clerk/nextjs') return { useUser: () => ({ user: null, isLoaded: true }) };
      if (specifier === 'react') {
        return {
          createContext: () => ({}),
          useCallback: (fn) => fn,
          useContext: () => null,
          useEffect: () => {},
          useReducer: () => [{}, () => {}],
          useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
          createElement: () => null,
        };
      }
      if (specifier.startsWith('@/')) {
        const subpath = specifier.replace('@/', '');
        const fullPath = subpath.endsWith('.ts') || subpath.endsWith('.tsx') ? subpath : `${subpath}.ts`;
        return loadTsModule(path.join(__dirname, '..', fullPath));
      }
      if (specifier.startsWith('.')) {
        const subpath = path.resolve(dir, specifier);
        const resolved = fs.existsSync(subpath)
          ? subpath
          : fs.existsSync(`${subpath}.ts`)
            ? `${subpath}.ts`
            : `${subpath}.tsx`;
        return loadTsModule(resolved);
      }
      return require(specifier);
    },
    localModule,
    localModule.exports,
  );
  return localModule.exports;
}

const { instrumentCode } = loadTsModule(path.join('utils', 'instrumenter.ts'));
const { hasUserFunction, hasLoop } = loadTsModule(path.join('utils', 'codeValidator.ts'));
const { mergeSavedStates } = loadTsModule(path.join('app', 'context', 'GameContext.tsx'));
const { getSandboxPlaybackPath, getSandboxPlaybackEvents } = loadTsModule(path.join('utils', 'sandboxRunner.ts'));

const WORKER_SCRIPT = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'code-runner.worker.js'),
  'utf8',
);

// Runs the ACTUAL public/code-runner.worker.js inside an isolated VM context
function runInActualWorker({ code, config = {} }) {
  const traceIdentifier = '__trace__';
  let instrumentedCode;
  try {
    instrumentedCode = instrumentCode(code, { traceIdentifier, providedNames: Object.keys(config.data || {}) });
  } catch (error) {
    return { ok: false, errorCode: 'COMPILE_ERROR', error: error.message, steps: 0, events: [], path: [], collectedKeys: [] };
  }

  let messageListener = null;
  let sentMessage = null;

  const mockSelf = {
    addEventListener(event, listener) {
      if (event === 'message') messageListener = listener;
    },
    postMessage(data) {
      sentMessage = data;
    },
  };

  const sandboxGlobals = {
    self: mockSelf,
    globalThis: mockSelf,
    console: { log() {}, warn() {}, error() {} },
  };

  const context = vm.createContext(sandboxGlobals);
  vm.runInContext(WORKER_SCRIPT, context);

  assert.ok(messageListener, 'Worker script must register a message listener');

  messageListener({
    data: {
      type: 'run',
      runId: 'test-run-123',
      traceIdentifier,
      instrumentedCode,
      config: {
        gridMap: config.gridMap || [['path', 'path', 'goal']],
        initialPos: config.initialPos || { x: 0, y: 0, dir: 'right' },
        mode: config.mode || 'basic',
        throwOnOutOfBounds: config.throwOnOutOfBounds ?? false,
        maxSteps: config.maxSteps ?? 2000,
        maxOperations: config.maxOperations ?? 10000,
        data: config.data,
        variants: config.variants,
      },
    },
  });

  assert.ok(sentMessage, 'Worker must post back a result message');
  return sentMessage.result;
}

test('Actual Worker executes Level 1 starter code without strict mode eval error', () => {
  const starterCode = `
    move();
    move();
  `;
  const result = runInActualWorker({
    code: starterCode,
    config: {
      gridMap: [['path', 'path', 'goal']],
      initialPos: { x: 0, y: 0, dir: 'right' },
    },
  });
  assert.equal(result.ok, true, `Expected execution to succeed, got error: ${result.error}`);
  assert.equal(result.finalPos.x, 2);
  assert.equal(result.finalPos.y, 0);
  assert.equal(result.steps, 2);
});

test('Actual Worker executes MiniDemo repeat command without crashing', () => {
  const miniDemoCode = `
    repeat(2, () => {
      move();
    });
  `;
  const result = runInActualWorker({
    code: miniDemoCode,
    config: {
      gridMap: [['path', 'path', 'goal']],
      initialPos: { x: 0, y: 0, dir: 'right' },
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.finalPos.x, 2);
  assert.equal(result.steps, 2);
});

test('Actual Worker prevents Function constructor sandbox escape', () => {
  const maliciousCode = `
    const fn = (() => {}).constructor;
    fn('return this')();
  `;
  const result = runInActualWorker({
    code: maliciousCode,
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /disabled in the sandbox/);
});

test('Actual Worker prevents prototype pollution from tampering with finalPos / DOM state', () => {
  const pollutionCode = `
    try {
      Object.prototype.x = 99;
      Object.prototype.terminalUnlocked = true;
      Object.prototype.doorOpen = true;
      Object.prototype.platformActive = true;
    } catch (_) {}
    move();
  `;
  const result = runInActualWorker({
    code: pollutionCode,
    config: {
      gridMap: [['path', 'path', 'goal']],
      initialPos: { x: 0, y: 0, dir: 'right' },
      mode: 'dom',
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.finalPos.x, 1, 'finalPos.x must not be polluted by prototype property');
  assert.equal(result.domState.terminalUnlocked, false, 'terminalUnlocked must not be forged by prototype');
  assert.equal(result.domState.doorOpen, false, 'doorOpen must not be forged by prototype');
});

test('Actual Worker halts infinite loops with OPERATION_LIMIT', () => {
  const infiniteCode = `
    while (true) {}
  `;
  const result = runInActualWorker({
    code: infiniteCode,
    config: { maxOperations: 50 },
  });
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'OPERATION_LIMIT');
});

test('Actual Worker halts infinite loops whose body only declares a function', () => {
  const infiniteCode = `
    while (true) {
      function unused() {}
    }
  `;
  const result = runInActualWorker({
    code: infiniteCode,
    config: { maxOperations: 50 },
  });
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'OPERATION_LIMIT');
});

test('Actual Worker triggers OUT_OF_BOUNDS when throwOnOutOfBounds is true', () => {
  const oobCode = `
    turnLeft();
    move();
  `;
  const result = runInActualWorker({
    code: oobCode,
    config: {
      gridMap: [['path', 'goal']],
      initialPos: { x: 0, y: 0, dir: 'right' },
      throwOnOutOfBounds: true,
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'OUT_OF_BOUNDS');
});

test('mergeSavedStates preserves lost lives across tabs (never resurrects lost lives)', () => {
  const tabAState = {
    lives: 3,
    score: 175,
    completedLevels: [1],
    attemptsByLevel: { 1: 1 },
  };
  const tabBState = {
    lives: 2, // lost a life
    score: 100,
    completedLevels: [1],
    attemptsByLevel: { 1: 2 },
  };

  const merged = mergeSavedStates(tabAState, tabBState);
  assert.equal(merged.lives, 2, 'Must keep the lowest lives count (2 instead of 3)');
  assert.equal(merged.score, 175, 'Must keep the highest score');
  assert.deepEqual(merged.completedLevels, [1]);
  assert.equal(merged.attemptsByLevel[1], 2);
});

test('codeValidator correctly detects functions for Level 4', () => {
  assert.equal(hasUserFunction('function myMove() { move(); } myMove();'), true);
  assert.equal(hasUserFunction('const step = () => move(); step();'), true);
  assert.equal(hasUserFunction('move(); move(); turnRight();'), false);
  // Uncalled function MUST be rejected
  assert.equal(hasUserFunction('function unusedFunc() { move(); } move(); move();'), false);
  assert.equal(hasUserFunction('const unused = () => { move(); }; move();'), false);
  // Empty called function or empty IIFE MUST be rejected
  assert.equal(hasUserFunction('function dummy() {} dummy(); move(); move();'), false);
  assert.equal(hasUserFunction('(() => {})(); move(); move();'), false);
  // Uncalled nested function inside called outer function MUST be rejected
  const nestedUncalledCode = `
    function outer() {
      function innerUncalled() {
        move();
      }
    }
    outer();
    move(); move();
  `;
  assert.equal(hasUserFunction(nestedUncalledCode), false);
});

test('codeValidator correctly detects loops for Level 5', () => {
  assert.equal(hasLoop('for (const cmd of route) { move(); }'), true);
  assert.equal(hasLoop('for (let i = 0; i < route.length; i++) { move(); }'), true);
  assert.equal(hasLoop('while (canMove()) { move(); }'), true);
  assert.equal(hasLoop('route.forEach(cmd => move());'), true);
  assert.equal(hasLoop('route.map(cmd => move());'), true);
  assert.equal(hasLoop('move(); move(); turnRight(); move();'), false);
  // Dead loop with hardcoded top-level moves MUST be rejected
  const deadLoopCode = `
    for (let i = 0; i < 0; i++) {}
    move(); move(); move(); move(); move(); move(); move(); move(); move(); move();
  `;
  assert.equal(hasLoop(deadLoopCode), false);
  // Dead loop with i < 0 condition containing move() MUST be rejected
  assert.equal(hasLoop('for (let i = 0; i < 0; i++) { move(); }'), false);
  assert.equal(hasLoop('while (false) { move(); }'), false);
  assert.equal(hasLoop('for (const x of []) { move(); }'), false);
  // Fake loop with if (false) move() and moves in a helper function MUST be rejected
  const fakeLoopWithHelper = `
    for (let i = 0; i < 5; i++) {
      if (false) move();
    }
    function solve() {
      move(); move(); move(); move(); move(); move(); move(); move();
    }
    solve();
  `;
  assert.equal(hasLoop(fakeLoopWithHelper), false);
});

test('Actual Worker executes forEach and map loops with loopIterations and loopRobotActions', () => {
  const code = `
    const route = [1, 2, 3, 4, 5];
    route.forEach(() => {
      move();
    });
  `;
  const result = runInActualWorker({
    code,
    config: {
      gridMap: [
        ['path', 'path', 'path', 'path', 'path', 'path', 'goal'],
        ['wall', 'wall', 'wall', 'wall', 'wall', 'wall', 'wall'],
      ],
      initialPos: { x: 0, y: 0, dir: 'right' },
      mode: 'basic',
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.finalPos.x, 5);
  assert.equal(result.steps, 5);
  assert.ok(result.loopIterations >= 5, `Expected loopIterations >= 5, got ${result.loopIterations}`);
  assert.ok(result.loopRobotActions >= 5, `Expected loopRobotActions >= 5, got ${result.loopRobotActions}`);
});

test('Actual Worker accurately tracks userFunctionRobotActions for Level 4', () => {
  // Valid helper function
  const validFn = `
    function step() {
      move();
    }
    step();
    step();
  `;
  const validResult = runInActualWorker({
    code: validFn,
    config: {
      gridMap: [['path', 'path', 'path', 'goal']],
      initialPos: { x: 0, y: 0, dir: 'right' },
    },
  });
  assert.equal(validResult.ok, true);
  assert.equal(validResult.userFunctionRobotActions, 2);

  // Uncalled dummy function with top-level moves -> userFunctionRobotActions must be 0!
  const cheatFn = `
    function dummy() {
      move();
    }
    move();
    move();
  `;
  const cheatResult = runInActualWorker({
    code: cheatFn,
    config: {
      gridMap: [['path', 'path', 'path', 'goal']],
      initialPos: { x: 0, y: 0, dir: 'right' },
    },
  });
  assert.equal(cheatResult.ok, true);
  assert.equal(cheatResult.userFunctionRobotActions, 0);

  // Arrow callback helper
  const callbackCode = `
    const actions = [() => move(), () => move()];
    actions.forEach(fn => fn());
  `;
  const callbackResult = runInActualWorker({
    code: callbackCode,
    config: {
      gridMap: [['path', 'path', 'path', 'goal']],
      initialPos: { x: 0, y: 0, dir: 'right' },
    },
  });
  assert.equal(callbackResult.ok, true);
  assert.equal(callbackResult.userFunctionRobotActions, 2);

  // Expression sequence (noop(), move()) -> move is at top level, not in function!
  const exprSeqCode = `
    function noop() {}
    (noop(), move());
  `;
  const exprSeqResult = runInActualWorker({
    code: exprSeqCode,
    config: {
      gridMap: [['path', 'path', 'goal']],
      initialPos: { x: 0, y: 0, dir: 'right' },
    },
  });
  assert.equal(exprSeqResult.ok, true);
  assert.equal(exprSeqResult.userFunctionRobotActions, 0, '(noop(), move()) must NOT count move() as inside user function');

  // Unreachable move inside called function: function fake() { if (false) move(); } fake(); move();
  const unreachableFnCode = `
    function fake() {
      if (false) move();
    }
    fake();
    move();
  `;
  const unreachableResult = runInActualWorker({
    code: unreachableFnCode,
    config: {
      gridMap: [['path', 'path', 'goal']],
      initialPos: { x: 0, y: 0, dir: 'right' },
    },
  });
  assert.equal(unreachableResult.ok, true);
  assert.equal(unreachableResult.userFunctionRobotActions, 0, 'Unreachable move inside fake function must give 0');
});

test('Actual Worker correctly distinguishes empty loops from loops with robot actions', () => {
  const emptyLoopCode = `
    for (let i = 0; i < 5; i++) {}
    move();
    move();
  `;
  const emptyLoopResult = runInActualWorker({
    code: emptyLoopCode,
    config: {
      gridMap: [['path', 'path', 'path', 'goal']],
      initialPos: { x: 0, y: 0, dir: 'right' },
    },
  });
  assert.equal(emptyLoopResult.ok, true);
  assert.equal(emptyLoopResult.loopRobotActions, 0, 'Top level moves after empty loop must have loopRobotActions = 0');

  const validLoopCode = `
    for (let i = 0; i < 5; i++) {
      move();
    }
  `;
  const validLoopResult = runInActualWorker({
    code: validLoopCode,
    config: {
      gridMap: [['path', 'path', 'path', 'path', 'path', 'goal']],
      initialPos: { x: 0, y: 0, dir: 'right' },
    },
  });
  assert.equal(validLoopResult.ok, true);
  assert.equal(validLoopResult.loopRobotActions, 5);
});

test('sandboxRunner caps long playback traces to prevent UI blocking', () => {
  const longPath = Array.from({ length: 500 }, (_, i) => ({ x: i, y: 0, dir: 'right' }));
  const longEvents = Array.from({ length: 500 }, () => ({ type: 'robot', action: 'move' }));

  const fakeResult = {
    ok: true,
    path: longPath,
    events: longEvents,
    finalPos: { x: 499, y: 0, dir: 'right' },
    steps: 500,
  };

  const cappedPath = getSandboxPlaybackPath(fakeResult);
  const cappedEvents = getSandboxPlaybackEvents(fakeResult);

  assert.ok(cappedPath.length <= 150, `Path should be capped to <= 150, got ${cappedPath.length}`);
  assert.ok(cappedEvents.length <= 150, `Events should be capped to <= 150, got ${cappedEvents.length}`);
  assert.equal(cappedPath[cappedPath.length - 1].x, 499, 'Last position in capped path must match destination');
});

test('getSandboxPlaybackPath and Events cap long failure runs while preserving the final failure step', () => {
  const failPath = [];
  const failEvents = [];
  for (let i = 0; i < 200; i++) {
    const isLast = i === 199;
    failPath.push({ x: i, y: 0, dir: 'right', blocked: isLast });
    failEvents.push({ type: 'robot', action: isLast ? 'blocked' : 'move', pos: { x: i, y: 0, dir: 'right' }, step: i + 1 });
  }

  const failResult = {
    ok: false,
    errorCode: 'RUNTIME_ERROR',
    error: 'Blocked by wall',
    path: failPath,
    events: failEvents,
    finalPos: { x: 199, y: 0, dir: 'right', blocked: true },
    steps: 200,
  };

  const cappedFailPath = getSandboxPlaybackPath(failResult);
  const cappedFailEvents = getSandboxPlaybackEvents(failResult);

  assert.ok(cappedFailPath.length <= 100, `Failure path should be capped to <= 100, got ${cappedFailPath.length}`);
  assert.ok(cappedFailEvents.length <= 100, `Failure events should be capped to <= 100, got ${cappedFailEvents.length}`);
  assert.equal(cappedFailPath[cappedFailPath.length - 1].x, 199, 'Last position in capped failure path must match final failure step');
  assert.equal(cappedFailPath[cappedFailPath.length - 1].blocked, true, 'Last position must preserve failure state');
  assert.equal(cappedFailEvents[cappedFailEvents.length - 1].action, 'blocked', 'Last event must be the failure action');
});

test('Actual Worker isolates arguments array so user code cannot forge hooks or inspect parameters via arguments', () => {
  const probeCode = `
    // Attempting to inspect or invoke hooks via arguments
    if (typeof arguments !== 'undefined' && arguments[10]) {
      arguments[10]();
    }
    if (typeof arguments !== 'undefined' && arguments[12]) {
      arguments[12]();
    }
    move();
  `;

  const result = runInActualWorker({
    code: probeCode,
    config: {
      gridMap: [['path', 'path', 'goal']],
      initialPos: { x: 0, y: 0, dir: 'right' },
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.userFunctionRobotActions, 0, 'Must not register userFunctionRobotActions from forged arguments call');
  assert.equal(result.loopRobotActions, 0, 'Must not register loopRobotActions from forged arguments call');
  assert.equal(result.steps, 1);
});

test('Actual Worker instruments route.forEach(execute) with loop and function hooks', () => {
  const code = `
    const route = ['move', 'turnRight', 'move'];
    function execute(cmd) {
      if (cmd === 'move') move();
      else if (cmd === 'turnRight') turnRight();
    }
    route.forEach(execute);
  `;

  const result = runInActualWorker({
    code,
    config: {
      gridMap: [
        ['path', 'path', 'wall'],
        ['wall', 'goal', 'wall'],
      ],
      initialPos: { x: 0, y: 0, dir: 'right' },
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.loopIterations, 3, 'forEach must trigger 3 loop iterations');
  assert.equal(result.loopRobotActions, 3, 'All 3 robot actions must count as loop robot actions');
  assert.equal(result.userFunctionRobotActions, 3, 'All 3 robot actions must count as user function robot actions');
  assert.equal(result.steps, 3);
  assert.equal(result.finalPos.x, 1);
  assert.equal(result.finalPos.y, 1);
});

test('Actual Worker virtual DOM correctly executes classList.add, classList.remove, and classList.toggle without errors', () => {
  const code = `
    const platform = dom.getElementById('platform');
    platform.classList.add('active');
    platform.classList.remove('active');
    platform.classList.toggle('active');

    const terminal = dom.getElementById('terminal');
    terminal.textContent = 'UNLOCKED';

    const btn = dom.querySelector('.door-button');
    btn.click();
  `;

  const result = runInActualWorker({
    code,
    config: {
      mode: 'dom',
      gridMap: [['robot', 'terminal', 'door', 'path', 'goal']],
      initialPos: { x: 0, y: 0, dir: 'right' },
    },
  });

  assert.equal(result.ok, true, `Worker must not fail on DOM methods: ${result.error}`);
  assert.equal(result.domState.platformActive, true, 'Platform must remain active after toggle');
  assert.equal(result.domState.terminalUnlocked, true, 'Terminal must be unlocked');
  assert.equal(result.domState.doorOpen, true, 'Door must be opened');
  assert.equal(result.domState.buttonClicked, true, 'Button must be clicked');
});

test('Actual Worker instruments repeat(count, namedAction) with loop and user function hooks', () => {
  const code = `
    function step() {
      move();
    }
    repeat(3, step);
  `;

  const result = runInActualWorker({
    code,
    config: {
      gridMap: [['path', 'path', 'path', 'goal']],
      initialPos: { x: 0, y: 0, dir: 'right' },
    },
  });

  assert.equal(result.ok, true, `Execution must succeed: ${result.error}`);
  assert.equal(result.loopIterations, 3, 'repeat must record 3 loop iterations');
  assert.equal(result.loopRobotActions, 3, 'repeat must count robot actions inside loop');
  assert.equal(result.userFunctionRobotActions, 3, 'step function must count user function actions');
  assert.equal(result.steps, 3);
  assert.equal(result.finalPos.x, 3);
});

test('Actual Worker counts loop actions for loops over data and for plain counted loops', () => {
  // 1. Decorative loop test: 4 turnRights inside loop, then moves outside loop
  const decorativeCode = `
    for (let i = 0; i < 4; i++) {
      turnRight();
    }
    move();
    move();
  `;
  const decorativeResult = runInActualWorker({
    code: decorativeCode,
    config: {
      route: ['move', 'move'],
      gridMap: [['path', 'path', 'goal']],
      initialPos: { x: 0, y: 0, dir: 'right' },
    },
  });
  assert.equal(decorativeResult.ok, true);
  assert.equal(decorativeResult.loopRobotActions, 4, 'Decorative loop records general loop actions');

  // 2. Real route loop test: for (const cmd of route)
  const routeCode = `
    const route = ['move', 'move'];
    for (const cmd of route) {
      if (cmd === 'move') move();
    }
  `;
  const routeResult = runInActualWorker({
    code: routeCode,
    config: {
      route: ['move', 'move'],
      gridMap: [['path', 'path', 'goal']],
      initialPos: { x: 0, y: 0, dir: 'right' },
    },
  });
  assert.equal(routeResult.ok, true, routeResult.error);
  assert.equal(routeResult.loopIterations, 2, 'Route loop records 2 iterations');
  assert.equal(routeResult.loopActions, 2, 'Route loop records 2 robot actions');
  assert.equal(routeResult.steps, 2);

  // 3. Callback factory route loop test: route.forEach(make())
  const factoryCode = `
    const route = ['move', 'move'];
    let factoryCalls = 0;
    function make() {
      factoryCalls++;
      return function(cmd) {
        if (cmd === 'move') move();
      };
    }
    route.forEach(make());
  `;
  const factoryResult = runInActualWorker({
    code: factoryCode,
    config: {
      route: ['move', 'move'],
      gridMap: [['path', 'path', 'goal']],
      initialPos: { x: 0, y: 0, dir: 'right' },
    },
  });
  assert.equal(factoryResult.ok, true);
  assert.equal(factoryResult.loopIterations, 2);
  assert.equal(factoryResult.loopActions, 2);
});

test('Actual Worker executes runRoute(route) and records loopActions correctly', () => {
  const code = `
    const route = ['move', 'move'];
    function runRoute(commands) {
      for (const cmd of commands) {
        if (cmd === 'move') move();
      }
    }
    runRoute(route);
  `;
  const result = runInActualWorker({
    code,
    config: {
      route: ['move', 'move'],
      gridMap: [['path', 'path', 'goal']],
      initialPos: { x: 0, y: 0, dir: 'right' },
    },
  });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.loopIterations, 2);
  assert.equal(result.loopActions, 2);
  assert.equal(result.steps, 2);
});

test('Actual Worker executes route.forEach(robot.step, robot) preserving thisArg and single evaluation', () => {
  const code = `
    const route = ['move', 'move'];
    let reads = 0;
    const robot = {
      tag: 'my-bot',
      get step() {
        reads++;
        return function(cmd) {
          if (this.tag !== 'my-bot') throw new Error('context lost!');
          if (cmd === 'move') move();
        };
      }
    };
    route.forEach(robot.step, robot);
  `;
  const result = runInActualWorker({
    code,
    config: {
      route: ['move', 'move'],
      gridMap: [['path', 'path', 'goal']],
      initialPos: { x: 0, y: 0, dir: 'right' },
    },
  });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.loopIterations, 2);
  assert.equal(result.loopActions, 2);
  assert.equal(result.steps, 2);
});

test('Actual Worker executes factory returning named function execute in route.forEach(make())', () => {
  const code = `
    const route = ['move', 'move'];
    function execute(cmd) {
      if (cmd === 'move') move();
    }
    function make() {
      return execute;
    }
    route.forEach(make());
  `;
  const result = runInActualWorker({
    code,
    config: {
      route: ['move', 'move'],
      gridMap: [['path', 'path', 'goal']],
      initialPos: { x: 0, y: 0, dir: 'right' },
    },
  });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.loopIterations, 2);
  assert.equal(result.loopActions, 2);
  assert.equal(result.steps, 2);
});

test('Actual Worker executes concise arrow factory const make = () => execute in route.forEach(make())', () => {
  const code = `
    const route = ['move', 'move'];
    const execute = (cmd) => {
      if (cmd === 'move') move();
    };
    const make = () => execute;
    route.forEach(make());
  `;
  const result = runInActualWorker({
    code,
    config: {
      route: ['move', 'move'],
      gridMap: [['path', 'path', 'goal']],
      initialPos: { x: 0, y: 0, dir: 'right' },
    },
  });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.loopIterations, 2);
  assert.equal(result.loopActions, 2);
  assert.equal(result.steps, 2);
});

test('Actual Worker executes route loop inside function assigned after declaration', () => {
  const code = `
    const route = ['move', 'move'];
    let runRoute;
    runRoute = function(commands) {
      commands.forEach(cmd => {
        if (cmd === 'move') move();
      });
    };
    runRoute(route);
  `;
  const result = runInActualWorker({
    code,
    config: {
      route: ['move', 'move'],
      gridMap: [['path', 'path', 'goal']],
      initialPos: { x: 0, y: 0, dir: 'right' },
    },
  });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.loopIterations, 2);
  assert.equal(result.loopActions, 2);
  assert.equal(result.steps, 2);
});
test('Actual Worker virtual DOM unlocks terminal via either textContent or innerText', () => {
  const code = `
    const t = dom.getElementById('terminal');
    t.innerText = 'UNLOCKED';
  `;
  const result = runInActualWorker({
    code,
    config: {
      mode: 'dom',
      gridMap: [['robot', 'terminal', 'door', 'path', 'goal']],
      initialPos: { x: 0, y: 0, dir: 'right' },
    },
  });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.domState.terminalUnlocked, true, 'Setting innerText to UNLOCKED must unlock terminal');
});

test('Actual Worker tracks userFunctionRobotActions for concise arrow function const go = () => move()', () => {
  const code = `
    const go = () => move();
    go();
    go();
  `;
  const result = runInActualWorker({
    code,
    config: {
      gridMap: [['path', 'path', 'path', 'goal']],
      initialPos: { x: 0, y: 0, dir: 'right' },
    },
  });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.userFunctionRobotActions, 2, 'Concise arrow function must track userFunctionRobotActions');
});

test('Actual Worker executes actions[cmd]() in route loop', () => {
  const code = `
    const route = ['move', 'turnRight', 'move'];
    const actions = {
      'move': move,
      'turnRight': turnRight,
    };
    function execute(cmd) {
      actions[cmd]();
    }
    const handler = execute;
    route.forEach(handler);
  `;
  const result = runInActualWorker({
    code,
    config: {
      gridMap: [
        ['path', 'path'],
        ['wall', 'goal'],
      ],
      initialPos: { x: 0, y: 0, dir: 'right' },
    },
  });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.loopIterations, 3);
  assert.equal(result.loopActions, 3);
  assert.equal(result.steps, 3);
});


test('instrumenter rejects async/await with the editor line number', () => {
  assert.throws(
    () => instrumentCode('move();\n\nasync function go() {\n  await 1;\n  move();\n}\ngo();', '__trace__'),
    /async\/await.*рядок 3/,
  );
  assert.throws(() => instrumentCode('move();\nconst go = async () => move();', '__trace__'), /рядок 2/);
  assert.throws(() => instrumentCode('async function go() {\n  for await (const x of []) move();\n}', '__trace__'), /async\/await/);
});

test('Actual Worker reports Promise and timers as errors instead of silently dropping moves', () => {
  for (const code of [
    'Promise.resolve().then(() => move());',
    'new Promise((resolve) => resolve()).then(() => move());',
    'setTimeout(() => move(), 0);',
    'setInterval(() => move(), 10);',
    'queueMicrotask(() => move());',
  ]) {
    const result = runInActualWorker({ code });
    assert.equal(result.ok, false, `${code} must fail`);
    assert.match(result.error, /асинхронний код не підтримується/, code);
  }
});

test('line numbers are not shifted by trimming leading blank lines', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'utils', 'sandboxRunner.ts'), 'utf8');
  assert.doesNotMatch(source, /request\.code\.trim\(\)/);
});

test('level 7 treats leaving the board as an error like the other stepped levels', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'app', 'Levels', 'level7', 'page.tsx'), 'utf8');
  assert.match(source, /throwOnOutOfBounds:\s*true/);
});

test('every level records the already decided verdict on reset or page leave', () => {
  for (let level = 1; level <= 7; level += 1) {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'app', 'Levels', `level${level}`, 'page.tsx'),
      'utf8',
    );
    const fallbacks = source.match(/pendingVerdictRef\.current \?\? \{ outcome: 'defeat' \}/g) || [];
    assert.equal(fallbacks.length, 2, `level ${level}: reset and leave must both use pendingVerdictRef`);
    assert.match(source, /finishAttemptSync\(\{ token: activeToken, outcome: verdict\.outcome, points: verdict\.points \}\)/, `level ${level}`);
    assert.match(source, /verdict\.outcome === 'victory'/, `level ${level}: resetLevel must check for victory verdict`);
    assert.match(source, /setIsVictory\(true\)/, `level ${level}: resetLevel must show victory modal on winning reset`);
  }
});

test('Actual Worker: reassigning Boolean does not forge key, door, or domState results', () => {
  const attackCode = `
    Boolean = () => true;
    move();
  `;
  const result = runInActualWorker({
    code: attackCode,
    config: {
      gridMap: [['path', 'path', 'goal']],
      initialPos: { x: 0, y: 0, dir: 'right' },
      mode: 'dom',
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.hasKey, false, 'hasKey must remain false');
  assert.equal(result.doorOpened, false, 'doorOpened must remain false');
  assert.equal(result.isDead, false, 'isDead must remain false');
  assert.equal(result.domState.terminalUnlocked, false, 'terminalUnlocked must remain false');
  assert.equal(result.domState.doorOpen, false, 'doorOpen must remain false');
  assert.equal(result.domState.buttonClicked, false, 'buttonClicked must remain false');
  assert.equal(result.domState.platformActive, false, 'platformActive must remain false');
});

test('Actual Worker: overriding Set.prototype[Symbol.iterator] does not forge collectedKeys', () => {
  const attackCode = `
    Set.prototype[Symbol.iterator] = function* () {
      yield 'fake-key-1';
      yield 'fake-key-2';
      yield 'fake-key-3';
    };
    move();
  `;
  const result = runInActualWorker({
    code: attackCode,
    config: {
      gridMap: [['path', 'path', 'goal']],
      initialPos: { x: 0, y: 0, dir: 'right' },
      mode: 'multi-key',
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.collectedKeys.length, 0, 'collectedKeys must remain empty when no actual keys were picked');
});

test('Actual Worker: try/catch cannot suppress enemy death or continue execution', () => {
  const attackCode = `
    function safeMove() {
      try { move(); } catch (e) {}
    }
    safeMove(); // moves onto enemy at (1, 0)
    safeMove(); // attempts to continue
  `;
  const result = runInActualWorker({
    code: attackCode,
    config: {
      gridMap: [['path', 'enemy', 'goal']],
      initialPos: { x: 0, y: 0, dir: 'right' },
      mode: 'key-door',
    },
  });
  assert.equal(result.ok, false, 'Attempt must fail after robot is killed');
  assert.equal(result.errorCode, 'KILLED');
  assert.equal(result.isDead, true);
});

test('Actual Worker: try/catch cannot suppress out of bounds or continue execution', () => {
  const attackCode = `
    turnLeft();
    try { move(); } catch (e) {}
    turnRight();
    move();
  `;
  const result = runInActualWorker({
    code: attackCode,
    config: {
      gridMap: [['path', 'path', 'goal']],
      initialPos: { x: 0, y: 0, dir: 'right' },
      mode: 'basic',
      throwOnOutOfBounds: true,
    },
  });
  assert.equal(result.ok, false, 'Attempt must fail after out of bounds');
  assert.equal(result.errorCode, 'OUT_OF_BOUNDS');
});

test('LevelLayout logColor highlights Ukrainian error lines in red', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'components', 'LevelLayout.tsx'),
    'utf8',
  );
  assert.match(source, /line\.includes\('ВИХІД'\)/);
  assert.match(source, /line\.includes\('МЕЖІ'\)/);
  assert.match(source, /line\.includes\('СТІНА'\)/);
  assert.match(source, /line\.includes\('ЗНИЩЕНО'\)/);
});

test('Actual Worker: try/catch cannot suppress STEP_LIMIT', () => {
  const stepLimitCode = `
    for (let i = 0; i < 20; i++) {
      try { move(); } catch (e) {}
    }
  `;
  const result = runInActualWorker({
    code: stepLimitCode,
    config: {
      gridMap: [['path', 'path', 'path', 'path', 'path', 'path', 'goal']],
      initialPos: { x: 0, y: 0, dir: 'right' },
      maxSteps: 3,
    },
  });
  assert.equal(result.ok, false, 'Attempt must fail when step limit is exceeded even if caught in try/catch');
  assert.equal(result.errorCode, 'STEP_LIMIT');
});

test('Actual Worker: try/catch cannot suppress OPERATION_LIMIT', () => {
  const opLimitCode = `
    for (let i = 0; i < 50; i++) {
      try {
        while (true) {}
      } catch (e) {}
    }
  `;
  const result = runInActualWorker({
    code: opLimitCode,
    config: {
      gridMap: [['path', 'path', 'goal']],
      initialPos: { x: 0, y: 0, dir: 'right' },
      maxOperations: 15,
    },
  });
  assert.equal(result.ok, false, 'Attempt must fail when operation limit is exceeded even if caught in try/catch');
  assert.equal(result.errorCode, 'OPERATION_LIMIT');
});

test('Actual Worker: a learner error thrown after a death does not replace the death as the reason', () => {
  for (const code of [
    'try { move(); } catch (e) { throw new Error("oops"); }',
    'try { move(); } catch (e) {}\nnull.x;',
    'try { move(); } catch (e) { e.runnerCode = "OK"; }',
  ]) {
    const result = runInActualWorker({
      code,
      config: { gridMap: [['path', 'enemy', 'goal']], mode: 'key-door' },
    });
    assert.equal(result.ok, false, code);
    assert.equal(result.errorCode, 'KILLED', code);
    assert.equal(result.error, 'Робота знищив ворог.', code);
  }
});

test('Actual Worker: learner code cannot pick its own error code', () => {
  const result = runInActualWorker({ code: 'throw { runnerCode: "OK", message: "fake" };' });
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'RUNTIME_ERROR');
  assert.equal(result.error, 'fake');
});

test('level 7 log highlights its Ukrainian blocked / out-of-bounds lines in red', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'app', 'Levels', 'level7', 'page.tsx'), 'utf8');
  assert.match(source, /line\.includes\('ЗАБЛОКОВАНО'\)/);
  assert.match(source, /line\.includes\('ВИХІД ЗА МЕЖІ'\)/);
});

test('Actual Worker marks the picked-up key in the replay path so levels can hide it', () => {
  const result = runInActualWorker({
    code: 'move(); move();',
    config: { gridMap: [['path', 'key', 'goal']], mode: 'multi-key' },
  });
  assert.equal(result.ok, true, result.error);
  assert.deepEqual([...result.collectedKeys], ['1,0']);
  assert.deepEqual(Array.from(result.path, p => Boolean(p.keyPicked)), [false, true, false]);
  assert.equal(getSandboxPlaybackPath(result).filter(p => p.keyPicked).length, 1);
});

test('key levels show the sandbox result, not the shortened replay, once the animation ends', () => {
  for (const level of [3, 5, 6]) {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'app', 'Levels', `level${level}`, 'page.tsx'),
      'utf8',
    );
    assert.doesNotMatch(source, /animIndex >= 0/, `level ${level}`);
    assert.match(source, /isAnimating\s*\n?\s*\?/, `level ${level}`);
  }
});

test('Actual Worker counts a route loop over an alias made inside a nested function', () => {
  const result = runInActualWorker({
    code: `const route = ['move', 'move'];
function run() {
  const r = route;
  const inner = () => { const r2 = r; for (const c of r2) move(); };
  inner();
}
run();`,
  });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.loopIterations, 2);
  assert.equal(result.loopActions, 2);
});

test('winning reset uses the real final position instead of hard-coded goal coordinates', () => {
  for (let level = 1; level <= 7; level += 1) {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'app', 'Levels', `level${level}`, 'page.tsx'),
      'utf8',
    );
    assert.doesNotMatch(source, /finalPos \?\? \{/, `level ${level}`);
  }
});

test('P2: Issue 4 - Actual Worker supports route["forEach"] bracket notation with route tracking', () => {
  const code = `
    const route = ['move', 'move'];
    function execute(cmd) {
      if (cmd === 'move') move();
    }
    route['forEach'](execute);
  `;
  const result = runInActualWorker({
    code,
    config: {
      gridMap: [['path', 'path', 'goal']],
      initialPos: { x: 0, y: 0, dir: 'right' },
    },
  });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.loopIterations, 2);
  assert.equal(result.loopActions, 2);
  assert.equal(result.steps, 2);
});

test('P2: Issue 5 - Actual Worker routes commands when function is invoked through alias const go = run', () => {
  const code = `
    const route = ['move', 'move'];
    function run(commands) {
      for (const cmd of commands) {
        if (cmd === 'move') move();
      }
    }
    const go = run;
    go(route);
  `;
  const result = runInActualWorker({
    code,
    config: {
      gridMap: [['path', 'path', 'goal']],
      initialPos: { x: 0, y: 0, dir: 'right' },
    },
  });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.loopIterations, 2);
  assert.equal(result.loopActions, 2);
  assert.equal(result.steps, 2);
});

test('P2: Issue 9 - Actual Worker Level 7 classList.add and remove support multiple arguments', () => {
  const code = `
    const platform = dom.getElementById('platform');
    platform.classList.add('ready', 'active');
    if (!platform.classList.contains('ready')) throw new Error('missing ready');
    if (!platform.classList.contains('active')) throw new Error('missing active');
    platform.classList.remove('ready', 'other');
    if (platform.classList.contains('ready')) throw new Error('ready not removed');
    if (!platform.classList.contains('active')) throw new Error('active should remain');
  `;
  const result = runInActualWorker({
    code,
    config: {
      mode: 'dom',
      gridMap: [['path', 'goal']],
      initialPos: { x: 0, y: 0, dir: 'right' },
    },
  });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.domState.platformActive, true, 'Platform must be active when "active" is among added classes');
});

test('P2: Issue 10 - Actual Worker Level 7 querySelector dynamically matches dynamically added and removed classes', () => {
  const code = `
    const button = dom.querySelector('.door-button');
    if (!button) throw new Error('initial button must be found');
    button.classList.add('trigger');
    const triggerBtn = dom.querySelector('.trigger');
    if (!triggerBtn) throw new Error('.trigger button must be found after adding class');
    triggerBtn.click();
    if (!dom.querySelector('.door-button')) throw new Error('door-button still matches');
    button.classList.remove('door-button');
    if (dom.querySelector('.door-button') !== null) throw new Error('removed class should not match');
    if (dom.querySelectorAll('.trigger').length !== 1) throw new Error('querySelectorAll length mismatch');
  `;
  const result = runInActualWorker({
    code,
    config: {
      mode: 'dom',
      gridMap: [['path', 'goal']],
      initialPos: { x: 0, y: 0, dir: 'right' },
    },
  });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.domState.doorOpen, true, 'Door button click via .trigger must open door');
});

test('R9 & R10: Door classList syncs with state, repeat click reopens door, and [class*="..."] matches substring', () => {
  const code = `
    const door = dom.querySelector('#door');
    const button = dom.querySelector('[class*="oor-but"]');
    if (!button) throw new Error('substring selector [class*="oor-but"] should match door-button');
    if (!door.classList.contains('closed')) throw new Error('door should initially have closed class');
    
    button.click();
    if (!door.classList.contains('open')) throw new Error('door should have open class after button click');
    if (door.classList.contains('closed')) throw new Error('door should not have closed class after opening');
    
    // Close the door manually
    door.classList.remove('open');
    if (!door.classList.contains('closed')) throw new Error('door should have closed class after removing open');
    
    // Repeat button click should reopen the closed door
    button.click();
    if (!door.classList.contains('open')) throw new Error('door should have open class after second button click');
  `;
  const result = runInActualWorker({
    code,
    config: {
      mode: 'dom',
      gridMap: [['path', 'goal']],
      initialPos: { x: 0, y: 0, dir: 'right' },
    },
  });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.domState.doorOpen, true, 'Door should be open after second click');
});

test('repeat() does not emit artificial line 1 trace events', () => {
  const code = `// line 1 comment
// line 2 comment
repeat(3, () => {
  move();
});`;
  const result = runInActualWorker({
    code,
    config: {
      gridMap: [['path', 'path', 'path', 'path', 'goal']],
      initialPos: { x: 0, y: 0, dir: 'right' },
    },
  });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.steps, 3);
  const line1Events = result.events.filter(e => e.type === 'line' && e.line === 1);
  assert.equal(line1Events.length, 0, 'repeat should not emit line 1 trace events');
});

test('Level 5: Actual Worker tracks loopActions for while and for queue/stack loops using route.shift() and route.pop()', () => {
  const route = ['move', 'move', 'move'];

  // 1. while (route.length > 0) with route.shift()
  const codeWhileLen = `
    const route = ['move', 'move', 'move'];
    while (route.length > 0) {
      const c = route.shift();
      if (c === 'move') move();
    }
  `;
  const res1 = runInActualWorker({
    code: codeWhileLen,
    config: {
      route: [...route],
      gridMap: [['path', 'path', 'path', 'path', 'goal']],
      initialPos: { x: 0, y: 0, dir: 'right' },
    },
  });
  assert.equal(res1.ok, true, res1.error);
  assert.equal(res1.loopActions, 3, 'while (route.length > 0) must count loop actions');
  assert.ok(res1.loopIterations >= 1, 'must count route loop iterations');

  // 2. while ((c = route.shift()))
  const codeWhileAssign = `
    const route = ['move', 'move', 'move'];
    let c;
    while ((c = route.shift())) {
      if (c === 'move') move();
    }
  `;
  const res2 = runInActualWorker({
    code: codeWhileAssign,
    config: {
      route: [...route],
      gridMap: [['path', 'path', 'path', 'path', 'goal']],
      initialPos: { x: 0, y: 0, dir: 'right' },
    },
  });
  assert.equal(res2.ok, true, res2.error);
  assert.equal(res2.loopActions, 3, 'while ((c = route.shift())) must count loop actions');

  // 3. for (let c = route.shift(); c; c = route.shift())
  const codeForShift = `
    const route = ['move', 'move', 'move'];
    for (let c = route.shift(); c; c = route.shift()) {
      if (c === 'move') move();
    }
  `;
  const res3 = runInActualWorker({
    code: codeForShift,
    config: {
      route: [...route],
      gridMap: [['path', 'path', 'path', 'path', 'goal']],
      initialPos: { x: 0, y: 0, dir: 'right' },
    },
  });
  assert.equal(res3.ok, true, res3.error);
  assert.equal(res3.loopActions, 3, 'for (... route.shift() ...) must count loop actions');

  // 4. while (route.length > 0) with route.pop()
  const codeWhilePop = `
    const route = ['move', 'move', 'move'];
    while (route.length > 0) {
      const c = route.pop();
      if (c === 'move') move();
    }
  `;
  const res4 = runInActualWorker({
    code: codeWhilePop,
    config: {
      route: [...route],
      gridMap: [['path', 'path', 'path', 'path', 'goal']],
      initialPos: { x: 0, y: 0, dir: 'right' },
    },
  });
  assert.equal(res4.ok, true, res4.error);
  assert.equal(res4.loopActions, 3, 'while with route.pop() must count loop actions');
});

test('Level 4: Actual Worker tracks userFunctionRobotActions for concise arrow function with map', () => {
  const code = `
    const go = (n) => [...Array(n)].map(() => move());
    go(3);
  `;
  const result = runInActualWorker({
    code,
    config: {
      gridMap: [['path', 'path', 'path', 'path', 'goal']],
      initialPos: { x: 0, y: 0, dir: 'right' },
    },
  });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.steps, 3);
  assert.equal(result.userFunctionRobotActions, 3, 'Concise arrow function with .map(() => move()) must count user function actions');
});

test('R2: Migration of legacy 350 scores properly allocates scoresByLevel and allows score improvement on replay', () => {
  const { normalizeSavedState, gameReducer } = loadTsModule(path.join('app', 'context', 'GameContext.tsx'));
  const legacySave = {
    lives: 3,
    score: 350,
    completedLevels: [1, 2],
    attemptsByLevel: { 1: 1, 2: 2 },
    resetAt: 1000,
  };
  const normalized = normalizeSavedState(legacySave).saved;
  assert.equal(normalized.score, 350);
  assert.deepEqual(normalized.completedLevels, [1, 2]);
  // Level 1 had one attempt, so it was a first-try win (+25); 350 then splits only as 125 + 225.
  assert.equal(normalized.scoresByLevel[1], 125);
  assert.equal(normalized.scoresByLevel[2], 225);

  // Replaying level 1 (attempt 2, no first-try bonus) with the efficiency bonus scores 150 (+25)
  const updated = gameReducer(
    { ...normalized, storageKey: 'test-key', hydrated: true, revision: 0, persistedRevision: 0, isReset: false },
    { type: 'finishAttempt', storageKey: 'test-key', resetAt: 1000, level: 1, attemptId: 'att-1-150', outcome: 'victory', points: 150 }
  );
  assert.equal(updated.scoresByLevel[1], 150);
  assert.equal(updated.score, 375);
});

test('R4: Actual Worker tracks loopActions for computed iteration method route[m](...) and template literal', () => {
  const code = "const route = ['move', 'move']; const m = 'forEach'; route[m](cmd => move());";
  const result = runInActualWorker({
    code,
    config: {
      route: ['move', 'move'],
      gridMap: [['path', 'path', 'path', 'goal']],
      initialPos: { x: 0, y: 0, dir: 'right' },
    },
  });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.loopActions, 2);

  const codeTemplate = "const route = ['move', 'move']; const m = 'Each'; route[`for${m}`](cmd => move());";
  const resultTemplate = runInActualWorker({
    code: codeTemplate,
    config: {
      route: ['move', 'move'],
      gridMap: [['path', 'path', 'path', 'goal']],
      initialPos: { x: 0, y: 0, dir: 'right' },
    },
  });
  assert.equal(resultTemplate.ok, true, resultTemplate.error);
  assert.equal(resultTemplate.loopActions, 2);
});

test('R5: Actual Worker tracks loopActions via default param, fn return, bind/call/apply', () => {
  // default param
  const res1 = runInActualWorker({
    code: "const route = ['move', 'move']; function run(r = route) { for (const c of r) move(); } run();",
    config: {
      route: ['move', 'move'],
      gridMap: [['path', 'path', 'path', 'goal']],
      initialPos: { x: 0, y: 0, dir: 'right' },
    },
  });
  assert.equal(res1.ok, true, res1.error);
  assert.equal(res1.loopActions, 2);

  // function returning route
  const res2 = runInActualWorker({
    code: "const route = ['move', 'move']; function getRoute() { return route; } for (const c of getRoute()) move();",
    config: {
      route: ['move', 'move'],
      gridMap: [['path', 'path', 'path', 'goal']],
      initialPos: { x: 0, y: 0, dir: 'right' },
    },
  });
  assert.equal(res2.ok, true, res2.error);
  assert.equal(res2.loopActions, 2);

  // call
  const res3 = runInActualWorker({
    code: "const route = ['move', 'move']; function iter(r) { for (const c of r) move(); } iter.call(null, route);",
    config: {
      route: ['move', 'move'],
      gridMap: [['path', 'path', 'path', 'goal']],
      initialPos: { x: 0, y: 0, dir: 'right' },
    },
  });
  assert.equal(res3.ok, true, res3.error);
  assert.equal(res3.loopActions, 2);

  // apply
  const res4 = runInActualWorker({
    code: "const route = ['move', 'move']; function iter(r) { for (const c of r) move(); } iter.apply(null, [route]);",
    config: {
      route: ['move', 'move'],
      gridMap: [['path', 'path', 'path', 'goal']],
      initialPos: { x: 0, y: 0, dir: 'right' },
    },
  });
  assert.equal(res4.ok, true, res4.error);
  assert.equal(res4.loopActions, 2);

  // bind
  const res5 = runInActualWorker({
    code: "const route = ['move', 'move']; const iter = function(r) { for (const c of r) move(); }.bind(null, route); iter();",
    config: {
      route: ['move', 'move'],
      gridMap: [['path', 'path', 'path', 'goal']],
      initialPos: { x: 0, y: 0, dir: 'right' },
    },
  });
  assert.equal(res5.ok, true, res5.error);
  assert.equal(res5.loopActions, 2);
});

test('R11: Actual Worker and sandboxRunner preserve executed steps in replay path on execution error', () => {
  const code = `
    move();
    move();
    throw new Error('Learner runtime error');
  `;
  const result = runInActualWorker({
    code,
    config: {
      gridMap: [['path', 'path', 'path', 'goal']],
      initialPos: { x: 0, y: 0, dir: 'right' },
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.steps, 2);
  const path = getSandboxPlaybackPath(result);
  assert.ok(path.length >= 3, 'Playback path must include initial position and the 2 executed moves');
  assert.equal(path[1].x, 1);
  assert.equal(path[2].x, 2);
});

test('Level 7 Virtual DOM: supports document alias, className sync with classList, door.className setter, and getAttribute', () => {
  const code = `
    const terminalEl = document.getElementById('terminal');
    terminalEl.textContent = 'UNLOCKED';

    const btn = document.querySelector('.door-button');
    if (btn.getAttribute('class') !== 'door-button') throw new Error('getAttribute class failed');
    if (btn.className !== 'door-button') throw new Error('className failed');

    btn.classList.add('custom-btn');
    if (!btn.className.includes('custom-btn')) throw new Error('classList sync failed');

    const doorEl = document.getElementById('door');
    doorEl.className = 'open';

    const platformEl = document.getElementById('platform');
    platformEl.classList.add('active');

    move();
  `;

  const result = runInActualWorker({
    code,
    config: {
      mode: 'dom',
      gridMap: [['path', 'door', 'path', 'goal']],
      initialPos: { x: 0, y: 0, dir: 'right' },
    },
  });

  assert.equal(result.ok, true, result.error);
  assert.equal(result.domState.terminalUnlocked, true);
  assert.equal(result.domState.doorOpen, true);
  assert.equal(result.domState.platformActive, true);
});






// --- Levels 5 and 6: moves must follow the commands written as data, inside a loop (runtime) ---
const { isDataDrivenLoopRun, movesInLoop, followsLevelData } = loadTsModule(path.join('utils', 'sandboxRunner.ts'));
const { routeVariant, instructionsVariant, expandInstructions, boardForCommands } = loadTsModule(path.join('utils', 'levelData.ts'));
const { LEVELS_CONFIG: LEVELS } = loadTsModule(path.join('utils', 'levelsConfig.ts'));

// --- Levels 5 and 6: the level passes its data to the code and checks it on hidden variants ---
function levelPage(n) {
  return fs.readFileSync(path.join(__dirname, '..', 'app', 'Levels', `level${n}`, 'page.tsx'), 'utf8');
}
const ROUTE5 = eval(levelPage(5).match(/const finalRoute: RobotCommand\[\] = (\[[\s\S]*?\]);/)[1]);
const INSTR6 = eval(levelPage(6).match(/const INSTRUCTIONS: Instruction\[\] = (\[[\s\S]*?\n\]);/)[1]);
const LEVEL_VARIANTS = {
  5: [{ ...boardForCommands(routeVariant(ROUTE5)), data: { route: routeVariant(ROUTE5) } }],
  6: [{ ...boardForCommands(expandInstructions(instructionsVariant(INSTR6))), data: { instructions: instructionsVariant(INSTR6) } }],
};
const LEVEL_DATA = { 5: { route: ROUTE5 }, 6: { instructions: INSTR6 } };

/** Runs code the way the level 5 / 6 page does and returns its verdict. */
function playLevel(n, code) {
  const { gridMap, initialPos } = LEVELS[n];
  const result = runInActualWorker({
    code,
    config: { gridMap, initialPos, mode: 'multi-key', throwOnOutOfBounds: true, data: LEVEL_DATA[n], variants: LEVEL_VARIANTS[n] },
  });
  const reachedGoal = result.ok && gridMap[result.finalPos.y][result.finalPos.x] === 'goal';
  const win = reachedGoal && result.collectedKeys.length === 3 && isDataDrivenLoopRun(result, LEVEL_VARIANTS[n]);
  return { result, reachedGoal, win };
}

const EXEC = `function exec(c) { if (c === 'move') move(); else if (c === 'turnRight') turnRight(); else if (c === 'turnLeft') turnLeft(); }\n`;
const HARD5 = ROUTE5.map(c => `${c}();`).join(' ');
const FLAT6 = expandInstructions(INSTR6);
const HARD6 = FLAT6.map(c => `${c}();`).join(' ');
const OPEN_GRID = { gridMap: Array.from({ length: 12 }, () => Array(12).fill('path')) };
const STEP_LOOP = 'for (const s of instructions) { for (let i = 0; i < (s.steps || 1); i++) exec(s.command); }';

test('level 5: every way of following route in a loop wins (N3-N6, N8, W2)', () => {
  const styles = {
    'for...of': 'for (const c of route) exec(c);',
    forEach: 'route.forEach(c => exec(c));',
    'forEach(exec)': 'route.forEach(exec);',
    'index loop': 'for (let i = 0; i < route.length; i++) exec(route[i]);',
    'while + shift': 'while (route.length) exec(route.shift());',
    'computed method': "const m = 'forEach';\nroute[m](c => exec(c));",
    'bind without args': 'function run(list) { for (const c of list) exec(c); }\nconst go = run.bind(null);\ngo(route);',
    'Array.prototype.forEach.call': 'Array.prototype.forEach.call(route, exec);',
    'aliased forEach': 'const each = Array.prototype.forEach;\neach.call(route, exec);',
    'batches of 5 (W2)': 'for (let i = 0; i < route.length; i += 5) { exec(route[i]); exec(route[i + 1]); exec(route[i + 2]); exec(route[i + 3]); exec(route[i + 4]); }',
    'loops over slices (W2)': 'for (const c of route.slice(0, 20)) exec(c);\nfor (const c of route.slice(20)) exec(c);',
    'shared handler called many times (W2)': 'function part(from, to) { for (let i = from; i < to; i++) exec(route[i]); }\npart(0, 10); part(10, 20); part(20, 30); part(30, route.length);',
    'enum constants': "const C = { MOVE: 'move', LEFT: 'turnLeft' };\nfor (const c of route) { if (c === C.MOVE) move(); else if (c === C.LEFT) turnLeft(); else turnRight(); }",
    'destructured constants (N5)': "const [M, L] = ['move', 'turnLeft'];\nfor (const c of route) { if (c === M) move(); else if (c === L) turnLeft(); else turnRight(); }",
    'map to functions': 'const act = { move, turnLeft, turnRight };\nroute.map(c => act[c]).forEach(f => f());',
    'indexOf dispatcher (N5)': "const names = ['move', 'turnLeft', 'turnRight'];\nconst fns = [move, turnLeft, turnRight];\nfor (const c of route) fns[names.indexOf(c)]();",
    'table of pairs': "const table = [['move', move], ['turnLeft', turnLeft], ['turnRight', turnRight]];\nfor (const c of route) { for (const [name, fn] of table) if (name === c) fn(); }",
    'JSON copy with a space (N3)': "const copy = JSON.parse(' ' + JSON.stringify(route));\nfor (const c of copy) exec(c);",
    'computed call (N4)': 'const api = { move, turnLeft, turnRight };\nfor (const c of route) api[c].call(null);',
    'sensor guard (N6)': "for (const c of route) { if (c === 'move' && !canMove()) turnRight(); else exec(c); if (hasKey()) {} }",
    'switch': "for (const c of route) { switch (c) { case 'move': move(); break; case 'turnLeft': turnLeft(); break; default: turnRight(); } }",
  };
  for (const [name, body] of Object.entries(styles)) {
    const { result, win } = playLevel(5, EXEC + body);
    assert.equal(result.ok, true, `${name}: ${result.error}`);
    assert.equal(win, true, `${name}: loop=${result.loopActions} variants=${JSON.stringify(result.variants)}`);
  }
});

test('level 6: every way of reading the instruction objects wins (N1, N6, V1, W3)', () => {
  const copies = {
    'computed key': "({ ['com' + 'mand']: s.command, steps: s.steps })",
    assignment: '(() => { const o = {}; o.command = s.command; o.steps = s.steps; return o; })()',
    getter: '({ get command() { return s.command; }, steps: s.steps })',
    spread: '({ ...s })',
    'Object.assign': 'Object.assign({}, s)',
    'Object.fromEntries': 'Object.fromEntries(Object.entries(s))',
    'shorthand': '(() => { const command = s.command; const steps = s.steps; return { command, steps }; })()',
  };
  const styles = {
    'for...of with steps': STEP_LOOP,
    'repeat(s.steps, move) (N1)': "for (const s of instructions) { if (s.command === 'move') repeat(s.steps, move); else if (s.command === 'turnRight') turnRight(); else turnLeft(); }",
    'forEach + repeat': 'instructions.forEach(s => repeat(s.steps || 1, () => exec(s.command)));',
    'while with index': 'let i = 0;\nwhile (i < instructions.length) { const s = instructions[i]; let n = s.steps || 1; while (n-- > 0) exec(s.command); i++; }',
    'sensors in the loop (N6)': 'let seen = 0;\nfor (const s of instructions) { for (let i = 0; i < (s.steps || 1); i++) { exec(s.command); if (hasKey() || isWallAhead()) seen++; } }',
    'destructuring': 'for (const { command, steps = 1 } of instructions) for (let i = 0; i < steps; i++) exec(command);',
    'flatMap to strings first (W3)': 'const flat = instructions.flatMap(s => Array(s.steps || 1).fill(s.command));\nfor (const c of flat) exec(c);',
    'closures prepared first (W3)': 'const actions = instructions.map(s => () => { for (let i = 0; i < (s.steps || 1); i++) exec(s.command); });\nfor (const a of actions) a();',
    ...Object.fromEntries(Object.entries(copies).map(([name, make]) => [`objects copied via ${name} (V1)`,
      `const list = instructions.map(s => ${make});\nfor (const s of list) { for (let i = 0; i < (s.steps || 1); i++) exec(s.command); }`])),
  };
  for (const [name, body] of Object.entries(styles)) {
    const { result, win } = playLevel(6, EXEC + body);
    assert.equal(result.ok, true, `${name}: ${result.error}`);
    assert.equal(result.steps, 49, name);
    assert.equal(win, true, `${name}: loop=${result.loopActions} variants=${JSON.stringify(result.variants)}`);
  }
});

test('levels 5 and 6: a route copied into the code by hand loses in any form (W1, N9)', () => {
  const runsOf = (cmds) => cmds.join(' ').split(/ ?turn\w+ ?/).filter(Boolean).map(seg => seg.split(' ').length);
  const letters = ROUTE5.map(c => (c === 'move' ? 'M' : c === 'turnLeft' ? 'L' : 'R')).join('');
  const cheats5 = {
    'no loop': HARD5,
    'one pass of a loop': `for (let k = 0; k < 1; k++) { ${HARD5} }`,
    'own string read by index (W1)': `const s = '${letters}';\nfor (let i = 0; i < s.length; i++) { if (s[i] === 'M') move(); else if (s[i] === 'L') turnLeft(); else turnRight(); }`,
    'route read and ignored (W1)': `const mine = ${JSON.stringify(ROUTE5)};\nfor (let i = 0; i < route.length; i++) { route[i]; exec(mine[i]); }`,
    'array of arrow functions': `const fns = [${ROUTE5.map(c => `() => ${c}()`).join(', ')}];\nfor (const f of fns) f();`,
    'object of arrow functions': `const plan = { ${ROUTE5.map((c, i) => `s${i}: () => ${c}()`).join(', ')} };\nfor (const k in plan) plan[k]();`,
    'turns from route, segment lengths by hand': `const runs = ${JSON.stringify(runsOf(ROUTE5))};\nlet r = 0; let inRun = false;\nfor (const c of route) { if (c === 'move') { if (!inRun) { repeat(runs[r++], move); inRun = true; } } else { inRun = false; exec(c); } }`,
    'segment lengths from route, turns by hand': `const turns = ${JSON.stringify(ROUTE5.filter(c => c !== 'move'))};\nlet t = 0;\nfor (const c of route) { if (c === 'move') move(); else exec(turns[t++]); }`,
  };
  for (const [name, body] of Object.entries(cheats5)) {
    const { result, reachedGoal, win } = playLevel(5, EXEC + body);
    assert.equal(reachedGoal, true, `${name} must solve the real board: ${result.error}`);
    assert.equal(win, false, name);
  }
  const cheats6 = {
    'reads dummy.command, then moves by hand (W1)': `const dummy = instructions[0];\nfor (let k = 0; k < 1; k++) { dummy.command; ${HARD6} }`,
    'own array of strings': `const cmds = ${JSON.stringify(FLAT6)};\nfor (const c of cmds) exec(c);`,
    'own array of objects': `const mine = ${JSON.stringify(INSTR6)};\nfor (const s of mine) { for (let i = 0; i < (s.steps || 1); i++) exec(s.command); }`,
  };
  for (const [name, body] of Object.entries(cheats6)) {
    const { result, reachedGoal, win } = playLevel(6, EXEC + body);
    assert.equal(reachedGoal, true, `${name} must solve the real board: ${result.error}`);
    assert.equal(win, false, name);
  }
});

test('levels 5 and 6: the data the level passes cannot be declared again', () => {
  for (const [n, name, value] of [[5, 'route', ROUTE5], [6, 'instructions', INSTR6]]) {
    const { result, win } = playLevel(n, `const ${name} = ${JSON.stringify(value)};\n${EXEC}for (const c of ${name}) exec(c);`);
    assert.equal(win, false);
    assert.equal(result.errorCode, 'COMPILE_ERROR');
    assert.match(result.error, new RegExp(`Змінна ${name} уже є.*рядок 1`));
  }
  // Inner scopes may use the name freely.
  const inner = playLevel(5, `${EXEC}function run(route) { for (const c of route) exec(c); }\nrun(route);`);
  assert.equal(inner.win, true, inner.result.error);
});

test('hidden variants: same length, every turn and segment length changed, the real route fails there', () => {
  for (const [n, commands, variantCommands] of [
    [5, ROUTE5, routeVariant(ROUTE5)],
    [6, FLAT6, expandInstructions(instructionsVariant(INSTR6))],
  ]) {
    assert.equal(variantCommands.length, commands.length, `level ${n}`);
    assert.notDeepEqual(variantCommands, commands);
    const board = LEVEL_VARIANTS[n][0];
    assert.equal(board.keys, 3);
    const run = (cmds) => runInActualWorker({
      code: cmds.map(c => `${c}();`).join(' '),
      config: { gridMap: board.gridMap, initialPos: board.initialPos, mode: 'multi-key', throwOnOutOfBounds: true },
    });
    const own = run(variantCommands);
    assert.equal(board.gridMap[own.finalPos.y][own.finalPos.x], 'goal', `level ${n}: the variant's own route reaches its goal`);
    assert.equal(own.collectedKeys.length, 3);
    const real = run(commands);
    assert.equal(real.ok && board.gridMap[real.finalPos.y][real.finalPos.x] === 'goal' && real.collectedKeys.length === 3, false,
      `level ${n}: the real route must not solve the variant`);
  }
  // Objects keep their shape: turns have no steps, moves keep a steps field.
  const variant6 = instructionsVariant(INSTR6);
  variant6.forEach((v, i) => assert.equal('steps' in v, 'steps' in INSTR6[i]));
});

test('levels 5 and 6 pass their data and decide from the run and the hidden variants', () => {
  const level5 = levelPage(5);
  const level6 = levelPage(6);
  assert.match(level5, /data: \{ route: finalRoute \}/);
  assert.match(level5, /variants: ROUTE_VARIANTS/);
  assert.match(level6, /data: \{ instructions: INSTRUCTIONS \}/);
  assert.match(level6, /variants: INSTRUCTION_VARIANTS/);
  for (const source of [level5, level6]) {
    assert.match(source, /movesInLoop\(result\)/);
    assert.match(source, /followsLevelData\(result, \w+_VARIANTS\)/);
    assert.doesNotMatch(source, /usesRoute\(code\)|hasLoop\(code\)|verifyCommandFlow|requireInstructions/);
  }
  // The starter code shows the data but does not declare it (declaring it again is an error).
  const starter5 = level5.slice(level5.indexOf('const initialCode'));
  const starter6 = level6.slice(level6.indexOf('const initialCode'));
  assert.doesNotMatch(starter5.slice(0, starter5.indexOf('`;')), /^const route =/m);
  assert.doesNotMatch(starter6.slice(0, starter6.indexOf('`;')), /^const instructions =/m);
});

test('the verdict needs both: moves in a loop and the variants solved', () => {
  const variants = LEVEL_VARIANTS[5];
  const solved = { ok: true, finalPos: { x: 0, y: 0 }, collectedKeys: ['a', 'b', 'c'], steps: 41 };
  const goal = variants[0].gridMap.flatMap((row, y) => row.map((c, x) => (c === 'goal' ? { x, y } : null))).find(Boolean);
  const base = { ok: true, steps: 41, loopActions: 41, variants: [{ ...solved, finalPos: goal }] };
  assert.equal(isDataDrivenLoopRun(base, variants), true);
  assert.equal(isDataDrivenLoopRun({ ...base, loopActions: 30 }, variants), false, 'more than 7 moves outside loops');
  assert.equal(movesInLoop({ ...base, loopActions: 34 }), true, '7 hand-written moves are tolerated');
  assert.equal(followsLevelData({ ...base, variants: undefined }, variants), false, 'no variant result');
  assert.equal(followsLevelData({ ...base, variants: [{ ...solved, finalPos: goal, collectedKeys: ['a'] }] }, variants), false);
  assert.equal(followsLevelData({ ...base, variants: [{ ...solved, finalPos: goal, ok: false }] }, variants), false);
});

test('functions kept in arrays and objects stay the same functions (V2)', () => {
  const result = runInActualWorker({
    code: `function solve() { move(); }\nconst handlers = { solve };\nif (handlers.solve !== solve) throw new Error('identity');\nclass A { hi() { return 1; } }\nfunction B() {}\nB.prototype.hi = function () { return 2; };\nconst types = [A, B];\nif (new types[0]().hi() !== 1 || new types[1]().hi() !== 2) throw new Error('constructor');\nconst list = [move, solve];\nif (list.indexOf(solve) !== 1 || list[0] !== move) throw new Error('indexOf');\nlist[1]();`,
    config: OPEN_GRID,
  });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.steps, 1);
});

test('a built-in command passed as a callback is not the learner\'s function (V3)', () => {
  for (const code of ['repeat(2, move); turnRight(); move();', "['a', 'b'].forEach(move);", "['a'].map(turnRight);", 'Array.from([1, 2], move);', 'new Set([1]).forEach(move);']) {
    const result = runInActualWorker({ code, config: OPEN_GRID });
    assert.equal(result.ok, true, `${code}: ${result.error}`);
    assert.equal(result.userFunctionRobotActions, 0, code);
    assert.ok(result.loopActions > 0, code);
  }
  const level4 = fs.readFileSync(path.join(__dirname, '..', 'app', 'Levels', 'level4', 'page.tsx'), 'utf8');
  assert.match(level4, /userFunctionRobotActions/);
});

test('a loop counts only if that loop itself repeated, not several one-pass loops together', () => {
  const route = ['move','turnLeft','move','turnRight','move','move','move','turnRight','move','move','turnLeft','move','turnRight','move'];
  const hard = (cmds) => cmds.map(c => `${c}();`).join(' ');
  const first = hard(route.slice(0, 7));
  const second = hard(route.slice(7));
  const notLoops = {
    'two one-pass for loops': `for (let i = 0; i < 1; i++) { ${first} }
for (let j = 0; j < 1; j++) { ${second} }`,
    'two repeat(1, ...)': `repeat(1, () => { ${first} });
repeat(1, () => { ${second} });`,
    'two one-pass forEach': `[0].forEach(() => { ${first} });
[0].forEach(() => { ${second} });`,
    'the same one-pass loop run twice': `function part(go) { for (let i = 0; i < 1; i++) go(); }
part(() => { ${first} });
part(() => { ${second} });`,
    'one-pass loop padded with an empty pass': `for (let i = 0; i < 2; i++) { if (i === 0) { ${hard(route)} } }`,
  };
  for (const [name, code] of Object.entries(notLoops)) {
    const result = runInActualWorker({ code, config: OPEN_GRID });
    assert.equal(result.ok, true, `${name}: ${result.error}`);
    assert.equal(result.loopActions, 0, name);
    assert.equal(movesInLoop(result), false, name);
  }
  // A two-pass decoy loop counts only its own moves, not the one-pass loop with the route.
  const decoy = runInActualWorker({ code: `for (let i = 0; i < 2; i++) { turnLeft(); turnRight(); }
for (let i = 0; i < 1; i++) { ${hard(route)} }`, config: OPEN_GRID });
  assert.equal(decoy.loopActions, 4);
  assert.equal(movesInLoop(decoy), false);
  // Real loops count, including an outer loop that runs once around one that repeats.
  for (const code of [
    `const route = ${JSON.stringify(route)};
for (const c of route) { if (c === 'move') move(); else if (c === 'turnLeft') turnLeft(); else turnRight(); }`,
    `for (let k = 0; k < 1; k++) { repeat(${route.length}, move); }`,
    `let i = 0;
while (i < 3 && (move(), true)) i++;`,
    'function* g() { for (let i = 0; i < 3; i++) yield i; }\nfor (const _ of g()) move();',
  ]) {
    const result = runInActualWorker({ code, config: OPEN_GRID });
    assert.equal(result.ok, true, `${code}: ${result.error}`);
    assert.equal(result.loopActions, result.steps, code);
    assert.equal(movesInLoop(result), true, code);
  }
  // A single move needs no repetition.
  assert.equal(runInActualWorker({ code: 'for (let i = 0; i < 1; i++) move();', config: OPEN_GRID }).loopActions, 1);
  // A loop left open by a suspended generator lends no repetition to the code after it.
  const gen = runInActualWorker({ code: 'function* g() { for (let i = 0; i < 3; i++) { turnLeft(); yield; } }\nconst it = g(); it.next(); it.next();\nfor (let i = 0; i < 1; i++) { move(); move(); }', config: OPEN_GRID });
  assert.equal(gen.loopActions, 2);
});

test('commands in the condition or update of a loop are loop actions (M1)', () => {
  for (const code of [
    'let i = 0; while (move(), i++ < 1) {}',
    'for (let i = 0; i < 2; i++, move()) {}',
    'let i = 0; do {} while (move(), ++i < 2);',
    'for (let i = 0; move(), i < 1; i++) {}',
    'for (const { a = move() } of [{}, {}]) {}',
  ]) {
    const result = runInActualWorker({ code, config: OPEN_GRID });
    assert.equal(result.ok, true, `${code}: ${result.error}`);
    assert.equal(result.steps, 2, code);
    assert.equal(result.loopActions, 2, code);
  }
  // break, continue, closures over the loop variable and labels behave as before.
  const semantics = runInActualWorker({
    code: 'let n = 0; for (let i = 0; i < 5; i++) { if (i === 2) continue; n++; if (n > 2) break; }\nif (n !== 3) throw new Error("n=" + n);\nlet k = 0; do { k++; if (k < 3) continue; } while (k < 4);\nif (k !== 4) throw new Error("k=" + k);\nconst fns = []; for (let i = 0; i < 3; i++) fns.push(() => i);\nif (fns.map(f => f()).join() !== "0,1,2") throw new Error("closures");\nlet hits = 0; outer: for (let a = 0; a < 3; a++) { for (let b = 0; b < 3; b++) { if (b === 1) continue outer; hits++; } }\nif (hits !== 3) throw new Error("labels");',
    config: OPEN_GRID,
  });
  assert.equal(semantics.ok, true, semantics.error);
});

test('a learner\'s own method named forEach is a function call, not a loop (M2)', () => {
  const own = runInActualWorker({ code: 'const o = { forEach(cb) { cb(); } };\no.forEach(() => { move(); move(); });', config: OPEN_GRID });
  assert.equal(own.loopActions, 0);
  const ownRepeat = runInActualWorker({ code: 'const t = { repeat(n, f) { f(); } };\nt.repeat(3, () => move());', config: OPEN_GRID });
  assert.equal(ownRepeat.loopActions, 0);
  const realLoopInside = runInActualWorker({ code: 'const o = { forEach(cb) { for (let i = 0; i < 2; i++) cb(); } };\no.forEach(() => move());', config: OPEN_GRID });
  assert.equal(realLoopInside.loopActions, 2);
});

test('a suspended generator does not lend its function or loop to the code after it (M3)', () => {
  const after = runInActualWorker({ code: 'function* g() { for (;;) { yield 1; } }\nconst it = g(); it.next();\nmove(); move(); turnRight();', config: OPEN_GRID });
  assert.equal(after.ok, true, after.error);
  assert.equal(after.loopActions, 0);
  assert.equal(after.userFunctionRobotActions, 0);
  const inside = runInActualWorker({ code: 'function* g() { while (true) { move(); yield; } }\nconst it = g(); it.next(); it.next(); turnRight();\nfor (const _ of (function* () { yield 1; yield 2; })()) move();\nit.return(); move();', config: OPEN_GRID });
  assert.equal(inside.ok, true, inside.error);
  assert.equal(inside.loopActions, 4, 'the generator\'s own loop and the for...of count');
  assert.equal(inside.userFunctionRobotActions, 2, 'only the moves made by the generator');
  const delegated = runInActualWorker({ code: 'function* inner() { yield 1; move(); yield 2; }\nfunction* outer() { yield* inner(); }\nconst it = outer(); it.next(); move(); it.next(); move();', config: OPEN_GRID });
  assert.equal(delegated.userFunctionRobotActions, 1);
  const thrown = runInActualWorker({ code: 'function* g() { try { while (true) yield; } finally { move(); } }\nconst it = g(); it.next();\ntry { it.throw(new Error("x")); } catch (e) {}\nmove();', config: OPEN_GRID });
  assert.equal(thrown.ok, true, thrown.error);
  assert.equal(thrown.userFunctionRobotActions, 1);
  assert.equal(thrown.loopActions, 0);
});

test('commands in default parameter values belong to the function (M4)', () => {
  for (const code of [
    'function run(action, result = action()) {}\nrun(move);',
    'const run = (action, result = action()) => {};\nrun(move);',
    'const run = function (action, result = action()) {};\nrun(move);',
    'const o = { run(action, result = action()) {} };\no.run(move);',
    'function run(action, { x = action() } = {}) {}\nrun(move);',
    'class C { x = move(); }\nnew C();',
  ]) {
    const result = runInActualWorker({ code, config: OPEN_GRID });
    assert.equal(result.ok, true, `${code}: ${result.error}`);
    assert.equal(result.userFunctionRobotActions, 1, code);
  }
  const semantics = runInActualWorker({
    code: 'function f(a, b = a * 2, { c = this && this.k } = {}) { return [a, b, c, arguments.length]; }\nconst out = f.call({ k: 7 }, 3);\nif (out.join() !== "3,6,7,1") throw new Error(out.join());\nclass P { constructor(v = 1) { this.v = v; } }\nclass Q extends P { constructor(v = 5) { super(v); } m(x = super.hi) { return x; } }\nP.prototype.hi = 9;\nif (new Q().v !== 5 || new Q().m() !== 9) throw new Error("super");',
    config: OPEN_GRID,
  });
  assert.equal(semantics.ok, true, semantics.error);
});

test('hasUserFunction: a function reached through an array element counts (F5)', () => {
  assert.equal(hasUserFunction('function go() { move(); }\nconst steps = [go];\nconst first = steps[0];\nfirst();'), true);
  assert.equal(hasUserFunction('function go() { move(); }\nconst steps = [go];\nconst [first] = steps;\nfirst();'), true);
  assert.equal(hasUserFunction('const nums = [1, 2];\nconst first = nums[0];\nmove();'), false);
});

test('hasUserFunction: a function reached through a chain of references counts (V1)', () => {
  assert.equal(hasUserFunction('function run(f) { f(); }\nconst a = run;\nconst b = a;\nb(move);'), true);
  assert.equal(hasUserFunction('function run(f) { f(); }\nconst a = run; const b = a; const c = b;\nc(move);'), true);
  assert.equal(hasUserFunction('function run(f) {}\nconst a = run;\nconst b = a;\nb(move);\nmove();'), false);
});

test('N2: Level 4 custom function calls callback via local reference or array of functions', () => {
  assert.equal(hasUserFunction('function run(action) { const a = action; a(); }\nrun(move);'), true);
  assert.equal(hasUserFunction('function run(action) { const fns = [action]; fns[0](); }\nrun(move);'), true);
  assert.equal(hasUserFunction('function run(action) { const fns = [action]; const a = fns[0]; a(); }\nrun(move);'), true);
  assert.equal(hasUserFunction('function run(action) { const a = action; }\nrun(move);\nmove();'), false);

  const workerResult = runInActualWorker({
    code: 'function run(action) { const a = action; a(); }\nfor (let i = 0; i < 32; i++) run(move);',
    config: { gridMap: Array.from({ length: 40 }, () => Array(40).fill('path')) }
  });
  assert.equal(workerResult.ok, true, workerResult.error);
  assert.equal(workerResult.userFunctionRobotActions, 32);
});

test('level 3 and level 4 decide from the run: loops however called, functions however reached (N8, N2)', () => {
  const level3 = fs.readFileSync(path.join(__dirname, '..', 'app', 'Levels', 'level3', 'page.tsx'), 'utf8');
  const level4 = fs.readFileSync(path.join(__dirname, '..', 'app', 'Levels', 'level4', 'page.tsx'), 'utf8');
  assert.doesNotMatch(level3 + level4, /codeValidator/);
  const route = "const route = ['move', 'move', 'turnRight', 'move'];\n";
  for (const call of ['Array.prototype.forEach.call(route, exec)', 'Array.prototype.forEach.apply(route, [exec])', 'Array.prototype.forEach.bind(route)(exec)']) {
    const result = runInActualWorker({ code: `${route}${EXEC}${call};`, config: OPEN_GRID });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.loopActions, 4, call);
  }
  const fromArray = runInActualWorker({ code: 'function go() { move(); }\nconst steps = [go];\nconst first = steps[0];\nfirst(); first();', config: OPEN_GRID });
  assert.equal(fromArray.userFunctionRobotActions, 2);
});

test('zero-iteration while/for conditions do not count as loopActions or satisfy movesInLoop', () => {
  const zeroWhile = runInActualWorker({
    code: 'while (move(), move(), turnRight(), move(), false) {}',
    config: OPEN_GRID,
  });
  assert.equal(zeroWhile.ok, true, zeroWhile.error);
  assert.equal(zeroWhile.steps, 4);
  assert.equal(zeroWhile.loopIterations, 0);
  assert.equal(zeroWhile.loopActions, 0);
  assert.equal(movesInLoop(zeroWhile), false);

  const zeroFor = runInActualWorker({
    code: 'for (; move(), move(), false; ) {}',
    config: OPEN_GRID,
  });
  assert.equal(zeroFor.ok, true, zeroFor.error);
  assert.equal(zeroFor.loopIterations, 0);
  assert.equal(zeroFor.loopActions, 0);
  assert.equal(movesInLoop(zeroFor), false);
});

test('static class fields do not count as userFunctionRobotActions, while non-declaration for-of destructuring counts as loopActions', () => {
  const staticField = runInActualWorker({
    code: 'class Bot { static s = (move(), move()); }',
    config: OPEN_GRID,
  });
  assert.equal(staticField.ok, true, staticField.error);
  assert.equal(staticField.steps, 2);
  assert.equal(staticField.userFunctionRobotActions, 0);

  const assignForOf = runInActualWorker({
    code: 'let a;\nfor ({ a = move() } of [{}, {}]) {}\nfor ([a = move()] of [[], []]) {}',
    config: OPEN_GRID,
  });
  assert.equal(assignForOf.ok, true, assignForOf.error);
  assert.equal(assignForOf.steps, 4);
  assert.equal(assignForOf.loopActions, 4);
});

test('Level 7 Virtual DOM supports compound CSS selectors, exact class attribute, and selector lists', () => {
  const domRun = runInActualWorker({
    code: `
      const term = document.querySelector('div#terminal[id="terminal"]');
      term.textContent = 'UNLOCKED';
      const btn = document.querySelector('#nonexistent, button#button.door-button[class="door-button"]');
      btn.classList.add('extra');
      const btnMulti = document.querySelector('.door-button.extra[class~="door-button"]');
      btnMulti.click();
      const plat = document.querySelector('div[id^="plat"][id$="form"]');
      plat.classList.add('active');
    `,
    config: { ...OPEN_GRID, mode: 'dom' },
  });
  assert.equal(domRun.ok, true, domRun.error);
  assert.equal(domRun.domState.terminalUnlocked, true);
  assert.equal(domRun.domState.buttonClicked, true);
  assert.equal(domRun.domState.doorOpen, true);
  assert.equal(domRun.domState.platformActive, true);
});

test('Level 4 gridMap blocks bypass at (7,5) so goal is only reachable through door at (5,4)', () => {
  assert.equal(LEVELS[4].gridMap[5][7], 'wall', 'Cell (7,5) must be a wall so the door at (5,4) cannot be bypassed');
  assert.equal(LEVELS[4].gridMap[4][5], 'door', 'Cell (5,4) is the door');
});

test('1-iteration loop wrappers and empty-loop + false-condition tricks do not satisfy movesInLoop', () => {
  const cheats = [
    'for (let i = 0; i < 1; i++) { move(); move(); turnRight(); move(); }',
    'while (true) { move(); move(); turnRight(); move(); break; }',
    'do { move(); move(); turnRight(); move(); } while (false);',
    'repeat(1, () => { move(); move(); turnRight(); move(); });',
    '[1].forEach(() => { move(); move(); turnRight(); move(); });',
    'for (let i = 0; i < 5; i++) { if (i === 0) { move(); move(); turnRight(); move(); } }',
    'for (let i = 0; i < 2; i++) {} while (move(), move(), turnRight(), move(), false) {}',
    'let i = 0; while (i++ < 2) {} while (move(), move(), turnRight(), move(), false) {}',
  ];
  for (const code of cheats) {
    const res = runInActualWorker({ code, config: OPEN_GRID });
    assert.equal(res.ok, true, `${code}: ${res.error}`);
    assert.equal(res.steps, 4, code);
    assert.equal(movesInLoop(res), false, `Fake loop wrapper must not satisfy movesInLoop: ${code}`);
  }
});

test('resetLevel across all 7 levels only shows VictoryModal when finishAttemptTransaction succeeds', () => {
  for (let level = 1; level <= 7; level += 1) {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'app', 'Levels', `level${level}`, 'page.tsx'),
      'utf8',
    );
    const resetIdx = source.indexOf('const resetLevel = useCallback');
    assert.ok(resetIdx !== -1, `level ${level}: must define resetLevel`);
    const resetBlock = source.slice(resetIdx, resetIdx + 1200);
    assert.match(
      resetBlock,
      /const success = finishAttemptTransaction\(\{ token: activeToken, outcome: 'victory', points: verdict\.points \}\);\s*if \(success\)/,
      `level ${level}: resetLevel must gate setIsVictory(true) on finishAttemptTransaction return value`,
    );
  }
});

test('a var and a function declaration with the same name stay valid JavaScript', () => {
  const grid = { gridMap: Array.from({ length: 6 }, () => Array(6).fill('path')) };
  const cases = [
    'function outer() { var step = 1; function step() { move(); } step = 2; return step; }\nif (outer() !== 2) throw new Error("value");',
    'const outer = () => { var step; function step() { move(); } step(); };\nouter();',
    'const o = { run() { var step; function step() { move(); } step(); } };\no.run();',
    'const f = function () { function step() { move(); } var step; step(); };\nf();',
    'function* g() { var s; function s() { move(); } s(); yield 1; }\ng().next();',
  ];
  for (const code of cases) {
    new Function('move', `"use strict";\n${code}`)(() => {});
    const result = runInActualWorker({ code, config: grid });
    assert.equal(result.ok, true, `${code}: ${result.error}`);
  }
  const moved = runInActualWorker({ code: cases[1], config: grid });
  assert.equal(moved.userFunctionRobotActions, 1, 'the hoisted function still counts as the learner\'s function');
});

test('level 7: element.style.backgroundColor reaches the board, other values are ignored like in a browser', () => {
  const { LEVELS_CONFIG: LEVELS7, } = loadTsModule(path.join('utils', 'levelsConfig.ts'));
  const { isSafeCssColor } = loadTsModule(path.join('utils', 'sandboxRunner.ts'));
  const result = runInActualWorker({
    code: `const p = dom.getElementById('platform');
p.style.backgroundColor = 'gold';
dom.getElementById('door').style.background = '#ff0000';
dom.getElementById('terminal').style.backgroundColor = 'url(http://example.com/x.png)';
if (p.style.backgroundColor !== 'gold') throw new Error('getter');`,
    config: { ...LEVELS7[7], mode: 'dom' },
  });
  assert.equal(result.ok, true, result.error);
  assert.equal(JSON.stringify(result.domState.colors), JSON.stringify({ door: '#ff0000', platform: 'gold' }));
  assert.ok(result.events.some(e => e.type === 'dom' && e.state.colors.platform === 'gold'), 'the change is replayed step by step');
  for (const ok of ['gold', '#fff', 'rgb(1, 2, 3)', 'hsla(120 50% 50% / 0.5)']) assert.equal(isSafeCssColor(ok), true, ok);
  for (const bad of ['url(x)', 'red; background: url(x)', 'expression(alert(1))', '"red"', '']) assert.equal(isSafeCssColor(bad), false, bad);
  const level7 = fs.readFileSync(path.join(__dirname, '..', 'app', 'Levels', 'level7', 'page.tsx'), 'utf8');
  assert.match(level7, /isSafeCssColor\(color\)/);
  assert.match(level7, /backgroundColor: customColor/);
});

test('level 4: the rule shown to the player decides, and advance(n) with separate turns wins', () => {
  const { LEVELS_CONFIG: LEVELS4 } = loadTsModule(path.join('utils', 'levelsConfig.ts'));
  const route = ['go', 'go', 'turnRight', 'go', 'turnLeft', 'go', 'go', 'turnLeft', 'go', 'turnRight', 'turnRight', 'go', 'go', 'turnLeft', 'go', 'go', 'go', 'turnRight', 'go', 'go', 'go', 'go', 'turnRight', 'go', 'go', 'go', 'turnRight', 'go', 'go', 'turnRight', 'go', 'turnRight', 'turnRight', 'go', 'turnLeft', 'go', 'go', 'turnRight', 'go', 'go', 'go', 'go', 'turnLeft', 'go'];
  const segments = [];
  for (const c of route) {
    if (c === 'go') {
      if (typeof segments[segments.length - 1] === 'number') segments[segments.length - 1] += 1;
      else segments.push(1);
    } else segments.push(c);
  }
  const play = (code) => runInActualWorker({ code, config: { ...LEVELS4[4], mode: 'key-door', throwOnOutOfBounds: true } });
  const ruleHolds = (r) => r.userFunctionRobotActions >= 1 && r.userFunctionRobotActions * 2 >= r.steps;
  const advance = play(`function advance(n) { for (let i = 0; i < n; i++) move(); }\n${segments.map(s => (typeof s === 'number' ? `advance(${s});` : `${s}();`)).join('\n')}`);
  assert.equal(advance.ok, true, advance.error);
  assert.equal(advance.doorOpened && advance.hasKey, true);
  assert.equal(route.length - advance.userFunctionRobotActions, 15, 'all 15 turns are hand-written');
  assert.equal(ruleHolds(advance), true);
  const token = play(`function go() { move(); }\ngo();\n${route.slice(1).map(c => (c === 'go' ? 'move();' : `${c}();`)).join('\n')}`);
  assert.equal(token.ok, true, token.error);
  assert.equal(ruleHolds(token), false, 'one call of a function next to a hand-written route is not enough');
  const level4 = fs.readFileSync(path.join(__dirname, '..', 'app', 'Levels', 'level4', 'page.tsx'), 'utf8');
  assert.doesNotMatch(level4, /MAX_UNBACKED_ACTIONS/);
  assert.match(level4, /return userFnActions >= 1 && userFnActions \* 2 >= result\.steps;/);
  assert.match(level4, /щонайменше <strong>половину команд<\/strong>/);
});

/** Runs code both as plain strict JavaScript and in the worker; both must succeed or fail alike. */
function runLikeJavaScript(code) {
  let plain = 'ok';
  try {
    new Function('move', 'turnLeft', 'turnRight', `"use strict";\n${code}`)(() => {}, () => {}, () => {});
  } catch (error) {
    plain = error.message;
  }
  const result = runInActualWorker({ code, config: { gridMap: Array.from({ length: 8 }, () => Array(8).fill('path')) } });
  assert.equal(result.ok ? 'ok' : result.error, plain, code);
  return result;
}

test('nested function declarations see the let/const of their function and keep var semantics', () => {
  assert.equal(runLikeJavaScript('function run() { let count = 0; function inc() { count++; move(); } inc(); inc(); if (count !== 2) throw new Error("count " + count); }\nrun();').userFunctionRobotActions, 2);
  runLikeJavaScript('const count = 100;\nfunction run() { const count = 1; function get() { return count; } if (get() !== 1) throw new Error("outer count " + get()); }\nrun();');
  runLikeJavaScript('function outer() { var step = 1; function step() { move(); } step = 2; return step; }\nif (outer() !== 2) throw new Error("value");');
  runLikeJavaScript('function run() { go(); const x = 1; function go() { move(); } }\nrun();');
  runLikeJavaScript('function* g() { let n = 0; function bump() { n++; move(); } bump(); yield n; }\nif (g().next().value !== 1) throw new Error("n");');
  runLikeJavaScript('function run() { function inner() {} if (inner.name !== "inner") throw new Error("name " + inner.name); }\nrun();');
});

test('functions keep the names JavaScript infers for them in defaults and class fields', () => {
  runLikeJavaScript('function run(cmd = function () {}) { if (cmd.name !== "cmd") throw new Error("name " + cmd.name); }\nrun();');
  assert.equal(runLikeJavaScript('function run(go = () => move()) { if (go.name !== "go") throw new Error("name " + go.name); go(); }\nrun();').userFunctionRobotActions, 1);
  runLikeJavaScript('class Bot { turnRight = () => turnRight(); step = function () { move(); }; }\nconst b = new Bot();\nif (b.turnRight.name !== "turnRight" || b.step.name !== "step") throw new Error("names");\nb.step();');
  // Code in a default value still runs as part of the function.
  assert.equal(runLikeJavaScript('function run(action, result = action()) {}\nrun(move);').userFunctionRobotActions, 1);
});

test('loops inside a class static block are loops', () => {
  const result = runLikeJavaScript('class Runner { static { for (let i = 0; i < 3; i++) move(); } }');
  assert.equal(result.loopActions, 3);
});

test('for...of: next() of the iterator and the assignment to the loop target run inside the iteration', () => {
  assert.equal(runLikeJavaScript('const bot = { set cmd(c) { move(); } };\nfor (bot.cmd of [1, 2, 3]);').loopActions, 3);
  assert.equal(runLikeJavaScript('const it = { i: 0, [Symbol.iterator]() { return this; }, next() { if (this.i++ < 3) { move(); return { done: false, value: 1 }; } return { done: true }; } };\nfor (const _ of it) {}').loopActions, 3);
  runLikeJavaScript('let closed = false;\nconst it = { [Symbol.iterator]() { return { next: () => ({ done: false, value: 1 }), return: () => { closed = true; return { done: true }; } }; } };\nfor (const _ of it) { move(); break; }\nif (!closed) throw new Error("not closed");');
  runLikeJavaScript('let calls = 0;\nconst it = { [Symbol.iterator]() { calls++; return [1, 2][Symbol.iterator](); } };\nfor (const _ of it) {}\nif (calls !== 1) throw new Error("calls " + calls);');
  runLikeJavaScript('for (const x of 5) {}');
  runLikeJavaScript('let out = "";\nfor (const ch of "abc") out += ch;\nif (out !== "abc") throw new Error(out);');
});


test('beginner-friendly protections: move(steps), providedNames reassignment, empty code, and DOM selector hints', () => {
  // 1. move(steps) moves multiple steps when called with a single numeric count
  const multi = runInActualWorker({
    code: 'move(3);',
    config: { gridMap: Array.from({ length: 8 }, () => Array(8).fill('path')) },
  });
  assert.equal(multi.ok, true, multi.error);
  assert.equal(multi.steps, 3);
  assert.equal(multi.finalPos.x, 3);

  // 2. checkRunnableCode catches empty/comment-only code, syntax errors, and providedNames reassignment
  const { checkRunnableCode } = loadTsModule('utils/sandboxRunner.ts');
  assert.match(checkRunnableCode('// comment only\n/* block */') || '', /Спочатку напиши або розкоментуй код/);
  assert.match(checkRunnableCode('route = ["right"];', ['route']) || '', /Змінна route уже є/);
  assert.equal(checkRunnableCode('// comment\nmove();'), null);

  // 3. Level 7 (DOM): locked terminal blocks movement, and #terminal / .active / door-button normalize
  const domBlocked = runInActualWorker({
    code: 'move();',
    config: {
      mode: 'dom',
      gridMap: [['start', 'terminal', 'goal']],
      startPos: { x: 0, y: 0 },
      goalPos: { x: 2, y: 0 },
    },
  });
  assert.equal(domBlocked.ok, true);
  assert.equal(domBlocked.finalPos.blocked, true);
  assert.equal(domBlocked.finalPos.x, 0);
  assert.ok(domBlocked.events.some(e => e.type === 'robot' && e.action === 'blocked' && e.message === 'Термінал заблоковано'));

  const domNormalized = runInActualWorker({
    code: `
      const t = dom.getElementById('#terminal');
      t.textContent = 'UNLOCKED';
      const btn = dom.querySelector('door-button');
      btn.click();
      const p = dom.getElementById('#platform');
      p.classList.add('.active');
      move(2);
    `,
    config: {
      mode: 'dom',
      gridMap: [['start', 'terminal', 'goal']],
      startPos: { x: 0, y: 0 },
      goalPos: { x: 2, y: 0 },
      throwOnWall: true,
    },
  });
  assert.equal(domNormalized.ok, true, domNormalized.error);
  assert.equal(domNormalized.domState.terminalUnlocked, true);
  assert.equal(domNormalized.domState.doorOpen, true);
  assert.equal(domNormalized.domState.platformActive, true);
  assert.equal(domNormalized.finalPos.x, 2);
});

// --- Beginner mistakes are explained before the run, so they cost no life ---
const { checkRunnableCode } = loadTsModule(path.join('utils', 'sandboxRunner.ts'));
const DOM_IDS = { domElementIds: ['terminal', 'door', 'platform', 'button'] };

test('typical beginner mistakes are caught before the run with a hint in Ukrainian', () => {
  const cases = [
    ['move();\nmove;', {}, /Рядок 2: «move» без дужок.*move\(\);/],
    ['turnLeft;', {}, /«turnLeft» без дужок/],
    ["const btn = dom.querySelector('.door-button');\nbtn.click;", DOM_IDS, /«btn\.click» без дужок.*btn\.click\(\);/],
    ['turnleft();', {}, /команди «turnleft» немає.*turnLeft\(\)/],
    ['Move();', {}, /ти мав на увазі move\(\)/],
    ['iswallahead();', {}, /isWallAhead\(\)/],
    ['Repeat(2, move);', {}, /repeat\(\)/],
    ["const route = ['move'];\nfor (const cmd of route) { if (cmd = 'move') move(); }", {}, /Рядок 2: в умові стоїть «=».*cmd === 'move'/],
    ['repeat(4, move());', {}, /repeat\(4, move\(\)\) виконає move\(\) лише один раз.*repeat\(4, move\)/],
    ['repeat(4);', {}, /repeat потрібні дві речі/],
    ["dom.getElementById('termnial').textContent = 'UNLOCKED';", DOM_IDS, /id «termnial» немає\. Доступні id: terminal, door, platform, button/],
  ];
  for (const [code, options, message] of cases) {
    assert.match(checkRunnableCode(code, [], options) ?? '', message, code);
  }
});

test('correct code is never held back by the beginner checks', () => {
  const correct = [
    'while (!isGoalReached()) { if (canMove()) { move(); } else { turnRight(); } }',
    "const queue = ['move'];\nlet c;\nwhile ((c = queue.shift())) move();\nwhile (c = queue.shift()) move();",
    'repeat(4, move);\nrepeat(2, () => { move(); turnRight(); });',
    'function makeStep() { return () => move(); }\nrepeat(3, makeStep());',
    'function turnleft() { turnLeft(); }\nturnleft();',
    'const act = { move, turnLeft };\nact.move();\nconst moves = 2;\nfor (let i = 0; i < moves; i++) move();',
    "dom.getElementById('terminal').textContent = 'UNLOCKED';\ndom.querySelector('.door-button').click();\ndom.getElementById('#platform').classList.add('active');",
    'class Bot { move() { move(); } }\nnew Bot().move();\nMath.max(1, 2);',
  ];
  for (const code of correct) assert.equal(checkRunnableCode(code, [], DOM_IDS), null, code);
  // The hint of level 6, uncommented, passes too.
  const level6 = fs.readFileSync(path.join(__dirname, '..', 'app', 'Levels', 'level6', 'page.tsx'), 'utf8');
  const hint = level6.slice(level6.indexOf('// for (const item of instructions)'), level6.indexOf('`;', level6.indexOf('// for (const item of instructions)')));
  assert.equal(checkRunnableCode(hint.replace(/^\/\/ ?/gm, ''), ['instructions']), null);
});

test('runtime errors beginners meet are explained in Ukrainian', () => {
  const grid = { gridMap: Array.from({ length: 6 }, () => Array(6).fill('path')) };
  assert.match(runInActualWorker({ code: 'const n = "x";\nmissingCommand();', config: grid }).error, /Невідома назва «missingCommand»/);
  assert.match(runInActualWorker({ code: 'const item = {};\nrepeat(item.steps, move);', config: grid }).error, /отримано undefined.*item\.steps \?\? 1/);
  assert.match(runInActualWorker({ code: 'repeat(2, 5);', config: grid }).error, /команда без дужок або функція/);
  const { LEVELS_CONFIG: L } = loadTsModule(path.join('utils', 'levelsConfig.ts'));
  const nullLookup = runInActualWorker({ code: "const id = 'term' + 'nial';\ndom.getElementById(id).textContent = 'UNLOCKED';", config: { ...L[7], mode: 'dom' } });
  assert.match(nullLookup.error, /Елемент не знайдено: dom\.getElementById\('termnial'\) повернув null.*terminal, door, platform, button/);
});

test('level maps: level 2 needs turns and its hint works, level 3 hint works twice, level 7 goes over the platform', () => {
  const { LEVELS_CONFIG: L } = loadTsModule(path.join('utils', 'levelsConfig.ts'));
  const play = (n, code, mode) => {
    const r = runInActualWorker({ code, config: { gridMap: L[n].gridMap, initialPos: L[n].initialPos, mode, throwOnOutOfBounds: true } });
    return { r, cell: L[n].gridMap[r.finalPos.y][r.finalPos.x] };
  };
  const follow = (until) => `while (!${until}()) { if (canMove()) { move(); } else { turnRight(); } }`;
  assert.equal(play(2, follow('isGoalReached'), 'conditional').cell, 'goal');
  assert.notEqual(play(2, 'move(); move(); move(); move();', 'conditional').cell, 'goal', 'a straight line is not enough any more');
  assert.equal(L[2].optimalSteps, 9);
  const level3 = play(3, `${follow('hasKey')}\n${follow('isGoalReached')}`, 'single-key');
  assert.equal(level3.r.hasKey, true);
  assert.equal(level3.cell, 'goal');
  const tasks = "dom.getElementById('terminal').textContent = 'UNLOCKED';\ndom.querySelector('.door-button').click();\n";
  assert.notEqual(play(7, `${tasks}move(); move(); move(); move(); turnRight(); move(); move(); move(); move();`, 'dom').cell, 'goal', 'no way around the platform');
  const viaDoorClass = play(7, "dom.getElementById('terminal').textContent = 'UNLOCKED';\ndom.getElementById('door').classList.add('open');\ndom.getElementById('platform').classList.add('active');\nmove(); move(); turnRight(); move(); move(); move(); move(); turnLeft(); move(); move();", 'dom');
  assert.equal(viaDoorClass.cell, 'goal');
  assert.equal(viaDoorClass.r.domState.doorOpen, true);
  const level7 = fs.readFileSync(path.join(__dirname, '..', 'app', 'Levels', 'level7', 'page.tsx'), 'utf8');
  assert.match(level7, /&& terminalUnlocked && doorOpen && platformActive;/, 'the door counts however it was opened');
  assert.match(level7, /checkRunnableCode\(code, \[\], \{ domElementIds: DOM_ELEMENT_IDS \}\)/);
});

test('level 6: every instruction object has steps, so repeat(item.steps, ...) works for turns too', () => {
  const page = fs.readFileSync(path.join(__dirname, '..', 'app', 'Levels', 'level6', 'page.tsx'), 'utf8');
  const list = eval(page.match(/const INSTRUCTIONS: Instruction\[\] = (\[[\s\S]*?\n\]);/)[1]);
  assert.ok(list.every(i => Number.isInteger(i.steps)), 'every object has steps');
  assert.ok(list.filter(i => i.command !== 'move').every(i => i.steps === 1));
  const { LEVELS_CONFIG: L } = loadTsModule(path.join('utils', 'levelsConfig.ts'));
  const r = runInActualWorker({
    code: "for (const item of instructions) { repeat(item.steps, () => { if (item.command === 'move') move(); else if (item.command === 'turnLeft') turnLeft(); else turnRight(); }); }",
    config: { gridMap: L[6].gridMap, initialPos: L[6].initialPos, mode: 'multi-key', throwOnOutOfBounds: true, data: { instructions: list } },
  });
  assert.equal(r.ok, true, r.error);
  assert.equal(L[6].gridMap[r.finalPos.y][r.finalPos.x], 'goal');
  assert.equal(r.collectedKeys.length, 3);
});

test('the home page demo checks the code like the levels and says when the robot hit a wall', () => {
  const demo = fs.readFileSync(path.join(__dirname, '..', 'components', 'MiniDemo.tsx'), 'utf8');
  assert.match(demo, /const preflightError = checkRunnableCode\(code\);/);
  assert.match(demo, /e\.action === 'blocked'/);
  assert.match(demo, /Робот врізався в стіну/);
});
