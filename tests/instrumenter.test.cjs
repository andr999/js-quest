const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

function loadInstrumenter() {
  const filename = path.join(__dirname, '..', 'utils', 'instrumenter.ts');
  const source = fs.readFileSync(filename, 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: filename,
  }).outputText;
  const localModule = { exports: {} };
  const evaluateModule = new Function('require', 'module', 'exports', compiled);
  evaluateModule(require, localModule, localModule.exports);
  return localModule.exports;
}

const { instrumentCode } = loadInstrumenter();

test('preserves return values from declared functions in expressions and conditions', () => {
  const source = `
function steps() { return 2; }
const count = steps();
let total = 0;
for (let index = 0; index < steps(); index += 1) total += 1;
if (steps() === 2) total += count;
`;
  const trace = () => {};
  const noop = () => {};
  const execute = new Function(
    '__trace__',
    '__jsQuestEnterFn__',
    '__jsQuestExitFn__',
    '__jsQuestEnterLoop__',
    '__jsQuestExitLoop__',
    `${instrumentCode(source, '__trace__')}\nreturn { count, total };`,
  );

  assert.deepEqual(execute(trace, noop, noop, noop, noop), { count: 2, total: 4 });
  assert.doesNotMatch(instrumentCode(source), /function\s*\*/);
});

test('adds a guard call inside an empty arrow-function loop', () => {
  const instrumented = instrumentCode('(() => { while (true) {} })();', '__trace__');
  const childScript = `
const noop = () => {};
const execute = new Function(
  '__trace__',
  '__jsQuestEnterFn__',
  '__jsQuestExitFn__',
  '__jsQuestEnterLoop__',
  '__jsQuestExitLoop__',
  ${JSON.stringify(instrumented)}
);
let operations = 0;
try {
  execute(
    () => {},
    noop,
    noop,
    () => {
      operations += 1;
      if (operations > 25) throw new Error('guard-stopped-loop');
    },
    noop
  );
} catch (error) {
  if (error.message === 'guard-stopped-loop') {
    process.stdout.write('stopped');
    process.exit(0);
  }
  throw error;
}
process.exit(2);
`;
  const child = spawnSync(process.execPath, ['-e', childScript], {
    encoding: 'utf8',
    timeout: 10_000,
  });

  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, 'stopped');
});

test('instruments single-statement loop and conditional bodies without changing results', () => {
  const lines = [];
  const source = `
let value = 0;
for (let index = 0; index < 3; index += 1) value += index;
if (value === 3) value += 4;
`;
  const noop = () => {};
  const execute = new Function(
    '__trace__',
    '__jsQuestEnterFn__',
    '__jsQuestExitFn__',
    '__jsQuestEnterLoop__',
    '__jsQuestExitLoop__',
    `${instrumentCode(source, '__trace__')}\nreturn value;`
  );

  assert.equal(execute((line) => lines.push(line), noop, noop, noop, noop), 7);
  assert.ok(lines.length >= 5);
});

test('instruments with custom randomized hook identifiers', () => {
  const source = `
function myFunc() {
  for (let i = 0; i < 2; i++) {}
}
myFunc();
`;
  const customHooks = {
    enterFn: '__customEnterFn_123',
    exitFn: '__customExitFn_123',
    enterLoop: '__customEnterLoop_123',
    exitLoop: '__customExitLoop_123',
  };
  const instrumented = instrumentCode(source, {
    traceIdentifier: '__customTrace_123',
    hookIdentifiers: customHooks,
  });

  assert.ok(instrumented.includes('__customEnterFn_123()'));
  assert.ok(instrumented.includes('__customExitFn_123()'));
  assert.ok(instrumented.includes('__customEnterLoop_123(false)'));
  assert.ok(instrumented.includes('__customExitLoop_123(false)'));
  assert.ok(instrumented.includes('__customTrace_123('));
});

test('instruments callback factory calls only once in higher-order iteration methods', () => {
  const source = `
let factoryInvocations = 0;
function makeHandler() {
  factoryInvocations++;
  return function(cmd) {};
}
const route = ['move', 'turnRight'];
route.forEach(makeHandler());
`;
  const instrumented = instrumentCode(source);

  const sandbox = {
    __jsQuestTrace__: () => {},
    __jsQuestEnterFn__: () => {},
    __jsQuestExitFn__: () => {},
    __jsQuestEnterLoop__: () => {},
    __jsQuestExitLoop__: () => {},
  };
  const fn = new Function(...Object.keys(sandbox), `${instrumented}\nreturn factoryInvocations;`);
  const invocations = fn(...Object.values(sandbox));
  assert.equal(invocations, 1, 'Callback factory must be evaluated exactly once');
});

test('forEach preserves thisArg context and evaluates callback property getter exactly once', () => {
  const source = `
let reads = 0;
const robot = {
  get step() {
    reads++;
    return function(cmd) {
      if (this !== robot) throw new Error('context-lost');
      this.executed = (this.executed || 0) + 1;
    };
  }
};
const route = ['move', 'turnRight'];
route.forEach(robot.step, robot);
`;
  const instrumented = instrumentCode(source);

  const sandbox = {
    __jsQuestTrace__: () => {},
    __jsQuestEnterFn__: () => {},
    __jsQuestExitFn__: () => {},
    __jsQuestEnterLoop__: () => {},
    __jsQuestExitLoop__: () => {},
  };
  const fn = new Function(...Object.keys(sandbox), `${instrumented}\nreturn { reads, executed: robot.executed };`);
  const result = fn(...Object.values(sandbox));
  assert.equal(result.reads, 1, 'Property getter must be read exactly once, not on every iteration');
  assert.equal(result.executed, 2, 'Callback must execute twice with correct context');
});

function runInstrumented(source, result) {
  const counts = { fn: 0, loop: 0, part: 0 };
  const hooks = {
    __jsQuestTrace__: () => {},
    __jsQuestEnterFn__: () => { counts.fn += 1; },
    __jsQuestExitFn__: () => {},
    __jsQuestEnterLoop__: (isPart) => { if (isPart) counts.part += 1; else counts.loop += 1; },
    __jsQuestExitLoop__: () => {},
  };
  const value = new Function(...Object.keys(hooks), `${instrumentCode(source)}\nreturn ${result};`)(...Object.values(hooks));
  return { value, counts };
}

test('loop conditions and updates are evaluated inside the iteration, with the same results', () => {
  const instrumented = instrumentCode('let i = 0;\nwhile (i < 2) i++;\nfor (let k = 0; k < 3; k++) {}\ndo { i++; } while (i < 5);');
  assert.match(instrumented, /__jsQuestEnterLoop__\(true\)/);
  const { value, counts } = runInstrumented('let out = [];\nfor (let k = 0, j = 10; k < 3; k++, j--) out.push(k + j);\nlet w = 0; while (w++ < 2) out.push(w);\nlet d = 0; do { out.push(d); } while (++d < 2);', 'out.join()');
  assert.equal(value, '10,10,10,1,2,0,1');
  assert.equal(counts.loop, 3 + 2 + 2, 'one per iteration of each loop');
  assert.ok(counts.part > 0);
  assert.equal(counts.fn, 0, 'the wrapper around a condition is not a learner function');
});

test('the learner\'s own iteration-like methods are left alone: only real built-ins count (M2)', () => {
  const instrumented = instrumentCode('const o = { forEach(cb) { cb(); } };\no.forEach(() => move());\nrepeat(2, move);');
  assert.doesNotMatch(instrumented, /__cb|__iterArgs/);
  assert.doesNotMatch(instrumented, /__jsQuestEnterLoop__/);
});

test('default parameter values and class fields run as part of a function (M4)', () => {
  const { value, counts } = runInstrumented('function f(a, b = a + 1, { c = 3, [\'d\' + \'\']: d = 4 } = {}) { return [a, b, c, d].join(); }\nclass K { x = 5; }\nconst out = f(1) + "|" + new K().x;', 'out');
  assert.equal(value, '1,2,3,4|5');
  assert.ok(counts.fn >= 5, `defaults, computed key and field are functions too (${counts.fn})`);
});

test('the names a level passes in cannot be declared again at the top of the code', () => {
  assert.throws(() => instrumentCode('const route = [];', { providedNames: ['route'] }), /Змінна route уже є.*рядок 1/);
  assert.throws(() => instrumentCode('move();\nif (true) { var route = []; }', { providedNames: ['route'] }), /рядок 2/);
  assert.throws(() => instrumentCode('function instructions() {}', { providedNames: ['instructions'] }), /instructions/);
  assert.doesNotThrow(() => instrumentCode('function run(route) { const copy = route; }\n{ let route = 1; }', { providedNames: ['route'] }));
  assert.doesNotThrow(() => instrumentCode('const route = [];'));
});

test('instrumentCode rejects dynamic import()', () => {
  assert.throws(
    () => {
      instrumentCode("import('module').catch(() => move());");
    },
    (err) => {
      assert.match(err.message, /Динамічний import\(\) не підтримується/);
      return true;
    },
  );
});

test('concise arrow function bodies emit trace line events when executed', () => {
  const lines = [];
  const source = 'const step = () =>\n  42;\nconst res = step();';
  const noop = () => {};
  const execute = new Function(
    '__trace__',
    '__jsQuestEnterFn__',
    '__jsQuestExitFn__',
    '__jsQuestEnterLoop__',
    '__jsQuestExitLoop__',
    `${instrumentCode(source, '__trace__')}\nreturn res;`,
  );
  assert.equal(execute((line) => lines.push(line), noop, noop, noop, noop), 42);
  assert.ok(lines.includes(2), `Expected line 2 from concise arrow body to be traced, got: ${lines.join(',')}`);
});

test('static class fields do not trigger enterFn on class declaration', () => {
  const { value, counts } = runInstrumented('class C { static s = 10; }\nconst v = C.s;', 'v');
  assert.equal(value, 10);
  assert.equal(counts.fn, 0, 'static class field evaluated at declaration must not count as user function call');
});

test('var inside class static block is scoped to the static block and does not conflict with providedNames', () => {
  assert.doesNotThrow(() =>
    instrumentCode('class C { static { var route = 1; } }\nfor (const c of route) move();', { providedNames: ['route'] })
  );
});

