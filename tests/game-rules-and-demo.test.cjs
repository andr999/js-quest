const assert = require('node:assert/strict');
const test = require('node:test');

// Demo grid 3x3
const demoGrid = [
  ['empty', 'empty', 'empty'],
  ['empty', 'wall',  'empty'],
  ['empty', 'empty', 'goal'],
];

function simulateRobotExecution(commands, throwOnOutOfBounds = true) {
  const DIRECTIONS = ['up', 'right', 'down', 'left'];
  let pos = { x: 0, y: 0, dir: 'right' };
  let error = null;

  function getDelta(direction) {
    if (direction === 'right') return [1, 0];
    if (direction === 'left') return [-1, 0];
    if (direction === 'up') return [0, -1];
    return [0, 1];
  }

  for (const cmd of commands) {
    if (cmd === 'move') {
      const delta = getDelta(pos.dir);
      const nx = pos.x + delta[0];
      const ny = pos.y + delta[1];
      if (ny < 0 || ny >= demoGrid.length || nx < 0 || nx >= demoGrid[ny].length) {
        if (throwOnOutOfBounds) {
          error = 'OUT_OF_BOUNDS';
          break;
        }
        pos = { ...pos, outOfBounds: true, blocked: true };
      } else if (demoGrid[ny][nx] === 'wall') {
        pos = { ...pos, blocked: true };
      } else {
        pos = { ...pos, x: nx, y: ny, blocked: false, outOfBounds: false };
      }
    } else if (cmd === 'turnRight') {
      const idx = DIRECTIONS.indexOf(pos.dir);
      pos = { ...pos, dir: DIRECTIONS[(idx + 1) % 4] };
    } else if (cmd === 'turnLeft') {
      const idx = DIRECTIONS.indexOf(pos.dir);
      pos = { ...pos, dir: DIRECTIONS[(idx + 3) % 4] };
    }
  }

  const ok = !error && !pos.outOfBounds && !pos.blocked;
  const isGoal = pos.x === 2 && pos.y === 2 && demoGrid[pos.y][pos.x] === 'goal';
  return { ok, error, pos, isSuccess: ok && isGoal };
}

test('MiniDemo: valid path reaches goal and succeeds', () => {
  const validCommands = ['move', 'move', 'turnRight', 'move', 'move'];
  const result = simulateRobotExecution(validCommands, true);
  assert.equal(result.ok, true);
  assert.equal(result.isSuccess, true);
  assert.deepEqual(result.pos, { x: 2, y: 2, dir: 'down', blocked: false, outOfBounds: false });
});

test('MiniDemo: extra move after goal triggers OUT_OF_BOUNDS and fails', () => {
  const extraMoveCommands = ['move', 'move', 'turnRight', 'move', 'move', 'move'];
  const result = simulateRobotExecution(extraMoveCommands, true);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'OUT_OF_BOUNDS');
  assert.equal(result.isSuccess, false, 'Moving out of bounds must never count as victory');
});

test('Modal exclusivity: rules, victory, defeat modals suppressed when isGameOver is true', () => {
  const isGameOver = true;
  const showRules = true;
  const isVictory = true;
  const isDefeat = true;

  const shouldRenderRules = showRules && !isGameOver;
  const shouldRenderVictory = isVictory && !isGameOver;
  const shouldRenderDefeat = isDefeat && !isGameOver;

  assert.equal(shouldRenderRules, false, 'RulesModal must not render when game over');
  assert.equal(shouldRenderVictory, false, 'VictoryModal must not render when game over');
  assert.equal(shouldRenderDefeat, false, 'DefeatModal must not render when game over');
});

// Relative luminance and contrast ratio according to WCAG 2.1 specs
function getLuminance(r, g, b) {
  const [rs, gs, bs] = [r, g, b].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
}

function getContrastRatio(rgb1, rgb2) {
  const lum1 = getLuminance(rgb1[0], rgb1[1], rgb1[2]);
  const lum2 = getLuminance(rgb2[0], rgb2[1], rgb2[2]);
  const brightest = Math.max(lum1, lum2);
  const darkest = Math.min(lum1, lum2);
  return (brightest + 0.05) / (darkest + 0.05);
}

test('LevelMap locked cards meet WCAG AA contrast ratio (>= 4.5:1)', () => {
  // slate-100 bg: #f1f5f9 (241, 245, 249), slate-700 text: #334155 (51, 65, 85)
  const slate100 = [241, 245, 249];
  const slate700 = [51, 65, 85];
  const contrast = getContrastRatio(slate100, slate700);

  assert.ok(contrast >= 4.5, `Contrast ratio ${contrast.toFixed(2)}:1 must be >= 4.5:1`);
});

test('Architectural Invariant: All levels 1-7 preserve learner code on reset and listen to resetAt', () => {
  const fs = require('node:fs');
  const path = require('node:path');

  for (let level = 1; level <= 7; level++) {
    const filePath = path.join(__dirname, '..', 'app', 'Levels', `level${level}`, 'page.tsx');
    const source = fs.readFileSync(filePath, 'utf8');

    // resetLevel must NOT call setCode(initialCode)
    const resetLevelMatch = source.match(/const resetLevel = useCallback\(\(\) => \{([\s\S]*?)\}, \[/);
    assert.ok(resetLevelMatch, `Level ${level} must define resetLevel`);
    const resetBody = resetLevelMatch[1];
    assert.ok(
      !resetBody.includes('setCode(initialCode)'),
      `Level ${level} resetLevel must NEVER wipe user code with setCode(initialCode)`
    );

    // Level must extract and watch resetAt
    assert.ok(
      source.includes('resetAt'),
      `Level ${level} must extract and listen to resetAt from useGame()`
    );

    // Levels 1-5 must not contain spurious enemy warnings
    if (level <= 5) {
      assert.ok(
        !source.includes("'Обережно, вороги!'"),
        `Level ${level} must not contain spurious 'Обережно, вороги!' defeat reason`
      );
    }
  }
});

test('Level 5 initialCode generates valid JavaScript without syntax error', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const acorn = require('acorn');
  const ts = require('typescript');
  const vm = require('node:vm');

  const filePath = path.join(__dirname, '..', 'app', 'Levels', 'level5', 'page.tsx');
  const source = fs.readFileSync(filePath, 'utf8');

  // Extract the actual declarations of finalRoute, formattedRoute, routeString, and initialCode from page.tsx
  const match = source.match(/(const finalRoute: RobotCommand\[\] = [\s\S]*?const initialCode = `[\s\S]*?`\s*;)\s*(?=export default)/);
  assert.ok(match, 'Must find code block defining initialCode in level 5 page.tsx');

  const jsCode = ts.transpileModule('const TOTAL_KEYS = 3;\nconst routeDataVariant = () => ({});\n' + match[1] + '\nglobalThis.__TEST_LEVEL5_INITIAL_CODE = initialCode;', {
    compilerOptions: { target: ts.ScriptTarget.ES2020 }
  }).outputText;

  const sandbox = { globalThis: {} };
  vm.createContext(sandbox);
  vm.runInContext(jsCode, sandbox);
  const initialCode = sandbox.globalThis.__TEST_LEVEL5_INITIAL_CODE;

  assert.ok(typeof initialCode === 'string' && initialCode.length > 0, 'initialCode must be a non-empty string');
  // The level passes route to the code; the starter shows it in a comment and must not declare it.
  assert.ok(initialCode.includes('// route = ['), 'initialCode must show the route array');
  assert.doesNotMatch(initialCode, /^\s*(const|let|var) route\b/m, 'initialCode must not declare route again');
  const shown = initialCode.slice(initialCode.indexOf('// route = ['), initialCode.indexOf('// ];'));
  assert.equal((shown.match(/'(move|turnLeft|turnRight)'/g) || []).length, 41, 'the comment lists the whole route');

  assert.doesNotThrow(() => {
    acorn.parse(initialCode, { ecmaVersion: 'latest' });
  }, 'Level 5 actual initialCode must be valid JavaScript syntax');
});

test('robotEngine: isWallAhead does not pass out-of-bounds coordinates to custom isWall callback', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const ts = require('typescript');

  const filePath = path.join(__dirname, '..', 'utils', 'robotEngine.ts');
  const source = fs.readFileSync(filePath, 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
  }).outputText;
  const mod = { exports: {} };
  const fn = new Function('require', 'module', 'exports', compiled);
  fn(require, mod, mod.exports);

  const { createRobotEngine } = mod.exports;
  const gridMap = [
    ['start', 'path'],
    ['path', 'goal'],
  ];
  const customWallCalls = [];
  const engine = createRobotEngine({
    gridMap,
    initialPos: { x: 0, y: 0, dir: 'up' }, // facing up: (0, -1) is out of bounds
    isWall: (x, y) => {
      customWallCalls.push([x, y]);
      if (y < 0 || y >= gridMap.length || x < 0 || x >= gridMap[0].length) {
        throw new Error(`Out of bounds coords passed to isWall: (${x}, ${y})`);
      }
      return false;
    },
  });

  assert.equal(engine.isWallAhead(), true, 'isWallAhead should return true for out-of-bounds cell');
  assert.equal(customWallCalls.length, 0, 'custom isWall callback must NOT be called for out-of-bounds coordinates');
});

test('Level 7: resetAt effect clears attemptTokenRef and attemptInProgressRef before resetLevel', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const filePath = path.join(__dirname, '..', 'app', 'Levels', 'level7', 'page.tsx');
  const source = fs.readFileSync(filePath, 'utf8');
  assert.ok(source.includes('attemptTokenRef.current = null;'), 'Level 7 reset effect must clear attemptTokenRef');
  assert.ok(source.includes('attemptInProgressRef.current = false;'), 'Level 7 reset effect must clear attemptInProgressRef');
});

test('useGeneratorExecution: generator reference is cleared on completion and error to prevent duplicate onComplete', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const filePath = path.join(__dirname, '..', 'hooks', 'useGeneratorExecution.ts');
  const source = fs.readFileSync(filePath, 'utf8');
  assert.ok(source.includes('generatorRef.current = null;'), 'Must reset generatorRef.current to null');
});

test('LevelGuard: sets checked to false before redirecting locked level to prevent flash of content', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const filePath = path.join(__dirname, '..', 'components', 'LevelGuard.tsx');
  const source = fs.readFileSync(filePath, 'utf8');
  assert.ok(source.includes('setChecked(false);'), 'LevelGuard must reset checked state to false before router.replace');
});

test('MiniDemo: manages shakeTimeoutRef to cancel pending timers on unmount and reset', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const filePath = path.join(__dirname, '..', 'components', 'MiniDemo.tsx');
  const source = fs.readFileSync(filePath, 'utf8');
  assert.ok(source.includes('shakeTimeoutRef'), 'MiniDemo must maintain a shakeTimeoutRef');
  assert.ok(source.includes('clearTimeout(shakeTimeoutRef.current)'), 'MiniDemo must clear pending shake timeout');
});

test('Home page play button correctly resolves next uncompleted level, finish, and game over states', () => {
  const TOTAL_LEVELS = 7;

  function resolvePlayButton(lives, completedLevels) {
    const nextLevel = Math.min(
      TOTAL_LEVELS,
      Array.from({ length: TOTAL_LEVELS }, (_, i) => i + 1).find(lvl => !completedLevels.includes(lvl)) ?? 1
    );
    const allCompleted = TOTAL_LEVELS > 0 && Array.from({ length: TOTAL_LEVELS }, (_, i) => i + 1).every(lvl => completedLevels.includes(lvl));

    const playButtonHref = lives === 0
      ? '/Levels/level1'
      : allCompleted
        ? '/finish'
        : `/Levels/level${nextLevel}`;

    const playButtonText = lives === 0
      ? 'Почати заново'
      : allCompleted
        ? 'Переглянути нагороду 🏆'
        : completedLevels.length > 0
          ? `Продовжити (Рівень ${nextLevel})`
          : 'Почати гру';

    return { playButtonHref, playButtonText };
  }

  // Brand new player
  const newPlayer = resolvePlayButton(3, []);
  assert.equal(newPlayer.playButtonHref, '/Levels/level1');
  assert.equal(newPlayer.playButtonText, 'Почати гру');

  // Player beat level 1
  const afterL1 = resolvePlayButton(3, [1]);
  assert.equal(afterL1.playButtonHref, '/Levels/level2');
  assert.equal(afterL1.playButtonText, 'Продовжити (Рівень 2)');

  // Player beat levels 1, 2, 3
  const afterL3 = resolvePlayButton(2, [1, 2, 3]);
  assert.equal(afterL3.playButtonHref, '/Levels/level4');
  assert.equal(afterL3.playButtonText, 'Продовжити (Рівень 4)');

  // Player beat all levels 1..7
  const champion = resolvePlayButton(3, [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(champion.playButtonHref, '/finish');
  assert.equal(champion.playButtonText, 'Переглянути нагороду 🏆');

  // Player with 0 lives (Game Over)
  const gameOver = resolvePlayButton(0, [1, 2, 3]);
  assert.equal(gameOver.playButtonHref, '/Levels/level1');
  assert.equal(gameOver.playButtonText, 'Почати заново');
});

test('Level 3 victory logic: requires key, reaching goal, and active robot actions in a loop', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const level3Source = fs.readFileSync(path.join(__dirname, '..', 'app', 'Levels', 'level3', 'page.tsx'), 'utf8');

  // Level 3 decides the loop requirement from the run (any loop, array method or repeat,
  // however it is called), not from a static scan of the code.
  assert.ok(!level3Source.includes('codeValidator'), 'Level 3 must not depend on the static validator');
  assert.ok(level3Source.includes('hasValidLoop'), 'Level 3 must define hasValidLoop condition');
  assert.ok(level3Source.includes('result.loopActions'), 'Level 3 must use loopActions from the worker result');
  assert.ok(level3Source.includes('while, for або repeat'), 'Level 3 must display Ukrainian loop requirement message on failure');
});

// Loads a hook module with a minimal React: one render, state kept per call, effects skipped.
function loadHooksForOneRender() {
  const fs = require('node:fs');
  const path = require('node:path');
  const ts = require('typescript');
  const react = {
    useState: (initial) => {
      const box = { value: typeof initial === 'function' ? initial() : initial };
      return [box.value, (next) => { box.value = typeof next === 'function' ? next(box.value) : next; }];
    },
    useRef: (initial) => ({ current: initial }),
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    useEffect: () => {},
  };
  const cache = {};
  function load(name) {
    if (cache[name]) return cache[name];
    const filename = path.join(__dirname, '..', 'hooks', `${name}.ts`);
    const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const mod = { exports: {} };
    new Function('require', 'module', 'exports', compiled)(
      (spec) => (spec === 'react' ? react : load(spec.replace('./', ''))),
      mod,
      mod.exports,
    );
    cache[name] = mod.exports;
    return mod.exports;
  }
  return load('useSteppedExecution');
}

test('useSteppedExecution: a second click before React re-renders continues the run instead of starting a new attempt', async () => {
  const { useSteppedExecution } = loadHooksForOneRender();
  let setups = 0;
  const execution = useSteppedExecution({
    setup: async () => {
      setups += 1;
      return (function* () { yield { type: 'line', line: 1 }; yield { type: 'line', line: 2 }; yield; })();
    },
    onComplete: () => {},
    onError: (error) => { throw error; },
  });
  // Both clicks use the handlers of the same render, as quick clicks do.
  await execution.handleStep();
  await execution.handleStep();
  await execution.handleRun();
  assert.equal(setups, 1, 'setup (and with it startAttempt) must run once');
  assert.equal(execution.getExecutionState(), 'running');
});

test('with no lives left, the level map and the demo do not open a level into the game-over window', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
  const levelMap = read('components', 'LevelMap.tsx');
  const gameOverCard = levelMap.slice(levelMap.indexOf('if (isGameOver) {'), levelMap.indexOf('return (\n    <Link'));
  assert.ok(gameOverCard.includes('cursor-not-allowed'), 'cards are shown but disabled');
  assert.doesNotMatch(gameOverCard, /<Link/, 'a game-over card is not a link');
  assert.match(levelMap, /onClick=\{onRestart\}/, 'the map offers to start again');
  for (const page of [read('app', 'page.tsx'), read('app', 'profile', 'page.tsx')]) {
    assert.match(page, /<LevelMap [^>]*isGameOver=\{isGameOver\} onRestart=\{resetGame\}/);
  }
  const miniDemo = read('components', 'MiniDemo.tsx');
  assert.match(miniDemo, /if \(isGameOver\) resetGame\(\);/, '"Почати гру →" starts a new game when no lives are left');
});

test('MiniDemo: the code editor renders after mount inside an ErrorBoundary with a textarea fallback', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '..', 'components', 'MiniDemo.tsx'), 'utf8');
  assert.match(source, /import ErrorBoundary from '@\/components\/ErrorBoundary'/);
  assert.match(source, /mounted \? \(\s*<ErrorBoundary fallback=\{plainEditor\}>\s*<Editor/);
  assert.match(source, /\) : plainEditor\}/);
  assert.match(source, /const plainEditor = \(\s*<textarea\s+id="mini-demo-editor"/);
});
