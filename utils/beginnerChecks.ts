import * as acorn from 'acorn';

/**
 * Typical beginner mistakes that are valid JavaScript but cannot be what the learner meant. They are
 * reported before the run, so they cost neither an attempt nor a life:
 * - a command without parentheses (`move;`, `btn.click;`), which silently does nothing;
 * - a misspelled command (`turnleft()`, `Move()`), which would stop the run with a ReferenceError;
 * - `=` instead of `===` in a condition (`if (cmd = 'move')`);
 * - `repeat(4, move())`, which runs move() once before repeat and gives repeat nothing to repeat;
 * - on the DOM level, an element id that does not exist (`getElementById('termnial')`).
 * Only patterns that are always mistakes are reported, so correct code is never held back.
 */

const ROBOT_COMMANDS = ['move', 'turnLeft', 'turnRight'];
const BUILT_INS = [...ROBOT_COMMANDS, 'repeat', 'canMove', 'isWallAhead', 'isGoalReached', 'hasKey'];
/** Methods whose name alone (`btn.click;`) is never useful as a statement. */
const METHODS = ['click', 'getElementById', 'querySelector', 'querySelectorAll', 'add', 'remove', 'toggle', 'contains', ...BUILT_INS];

export interface BeginnerCheckOptions {
  /** Ids of the elements of the virtual DOM (level 7). */
  domElementIds?: readonly string[];
  /** Names the level passes to the code (route, instructions). */
  providedNames?: readonly string[];
}

/** Damerau–Levenshtein distance (an adjacent swap counts as one edit). */
function editDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j += 1) d[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

/** The built-in a misspelled name most likely stands for, if any. */
function closestBuiltIn(name: string): string | null {
  const lower = name.toLowerCase();
  for (const builtIn of BUILT_INS) {
    if (builtIn.toLowerCase() === lower) return builtIn;
  }
  let best: string | null = null;
  let bestDistance = Infinity;
  for (const builtIn of BUILT_INS) {
    const distance = editDistance(lower, builtIn.toLowerCase());
    const allowed = builtIn.length <= 5 ? 1 : 2;
    if (distance <= allowed && distance < bestDistance) {
      best = builtIn;
      bestDistance = distance;
    }
  }
  return best;
}

function walk(node: any, visit: (node: any, parent: any) => void, parent: any = null): void {
  if (!node || typeof node !== 'object') return;
  if (typeof node.type === 'string') visit(node, parent);
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'start' || key === 'end') continue;
    const child = node[key];
    if (Array.isArray(child)) child.forEach(item => walk(item, visit, node));
    else if (child && typeof child === 'object') walk(child, visit, node);
  }
}

function patternNames(pattern: any, out: Set<string>): void {
  if (!pattern) return;
  if (pattern.type === 'Identifier') out.add(pattern.name);
  else if (pattern.type === 'AssignmentPattern') patternNames(pattern.left, out);
  else if (pattern.type === 'RestElement') patternNames(pattern.argument, out);
  else if (pattern.type === 'ArrayPattern') pattern.elements.forEach((el: any) => patternNames(el, out));
  else if (pattern.type === 'ObjectPattern') {
    pattern.properties.forEach((prop: any) => patternNames(prop.type === 'RestElement' ? prop.argument : prop.value, out));
  }
}

/** Every name the code declares anywhere (variables, functions, classes, parameters). */
function declaredNames(ast: any): { all: Set<string>; functions: Set<string> } {
  const all = new Set<string>();
  const functions = new Set<string>();
  walk(ast, (node) => {
    if (node.type === 'VariableDeclarator') {
      patternNames(node.id, all);
      if (node.id.type === 'Identifier' && /Function/.test(node.init?.type ?? '')) functions.add(node.id.name);
    } else if ((node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ClassDeclaration' || node.type === 'ClassExpression') && node.id) {
      all.add(node.id.name);
      if (node.type === 'FunctionDeclaration') functions.add(node.id.name);
    }
    if (/Function/.test(node.type) && Array.isArray(node.params)) node.params.forEach((p: any) => patternNames(p, all));
    if (node.type === 'CatchClause' && node.param) patternNames(node.param, all);
  });
  return { all, functions };
}

function memberText(node: any): string | null {
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'ThisExpression') return 'this';
  if (node.type === 'MemberExpression' && !node.computed && node.property.type === 'Identifier') {
    const object = memberText(node.object);
    return object ? `${object}.${node.property.name}` : null;
  }
  return null;
}

function literalText(node: any): string | null {
  if (node.type === 'Literal') return typeof node.value === 'string' ? `'${node.value}'` : String(node.value);
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) return `\`${node.quasis[0].value.cooked}\``;
  return null;
}

/** Returns a hint in Ukrainian for the first beginner mistake in `code`, or null. */
export function findBeginnerMistake(code: string, options: BeginnerCheckOptions = {}): string | null {
  let ast: any;
  try {
    ast = acorn.parse(code, { ecmaVersion: 2024, sourceType: 'script', locations: true });
  } catch {
    return null; // syntax errors are reported elsewhere
  }
  const { all: declared, functions } = declaredNames(ast);
  for (const name of options.providedNames ?? []) declared.add(name);
  const isBuiltIn = (name: string) => BUILT_INS.includes(name) && !declared.has(name);
  const line = (node: any) => `Рядок ${node.loc.start.line}`;
  const mistakes: { pos: number; message: string }[] = [];
  const report = (node: any, message: string) => mistakes.push({ pos: node.start, message: `${line(node)}: ${message}` });

  const checkCondition = (test: any) => {
    if (!test) return;
    if (test.type === 'LogicalExpression') {
      checkCondition(test.left);
      checkCondition(test.right);
      return;
    }
    if (test.type === 'AssignmentExpression' && test.operator === '=') {
      const value = literalText(test.right);
      const target = memberText(test.left);
      if (value !== null && target) {
        report(test, `в умові стоїть «=», а воно не порівнює, а записує значення. Щоб порівняти, пиши «===»: ${target} === ${value}.`);
      }
    }
  };

  walk(ast, (node) => {
    // move;  btn.click;  go;
    if (node.type === 'ExpressionStatement') {
      const expression = node.expression;
      const text = memberText(expression);
      const isCommand = expression.type === 'Identifier' && (isBuiltIn(expression.name) || functions.has(expression.name));
      const isMethod = expression.type === 'MemberExpression' && !expression.computed && METHODS.includes(expression.property.name);
      if (text && (isCommand || isMethod)) {
        report(node, `«${text}» без дужок нічого не робить. Щоб виконати команду, допиши дужки: ${text}();`);
      }
    }

    if (node.type === 'IfStatement' || node.type === 'WhileStatement' || node.type === 'DoWhileStatement' || node.type === 'ForStatement' || node.type === 'ConditionalExpression') {
      checkCondition(node.test);
    }

    if (node.type !== 'CallExpression') return;

    // turnleft(), Move(), canmove()
    if (node.callee.type === 'Identifier' && !declared.has(node.callee.name) && !BUILT_INS.includes(node.callee.name)) {
      const meant = closestBuiltIn(node.callee.name);
      if (meant) {
        report(node, `команди «${node.callee.name}» немає. Мабуть, ти мав на увазі ${meant}() — зверни увагу на великі й малі літери.`);
      }
    }
    // repeat(4, move())  repeat(4)
    if (node.callee.type === 'Identifier' && node.callee.name === 'repeat' && isBuiltIn('repeat')) {
      const [times, action] = node.arguments;
      const timesText = times ? (literalText(times) ?? memberText(times) ?? 'n') : 'n';
      if (!action) {
        report(node, `repeat потрібні дві речі: скільки разів і що робити. Наприклад: repeat(${timesText}, move);`);
      } else if (action.type === 'CallExpression' && action.callee.type === 'Identifier' && ROBOT_COMMANDS.includes(action.callee.name) && isBuiltIn(action.callee.name)) {
        const name = action.callee.name;
        report(node, `repeat(${timesText}, ${name}()) виконає ${name}() лише один раз — ще до repeat. Передай саму команду без дужок: repeat(${timesText}, ${name}); або repeat(${timesText}, () => { ${name}(); });`);
      }
    }
    // dom.getElementById('termnial'), dom.querySelector('#termnial')
    const ids = options.domElementIds;
    if (ids && node.callee.type === 'MemberExpression' && !node.callee.computed) {
      const method = node.callee.property.name;
      const arg = node.arguments[0];
      if (arg?.type === 'Literal' && typeof arg.value === 'string') {
        // getElementById('#door') still finds the door (the run prints a hint about the #).
        const id = method === 'getElementById' ? arg.value.trim().replace(/^#/, '')
          : (method === 'querySelector' || method === 'querySelectorAll') && /^#[\w-]+$/.test(arg.value.trim()) ? arg.value.trim().slice(1)
            : null;
        if (id !== null && !ids.includes(id)) {
          report(node, `елемента з id «${id}» немає. Доступні id: ${ids.join(', ')}.`);
        }
      }
    }
  });

  mistakes.sort((a, b) => a.pos - b.pos);
  return mistakes[0]?.message ?? null;
}
