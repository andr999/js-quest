import * as acorn from 'acorn';
import { generate } from 'astring';
import type { Node, Statement } from 'estree';

type AnyNode = Node & Record<string, any>;
type AnyStatement = Statement & Record<string, any>;

const LOOP_TYPES = new Set([
  'WhileStatement',
  'ForStatement',
  'ForInStatement',
  'ForOfStatement',
  'DoWhileStatement',
]);

const FUNCTION_TYPES = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);

function makeTraceStatement(line: number, traceIdentifier: string): AnyStatement {
  return {
    type: 'ExpressionStatement',
    expression: {
      type: 'CallExpression',
      callee: { type: 'Identifier', name: traceIdentifier },
      arguments: [{ type: 'Literal', value: line }],
      optional: false,
    },
  } as AnyStatement;
}

function makeCallStatement(name: string, args: AnyNode[] = []): AnyStatement {
  return {
    type: 'ExpressionStatement',
    expression: {
      type: 'CallExpression',
      callee: { type: 'Identifier', name },
      arguments: args,
      optional: false,
    },
  } as AnyStatement;
}

function makeTryFinally(body: AnyStatement[], finalizer: AnyStatement[], loc?: unknown): AnyStatement {
  return {
    type: 'TryStatement',
    block: { type: 'BlockStatement', body, loc },
    handler: null,
    finalizer: { type: 'BlockStatement', body: finalizer },
  } as AnyStatement;
}

function ensureBlock(statement: AnyNode | null | undefined): AnyNode | null | undefined {
  if (!statement || statement.type === 'BlockStatement') return statement;
  return {
    type: 'BlockStatement',
    body: [statement],
    loc: statement.loc,
  } as AnyNode;
}

function normalizeArrowBody(arrowFn: AnyNode): void {
  if (arrowFn.body && arrowFn.body.type !== 'BlockStatement') {
    const exprLoc = arrowFn.body.loc;
    arrowFn.expression = false;
    arrowFn.body = {
      type: 'BlockStatement',
      body: [
        {
          type: 'ReturnStatement',
          argument: arrowFn.body,
          loc: exprLoc,
        },
      ],
      loc: exprLoc,
    };
  }
}

/** `(() => expression)()`: the same value, `this`, `arguments` and `super`, evaluated inside an arrow. */
function arrowCall(body: AnyNode, extra: Record<string, unknown> = {}): AnyNode {
  return {
    type: 'CallExpression',
    callee: {
      type: 'ArrowFunctionExpression',
      id: null,
      params: [],
      body,
      expression: body.type !== 'BlockStatement',
      async: false,
      generator: false,
      ...extra,
    },
    arguments: [],
    optional: false,
    loc: body.loc,
  } as AnyNode;
}

/** Whether evaluating `node` could suspend the enclosing generator (yield cannot move into an arrow). */
function containsYield(node: any): boolean {
  if (!node || typeof node !== 'object') return false;
  if (node.type === 'YieldExpression') return true;
  if (FUNCTION_TYPES.has(node.type)) return false;
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'range') continue;
    const child = node[key];
    if (Array.isArray(child) ? child.some(containsYield) : containsYield(child)) return true;
  }
  return false;
}

/**
 * A function or class expression without static code runs nothing when it is evaluated, and moving
 * it into an arrow would lose the name JavaScript gives it (`cb = () => {}` has cb.name === 'cb').
 */
function onlyCreatesFunction(node: any): boolean {
  if (node?.type === 'FunctionExpression' || node?.type === 'ArrowFunctionExpression') return true;
  if (node?.type !== 'ClassExpression' || node.superClass) return false;
  return node.body.body.every((member: any) => !member.computed && !member.static);
}

/**
 * Code in a parameter list (default values, computed keys of destructuring patterns) runs when the
 * function is called but before its body, so it is moved into arrows, which count as the learner's
 * functions like the body does.
 */
function wrapParameterCode(pattern: any): void {
  if (!pattern || typeof pattern !== 'object') return;
  if (pattern.type === 'AssignmentPattern') {
    wrapParameterCode(pattern.left);
    if (!containsYield(pattern.right) && !onlyCreatesFunction(pattern.right)) {
      pattern.right = arrowCall(pattern.right);
    }
  } else if (pattern.type === 'ObjectPattern') {
    for (const prop of pattern.properties) {
      if (prop.type === 'RestElement') {
        wrapParameterCode(prop.argument);
        continue;
      }
      if (prop.computed && !containsYield(prop.key)) prop.key = arrowCall(prop.key);
      wrapParameterCode(prop.value);
    }
  } else if (pattern.type === 'ArrayPattern') {
    for (const element of pattern.elements) wrapParameterCode(element);
  } else if (pattern.type === 'RestElement') {
    wrapParameterCode(pattern.argument);
  }
}

function patternRunsCode(pattern: any): boolean {
  if (!pattern || typeof pattern !== 'object') return false;
  if (pattern.type === 'AssignmentPattern') return true;
  if (pattern.type === 'ObjectPattern') {
    return pattern.properties.some((prop: any) =>
      prop.type === 'RestElement' ? patternRunsCode(prop.argument) : prop.computed || patternRunsCode(prop.value));
  }
  if (pattern.type === 'ArrayPattern') return pattern.elements.some(patternRunsCode);
  if (pattern.type === 'RestElement') return patternRunsCode(pattern.argument);
  return false;
}

export interface HookIdentifiers {
  enterFn: string;
  exitFn: string;
  enterLoop: string;
  exitLoop: string;
}

export const DEFAULT_HOOK_IDENTIFIERS: HookIdentifiers = {
  enterFn: '__jsQuestEnterFn__',
  exitFn: '__jsQuestExitFn__',
  enterLoop: '__jsQuestEnterLoop__',
  exitLoop: '__jsQuestExitLoop__',
};

export interface InstrumentOptions {
  traceIdentifier?: string;
  hookIdentifiers?: Partial<HookIdentifiers>;
  /** Names the level passes to the code (e.g. `route`): declaring them again would hide the level's data. */
  providedNames?: string[];
}

interface InstrumentContext {
  traceIdentifier: string;
  hooks: HookIdentifiers;
  nextLoopItem: number;
}

/**
 * A loop condition and update run on every iteration, so they are evaluated inside the iteration
 * like the body is: `while (move(), i++ < 3)` moves the robot in a loop.
 */
function loopPart(expression: AnyNode, context: InstrumentContext): AnyNode {
  if (containsYield(expression)) return expression;
  const { hooks } = context;
  const body = {
    type: 'BlockStatement',
    body: [
      makeCallStatement(hooks.enterLoop, [{ type: 'Literal', value: true } as AnyNode]),
      makeTryFinally(
        [{ type: 'ReturnStatement', argument: expression } as AnyStatement],
        [makeCallStatement(hooks.exitLoop, [{ type: 'Literal', value: true } as AnyNode])],
      ),
    ],
  } as AnyNode;
  return arrowCall(body, { _isFunctionInstrumented: true });
}

function prepareLoop(loop: AnyNode, context: InstrumentContext): void {
  const node = loop as Record<string, any>;
  node.body = ensureBlock(node.body);
  if ((node.type === 'WhileStatement' || node.type === 'DoWhileStatement' || node.type === 'ForStatement') && node.test) {
    node.test = loopPart(node.test, context);
  }
  if (node.type === 'ForStatement' && node.update) {
    node.update = loopPart(node.update, context);
  }
  // for...of asks the iterator for the next value before every iteration: a custom iterator or a
  // generator may move the robot there, so next() runs inside the iteration too.
  if (node.type === 'ForOfStatement') {
    node.right = {
      type: 'CallExpression',
      callee: { type: 'Identifier', name: context.hooks.enterLoop },
      arguments: [{ type: 'Literal', value: 'iterable' }, node.right],
      optional: false,
      loc: node.right.loc,
    };
  }
  // for (const { command = next() } of list), for (bot.command of list): defaults, computed keys and
  // setters of the loop target run per iteration, so the assignment moves into the iteration's body.
  if (
    (node.type === 'ForOfStatement' || node.type === 'ForInStatement') &&
    node.left?.type === 'VariableDeclaration' &&
    node.left.declarations.length === 1 &&
    patternRunsCode(node.left.declarations[0].id) &&
    !containsYield(node.left.declarations[0].id)
  ) {
    const item = { type: 'Identifier', name: `__jsQuestItem${context.nextLoopItem++}__` };
    const pattern = node.left.declarations[0].id;
    const kind = node.left.kind;
    node.left = {
      type: 'VariableDeclaration',
      kind: kind === 'var' ? 'var' : 'const',
      declarations: [{ type: 'VariableDeclarator', id: item, init: null }],
    } as AnyNode;
    node.body = {
      type: 'BlockStatement',
      body: [
        {
          type: 'VariableDeclaration',
          kind,
          declarations: [{ type: 'VariableDeclarator', id: pattern, init: item }],
          loc: node.loc,
        },
        node.body,
      ],
      loc: node.body.loc,
    } as AnyNode;
  } else if (
    (node.type === 'ForOfStatement' || node.type === 'ForInStatement') &&
    ((node.left?.type === 'ObjectPattern' || node.left?.type === 'ArrayPattern') && patternRunsCode(node.left) ||
      node.left?.type === 'MemberExpression') &&
    !containsYield(node.left)
  ) {
    const item = { type: 'Identifier', name: `__jsQuestItem${context.nextLoopItem++}__` };
    const pattern = node.left;
    node.left = {
      type: 'VariableDeclaration',
      kind: 'const',
      declarations: [{ type: 'VariableDeclarator', id: item, init: null }],
    } as AnyNode;
    node.body = {
      type: 'BlockStatement',
      body: [
        {
          type: 'ExpressionStatement',
          expression: {
            type: 'AssignmentExpression',
            operator: '=',
            left: { type: 'ArrayPattern', elements: [pattern] },
            right: { type: 'ArrayExpression', elements: [item] },
          },
          loc: node.loc,
        },
        node.body,
      ],
      loc: node.body.loc,
    } as AnyNode;
  }
}

function instrumentNode(node: AnyNode | null | undefined, context: InstrumentContext): void {
  if (!node || typeof node !== 'object') return;
  const { traceIdentifier, hooks } = context;

  // The worker reports the result as soon as the code returns, so anything scheduled
  // for later would silently never move the robot.
  if (
    node.async === true ||
    node.type === 'AwaitExpression' ||
    (node.type === 'ForOfStatement' && node.await === true) ||
    node.type === 'ImportExpression'
  ) {
    const line = node.loc?.start?.line;
    if (node.type === 'ImportExpression') {
      throw new Error(
        `Динамічний import() не підтримується: робот виконує команди одразу, одну за одною${line ? ` (рядок ${line})` : ''}.`,
      );
    }
    throw new Error(
      `Асинхронний код (async/await) не підтримується: робот виконує команди одразу, одну за одною${line ? ` (рядок ${line})` : ''}.`,
    );
  }

  if (node.type === 'IfStatement') {
    (node as unknown as { consequent: AnyNode }).consequent = ensureBlock(node.consequent) as AnyNode;
    if (node.alternate && node.alternate.type !== 'IfStatement') {
      (node as unknown as { alternate: AnyNode }).alternate = ensureBlock(node.alternate) as AnyNode;
    }
  }

  if (LOOP_TYPES.has(node.type) && !node._isLoopPrepared) {
    node._isLoopPrepared = true;
    prepareLoop(node, context);
  }

  if (FUNCTION_TYPES.has(node.type)) {
    if (!node._isFunctionInstrumented && Array.isArray(node.params)) {
      for (const param of node.params) wrapParameterCode(param);
    }
    if (node.type === 'ArrowFunctionExpression') {
      normalizeArrowBody(node);
    }
  }

  // Instance class field initializers run when constructing an instance (`new C()`).
  if (node.type === 'PropertyDefinition' && !node.static && node.value && !containsYield(node.value) && !onlyCreatesFunction(node.value)) {
    (node as Record<string, any>).value = arrowCall(node.value);
  }

  // Recurse first
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'range') continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const child of value) {
        if (child && typeof child === 'object') instrumentNode(child, context);
      }
    } else if (value && typeof value === 'object') {
      instrumentNode(value, context);
    }
  }

  if (node.type === 'SwitchCase' && Array.isArray(node.consequent)) {
    const traced: AnyStatement[] = [];
    for (const statement of node.consequent) {
      if (statement.type !== 'EmptyStatement' && statement.loc?.start?.line) {
        traced.push(makeTraceStatement(statement.loc.start.line, traceIdentifier));
      }
      traced.push(wrapLoopInstance(statement as AnyStatement, context));
    }
    (node as unknown as { consequent: AnyStatement[] }).consequent = traced;
    return;
  }

  if (FUNCTION_TYPES.has(node.type)) {
    if (node.body && node.body.type === 'BlockStatement' && !node._isFunctionInstrumented) {
      node._isFunctionInstrumented = true;
      // The body moves into a try block. A function declaration there would become block-scoped and
      // clash with a `var` of the same name (`var step; function step() {}` is valid JavaScript), and
      // moving it out of the block would cut it off from the body's let/const. So it stays in the
      // block, first (it is hoisted anyway), as `var step = function () {...}`: the same binding as a
      // declaration in a function body, the same closures and the same inferred name.
      const statements = (node.body.body || []) as AnyStatement[];
      const declarations = statements.filter(statement => statement.type === 'FunctionDeclaration');
      node.body.body = [
        makeCallStatement(hooks.enterFn),
        makeTryFinally(
          [
            ...declarations.map(asVarFunction),
            ...statements.filter(statement => statement.type !== 'FunctionDeclaration'),
          ],
          [makeCallStatement(hooks.exitFn)],
          node.body.loc,
        ),
      ];
    }
    return;
  }

  if (LOOP_TYPES.has(node.type)) {
    if (node.body && node.body.type === 'BlockStatement' && !node._isLoopInstrumented) {
      node._isLoopInstrumented = true;
      const notPart = [{ type: 'Literal', value: false } as AnyNode];
      node.body.body = [
        makeCallStatement(hooks.enterLoop, notPart),
        makeTryFinally(node.body.body || [], [makeCallStatement(hooks.exitLoop, notPart)], node.body.loc),
      ];
    }
    return;
  }

  if (node.type !== 'Program' && node.type !== 'BlockStatement' && node.type !== 'StaticBlock') return;
  if (!Array.isArray(node.body)) return;

  const tracedBody: AnyStatement[] = [];
  for (const statement of node.body as AnyStatement[]) {
    if (
      statement.type !== 'FunctionDeclaration' &&
      statement.type !== 'EmptyStatement' &&
      statement.loc?.start?.line
    ) {
      tracedBody.push(makeTraceStatement(statement.loc.start.line, traceIdentifier));
    }
    tracedBody.push(wrapLoopInstance(statement, context));
  }
  (node as unknown as { body: AnyStatement[] }).body = tracedBody;
}

/** `function step() {}` → `var step = function () {}` (the name is inferred from the variable). */
function asVarFunction(declaration: AnyStatement): AnyStatement {
  const fn = declaration as AnyNode;
  return {
    type: 'VariableDeclaration',
    kind: 'var',
    declarations: [{
      type: 'VariableDeclarator',
      id: { type: 'Identifier', name: fn.id.name },
      init: { ...fn, type: 'FunctionExpression', id: null },
    }],
    loc: fn.loc,
  } as AnyStatement;
}

/**
 * Each run of a loop statement is one loop instance: `{ const t = enterLoop('loop'); try { LOOP }
 * finally { exitLoop('loop', t); } }`, so the worker can tell whether that loop really repeated.
 * Labels stay on the loop, where `continue label` needs them.
 */
function wrapLoopInstance(statement: AnyStatement, context: InstrumentContext): AnyStatement {
  let target: AnyNode = statement;
  while (target.type === 'LabeledStatement') target = (target as any).body;
  if (!LOOP_TYPES.has(target.type)) return statement;
  const { hooks } = context;
  const token = { type: 'Identifier', name: `__jsQuestLoop${context.nextLoopItem++}__` } as AnyNode;
  const mode = { type: 'Literal', value: 'loop' } as AnyNode;
  return {
    type: 'BlockStatement',
    body: [
      {
        type: 'VariableDeclaration',
        kind: 'const',
        declarations: [{
          type: 'VariableDeclarator',
          id: token,
          init: { type: 'CallExpression', callee: { type: 'Identifier', name: hooks.enterLoop }, arguments: [mode], optional: false },
        }],
      },
      makeTryFinally([statement], [makeCallStatement(hooks.exitLoop, [mode, token])]),
    ],
  } as AnyStatement;
}

function patternNames(pattern: any, out: { name: string; line?: number }[]): void {
  if (!pattern) return;
  if (pattern.type === 'Identifier') out.push({ name: pattern.name, line: pattern.loc?.start?.line });
  else if (pattern.type === 'AssignmentPattern') patternNames(pattern.left, out);
  else if (pattern.type === 'RestElement') patternNames(pattern.argument, out);
  else if (pattern.type === 'ArrayPattern') pattern.elements.forEach((el: any) => patternNames(el, out));
  else if (pattern.type === 'ObjectPattern') {
    pattern.properties.forEach((prop: any) => patternNames(prop.type === 'RestElement' ? prop.argument : prop.value, out));
  }
}

/** Names the code declares in its own top scope: there they would hide what the level passes in. */
function topLevelDeclarations(ast: AnyNode): { name: string; line?: number }[] {
  const found: { name: string; line?: number }[] = [];
  for (const statement of (ast as any).body) {
    if ((statement.type === 'FunctionDeclaration' || statement.type === 'ClassDeclaration') && statement.id) {
      found.push({ name: statement.id.name, line: statement.loc?.start?.line });
    } else if (statement.type === 'VariableDeclaration' && statement.kind !== 'var') {
      statement.declarations.forEach((d: any) => patternNames(d.id, found));
    }
  }
  // `var` reaches the top scope from any block outside functions and class static blocks.
  (function walk(node: any, shadowed = new Set<string>()): void {
    if (!node || typeof node !== 'object' || FUNCTION_TYPES.has(node.type) || node.type === 'StaticBlock') return;
    let nextShadowed = shadowed;
    if (node.type === 'BlockStatement' || node.type === 'ForStatement' || node.type === 'ForInStatement' || node.type === 'ForOfStatement') {
      const localNames: { name: string; line?: number }[] = [];
      if (node.type === 'BlockStatement' && Array.isArray(node.body)) {
        for (const stmt of node.body) {
          if (stmt.type === 'VariableDeclaration' && stmt.kind !== 'var') {
            stmt.declarations.forEach((d: any) => patternNames(d.id, localNames));
          } else if ((stmt.type === 'FunctionDeclaration' || stmt.type === 'ClassDeclaration') && stmt.id) {
            localNames.push({ name: stmt.id.name });
          }
        }
      } else {
        const init = node.init ?? node.left;
        if (init && init.type === 'VariableDeclaration' && init.kind !== 'var') {
          init.declarations.forEach((d: any) => patternNames(d.id, localNames));
        }
      }
      if (localNames.length > 0) {
        nextShadowed = new Set(shadowed);
        localNames.forEach(item => nextShadowed.add(item.name));
      }
    }
    if (node.type === 'VariableDeclaration' && node.kind === 'var') {
      node.declarations.forEach((d: any) => patternNames(d.id, found));
    } else if (node.type === 'AssignmentExpression' || node.type === 'UpdateExpression') {
      const targets: { name: string; line?: number }[] = [];
      patternNames(node.left ?? node.argument, targets);
      for (const target of targets) {
        if (!nextShadowed.has(target.name)) {
          found.push({ name: target.name, line: target.line ?? node.loc?.start?.line });
        }
      }
    }
    for (const key of Object.keys(node)) {
      if (key === 'loc' || key === 'range') continue;
      const child = node[key];
      if (Array.isArray(child)) child.forEach(item => walk(item, nextShadowed));
      else walk(child, nextShadowed);
    }
  })(ast);
  return found;
}

export function hasExecutableStatements(code: string): boolean {
  if (!code || !code.trim()) return false;
  try {
    const ast = acorn.parse(code, {
      ecmaVersion: 2024,
      locations: true,
      sourceType: 'script',
    }) as AnyNode;
    return Array.isArray((ast as any).body) && (ast as any).body.some((stmt: any) => stmt.type !== 'EmptyStatement');
  } catch {
    return true;
  }
}

export function instrumentCode(
  code: string,
  optionsOrTraceIdentifier: string | InstrumentOptions = '__jsQuestTrace__',
): string {
  let traceIdentifier = '__jsQuestTrace__';
  let hooks: HookIdentifiers = { ...DEFAULT_HOOK_IDENTIFIERS };
  let providedNames: string[] = [];

  if (typeof optionsOrTraceIdentifier === 'string') {
    traceIdentifier = optionsOrTraceIdentifier;
  } else if (optionsOrTraceIdentifier && typeof optionsOrTraceIdentifier === 'object') {
    if (optionsOrTraceIdentifier.traceIdentifier) {
      traceIdentifier = optionsOrTraceIdentifier.traceIdentifier;
    }
    if (optionsOrTraceIdentifier.hookIdentifiers) {
      hooks = {
        ...DEFAULT_HOOK_IDENTIFIERS,
        ...optionsOrTraceIdentifier.hookIdentifiers,
      };
    }
    providedNames = optionsOrTraceIdentifier.providedNames ?? [];
  }

  const IDENTIFIER_REGEX = /^[$A-Z_a-z][$\w]*$/;
  if (!IDENTIFIER_REGEX.test(traceIdentifier)) {
    throw new Error('Некоректний ідентифікатор трасування.');
  }
  for (const [key, value] of Object.entries(hooks)) {
    if (!IDENTIFIER_REGEX.test(value)) {
      throw new Error(`Некоректний ідентифікатор хука ${key}: ${value}`);
    }
  }

  const ast = acorn.parse(code, {
    ecmaVersion: 2024,
    locations: true,
    sourceType: 'script',
  }) as AnyNode;

  if (providedNames.length > 0) {
    const redeclared = topLevelDeclarations(ast).find(d => providedNames.includes(d.name));
    if (redeclared) {
      throw new Error(
        `Змінна ${redeclared.name} уже є: рівень сам передає її твоєму коду. ` +
          `Не оголошуй ${redeclared.name} ще раз — просто використовуй її${redeclared.line ? ` (рядок ${redeclared.line})` : ''}.`,
      );
    }
  }

  instrumentNode(ast, { traceIdentifier, hooks, nextLoopItem: 0 });
  return generate(ast);
}
