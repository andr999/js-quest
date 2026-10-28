import * as acorn from 'acorn';

const ROBOT_COMMANDS = new Set(['move', 'turnRight', 'turnLeft', 'repeat']);

const ITERATION_METHODS = new Set([
  'forEach',
  'map',
  'filter',
  'reduce',
  'reduceRight',
  'some',
  'every',
  'find',
  'findIndex',
  'findLast',
  'findLastIndex',
  'flatMap',
]);

function isRobotAction(name: string): boolean {
  return ROBOT_COMMANDS.has(name);
}

function resolveStaticString(node: any, constants?: Map<string, string>): string | null {
  if (!node) return null;
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node.type === 'TemplateLiteral') {
    let res = '';
    for (let i = 0; i < node.quasis.length; i++) {
      res += node.quasis[i].value.cooked ?? node.quasis[i].value.raw;
      if (i < node.expressions.length) {
        const val = resolveStaticString(node.expressions[i], constants);
        if (val === null) return null;
        res += val;
      }
    }
    return res;
  }
  if (node.type === 'BinaryExpression' && node.operator === '+') {
    const l = resolveStaticString(node.left, constants);
    const r = resolveStaticString(node.right, constants);
    if (l !== null && r !== null) return l + r;
    return null;
  }
  if (node.type === 'Identifier' && constants?.has(node.name)) {
    return constants.get(node.name)!;
  }
  return null;
}

function collectStringConstants(ast: any): Map<string, string> {
  const constants = new Map<string, string>();
  // A name declared or assigned in several places (e.g. a same-named local in another function)
  // has no single value, so it is left unresolved instead of taking whichever came last.
  const ambiguous = new Set<string>();
  if (!ast || typeof ast !== 'object') return constants;
  function walk(node: any) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'VariableDeclarator' && node.id?.type === 'Identifier') {
      const name = node.id.name;
      const val = resolveStaticString(node.init);
      if (val === null || (constants.has(name) && constants.get(name) !== val)) {
        ambiguous.add(name);
      } else {
        constants.set(name, val);
      }
    } else if (node.type === 'AssignmentExpression' && node.left?.type === 'Identifier') {
      ambiguous.add(node.left.name);
    }
    for (const key of Object.keys(node)) {
      if (key !== 'loc' && key !== 'range') {
        const child = node[key];
        if (Array.isArray(child)) {
          for (const item of child) walk(item);
        } else if (child && typeof child === 'object') {
          walk(child);
        }
      }
    }
  }
  walk(ast);
  for (const name of ambiguous) constants.delete(name);
  return constants;
}

function isArrayFromWithMapper(node: any, constants?: Map<string, string>): boolean {
  if (!node || node.type !== 'CallExpression' || node.callee?.type !== 'MemberExpression') return false;
  if (node.callee.object?.type !== 'Identifier' || node.callee.object.name !== 'Array') return false;
  const propName = !node.callee.computed && node.callee.property?.type === 'Identifier'
    ? node.callee.property.name
    : resolveStaticString(node.callee.property, constants);
  return propName === 'from' && Array.isArray(node.arguments) && node.arguments.length >= 2;
}

function isIterationCall(node: any, constants?: Map<string, string>): boolean {
  if (!node || node.type !== 'CallExpression') return false;
  if (node.callee?.type === 'MemberExpression') {
    let propName: string | null = null;
    if (!node.callee.computed && node.callee.property?.type === 'Identifier') {
      propName = node.callee.property.name;
    } else {
      propName = resolveStaticString(node.callee.property, constants);
    }
    if (propName && ITERATION_METHODS.has(propName)) {
      return true;
    }
    if (isArrayFromWithMapper(node, constants)) {
      return true;
    }
  }
  if (node.callee?.type === 'Identifier' && node.callee.name === 'repeat') {
    return true;
  }
  return false;
}

function getIterationCallbackIndex(node: any, constants?: Map<string, string>): number {
  if (node?.callee?.type === 'Identifier' && node.callee.name === 'repeat') return 1;
  if (isArrayFromWithMapper(node, constants)) return 1;
  return 0;
}

function evalStaticValue(node: any): { isStatic: true; value: any } | { isStatic: false } {
  if (!node) return { isStatic: false };
  if (node.type === 'Literal') {
    return { isStatic: true, value: node.value };
  }
  if (node.type === 'Identifier') {
    if (node.name === 'undefined') return { isStatic: true, value: undefined };
    if (node.name === 'NaN') return { isStatic: true, value: NaN };
    if (node.name === 'Infinity') return { isStatic: true, value: Infinity };
  }
  if (node.type === 'UnaryExpression') {
    const inner = evalStaticValue(node.argument);
    if (inner.isStatic) {
      if (node.operator === '!') return { isStatic: true, value: !inner.value };
      if (node.operator === '-') return { isStatic: true, value: -inner.value };
      if (node.operator === '+') return { isStatic: true, value: +inner.value };
      if (node.operator === '~') return { isStatic: true, value: ~inner.value };
      if (node.operator === 'typeof') return { isStatic: true, value: typeof inner.value };
    }
  }
  if (
    node.type === 'CallExpression' &&
    node.callee?.type === 'Identifier' &&
    node.callee.name === 'Boolean' &&
    node.arguments?.length === 1
  ) {
    const inner = evalStaticValue(node.arguments[0]);
    if (inner.isStatic) {
      return { isStatic: true, value: Boolean(inner.value) };
    }
  }
  if (node.type === 'BinaryExpression') {
    const left = evalStaticValue(node.left);
    const right = evalStaticValue(node.right);
    if (left.isStatic && right.isStatic) {
      const l = left.value;
      const r = right.value;
      switch (node.operator) {
        case '<': return { isStatic: true, value: l < r };
        case '<=': return { isStatic: true, value: l <= r };
        case '>': return { isStatic: true, value: l > r };
        case '>=': return { isStatic: true, value: l >= r };
        case '===': return { isStatic: true, value: l === r };
        case '!==': return { isStatic: true, value: l !== r };
        case '==': return { isStatic: true, value: l == r };
        case '!=': return { isStatic: true, value: l != r };
        case '+': return { isStatic: true, value: l + r };
        case '-': return { isStatic: true, value: l - r };
        case '*': return { isStatic: true, value: l * r };
        case '/': return { isStatic: true, value: l / r };
        case '%': return { isStatic: true, value: l % r };
      }
    }
  }
  return { isStatic: false };
}

function isDeadCondition(testNode: any): boolean {
  if (!testNode) return false;
  const staticVal = evalStaticValue(testNode);
  if (staticVal.isStatic) {
    return !staticVal.value;
  }
  return false;
}

function isDeadForLoop(forNode: any): boolean {
  if (!forNode.test) return false;

  const staticTest = evalStaticValue(forNode.test);
  if (staticTest.isStatic) {
    return !staticTest.value;
  }

  if (forNode.test.type === 'BinaryExpression') {
    const op = forNode.test.operator;
    const testLeft = forNode.test.left;
    const testRight = forNode.test.right;

    let initVal: { isStatic: true; value: any } | { isStatic: false } = { isStatic: false };
    if (forNode.init?.type === 'VariableDeclaration') {
      const decl = forNode.init.declarations?.[0];
      if (decl && decl.id?.type === 'Identifier' && testLeft?.type === 'Identifier' && decl.id.name === testLeft.name) {
        initVal = evalStaticValue(decl.init);
      }
    } else if (forNode.init?.type === 'AssignmentExpression') {
      if (forNode.init.left?.type === 'Identifier' && testLeft?.type === 'Identifier' && forNode.init.left.name === testLeft.name) {
        initVal = evalStaticValue(forNode.init.right);
      }
    }

    const rightVal = evalStaticValue(testRight);

    if (initVal.isStatic && rightVal.isStatic) {
      const l = initVal.value;
      const r = rightVal.value;
      if (op === '<') return !(l < r);
      if (op === '<=') return !(l <= r);
      if (op === '>') return !(l > r);
      if (op === '>=') return !(l >= r);
      if (op === '===' || op === '==') return !(l === r);
      if (op === '!==' || op === '!=') return !(l !== r);
    }
  }

  return false;
}

function traverseAst(node: any, visitor: (node: any) => void) {
  if (!node || typeof node !== 'object') return;
  visitor(node);
  for (const key of Object.keys(node)) {
    if (key !== 'loc' && key !== 'range') {
      const child = node[key];
      if (Array.isArray(child)) {
        for (const item of child) traverseAst(item, visitor);
      } else if (child && typeof child === 'object') {
        traverseAst(child, visitor);
      }
    }
  }
}

function traverseReachableAst(node: any, visitor: (node: any) => void) {
  if (!node || typeof node !== 'object') return;
  visitor(node);

  if (node.type === 'BlockStatement' || node.type === 'Program') {
    if (Array.isArray(node.body)) {
      for (const stmt of node.body) {
        traverseReachableAst(stmt, visitor);
        if (
          stmt.type === 'ReturnStatement' ||
          stmt.type === 'ThrowStatement' ||
          stmt.type === 'BreakStatement' ||
          stmt.type === 'ContinueStatement'
        ) {
          break;
        }
      }
    }
    return;
  }

  if (node.type === 'IfStatement') {
    const staticTest = evalStaticValue(node.test);
    if (staticTest.isStatic) {
      if (staticTest.value) {
        if (node.consequent) traverseReachableAst(node.consequent, visitor);
      } else {
        if (node.alternate) traverseReachableAst(node.alternate, visitor);
      }
      return;
    }
  }

  for (const key of Object.keys(node)) {
    if (key !== 'loc' && key !== 'range') {
      const child = node[key];
      if (Array.isArray(child)) {
        for (const item of child) traverseReachableAst(item, visitor);
      } else if (child && typeof child === 'object') {
        traverseReachableAst(child, visitor);
      }
    }
  }
}

export class RobotFunctionSet {
  private set = new Set<string>();
  actionMaps: Set<string> = new Set();
  add(value: string) { this.set.add(value); return this; }
  has(value: string) { return this.set.has(value); }
  delete(value: string) { return this.set.delete(value); }
  clear() { this.set.clear(); }
  get size() { return this.set.size; }
  forEach(cb: (value: string, key: string, set: Set<string>) => void) { this.set.forEach(cb); }
  [Symbol.iterator]() { return this.set[Symbol.iterator](); }
  values() { return this.set.values(); }
  keys() { return this.set.keys(); }
  entries() { return this.set.entries(); }
}

export type RobotFunctionLookup = RobotFunctionSet | Set<string>;

function unwrapObjectInit(node: any): any {
  let curr = node;
  while (curr) {
    if (
      curr.type === 'CallExpression' &&
      curr.callee?.type === 'MemberExpression' &&
      curr.callee.object?.type === 'Identifier' &&
      curr.callee.object.name === 'Object'
    ) {
      const method = curr.callee.property?.name || curr.callee.property?.value;
      if (
        (method === 'freeze' || method === 'seal' || method === 'preventExtensions') &&
        Array.isArray(curr.arguments) &&
        curr.arguments.length > 0
      ) {
        curr = curr.arguments[0];
        continue;
      }
    }
    break;
  }
  return curr;
}

function extractBindTarget(expr: any): string | null {
  if (!expr || typeof expr !== 'object') return null;
  if (
    expr.type === 'CallExpression' &&
    expr.callee?.type === 'MemberExpression' &&
    (expr.callee.property?.name === 'bind' || expr.callee.property?.value === 'bind')
  ) {
    const obj = expr.callee.object;
    if (obj?.type === 'Identifier' && obj.name) return obj.name;
    if (obj?.type === 'MemberExpression') {
      const prop = obj.property?.name || obj.property?.value;
      const targetObj = obj.object?.name;
      if (prop && targetObj) return `${targetObj}.${prop}`;
      if (prop) return prop;
    }
  }
  return null;
}

function isReachableRobotCall(
  node: any,
  validCalledSet: RobotFunctionLookup,
  actionMaps: Set<string> = (validCalledSet as any)?.actionMaps || new Set(),
  localActions?: Set<string>
): boolean {
  if (!node || node.type !== 'CallExpression') return false;

  // 1. Direct identifier call: move(), myFn(), solve(), run(), handler(), action()
  if (node.callee?.type === 'Identifier' && node.callee.name) {
    if (
      isRobotAction(node.callee.name) ||
      validCalledSet.has(node.callee.name) ||
      actionMaps.has(node.callee.name) ||
      (localActions && localActions.has(node.callee.name))
    ) {
      return true;
    }
  }

  // .bind call: fn.bind(null)(), robot.solve.bind(robot)()
  if (node.callee) {
    const bindTarget = extractBindTarget(node.callee);
    if (bindTarget && (isRobotAction(bindTarget) || validCalledSet.has(bindTarget) || (localActions && localActions.has(bindTarget)))) {
      return true;
    }
  }

  // Action .call/.apply call: action.call(null), action.apply(null)
  if (
    node.callee?.type === 'MemberExpression' &&
    node.callee.object?.type === 'Identifier' &&
    (
      (localActions && localActions.has(node.callee.object.name)) ||
      validCalledSet.has(node.callee.object.name) ||
      isRobotAction(node.callee.object.name)
    ) &&
    (node.callee.property?.name === 'call' || node.callee.property?.name === 'apply')
  ) {
    return true;
  }

  // Map .get() call: actions.get(cmd)()
  if (
    node.callee?.type === 'CallExpression' &&
    node.callee.callee?.type === 'MemberExpression' &&
    (node.callee.callee.property?.name === 'get' || node.callee.callee.property?.value === 'get') &&
    node.callee.callee.object?.type === 'Identifier' &&
    actionMaps.has(node.callee.callee.object.name)
  ) {
    return true;
  }

  // 2. Member call: robot.solve(), this.solve(), bot.step(), actions[cmd](), actions.move()
  if (node.callee?.type === 'MemberExpression') {
    if (node.callee.object?.type === 'Identifier' && node.callee.object.name) {
      if (actionMaps.has(node.callee.object.name) || validCalledSet.has(node.callee.object.name)) {
        return true;
      }
    }
    const unwrappedCalleeObj = unwrapObjectInit(node.callee.object);
    if (unwrappedCalleeObj?.type === 'ObjectExpression' && Array.isArray(unwrappedCalleeObj.properties)) {
      for (const p of unwrappedCalleeObj.properties) {
        if (p.type === 'Property' && p.value) {
          const valName = p.value.name;
          if (valName && (isRobotAction(valName) || validCalledSet.has(valName) || (localActions && localActions.has(valName)))) return true;
          if (p.value.type === 'FunctionExpression' || p.value.type === 'ArrowFunctionExpression') {
            if (functionDirectlyHasRobotAction(p.value.body, validCalledSet, actionMaps, localActions)) return true;
          }
        }
      }
    }

    const propName = node.callee.property?.name || node.callee.property?.value;
    if (propName) {
      if (isRobotAction(propName) || validCalledSet.has(propName)) {
        return true;
      }
      if (node.callee.object?.type === 'Identifier' && node.callee.object.name) {
        const fullMemberName = `${node.callee.object.name}.${propName}`;
        if (validCalledSet.has(fullMemberName)) {
          return true;
        }
      }
    }
  }

  // 3. Immediately invoked function expression
  if (
    node.callee?.type === 'FunctionExpression' ||
    node.callee?.type === 'ArrowFunctionExpression'
  ) {
    if (functionDirectlyHasRobotAction(node.callee.body, validCalledSet, actionMaps, localActions)) {
      return true;
    }
  }

  return false;
}

function isReturnedAction(
  exprNode: any,
  validCalledSet: RobotFunctionLookup,
  actionMaps: Set<string> = (validCalledSet as any)?.actionMaps || new Set(),
  localActions?: Set<string>
): boolean {
  if (!exprNode || typeof exprNode !== 'object') return false;

  if (exprNode.type === 'FunctionExpression' || exprNode.type === 'ArrowFunctionExpression') {
    return functionDirectlyHasRobotAction(exprNode.body, validCalledSet, actionMaps, localActions);
  }

  if (exprNode.type === 'Identifier') {
    return (
      isRobotAction(exprNode.name) ||
      validCalledSet.has(exprNode.name) ||
      actionMaps.has(exprNode.name) ||
      Boolean(localActions?.has(exprNode.name))
    );
  }

  if (exprNode.type === 'MemberExpression') {
    if (exprNode.object?.type === 'Identifier' && (actionMaps.has(exprNode.object.name) || validCalledSet.has(exprNode.object.name))) {
      return true;
    }
    const propName = exprNode.property?.name || exprNode.property?.value;
    if (propName && (isRobotAction(propName) || validCalledSet.has(propName))) {
      return true;
    }
    if (exprNode.object?.type === 'Identifier' && exprNode.object.name) {
      const full = `${exprNode.object.name}.${propName}`;
      if (validCalledSet.has(full)) {
        return true;
      }
    }
    return false;
  }

  if (exprNode.type === 'CallExpression') {
    const bindTarget = extractBindTarget(exprNode);
    if (bindTarget && (isRobotAction(bindTarget) || validCalledSet.has(bindTarget) || actionMaps.has(bindTarget) || (localActions && localActions.has(bindTarget)))) {
      return true;
    }
    return isReachableRobotCall(exprNode, validCalledSet, actionMaps, localActions);
  }

  const unwrappedExpr = unwrapObjectInit(exprNode);
  if (unwrappedExpr?.type === 'ObjectExpression' && Array.isArray(unwrappedExpr.properties)) {
    for (const prop of unwrappedExpr.properties) {
      if (prop.type === 'Property' && prop.value) {
        if (
          prop.value.type === 'FunctionExpression' ||
          prop.value.type === 'ArrowFunctionExpression'
        ) {
          if (functionDirectlyHasRobotAction(prop.value.body, validCalledSet, actionMaps, localActions)) {
            return true;
          }
        } else if (isReturnedAction(prop.value, validCalledSet, actionMaps, localActions)) {
          return true;
        }
      }
    }
  }

  if (exprNode.type === 'ConditionalExpression') {
    return (
      isReturnedAction(exprNode.consequent, validCalledSet, actionMaps, localActions) ||
      isReturnedAction(exprNode.alternate, validCalledSet, actionMaps, localActions)
    );
  }

  if (exprNode.type === 'LogicalExpression') {
    return (
      isReturnedAction(exprNode.left, validCalledSet, actionMaps, localActions) ||
      isReturnedAction(exprNode.right, validCalledSet, actionMaps, localActions)
    );
  }

  if (exprNode.type === 'SequenceExpression' && Array.isArray(exprNode.expressions)) {
    const last = exprNode.expressions[exprNode.expressions.length - 1];
    return isReturnedAction(last, validCalledSet, actionMaps, localActions);
  }

  return false;
}

function functionDirectlyHasRobotAction(
  bodyNode: any,
  validCalledSet: RobotFunctionLookup,
  actionMaps: Set<string> = (validCalledSet as any)?.actionMaps || new Set(),
  localActions?: Set<string>
): boolean {
  let found = false;

  if (!bodyNode || typeof bodyNode !== 'object') return false;

  if (bodyNode.type === 'FunctionExpression' || bodyNode.type === 'ArrowFunctionExpression') {
    return functionDirectlyHasRobotAction(bodyNode.body, validCalledSet, actionMaps, localActions);
  }

  const effectiveLocalActions = new Set<string>(localActions || []);
  const effectiveLocalMaps = new Set<string>(actionMaps || []);

  function isAction(name: string): boolean {
    return isRobotAction(name) || validCalledSet.has(name) || effectiveLocalActions.has(name);
  }
  function isMap(name: string): boolean {
    return effectiveLocalMaps.has(name) || actionMaps.has(name);
  }

  let localChanged = true;
  while (localChanged) {
    localChanged = false;
    function scanLocal(node: any): void {
      if (!node || typeof node !== 'object') return;
      if (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression') {
        return;
      }
      if (node.type === 'VariableDeclarator') {
        const id = node.id;
        const init = node.init;
        if (id?.type === 'Identifier' && init) {
          const varName = id.name;
          if (init.type === 'Identifier' && isAction(init.name)) {
            if (!effectiveLocalActions.has(varName)) { effectiveLocalActions.add(varName); localChanged = true; }
          } else if (init.type === 'MemberExpression') {
            const objName = init.object?.name;
            const propName = init.property?.name || init.property?.value;
            if (objName && isMap(objName)) {
              if (!effectiveLocalActions.has(varName)) { effectiveLocalActions.add(varName); localChanged = true; }
            } else if (propName && isAction(propName)) {
              if (!effectiveLocalActions.has(varName)) { effectiveLocalActions.add(varName); localChanged = true; }
            }
          } else if (init.type === 'ArrayExpression' && Array.isArray(init.elements)) {
            if (init.elements.some((el: any) => el && el.type === 'Identifier' && isAction(el.name))) {
              if (!effectiveLocalMaps.has(varName)) { effectiveLocalMaps.add(varName); localChanged = true; }
            }
          } else if (init.type === 'ObjectExpression' && Array.isArray(init.properties)) {
            if (init.properties.some((p: any) => p.type === 'Property' && p.value?.type === 'Identifier' && isAction(p.value.name))) {
              if (!effectiveLocalMaps.has(varName)) { effectiveLocalMaps.add(varName); localChanged = true; }
            }
          }
        } else if (id?.type === 'ArrayPattern' && Array.isArray(id.elements) && init) {
          for (const el of id.elements) {
            if (el?.type === 'Identifier') {
              if (init.type === 'Identifier' && isMap(init.name)) {
                if (!effectiveLocalActions.has(el.name)) { effectiveLocalActions.add(el.name); localChanged = true; }
              } else if (init.type === 'ArrayExpression' && Array.isArray(init.elements)) {
                const idx = id.elements.indexOf(el);
                const initEl = init.elements[idx];
                if (initEl?.type === 'Identifier' && isAction(initEl.name)) {
                  if (!effectiveLocalActions.has(el.name)) { effectiveLocalActions.add(el.name); localChanged = true; }
                }
              }
            }
          }
        }
      } else if (node.type === 'AssignmentExpression') {
        if (node.left?.type === 'Identifier' && node.right) {
          const varName = node.left.name;
          if (node.right.type === 'Identifier' && isAction(node.right.name)) {
            if (!effectiveLocalActions.has(varName)) { effectiveLocalActions.add(varName); localChanged = true; }
          } else if (node.right.type === 'MemberExpression' && node.right.object?.name && isMap(node.right.object.name)) {
            if (!effectiveLocalActions.has(varName)) { effectiveLocalActions.add(varName); localChanged = true; }
          } else if (node.right.type === 'ArrayExpression' && Array.isArray(node.right.elements)) {
            if (node.right.elements.some((el: any) => el && el.type === 'Identifier' && isAction(el.name))) {
              if (!effectiveLocalMaps.has(varName)) { effectiveLocalMaps.add(varName); localChanged = true; }
            }
          }
        }
      }
      for (const k of Object.keys(node)) {
        if (k !== 'loc' && k !== 'range') {
          const child = node[k];
          if (Array.isArray(child)) {
            for (const item of child) scanLocal(item);
          } else if (child && typeof child === 'object') {
            scanLocal(child);
          }
        }
      }
    }
    scanLocal(bodyNode);
  }

  function walk(node: any) {
    if (!node || typeof node !== 'object' || found) return;

    if (node.type === 'ReturnStatement' && node.argument) {
      if (isReturnedAction(node.argument, validCalledSet, effectiveLocalMaps, effectiveLocalActions)) {
        found = true;
        return;
      }
    }

    if (isIterationCall(node) && Array.isArray(node.arguments)) {
      const cbIdx = getIterationCallbackIndex(node);
      const arg = node.arguments[cbIdx];
      if (arg) {
        if (arg.type === 'FunctionExpression' || arg.type === 'ArrowFunctionExpression') {
          if (functionDirectlyHasRobotAction(arg.body, validCalledSet, effectiveLocalMaps, effectiveLocalActions)) {
            found = true;
            return;
          }
        } else if (arg.type === 'Identifier' && (isRobotAction(arg.name) || validCalledSet.has(arg.name) || effectiveLocalActions.has(arg.name))) {
          found = true;
          return;
        }
      }
    }

    // Do NOT descend into nested function declarations or closures that are not directly invoked
    if (node.type === 'FunctionDeclaration') {
      return;
    }
    if (node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression') {
      return;
    }

    if (node.type === 'BlockStatement' || node.type === 'Program') {
      if (Array.isArray(node.body)) {
        for (const stmt of node.body) {
          walk(stmt);
          if (found) return;
          if (
            stmt.type === 'ReturnStatement' ||
            stmt.type === 'ThrowStatement' ||
            stmt.type === 'BreakStatement' ||
            stmt.type === 'ContinueStatement'
          ) {
            break;
          }
        }
      }
      return;
    }

    if (node.type === 'IfStatement') {
      const staticTest = evalStaticValue(node.test);
      if (staticTest.isStatic) {
        if (staticTest.value) {
          if (node.consequent) walk(node.consequent);
        } else {
          if (node.alternate) walk(node.alternate);
        }
        return;
      }
    }

    if (isReachableRobotCall(node, validCalledSet, effectiveLocalMaps, effectiveLocalActions)) {
      found = true;
      return;
    }

    for (const key of Object.keys(node)) {
      if (key !== 'loc' && key !== 'range') {
        const child = node[key];
        if (Array.isArray(child)) {
          for (const item of child) walk(item);
        } else if (child && typeof child === 'object') {
          walk(child);
        }
      }
    }
  }

  // Concise arrow function body (e.g. () => execute or () => move() or () => [...Array(n)].map(() => move()))
  if (bodyNode.type !== 'BlockStatement') {
    if (isReturnedAction(bodyNode, validCalledSet, effectiveLocalMaps, effectiveLocalActions)) {
      return true;
    }
    walk(bodyNode);
    return found;
  }

  walk(bodyNode);
  return found;
}

function collectValidRobotFunctions(ast: any): RobotFunctionSet {
  const indexedFunctions: {
    names: string[];
    params: (string | null)[];
    body: any;
    fnNode: any;
    localActions: Set<string>;
  }[] = [];
  const aliases: { alias: string; target: string }[] = [];
  const candidateActionMaps: { name: string; targets: string[]; bodies: any[] }[] = [];
  const actionMapRegistry = new Map<string, { name: string; targets: string[]; bodies: any[] }>();
  const fnNodeMap = new Map<any, (typeof indexedFunctions)[number]>();

  function extractFnParams(node: any): (string | null)[] {
    if (!node || !Array.isArray(node.params)) return [];
    return node.params.map((p: any) =>
      p?.type === 'Identifier'
        ? p.name
        : p?.type === 'AssignmentPattern' && p.left?.type === 'Identifier'
        ? p.left.name
        : p?.type === 'RestElement' && p.argument?.type === 'Identifier'
        ? p.argument.name
        : null
    );
  }

  function registerFunction(names: string[], fnNode: any) {
    const entry = {
      names,
      params: extractFnParams(fnNode),
      body: fnNode.body,
      fnNode,
      localActions: new Set<string>(),
    };
    indexedFunctions.push(entry);
    fnNodeMap.set(fnNode, entry);
    return entry;
  }

  function getOrCreateActionMap(name: string) {
    let m = actionMapRegistry.get(name);
    if (!m) {
      m = { name, targets: [], bodies: [] };
      actionMapRegistry.set(name, m);
      candidateActionMaps.push(m);
    }
    return m;
  }

  traverseAst(ast, (node) => {
    // 1. Function declaration: function fn() {}
    if (node.type === 'FunctionDeclaration' && node.id?.name) {
      registerFunction([node.id.name], node);
    }
    // 2. Variable declarator:
    else if (node.type === 'VariableDeclarator') {
      if (node.id?.type === 'Identifier' && node.id.name) {
        const varName = node.id.name;
        if (!node.init) return;

        const unwrappedInit = unwrapObjectInit(node.init);
        const bindTarget = extractBindTarget(unwrappedInit);

        // const fn = () => {}
        if (node.init.type === 'FunctionExpression' || node.init.type === 'ArrowFunctionExpression') {
          registerFunction([varName], node.init);
        }
        // const handler = execute.bind(null)
        else if (bindTarget) {
          aliases.push({ alias: varName, target: bindTarget });
        }
        // const run = solve; (alias)
        else if (unwrappedInit?.type === 'Identifier' && unwrappedInit.name) {
          aliases.push({ alias: varName, target: unwrappedInit.name });
        }
        // const run = robot.solve;
        else if (unwrappedInit?.type === 'MemberExpression') {
          const objName = unwrappedInit.object?.name;
          const propName = unwrappedInit.computed ? null : unwrappedInit.property?.name || unwrappedInit.property?.value;
          if (unwrappedInit.computed) {
            // const first = steps[0] / actions[cmd]: an element of a collection of robot actions
            // is itself an action, so it refers to the collection (resolved as an action map).
            if (objName) aliases.push({ alias: varName, target: objName });
          } else if (propName) {
            if (objName) aliases.push({ alias: varName, target: `${objName}.${propName}` });
            aliases.push({ alias: varName, target: propName });
          }
        }
        // const actions = { ... }
        else if (unwrappedInit?.type === 'ObjectExpression' && Array.isArray(unwrappedInit.properties)) {
          const map = getOrCreateActionMap(varName);
          for (const prop of unwrappedInit.properties) {
            if (prop.type === 'Property' && prop.value) {
              const propName = prop.key?.name || prop.key?.value;
              const propBindTarget = extractBindTarget(prop.value);
              if (prop.value.type === 'FunctionExpression' || prop.value.type === 'ArrowFunctionExpression') {
                if (propName) {
                  registerFunction([propName, `${varName}.${propName}`], prop.value);
                }
                map.bodies.push(prop.value.body);
              } else if (propBindTarget) {
                if (propName) {
                  aliases.push({ alias: propName, target: propBindTarget });
                  aliases.push({ alias: `${varName}.${propName}`, target: propBindTarget });
                }
                map.targets.push(propBindTarget);
              } else if (prop.value.type === 'Identifier' && prop.value.name) {
                if (propName) {
                  aliases.push({ alias: propName, target: prop.value.name });
                  aliases.push({ alias: `${varName}.${propName}`, target: prop.value.name });
                }
                map.targets.push(prop.value.name);
              } else if (prop.value.type === 'MemberExpression') {
                const pName = prop.value.property?.name || prop.value.property?.value;
                if (pName) {
                  if (propName) {
                    aliases.push({ alias: propName, target: pName });
                    aliases.push({ alias: `${varName}.${propName}`, target: pName });
                  }
                  map.targets.push(pName);
                }
              }
            }
          }
        }
        // const actions = [move, turnRight]
        else if (node.init.type === 'ArrayExpression' && Array.isArray(node.init.elements)) {
          const map = getOrCreateActionMap(varName);
          for (const el of node.init.elements) {
            if (!el) continue;
            const elBindTarget = extractBindTarget(el);
            if (elBindTarget) {
              map.targets.push(elBindTarget);
            } else if (el.type === 'Identifier' && el.name) {
              map.targets.push(el.name);
            } else if (el.type === 'FunctionExpression' || el.type === 'ArrowFunctionExpression') {
              map.bodies.push(el.body);
            }
          }
        }
        // const actions = new Map([...])
        else if (
          node.init.type === 'NewExpression' &&
          node.init.callee?.type === 'Identifier' &&
          node.init.callee.name === 'Map' &&
          Array.isArray(node.init.arguments) &&
          node.init.arguments.length > 0
        ) {
          const firstArg = node.init.arguments[0];
          if (firstArg.type === 'ArrayExpression' && Array.isArray(firstArg.elements)) {
            const map = getOrCreateActionMap(varName);
            for (const el of firstArg.elements) {
              if (el?.type === 'ArrayExpression' && Array.isArray(el.elements) && el.elements.length >= 2) {
                const val = el.elements[1];
                const valBindTarget = extractBindTarget(val);
                if (valBindTarget) {
                  map.targets.push(valBindTarget);
                } else if (val.type === 'Identifier' && val.name) {
                  map.targets.push(val.name);
                } else if (val.type === 'FunctionExpression' || val.type === 'ArrowFunctionExpression') {
                  map.bodies.push(val.body);
                }
              }
            }
          }
        }
      }
      // Destructuring: const { solve, move: myMove } = robot / { solve() {} }
      else if (node.id?.type === 'ObjectPattern' && Array.isArray(node.id.properties)) {
        const init = unwrapObjectInit(node.init);
        for (const prop of node.id.properties) {
          if (prop.type === 'Property' && prop.value?.type === 'Identifier') {
            const localName = prop.value.name;
            const propKey = prop.key?.name || prop.key?.value;
            if (!propKey) continue;

            let matched = false;
            if (init?.type === 'ObjectExpression' && Array.isArray(init.properties)) {
              const initProp = init.properties.find(
                (p: any) => p.type === 'Property' && (p.key?.name === propKey || p.key?.value === propKey)
              );
              if (initProp && initProp.value) {
                matched = true;
                const val = initProp.value;
                const valBindTarget = extractBindTarget(val);
                if (val.type === 'FunctionExpression' || val.type === 'ArrowFunctionExpression') {
                  registerFunction([localName], val);
                } else if (valBindTarget) {
                  aliases.push({ alias: localName, target: valBindTarget });
                } else if (val.type === 'Identifier' && val.name) {
                  aliases.push({ alias: localName, target: val.name });
                } else if (val.type === 'MemberExpression') {
                  const pName = val.property?.name || val.property?.value;
                  if (pName) aliases.push({ alias: localName, target: pName });
                }
              }
            }

            if (!matched) {
              if (init?.type === 'Identifier' && init.name) {
                aliases.push({ alias: localName, target: `${init.name}.${propKey}` });
              }
              aliases.push({ alias: localName, target: propKey });
            }
          }
        }
      }
      // Destructuring: const [step1, step2] = [move, turnRight]
      else if (node.id?.type === 'ArrayPattern' && Array.isArray(node.id.elements)) {
        const init = node.init;
        for (let i = 0; i < node.id.elements.length; i++) {
          const el = node.id.elements[i];
          if (el?.type === 'Identifier') {
            const localName = el.name;
            let matched = false;
            if (init?.type === 'ArrayExpression' && Array.isArray(init.elements) && init.elements[i]) {
              const initEl = init.elements[i];
              const elBindTarget = extractBindTarget(initEl);
              matched = true;
              if (initEl.type === 'FunctionExpression' || initEl.type === 'ArrowFunctionExpression') {
                registerFunction([localName], initEl);
              } else if (elBindTarget) {
                aliases.push({ alias: localName, target: elBindTarget });
              } else if (initEl.type === 'Identifier' && initEl.name) {
                aliases.push({ alias: localName, target: initEl.name });
              }
            }
            if (!matched && init?.type === 'Identifier' && init.name) {
              aliases.push({ alias: localName, target: `${init.name}[${i}]` });
              // const [first] = steps: an element of an action collection refers to the collection
              aliases.push({ alias: localName, target: init.name });
            }
          }
        }
      }
    }
    // 3. General Object expression properties: { solve() {} }
    else if (node.type === 'ObjectExpression' && Array.isArray(node.properties)) {
      for (const prop of node.properties) {
        if (
          prop.type === 'Property' &&
          prop.value &&
          (prop.value.type === 'FunctionExpression' || prop.value.type === 'ArrowFunctionExpression')
        ) {
          const propName = prop.key?.name || prop.key?.value;
          if (propName) {
            registerFunction([propName], prop.value);
          }
        }
      }
    }
    // 4. Assignment expression: robot.solve = () => {}, run = solve, actions = { ... }, actions.move = move
    else if (node.type === 'AssignmentExpression') {
      const unwrappedRight = unwrapObjectInit(node.right);
      const bindTarget = extractBindTarget(unwrappedRight);
      if (
        node.right &&
        (node.right.type === 'FunctionExpression' || node.right.type === 'ArrowFunctionExpression')
      ) {
        if (node.left?.type === 'Identifier' && node.left.name) {
          registerFunction([node.left.name], node.right);
        } else if (node.left?.type === 'MemberExpression') {
          const propName = node.left.property?.name || node.left.property?.value;
          const objName = node.left.object?.name;
          if (propName) {
            const names = objName ? [propName, `${objName}.${propName}`] : [propName];
            registerFunction(names, node.right);
          }
          if (objName) {
            const map = getOrCreateActionMap(objName);
            map.bodies.push(node.right.body);
          }
        }
      } else if (bindTarget) {
        if (node.left?.type === 'Identifier' && node.left.name) {
          aliases.push({ alias: node.left.name, target: bindTarget });
        } else if (node.left?.type === 'MemberExpression') {
          const propName = node.left.property?.name || node.left.property?.value;
          const objName = node.left.object?.name;
          if (propName) {
            if (objName) aliases.push({ alias: `${objName}.${propName}`, target: bindTarget });
            aliases.push({ alias: propName, target: bindTarget });
          }
          if (objName) {
            const map = getOrCreateActionMap(objName);
            map.targets.push(bindTarget);
          }
        }
      } else if (unwrappedRight?.type === 'Identifier' && unwrappedRight.name) {
        if (node.left?.type === 'Identifier' && node.left.name) {
          aliases.push({ alias: node.left.name, target: unwrappedRight.name });
        } else if (node.left?.type === 'MemberExpression') {
          const propName = node.left.property?.name || node.left.property?.value;
          const objName = node.left.object?.name;
          if (propName) {
            if (objName) aliases.push({ alias: `${objName}.${propName}`, target: unwrappedRight.name });
            aliases.push({ alias: propName, target: unwrappedRight.name });
          }
          if (objName) {
            const map = getOrCreateActionMap(objName);
            map.targets.push(unwrappedRight.name);
          }
        }
      } else if (node.left?.type === 'Identifier' && node.left.name && unwrappedRight?.type === 'ObjectExpression' && Array.isArray(unwrappedRight.properties)) {
        const map = getOrCreateActionMap(node.left.name);
        for (const prop of unwrappedRight.properties) {
          if (prop.type === 'Property' && prop.value) {
            const propName = prop.key?.name || prop.key?.value;
            const propBindTarget = extractBindTarget(prop.value);
            if (prop.value.type === 'FunctionExpression' || prop.value.type === 'ArrowFunctionExpression') {
              if (propName) {
                registerFunction([propName, `${node.left.name}.${propName}`], prop.value);
              }
              map.bodies.push(prop.value.body);
            } else if (propBindTarget) {
              if (propName) {
                aliases.push({ alias: propName, target: propBindTarget });
                aliases.push({ alias: `${node.left.name}.${propName}`, target: propBindTarget });
              }
              map.targets.push(propBindTarget);
            } else if (prop.value.type === 'Identifier' && prop.value.name) {
              if (propName) {
                aliases.push({ alias: propName, target: prop.value.name });
                aliases.push({ alias: `${node.left.name}.${propName}`, target: prop.value.name });
              }
              map.targets.push(prop.value.name);
            }
          }
        }
      } else if (node.left?.type === 'ObjectPattern' && Array.isArray(node.left.properties)) {
        for (const prop of node.left.properties) {
          if (prop.type === 'Property' && prop.value?.type === 'Identifier') {
            const localName = prop.value.name;
            const propKey = prop.key?.name || prop.key?.value;
            if (!propKey) continue;
            if (unwrappedRight?.type === 'Identifier' && unwrappedRight.name) {
              aliases.push({ alias: localName, target: `${unwrappedRight.name}.${propKey}` });
            }
            aliases.push({ alias: localName, target: propKey });
          }
        }
      }
    }
    // Object.assign(actions, { move, turnRight })
    else if (
      node.type === 'CallExpression' &&
      node.callee?.type === 'MemberExpression' &&
      node.callee.object?.name === 'Object' &&
      node.callee.property?.name === 'assign' &&
      Array.isArray(node.arguments) &&
      node.arguments.length >= 2
    ) {
      const targetArg = node.arguments[0];
      if (targetArg?.type === 'Identifier' && targetArg.name) {
        const map = getOrCreateActionMap(targetArg.name);
        for (let i = 1; i < node.arguments.length; i++) {
          const src = node.arguments[i];
          if (src?.type === 'ObjectExpression' && Array.isArray(src.properties)) {
            for (const prop of src.properties) {
              if (prop.type === 'Property' && prop.value) {
                const propName = prop.key?.name || prop.key?.value;
                const bindTarget = extractBindTarget(prop.value);
                if (prop.value.type === 'FunctionExpression' || prop.value.type === 'ArrowFunctionExpression') {
                  if (propName) {
                    registerFunction([propName, `${targetArg.name}.${propName}`], prop.value);
                  }
                  map.bodies.push(prop.value.body);
                } else if (bindTarget) {
                  if (propName) {
                    aliases.push({ alias: propName, target: bindTarget });
                    aliases.push({ alias: `${targetArg.name}.${propName}`, target: bindTarget });
                  }
                  map.targets.push(bindTarget);
                } else if (prop.value.type === 'Identifier' && prop.value.name) {
                  if (propName) {
                    aliases.push({ alias: propName, target: prop.value.name });
                    aliases.push({ alias: `${targetArg.name}.${propName}`, target: prop.value.name });
                  }
                  map.targets.push(prop.value.name);
                }
              }
            }
          }
        }
      }
    }
    // 5. Class declaration / expression methods: class Bot { solve() {} }
    else if ((node.type === 'ClassDeclaration' || node.type === 'ClassExpression') && node.body?.body) {
      const className = node.id?.name;
      for (const member of node.body.body) {
        if (member.type === 'MethodDefinition' && member.value?.type === 'FunctionExpression') {
          const methodName = member.key?.name || member.key?.value;
          if (methodName) {
            const names = className ? [methodName, `${className}.${methodName}`] : [methodName];
            registerFunction(names, member.value);
          }
        }
      }
    }
  });

  // Call sites, aliases and indexed functions never change between fixed-point passes, so they
  // are resolved once here: re-walking the whole AST on every pass made long helper chains O(n³).
  const aliasTargets = new Map<string, string[]>();
  for (const { alias, target } of aliases) {
    const targets = aliasTargets.get(alias);
    if (targets) targets.push(target);
    else aliasTargets.set(alias, [target]);
  }
  const functionsByName = new Map<string, typeof indexedFunctions>();
  for (const fn of indexedFunctions) {
    for (const name of fn.names) {
      const fns = functionsByName.get(name);
      if (fns) fns.push(fn);
      else functionsByName.set(name, [fn]);
    }
  }

  const callSites: {
    args: any[];
    fns: (typeof indexedFunctions)[number][];
    callerFn: (typeof indexedFunctions)[number] | null;
  }[] = [];
  const fnStack: (typeof indexedFunctions)[number][] = [];

  function collectCallSites(node: any) {
    if (!node || typeof node !== 'object') return;

    let pushed = false;
    const fnEntry = fnNodeMap.get(node);
    if (fnEntry) {
      fnStack.push(fnEntry);
      pushed = true;
    }

    if (node.type === 'CallExpression' && Array.isArray(node.arguments)) {
      let calleeName: string | null = null;
      let actualArgs = node.arguments;

      if (node.callee?.type === 'Identifier') {
        calleeName = node.callee.name;
      } else if (node.callee?.type === 'MemberExpression') {
        const propName = node.callee.property?.name || node.callee.property?.value;
        if (propName === 'call' || propName === 'bind') {
          if (node.callee.object?.type === 'Identifier') {
            calleeName = node.callee.object.name;
          } else if (node.callee.object?.type === 'MemberExpression') {
            calleeName = node.callee.object.property?.name || node.callee.object.property?.value;
          }
          actualArgs = node.arguments.slice(1);
        } else if (propName === 'apply') {
          if (node.callee.object?.type === 'Identifier') {
            calleeName = node.callee.object.name;
          } else if (node.callee.object?.type === 'MemberExpression') {
            calleeName = node.callee.object.property?.name || node.callee.object.property?.value;
          }
          if (node.arguments[1]?.type === 'ArrayExpression' && Array.isArray(node.arguments[1].elements)) {
            actualArgs = node.arguments[1].elements;
          } else {
            actualArgs = [];
          }
        } else {
          calleeName = propName;
        }
      }

      if (calleeName && actualArgs.length > 0) {
        const targetFns = new Set<(typeof indexedFunctions)[number]>();
        // Follow the whole alias chain (const a = run; const b = a; b(move)), not just one step.
        const seenNames = new Set<string>([calleeName]);
        const pendingNames = [calleeName];
        while (pendingNames.length > 0) {
          const name = pendingNames.pop()!;
          for (const fn of functionsByName.get(name) ?? []) targetFns.add(fn);
          for (const target of aliasTargets.get(name) ?? []) {
            if (!seenNames.has(target)) {
              seenNames.add(target);
              pendingNames.push(target);
            }
          }
        }
        if (targetFns.size > 0) {
          callSites.push({
            args: actualArgs,
            fns: Array.from(targetFns),
            callerFn: fnStack.length > 0 ? fnStack[fnStack.length - 1] : null,
          });
        }
      }
    }

    for (const key of Object.keys(node)) {
      if (key !== 'loc' && key !== 'range') {
        const child = node[key];
        if (Array.isArray(child)) {
          for (const item of child) collectCallSites(item);
        } else if (child && typeof child === 'object') {
          collectCallSites(child);
        }
      }
    }

    if (pushed) fnStack.pop();
  }

  collectCallSites(ast);

  const result = new RobotFunctionSet();
  let changed = true;
  while (changed) {
    changed = false;

    // Check default parameters on functions (e.g. function step(action = move))
    for (const fn of indexedFunctions) {
      if (Array.isArray(fn.fnNode?.params)) {
        for (const p of fn.fnNode.params) {
          if (p?.type === 'AssignmentPattern' && p.left?.type === 'Identifier') {
            const paramName = p.left.name;
            if (!fn.localActions.has(paramName)) {
              let isDefaultRobotAction = false;
              if (p.right?.type === 'Identifier') {
                if (isRobotAction(p.right.name) || result.has(p.right.name) || result.actionMaps.has(p.right.name)) {
                  isDefaultRobotAction = true;
                }
                if ((aliasTargets.get(p.right.name) ?? []).some((t: string) => isRobotAction(t) || result.has(t))) {
                  isDefaultRobotAction = true;
                }
              } else if (isReturnedAction(p.right, result, result.actionMaps, fn.localActions)) {
                isDefaultRobotAction = true;
              }
              if (isDefaultRobotAction) {
                fn.localActions.add(paramName);
                changed = true;
              }
            }
          }
        }
      }
    }

    // Check call arguments passed to functions and populate localActions
    for (const { args, fns, callerFn } of callSites) {
      for (const fn of fns) {
        for (let i = 0; i < args.length; i++) {
          const arg = args[i];
          const paramName = fn.params[i];
          if (!paramName || fn.localActions.has(paramName)) continue;

          let isArgRobotAction = false;
          if (arg?.type === 'Identifier') {
            if (isRobotAction(arg.name) || result.has(arg.name) || result.actionMaps.has(arg.name)) {
              isArgRobotAction = true;
            }
            if ((aliasTargets.get(arg.name) ?? []).some(t => isRobotAction(t) || result.has(t))) {
              isArgRobotAction = true;
            }
            if (
              callerFn &&
              (callerFn.localActions.has(arg.name) ||
                (aliasTargets.get(arg.name) ?? []).some(t => callerFn.localActions.has(t)))
            ) {
              isArgRobotAction = true;
            }
          } else if (arg?.type === 'MemberExpression') {
            const prop = arg.property?.name || arg.property?.value;
            if (prop && (isRobotAction(prop) || result.has(prop))) {
              isArgRobotAction = true;
            }
            if (arg.object?.type === 'Identifier' && (result.actionMaps.has(arg.object.name) || (callerFn && callerFn.localActions.has(arg.object.name)))) {
              isArgRobotAction = true;
            }
          } else if (arg?.type === 'FunctionExpression' || arg?.type === 'ArrowFunctionExpression') {
            const callerLocalActions = callerFn?.localActions;
            if (functionDirectlyHasRobotAction(arg.body, result, result.actionMaps, callerLocalActions)) {
              isArgRobotAction = true;
            }
          }

          if (isArgRobotAction) {
            fn.localActions.add(paramName);
            changed = true;
          }
        }
      }
    }

    // A. Check indexed functions
    for (const fn of indexedFunctions) {
      const hasAnyValidName = fn.names.some(n => result.has(n));
      if (!hasAnyValidName && functionDirectlyHasRobotAction(fn.body, result, result.actionMaps, fn.localActions)) {
        for (const n of fn.names) result.add(n);
        changed = true;
      }
    }

    // B. Check aliases
    for (const { alias, target } of aliases) {
      if (!result.has(alias)) {
        if (isRobotAction(target) || result.has(target)) {
          result.add(alias);
          changed = true;
        }
      }
    }

    // C. Check candidate action maps
    for (const mapDef of candidateActionMaps) {
      if (!result.actionMaps.has(mapDef.name)) {
        const hasActionTarget = mapDef.targets.some(t => isRobotAction(t) || result.has(t));
        const hasActionBody = mapDef.bodies.some(b => functionDirectlyHasRobotAction(b, result, result.actionMaps));
        if (hasActionTarget || hasActionBody) {
          result.actionMaps.add(mapDef.name);
          result.add(mapDef.name);
          changed = true;
        }
      }
    }
  }

  return result;
}

/**
 * Validates that the user code declares at least one custom function (or object/class method)
 * containing robot commands directly or indirectly, AND actually invokes/calls that custom function
 * in reachable code.
 * Rejects empty/dummy functions, uncalled functions, and uncalled nested functions.
 */
export function hasUserFunction(code: string): boolean {
  try {
    const ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'script' }) as any;
    const declaredValidFunctions = collectValidRobotFunctions(ast);
    if (declaredValidFunctions.size === 0) return false;

    let calledValidFunction = false;

    traverseReachableAst(ast, (node) => {
      if (isReachableRobotCall(node, declaredValidFunctions, declaredValidFunctions.actionMaps)) {
        // Direct built-in robot action call (e.g. move()) alone doesn't satisfy custom user function requirement
        if (!(node.callee?.type === 'Identifier' && isRobotAction(node.callee.name))) {
          calledValidFunction = true;
        }
      }

      // Check if a declared valid function is passed as an argument (e.g. repeat(3, step) or arr.forEach(step))
      if (node.type === 'CallExpression' && Array.isArray(node.arguments)) {
        for (const arg of node.arguments) {
          if (arg?.type === 'Identifier' && (declaredValidFunctions.has(arg.name) || declaredValidFunctions.actionMaps.has(arg.name))) {
            calledValidFunction = true;
          } else if (arg?.type === 'MemberExpression') {
            const propName = arg.property?.name || arg.property?.value;
            if (
              propName &&
              (declaredValidFunctions.has(propName) ||
                (arg.object?.name && declaredValidFunctions.has(`${arg.object.name}.${propName}`)) ||
                (arg.object?.name && declaredValidFunctions.actionMaps.has(arg.object.name)))
            ) {
              calledValidFunction = true;
            }
          }
        }
      }
    });

    return calledValidFunction;
  } catch {
    const matches = code.match(/(?:function\s+([a-zA-Z_$][\w$]*)|(?:const|let|var)\s+([a-zA-Z_$][\w$]*)\s*=\s*(?:\([^)]*\)|[a-zA-Z_$][\w$]*)\s*=>|([a-zA-Z_$][\w$]*)\s*\([^)]*\)\s*\{)/g);
    if (!matches || matches.length === 0) return false;

    for (const match of matches) {
      const nameMatch = match.match(/(?:function\s+([a-zA-Z_$][\w$]*)|(?:const|let|var)\s+([a-zA-Z_$][\w$]*)|([a-zA-Z_$][\w$]*)\s*\()/);
      const fnName = nameMatch?.[1] || nameMatch?.[2] || nameMatch?.[3];
      if (fnName && new RegExp(`\\b${fnName}\\s*\\(`, 'g').test(code.replace(match, ''))) {
        return /(?:move|turnRight|turnLeft)\s*\(/.test(code);
      }
    }
    return false;
  }
}

function bodyHasActiveRobotAction(
  bodyNode: any,
  validCalledSet: RobotFunctionLookup,
  actionMaps: Set<string> = (validCalledSet as any)?.actionMaps || new Set()
): boolean {
  let found = false;

  function walk(node: any) {
    if (!node || typeof node !== 'object' || found) return;

    if (node.type === 'IfStatement') {
      const staticTest = evalStaticValue(node.test);
      if (staticTest.isStatic) {
        if (staticTest.value) {
          if (node.consequent) walk(node.consequent);
        } else {
          if (node.alternate) walk(node.alternate);
        }
        return;
      }
    }

    if (isReachableRobotCall(node, validCalledSet, actionMaps)) {
      found = true;
      return;
    }

    if (
      node.type === 'Identifier' &&
      (isRobotAction(node.name) || validCalledSet.has(node.name) || actionMaps.has(node.name))
    ) {
      found = true;
      return;
    }

    if (node.type === 'MemberExpression') {
      if (node.object?.type === 'Identifier' && (actionMaps.has(node.object.name) || validCalledSet.has(node.object.name))) {
        found = true;
        return;
      }
      const propName = node.property?.name || node.property?.value;
      if (propName) {
        if (isRobotAction(propName) || validCalledSet.has(propName)) {
          found = true;
          return;
        }
        if (node.object?.type === 'Identifier' && node.object.name) {
          const fullMemberName = `${node.object.name}.${propName}`;
          if (validCalledSet.has(fullMemberName)) {
            found = true;
            return;
          }
        }
      }
    }

    for (const key of Object.keys(node)) {
      if (key !== 'loc' && key !== 'range') {
        const child = node[key];
        if (Array.isArray(child)) {
          for (const item of child) walk(item);
        } else if (child && typeof child === 'object') {
          walk(child);
        }
      }
    }
  }

  walk(bodyNode);
  return found;
}

function getShadowedIdentifiersInFunction(fnNode: any): Set<string> {
  const shadowed = new Set<string>();
  if (!fnNode || typeof fnNode !== 'object') return shadowed;
  if (Array.isArray(fnNode.params)) {
    for (const p of fnNode.params) {
      if (p?.type === 'Identifier') shadowed.add(p.name);
      else if (p?.type === 'AssignmentPattern' && p.left?.type === 'Identifier') shadowed.add(p.left.name);
      else if (p?.type === 'RestElement' && p.argument?.type === 'Identifier') shadowed.add(p.argument.name);
      else if (p?.type === 'ObjectPattern' && Array.isArray(p.properties)) {
        for (const prop of p.properties) {
          if (prop?.value?.type === 'Identifier') shadowed.add(prop.value.name);
        }
      } else if (p?.type === 'ArrayPattern' && Array.isArray(p.elements)) {
        for (const el of p.elements) {
          if (el?.type === 'Identifier') shadowed.add(el.name);
        }
      }
    }
  }
  function walkBody(n: any) {
    if (!n || typeof n !== 'object') return;
    if (n !== fnNode && (n.type === 'FunctionDeclaration' || n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression')) {
      if (n.type === 'FunctionDeclaration' && n.id?.name) {
        shadowed.add(n.id.name);
      }
      return;
    }
    if (n.type === 'VariableDeclarator') {
      if (n.id?.type === 'Identifier') shadowed.add(n.id.name);
      else if (n.id?.type === 'ObjectPattern' && Array.isArray(n.id.properties)) {
        for (const prop of n.id.properties) {
          if (prop?.value?.type === 'Identifier') shadowed.add(prop.value.name);
        }
      } else if (n.id?.type === 'ArrayPattern' && Array.isArray(n.id.elements)) {
        for (const el of n.id.elements) {
          if (el?.type === 'Identifier') shadowed.add(el.name);
        }
      }
    }
    for (const key of Object.keys(n)) {
      if (key !== 'loc' && key !== 'range') {
        const child = n[key];
        if (Array.isArray(child)) {
          for (const item of child) walkBody(item);
        } else if (child && typeof child === 'object') {
          walkBody(child);
        }
      }
    }
  }
  if (fnNode.body) walkBody(fnNode.body);
  return shadowed;
}

/** Only membership is ever checked, so a scope can be a live view instead of a copied Set. */
type AliasLookup = { has(name: string): boolean };

/**
 * Aliases visible inside `fnNode`: everything visible in the enclosing scope (closures keep
 * seeing their outer function's aliases) plus the function's own, respecting shadowed identifiers.
 */
function scopeAliasLookup(
  enclosing: AliasLookup,
  functionScopeAliases: Map<any, Set<string>>,
  fnNode: any,
  shadowedMap?: Map<any, Set<string>>,
): AliasLookup {
  const shadowed = shadowedMap?.get(fnNode);
  return {
    has: (name) => {
      if (shadowed?.has(name)) {
        return functionScopeAliases.get(fnNode)?.has(name) === true;
      }
      return enclosing.has(name) || functionScopeAliases.get(fnNode)?.has(name) === true;
    },
  };
}

function isRouteExpressionNode(
  expr: any,
  routeAliases: AliasLookup,
  functionsReturningRoute?: Set<string>,
): boolean {
  if (!expr || typeof expr !== 'object') return false;
  if (expr.type === 'Identifier' && routeAliases.has(expr.name)) return true;
  if (expr.type === 'ArrayExpression' && Array.isArray(expr.elements)) {
    for (const el of expr.elements) {
      if (el?.type === 'SpreadElement' && isRouteExpressionNode(el.argument, routeAliases, functionsReturningRoute)) {
        return true;
      }
    }
  }
  if (
    expr.type === 'CallExpression' &&
    expr.callee?.type === 'MemberExpression' &&
    isRouteExpressionNode(expr.callee.object, routeAliases, functionsReturningRoute)
  ) {
    return true;
  }
  if (
    expr.type === 'CallExpression' &&
    expr.callee?.type === 'MemberExpression' &&
    expr.callee.object?.type === 'Identifier' &&
    expr.callee.object.name === 'Array' &&
    expr.callee.property?.type === 'Identifier' &&
    expr.callee.property.name === 'from' &&
    Array.isArray(expr.arguments) &&
    expr.arguments.length > 0 &&
    isRouteExpressionNode(expr.arguments[0], routeAliases, functionsReturningRoute)
  ) {
    return true;
  }
  if (expr.type === 'CallExpression' && functionsReturningRoute && functionsReturningRoute.size > 0) {
    let calleeName: string | null = null;
    if (expr.callee?.type === 'Identifier') {
      calleeName = expr.callee.name;
    } else if (expr.callee?.type === 'MemberExpression') {
      const p = expr.callee.property?.name || expr.callee.property?.value;
      if (expr.callee.object?.name && p) {
        if (functionsReturningRoute.has(`${expr.callee.object.name}.${p}`)) return true;
      }
      calleeName = p;
    }
    if (calleeName && functionsReturningRoute.has(calleeName)) return true;
  }
  return false;
}

function doesFunctionReturnRoute(
  fnNode: any,
  activeAliases: AliasLookup,
  functionsReturningRoute: Set<string>,
): boolean {
  if (!fnNode) return false;
  if (fnNode.type === 'ArrowFunctionExpression' && fnNode.body?.type !== 'BlockStatement') {
    return isRouteExpressionNode(fnNode.body, activeAliases, functionsReturningRoute);
  }
  let returnsRoute = false;
  function walk(n: any) {
    if (!n || typeof n !== 'object' || returnsRoute) return;
    if (
      n !== fnNode &&
      (n.type === 'FunctionDeclaration' ||
        n.type === 'FunctionExpression' ||
        n.type === 'ArrowFunctionExpression')
    ) {
      return;
    }
    if (n.type === 'ReturnStatement' && n.argument) {
      if (isRouteExpressionNode(n.argument, activeAliases, functionsReturningRoute)) {
        returnsRoute = true;
        return;
      }
    }
    for (const key of Object.keys(n)) {
      if (key !== 'loc' && key !== 'range') {
        const c = n[key];
        if (Array.isArray(c)) {
          for (const item of c) walk(item);
        } else if (c && typeof c === 'object') {
          walk(c);
        }
      }
    }
  }
  walk(fnNode.body);
  return returnsRoute;
}

interface RouteAliasesResult {
  globalAliases: Set<string>;
  functionScopeAliases: Map<any, Set<string>>;
  shadowedMap: Map<any, Set<string>>;
  functionsReturningRoute: Set<string>;
}

function findRouteAliasesInAst(ast: any): RouteAliasesResult {
  const globalAliases = new Set<string>(['route']);
  const globalAliasGraph = new Map<string, string>();
  const functionScopeAliases = new Map<any, Set<string>>();
  const scopeAliasGraphs = new Map<any, Map<string, string>>();
  const functionsReturningRoute = new Set<string>();
  const shadowedMap = new Map<any, Set<string>>();

  function propagateAliases(aliases: Set<string>, graph: Map<string, string>): boolean {
    let anyAdded = false;
    const childrenMap = new Map<string, string[]>();
    graph.forEach((parent, child) => {
      let list = childrenMap.get(parent);
      if (!list) { list = []; childrenMap.set(parent, list); }
      list.push(child);
    });
    const queue = Array.from(aliases);
    while (queue.length > 0) {
      const curr = queue.shift()!;
      const children = childrenMap.get(curr);
      if (children) {
        for (const ch of children) {
          if (!aliases.has(ch)) {
            aliases.add(ch);
            queue.push(ch);
            anyAdded = true;
          }
        }
      }
    }
    return anyAdded;
  }

  interface FunctionDef {
    node: any;
    params: (string | null)[];
    defaultRouteParams: Set<number>;
  }

  const functionsByName = new Map<string, FunctionDef>();
  const functionAliases = new Map<string, string>(); // aliasName -> targetName
  const boundFunctions = new Map<string, { targetName: string; boundArgs: any[] }>();

  function extractParamNamesAndDefaults(fnNode: any): { params: (string | null)[]; defaultRouteParams: Set<number> } {
    if (!fnNode || !Array.isArray(fnNode.params)) return { params: [], defaultRouteParams: new Set() };
    const defaultRouteParams = new Set<number>();
    const params = fnNode.params.map((p: any) => {
      if (p?.type === 'Identifier') return p.name;
      if (p?.type === 'AssignmentPattern' && p.left?.type === 'Identifier') {
        return p.left.name;
      }
      if (p?.type === 'RestElement' && p.argument?.type === 'Identifier') return p.argument.name;
      return null;
    });
    return { params, defaultRouteParams };
  }

  function indexFunctions(node: any) {
    if (!node || typeof node !== 'object') return;

    if (
      node.type === 'FunctionDeclaration' ||
      node.type === 'FunctionExpression' ||
      node.type === 'ArrowFunctionExpression'
    ) {
      if (!shadowedMap.has(node)) {
        shadowedMap.set(node, getShadowedIdentifiersInFunction(node));
      }
    }

    if (node.type === 'FunctionDeclaration' && node.id?.name && Array.isArray(node.params)) {
      const { params, defaultRouteParams } = extractParamNamesAndDefaults(node);
      functionsByName.set(node.id.name, { node, params, defaultRouteParams });
    } else if (node.type === 'VariableDeclarator' && node.id?.name) {
      if (node.init && (node.init.type === 'FunctionExpression' || node.init.type === 'ArrowFunctionExpression') && Array.isArray(node.init.params)) {
        const { params, defaultRouteParams } = extractParamNamesAndDefaults(node.init);
        functionsByName.set(node.id.name, { node: node.init, params, defaultRouteParams });
      } else if (node.init?.type === 'Identifier' && node.init.name) {
        functionAliases.set(node.id.name, node.init.name);
      } else if (
        node.init?.type === 'CallExpression' &&
        node.init.callee?.type === 'MemberExpression' &&
        node.init.callee.property?.name === 'bind' &&
        node.init.callee.object
      ) {
        let targetName: string | null = null;
        if (node.init.callee.object.type === 'Identifier') {
          targetName = node.init.callee.object.name;
        } else if (node.init.callee.object.type === 'MemberExpression') {
          targetName = node.init.callee.object.property?.name || node.init.callee.object.property?.value;
        } else if (
          node.init.callee.object.type === 'FunctionExpression' ||
          node.init.callee.object.type === 'ArrowFunctionExpression'
        ) {
          const { params, defaultRouteParams } = extractParamNamesAndDefaults(node.init.callee.object);
          targetName = node.id.name;
          functionsByName.set(node.id.name, { node: node.init.callee.object, params, defaultRouteParams });
        }
        if (targetName) {
          boundFunctions.set(node.id.name, {
            targetName,
            boundArgs: Array.isArray(node.init.arguments) ? node.init.arguments.slice(1) : [],
          });
          functionAliases.set(node.id.name, targetName);
        }
      }
    } else if (
      node.type === 'Property' &&
      node.key &&
      (node.value?.type === 'FunctionExpression' || node.value?.type === 'ArrowFunctionExpression') &&
      Array.isArray(node.value.params)
    ) {
      const name = node.key.name || node.key.value;
      if (name) {
        const { params, defaultRouteParams } = extractParamNamesAndDefaults(node.value);
        functionsByName.set(name, { node: node.value, params, defaultRouteParams });
      }
    } else if (node.type === 'MethodDefinition' && node.key && node.value && Array.isArray(node.value.params)) {
      const name = node.key.name || node.key.value;
      if (name) {
        const { params, defaultRouteParams } = extractParamNamesAndDefaults(node.value);
        functionsByName.set(name, { node: node.value, params, defaultRouteParams });
      }
    } else if (
      node.type === 'AssignmentExpression' &&
      node.right &&
      (node.right.type === 'FunctionExpression' || node.right.type === 'ArrowFunctionExpression') &&
      Array.isArray(node.right.params)
    ) {
      let name: string | null = null;
      let objName: string | null = null;
      if (node.left?.type === 'Identifier') {
        name = node.left.name;
      } else if (node.left?.type === 'MemberExpression') {
        name = node.left.property?.name || node.left.property?.value;
        objName = node.left.object?.name;
      }
      if (name) {
        const { params, defaultRouteParams } = extractParamNamesAndDefaults(node.right);
        functionsByName.set(name, { node: node.right, params, defaultRouteParams });
        if (objName) functionsByName.set(`${objName}.${name}`, { node: node.right, params, defaultRouteParams });
      }
    } else if (node.type === 'AssignmentExpression' && node.left?.type === 'Identifier' && node.right?.type === 'Identifier') {
      functionAliases.set(node.left.name, node.right.name);
    }
    for (const key of Object.keys(node)) {
      if (key !== 'loc' && key !== 'range') {
        const child = node[key];
        if (Array.isArray(child)) {
          for (const item of child) indexFunctions(item);
        } else if (child && typeof child === 'object') {
          indexFunctions(child);
        }
      }
    }
  }

  indexFunctions(ast);

  function resolveFunction(name: string): FunctionDef | null {
    let curr: string | undefined = name;
    const visited = new Set<string>();
    while (curr && !visited.has(curr)) {
      visited.add(curr);
      if (functionsByName.has(curr)) return functionsByName.get(curr)!;
      curr = functionAliases.get(curr);
    }
    return null;
  }

  function setsEqual<T>(a: Set<T> | undefined, b: Set<T> | undefined): boolean {
    if (!a && !b) return true;
    if (!a || !b) return false;
    if (a.size !== b.size) return false;
    for (const item of a) {
      if (!b.has(item)) return false;
    }
    return true;
  }

  let changed = true;
  let passCount = 0;
  while (changed && passCount < 10) {
    passCount++;
    changed = false;

    const prevGlobal = new Set(globalAliases);
    const prevScope = new Map<any, Set<string>>();
    functionScopeAliases.forEach((v, k) => {
      prevScope.set(k, new Set(v));
    });
    const prevReturns = new Set(functionsReturningRoute);
    const prevDefaults = new Map<FunctionDef, Set<number>>();
    functionsByName.forEach((fn) => {
      prevDefaults.set(fn, new Set(fn.defaultRouteParams));
    });

    // Check default parameters and return statements
    functionsByName.forEach((fnDef, name) => {
      const fnNode = fnDef.node;
      const fnScopeAliases = scopeAliasLookup(globalAliases, functionScopeAliases, fnNode, shadowedMap);

      if (Array.isArray(fnNode.params)) {
        for (let i = 0; i < fnNode.params.length; i++) {
          const p = fnNode.params[i];
          if (p?.type === 'AssignmentPattern' && p.left?.type === 'Identifier') {
            if (isRouteExpressionNode(p.right, fnScopeAliases, functionsReturningRoute)) {
              if (!fnDef.defaultRouteParams.has(i)) {
                fnDef.defaultRouteParams.add(i);
                changed = true;
              }
            } else {
              if (fnDef.defaultRouteParams.has(i)) {
                fnDef.defaultRouteParams.delete(i);
                changed = true;
              }
            }
          }
        }
      }

      if (!functionsReturningRoute.has(name)) {
        if (doesFunctionReturnRoute(fnNode, fnScopeAliases, functionsReturningRoute)) {
          functionsReturningRoute.add(name);
          changed = true;
        }
      }
    });

    const callsByFunction = new Map<FunctionDef, { args: any[]; activeAliases: AliasLookup }[]>();
    const anonymousCalls = new Map<any, { args: any[]; activeAliases: AliasLookup }[]>();

    function walk(node: any, currentFunctionNode: any, activeAliases: AliasLookup) {
      if (!node || typeof node !== 'object') return;

      const isFunction =
        node.type === 'FunctionDeclaration' ||
        node.type === 'FunctionExpression' ||
        node.type === 'ArrowFunctionExpression';

      const nextFunctionNode = isFunction ? node : currentFunctionNode;
      const childAliases = isFunction
        ? scopeAliasLookup(activeAliases, functionScopeAliases, node, shadowedMap)
        : activeAliases;

      if (node.type === 'VariableDeclarator' && node.id?.type === 'Identifier') {
        const isRoute = isRouteExpressionNode(node.init, activeAliases, functionsReturningRoute);
        if (isRoute) {
          if (currentFunctionNode) {
            let s = functionScopeAliases.get(currentFunctionNode);
            if (!s) { s = new Set(); functionScopeAliases.set(currentFunctionNode, s); }
            if (!s.has(node.id.name)) {
              s.add(node.id.name);
              changed = true;
            }
            let g = scopeAliasGraphs.get(currentFunctionNode);
            if (g) g.delete(node.id.name);
          } else {
            if (!globalAliases.has(node.id.name)) {
              globalAliases.add(node.id.name);
              changed = true;
            }
            globalAliasGraph.delete(node.id.name);
          }
        } else if (node.init?.type === 'Identifier') {
          if (currentFunctionNode) {
            let g = scopeAliasGraphs.get(currentFunctionNode);
            if (!g) { g = new Map(); scopeAliasGraphs.set(currentFunctionNode, g); }
            g.set(node.id.name, node.init.name);
          } else {
            globalAliasGraph.set(node.id.name, node.init.name);
          }
        }
      }

      if (node.type === 'AssignmentExpression' && node.left?.type === 'Identifier') {
        const isRoute = isRouteExpressionNode(node.right, activeAliases, functionsReturningRoute);
        if (isRoute) {
          if (currentFunctionNode) {
            let s = functionScopeAliases.get(currentFunctionNode);
            if (!s) { s = new Set(); functionScopeAliases.set(currentFunctionNode, s); }
            if (!s.has(node.left.name)) {
              s.add(node.left.name);
              changed = true;
            }
            let g = scopeAliasGraphs.get(currentFunctionNode);
            if (g) g.delete(node.left.name);
          } else {
            if (!globalAliases.has(node.left.name)) {
              globalAliases.add(node.left.name);
              changed = true;
            }
            globalAliasGraph.delete(node.left.name);
          }
        } else if (node.right?.type === 'Identifier') {
          if (currentFunctionNode) {
            let g = scopeAliasGraphs.get(currentFunctionNode);
            if (!g) { g = new Map(); scopeAliasGraphs.set(currentFunctionNode, g); }
            g.set(node.left.name, node.right.name);
          } else {
            globalAliasGraph.set(node.left.name, node.right.name);
          }
        } else {
          // Reassigned to non-route: remove from aliases
          if (currentFunctionNode) {
            const s = functionScopeAliases.get(currentFunctionNode);
            if (s && s.has(node.left.name)) {
              s.delete(node.left.name);
              changed = true;
            }
            let g = scopeAliasGraphs.get(currentFunctionNode);
            if (g) g.delete(node.left.name);
          } else {
            if (globalAliases.has(node.left.name)) {
              globalAliases.delete(node.left.name);
              changed = true;
            }
            globalAliasGraph.delete(node.left.name);
          }
        }
      }

      if (node.type === 'CallExpression' && Array.isArray(node.arguments)) {
        let calleeName: string | null = null;
        let fullCalleeName: string | null = null;
        let actualArgs = node.arguments;

        if (node.callee?.type === 'Identifier') {
          calleeName = node.callee.name;
          const boundInfo = node.callee.name ? boundFunctions.get(node.callee.name) : undefined;
          if (boundInfo) {
            actualArgs = [...boundInfo.boundArgs, ...node.arguments];
            calleeName = boundInfo.targetName;
          }
        } else if (node.callee?.type === 'MemberExpression') {
          const propName = node.callee.property?.name || node.callee.property?.value;
          if (propName === 'call' || propName === 'bind') {
            if (node.callee.object?.type === 'Identifier') {
              calleeName = node.callee.object.name;
            } else if (node.callee.object?.type === 'MemberExpression') {
              calleeName = node.callee.object.property?.name || node.callee.object.property?.value;
            }
            actualArgs = node.arguments.slice(1);
          } else if (propName === 'apply') {
            if (node.callee.object?.type === 'Identifier') {
              calleeName = node.callee.object.name;
            } else if (node.callee.object?.type === 'MemberExpression') {
              calleeName = node.callee.object.property?.name || node.callee.object.property?.value;
            }
            if (node.arguments[1]?.type === 'ArrayExpression' && Array.isArray(node.arguments[1].elements)) {
              actualArgs = node.arguments[1].elements;
            } else {
              actualArgs = [];
            }
          } else {
            calleeName = propName;
            if (node.callee.object?.name && propName) {
              fullCalleeName = `${node.callee.object.name}.${propName}`;
            }
          }
        }

        const targetFn = (fullCalleeName && resolveFunction(fullCalleeName)) || (calleeName && resolveFunction(calleeName));
        if (targetFn) {
          let list = callsByFunction.get(targetFn);
          if (!list) { list = []; callsByFunction.set(targetFn, list); }
          list.push({ args: actualArgs, activeAliases });
        } else if (
          (node.callee?.type === 'FunctionExpression' || node.callee?.type === 'ArrowFunctionExpression') &&
          Array.isArray(node.callee.params)
        ) {
          let list = anonymousCalls.get(node.callee);
          if (!list) { list = []; anonymousCalls.set(node.callee, list); }
          list.push({ args: actualArgs, activeAliases });
        }
      }

      for (const key of Object.keys(node)) {
        if (key !== 'loc' && key !== 'range') {
          const child = node[key];
          if (Array.isArray(child)) {
            for (const item of child) walk(item, nextFunctionNode, childAliases);
          } else if (child && typeof child === 'object') {
            walk(child, nextFunctionNode, childAliases);
          }
        }
      }
    }

    walk(ast, null, globalAliases);

    if (propagateAliases(globalAliases, globalAliasGraph)) {
      changed = true;
    }
    functionScopeAliases.forEach((scopeSet, fnNode) => {
      const g = scopeAliasGraphs.get(fnNode);
      if (g && propagateAliases(scopeSet, g)) {
        changed = true;
      }
    });

    // Process parameters for indexed functions: every call must pass route (or default route)
    functionsByName.forEach((targetFn) => {
      const calls = callsByFunction.get(targetFn) || [];
      let s = functionScopeAliases.get(targetFn.node);
      if (!s) { s = new Set(); functionScopeAliases.set(targetFn.node, s); }

      for (let i = 0; i < targetFn.params.length; i++) {
        const paramName = targetFn.params[i];
        if (!paramName) continue;

        const hasDefault = targetFn.defaultRouteParams.has(i);

        if (calls.length === 0) {
          if (hasDefault) {
            if (!s.has(paramName)) {
              s.add(paramName);
              changed = true;
            }
          }
        } else {
          let allCallsPassRoute = true;
          for (const call of calls) {
            const arg = call.args[i];
            if (arg !== undefined) {
              if (!isRouteExpressionNode(arg, call.activeAliases, functionsReturningRoute)) {
                allCallsPassRoute = false;
                break;
              }
            } else {
              if (!hasDefault) {
                allCallsPassRoute = false;
                break;
              }
            }
          }

          if (allCallsPassRoute) {
            if (!s.has(paramName)) {
              s.add(paramName);
              changed = true;
            }
          } else {
            if (s.has(paramName)) {
              s.delete(paramName);
              changed = true;
            }
          }
        }
      }
    });

    // Process anonymous function calls
    anonymousCalls.forEach((calls, fnNode) => {
      let s = functionScopeAliases.get(fnNode);
      if (!s) { s = new Set(); functionScopeAliases.set(fnNode, s); }

      const params = fnNode.params.map((p: any) =>
        p?.type === 'Identifier' ? p.name : p?.type === 'AssignmentPattern' && p.left?.type === 'Identifier' ? p.left.name : null
      );

      for (let i = 0; i < params.length; i++) {
        const paramName = params[i];
        if (!paramName) continue;

        let allCallsPassRoute = calls.length > 0;
        for (const call of calls) {
          const arg = call.args[i];
          if (arg !== undefined) {
            if (!isRouteExpressionNode(arg, call.activeAliases, functionsReturningRoute)) {
              allCallsPassRoute = false;
              break;
            }
          } else {
            allCallsPassRoute = false;
            break;
          }
        }

        if (allCallsPassRoute) {
          if (!s.has(paramName)) {
            s.add(paramName);
            changed = true;
          }
        } else {
          if (s.has(paramName)) {
            s.delete(paramName);
            changed = true;
          }
        }
      }
    });

    let hasChanges = false;
    if (!setsEqual(prevGlobal, globalAliases)) hasChanges = true;
    if (!setsEqual(prevReturns, functionsReturningRoute)) hasChanges = true;
    if (!hasChanges) {
      functionScopeAliases.forEach((v, k) => {
        if (!setsEqual(prevScope.get(k), v)) {
          hasChanges = true;
        }
      });
    }
    if (!hasChanges) {
      functionsByName.forEach((fn) => {
        if (!setsEqual(prevDefaults.get(fn), fn.defaultRouteParams)) {
          hasChanges = true;
        }
      });
    }
    changed = hasChanges;
  }

  return { globalAliases, functionScopeAliases, shadowedMap, functionsReturningRoute };
}

const ROUTE_ELEMENT_PROPERTIES = new Set(['at', 'shift', 'pop', 'slice', 'splice']);

function isRouteElementAccess(node: any, routeAliases: AliasLookup): boolean {
  if (
    node &&
    node.type === 'MemberExpression' &&
    node.object?.type === 'Identifier' &&
    routeAliases.has(node.object.name)
  ) {
    if (node.computed) {
      return true;
    }
    const propName = node.property?.name || node.property?.value;
    if (typeof propName === 'string' && ROUTE_ELEMENT_PROPERTIES.has(propName)) {
      return true;
    }
  }
  return false;
}

function loopAccessesRouteElements(loopNode: any, routeAliases: AliasLookup): boolean {
  let accessed = false;
  function walk(node: any) {
    if (!node || typeof node !== 'object' || accessed) return;
    if (isRouteElementAccess(node, routeAliases)) {
      accessed = true;
      return;
    }
    for (const key of Object.keys(node)) {
      if (key !== 'loc' && key !== 'range') {
        const child = node[key];
        if (Array.isArray(child)) {
          for (const item of child) walk(item);
        } else if (child && typeof child === 'object') {
          walk(child);
        }
      }
    }
  }

  if (loopNode.test) walk(loopNode.test);
  if (loopNode.init) walk(loopNode.init);
  if (loopNode.update) walk(loopNode.update);
  if (loopNode.body) walk(loopNode.body);

  return accessed;
}

function hasAnyReachableStatement(body: any): boolean {
  if (!body) return false;
  if (body.type === 'BlockStatement') {
    if (!Array.isArray(body.body)) return false;
    return body.body.some((stmt: any) => stmt && stmt.type !== 'EmptyStatement');
  }
  if (body.type === 'EmptyStatement') return false;
  return true;
}

/**
 * Validates that the user code actively references and iterates over the provided `route` array.
 */
export function usesRoute(code: string): boolean {
  try {
    const ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'script' }) as any;
    let foundRouteUsage = false;
    const stringConstants = collectStringConstants(ast);

    // Track identifiers that alias 'route' with function-level scoping
    const { globalAliases, functionScopeAliases, shadowedMap, functionsReturningRoute } = findRouteAliasesInAst(ast);

    const declaredValidFunctions = collectValidRobotFunctions(ast);

    let hasGlobalRobotCalls = false;
    traverseReachableAst(ast, (node) => {
      if (isReachableRobotCall(node, declaredValidFunctions)) {
        hasGlobalRobotCalls = true;
      }
    });

    function walkReachable(node: any, activeAliases: AliasLookup) {
      if (!node || typeof node !== 'object' || foundRouteUsage) return;

      if (node.type === 'BlockStatement' || node.type === 'Program') {
        if (Array.isArray(node.body)) {
          for (const stmt of node.body) {
            walkReachable(stmt, activeAliases);
            if (foundRouteUsage) return;
            if (
              stmt.type === 'ReturnStatement' ||
              stmt.type === 'ThrowStatement' ||
              stmt.type === 'BreakStatement' ||
              stmt.type === 'ContinueStatement'
            ) {
              break;
            }
          }
        }
        return;
      }

      const isFunction =
        node.type === 'FunctionDeclaration' ||
        node.type === 'FunctionExpression' ||
        node.type === 'ArrowFunctionExpression';

      const childAliases = isFunction
        ? scopeAliasLookup(activeAliases, functionScopeAliases, node, shadowedMap)
        : activeAliases;

      // 1. ForOf / ForIn: for (const x of route)
      if (node.type === 'ForOfStatement' || node.type === 'ForInStatement') {
        if (isRouteExpressionNode(node.right, activeAliases, functionsReturningRoute)) {
          if (hasGlobalRobotCalls) {
            if (bodyHasActiveRobotAction(node.body, declaredValidFunctions)) {
              foundRouteUsage = true;
            }
          } else if (hasAnyReachableStatement(node.body)) {
            foundRouteUsage = true;
          }
        }
      }

      // 2. Standard loops: for, while, do-while where loop accesses route elements
      if (
        node.type === 'ForStatement' ||
        node.type === 'WhileStatement' ||
        node.type === 'DoWhileStatement'
      ) {
        if (loopAccessesRouteElements(node, activeAliases)) {
          if (hasGlobalRobotCalls) {
            if (bodyHasActiveRobotAction(node, declaredValidFunctions)) {
              foundRouteUsage = true;
            }
          } else if (hasAnyReachableStatement(node.body)) {
            foundRouteUsage = true;
          }
        }
      }

      // 3. Iteration calls: route.forEach, route.map, Array.from(route, ...), etc.
      if (isIterationCall(node, stringConstants) && node.callee?.type === 'MemberExpression') {
        const isArrayFrom = isArrayFromWithMapper(node, stringConstants);
        const targetExpr = isArrayFrom ? node.arguments?.[0] : node.callee.object;
        const callbackIndex = getIterationCallbackIndex(node, stringConstants);
        if (isRouteExpressionNode(targetExpr, activeAliases, functionsReturningRoute)) {
          if (hasGlobalRobotCalls) {
            const callbackArg = node.arguments?.[callbackIndex];
            if (callbackArg && bodyHasActiveRobotAction(callbackArg, declaredValidFunctions)) {
              foundRouteUsage = true;
            }
          } else if (node.arguments && node.arguments.length > callbackIndex) {
            foundRouteUsage = true;
          }
        }
      }

      // 4. Passed as argument to a function or call: execute(route), processRoute(route)
      if (node.type === 'CallExpression' && Array.isArray(node.arguments)) {
        for (const arg of node.arguments) {
          if (isRouteExpressionNode(arg, activeAliases, functionsReturningRoute)) {
            let calleeName: string | null = null;
            if (node.callee?.type === 'Identifier') {
              calleeName = node.callee.name;
            } else if (node.callee?.type === 'MemberExpression') {
              calleeName = node.callee.property?.name || node.callee.property?.value;
            }
            if (calleeName && calleeName !== 'log' && calleeName !== 'warn' && calleeName !== 'error') {
              if (hasGlobalRobotCalls) {
                if (declaredValidFunctions.has(calleeName) || isRobotAction(calleeName)) {
                  foundRouteUsage = true;
                }
              } else {
                foundRouteUsage = true;
              }
            }
          }
        }
      }

      if (node.type === 'IfStatement') {
        const staticTest = evalStaticValue(node.test);
        if (staticTest.isStatic) {
          if (staticTest.value) {
            if (node.consequent) walkReachable(node.consequent, childAliases);
          } else {
            if (node.alternate) walkReachable(node.alternate, childAliases);
          }
          return;
        }
      }

      for (const key of Object.keys(node)) {
        if (key !== 'loc' && key !== 'range') {
          const child = node[key];
          if (Array.isArray(child)) {
            for (const item of child) walkReachable(item, childAliases);
          } else if (child && typeof child === 'object') {
            walkReachable(child, childAliases);
          }
        }
      }
    }

    walkReachable(ast, globalAliases);

    return foundRouteUsage;
  } catch {
    return /\broute\b/.test(code);
  }
}

/**
 * Validates that the user code uses an active loop (containing robot actions or helper functions)
 * to traverse the route, rather than a dead/fake loop with hardcoded commands.
 */
export function hasLoop(code: string): boolean {
  try {
    const ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'script' }) as any;
    const stringConstants = collectStringConstants(ast);
    const declaredValidFunctions = collectValidRobotFunctions(ast);
    let hasActiveLoop = false;

    // Collect all function bodies across the AST (declarations, variable/assignment/property expressions)
    const fnDefs = new Map<string, any>();

    function collectFnDefs(node: any) {
      if (!node || typeof node !== 'object') return;
      if (node.type === 'FunctionDeclaration' && node.id?.name) {
        fnDefs.set(node.id.name, node.body);
      } else if (node.type === 'VariableDeclarator' && node.id?.type === 'Identifier' && node.init) {
        if (node.init.type === 'ArrowFunctionExpression' || node.init.type === 'FunctionExpression') {
          fnDefs.set(node.id.name, node.init.body);
        }
      } else if (node.type === 'AssignmentExpression' && node.left?.type === 'Identifier' && node.right) {
        if (node.right.type === 'ArrowFunctionExpression' || node.right.type === 'FunctionExpression') {
          fnDefs.set(node.left.name, node.right.body);
        }
      } else if (
        node.type === 'Property' &&
        (node.key?.type === 'Identifier' || node.key?.type === 'Literal') &&
        node.value
      ) {
        const propName = node.key.name || node.key.value;
        if (
          propName &&
          (node.value.type === 'ArrowFunctionExpression' || node.value.type === 'FunctionExpression')
        ) {
          fnDefs.set(propName, node.value.body);
        }
      }
      for (const k of Object.keys(node)) {
        if (k !== 'loc' && k !== 'range') {
          const c = node[k];
          if (Array.isArray(c)) c.forEach(collectFnDefs);
          else if (c && typeof c === 'object') collectFnDefs(c);
        }
      }
    }
    collectFnDefs(ast);

    // Analyze non-loop robot actions and callees within a specific scope without descending into nested function definitions
    function analyzeScope(rootNode: any) {
      let directNonLoopRobotCalls = 0;
      const nonLoopCalls: string[] = [];

      function walk(node: any, inLoopContext = false) {
        if (!node || typeof node !== 'object') return;

        // Do NOT descend into nested function definitions, as they execute only when invoked
        if (node !== rootNode) {
          if (node.type === 'FunctionDeclaration') return;
          if (node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression') return;
        }

        if (node.type === 'BlockStatement' || node.type === 'Program') {
          if (Array.isArray(node.body)) {
            for (const stmt of node.body) {
              walk(stmt, inLoopContext);
              if (
                stmt.type === 'ReturnStatement' ||
                stmt.type === 'ThrowStatement' ||
                stmt.type === 'BreakStatement' ||
                stmt.type === 'ContinueStatement'
              ) {
                break;
              }
            }
          }
          return;
        }

        if (node.type === 'IfStatement') {
          const staticTest = evalStaticValue(node.test);
          if (staticTest.isStatic) {
            if (staticTest.value) {
              if (node.consequent) walk(node.consequent, inLoopContext);
            } else {
              if (node.alternate) walk(node.alternate, inLoopContext);
            }
            return;
          }
        }

        const isLoop =
          node.type === 'ForStatement' ||
          node.type === 'ForOfStatement' ||
          node.type === 'ForInStatement' ||
          node.type === 'WhileStatement' ||
          node.type === 'DoWhileStatement' ||
          isIterationCall(node, stringConstants);

        const nextInLoop = inLoopContext || isLoop;

        if (node.type === 'CallExpression') {
          let calleeName: string | null = null;
          if (node.callee?.type === 'Identifier') {
            calleeName = node.callee.name;
          } else if (node.callee?.type === 'MemberExpression') {
            calleeName = node.callee.property?.name || node.callee.property?.value;
          }

          if (calleeName) {
            if (!nextInLoop) {
              if (isRobotAction(calleeName)) {
                directNonLoopRobotCalls++;
              } else if (
                declaredValidFunctions.has(calleeName) ||
                declaredValidFunctions.actionMaps?.has(calleeName) ||
                fnDefs.has(calleeName)
              ) {
                nonLoopCalls.push(calleeName);
              }
            }
          } else if (
            !nextInLoop &&
            isReachableRobotCall(node, declaredValidFunctions, declaredValidFunctions.actionMaps)
          ) {
            directNonLoopRobotCalls++;
          }
        }

        for (const k of Object.keys(node)) {
          if (k !== 'loc' && k !== 'range') {
            const c = node[k];
            if (Array.isArray(c)) c.forEach((item) => walk(item, nextInLoop));
            else if (c && typeof c === 'object') walk(c, nextInLoop);
          }
        }
      }

      walk(rootNode, false);
      return { directNonLoopRobotCalls, nonLoopCalls };
    }

    const topScope = analyzeScope(ast);
    const fnWeights = new Map<string, number>();
    const visiting = new Set<string>();

    function getFnWeight(name: string): number {
      if (isRobotAction(name)) return 1;
      if (fnWeights.has(name)) return fnWeights.get(name)!;
      if (visiting.has(name)) return 0;
      if (!fnDefs.has(name)) {
        return declaredValidFunctions.has(name) ? 1 : 0;
      }
      visiting.add(name);

      const body = fnDefs.get(name);
      const scope = analyzeScope(body);
      let weight = scope.directNonLoopRobotCalls;
      for (const callee of scope.nonLoopCalls) {
        weight += getFnWeight(callee);
      }

      visiting.delete(name);
      fnWeights.set(name, weight);
      return weight;
    }

    let nonLoopRobotCalls = topScope.directNonLoopRobotCalls;
    for (const callee of topScope.nonLoopCalls) {
      nonLoopRobotCalls += getFnWeight(callee);
    }

    // Check loops for active robot commands or valid helper functions
    traverseReachableAst(ast, (node) => {
      const isStandardLoop =
        node.type === 'ForStatement' ||
        node.type === 'ForOfStatement' ||
        node.type === 'ForInStatement' ||
        node.type === 'WhileStatement' ||
        node.type === 'DoWhileStatement';

      if (node.type === 'ForStatement' && isDeadForLoop(node)) {
        return;
      }
      if (node.type === 'WhileStatement' && isDeadCondition(node.test)) {
        return;
      }
      if (
        (node.type === 'ForOfStatement' || node.type === 'ForInStatement') &&
        node.right?.type === 'ArrayExpression' &&
        node.right.elements?.length === 0
      ) {
        return;
      }

      if (isStandardLoop) {
        if (bodyHasActiveRobotAction(node, declaredValidFunctions)) {
          hasActiveLoop = true;
        }
      } else if (isIterationCall(node, stringConstants)) {
        if (
          node.callee?.type === 'MemberExpression' &&
          node.callee.object?.type === 'ArrayExpression' &&
          node.callee.object.elements?.length === 0
        ) {
          return;
        }
        if (
          isArrayFromWithMapper(node, stringConstants) &&
          node.arguments?.[0]?.type === 'ArrayExpression' &&
          node.arguments[0].elements?.length === 0
        ) {
          return;
        }
        // Only inspect the callback at callbackIndex (0 for Array methods, 1 for repeat and Array.from)
        const callbackIndex = getIterationCallbackIndex(node, stringConstants);
        const callbackArg = node.arguments?.[callbackIndex];
        if (callbackArg && bodyHasActiveRobotAction(callbackArg, declaredValidFunctions)) {
          hasActiveLoop = true;
        }
      }
    });

    return hasActiveLoop && nonLoopRobotCalls < 8;
  } catch {
    return /\b(for\s*\(|while\s*\(|\.forEach\(|\.map\(|\.filter\(|\.reduce\(|repeat\()/i.test(code);
  }
}

const INSTRUCTION_FIELDS = new Set(['command', 'action']);
const NON_ROBOT_OBJECTS = new Set(['console', 'Math', 'JSON', 'Object', 'Array', 'String', 'Number', 'Reflect']);

function walkNode(node: any, visit: (node: any) => boolean | void): boolean {
  if (!node || typeof node !== 'object') return false;
  if (visit(node) === true) return true;
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'range' || key === 'start' || key === 'end') continue;
    const child = node[key];
    if (Array.isArray(child) ? child.some(item => walkNode(item, visit)) : walkNode(child, visit)) return true;
  }
  return false;
}

function mentionsIdentifier(node: any, name: string): boolean {
  return walkNode(node, n => n.type === 'Identifier' && n.name === name);
}

function fieldName(key: any, computed: boolean): unknown {
  if (!computed && key?.type === 'Identifier') return key.name;
  if (key?.type === 'Literal') return key.value;
  const evaluated = evalStaticValue(key);
  return evaluated.isStatic ? evaluated.value : undefined;
}

/** Reads an instruction's command: `step.command`, `step['command']`, `({ command }) =>`, Object.values(step). */
function readsInstructionField(node: any): boolean {
  return walkNode(node, (n) => {
    if (n.type === 'MemberExpression' && INSTRUCTION_FIELDS.has(fieldName(n.property, !!n.computed) as string)) return true;
    if (n.type === 'Property' && n.key && INSTRUCTION_FIELDS.has(fieldName(n.key, !!n.computed) as string)) return true;
    return n.type === 'CallExpression'
      && n.callee?.type === 'MemberExpression'
      && n.callee.object?.type === 'Identifier'
      && n.callee.object.name === 'Object'
      && (n.callee.property?.name === 'values' || n.callee.property?.name === 'entries');
  });
}

/** Calls something that can move the robot: a command, a learner function or a dispatch table entry. */
function makesRobotCall(node: any): boolean {
  return walkNode(node, (n) => {
    if (n.type !== 'CallExpression') return false;
    const callee = n.callee;
    if (callee?.type === 'Identifier') return true;
    if (callee?.type !== 'MemberExpression') return false;
    if (callee.computed) return true;
    return !(callee.object?.type === 'Identifier' && NON_ROBOT_OBJECTS.has(callee.object.name));
  });
}

/**
 * Level 6: the code goes over the `instructions` array in a loop (for...of/in, an index loop or an
 * iteration method such as forEach), and in that loop reads an instruction's command and makes a
 * call that can move the robot. Mentioning `instructions` and a `command` field in unrelated places
 * (`instructions; const x = { command: 1 }; move();`) is not enough.
 */
export function usesInstructions(code: string): boolean {
  try {
    const ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'script' }) as any;
    const stringConstants = collectStringConstants(ast);
    let found = false;

    traverseReachableAst(ast, (node) => {
      if (found) return;
      let fieldScope: any = null;
      let callScope: any = null;
      if ((node.type === 'ForOfStatement' || node.type === 'ForInStatement') && mentionsIdentifier(node.right, 'instructions')) {
        // The command may be read in the loop header too: for (const c of instructions.map(s => s.command)).
        fieldScope = node;
        callScope = node.body;
      } else if (
        (node.type === 'ForStatement' || node.type === 'WhileStatement' || node.type === 'DoWhileStatement') &&
        walkNode(node, n => n.type === 'MemberExpression' && n.computed && n.object?.type === 'Identifier' && n.object.name === 'instructions')
      ) {
        fieldScope = node;
        callScope = node.body;
      } else if (
        isIterationCall(node, stringConstants) &&
        node.callee?.type === 'MemberExpression' &&
        mentionsIdentifier(node.callee.object, 'instructions')
      ) {
        // The command may be read earlier in the chain: instructions.map(s => s.command).forEach(exec).
        fieldScope = node;
        callScope = node.arguments?.[getIterationCallbackIndex(node, stringConstants)];
      }
      if (fieldScope && readsInstructionField(fieldScope) && makesRobotCall(callScope)) found = true;
    });

    return found;
  } catch {
    return /(for|while)[sS]*instructions/.test(code) && /.(command|action)/.test(code);
  }
}

