const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

function loadCodeValidator() {
  const filename = path.join(__dirname, '..', 'utils', 'codeValidator.ts');
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

const { hasUserFunction, hasLoop, usesRoute, usesInstructions } = loadCodeValidator();

test('hasUserFunction: rejects functions containing robot calls only inside dead if branches', () => {
  assert.equal(
    hasUserFunction('function myAction() { if (false) { move(); } }\nmyAction();'),
    false,
    'Must reject when robot command is only in if(false)'
  );
  assert.equal(
    hasUserFunction('function myAction() { if (Boolean(false)) { move(); } }\nmyAction();'),
    false,
    'Must reject when robot command is only in if(Boolean(false))'
  );
  assert.equal(
    hasUserFunction('function myAction() { if (!true) { move(); } }\nmyAction();'),
    false,
    'Must reject when robot command is only in if(!true)'
  );
  assert.equal(
    hasUserFunction('function myAction() { if (1 === 2) { move(); } }\nmyAction();'),
    false,
    'Must reject when robot command is only in if(1 === 2)'
  );
});

test('hasUserFunction: rejects function calls invoked only inside dead if branches', () => {
  assert.equal(
    hasUserFunction('function myAction() { move(); }\nif (false) { myAction(); }'),
    false,
    'Must reject when function is only called inside if(false)'
  );
  assert.equal(
    hasUserFunction('function myAction() { move(); }\nif (Boolean(false)) { myAction(); }'),
    false,
    'Must reject when function is only called inside if(Boolean(false))'
  );
});

test('hasUserFunction: accepts valid functions called in reachable code', () => {
  assert.equal(
    hasUserFunction('function stepForward() { move(); }\nstepForward();'),
    true,
    'Must accept valid function declaration and call'
  );
  assert.equal(
    hasUserFunction('const step = () => { turnRight(); move(); };\nstep();'),
    true,
    'Must accept valid arrow function and call'
  );
  assert.equal(
    hasUserFunction('function step() { if (true) { move(); } }\nstep();'),
    true,
    'Must accept valid function with if(true)'
  );
  assert.equal(
    hasUserFunction('function step() { if (Boolean(true)) { move(); } }\nstep();'),
    true,
    'Must accept valid function with if(Boolean(true))'
  );
});

test('hasLoop: accepts active loops with negative initial bounds', () => {
  assert.equal(
    hasLoop('for (let i = -5; i < 0; i++) { move(); }'),
    true,
    'Must accept for loop starting at -5 up to 0'
  );
  assert.equal(
    hasLoop('for (let i = -10; i <= -2; i++) { move(); turnRight(); }'),
    true,
    'Must accept for loop with negative range'
  );
});

test('hasLoop: rejects statically dead loops', () => {
  assert.equal(
    hasLoop('for (let i = 5; i < 0; i++) { move(); }'),
    false,
    'Must reject for loop with impossible bounds (5 < 0)'
  );
  assert.equal(
    hasLoop('for (let i = 0; i < 0; i++) { move(); }'),
    false,
    'Must reject for loop with bounds 0 < 0'
  );
  assert.equal(
    hasLoop('while (false) { move(); }'),
    false,
    'Must reject while(false)'
  );
  assert.equal(
    hasLoop('while (Boolean(false)) { move(); }'),
    false,
    'Must reject while(Boolean(false))'
  );
  assert.equal(
    hasLoop('while (!true) { move(); }'),
    false,
    'Must reject while(!true)'
  );
  assert.equal(
    hasLoop('[].forEach(() => { move(); })'),
    false,
    'Must reject forEach on empty array literal'
  );
});

test('hasLoop: accepts valid standard loops and iteration methods', () => {
  assert.equal(
    hasLoop('for (let i = 0; i < 5; i++) { move(); }'),
    true,
    'Must accept standard for loop'
  );
  assert.equal(
    hasLoop('while (true) { move(); }'),
    true,
    'Must accept while(true)'
  );
  assert.equal(
    hasLoop('[1, 2, 3].forEach(() => { move(); })'),
    true,
    'Must accept forEach on array'
  );
  assert.equal(
    hasLoop('for (const step of route) { move(); }'),
    true,
    'Must accept for...of loop'
  );
});

test('hasUserFunction: accepts object literal methods and class methods', () => {
  assert.equal(
    hasUserFunction('const robot = { solve() { move(); } };\nrobot.solve();'),
    true,
    'Must accept object method solve()'
  );
  assert.equal(
    hasUserFunction('const robot = { solve: () => { turnRight(); move(); } };\nrobot.solve();'),
    true,
    'Must accept object arrow property solve'
  );
  assert.equal(
    hasUserFunction('class Bot { solve() { move(); } }\nconst b = new Bot();\nb.solve();'),
    true,
    'Must accept class method solve()'
  );
});

test('hasLoop: accepts loops that execute robot commands via helper functions or methods', () => {
  const helperFnCode = `
    function execute(cmd) {
      if (cmd === 'move') move();
      else if (cmd === 'turnRight') turnRight();
      else if (cmd === 'turnLeft') turnLeft();
    }
    for (const cmd of route) {
      execute(cmd);
    }
  `;
  assert.equal(
    hasLoop(helperFnCode),
    true,
    'Must accept loop calling helper function execute(cmd)'
  );

  const helperMethodCode = `
    const robot = {
      step(cmd) {
        if (cmd === 'move') move();
      }
    };
    for (const cmd of route) {
      robot.step(cmd);
    }
  `;
  assert.equal(
    hasLoop(helperMethodCode),
    true,
    'Must accept loop calling object method robot.step(cmd)'
  );
});

test('hasLoop: accepts route.forEach(execute) with named callback function', () => {
  const code = `
    function execute(cmd) {
      if (cmd === 'move') move();
      else if (cmd === 'turnRight') turnRight();
    }
    route.forEach(execute);
  `;
  assert.equal(hasLoop(code), true, 'Must accept route.forEach(execute)');
});

test('usesRoute: correctly validates active usage of route array', () => {
  assert.equal(usesRoute('for (const cmd of route) { move(); }'), true);
  assert.equal(usesRoute('route.forEach(cmd => { move(); })'), true);
  assert.equal(usesRoute('route.forEach(execute)'), true);
  assert.equal(usesRoute('for (let i = 0; i < route.length; i += 2) { execute(route[i]); }'), true);
  assert.equal(usesRoute('const r = route; for (const x of r) { move(); }'), true);
  assert.equal(usesRoute('executeRoute(route)'), true);
});

test('usesRoute: rejects code that does not reference route or only in dead code', () => {
  assert.equal(usesRoute('for (let i = 0; i < 41; i++) { move(); }'), false);
  assert.equal(usesRoute('if (false) { console.log(route); }\nmove();'), false);
  assert.equal(usesRoute('function solve() { move(); }\nsolve();'), false);
});

test('hasUserFunction: accepts valid functions passed as callbacks to repeat and iteration methods', () => {
  assert.equal(
    hasUserFunction('function myStep() { move(); }\nrepeat(3, myStep);'),
    true,
    'Must accept function passed to repeat(3, myStep)'
  );
  assert.equal(
    hasUserFunction('const step = () => move();\n[1, 2].forEach(step);'),
    true,
    'Must accept function passed to [1, 2].forEach(step)'
  );
  assert.equal(
    hasUserFunction('const bot = { step() { move(); } };\nrepeat(2, bot.step);'),
    true,
    'Must accept object method passed to repeat(2, bot.step)'
  );
  assert.equal(
    hasUserFunction('function makeStep() { return () => move(); }\nconst s = makeStep();\ns();'),
    true,
    'Must accept factory function returning action closure'
  );
});

test('hasLoop: accepts route.forEach(make()) callback factory', () => {
  const code = `
    function make() {
      return function(cmd) {
        if (cmd === 'move') move();
      };
    }
    route.forEach(make());
  `;
  assert.equal(hasLoop(code), true, 'Must accept route.forEach(make())');
  assert.equal(usesRoute(code), true, 'Must accept route in route.forEach(make())');
});

test('hasLoop and usesRoute: accepts factory returning named function identifier', () => {
  const code = `
    function execute(cmd) {
      if (cmd === 'move') move();
      else if (cmd === 'turnRight') turnRight();
    }
    function make() {
      return execute;
    }
    route.forEach(make());
  `;
  assert.equal(hasLoop(code), true, 'Must accept factory returning named function in hasLoop');
  assert.equal(usesRoute(code), true, 'Must accept factory returning named function in usesRoute');
});

test('hasLoop and usesRoute: accepts route passed into custom function runRoute(route)', () => {
  const code = `
    function runRoute(commands) {
      for (const cmd of commands) {
        if (cmd === 'move') move();
        else if (cmd === 'turnRight') turnRight();
      }
    }
    runRoute(route);
  `;
  assert.equal(usesRoute(code), true, 'Must recognize route passed to runRoute(route)');
  assert.equal(hasLoop(code), true, 'Must recognize loop inside runRoute(route)');
});

test('hasLoop and usesRoute: accepts spread copy of route [...route]', () => {
  const spreadVarCode = `
    const copy = [...route];
    for (const cmd of copy) {
      if (cmd === 'move') move();
    }
  `;
  assert.equal(usesRoute(spreadVarCode), true, 'Must recognize const copy = [...route]');
  assert.equal(hasLoop(spreadVarCode), true, 'Must recognize loop over copy');

  const inlineSpreadCode = `
    for (const cmd of [...route]) {
      if (cmd === 'move') move();
    }
  `;
  assert.equal(usesRoute(inlineSpreadCode), true, 'Must recognize loop over inline [...route]');
  assert.equal(hasLoop(inlineSpreadCode), true, 'Must recognize loop');
});

test('hasLoop, usesRoute, and hasUserFunction: accepts concise arrow function factory const make = () => execute', () => {
  const code = `
    const execute = (cmd) => {
      if (cmd === 'move') move();
      else if (cmd === 'turnRight') turnRight();
    };
    const make = () => execute;
    route.forEach(make());
  `;
  assert.equal(hasUserFunction(code), true, 'Must accept concise arrow factory in hasUserFunction');
  assert.equal(hasLoop(code), true, 'Must accept concise arrow factory in hasLoop');
  assert.equal(usesRoute(code), true, 'Must accept concise arrow factory in usesRoute');
});

test('hasLoop, usesRoute, and hasUserFunction: accepts function assigned after declaration let runRoute; runRoute = ...', () => {
  const code = `
    let runRoute;
    runRoute = function(commands) {
      commands.forEach(cmd => {
        if (cmd === 'move') move();
        else if (cmd === 'turnRight') turnRight();
      });
    };
    runRoute(route);
  `;
  assert.equal(hasUserFunction(code), true, 'Must recognize assigned function in hasUserFunction');
  assert.equal(usesRoute(code), true, 'Must recognize route passed to assigned function in usesRoute');
  assert.equal(hasLoop(code), true, 'Must recognize loop inside assigned function in hasLoop');
});

test('hasUserFunction: accepts concise arrow functions const go = () => move()', () => {
  const code = `
    const go = () => move();
    go();
  `;
  assert.equal(hasUserFunction(code), true, 'Must accept concise arrow function');
});

test('hasUserFunction: accepts function alias const run = solve; run()', () => {
  const code = `
    function solve() {
      move();
      turnRight();
    }
    const run = solve;
    run();
  `;
  assert.equal(hasUserFunction(code), true, 'Must accept function alias const run = solve; run()');
});

test('hasLoop and usesRoute: accepts callback alias const handler = execute; route.forEach(handler)', () => {
  const code = `
    function execute(cmd) {
      if (cmd === 'move') move();
      else turnRight();
    }
    const handler = execute;
    route.forEach(handler);
  `;
  assert.equal(hasLoop(code), true, 'Must accept callback alias in hasLoop');
  assert.equal(usesRoute(code), true, 'Must accept callback alias in usesRoute');
});

test('hasLoop, usesRoute, and hasUserFunction: accepts actions[cmd]() action map with commands and arrow functions', () => {
  const codeDirectCmds = `
    const actions = {
      move,
      turnRight,
      turnLeft,
    };
    function execute(cmd) {
      actions[cmd]();
    }
    const handler = execute;
    route.forEach(handler);
  `;
  assert.equal(hasLoop(codeDirectCmds), true, 'Must accept actions[cmd]() with direct commands in hasLoop');
  assert.equal(usesRoute(codeDirectCmds), true, 'Must accept actions[cmd]() with direct commands in usesRoute');
  assert.equal(hasUserFunction(codeDirectCmds), true, 'Must accept actions[cmd]() with direct commands in hasUserFunction');

  const codeArrowMap = `
    const actions = {
      'M': () => move(),
      'R': () => turnRight(),
    };
    route.forEach(cmd => {
      actions[cmd]();
    });
  `;
  assert.equal(hasLoop(codeArrowMap), true, 'Must accept actions[cmd]() with arrow functions in hasLoop');
  assert.equal(usesRoute(codeArrowMap), true, 'Must accept actions[cmd]() with arrow functions in usesRoute');
});

test('hasLoop: accepts route loops with up to 7 non-loop robot setup calls', () => {
  const code = `
    turnRight();
    turnLeft();
    for (const cmd of route) {
      if (cmd === 'move') move();
    }
  `;
  assert.equal(hasLoop(code), true, 'Must accept route loop with 2 setup robot calls');
  assert.equal(usesRoute(code), true, 'Must recognize route in loop');
});

test('P2: accepts execute.bind(null) in route.forEach(handler) on Level 5', () => {
  const code = `
    function execute(cmd) {
      if (cmd === 'move') move();
      else if (cmd === 'turnRight') turnRight();
      else if (cmd === 'turnLeft') turnLeft();
    }
    const handler = execute.bind(null);
    route.forEach(handler);
  `;
  assert.equal(hasLoop(code), true, 'Must accept route.forEach(handler) where handler = execute.bind(null)');
  assert.equal(usesRoute(code), true, 'Must accept route in route.forEach(handler)');
  assert.equal(hasUserFunction(code), true, 'Must recognize execute as a user function');
});

test('P2: accepts function destructuring on Level 4 in hasUserFunction', () => {
  const codeObjDestructure = `
    const robot = {
      solve() {
        move();
        turnRight();
      }
    };
    const { solve: run } = robot;
    run();
  `;
  assert.equal(hasUserFunction(codeObjDestructure), true, 'Must accept renamed destructured method const { solve: run } = robot');

  const codeInlineObjDestructure = `
    const { solve } = {
      solve() {
        move();
      }
    };
    solve();
  `;
  assert.equal(hasUserFunction(codeInlineObjDestructure), true, 'Must accept inline object destructured function');

  const codeArrayDestructure = `
    const [step] = [() => { move(); }];
    step();
  `;
  assert.equal(hasUserFunction(codeArrayDestructure), true, 'Must accept array destructured arrow function');

  const codeBoundDestructure = `
    function solve() {
      move();
    }
    const run = solve.bind(null);
    run();
  `;
  assert.equal(hasUserFunction(codeBoundDestructure), true, 'Must accept bound function alias const run = solve.bind(null)');
});

test('P2: accepts dynamically populated command tables on Level 5', () => {
  const codePropertyAssign = `
    const actions = {};
    actions.move = move;
    actions.turnRight = turnRight;
    actions.turnLeft = turnLeft;
    route.forEach(cmd => actions[cmd]());
  `;
  assert.equal(hasLoop(codePropertyAssign), true, 'Must accept actions[cmd]() with property assignment');
  assert.equal(usesRoute(codePropertyAssign), true, 'Must accept usesRoute with property assignment');

  const codeBracketAssign = `
    const actions = {};
    actions['move'] = () => move();
    actions['turnRight'] = () => turnRight();
    actions['turnLeft'] = () => turnLeft();
    route.forEach(cmd => actions[cmd]());
  `;
  assert.equal(hasLoop(codeBracketAssign), true, 'Must accept actions[cmd]() with bracket assignment');
  assert.equal(usesRoute(codeBracketAssign), true, 'Must accept usesRoute with bracket assignment');

  const codeObjectAssign = `
    const actions = {};
    Object.assign(actions, { move, turnRight, turnLeft });
    route.forEach(cmd => actions[cmd]());
  `;
  assert.equal(hasLoop(codeObjectAssign), true, 'Must accept actions[cmd]() with Object.assign');
  assert.equal(usesRoute(codeObjectAssign), true, 'Must accept usesRoute with Object.assign');

  const codeMapGet = `
    const actions = new Map([
      ['move', move],
      ['turnRight', turnRight],
      ['turnLeft', turnLeft]
    ]);
    route.forEach(cmd => actions.get(cmd)());
  `;
  assert.equal(hasLoop(codeMapGet), true, 'Must accept actions.get(cmd)() with Map');
  assert.equal(usesRoute(codeMapGet), true, 'Must accept usesRoute with Map');
});

test('P3: accepts Object.freeze, Object.seal, Object.preventExtensions action map on Level 5', () => {
  const codeFreeze = `
    const actions = Object.freeze({ move, turnLeft, turnRight });
    for (const cmd of route) {
      actions[cmd]();
    }
  `;
  assert.equal(hasLoop(codeFreeze), true, 'Must accept hasLoop with Object.freeze action map');
  assert.equal(usesRoute(codeFreeze), true, 'Must accept usesRoute with Object.freeze action map');

  const codeSeal = `
    const actions = Object.seal({ move, turnLeft, turnRight });
    for (const cmd of route) {
      actions[cmd]();
    }
  `;
  assert.equal(hasLoop(codeSeal), true, 'Must accept hasLoop with Object.seal action map');
  assert.equal(usesRoute(codeSeal), true, 'Must accept usesRoute with Object.seal action map');

  const codePreventExtensions = `
    const actions = Object.preventExtensions({ move, turnLeft, turnRight });
    for (const cmd of route) {
      actions[cmd]();
    }
  `;
  assert.equal(hasLoop(codePreventExtensions), true, 'Must accept hasLoop with Object.preventExtensions action map');
  assert.equal(usesRoute(codePreventExtensions), true, 'Must accept usesRoute with Object.preventExtensions action map');
});

test('P2: Issue 3 - Level 4 accepts function invoking passed command callback', () => {
  const code = `
    function execute(action) {
      action();
    }
    execute(move);
    execute(turnRight);
    execute(move);
  `;
  assert.equal(hasUserFunction(code), true, 'hasUserFunction must accept callback parameter execution');
});

test('P2: Issue 4 - Level 5 accepts route["forEach"] bracket notation', () => {
  const code = `
    function execute(cmd) {
      if (cmd === 'move') move();
    }
    route['forEach'](execute);
  `;
  assert.equal(hasLoop(code), true, 'hasLoop must recognize route["forEach"]');
  assert.equal(usesRoute(code), true, 'usesRoute must recognize route["forEach"]');
});

test('P2: Issue 5 - Level 5 tracks route when run function is called via alias const go = run', () => {
  const code = `
    function run(commands) {
      for (const cmd of commands) {
        if (cmd === 'move') move();
        else if (cmd === 'turnRight') turnRight();
        else if (cmd === 'turnLeft') turnLeft();
      }
    }
    const go = run;
    go(route);
  `;
  assert.equal(hasLoop(code), true, 'hasLoop must recognize go(route)');
  assert.equal(usesRoute(code), true, 'usesRoute must recognize go(route)');
});

test('P2: Issue 6 - Level 5 uncalled dead function does not trigger nonLoopRobotCalls failure', () => {
  const code = `
    function oldSolution() {
      move(); move(); move(); move();
      move(); move(); move(); move();
    }
    for (const cmd of route) {
      if (cmd === 'move') move();
    }
  `;
  assert.equal(hasLoop(code), true, 'hasLoop must ignore robot commands inside uncalled functions');
});

test('P2: Issue 7 - Level 5 rejects reduce cheat where commands are executed in initial accumulator', () => {
  const code = `
    route.reduce((acc, cmd) => acc, function () {
      move(); move(); move(); move();
      move(); move(); move(); move();
    })();
  `;
  assert.equal(hasLoop(code), false, 'hasLoop must reject reduce with commands only in initial accumulator');
  assert.equal(usesRoute(code), false, 'usesRoute must reject reduce with commands only in initial accumulator');
});

test('P2: Issue 8 - Shared parameter names across functions do not falsely link to route', () => {
  const code = `
    function inspect(commands) { return commands.length; }
    inspect(route);

    function run(commands) {
      for (const cmd of commands) {
        if (cmd === 'move') move();
        else if (cmd === 'turnRight') turnRight();
        else if (cmd === 'turnLeft') turnLeft();
      }
    }
    run(['move']);
  `;
  assert.equal(usesRoute(code), false, 'usesRoute must reject separate function with identical parameter name');
});

test('Level 5: recognizes queue/stack loops using route.shift() and route.pop() in usesRoute and hasLoop', () => {
  const codeWhileLengthShift = `
    while (route.length > 0) {
      const c = route.shift();
      if (c === 'move') move();
    }
  `;
  assert.equal(hasLoop(codeWhileLengthShift), true);
  assert.equal(usesRoute(codeWhileLengthShift), true);

  const codeWhileAssignShift = `
    let c;
    while ((c = route.shift())) {
      if (c === 'move') move();
    }
  `;
  assert.equal(hasLoop(codeWhileAssignShift), true);
  assert.equal(usesRoute(codeWhileAssignShift), true);

  const codeForShift = `
    for (let c = route.shift(); c; c = route.shift()) {
      if (c === 'move') move();
    }
  `;
  assert.equal(hasLoop(codeForShift), true);
  assert.equal(usesRoute(codeForShift), true);

  const codeWhilePop = `
    while (route.length > 0) {
      const c = route.pop();
      if (c === 'move') move();
    }
  `;
  assert.equal(hasLoop(codeWhilePop), true);
  assert.equal(usesRoute(codeWhilePop), true);
});

test('Level 4: concise arrow functions without curly braces using map or forEach are recognized in hasUserFunction', () => {
  const codeMap = `
    const go = (n) => [...Array(n)].map(() => move());
    go(29);
  `;
  assert.equal(hasUserFunction(codeMap), true, 'Concise arrow with .map(() => move()) must satisfy hasUserFunction');

  const codeForEach = `
    const go = (n) => [...Array(n)].forEach(() => move());
    go(29);
  `;
  assert.equal(hasUserFunction(codeForEach), true, 'Concise arrow with .forEach(() => move()) must satisfy hasUserFunction');

  const codeForEachAction = `
    const go = (n) => [...Array(n)].forEach(move);
    go(29);
  `;
  assert.equal(hasUserFunction(codeForEachAction), true, 'Concise arrow with .forEach(move) must satisfy hasUserFunction');
});

test('hasLoop: correctly handles arrow functions, nested helper calls, and dead code without false rejections', () => {
  const codeArrowInLoop = `
    const helper = () => {
      move(); move(); move(); move(); move(); move(); move(); move();
    };
    for (const cmd of route) {
      helper();
    }
  `;
  assert.equal(hasLoop(codeArrowInLoop), true, 'Arrow helper called inside loop must satisfy hasLoop');

  const codeNestedInLoop = `
    function step() {
      subStep();
    }
    function subStep() {
      move(); move(); move(); move(); move(); move(); move(); move();
    }
    for (let i = 0; i < 5; i++) {
      step();
    }
  `;
  assert.equal(hasLoop(codeNestedInLoop), true, 'Nested functions called inside loop must satisfy hasLoop');

  const codeDeadArrow = `
    const unused = () => {
      move(); move(); move(); move(); move(); move(); move(); move();
    };
    for (let i = 0; i < 5; i++) {
      move();
    }
  `;
  assert.equal(hasLoop(codeDeadArrow), true, 'Unused arrow helper with 8+ commands must not cause false rejection');

  const codeCheatOutsideLoop = `
    const cheat = () => {
      move(); move(); move(); move(); move(); move(); move(); move(); move();
    };
    for (let i = 0; i < 1; i++) {
      move();
    }
    cheat();
  `;
  assert.equal(hasLoop(codeCheatOutsideLoop), false, 'Helper with 8+ moves called outside loop must be rejected');
});

test('usesRoute: closures still see route aliases of their enclosing function', () => {
  const exec = `function exec(c) { if (c === 'move') move(); else turnRight(); }\n`;
  const variants = [
    `function run() { const r = route; const inner = () => { for (const c of r) exec(c); }; inner(); }\nrun();`,
    `function run() { const r = route; function step() { r.forEach(c => exec(c)); } step(); }\nrun();`,
    `(() => { const r = route; (() => { for (let i = 0; i < r.length; i++) exec(r[i]); })(); })();`,
    `function run() { const r = route; const inner = () => { const r2 = r; for (const c of r2) exec(c); }; inner(); }\nrun();`,
  ];
  for (const body of variants) {
    const code = `const route = ['move', 'turnRight'];\n${exec}${body}`;
    assert.equal(usesRoute(code), true, body);
  }
});

test('validators stay fast on a long route alias chain assigned in reverse order', () => {
  let code = 'const route = ["move"];\n';
  for (let i = 1; i <= 800; i += 1) code += `let a${i};\n`;
  for (let i = 800; i >= 2; i -= 1) code += `a${i} = a${i - 1};\n`;
  code += 'a1 = route;\nfor (const x of a800) move();\n';

  const started = Date.now();
  assert.equal(usesRoute(code), true);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 3000, `usesRoute took ${elapsed} ms on an 800-alias chain`);
});

test('validators stay fast on a long helper chain declared in reverse order', () => {
  // f700 -> f699 -> ... -> f0 -> move(): each fixed-point pass discovers one more function,
  // which took ~15 s when every pass re-walked the whole AST.
  let code = '';
  for (let i = 700; i >= 1; i -= 1) code += `function f${i}(){ f${i - 1}(); }\n`;
  code += 'function f0(){ move(); }\nf700();\n';

  const started = Date.now();
  assert.equal(hasUserFunction(code), true);
  hasLoop(code);
  usesRoute(code);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 3000, `validators took ${elapsed} ms on a 700-function chain`);
});

test('R3: Level 4 accepts valid callback passed through intermediary function', () => {
  const code = `
    function helper(fn) { fn(); }
    function step() { move(); }
    helper(step);
  `;
  assert.equal(hasUserFunction(code), true);
});

test('R4: Level 5 recognizes computed iteration method name in usesRoute and hasLoop', () => {
  assert.equal(usesRoute("const m = 'forEach'; route[m](cmd => move());"), true);
  assert.equal(hasLoop("const m = 'forEach'; route[m](cmd => move());"), true);
  assert.equal(usesRoute("const m = 'Each'; route[`for${m}`](cmd => move());"), true);
  assert.equal(hasLoop("const m = 'Each'; route[`for${m}`](cmd => move());"), true);
});

test('R5: Level 5 recognizes route alias via default parameter, return, bind/call/apply', () => {
  // default parameter
  assert.equal(usesRoute('function run(r = route) { for (const c of r) move(); } run();'), true);
  assert.equal(hasLoop('function run(r = route) { for (const c of r) move(); } run();'), true);

  // function returning route
  assert.equal(usesRoute('function getRoute() { return route; } for (const c of getRoute()) move();'), true);
  assert.equal(hasLoop('function getRoute() { return route; } for (const c of getRoute()) move();'), true);

  // .call
  assert.equal(usesRoute('function iter(r) { for (const c of r) move(); } iter.call(null, route);'), true);
  assert.equal(hasLoop('function iter(r) { for (const c of r) move(); } iter.call(null, route);'), true);

  // .apply
  assert.equal(usesRoute('function iter(r) { for (const c of r) move(); } iter.apply(null, [route]);'), true);
  assert.equal(hasLoop('function iter(r) { for (const c of r) move(); } iter.apply(null, [route]);'), true);

  // .bind
  assert.equal(usesRoute('const iter = function(r) { for (const c of r) move(); }.bind(null, route); iter();'), true);
  assert.equal(hasLoop('const iter = function(r) { for (const c of r) move(); }.bind(null, route); iter();'), true);
});

test('R6: Level 5 does not count unreachable commands after return or uncalled callbacks', () => {
  const codeDeadReturn = `
    function helper() {
      return;
      move();
      turnRight();
      turnLeft();
      move();
      move();
      move();
      move();
      move();
    }
    helper();
    for (const c of route) move();
  `;
  assert.equal(hasLoop(codeDeadReturn), true);

  const codeUncalledCb = `
    function dummy(cb) {}
    for (let i = 0; i < 10; i++) {
      dummy(() => { move(); turnRight(); });
    }
    for (const c of route) move();
  `;
  assert.equal(hasLoop(codeUncalledCb), true);
});

test('R7: Level 5 rejects non-route array on name collision/shadowing and reassignment', () => {
  // Shadowed parameter called with non-route array
  const codeShadow = 'function solve(route) { for (const c of route) move(); } solve([1, 2, 3]);';
  assert.equal(usesRoute(codeShadow), false);

  // Reassignment to non-route array
  const codeReassign = 'let myRoute = route; myRoute = [1, 2, 3]; for (const c of myRoute) move();';
  assert.equal(usesRoute(codeReassign), false);
});

test('Level 6: usesInstructions detects instruction loop usage and rejects plain hardcoded commands', () => {
  const codeGoodForOf = `
    for (const step of instructions) {
      if (step.command === 'move') {
        for (let i = 0; i < (step.steps || 1); i++) move();
      } else if (step.command === 'turnRight') {
        turnRight();
      }
    }
  `;
  assert.equal(usesInstructions(codeGoodForOf), true);
  assert.equal(hasLoop(codeGoodForOf), true);

  const codeGoodForEach = `
    instructions.forEach(({ command, steps = 1 }) => {
      if (command === 'move') {
        repeat(steps, move);
      }
    });
  `;
  assert.equal(usesInstructions(codeGoodForEach), true);
  assert.equal(hasLoop(codeGoodForEach), true);

  const codeHardcodedOnly = `
    move();
    move();
    turnRight();
    move();
    turnLeft();
  `;
  assert.equal(usesInstructions(codeHardcodedOnly), false);
  assert.equal(hasLoop(codeHardcodedOnly), false);

  // Mentioning instructions without accessing properties or accessing unrelated command property without instructions must fail
  assert.equal(usesInstructions('console.log(instructions); move();'), false);
  assert.equal(usesInstructions('const x = { command: "move" }; move();'), false);
  assert.equal(usesInstructions('if (false) { instructions[0].command; } move();'), false);

  // Both have to happen in a loop over instructions: reading a command there and moving the robot.
  assert.equal(usesInstructions('instructions;\nconst x = { command: 1 };\nmove(11);'), false);
  assert.equal(usesInstructions('for (const s of instructions) { s.command; }\nmove();'), false);
  assert.equal(usesInstructions('for (const s of instructions) { move(); }\nconst x = { command: 1 };'), false);
  assert.equal(usesInstructions('const list = [{ command: "move" }];\nfor (const s of list) exec(s.command);'), false);
  assert.equal(usesInstructions('for (let i = 0; i < instructions.length; i++) exec(instructions[i].command);'), true);
  assert.equal(usesInstructions('const actions = { move, turnLeft, turnRight };\nfor (const { command } of instructions) actions[command]();'), true);
  assert.equal(usesInstructions('instructions.map(s => s["command"]).forEach(c => exec(c));\nfunction exec(c) {}'), true);
  assert.equal(usesInstructions('for (const c of instructions.map(s => s.command)) exec(c);'), true);
  assert.equal(usesInstructions('instructions.forEach(s => {});\nconst x = { command: 1 };\nmove();'), false);
  assert.equal(usesInstructions('instructions.forEach(s => exec(s.command));'), true);
});



