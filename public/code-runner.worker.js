/* JS Quest learner-code sandbox.
 *
 * This file intentionally contains no application imports. It is served with a
 * worker-specific CSP that blocks network access, while the main thread can
 * terminate it when learner code exceeds the time limit.
 */
(function () {
  'use strict';

  // Keep trusted capabilities and mutable built-ins in this closure before
  // sanitizing and freezing global objects.
  var NativeObject = Object;
  var NativeError = Error;
  var NativeTypeError = TypeError;
  var NativeFunction = Function;
  var safeArrayFrom = Array.from;
  var safeArrayIsArray = Array.isArray;
  var safeArrayFilter = Array.prototype.filter;
  var safeArrayIncludes = Array.prototype.includes;
  var safeArrayIndexOf = Array.prototype.indexOf;
  var safeArrayJoin = Array.prototype.join;
  var safeArrayMap = Array.prototype.map;
  var safeArrayPush = Array.prototype.push;
  var safeArraySlice = Array.prototype.slice;
  var safeArraySplice = Array.prototype.splice;
  var safeHasOwn = Object.prototype.hasOwnProperty;
  var safeJsonStringify = JSON.stringify;
  var safeNumber = Number;
  var safeNumberIsFinite = Number.isFinite;
  var safeNumberIsInteger = Number.isInteger;
  var safeObjectCreate = Object.create;
  var safeObjectFreeze = Object.freeze;
  var safeObjectDefineProperty = Object.defineProperty;
  var safeObjectGetPrototypeOf = Object.getPrototypeOf;
  var symbolIterator = Symbol.iterator;
  var safePostMessage = typeof self !== 'undefined' && self.postMessage ? self.postMessage.bind(self) : function () {};
  var safeAddEventListener = typeof self !== 'undefined' && self.addEventListener ? self.addEventListener.bind(self) : function () {};
  var safeReflectApply = Reflect.apply;
  var safeRegExpExec = RegExp.prototype.exec;
  var safeRegExpTest = RegExp.prototype.test;
  var safeStringTrim = String.prototype.trim;
  var safeString = String;
  var safeStringToUpperCase = String.prototype.toUpperCase;
  var safeStringToLowerCase = String.prototype.toLowerCase;
  var safeStringIndexOf = String.prototype.indexOf;
  var safeStringTrim = String.prototype.trim;
  var safeStringReplace = String.prototype.replace;
  var safeStringSplit = String.prototype.split;
  var NativeWeakSet = WeakSet;
  var safeWeakSetAdd = WeakSet.prototype.add;
  var safeWeakSetHas = WeakSet.prototype.has;
  var safeJsonParse = JSON.parse;
  var NativeWeakMap = WeakMap;
  var safeWeakMapGet = WeakMap.prototype.get;
  var safeWeakMapSet = WeakMap.prototype.set;

  function call(method, receiver, args) {
    return safeReflectApply(method, receiver, args);
  }

  var DIRECTIONS = ['up', 'right', 'down', 'left'];
  var DOM_ELEMENT_IDS = ['terminal', 'door', 'platform', 'button'];
  // Colours only (names, #hex, rgb()/hsl()): nothing that could load a URL or break out of a style.
  var SAFE_CSS_COLOR = /^(?:[a-zA-Z]{3,20}|#[0-9a-fA-F]{3,8}|(?:rgb|rgba|hsl|hsla)\([0-9.,%\s\/a-z-]{1,60}\))$/;

  function isSafeCssColor(value) {
    return typeof value === 'string' && value.length <= 64 && call(safeRegExpTest, SAFE_CSS_COLOR, [value]);
  }
  var MAX_RECORDED_LINE_EVENTS = 250;

  // Globals to sanitize on self, globalThis, DedicatedWorkerGlobalScope.prototype, WorkerGlobalScope.prototype
  var SANITIZED_GLOBALS = [
    'window',
    'document',
    'localStorage',
    'sessionStorage',
    'fetch',
    'XMLHttpRequest',
    'WebSocket',
    'EventSource',
    'indexedDB',
    'caches',
    'navigator',
    'location',
    'self',
    'globalThis',
    'importScripts',
    'Worker',
    'SharedWorker',
    'BroadcastChannel',
    'postMessage',
    'close',
    'setTimeout',
    'setInterval',
    'clearTimeout',
    'clearInterval',
    'queueMicrotask',
    'requestAnimationFrame',
    'cancelAnimationFrame',
    'Function',
    'eval',
    'openDatabase',
    'crypto',
    'SubtleCrypto',
    'Performance',
    'performance',
    'Notification',
    'FileReader',
    'FileReaderSync',
    'Blob',
    'File',
    'origin',
    'originAgentCluster',
    'btoa',
    'atob',
  ];

  // Parameter names to shadow in the generated function scope.
  // Note: 'eval' and 'arguments' are deliberately excluded because strict mode forbids them as parameter names.
  var SHADOWED_PARAMETERS = [
    'window',
    'document',
    'localStorage',
    'sessionStorage',
    'fetch',
    'XMLHttpRequest',
    'WebSocket',
    'EventSource',
    'indexedDB',
    'caches',
    'navigator',
    'location',
    'self',
    'globalThis',
    'importScripts',
    'Worker',
    'SharedWorker',
    'BroadcastChannel',
    'postMessage',
    'close',
    'setTimeout',
    'setInterval',
    'clearTimeout',
    'clearInterval',
    'queueMicrotask',
    'requestAnimationFrame',
    'cancelAnimationFrame',
    'Function',
    'Promise',
    'openDatabase',
    'crypto',
    'SubtleCrypto',
    'Performance',
    'performance',
    'Notification',
    'FileReader',
    'FileReaderSync',
    'Blob',
    'File',
    'origin',
    'originAgentCluster',
    'btoa',
    'atob',
    '__jsQuestEnterFn__',
    '__jsQuestExitFn__',
    '__jsQuestEnterLoop__',
    '__jsQuestExitLoop__',
  ];

  // Disable dynamic function constructors to prevent WorkerGlobalScope recovery
  var disabledFunctionConstructor = function () {
    throw new NativeError('Dynamic function evaluation is disabled in the sandbox.');
  };

  try {
    safeObjectDefineProperty(NativeFunction.prototype, 'constructor', {
      value: disabledFunctionConstructor,
      writable: false,
      configurable: false,
    });
  } catch (_) {}

  try {
    var asyncFunctionProto = safeObjectGetPrototypeOf(async function () {});
    if (asyncFunctionProto) {
      safeObjectDefineProperty(asyncFunctionProto, 'constructor', {
        value: disabledFunctionConstructor,
        writable: false,
        configurable: false,
      });
    }
  } catch (_) {}

  try {
    var generatorFunctionProto = safeObjectGetPrototypeOf(function* () {});
    if (generatorFunctionProto) {
      safeObjectDefineProperty(generatorFunctionProto, 'constructor', {
        value: disabledFunctionConstructor,
        writable: false,
        configurable: false,
      });
    }
  } catch (_) {}

  try {
    var asyncGeneratorFunctionProto = safeObjectGetPrototypeOf(async function* () {});
    if (asyncGeneratorFunctionProto) {
      safeObjectDefineProperty(asyncGeneratorFunctionProto, 'constructor', {
        value: disabledFunctionConstructor,
        writable: false,
        configurable: false,
      });
    }
  } catch (_) {}

  // Strip dangerous properties from self, DedicatedWorkerGlobalScope, and WorkerGlobalScope prototypes
  var globalScopesToSanitize = [];
  if (typeof self !== 'undefined') globalScopesToSanitize.push(self);
  if (typeof globalThis !== 'undefined') globalScopesToSanitize.push(globalThis);
  if (typeof DedicatedWorkerGlobalScope !== 'undefined' && DedicatedWorkerGlobalScope.prototype) {
    globalScopesToSanitize.push(DedicatedWorkerGlobalScope.prototype);
  }
  if (typeof WorkerGlobalScope !== 'undefined' && WorkerGlobalScope.prototype) {
    globalScopesToSanitize.push(WorkerGlobalScope.prototype);
  }

  for (var sIdx = 0; sIdx < globalScopesToSanitize.length; sIdx += 1) {
    var targetScope = globalScopesToSanitize[sIdx];
    for (var bIdx = 0; bIdx < SANITIZED_GLOBALS.length; bIdx += 1) {
      var propName = SANITIZED_GLOBALS[bIdx];
      try {
        delete targetScope[propName];
      } catch (_) {}
      try {
        safeObjectDefineProperty(targetScope, propName, {
          value: undefined,
          writable: false,
          configurable: false,
        });
      } catch (_) {}
    }
  }

  // --- Loop and function accounting the instrumenter cannot see -----------------------------
  // While learner code runs, `activeTracker` is set by runProgram. The callbacks of iteration
  // methods count as loop iterations however they are called (route.forEach(f),
  // Array.prototype.forEach.call(route, f), an alias, a computed name), and they receive exactly
  // the arguments and `this` plain JavaScript gives them. Only the real built-in methods do this:
  // a learner's own method that happens to be called forEach is an ordinary function.
  var activeTracker = null;
  var ArrayProto = Array.prototype;
  var ITERATION_CALLBACK_METHODS = ['forEach', 'map', 'filter', 'some', 'every', 'find', 'findIndex', 'findLast',
    'findLastIndex', 'flatMap', 'reduce', 'reduceRight'];

  function trackedCallback(callback, keepThis, loop) {
    var tracker = activeTracker;
    return function () {
      tracker.enterIteration(loop);
      try {
        return call(callback, keepThis ? this : undefined, arguments);
      } finally {
        tracker.exitIteration();
      }
    };
  }

  function iterationCallbackMethod(native, name, callbackIndex) {
    var isReduce = name === 'reduce' || name === 'reduceRight';
    return function () {
      var callback = arguments[callbackIndex];
      if (!activeTracker || typeof callback !== 'function') return call(native, this, arguments);
      var args = [];
      for (var r = 0; r < arguments.length; r += 1) args[r] = arguments[r];
      args[callbackIndex] = trackedCallback(callback, !isReduce, activeTracker.newLoop());
      return call(native, this, args);
    };
  }

  function patchIterationMethods(target, names, callbackIndex) {
    if (!target) return;
    for (var icIdx = 0; icIdx < names.length; icIdx += 1) {
      var icName = names[icIdx];
      if (typeof target[icName] === 'function') {
        safeObjectDefineProperty(target, icName, {
          value: iterationCallbackMethod(target[icName], icName, callbackIndex),
          writable: true,
          enumerable: false,
          configurable: true,
        });
      }
    }
  }

  var TypedArrayProto = typeof Int8Array === 'function' ? safeObjectGetPrototypeOf(Int8Array.prototype) : null;
  var IteratorProto = typeof Iterator === 'function' ? Iterator.prototype : null;
  patchIterationMethods(ArrayProto, ITERATION_CALLBACK_METHODS, 0);
  patchIterationMethods(TypedArrayProto, ITERATION_CALLBACK_METHODS, 0);
  patchIterationMethods(IteratorProto, ['forEach', 'map', 'filter', 'some', 'every', 'find', 'flatMap', 'reduce'], 0);
  patchIterationMethods(Map.prototype, ['forEach'], 0);
  patchIterationMethods(Set.prototype, ['forEach'], 0);
  patchIterationMethods(Array, ['from'], 1);

  // A generator keeps its place inside the learner's function (and inside any loop it was in)
  // while it is suspended at `yield`, but the code that resumed it is not inside them: whatever
  // the generator still has open is set aside when it suspends and given back when it resumes.
  var GeneratorProto = safeObjectGetPrototypeOf(function* () {}).prototype;
  var suspendedGeneratorDepths = new NativeWeakMap();

  function resumingGeneratorMethod(native) {
    return function () {
      var tracker = activeTracker;
      if (!tracker || this === null || typeof this !== 'object') return call(native, this, arguments);
      var generator = this;
      var base = tracker.depth();
      var held = call(safeWeakMapGet, suspendedGeneratorDepths, [generator]);
      if (held) tracker.resume(held);
      try {
        return call(native, generator, arguments);
      } finally {
        call(safeWeakMapSet, suspendedGeneratorDepths, [generator, tracker.cut(base)]);
      }
    };
  }

  var GENERATOR_METHODS = ['next', 'return', 'throw'];
  for (var gIdx = 0; gIdx < GENERATOR_METHODS.length; gIdx += 1) {
    safeObjectDefineProperty(GeneratorProto, GENERATOR_METHODS[gIdx], {
      value: resumingGeneratorMethod(GeneratorProto[GENERATOR_METHODS[gIdx]]),
      writable: false,
      enumerable: false,
      configurable: false,
    });
  }
  try { safeObjectFreeze(GeneratorProto); } catch (_) {}
  // Freeze prototypes to prevent prototype pollution attacks
  try { safeObjectFreeze(Object.prototype); } catch (_) {}
  try { safeObjectFreeze(Array.prototype); } catch (_) {}
  try { safeObjectFreeze(Function.prototype); } catch (_) {}
  try { safeObjectFreeze(Boolean.prototype); } catch (_) {}
  try { safeObjectFreeze(Number.prototype); } catch (_) {}
  try { safeObjectFreeze(String.prototype); } catch (_) {}
  try { safeObjectFreeze(Error.prototype); } catch (_) {}

  function toBool(val) {
    return !!val;
  }

  function copyPos(pos, extra) {
    var p = safeObjectCreate(null);
    p.x = safeNumber(extra && extra.x !== undefined ? extra.x : (pos ? pos.x : 0));
    p.y = safeNumber(extra && extra.y !== undefined ? extra.y : (pos ? pos.y : 0));
    p.dir = safeString(extra && extra.dir !== undefined ? extra.dir : (pos ? pos.dir : 'right'));
    p.blocked = toBool(extra && extra.blocked !== undefined ? extra.blocked : (pos ? pos.blocked : false));
    p.outOfBounds = toBool(extra && extra.outOfBounds !== undefined ? extra.outOfBounds : (pos ? pos.outOfBounds : false));
    p.killed = toBool(extra && extra.killed !== undefined ? extra.killed : (pos ? pos.killed : false));
    // emitRobot snapshots with copyPos(pos), so keyPicked must survive a plain copy too.
    var keyPicked = extra && extra.keyPicked !== undefined ? extra.keyPicked : (pos ? pos.keyPicked : false);
    if (keyPicked) p.keyPicked = true;
    return p;
  }

  function getDelta(direction) {
    if (direction === 'right') return [1, 0];
    if (direction === 'left') return [-1, 0];
    if (direction === 'up') return [0, -1];
    return [0, 1];
  }

  // Only errors created here may carry a runnerCode: learner code must not be able to
  // throw its own { runnerCode } or rewrite the code/message of a caught runner error.
  var runnerErrors = new NativeWeakSet();

  function runnerError(code, message) {
    var error = new NativeError(message);
    error.runnerCode = code;
    safeObjectFreeze(error);
    call(safeWeakSetAdd, runnerErrors, [error]);
    return error;
  }

  function isRunnerError(value) {
    return value !== null && typeof value === 'object' && call(safeWeakSetHas, runnerErrors, [value]);
  }

  // Scheduling APIs would run after the result is already reported, so their robot
  // commands would be silently lost. Fail loudly instead of leaving them undefined.
  var ASYNC_APIS = ['setTimeout', 'setInterval', 'queueMicrotask', 'requestAnimationFrame', 'Promise'];
  var PROMISE_STATICS = ['resolve', 'reject', 'all', 'allSettled', 'any', 'race', 'withResolvers', 'try'];

  function asyncUnsupported(name) {
    var fail = function () {
      throw runnerError(
        'RUNTIME_ERROR',
        name + ': асинхронний код не підтримується — робот виконує команди одразу, одну за одною.',
      );
    };
    if (name === 'Promise') {
      for (var pIdx = 0; pIdx < PROMISE_STATICS.length; pIdx += 1) {
        fail[PROMISE_STATICS[pIdx]] = fail;
      }
    }
    return fail;
  }

  function sanitizePosition(p) {
    if (!p) return { x: 0, y: 0, dir: 'right', blocked: false, outOfBounds: false, killed: false };
    var clean = {
      x: safeNumber(p.x) || 0,
      y: safeNumber(p.y) || 0,
      dir: safeString(p.dir) || 'right',
      blocked: toBool(p.blocked),
      outOfBounds: toBool(p.outOfBounds),
      killed: toBool(p.killed),
    };
    if (p.keyPicked) clean.keyPicked = true;
    return clean;
  }

  safeAddEventListener('message', function (messageEvent) {
    var payload = messageEvent.data;
    if (!payload || payload.type !== 'run' || typeof payload.runId !== 'string') return;

    var config = payload.config || {};
    var result = runProgram(payload, config);
    // Levels 5 and 6: the same code also runs on other data with a board made for it. Only the
    // outcome is reported; the learner sees the real run.
    if (result.ok && safeArrayIsArray(config.variants)) {
      result.variants = [];
      for (var vIdx = 0; vIdx < config.variants.length; vIdx += 1) {
        var variant = config.variants[vIdx] || {};
        var variantResult = runProgram(payload, {
          gridMap: variant.gridMap,
          initialPos: variant.initialPos,
          data: variant.data,
          mode: config.mode,
          throwOnOutOfBounds: config.throwOnOutOfBounds,
          maxSteps: config.maxSteps,
          maxOperations: config.maxOperations,
        });
        call(safeArrayPush, result.variants, [{
          ok: variantResult.ok,
          errorCode: variantResult.errorCode,
          finalPos: variantResult.finalPos,
          collectedKeys: variantResult.collectedKeys,
          steps: variantResult.steps,
        }]);
      }
    }
    safePostMessage({ type: 'result', runId: payload.runId, result: result });
  });

  function runProgram(payload, config) {
    var gridMap = safeArrayIsArray(config.gridMap) ? config.gridMap : [];
    var mode = config.mode || 'basic';
    var maxSteps = safeNumberIsFinite(config.maxSteps) ? config.maxSteps : 2000;
    var maxOperations = safeNumberIsFinite(config.maxOperations) ? config.maxOperations : 10000;
    var traceIdentifier = payload.traceIdentifier;

    if (!/^[$A-Z_a-z][$\w]*$/.test(traceIdentifier || '')) {
      return makeEmptyFailure('WORKER_ERROR', 'Некоректна конфігурація ізольованого виконавця.');
    }

    var events = [];
    var initial = config.initialPos || { x: 0, y: 0, dir: 'right' };
    var pos = copyPos(initial);
    var path = [copyPos(pos)];
    var steps = 0;
    var operations = 0;
    var loopIterations = 0;
    // Robot actions made inside a loop iteration: the body, condition or update of a loop
    // statement, a callback of an iteration method, or an action of repeat().
    var loopActions = 0;
    var userFunctionRobotActions = 0;
    var userFunctionDepth = 0;
    // Loop accounting. Every run of a loop statement, every call of an iteration method (forEach,
    // map, ...) and every repeat() is one loop instance; each run of its body, each callback call or
    // repeated action is one of its iterations, and a loop condition or update belongs to the
    // iteration it follows. A robot action counts as a loop action only if a loop instance it was
    // made in really repeated, i.e. made actions in at least two of its iterations: two loops that
    // each run once, or a two-pass decoy loop elsewhere, do not turn one-pass loops into loops.
    var loopFrames = []; // open loop instances and iterations, innermost last
    var stepLoops = []; // for each action made in an iteration: the loop instances it was made in
    var maxActiveIterations = 0;
    var recordedLineEvents = 0;
    var collectedKeys = [];
    var hasKeyValue = false;
    var doorOpened = false;
    var isDead = false;
    var fatalError = null;

    function checkFatalError() {
      if (fatalError) {
        throw fatalError;
      }
      if (isDead) {
        fatalError = runnerError('KILLED', 'Робота знищив ворог.');
        throw fatalError;
      }
      if (pos && pos.outOfBounds && config.throwOnOutOfBounds) {
        fatalError = runnerError('OUT_OF_BOUNDS', 'Робот вийшов за межі поля.');
        throw fatalError;
      }
      if (steps > maxSteps) {
        fatalError = runnerError('STEP_LIMIT', 'Занадто багато кроків! Можливо, нескінченний цикл.');
        throw fatalError;
      }
      if (operations > maxOperations) {
        fatalError = runnerError('OPERATION_LIMIT', 'Занадто багато операцій! Можливо, нескінченний цикл.');
        throw fatalError;
      }
    }

    var domState = {
      terminalUnlocked: false,
      doorOpen: false,
      platformActive: false,
      buttonClicked: false,
      // element id -> background colour set through element.style (shown on the board)
      colors: safeObjectCreate(null),
    };

    function enterFn() {
      countOperation();
      userFunctionDepth += 1;
    }

    function exitFn() {
      if (userFunctionDepth > 0) userFunctionDepth -= 1;
    }

    function countOperation() {
      operations += 1;
      if (operations > maxOperations) {
        fatalError = runnerError('OPERATION_LIMIT', 'Занадто багато операцій! Можливо, нескінченний цикл.');
        throw fatalError;
      }
    }

    function newLoop() {
      return { iteration: 0, lastActive: -1, active: 0 };
    }

    function openIteration(loop, isNewIteration) {
      if (isNewIteration) loop.iteration += 1;
      call(safeArrayPush, loopFrames, [{ loop: loop, isIteration: true }]);
    }

    function closeIteration() {
      for (var f = loopFrames.length - 1; f >= 0; f -= 1) {
        if (loopFrames[f].isIteration) {
          loopFrames.length = f;
          return;
        }
      }
    }

    function enclosingLoop() {
      for (var f = loopFrames.length - 1; f >= 0; f -= 1) {
        if (!loopFrames[f].isIteration) return loopFrames[f].loop;
      }
      return newLoop();
    }

    // The instrumenter calls enterLoop('loop') when a loop statement starts (and exitLoop('loop',
    // frame) when it ends however it ends), enterLoop(false) when its body starts an iteration and
    // enterLoop(true) around its condition and update.
    // for...of: the object it iterates, asked for each value inside the current iteration (a custom
    // iterator or a generator can move the robot in next()). Everything else is plain for...of:
    // [Symbol.iterator]() is called once, next is read once, return() is called on break.
    function iterateInLoop(iterable) {
      var loop = enclosingLoop();
      if (iterable === null || iterable === undefined || typeof iterable[symbolIterator] !== 'function') {
        throw new NativeTypeError(safeString(iterable) + ' is not iterable');
      }
      var wrapper = {};
      wrapper[symbolIterator] = function () {
        var iterator = call(iterable[symbolIterator], iterable, []);
        if (iterator === null || (typeof iterator !== 'object' && typeof iterator !== 'function')) {
          throw new NativeTypeError('Result of the Symbol.iterator method is not an object');
        }
        var next = iterator.next;
        return {
          next: function (value) {
            openIteration(loop, false);
            try {
              return call(next, iterator, [value]);
            } finally {
              closeIteration();
            }
          },
          return: function (value) {
            var close = iterator.return;
            if (close === undefined || close === null) return { done: true, value: value };
            return call(close, iterator, [value]);
          },
        };
      };
      return wrapper;
    }

    function enterLoop(mode, value) {
      countOperation();
      if (mode === 'iterable') return iterateInLoop(value);
      if (mode === 'loop') {
        var frame = { loop: newLoop(), isIteration: false };
        call(safeArrayPush, loopFrames, [frame]);
        return frame;
      }
      // Every iteration must consume the operation budget, including loops
      // whose body is empty or contains only declarations.
      if (mode !== true) loopIterations += 1;
      openIteration(enclosingLoop(), mode !== true);
      return undefined;
    }

    function exitLoop(mode, frame) {
      if (mode !== 'loop') {
        closeIteration();
        return;
      }
      for (var f = loopFrames.length - 1; f >= 0; f -= 1) {
        if (loopFrames[f] === frame) {
          loopFrames.length = f;
          return;
        }
      }
    }

    // Callbacks of iteration methods and the actions of repeat().
    function enterIteration(loop) {
      countOperation();
      loopIterations += 1;
      openIteration(loop, true);
    }

    function exitIteration() {
      closeIteration();
    }

    function recordLoopAction() {
      var loops = null;
      for (var f = 0; f < loopFrames.length; f += 1) {
        if (!loopFrames[f].isIteration) continue;
        var loop = loopFrames[f].loop;
        if (loop.lastActive !== loop.iteration) {
          loop.lastActive = loop.iteration;
          loop.active += 1;
          if (loop.active > maxActiveIterations) maxActiveIterations = loop.active;
        }
        if (!loops) loops = [];
        if (call(safeArrayIndexOf, loops, [loop]) === -1) call(safeArrayPush, loops, [loop]);
      }
      if (loops) call(safeArrayPush, stepLoops, [loops]);
    }

    function computeEffectiveLoopMetrics() {
      var counted = 0;
      for (var a = 0; a < stepLoops.length; a += 1) {
        // A single action needs no repetition; otherwise one of its loops must have repeated.
        var repeated = steps <= 1;
        for (var l = 0; !repeated && l < stepLoops[a].length; l += 1) {
          if (stepLoops[a][l].active >= 2) repeated = true;
        }
        if (repeated) counted += 1;
      }
      return {
        loopActions: counted,
        activeLoopIterations: maxActiveIterations,
      };
    }

    var tracker = {
      newLoop: newLoop,
      enterIteration: enterIteration,
      exitIteration: exitIteration,
      depth: function () {
        return [userFunctionDepth, loopFrames.length];
      },
      // Sets aside what a generator still has open when it suspends ...
      cut: function (base) {
        var held = [
          userFunctionDepth > base[0] ? userFunctionDepth - base[0] : 0,
          loopFrames.length > base[1] ? call(safeArraySlice, loopFrames, [base[1]]) : [],
        ];
        userFunctionDepth = base[0];
        if (loopFrames.length > base[1]) loopFrames.length = base[1];
        return held;
      },
      // ... and gives it back when it resumes, wherever that happens.
      resume: function (held) {
        userFunctionDepth += held[0];
        for (var h = 0; h < held[1].length; h += 1) call(safeArrayPush, loopFrames, [held[1][h]]);
      },
    };

    var safeJson = safeObjectFreeze({
      stringify: function () {
        return call(safeJsonStringify, undefined, arguments);
      },
      parse: function () {
        return call(safeJsonParse, undefined, arguments);
      },
    });

    function domSnapshot() {
      var colors = {};
      for (var cIdx = 0; cIdx < DOM_ELEMENT_IDS.length; cIdx += 1) {
        var colorId = DOM_ELEMENT_IDS[cIdx];
        if (domState.colors[colorId]) colors[colorId] = domState.colors[colorId];
      }
      return {
        terminalUnlocked: toBool(domState.terminalUnlocked),
        doorOpen: toBool(domState.doorOpen),
        platformActive: toBool(domState.platformActive),
        buttonClicked: toBool(domState.buttonClicked),
        colors: colors,
      };
    }

    function makeEmptyFailure(code, error) {
      var loopMetrics = computeEffectiveLoopMetrics();
      return {
        ok: false,
        errorCode: code,
        error: error,
        events: events || [],
        path: call(safeArrayMap, path || [copyPos(initial)], [sanitizePosition]),
        finalPos: sanitizePosition(pos || initial),
        steps: steps || 0,
        loopIterations: loopIterations || 0,
        activeLoopIterations: loopMetrics.activeLoopIterations,
        loopRobotActions: loopMetrics.loopActions,
        loopActions: loopMetrics.loopActions,
        userFunctionRobotActions: userFunctionRobotActions || 0,
        collectedKeys: call(safeArraySlice, collectedKeys || [], [0]),
        hasKey: toBool(hasKeyValue),
        doorOpened: toBool(doorOpened),
        isDead: toBool(isDead),
        domState: domSnapshot(),
      };
    }

    function emit(event) {
      if (events.length >= maxOperations * 3) {
        fatalError = runnerError('OPERATION_LIMIT', 'Занадто багато подій виконання.');
        throw fatalError;
      }
      call(safeArrayPush, events, [event]);
    }

    function trace(line) {
      countOperation();
      if (recordedLineEvents < MAX_RECORDED_LINE_EVENTS) {
        recordedLineEvents += 1;
        emit({ type: 'line', line: safeNumber(line) || 1 });
      }
    }

    function incrementStep(kind) {
      steps += 1;
      recordLoopAction();
      if (userFunctionDepth > 0) {
        userFunctionRobotActions += 1;
      }
      if (steps > maxSteps) {
        fatalError = runnerError('STEP_LIMIT', 'Занадто багато кроків! Можливо, нескінченний цикл.');
        throw fatalError;
      }
    }

    function isOutOfBounds(x, y) {
      return y < 0 || y >= gridMap.length || x < 0 || !gridMap[y] || x >= gridMap[y].length;
    }

    function cellAt(x, y) {
      return gridMap[y] && gridMap[y][x] ? gridMap[y][x] : 'path';
    }

    function isWallAt(x, y) {
      var cell = cellAt(x, y);
      if (cell === 'wall') return true;
      if (mode === 'key-door' && cell === 'door' && !hasKeyValue) return true;
      if (mode === 'dom' && cell === 'terminal' && !domState.terminalUnlocked) return true;
      if (mode === 'dom' && cell === 'door' && !domState.doorOpen) return true;
      if (mode === 'dom' && cell === 'platform' && !domState.platformActive) return true;
      return false;
    }

    function emitRobot(action, currentPos, cell, message) {
      var snapshot = copyPos(currentPos);
      call(safeArrayPush, path, [snapshot]);
      emit({ type: 'robot', action: action, pos: sanitizePosition(snapshot), step: steps, cell: cell, message: message });
    }

    function stepMoveOnce() {
      checkFatalError();
      incrementStep('move');
      var delta = getDelta(pos.dir);
      var nx = pos.x + delta[0];
      var ny = pos.y + delta[1];

      if (isOutOfBounds(nx, ny)) {
        pos = copyPos(pos, { outOfBounds: true, blocked: true });
        emitRobot('out-of-bounds', pos, undefined, 'OUT OF BOUNDS');
        if (config.throwOnOutOfBounds) {
          fatalError = runnerError('OUT_OF_BOUNDS', 'Робот вийшов за межі поля.');
          throw fatalError;
        }
        return;
      }

      if (isWallAt(nx, ny)) {
        var blockedCell = cellAt(nx, ny);
        var blockedMessage = blockedCell === 'door'
          ? 'Двері зачинено'
          : blockedCell === 'terminal'
            ? 'Термінал заблоковано'
            : blockedCell === 'platform'
              ? 'Платформа неактивна'
              : 'WALL';
        pos = copyPos(pos, { blocked: true, outOfBounds: false });
        emitRobot('blocked', pos, blockedCell, blockedMessage);
        return;
      }

      var cell = cellAt(nx, ny);
      pos = copyPos(pos, { x: nx, y: ny, blocked: false, outOfBounds: false });

      if ((mode === 'key-door' || mode === 'multi-key') && cell === 'enemy') {
        isDead = true;
        pos = copyPos(pos, { killed: true });
        emitRobot('death', pos, cell, 'KILLED');
        fatalError = runnerError('KILLED', 'Робота знищив ворог.');
        throw fatalError;
      }

      if ((mode === 'single-key' || mode === 'key-door' || mode === 'multi-key') && cell === 'key') {
        var keyId = nx + ',' + ny;
        var isNewKey = call(safeArrayIndexOf, collectedKeys, [keyId]) === -1;
        if (isNewKey) {
          call(safeArrayPush, collectedKeys, [keyId]);
        }
        hasKeyValue = true;
        emitRobot(isNewKey ? 'key' : 'move', copyPos(pos, isNewKey ? { keyPicked: true } : {}), cell, isNewKey ? 'КЛЮЧ ЗІБРАНО' : undefined);
        return;
      }

      if (mode === 'key-door' && cell === 'door') {
        var isFirstOpen = !doorOpened;
        doorOpened = true;
        emitRobot(isFirstOpen ? 'door' : 'move', pos, cell, isFirstOpen ? 'ДВЕРІ ВІДКРИТО' : undefined);
        return;
      }

      emitRobot('move', pos, cell);
    }

    function move(count) {
      if (arguments.length === 1 && typeof count === 'number') {
        checkFatalError();
        if (!safeNumberIsFinite(count) || count < 0 || !safeNumberIsInteger(count)) {
          throw new NativeError('move: кількість кроків має бути невід’ємним цілим числом.');
        }
        if (count > maxSteps) {
          fatalError = runnerError('STEP_LIMIT', 'Занадто багато кроків! Можливо, нескінченний цикл.');
          throw fatalError;
        }
        for (var mIdx = 0; mIdx < count; mIdx += 1) {
          stepMoveOnce();
        }
        return;
      }
      stepMoveOnce();
    }

    function turnRight() {
      checkFatalError();
      incrementStep('turnRight');
      pos = copyPos(pos, { dir: DIRECTIONS[(call(safeArrayIndexOf, DIRECTIONS, [pos.dir]) + 1) % 4], blocked: false, outOfBounds: false });
      emitRobot('turn', pos);
    }

    function turnLeft() {
      checkFatalError();
      incrementStep('turnLeft');
      pos = copyPos(pos, { dir: DIRECTIONS[(call(safeArrayIndexOf, DIRECTIONS, [pos.dir]) + 3) % 4], blocked: false, outOfBounds: false });
      emitRobot('turn', pos);
    }

    function isWallAhead() {
      checkFatalError();
      var delta = getDelta(pos.dir);
      var x = pos.x + delta[0];
      var y = pos.y + delta[1];
      return isOutOfBounds(x, y) || isWallAt(x, y);
    }

    function canMove() {
      checkFatalError();
      return !isWallAhead();
    }

    function isGoalReached() {
      checkFatalError();
      return cellAt(pos.x, pos.y) === 'goal';
    }

    function hasKey() {
      checkFatalError();
      return toBool(hasKeyValue);
    }

    function describeValue(value) {
      if (value === undefined) return 'undefined';
      if (typeof value === 'string') return "'" + value + "'";
      if (value === null || typeof value === 'number' || typeof value === 'boolean') return safeString(value);
      return typeof value;
    }

    // The last DOM lookup that found nothing, to explain a later "Cannot read properties of null".
    var missingDomLookup = null;

    // Plain-language Ukrainian for the JavaScript errors beginners meet most.
    function friendlyErrorMessage(error) {
      var message = error && typeof error.message === 'string' ? error.message : safeString(error);
      var name = error && typeof error.name === 'string' ? error.name : '';
      var match;
      if (name === 'ReferenceError' && (match = call(safeRegExpExec, /^(\S+) is not defined$/, [message]))) {
        return 'Невідома назва «' + match[1] + '»: такої команди чи змінної немає. Перевір, як вона написана — великі й малі літери важливі (наприклад, turnLeft, а не turnleft).';
      }
      if (name === 'TypeError' && call(safeRegExpTest, /of (null|undefined)|null is not|undefined is not an object/, [message]) && missingDomLookup) {
        return 'Елемент не знайдено: ' + missingDomLookup + ' повернув null. Перевір id чи селектор — доступні id: ' + call(safeArrayJoin, DOM_ELEMENT_IDS, [', ']) + '.';
      }
      if (name === 'TypeError' && (match = call(safeRegExpExec, /^(\S+) is not a function$/, [message]))) {
        return '«' + match[1] + '» — це не функція, її не можна викликати з дужками (). Перевір назву команди.';
      }
      if (name === 'TypeError' && call(safeRegExpTest, /^Assignment to constant variable/, [message])) {
        return 'Значення const не можна змінити. Якщо в умові ти хотів порівняти, пиши «===», а не «=»; якщо змінна має змінюватися — оголоси її через let.';
      }
      return message;
    }

    function repeat(times, action) {
      checkFatalError();
      if (!safeNumberIsFinite(times) || times < 0 || !safeNumberIsInteger(times)) {
        throw new NativeError(
          'repeat: кількість повторень має бути цілим числом від 0, а отримано ' + describeValue(times) + '.' +
          (times === undefined ? ' Якщо в обʼєкта немає поля steps, візьми 1: repeat(item.steps ?? 1, ...).' : ''),
        );
      }
      if (times > maxOperations) {
        fatalError = runnerError('OPERATION_LIMIT', 'repeat: занадто багато повторень!');
        throw fatalError;
      }
      if (typeof action !== 'function') {
        throw new NativeTypeError(
          'repeat: другим має бути те, що треба повторювати — команда без дужок або функція: ' +
          'repeat(' + describeValue(times) + ', move) чи repeat(' + describeValue(times) + ', () => { move(); }), а отримано ' + describeValue(action) + '.',
        );
      }
      var loop = newLoop();
      for (var index = 0; index < times; index += 1) {
        checkFatalError();
        enterIteration(loop);
        try {
          action();
        } finally {
          exitIteration();
        }
      }
    }

    function emitDom(message) {
      emit({ type: 'dom', state: domSnapshot(), message: message });
    }

    function makeClassList(initialClasses, onAdd, onRemove) {
      var classes = call(safeArraySlice, initialClasses, []);
      function normalizeClassToken(raw) {
        var token = call(safeStringTrim, safeString(raw), []);
        if (token.length > 1 && token.charAt(0) === '.') {
          emit({ type: 'console', message: '💡 Підказка: у classList пишуть назву класу без крапки: "' + token.slice(1) + '".' });
          return token.slice(1);
        }
        return token;
      }
      return {
        add: function () {
          checkFatalError();
          for (var aIdx = 0; aIdx < arguments.length; aIdx += 1) {
            var className = normalizeClassToken(arguments[aIdx]);
            if (!className) continue;
            if (call(safeArrayIndexOf, classes, [className]) === -1) {
              call(safeArrayPush, classes, [className]);
              if (onAdd) onAdd(className);
            }
          }
        },
        remove: function () {
          checkFatalError();
          for (var rIdx = 0; rIdx < arguments.length; rIdx += 1) {
            var className = normalizeClassToken(arguments[rIdx]);
            if (!className) continue;
            var index = call(safeArrayIndexOf, classes, [className]);
            if (index !== -1) {
              call(safeArraySplice, classes, [index, 1]);
              if (onRemove) onRemove(className);
            }
          }
        },
        contains: function (className) {
          checkFatalError();
          return call(safeArrayIndexOf, classes, [normalizeClassToken(className)]) !== -1;
        },
        containsSubstring: function (sub) {
          checkFatalError();
          var joined = call(safeArrayJoin, classes, [' ']);
          return call(safeStringIndexOf, joined, [safeString(sub)]) !== -1;
        },
        toggle: function (className, force) {
          checkFatalError();
          className = normalizeClassToken(className);
          var has = call(safeArrayIndexOf, classes, [className]) !== -1;
          if (force !== undefined) {
            if (force) {
              this.add(className);
              return true;
            } else {
              this.remove(className);
              return false;
            }
          }
          if (!has) {
            this.add(className);
            return true;
          }
          this.remove(className);
          return false;
        },
        toString: function () {
          checkFatalError();
          return call(safeArrayJoin, classes, [' ']);
        },
      };
    }

    // element.style: background colours reach the board; other properties are kept like plain values.
    function makeStyle(elementId) {
      var style = safeObjectCreate(null);
      var colorDesc = {
        enumerable: true,
        get: function () {
          checkFatalError();
          return domState.colors[elementId] || '';
        },
        set: function (value) {
          checkFatalError();
          var color = call(safeStringTrim, safeString(value), []);
          // Like a browser, a value that is not a colour is ignored.
          if (color !== '' && !isSafeCssColor(color)) return;
          if ((domState.colors[elementId] || '') === color) return;
          domState.colors[elementId] = color;
          emitDom(color ? '🎨 ' + elementId + ': колір ' + color : '🎨 ' + elementId + ': колір скинуто');
        },
      };
      safeObjectDefineProperty(style, 'backgroundColor', colorDesc);
      safeObjectDefineProperty(style, 'background', colorDesc);
      return style;
    }

    function createVirtualDom() {
      if (mode !== 'dom') return undefined;

      var terminalText = 'LOCKED';
      var terminal = {
        id: 'terminal',
        style: makeStyle('terminal'),
        classList: makeClassList([]),
      };
      var terminalPropDesc = {
        enumerable: true,
        get: function () {
          checkFatalError();
          return terminalText;
        },
        set: function (value) {
          checkFatalError();
          terminalText = safeString(value);
          if (call(safeStringToUpperCase, terminalText.trim(), []) === 'UNLOCKED') {
            if (!domState.terminalUnlocked) {
              domState.terminalUnlocked = true;
              emitDom('✅ Термінал розблоковано!');
            }
          } else if (domState.terminalUnlocked) {
            domState.terminalUnlocked = false;
            emitDom('🔒 Термінал заблоковано.');
          }
        },
      };
      safeObjectDefineProperty(terminal, 'textContent', terminalPropDesc);
      safeObjectDefineProperty(terminal, 'innerText', terminalPropDesc);
      safeObjectDefineProperty(terminal, 'innerHTML', terminalPropDesc);

      var doorUpdating = false;
      var door = {
        id: 'door',
        style: makeStyle('door'),
        classList: makeClassList(
          ['closed'],
          function (className) {
            if (doorUpdating) return;
            if (className === 'open') {
              doorUpdating = true;
              try {
                door.classList.remove('closed');
              } finally {
                doorUpdating = false;
              }
              if (!domState.doorOpen) {
                domState.doorOpen = true;
                emitDom('✅ Двері відкриті!');
              }
            } else if (className === 'closed') {
              doorUpdating = true;
              try {
                door.classList.remove('open');
              } finally {
                doorUpdating = false;
              }
              if (domState.doorOpen) {
                domState.doorOpen = false;
                emitDom('🚪 Двері знову зачинені.');
              }
            }
          },
          function (className) {
            if (doorUpdating) return;
            if (className === 'open') {
              doorUpdating = true;
              try {
                door.classList.add('closed');
              } finally {
                doorUpdating = false;
              }
              if (domState.doorOpen) {
                domState.doorOpen = false;
                emitDom('🚪 Двері знову зачинені.');
              }
            } else if (className === 'closed') {
              doorUpdating = true;
              try {
                door.classList.add('open');
              } finally {
                doorUpdating = false;
              }
              if (!domState.doorOpen) {
                domState.doorOpen = true;
                emitDom('✅ Двері відкриті!');
              }
            }
          },
        ),
      };

      var platform = {
        id: 'platform',
        style: makeStyle('platform'),
        classList: makeClassList(
          [],
          function (className) {
            if (className === 'active' && !domState.platformActive) {
              domState.platformActive = true;
              emitDom('✅ Платформа активована!');
            }
          },
          function (className) {
            if (className === 'active' && domState.platformActive) {
              domState.platformActive = false;
              emitDom('⬜ Платформа деактивована.');
            }
          },
        ),
      };

      var button = {
        id: 'button',
        style: makeStyle('button'),
        classList: makeClassList(['door-button']),
        click: function () {
          checkFatalError();
          domState.buttonClicked = true;
          emitDom('🔘 Кнопку натиснуто!');
          if (!domState.doorOpen) {
            door.classList.add('open');
          }
        },
      };

      function attachElementHelpers(el) {
        safeObjectDefineProperty(el, 'className', {
          enumerable: true,
          configurable: true,
          get: function () {
            checkFatalError();
            return el.classList ? el.classList.toString() : '';
          },
          set: function (value) {
            checkFatalError();
            if (!el.classList) return;
            var newStr = safeString(value).trim();
            var newClasses = newStr ? newStr.split(/\s+/) : [];
            var currentStr = el.classList.toString().trim();
            var currentClasses = currentStr ? currentStr.split(/\s+/) : [];

            for (var c = 0; c < currentClasses.length; c += 1) {
              if (call(safeArrayIndexOf, newClasses, [currentClasses[c]]) === -1) {
                el.classList.remove(currentClasses[c]);
              }
            }
            for (var n = 0; n < newClasses.length; n += 1) {
              el.classList.add(newClasses[n]);
            }
          },
        });

        el.getAttribute = function (name) {
          checkFatalError();
          var attr = call(safeStringToLowerCase, safeString(name), []);
          if (attr === 'class') {
            return el.className;
          }
          if (attr === 'id') {
            return el.id || null;
          }
          return null;
        };

        el.setAttribute = function (name, value) {
          checkFatalError();
          var attr = call(safeStringToLowerCase, safeString(name), []);
          if (attr === 'class') {
            el.className = value;
          } else if (attr === 'id') {
            el.id = safeString(value);
          }
        };
      }

      attachElementHelpers(terminal);
      attachElementHelpers(door);
      attachElementHelpers(platform);
      attachElementHelpers(button);

      var elements = safeObjectCreate(null);
      elements.terminal = terminal;
      elements.door = door;
      elements.platform = platform;
      elements.button = button;

      var allElements = [terminal, door, platform, button];

      function matchCompoundSelector(el, compound) {
        compound = call(safeStringTrim, compound, []);
        if (!compound) return false;

        var attrRegex = /\[([a-zA-Z0-9-_]+)\s*([*~^$]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\]]*))\]/g;
        var attrMatch;
        while ((attrMatch = call(safeRegExpExec, attrRegex, [compound])) !== null) {
          var attrName = call(safeStringToLowerCase, attrMatch[1], []);
          var op = attrMatch[2];
          var rawVal = attrMatch[3] !== undefined ? attrMatch[3] : (attrMatch[4] !== undefined ? attrMatch[4] : attrMatch[5]);
          var attrVal = call(safeStringTrim, rawVal || '', []);
          if (attrName !== 'id' && attrName !== 'class') return false;
          var actualVal = attrName === 'id'
            ? safeString(el.id || '')
            : safeString(el.className || '');

          if (op === '=') {
            if (actualVal !== attrVal) return false;
          } else if (op === '~=') {
            if (!attrVal) return false;
            if (attrName === 'class') {
              if (!el.classList || !el.classList.contains(attrVal)) return false;
            } else if (actualVal !== attrVal) {
              return false;
            }
          } else if (op === '*=') {
            if (!attrVal) return false;
            if (attrName === 'class' && el.classList && typeof el.classList.containsSubstring === 'function') {
              if (!el.classList.containsSubstring(attrVal)) return false;
            } else if (call(safeStringIndexOf, actualVal, [attrVal]) === -1) {
              return false;
            }
          } else if (op === '^=') {
            if (!attrVal || call(safeStringIndexOf, actualVal, [attrVal]) !== 0) return false;
          } else if (op === '$=') {
            if (
              !attrVal ||
              actualVal.length < attrVal.length ||
              call(safeStringIndexOf, actualVal, [attrVal, actualVal.length - attrVal.length]) !== actualVal.length - attrVal.length
            ) {
              return false;
            }
          }
        }

        var rest = call(safeStringTrim, call(safeStringReplace, compound, [attrRegex, '']), []);
        if (!rest) return true;

        var simpleMatch = call(safeRegExpExec, /^([a-zA-Z*]+)?((?:[#.][a-zA-Z0-9-_]+)*)$/, [rest]);
        if (!simpleMatch) return false;

        var tagPart = simpleMatch[1];
        var qualifiers = simpleMatch[2] || '';
        if (tagPart && tagPart !== '*') {
          var lowerTag = call(safeStringToLowerCase, tagPart, []);
          var isBtn = el === button;
          if (lowerTag === 'button' && !isBtn) return false;
          if (lowerTag === 'div' && isBtn) return false;
          if (lowerTag !== 'button' && lowerTag !== 'div') return false;
        }

        var qualRegex = /([#.])([a-zA-Z0-9-_]+)/g;
        var qMatch;
        while ((qMatch = call(safeRegExpExec, qualRegex, [qualifiers])) !== null) {
          if (qMatch[1] === '#') {
            if (el.id !== qMatch[2]) return false;
          } else if (qMatch[1] === '.') {
            if (!el.classList || !el.classList.contains(qMatch[2])) return false;
          }
        }

        return true;
      }

      function elementMatches(el, sel) {
        if (!el || typeof sel !== 'string') return false;
        sel = call(safeStringTrim, sel, []);
        if (!sel) return false;

        var parts = call(safeStringSplit, sel, [',']);
        for (var pIdx = 0; pIdx < parts.length; pIdx += 1) {
          if (matchCompoundSelector(el, parts[pIdx])) return true;
        }
        return false;
      }

      return safeObjectFreeze({
        getElementById: function (id) {
          checkFatalError();
          if (id === null || id === undefined) return null;
          var targetId = call(safeStringTrim, safeString(id), []);
          if (targetId.length > 1 && targetId.charAt(0) === '#') {
            targetId = targetId.slice(1);
            emit({ type: 'console', message: '💡 Підказка: у getElementById пишуть id без символу #: "' + targetId + '".' });
          }
          for (var i = 0; i < allElements.length; i += 1) {
            if (allElements[i].id === targetId) {
              return allElements[i];
            }
          }
          missingDomLookup = "dom.getElementById('" + targetId + "')";
          return null;
        },
        getElementsByClassName: function (classNames) {
          checkFatalError();
          var matched = [];
          if (typeof classNames !== 'string') return matched;
          var parts = classNames.trim().split(/\s+/);
          if (!parts[0]) return matched;
          for (var i = 0; i < allElements.length; i += 1) {
            var el = allElements[i];
            var allMatch = true;
            for (var p = 0; p < parts.length; p += 1) {
              if (!el.classList || !el.classList.contains(parts[p])) {
                allMatch = false;
                break;
              }
            }
            if (allMatch) {
              call(safeArrayPush, matched, [el]);
            }
          }
          return matched;
        },
        getElementsByTagName: function (tagName) {
          checkFatalError();
          var matched = [];
          if (typeof tagName !== 'string') return matched;
          var tag = call(safeStringToLowerCase, tagName.trim(), []);
          if (!tag) return matched;
          for (var i = 0; i < allElements.length; i += 1) {
            var el = allElements[i];
            if (tag === '*' || (tag === 'button' && el === button) || (tag === 'div' && el !== button)) {
              call(safeArrayPush, matched, [el]);
            }
          }
          return matched;
        },
        querySelector: function (selector) {
          checkFatalError();
          if (typeof selector !== 'string') return null;
          for (var i = 0; i < allElements.length; i += 1) {
            if (elementMatches(allElements[i], selector)) {
              return allElements[i];
            }
          }
          var trimmedSel = call(safeStringTrim, selector, []);
          if (/^[a-zA-Z0-9-_]+$/.test(trimmedSel) && trimmedSel !== 'div' && trimmedSel !== 'button') {
            for (var j = 0; j < allElements.length; j += 1) {
              if (elementMatches(allElements[j], '.' + trimmedSel)) {
                emit({ type: 'console', message: '💡 Підказка: для пошуку за класом у querySelector додавай крапку: ".' + trimmedSel + '".' });
                return allElements[j];
              }
              if (elementMatches(allElements[j], '#' + trimmedSel)) {
                emit({ type: 'console', message: '💡 Підказка: для пошуку за id у querySelector додавай #: "#' + trimmedSel + '".' });
                return allElements[j];
              }
            }
          }
          missingDomLookup = "dom.querySelector('" + selector + "')";
          return null;
        },
        querySelectorAll: function (selector) {
          checkFatalError();
          var matched = [];
          if (typeof selector !== 'string') return matched;
          for (var i = 0; i < allElements.length; i += 1) {
            if (elementMatches(allElements[i], selector)) {
              call(safeArrayPush, matched, [allElements[i]]);
            }
          }
          return matched;
        },
      });
    }

    function safeConsoleMessage(args) {
      var messages = call(safeArrayMap, args, [function (value) {
        if (typeof value === 'string') return value;
        try { return safeJsonStringify(value); } catch (_) { return safeString(value); }
      }]);
      return call(safeArrayJoin, messages, [' ']);
    }

    var safeConsole = safeObjectFreeze({
      log: function () { emit({ type: 'console', message: safeConsoleMessage(arguments) }); },
      warn: function () { emit({ type: 'console', message: safeConsoleMessage(arguments) }); },
      error: function () { emit({ type: 'console', message: safeConsoleMessage(arguments) }); },
    });

    try {
      var hooks = payload.hookIdentifiers || {
        enterFn: '__jsQuestEnterFn__',
        exitFn: '__jsQuestExitFn__',
        enterLoop: '__jsQuestEnterLoop__',
        exitLoop: '__jsQuestExitLoop__',
      };

      var activeHookNames = [hooks.enterFn, hooks.exitFn, hooks.enterLoop, hooks.exitLoop];
      var shadowedList = call(safeArrayFilter, SHADOWED_PARAMETERS, [function (name) {
        return name !== traceIdentifier && !call(safeArrayIncludes, activeHookNames, [name]);
      }]);

      var parameterNames = [
        'move',
        'turnRight',
        'turnLeft',
        'repeat',
        'isWallAhead',
        'canMove',
        'isGoalReached',
        'hasKey',
        'dom',
        traceIdentifier,
        hooks.enterFn,
        hooks.exitFn,
        hooks.enterLoop,
        hooks.exitLoop,
      ].concat(shadowedList).concat(['console', 'JSON']);

      var virtualDom = createVirtualDom();
      var parameterValues = [
        move,
        turnRight,
        turnLeft,
        repeat,
        isWallAhead,
        canMove,
        isGoalReached,
        hasKey,
        virtualDom,
        trace,
        enterFn,
        exitFn,
        enterLoop,
        exitLoop,
      ].concat(call(safeArrayMap, shadowedList, [function (name) {
        if (name === 'document' && mode === 'dom') {
          return virtualDom;
        }
        return call(safeArrayIncludes, ASYNC_APIS, [name]) ? asyncUnsupported(name) : undefined;
      }])).concat([safeConsole, safeJson]);

      // Data the level hands to the code (route, instructions). The learner reads it like any variable.
      var data = config.data && typeof config.data === 'object' ? config.data : {};
      var dataNames = NativeObject.keys(data);
      for (var dIdx = 0; dIdx < dataNames.length; dIdx += 1) {
        var dataName = dataNames[dIdx];
        if (!/^[$A-Z_a-z][$\w]*$/.test(dataName) || call(safeArrayIncludes, parameterNames, [dataName])) {
          return makeEmptyFailure('WORKER_ERROR', 'Некоректна конфігурація ізольованого виконавця.');
        }
        call(safeArrayPush, parameterNames, [dataName]);
        // A fresh copy made here: every run (real or variant) starts from untouched data, built
        // from this realm's own arrays and objects.
        call(safeArrayPush, parameterValues, [safeJsonParse(safeJsonStringify(data[dataName]))]);
      }

      var outerFunction = call(NativeFunction, null, parameterNames.concat([
        '"use strict";\n' +
        'return (function () {\n' +
        '  "use strict";\n' +
        payload.instrumentedCode + '\n' +
        '});'
      ]));
      var userCodeRunner = call(outerFunction, undefined, parameterValues);
      activeTracker = tracker;
      try {
        call(userCodeRunner, undefined, []);
      } finally {
        activeTracker = null;
      }
      checkFatalError();

      var loopMetrics = computeEffectiveLoopMetrics();
      return {
          ok: true,
          events: events,
          path: call(safeArrayMap, path, [sanitizePosition]),
          finalPos: sanitizePosition(pos),
          steps: steps,
          loopIterations: loopIterations,
          activeLoopIterations: loopMetrics.activeLoopIterations,
          loopRobotActions: loopMetrics.loopActions,
          loopActions: loopMetrics.loopActions,
          userFunctionRobotActions: userFunctionRobotActions,
          collectedKeys: call(safeArraySlice, collectedKeys, [0]),
          hasKey: toBool(hasKeyValue),
          doorOpened: toBool(doorOpened),
          isDead: toBool(isDead),
          domState: domSnapshot(),
      };
    } catch (error) {
      // A death or limit stays the reason even if learner code caught it and threw something else.
      var reported = fatalError || error;
      var runnerFailure = isRunnerError(reported);
      var failure = makeEmptyFailure(
        runnerFailure ? reported.runnerCode : 'RUNTIME_ERROR',
        runnerFailure ? reported.message : friendlyErrorMessage(reported),
      );
      return failure;
    }
  }
})();
