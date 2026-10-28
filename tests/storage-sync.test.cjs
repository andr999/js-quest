const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

function loadGameContextModule() {
  const filename = path.join(__dirname, '..', 'app', 'context', 'GameContext.tsx');
  const source = fs.readFileSync(filename, 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.React,
      esModuleInterop: true,
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
          useState: (init) => [init, () => {}],
        };
      }
      if (specifier === '@/utils/levelsConfig') return { TOTAL_LEVELS: 7 };
      return {};
    },
    localModule,
    localModule.exports,
  );
  return localModule.exports;
}

const {
  normalizeSavedState,
  mergeSavedStates,
  gameReducer,
  DEFAULT_LIVES,
  createDefaultSavedState,
  saveState,
  loadState,
  isAttemptStartCounted,
  registerActiveAttempt,
  unregisterActiveAttempt,
  isAttemptActiveInBrowser,
  executeFinishAttemptSync,
  migrateGuestProgress,
  getStorageKey,
  isValidLevel,
} = loadGameContextModule();

test('createDefaultSavedState creates initial state with resetAt = 0', () => {
  const def = createDefaultSavedState();
  assert.equal(def.resetAt, 0);
  assert.equal(def.lives, DEFAULT_LIVES);
  assert.deepEqual(def.completedLevels, []);
  assert.deepEqual(def.attemptsByLevel, {});
  assert.deepEqual(def.attemptEvents, []);
});

test('normalizeSavedState validates and sanitizes corrupted state', () => {
  // Corrupted input
  const corrupted = {
    lives: -5,
    score: 'invalid',
    completedLevels: [1, 999, 1, 'abc', 2],
  };
  const normalized = normalizeSavedState(corrupted);
  assert.equal(normalized.saved.lives, DEFAULT_LIVES);
  assert.equal(normalized.saved.score, 0);
  assert.deepEqual(normalized.saved.completedLevels, [1, 2]);

  // Completely invalid input
  const nonObject = normalizeSavedState('corrupted json string');
  assert.equal(nonObject.saved.lives, DEFAULT_LIVES);
  assert.equal(nonObject.saved.score, 0);
  assert.deepEqual(nonObject.saved.completedLevels, []);
  assert.ok(nonObject.error !== null);

  // Valid input
  const valid = { lives: 2, deathsByLevel: { 1: 1 }, score: 175, completedLevels: [1] };
  const validResult = normalizeSavedState(valid);
  assert.equal(validResult.saved.lives, 2);
  assert.equal(validResult.saved.score, 175);
  assert.deepEqual(validResult.saved.completedLevels, [1]);
  assert.equal(validResult.error, null);
});

test('normalizeSavedState safely caps huge legacy deathsByLevel and deduplicates deathEvents', () => {
  const corrupted = {
    lives: 3,
    deathsByLevel: { 1: 1_000_000 },
    deathEvents: [
      { id: 'dup-1', level: 1, ts: 100 },
      { id: 'dup-1', level: 1, ts: 200 },
      { id: 'invalid-lvl', level: 999, ts: 300 },
    ],
  };

  const start = Date.now();
  const normalized = normalizeSavedState(corrupted);
  const duration = Date.now() - start;

  assert.ok(duration < 100, `Normalization took ${duration}ms, must not hang on huge numbers`);
  assert.ok(normalized.saved.deathEvents.length <= DEFAULT_LIVES * 10);
  assert.equal(normalized.saved.deathEvents.filter(e => e.id === 'dup-1').length, 1);
});

test('legacy saves with 51-101+ attempts preserve full attempt counts without truncation', () => {
  const legacy51 = {
    lives: 3,
    score: 500,
    completedLevels: [1],
    attemptsByLevel: { 1: 51, 2: 120 },
  };
  const normalized = normalizeSavedState(legacy51);
  assert.equal(normalized.saved.attemptsByLevel[1], 51);
  assert.equal(normalized.saved.attemptsByLevel[2], 120);

  const merged = mergeSavedStates(normalized.saved, createDefaultSavedState(0));
  assert.equal(merged.attemptsByLevel[1], 51);
  assert.equal(merged.attemptsByLevel[2], 120);
});

test('mergeSavedStates preserves first attempt on new profile without loss', () => {
  const localAttempt = {
    lives: 3,
    score: 0,
    completedLevels: [],
    attemptsByLevel: { 1: 1 },
    attemptEvents: [{ id: 'local-attempt-1', level: 1, ts: 100 }],
    resetAt: 0,
    updatedAt: 100,
  };
  const emptyDiskState = createDefaultSavedState(0);

  const merged = mergeSavedStates(localAttempt, emptyDiskState);
  assert.equal(merged.attemptsByLevel[1], 1, 'First attempt must never be discarded by empty disk state');
  assert.equal(merged.lives, 3);
  assert.equal(merged.score, 0);
});

test('mergeSavedStates preserves progress and counts deaths across tabs without resurrection', () => {
  const tabA = {
    lives: 2,
    deathsByLevel: { 1: 1 },
    deathEvents: [{ id: 'tabA-death', level: 1, ts: 1000 }],
    score: 0,
    completedLevels: [],
    attemptsByLevel: { 1: 1 },
    resetAt: 1000,
  };
  const tabB = {
    lives: 2,
    deathsByLevel: { 2: 1 },
    deathEvents: [{ id: 'tabB-death', level: 2, ts: 1000 }],
    score: 175,
    completedLevels: [1],
    attemptsByLevel: { 2: 1 },
    resetAt: 1000,
  };

  const merged = mergeSavedStates(tabA, tabB);
  assert.equal(merged.lives, 1, 'Concurrent failures across levels both count (3 - 1 - 1 = 1)');
  assert.equal(merged.score, 175, 'Highest score must be retained');
  assert.deepEqual(merged.completedLevels, [1], 'Completed levels must not be wiped');
  assert.equal(merged.attemptsByLevel[1], 1);
  assert.equal(merged.attemptsByLevel[2], 1);
});

test('simultaneous failures on the same level in two tabs both count', () => {
  let stateTabA = {
    lives: 3,
    score: 0,
    completedLevels: [],
    attemptsByLevel: {},
    attemptEvents: [],
    completedAttemptIds: [],
    deathsByLevel: {},
    deathEvents: [],
    resetAt: 1000,
    updatedAt: 1000,
    storageKey: 'test-key',
    hydrated: true,
    revision: 0,
    persistedRevision: 0,
    isReset: false,
  };
  let stateTabB = { ...stateTabA };

  // Tab A fails level 1
  stateTabA = gameReducer(stateTabA, { type: 'loseLife', storageKey: 'test-key', level: 1 });
  assert.equal(stateTabA.lives, 2);

  // Tab B fails level 1 simultaneously
  stateTabB = gameReducer(stateTabB, { type: 'loseLife', storageKey: 'test-key', level: 1 });
  assert.equal(stateTabB.lives, 2);

  // Merge Tab A into Tab B
  const merged = mergeSavedStates(stateTabA, stateTabB);
  assert.equal(merged.lives, 1, 'Two independent losses on level 1 count as 2 deaths (1 life left)');
  assert.equal(merged.deathEvents.length, 2);
});

test('simultaneous attempts on the same level across two tabs merge to 2 attempts', () => {
  let stateTabA = {
    lives: 3,
    score: 0,
    completedLevels: [],
    attemptsByLevel: {},
    attemptEvents: [],
    completedAttemptIds: [],
    deathsByLevel: {},
    deathEvents: [],
    resetAt: 1000,
    updatedAt: 1000,
    storageKey: 'test-key',
    hydrated: true,
    revision: 0,
    persistedRevision: 0,
    isReset: false,
  };
  let stateTabB = { ...stateTabA };

  // Tab A records attempt on level 1 (from 0 to 1)
  stateTabA = gameReducer(stateTabA, { type: 'recordAttempt', storageKey: 'test-key', level: 1 });
  assert.equal(stateTabA.attemptsByLevel[1], 1);

  // Tab B records attempt on level 1 simultaneously (from 0 to 1)
  stateTabB = gameReducer(stateTabB, { type: 'recordAttempt', storageKey: 'test-key', level: 1 });
  assert.equal(stateTabB.attemptsByLevel[1], 1);

  // Merge Tab A into Tab B
  const merged = mergeSavedStates(stateTabA, stateTabB);
  assert.equal(merged.attemptsByLevel[1], 2, 'Two distinct concurrent attempts must accumulate to 2 attempts');
  assert.equal(merged.attemptEvents.length, 2);
});

test('legacy save with 51 attempts merging two simultaneous attempts in separate tabs yields 53', () => {
  const legacyInitial = {
    lives: 3,
    score: 0,
    completedLevels: [],
    attemptsByLevel: { 1: 51 },
    attemptEvents: [],
    completedAttemptIds: [],
    deathsByLevel: {},
    deathEvents: [],
    resetAt: 1000,
    updatedAt: 1000,
    storageKey: 'test-key',
    hydrated: true,
    revision: 0,
    persistedRevision: 0,
    isReset: false,
  };

  // Tab A increments attempt (51 -> 52)
  const tabA = gameReducer(legacyInitial, { type: 'recordAttempt', storageKey: 'test-key', level: 1 });
  assert.equal(tabA.attemptsByLevel[1], 52);

  // Tab B increments attempt (51 -> 52)
  const tabB = gameReducer(legacyInitial, { type: 'recordAttempt', storageKey: 'test-key', level: 1 });
  assert.equal(tabB.attemptsByLevel[1], 52);

  // Merge Tab A and Tab B
  const merged = mergeSavedStates(tabA, tabB);
  assert.equal(merged.attemptsByLevel[1], 53, 'Legacy 51 + Tab A attempt + Tab B attempt must equal 53');
});

test('attempt transaction bound to storageKey rejects attempt from previous user profile', () => {
  let state = {
    lives: 3,
    score: 0,
    completedLevels: [],
    attemptsByLevel: {},
    attemptEvents: [],
    completedAttemptIds: [],
    deathsByLevel: {},
    deathEvents: [],
    resetAt: 1000,
    updatedAt: 1000,
    storageKey: 'user_123',
    hydrated: true,
    revision: 0,
    persistedRevision: 0,
    isReset: false,
  };

  // Guest attempt finishes when user is already logged in as user_123
  const stateAfterGuestFinish = gameReducer(state, {
    type: 'finishAttempt',
    storageKey: 'guest_key', // guest key
    resetAt: 1000,
    level: 1,
    attemptId: 'guest-att-1',
    outcome: 'victory',
    points: 175,
  });

  assert.equal(stateAfterGuestFinish.score, 0, 'Must not award points to user from guest attempt');
  assert.deepEqual(stateAfterGuestFinish.completedLevels, []);
});

test('attempt transaction bound to resetAt ignores in-flight attempt after resetGame', () => {
  let state = {
    lives: 3,
    score: 0,
    completedLevels: [],
    attemptsByLevel: {},
    attemptEvents: [],
    completedAttemptIds: [],
    deathsByLevel: {},
    deathEvents: [],
    resetAt: 1000,
    updatedAt: 1000,
    storageKey: 'test-key',
    hydrated: true,
    revision: 0,
    persistedRevision: 0,
    isReset: false,
  };

  // Attempt starts at resetAt = 1000
  const attemptId = 'attempt-1';
  state = gameReducer(state, {
    type: 'startAttempt',
    storageKey: 'test-key',
    resetAt: 1000,
    level: 1,
    attemptId,
  });
  assert.equal(state.attemptsByLevel[1], 1);

  // User resets game before attempt finishes -> new epoch resetAt = 2000
  state = gameReducer(state, {
    type: 'reset',
    storageKey: 'test-key',
    resetAt: 2000,
  });
  assert.equal(state.resetAt, 2000);
  assert.equal(state.lives, 3);
  assert.equal(state.attemptsByLevel[1] || 0, 0);

  // In-flight attempt finishes with victory after reset
  state = gameReducer(state, {
    type: 'finishAttempt',
    storageKey: 'test-key',
    resetAt: 1000, // old resetAt
    level: 1,
    attemptId,
    outcome: 'victory',
    points: 175,
  });

  // MUST NOT add score or completed level from previous epoch
  assert.equal(state.score, 0);
  assert.deepEqual(state.completedLevels, []);
  assert.equal(state.lives, 3);
  assert.equal(state.attemptsByLevel[1] || 0, 0);

  // In-flight attempt finishes with defeat after reset
  state = gameReducer(state, {
    type: 'finishAttempt',
    storageKey: 'test-key',
    resetAt: 1000, // old resetAt
    level: 1,
    attemptId,
    outcome: 'defeat',
  });

  // MUST NOT lose lives from previous epoch
  assert.equal(state.lives, 3);
});

test('mergeSavedStates respects reset epochs (new reset supersedes old progress)', () => {
  const oldTabProgress = {
    lives: 2,
    score: 500,
    completedLevels: [1, 2, 3],
    attemptsByLevel: { 1: 3, 2: 2 },
    resetAt: 1000,
  };
  const freshReset = {
    lives: 3,
    score: 0,
    completedLevels: [],
    attemptsByLevel: {},
    resetAt: 2000,
  };

  // Reset happened later, so freshReset wins
  const mergedWithReset = mergeSavedStates(oldTabProgress, freshReset);
  assert.equal(mergedWithReset.score, 0);
  assert.deepEqual(mergedWithReset.completedLevels, []);
  assert.equal(mergedWithReset.lives, 3);
  assert.equal(mergedWithReset.resetAt, 2000);

  // Commutative check
  const mergedReversed = mergeSavedStates(freshReset, oldTabProgress);
  assert.equal(mergedReversed.score, 0);
  assert.deepEqual(mergedReversed.completedLevels, []);
});

test('stale tab write with older resetAt cannot undo newer reset, and syncFromStorage triggers persistence', () => {
  // Tab B resets game at epoch 5000
  const tabBState = {
    lives: 3,
    score: 0,
    completedLevels: [],
    attemptsByLevel: {},
    attemptEvents: [],
    completedAttemptIds: [],
    deathsByLevel: {},
    deathEvents: [],
    resetAt: 5000,
    updatedAt: 5000,
    storageKey: 'test-key',
    hydrated: true,
    revision: 1,
    persistedRevision: 1,
    isReset: false,
  };

  // Tab A (stale tab) sends a storage event with old resetAt: 1000 and old score: 350
  const staleIncoming = {
    lives: 2,
    score: 350,
    completedLevels: [1, 2],
    attemptsByLevel: { 1: 2, 2: 1 },
    resetAt: 1000,
    updatedAt: 4000,
  };

  const afterSync = gameReducer(tabBState, {
    type: 'syncFromStorage',
    storageKey: 'test-key',
    saved: staleIncoming,
  });

  // Tab B must maintain reset state
  assert.equal(afterSync.resetAt, 5000);
  assert.equal(afterSync.score, 0);
  assert.deepEqual(afterSync.completedLevels, []);
  // Must NOT advance persistedRevision to nextRevision, so Tab B will re-persist the new epoch to localStorage!
  assert.ok(afterSync.revision > afterSync.persistedRevision, 'Persist effect must be triggered to overwrite stale disk state');
});

test('gameReducer preserves unpersisted local actions when syncFromStorage arrives', () => {
  const initial = {
    lives: 3,
    score: 0,
    completedLevels: [],
    attemptsByLevel: {},
    attemptEvents: [],
    completedAttemptIds: [],
    deathsByLevel: {},
    deathEvents: [],
    resetAt: 1000,
    updatedAt: 1000,
    storageKey: 'test-key',
    hydrated: true,
    revision: 0,
    persistedRevision: 0,
    isReset: false,
  };

  // Tab A completes level 1 locally (unpersisted, revision: 1, persistedRevision: 0)
  const stateTabA = gameReducer(initial, {
    type: 'completeLevel',
    storageKey: 'test-key',
    level: 1,
    points: 175,
  });
  assert.equal(stateTabA.revision, 1);
  assert.equal(stateTabA.persistedRevision, 0);

  // Storage event arrives from Tab B (which had score: 50)
  const syncedState = gameReducer(stateTabA, {
    type: 'syncFromStorage',
    storageKey: 'test-key',
    saved: {
      lives: 3,
      score: 50,
      completedLevels: [],
      resetAt: 1000,
    },
  });

  // Score should be 175 and completedLevels: [1]
  assert.equal(syncedState.score, 175);
  assert.deepEqual(syncedState.completedLevels, [1]);
  // persistedRevision MUST NOT equal revision, so Tab A will persist the merged state to disk!
  assert.ok(syncedState.revision > syncedState.persistedRevision, 'Must trigger persist effect');
});

test('mergeSavedStates merges scores across tabs without loss when different levels are completed', () => {
  const tabA = {
    lives: 3,
    score: 175,
    completedLevels: [1],
    scoresByLevel: { 1: 175 },
    resetAt: 1000,
  };

  const tabB = {
    lives: 3,
    score: 275,
    completedLevels: [2],
    scoresByLevel: { 2: 275 },
    resetAt: 1000,
  };

  const merged = mergeSavedStates(tabA, tabB);
  assert.deepEqual(merged.completedLevels, [1, 2]);
  assert.equal(merged.score, 450, 'Score must be sum of level 1 (175) and level 2 (275)');
  assert.deepEqual(merged.scoresByLevel, { 1: 175, 2: 275 });
});

test('mergeSavedStates merges legacy saves across tabs without loss when shared base levels exist', () => {
  // Base save had completedLevels: [1, 2] and score: 350, with empty scoresByLevel.
  // Tab A completed level 3 (+150 => 500)
  const tabA = {
    lives: 3,
    score: 500,
    completedLevels: [1, 2, 3],
    scoresByLevel: { 3: 150 },
    resetAt: 1000,
  };

  // Tab B completed level 4 (+250 => 600)
  const tabB = {
    lives: 3,
    score: 600,
    completedLevels: [1, 2, 4],
    scoresByLevel: { 4: 250 },
    resetAt: 1000,
  };

  const merged = mergeSavedStates(tabA, tabB);
  assert.deepEqual(merged.completedLevels, [1, 2, 3, 4]);
  assert.equal(merged.score, 750, 'Score must be shared 350 + tab A 150 + tab B 250 = 750');
});

test('gameReducer finishAttempt does not award duplicate score upon re-completing an already finished level', () => {
  const stateWithLevel1 = {
    lives: 3,
    score: 175,
    completedLevels: [1],
    scoresByLevel: { 1: 175 },
    attemptsByLevel: { 1: 1 },
    attemptEvents: [],
    completedAttemptIds: [],
    deathsByLevel: {},
    deathEvents: [],
    resetAt: 1000,
    updatedAt: 1000,
    storageKey: 'test-key',
    hydrated: true,
    revision: 0,
    persistedRevision: 0,
    isReset: false,
  };

  // Re-completing level 1 with same points (175) or lower (150) must not increase total score
  const replayState = gameReducer(stateWithLevel1, {
    type: 'finishAttempt',
    storageKey: 'test-key',
    resetAt: 1000,
    level: 1,
    attemptId: 'att-1-replay',
    outcome: 'victory',
    points: 150,
  });

  assert.equal(replayState.score, 175, 'Score must remain 175');
  assert.deepEqual(replayState.completedLevels, [1]);
  assert.equal(replayState.scoresByLevel[1], 175);

  // Re-completing level 1 with higher score (200) should only award the difference (+25)
  const improvedState = gameReducer(stateWithLevel1, {
    type: 'finishAttempt',
    storageKey: 'test-key',
    resetAt: 1000,
    level: 1,
    attemptId: 'att-1-improved',
    outcome: 'victory',
    points: 200,
  });

  assert.equal(improvedState.score, 200, 'Score should increase from 175 to 200');
  assert.equal(improvedState.scoresByLevel[1], 200);
});

test('gameReducer finishAttempt handles legacy saves without scoresByLevel without double counting', () => {
  const legacyState = {
    lives: 3,
    score: 175,
    completedLevels: [1],
    scoresByLevel: {}, // legacy save where scoresByLevel was missing
    attemptsByLevel: { 1: 1 },
    attemptEvents: [],
    completedAttemptIds: [],
    deathsByLevel: {},
    deathEvents: [],
    resetAt: 1000,
    updatedAt: 1000,
    storageKey: 'test-key',
    hydrated: true,
    revision: 0,
    persistedRevision: 0,
    isReset: false,
  };

  const replayState = gameReducer(legacyState, {
    type: 'finishAttempt',
    storageKey: 'test-key',
    resetAt: 1000,
    level: 1,
    attemptId: 'att-legacy-replay',
    outcome: 'victory',
    points: 175,
  });

  assert.equal(replayState.score, 175, 'Replaying completed level on legacy save must not add 175 to score');
  assert.equal(replayState.scoresByLevel[1], 175, 'scoresByLevel must be populated');
});

test('gameReducer finishAttempt handles sequential replays 100 -> 150 on legacy save without inflating score', () => {
  // Legacy save: level 1 completed with score 175, scoresByLevel empty
  const rawLegacy = {
    lives: 3,
    score: 175,
    completedLevels: [1],
    scoresByLevel: {},
    resetAt: 1000,
  };
  const normalized = normalizeSavedState(rawLegacy).saved;
  assert.equal(normalized.score, 175);
  assert.equal(normalized.scoresByLevel[1], 175, 'Normalized legacy state must allocate 175 to level 1');

  // Step 1: Replay with 100 points
  const state1 = gameReducer(
    { ...normalized, storageKey: 'test-key', hydrated: true, revision: 0, persistedRevision: 0, isReset: false },
    {
      type: 'finishAttempt',
      storageKey: 'test-key',
      resetAt: 1000,
      level: 1,
      attemptId: 'att-100',
      outcome: 'victory',
      points: 100,
    }
  );
  assert.equal(state1.score, 175, 'Replay with 100 must keep score at 175');
  assert.equal(state1.scoresByLevel[1], 175);

  // Step 2: Replay with 150 points
  const state2 = gameReducer(state1, {
    type: 'finishAttempt',
    storageKey: 'test-key',
    resetAt: 1000,
    level: 1,
    attemptId: 'att-150',
    outcome: 'victory',
    points: 150,
  });
  assert.equal(state2.score, 175, 'Replay with 150 must keep score at 175 (not inflate to 225)');
  assert.equal(state2.scoresByLevel[1], 175);

  // Step 3: Replay with 200 points
  const state3 = gameReducer(state2, {
    type: 'finishAttempt',
    storageKey: 'test-key',
    resetAt: 1000,
    level: 1,
    attemptId: 'att-200',
    outcome: 'victory',
    points: 200,
  });
  assert.equal(state3.score, 200, 'Replay with 200 must increase score from 175 to 200 (+25)');
  assert.equal(state3.scoresByLevel[1], 200);
});

test('mergeSavedStates associativity: (X merge Y) merge Z === X merge (Y merge Z) across 10,000 random triples', () => {
  function makeRandomState(seed) {
    const numLevels = seed % 8;
    const completedLevels = [];
    for (let i = 1; i <= numLevels; i++) {
      completedLevels.push(i);
    }
    const hasScoresByLevel = seed % 2 === 0;
    const scoresByLevel = {};
    let sum = 0;
    for (const l of completedLevels) {
      const s = ((seed * 37 + l * 73) % 400) + 50;
      if (hasScoresByLevel) {
        scoresByLevel[l] = s;
      }
      sum += s;
    }
    const rawScore = sum + ((seed % 5) * 50);
    const raw = {
      lives: 3,
      score: rawScore,
      completedLevels,
      scoresByLevel: hasScoresByLevel ? scoresByLevel : {},
      resetAt: 1000,
    };
    return normalizeSavedState(raw).saved;
  }

  let violations = 0;
  for (let i = 0; i < 10000; i++) {
    const x = makeRandomState(i * 3 + 1);
    const y = makeRandomState(i * 3 + 2);
    const z = makeRandomState(i * 3 + 3);

    const left = mergeSavedStates(mergeSavedStates(x, y), z);
    const right = mergeSavedStates(x, mergeSavedStates(y, z));

    if (left.score !== right.score || JSON.stringify(left.completedLevels) !== JSON.stringify(right.completedLevels)) {
      violations++;
    }
  }

  assert.equal(violations, 0, `Must have 0 associativity violations, found ${violations}`);
});

test('legacy save with completed levels [1, 2] and score 425 migrates to {1: 150, 2: 275} without replay inflation', () => {
  const rawLegacy = {
    lives: 3,
    score: 425,
    completedLevels: [1, 2],
    resetAt: 1000,
  };
  const normalized = normalizeSavedState(rawLegacy).saved;
  assert.equal(normalized.score, 425);
  assert.equal(normalized.scoresByLevel[1], 150, 'Level 1 must receive exact 150 points (not 142)');
  assert.equal(normalized.scoresByLevel[2], 275, 'Level 2 must receive exact 275 points (not 283)');

  // Replaying level 1 for 150 points must not inflate the score
  const stateReplay = gameReducer(
    { ...normalized, storageKey: 'test-key', hydrated: true, revision: 0, persistedRevision: 0, isReset: false },
    {
      type: 'finishAttempt',
      storageKey: 'test-key',
      resetAt: 1000,
      level: 1,
      attemptId: 'att-1-150',
      outcome: 'victory',
      points: 150,
    }
  );
  assert.equal(stateReplay.score, 425, 'Replaying level 1 for 150 points must keep total score at 425');
  assert.equal(stateReplay.scoresByLevel[1], 150);
  assert.equal(stateReplay.scoresByLevel[2], 275);
});

test('legacy save with completed levels [1, 2] and score 400 migrates to {1: 175, 2: 225} and improving level 2 to 250 yields 425', () => {
  const rawLegacy = {
    lives: 3,
    score: 400,
    completedLevels: [1, 2],
    resetAt: 1000,
  };
  const normalized = normalizeSavedState(rawLegacy).saved;
  assert.equal(normalized.score, 400);
  assert.equal(normalized.scoresByLevel[1], 175, 'Level 1 must receive exact 175 points (100 base + 25 first try + 50 steps)');
  assert.equal(normalized.scoresByLevel[2], 225, 'Level 2 must receive exact 225 points (100 base + 25 first try + 100 steps)');

  // Replaying level 2 for 250 points must improve total score to 425
  const stateReplay = gameReducer(
    { ...normalized, storageKey: 'test-key', hydrated: true, revision: 0, persistedRevision: 0, isReset: false },
    {
      type: 'finishAttempt',
      storageKey: 'test-key',
      resetAt: 1000,
      level: 2,
      attemptId: 'att-2-250',
      outcome: 'victory',
      points: 250,
    }
  );
  assert.equal(stateReplay.score, 425, 'Replaying level 2 for 250 points must update total score to 425');
  assert.equal(stateReplay.scoresByLevel[1], 175);
  assert.equal(stateReplay.scoresByLevel[2], 250);
});

test('legacy save with completed levels [1, 2], score 325 and attempts {1: 2, 2: 1} migrates to {1: 100, 2: 225} and replaying level 2 with 250 points yields 350', () => {
  const rawLegacyWithAttempts = {
    lives: 3,
    score: 325,
    completedLevels: [1, 2],
    attemptsByLevel: { 1: 2, 2: 1 },
    resetAt: 1000,
  };
  const normalized = normalizeSavedState(rawLegacyWithAttempts).saved;
  assert.equal(normalized.score, 325);
  assert.equal(normalized.scoresByLevel[1], 100, 'Level 1 with 2 attempts cannot receive first-try bonus, receives base 100');
  assert.equal(normalized.scoresByLevel[2], 225, 'Level 2 with 1 attempt receives base 200 + 25 first-try bonus');

  // Replaying level 2 for 250 points (improving from 225 to 250 = +25) must result in exactly 350 total (not 375)
  const stateReplay = gameReducer(
    { ...normalized, storageKey: 'test-key', hydrated: true, revision: 0, persistedRevision: 0, isReset: false },
    {
      type: 'finishAttempt',
      storageKey: 'test-key',
      resetAt: 1000,
      level: 2,
      attemptId: 'att-2-250',
      outcome: 'victory',
      points: 250,
    }
  );
  assert.equal(stateReplay.score, 350, 'Replaying level 2 with 250 points must result in 350 total (100 + 250), not 375');
  assert.equal(stateReplay.scoresByLevel[1], 100);
  assert.equal(stateReplay.scoresByLevel[2], 250);

  // Even without explicit attemptsByLevel, 25 bonus pool cannot be efficiency (+50) and belongs to higher level first-try
  const rawLegacyNoAttempts = {
    lives: 3,
    score: 325,
    completedLevels: [1, 2],
    resetAt: 1000,
  };
  const normalizedNoAttempts = normalizeSavedState(rawLegacyNoAttempts).saved;
  assert.equal(normalizedNoAttempts.score, 325);
  assert.equal(normalizedNoAttempts.scoresByLevel[1], 100);
  assert.equal(normalizedNoAttempts.scoresByLevel[2], 225);
});

test('legacy save with score 350 and attempts {1: 2, 2: 1} preserves first-try bonus on level 1, improving level 2 yields 375 not 400', () => {
  const rawLegacy = {
    lives: 3,
    score: 350,
    completedLevels: [1, 2],
    attemptsByLevel: { 1: 2, 2: 1 },
    resetAt: 1000,
  };
  const normalized = normalizeSavedState(rawLegacy).saved;
  assert.equal(normalized.score, 350);
  assert.equal(normalized.scoresByLevel[1], 125, 'Level 1 keeps its first-try bonus (125) despite replay attempt');
  assert.equal(normalized.scoresByLevel[2], 225, 'Level 2 receives first-try bonus (225)');

  // Replaying level 2 with 250 points (improving from 225 to 250 = +25) must yield 375 total, not 400
  const stateReplay = gameReducer(
    { ...normalized, storageKey: 'test-key', hydrated: true, revision: 0, persistedRevision: 0, isReset: false },
    {
      type: 'finishAttempt',
      storageKey: 'test-key',
      resetAt: 1000,
      level: 2,
      attemptId: 'att-2-improved',
      outcome: 'victory',
      points: 250,
    }
  );
  assert.equal(stateReplay.score, 375, 'Improving level 2 from 225 to 250 must result in 375 (125 + 250), not 400');
  assert.equal(stateReplay.scoresByLevel[1], 125);
  assert.equal(stateReplay.scoresByLevel[2], 250);
});

test('R2: legacy save with score 350 and attempts {1: 1, 2: 2} migrates to {1: 125, 2: 225}, improving level 2 to 250 yields 375', () => {
  const rawLegacy = {
    lives: 3,
    score: 350,
    completedLevels: [1, 2],
    attemptsByLevel: { 1: 1, 2: 2 },
    resetAt: 1000,
  };
  const normalized = normalizeSavedState(rawLegacy).saved;
  assert.equal(normalized.score, 350);
  // Level 1 had a single attempt, so it was won on the first try (+25). The only decomposition of
  // 350 consistent with that is 125 + 225: level 2 was also won first and replayed later.
  assert.equal(normalized.scoresByLevel[1], 125, 'Level 1: base 100 + first-try bonus');
  assert.equal(normalized.scoresByLevel[2], 225, 'Level 2: base 200 + first-try bonus, the 2nd attempt was a replay');

  // A replay of level 2 (attempt 3, so no first-try bonus) with the efficiency bonus scores 250 (+25)
  const stateReplay = gameReducer(
    { ...normalized, storageKey: 'test-key', hydrated: true, revision: 0, persistedRevision: 0, isReset: false },
    {
      type: 'finishAttempt',
      storageKey: 'test-key',
      resetAt: 1000,
      level: 2,
      attemptId: 'att-2-improved',
      outcome: 'victory',
      points: 250,
    }
  );
  assert.equal(stateReplay.score, 375, 'Improving level 2 from 225 to 250 must result in 375 (125 + 250), not 350');
  assert.equal(stateReplay.scoresByLevel[1], 125);
  assert.equal(stateReplay.scoresByLevel[2], 250);
});

test('legacy reconstruction keeps a first-try bonus possible when later attempts were replays', () => {
  // Level 2 is the highest completed level; it was won on the first try, then replayed and died once.
  // Level 1 had a single attempt (first-try bonus is certain), so 350 can only split as 125 + 225.
  // Ruling out level 2's first-try bonus would force the impossible 100 + 250.
  const normalized = normalizeSavedState({
    lives: 2,
    score: 350,
    completedLevels: [1, 2],
    attemptsByLevel: { 1: 1, 2: 2 },
    deathsByLevel: { 2: 1 },
    resetAt: 1000,
  }).saved;
  assert.deepEqual({ ...normalized.scoresByLevel }, { 1: 125, 2: 225 });

  // Single-attempt levels keep their first-try bonus even when another level has deaths.
  const mixed = normalizeSavedState({
    lives: 2,
    score: 725,
    completedLevels: [1, 2, 3],
    attemptsByLevel: { 1: 1, 2: 1, 3: 2 },
    deathsByLevel: { 3: 1 },
    resetAt: 1000,
  }).saved;
  assert.equal((mixed.scoresByLevel[1] - 100) % 50, 25, 'level 1 keeps its first-try bonus');
  assert.equal((mixed.scoresByLevel[2] - 200) % 50, 25, 'level 2 keeps its first-try bonus');
  assert.equal(mixed.score, 725);
});

test('cross-tab synchronization with score 450 does not inflate 450 to 475 when a level was replayed', () => {
  const tabA = {
    lives: 3,
    score: 450,
    completedLevels: [1, 2],
    attemptsByLevel: { 1: 1, 2: 1 },
    resetAt: 1000,
  };
  const tabB = {
    lives: 3,
    score: 450,
    completedLevels: [1, 2],
    attemptsByLevel: { 1: 2, 2: 1 },
    resetAt: 1000,
  };
  const merged = mergeSavedStates(tabA, tabB);
  assert.equal(merged.score, 450, 'Cross-tab sync must keep total score at 450 without inflating to 475');
  assert.equal(merged.scoresByLevel[1], 175);
  assert.equal(merged.scoresByLevel[2], 275);
});

test('normalizeSavedState infers completedLevels from scoresByLevel if completedLevels array was missing or incomplete', () => {
  const save = {
    lives: 3,
    score: 400,
    completedLevels: [1], // Level 2 missing from completedLevels array
    scoresByLevel: { 1: 150, 2: 250 },
    resetAt: 1000,
  };
  const normalized = normalizeSavedState(save).saved;
  assert.deepEqual(normalized.completedLevels, [1, 2], 'Level 2 must be included in completedLevels based on positive score');
  assert.equal(normalized.score, 400);
});

test('gameReducer finishAttempt does not award victory or points when player has 0 lives (game over)', () => {
  const deadState = {
    lives: 0,
    score: 100,
    completedLevels: [1],
    scoresByLevel: { 1: 100 },
    attemptsByLevel: { 1: 1, 2: 1 },
    attemptEvents: [],
    completedAttemptIds: [],
    deathsByLevel: { 1: 3 },
    deathEvents: [
      { id: 'd1', level: 1, ts: 1000 },
      { id: 'd2', level: 1, ts: 1001 },
      { id: 'd3', level: 1, ts: 1002 },
    ],
    resetAt: 1000,
    updatedAt: 1000,
    storageKey: 'test-key',
    hydrated: true,
    revision: 0,
    persistedRevision: 0,
    isReset: false,
  };

  const outcomeState = gameReducer(deadState, {
    type: 'finishAttempt',
    storageKey: 'test-key',
    resetAt: 1000,
    level: 2,
    attemptId: 'att-2-late',
    outcome: 'victory',
    points: 250,
  });

  assert.equal(outcomeState.lives, 0, 'Lives must remain 0');
  assert.equal(outcomeState.score, 100, 'Score must not increase after game over');
  assert.deepEqual(outcomeState.completedLevels, [1], 'Level 2 must not be marked complete after game over');
  assert.ok(outcomeState.completedAttemptIds.includes('att-2-late'), 'Attempt ID should still be marked completed');
});

test('P2: legacy save with score 375 and levels [1, 2] migrates to {1: 125, 2: 250} and replaying level 2 with 250 points keeps score at 375', () => {
  // Test with attempts { 1: 1, 2: 2 } (browser reproduction scenario: level 1 on 1st try, level 2 on 2nd try)
  const legacyWithAttempts = {
    lives: 3,
    score: 375,
    completedLevels: [1, 2],
    attemptsByLevel: { 1: 1, 2: 2 },
    resetAt: 1000,
  };
  const normWithAttempts = normalizeSavedState(legacyWithAttempts).saved;
  assert.equal(normWithAttempts.score, 375);
  assert.equal(normWithAttempts.scoresByLevel[1], 125, 'Level 1 must receive 125 points');
  assert.equal(normWithAttempts.scoresByLevel[2], 250, 'Level 2 must receive 250 points');

  // Replay level 2 with the same 250 points
  const stateReplay = gameReducer(
    { ...normWithAttempts, storageKey: 'test-key', hydrated: true, revision: 0, persistedRevision: 0, isReset: false },
    {
      type: 'finishAttempt',
      storageKey: 'test-key',
      resetAt: 1000,
      level: 2,
      attemptId: 'att-2-replay',
      outcome: 'victory',
      points: 250,
    }
  );
  assert.equal(stateReplay.score, 375, 'Replaying level 2 with 250 points must keep total score at 375, NOT inflate to 425');
  assert.equal(stateReplay.scoresByLevel[1], 125);
  assert.equal(stateReplay.scoresByLevel[2], 250);

  // Test without attemptsByLevel
  const legacyNoAttempts = {
    lives: 3,
    score: 375,
    completedLevels: [1, 2],
    resetAt: 1000,
  };
  const normNoAttempts = normalizeSavedState(legacyNoAttempts).saved;
  assert.equal(normNoAttempts.score, 375);
  assert.equal(normNoAttempts.scoresByLevel[1], 125);
  assert.equal(normNoAttempts.scoresByLevel[2], 250);

  // Test with { 1: 1, 2: 1 }
  const legacyAtt11 = {
    lives: 3,
    score: 375,
    completedLevels: [1, 2],
    attemptsByLevel: { 1: 1, 2: 1 },
    resetAt: 1000,
  };
  const normAtt11 = normalizeSavedState(legacyAtt11).saved;
  assert.equal(normAtt11.score, 375);
  assert.equal(normAtt11.scoresByLevel[1], 125);
  assert.equal(normAtt11.scoresByLevel[2], 250);
});

test('P3: attempt count does not inflate to 1002 after reaching 1000 attempts and persists correctly across reloads', () => {
  const events = [];
  for (let i = 1; i <= 1000; i++) {
    events.push({ id: `att-${i}`, level: 1, ts: 1000 + i });
  }

  const diskState = {
    lives: 3,
    score: 100,
    completedLevels: [1],
    scoresByLevel: { 1: 100 },
    attemptsByLevel: { 1: 1000 },
    attemptEvents: events,
    completedAttemptIds: events.map(e => e.id),
    deathsByLevel: {},
    deathEvents: [],
    resetAt: 1000,
    updatedAt: 2000,
    storageKey: 'test-key',
    hydrated: true,
    revision: 10,
    persistedRevision: 10,
    isReset: false,
  };

  // Step 1: Start 1001st attempt
  const state1001 = gameReducer(diskState, {
    type: 'startAttempt',
    storageKey: 'test-key',
    resetAt: 1000,
    level: 1,
    attemptId: 'att-1001',
  });
  assert.equal(state1001.attemptsByLevel[1], 1001, 'Attempts in state immediately after startAttempt must be 1001');

  // Step 2: Persist effect runs mergeSavedStates(toSave, diskState)
  const toSave = {
    lives: state1001.lives,
    score: state1001.score,
    completedLevels: state1001.completedLevels,
    scoresByLevel: state1001.scoresByLevel,
    attemptsByLevel: state1001.attemptsByLevel,
    attemptEvents: state1001.attemptEvents,
    completedAttemptIds: state1001.completedAttemptIds,
    deathsByLevel: state1001.deathsByLevel,
    deathEvents: state1001.deathEvents,
    resetAt: state1001.resetAt,
    updatedAt: state1001.updatedAt,
  };
  const merged = mergeSavedStates(toSave, diskState);
  assert.equal(merged.attemptsByLevel[1], 1001, 'Merged attempts with disk must be 1001, NOT 1002');
  assert.equal(merged.attemptEvents.length, 1000, 'Events must be bounded to 1000');

  // Step 3: Persisted action updates state
  const stateAfterPersist = gameReducer(state1001, {
    type: 'persisted',
    storageKey: 'test-key',
    revision: state1001.revision,
    saved: merged,
  });
  assert.equal(stateAfterPersist.attemptsByLevel[1], 1001, 'UI state after persist must show 1001, NOT 1002');

  // Step 4: Reload from disk (normalizeSavedState)
  const reloaded = normalizeSavedState(JSON.parse(JSON.stringify(merged))).saved;
  assert.equal(reloaded.attemptsByLevel[1], 1001, 'Attempts after browser reload must remain 1001');
  assert.equal(reloaded.attemptEvents.length, 1000);

  // Step 5: Start 1002nd attempt
  const state1002 = gameReducer(stateAfterPersist, {
    type: 'startAttempt',
    storageKey: 'test-key',
    resetAt: 1000,
    level: 1,
    attemptId: 'att-1002',
  });
  assert.equal(state1002.attemptsByLevel[1], 1002);
  const merged1002 = mergeSavedStates(
    { ...state1002, storageKey: 'test-key' },
    merged
  );
  assert.equal(merged1002.attemptsByLevel[1], 1002, 'Attempts after 2nd new attempt must be 1002');

  // Step 6: Two concurrent attempts in separate tabs starting from 1000 merge to 1002
  const tabA = {
    attemptsByLevel: { 1: 1001 },
    attemptEvents: [...events.slice(1), { id: 'att-tabA', level: 1, ts: 3000 }],
    completedLevels: [1],
    scoresByLevel: { 1: 100 },
    lives: 3,
    score: 100,
    resetAt: 1000,
  };
  const tabB = {
    attemptsByLevel: { 1: 1001 },
    attemptEvents: [...events.slice(1), { id: 'att-tabB', level: 1, ts: 3001 }],
    completedLevels: [1],
    scoresByLevel: { 1: 100 },
    lives: 3,
    score: 100,
    resetAt: 1000,
  };
  const concurrentMerged = mergeSavedStates(tabA, tabB);
  assert.equal(concurrentMerged.attemptsByLevel[1], 1002, 'Two concurrent attempts beyond 1000 in separate tabs must merge to 1002');
});

test('mergeSavedStates handles attempt buffer cutoff when a level is absent from the 1000-event tail', () => {
  const lvl1Events = [];
  for (let i = 1; i <= 1000; i++) {
    lvl1Events.push({ id: `att-l1-${i}`, level: 1, ts: 1000 + i });
  }
  const tabA = {
    lives: 3,
    score: 100,
    completedLevels: [1],
    scoresByLevel: { 1: 100 },
    attemptsByLevel: { 1: 1000, 2: 1 },
    attemptEvents: [{ id: 'att-l2-1', level: 2, ts: 500 }, ...lvl1Events],
    resetAt: 1000,
  };
  const tabB = {
    lives: 3,
    score: 100,
    completedLevels: [1],
    scoresByLevel: { 1: 100 },
    attemptsByLevel: { 1: 1000, 2: 1 },
    attemptEvents: [...lvl1Events, { id: 'att-l2-2', level: 2, ts: 2500 }],
    resetAt: 1000,
  };
  const merged = mergeSavedStates(tabA, tabB);
  assert.ok(merged.attemptsByLevel[2] >= 2, 'Level 2 attempts should merge correctly even when sliced off in level 1 heavy buffer');
  assert.ok(Number.isFinite(merged.attemptsByLevel[2]));
});

test('gameReducer persisted action merges state when action.revision < state.revision', () => {
  const baseState = {
    lives: 3,
    score: 100,
    completedLevels: [1],
    scoresByLevel: { 1: 100 },
    attemptsByLevel: { 1: 1 },
    attemptEvents: [{ id: 'att-1', level: 1, ts: 1000 }],
    completedAttemptIds: ['att-1'],
    deathsByLevel: {},
    deathEvents: [],
    resetAt: 1000,
    updatedAt: 1000,
    storageKey: 'test-key',
    hydrated: true,
    revision: 5,
    persistedRevision: 4,
    isReset: false,
  };

  const advancedState = {
    ...baseState,
    score: 350,
    completedLevels: [1, 2],
    scoresByLevel: { 1: 100, 2: 250 },
    attemptsByLevel: { 1: 1, 2: 1 },
    attemptEvents: [{ id: 'att-1', level: 1, ts: 1000 }, { id: 'att-2', level: 2, ts: 1050 }],
    completedAttemptIds: ['att-1', 'att-2'],
    revision: 6,
    persistedRevision: 4,
  };

  const staleSaved = {
    lives: 3,
    score: 100,
    completedLevels: [1],
    scoresByLevel: { 1: 100 },
    attemptsByLevel: { 1: 1 },
    attemptEvents: [{ id: 'att-1', level: 1, ts: 1000 }],
    completedAttemptIds: ['att-1'],
    deathsByLevel: {},
    deathEvents: [],
    resetAt: 1000,
    updatedAt: 1000,
  };

  const nextState = gameReducer(advancedState, {
    type: 'persisted',
    storageKey: 'test-key',
    revision: 5,
    saved: staleSaved,
  });

  assert.equal(nextState.revision, 6, 'Revision must stay at 6');
  assert.equal(nextState.persistedRevision, 5, 'persistedRevision should be updated to 5');
  assert.deepEqual(nextState.completedLevels, [1, 2], 'In-memory completed level 2 must be preserved');
  assert.equal(nextState.score, 350, 'In-memory score must be preserved');
  assert.equal(nextState.scoresByLevel[2], 250);
});

test('normalizeSavedState score delta allocation ensures all level scores are non-negative', () => {
  const rawState = {
    lives: 3,
    score: 100,
    completedLevels: [1, 2, 3, 4, 5],
    scoresByLevel: {},
    resetAt: 1000,
  };
  const normalized = normalizeSavedState(rawState).saved;
  assert.equal(normalized.score, 100, 'Score should be preserved');
  for (const lvl of normalized.completedLevels) {
    assert.ok(normalized.scoresByLevel[lvl] >= 0, `Level ${lvl} score must be non-negative, got ${normalized.scoresByLevel[lvl]}`);
  }
  const sum = normalized.completedLevels.reduce((acc, lvl) => acc + (normalized.scoresByLevel[lvl] || 0), 0);
  assert.equal(sum, 100, 'Sum of level scores must equal total score');
});

test('gameReducer completeLevel does not award victory or points when player has 0 lives', () => {
  const deadState = {
    lives: 0,
    score: 100,
    completedLevels: [1],
    scoresByLevel: { 1: 100 },
    attemptsByLevel: { 1: 1 },
    attemptEvents: [],
    completedAttemptIds: [],
    deathsByLevel: { 1: 3 },
    deathEvents: [],
    resetAt: 1000,
    updatedAt: 1000,
    storageKey: 'test-key',
    hydrated: true,
    revision: 1,
    persistedRevision: 1,
    isReset: false,
  };

  const nextState = gameReducer(deadState, {
    type: 'completeLevel',
    storageKey: 'test-key',
    level: 2,
    points: 250,
  });

  assert.equal(nextState.lives, 0);
  assert.equal(nextState.score, 100, 'Score must not increase');
  assert.deepEqual(nextState.completedLevels, [1], 'Level 2 must not be marked complete');
  assert.equal(nextState.revision, 1, 'Revision should not increment');
});

test('gameReducer syncFromStorage triggers persistence when merged lives are lower than incoming disk lives', () => {
  const localState = {
    lives: 2,
    score: 100,
    completedLevels: [1],
    scoresByLevel: { 1: 100 },
    attemptsByLevel: { 1: 2 },
    attemptEvents: [{ id: 'att-1', level: 1, ts: 1000 }, { id: 'att-2', level: 1, ts: 1050 }],
    completedAttemptIds: ['att-1'],
    deathsByLevel: { 1: 1 },
    deathEvents: [{ id: 'd-1', level: 1, ts: 1050 }],
    resetAt: 1000,
    updatedAt: 1050,
    storageKey: 'test-key',
    hydrated: true,
    revision: 3,
    persistedRevision: 2,
    isReset: false,
  };

  const incomingDisk = {
    lives: 3,
    score: 100,
    completedLevels: [1],
    scoresByLevel: { 1: 100 },
    attemptsByLevel: { 1: 1 },
    attemptEvents: [{ id: 'att-1', level: 1, ts: 1000 }],
    completedAttemptIds: ['att-1'],
    deathsByLevel: {},
    deathEvents: [],
    resetAt: 1000,
    updatedAt: 1000,
  };

  const syncedState = gameReducer(localState, {
    type: 'syncFromStorage',
    storageKey: 'test-key',
    saved: incomingDisk,
  });

  assert.equal(syncedState.lives, 2);
  assert.ok(syncedState.revision > syncedState.persistedRevision, 'Revision must exceed persistedRevision so death is saved back');
});

test('mergeSavedStates handles boundary duplicate timestamps at 1000 attempts without counter inflation', () => {
  const baseEvents = [];
  baseEvents.push({ id: 'att-0', level: 1, ts: 1000 });
  baseEvents.push({ id: 'att-1', level: 1, ts: 1000 });
  for (let i = 2; i < 1000; i++) {
    baseEvents.push({ id: `att-${i}`, level: 1, ts: 1000 + i });
  }

  const base = {
    lives: 3,
    score: 0,
    completedLevels: [],
    scoresByLevel: {},
    attemptsByLevel: { 1: 1000 },
    attemptEvents: baseEvents,
    completedAttemptIds: baseEvents.map(e => e.id),
    deathsByLevel: {},
    deathEvents: [],
    resetAt: 500,
    updatedAt: 2000,
  };

  const incoming = {
    lives: 3,
    score: 0,
    completedLevels: [],
    scoresByLevel: {},
    attemptsByLevel: { 1: 1001 },
    attemptEvents: [
      ...baseEvents.slice(1),
      { id: 'att-1000', level: 1, ts: 3000 },
    ],
    completedAttemptIds: [
      ...baseEvents.slice(1).map(e => e.id),
      'att-1000',
    ],
    deathsByLevel: {},
    deathEvents: [],
    resetAt: 500,
    updatedAt: 3000,
  };

  const merged = mergeSavedStates(base, incoming);
  assert.equal(merged.attemptsByLevel[1], 1001, 'Attempts counter should be 1001, not inflated to 1002');
  assert.equal(merged.attemptEvents.length, 1000, 'Attempt events must be capped to 1000');
});

test('normalizeSavedState recovers unfinished attempt from browser reload / crash as defeat and deducts life', () => {
  const unfinishedAttemptState = {
    lives: 3,
    score: 0,
    completedLevels: [],
    scoresByLevel: {},
    attemptsByLevel: { 2: 1 },
    attemptEvents: [{ id: 'active-token-1', level: 2, ts: 1000 }],
    completedAttemptIds: [],
    deathsByLevel: {},
    deathEvents: [],
    resetAt: 500,
    updatedAt: 1000,
  };

  const normalized = normalizeSavedState(unfinishedAttemptState).saved;
  assert.equal(normalized.lives, 2, 'Life must be deducted for abandoned attempt');
  assert.equal(normalized.deathsByLevel[2], 1, 'Death must be recorded on level 2');
  assert.equal(normalized.deathEvents.length, 1);
  assert.equal(normalized.deathEvents[0].id, 'active-token-1-death');
  assert.deepEqual(normalized.completedAttemptIds, ['active-token-1'], 'Attempt should be marked as completed');
});

test('gameReducer startAttempt and recordAttempt do nothing when player has 0 lives (game over)', () => {
  const gameOverState = {
    lives: 0,
    score: 100,
    completedLevels: [1],
    scoresByLevel: { 1: 100 },
    attemptsByLevel: { 1: 3, 2: 1 },
    attemptEvents: [{ id: 'att-1', level: 1, ts: 1000 }],
    completedAttemptIds: ['att-1'],
    deathsByLevel: { 1: 3 },
    deathEvents: [
      { id: 'd-1', level: 1, ts: 1000 },
      { id: 'd-2', level: 1, ts: 1001 },
      { id: 'd-3', level: 1, ts: 1002 },
    ],
    resetAt: 500,
    updatedAt: 1002,
    storageKey: 'test-user',
    hydrated: true,
    revision: 10,
    persistedRevision: 10,
    isReset: false,
  };

  const afterStart = gameReducer(gameOverState, {
    type: 'startAttempt',
    storageKey: 'test-user',
    resetAt: 500,
    level: 2,
    attemptId: 'att-new',
  });
  assert.equal(afterStart.attemptsByLevel[2], 1, 'attemptsByLevel should not increment when lives === 0');
  assert.equal(afterStart.attemptEvents.length, 1, 'attemptEvents should not add new event when lives === 0');

  const afterRecord = gameReducer(gameOverState, {
    type: 'recordAttempt',
    storageKey: 'test-user',
    level: 2,
  });
  assert.equal(afterRecord.attemptsByLevel[2], 1, 'attemptsByLevel should not increment when lives === 0');
  assert.equal(afterRecord.attemptEvents.length, 1, 'attemptEvents should not add new event when lives === 0');
});

test('saveState and loadState preserve victory outcome, completed levels, and score', () => {
  const memStorage = new Map();
  global.window = {};
  global.localStorage = {
    getItem: (k) => memStorage.get(k) || null,
    setItem: (k, v) => memStorage.set(k, String(v)),
    removeItem: (k) => memStorage.delete(k),
  };

  const victoryState = {
    lives: 3,
    score: 175,
    completedLevels: [1],
    scoresByLevel: { 1: 175 },
    attemptsByLevel: { 1: 1 },
    attemptEvents: [{ id: 'att-1', level: 1, ts: 1000 }],
    completedAttemptIds: ['att-1'],
    deathsByLevel: {},
    deathEvents: [],
    resetAt: 500,
    updatedAt: 1000,
  };

  const saveErr = saveState('test-storage-key', victoryState);
  assert.equal(saveErr, null);

  const loaded = loadState('test-storage-key');
  assert.equal(loaded.error, null);
  assert.deepEqual(loaded.saved.completedLevels, [1]);
  assert.equal(loaded.saved.score, 175);
  assert.equal(loaded.saved.scoresByLevel[1], 175);

  delete global.window;
  delete global.localStorage;
});

test('P2: victory after long pause (>65s) does not deduct a life', () => {
  const attemptId = 'att-pause-65s';
  const attemptTs = Date.now() - 650_000;

  // Stale snapshot on disk (or evaluated after 65s pause by loadState)
  const staleDiskState = {
    lives: 3,
    score: 175,
    completedLevels: [1],
    scoresByLevel: { 1: 175 },
    attemptsByLevel: { 1: 1, 2: 1 },
    attemptEvents: [
      { id: 'att-1', level: 1, ts: attemptTs - 10000 },
      { id: attemptId, level: 2, ts: attemptTs },
    ],
    completedAttemptIds: ['att-1'],
    deathsByLevel: {},
    deathEvents: [],
    resetAt: 500,
    updatedAt: attemptTs,
  };

  // Normalization of stale state adds a crash-recovery death because > 60s elapsed
  const normalizedDisk = normalizeSavedState(staleDiskState).saved;
  assert.equal(normalizedDisk.deathEvents.some(d => d.id === `${attemptId}-death`), true);
  assert.equal(normalizedDisk.lives, 2, 'Stale snapshot without victory is normalized to 2 lives');

  // Victory completed in local game context
  const victoryState = {
    lives: 3,
    score: 400,
    completedLevels: [1, 2],
    scoresByLevel: { 1: 175, 2: 225 },
    attemptsByLevel: { 1: 1, 2: 1 },
    attemptEvents: [
      { id: 'att-1', level: 1, ts: attemptTs - 10000 },
      { id: attemptId, level: 2, ts: attemptTs },
    ],
    completedAttemptIds: ['att-1', attemptId],
    deathsByLevel: {},
    deathEvents: [],
    resetAt: 500,
    updatedAt: Date.now(),
  };

  // When merging victory state with stale disk state containing crash-recovery death,
  // the phantom death must be discarded and player must retain all 3 lives
  const merged = mergeSavedStates(victoryState, normalizedDisk);
  assert.equal(merged.lives, 3, 'Player must retain 3 lives after victory despite long pause');
  assert.equal(merged.deathEvents.some(d => d.id === `${attemptId}-death`), false, 'Phantom death event must be discarded');
  assert.deepEqual(merged.completedLevels, [1, 2]);
  assert.equal(merged.score, 400);
});

test('P2: legacy save with score 700 and attempts {1: 1, 2: 1, 3: 2} migrates to {1: 125, 2: 225, 3: 350} and replaying level 3 with 350 points keeps score at 700', () => {
  const rawLegacy = {
    lives: 3,
    score: 700,
    completedLevels: [1, 2, 3],
    attemptsByLevel: { 1: 1, 2: 1, 3: 2 },
    resetAt: 1000,
  };
  const normalized = normalizeSavedState(rawLegacy).saved;
  assert.equal(normalized.score, 700);
  assert.equal(normalized.scoresByLevel[1], 125, 'Level 1 must receive 125 points (100 base + 25 first try)');
  assert.equal(normalized.scoresByLevel[2], 225, 'Level 2 must receive 225 points (200 base + 25 first try)');
  assert.equal(normalized.scoresByLevel[3], 350, 'Level 3 must receive 350 points (300 base + 50 steps)');

  // Replaying level 3 for 350 points must not inflate score to 750
  const stateReplay = gameReducer(
    { ...normalized, storageKey: 'test-key', hydrated: true, revision: 0, persistedRevision: 0, isReset: false },
    {
      type: 'finishAttempt',
      storageKey: 'test-key',
      resetAt: 1000,
      level: 3,
      attemptId: 'att-3-350',
      outcome: 'victory',
      points: 350,
    }
  );
  assert.equal(stateReplay.score, 700, 'Replaying level 3 for 350 points must keep total score at 700, not 750');
  assert.equal(stateReplay.scoresByLevel[3], 350);
});

test('P3: 1000+ attempts buffer retains completion flags on surviving attempt events and prevents phantom deaths', () => {
  const attemptEvents = [];
  const completedAttemptIds = [];
  const baseTs = Date.now() - 120_000;

  for (let i = 0; i < 1100; i++) {
    const id = `att-${i}`;
    attemptEvents.push({ id, level: 1, ts: baseTs + i * 10 });
    completedAttemptIds.push(id);
  }

  const rawState = {
    lives: 3,
    score: 100,
    completedLevels: [1],
    scoresByLevel: { 1: 100 },
    attemptsByLevel: { 1: 1100 },
    attemptEvents,
    completedAttemptIds,
    deathsByLevel: {},
    deathEvents: [],
    resetAt: 500,
    updatedAt: Date.now(),
  };

  const normalized = normalizeSavedState(rawState).saved;
  assert.equal(normalized.attemptEvents.length, 1000, 'Attempt events capped to 1000');
  // All 1000 surviving attempt events must have their IDs in completedAttemptIds
  for (const e of normalized.attemptEvents) {
    assert.ok(
      normalized.completedAttemptIds.includes(e.id),
      `Surviving attempt ${e.id} must retain its completedAttemptId`,
    );
  }
  // Because all surviving attempt events are marked completed, no phantom deaths are generated
  assert.equal(normalized.deathEvents.length, 0, 'No phantom deaths created for surviving completed attempts');
  assert.equal(normalized.lives, 3, 'Lives must remain 3');
});

test('P3: multi-tab attempt merging when global attempts >= 1000 does not drop parallel attempts', () => {
  const baseEvents = [];
  for (let i = 0; i < 999; i++) {
    baseEvents.push({ id: `att-l1-${i}`, level: 1, ts: 1000 + i });
  }
  // Tab 1 records attempt on Level 2 at ts: 5000
  baseEvents.push({ id: 'att-tab1-l2', level: 2, ts: 5000 });

  const tab1State = {
    lives: 3,
    score: 100,
    completedLevels: [1],
    scoresByLevel: { 1: 100 },
    attemptsByLevel: { 1: 999, 2: 1 },
    attemptEvents: baseEvents,
    completedAttemptIds: baseEvents.map(e => e.id),
    deathsByLevel: {},
    deathEvents: [],
    resetAt: 500,
    updatedAt: 5000,
  };

  const incEvents = baseEvents.slice(0, 999);
  // Tab 2 records different attempt on Level 2 at ts: 5000
  incEvents.push({ id: 'att-tab2-l2', level: 2, ts: 5000 });

  const tab2State = {
    lives: 3,
    score: 100,
    completedLevels: [1],
    scoresByLevel: { 1: 100 },
    attemptsByLevel: { 1: 999, 2: 1 },
    attemptEvents: incEvents,
    completedAttemptIds: incEvents.map(e => e.id),
    deathsByLevel: {},
    deathEvents: [],
    resetAt: 500,
    updatedAt: 5000,
  };

  const merged = mergeSavedStates(tab1State, tab2State);
  assert.equal(merged.attemptsByLevel[2], 2, 'Level 2 attempts from both tabs must merge to 2');
});

test('P2: another tab completing level 1 does not cancel victory of level 2 after pause', () => {
  const attemptId = 'att-tabA-l2';
  // State in Tab A after Level 1 passed (score 175) and Level 2 started
  const tabAInitial = {
    lives: 3,
    score: 175,
    completedLevels: [1],
    scoresByLevel: { 1: 175 },
    attemptsByLevel: { 1: 1, 2: 1 },
    attemptEvents: [
      { id: 'att-l1', level: 1, ts: 1000 },
      { id: attemptId, level: 2, ts: 2000 },
    ],
    completedAttemptIds: ['att-l1'],
    deathsByLevel: {},
    deathEvents: [],
    resetAt: 500,
    updatedAt: 2000,
    storageKey: 'test-user',
    hydrated: true,
    revision: 1,
    persistedRevision: 1,
    isReset: false,
  };

  // Another tab (Tab B) passes Level 1, syncs, or runs normalizeSavedState
  // which prematurely added a crash death for att-tabA-l2 and added it to completedAttemptIds
  const tabAPrematureDeathState = {
    ...tabAInitial,
    lives: 2,
    deathsByLevel: { 2: 1 },
    deathEvents: [{ id: `${attemptId}-death`, level: 2, ts: 2000 }],
    completedAttemptIds: ['att-l1', attemptId],
  };

  // Tab A unpauses and completes Level 2 with victory (275 points)
  const finishResult = gameReducer(tabAPrematureDeathState, {
    type: 'finishAttempt',
    storageKey: 'test-user',
    resetAt: 500,
    level: 2,
    attemptId,
    outcome: 'victory',
    points: 275,
  });

  assert.equal(finishResult.lives, 3, 'Phantom death must be removed and lives restored to 3');
  assert.equal(finishResult.deathEvents.some(d => d.id === `${attemptId}-death`), false, 'Phantom death event must be removed');
  assert.equal(finishResult.score, 450, 'Score must be updated to 450 (175 + 275)');
  assert.deepEqual(finishResult.completedLevels, [1, 2], 'Level 2 must be recorded in completedLevels');
  assert.equal(finishResult.scoresByLevel[2], 275);
});

test('P2: real defeat after pause deducts life when 1 life was already lost', () => {
  const attemptId = 'att-defeat-after-pause';
  // Player already lost 1 life previously (lives = 2, 1 death event)
  const priorDeath = { id: 'death-l1', level: 1, ts: 500 };
  const baseState = {
    lives: 2,
    score: 0,
    completedLevels: [],
    scoresByLevel: {},
    attemptsByLevel: { 1: 1, 2: 1 },
    attemptEvents: [
      { id: 'att-1', level: 1, ts: 500 },
      { id: attemptId, level: 2, ts: 1000 },
    ],
    completedAttemptIds: ['att-1'],
    deathsByLevel: { 1: 1 },
    deathEvents: [priorDeath],
    resetAt: 500,
    updatedAt: 1000,
    storageKey: 'test-user',
    hydrated: true,
    revision: 2,
    persistedRevision: 2,
    isReset: false,
  };

  // Player fails Level 2 (real defeat)
  const afterDefeat = gameReducer(baseState, {
    type: 'finishAttempt',
    storageKey: 'test-user',
    resetAt: 500,
    level: 2,
    attemptId,
    outcome: 'defeat',
  });

  assert.equal(afterDefeat.lives, 1, 'Lives must decrease from 2 to 1 on defeat');
  assert.equal(afterDefeat.deathEvents.length, 2);
  assert.equal(afterDefeat.deathEvents.some(d => d.id === `${attemptId}-death`), true);

  // Even when merged with an incoming state that had attempt in completedAttemptIds without death
  const staleIncoming = {
    ...baseState,
    completedAttemptIds: ['att-1', attemptId],
    deathEvents: [priorDeath],
  };
  const merged = mergeSavedStates(afterDefeat, staleIncoming);
  assert.equal(merged.lives, 1, 'Real defeat must NOT be purged by merge; lives must stay 1');
  assert.equal(merged.deathEvents.some(d => d.id === `${attemptId}-death`), true);
});

test('P3: large history (1000+ events) with evicted old attempt merges concurrent attempts with same timestamp into 3', () => {
  const baseEvents = [];
  for (let i = 0; i < 999; i++) {
    baseEvents.push({ id: `att-l1-${i}`, level: 1, ts: 1000 + i });
  }
  // Level 2 has 1 new attempt at ts: 5000 in base (an older level 2 attempt was evicted long ago)
  baseEvents.push({ id: 'att-tab1-l2', level: 2, ts: 5000 });

  const tab1State = {
    lives: 3,
    score: 100,
    completedLevels: [1],
    scoresByLevel: { 1: 100 },
    attemptsByLevel: { 1: 999, 2: 2 }, // 2 total attempts on level 2 (1 evicted, 1 active)
    attemptEvents: baseEvents,
    completedAttemptIds: baseEvents.map(e => e.id),
    deathsByLevel: {},
    deathEvents: [],
    resetAt: 500,
    updatedAt: 5000,
  };

  const incEvents = baseEvents.slice(0, 999);
  // Level 2 has 1 new attempt at ts: 5000 in incoming (different ID, same timestamp)
  incEvents.push({ id: 'att-tab2-l2', level: 2, ts: 5000 });

  const tab2State = {
    lives: 3,
    score: 100,
    completedLevels: [1],
    scoresByLevel: { 1: 100 },
    attemptsByLevel: { 1: 999, 2: 2 }, // 2 total attempts on level 2 (1 evicted, 1 active)
    attemptEvents: incEvents,
    completedAttemptIds: incEvents.map(e => e.id),
    deathsByLevel: {},
    deathEvents: [],
    resetAt: 500,
    updatedAt: 5000,
  };

  const merged = mergeSavedStates(tab1State, tab2State);
  assert.equal(merged.attemptsByLevel[2], 3, 'Level 2 attempts should merge to 3 (1 evicted + 2 concurrent new)');
});

test('gameReducer finishAttempt victory removes phantom death and awards points even if lives was temporarily 0', () => {
  const attemptId = 'att-lvl2-win';
  const state = {
    lives: 0,
    score: 175,
    completedLevels: [1],
    scoresByLevel: { 1: 175 },
    attemptsByLevel: { 1: 1, 2: 1 },
    attemptEvents: [{ id: attemptId, level: 2, ts: 1000 }],
    completedAttemptIds: [attemptId],
    deathsByLevel: { 1: 2, 2: 1 },
    deathEvents: [
      { id: 'd-1', level: 1, ts: 500 },
      { id: 'd-2', level: 1, ts: 600 },
      { id: `${attemptId}-death`, level: 2, ts: 1000 },
    ],
    resetAt: 100,
    updatedAt: 1000,
    storageKey: 'test-key',
    hydrated: true,
    revision: 1,
    persistedRevision: 1,
    isReset: false,
  };

  const nextState = gameReducer(state, {
    type: 'finishAttempt',
    storageKey: 'test-key',
    resetAt: 100,
    level: 2,
    attemptId,
    outcome: 'victory',
    points: 275,
  });

  assert.equal(nextState.lives, 1, 'Lives should be restored from 0 to 1 after removing phantom death');
  assert.equal(nextState.score, 450, 'Score should increase from 175 to 450');
  assert.deepEqual(nextState.completedLevels, [1, 2], 'Level 2 should be marked completed');
  assert.equal(nextState.deathEvents.some(d => d.id === `${attemptId}-death`), false);
});

test('P2: long pause (>10 min) on level 2 does not cause premature Game Over when level 1 loses 2 lives in another tab', () => {
  const pausedAttemptId = 'att-tab1-l2-paused';
  registerActiveAttempt(pausedAttemptId);

  // Tab 1 paused on Level 2 with start timestamp > 10 minutes ago
  const tab1PausedState = {
    lives: 3,
    score: 0,
    completedLevels: [],
    scoresByLevel: {},
    attemptsByLevel: { 2: 1 },
    attemptEvents: [{ id: pausedAttemptId, level: 2, ts: Date.now() - 700_000 }],
    completedAttemptIds: [],
    deathsByLevel: {},
    deathEvents: [],
    resetAt: 1000,
    updatedAt: Date.now() - 700_000,
  };

  // Tab 2 opens, loads and normalizes state
  const tab2Loaded = normalizeSavedState(tab1PausedState).saved;
  assert.equal(tab2Loaded.lives, 3, 'Lives must NOT be deducted for active paused attempt');
  assert.equal(tab2Loaded.deathEvents.length, 0, 'No death event should be recorded for active paused attempt');
  assert.equal(tab2Loaded.completedAttemptIds.includes(pausedAttemptId), false, 'Paused attempt must remain incomplete');

  // Tab 2 plays Level 1 and dies twice
  const tab2StateAfter1stDeath = gameReducer(
    { ...tab2Loaded, storageKey: 'test-user', hydrated: true, revision: 1, persistedRevision: 1, isReset: false },
    {
      type: 'finishAttempt',
      storageKey: 'test-user',
      resetAt: 1000,
      level: 1,
      attemptId: 'att-tab2-l1-die1',
      outcome: 'defeat',
    }
  );
  assert.equal(tab2StateAfter1stDeath.lives, 2);

  const tab2StateAfter2ndDeath = gameReducer(tab2StateAfter1stDeath, {
    type: 'finishAttempt',
    storageKey: 'test-user',
    resetAt: 1000,
    level: 1,
    attemptId: 'att-tab2-l1-die2',
    outcome: 'defeat',
  });
  // Tab 2 has 2 deaths, player should have 1 life remaining (NOT 0 - NO GAME OVER!)
  assert.equal(tab2StateAfter2ndDeath.lives, 1, 'Player must have 1 life left, NOT 0 (premature Game Over avoided)');
  assert.equal(tab2StateAfter2ndDeath.deathEvents.length, 2);

  // When synced back to Tab 1, Tab 1 also has 1 life and can unpause
  const tab1Synced = mergeSavedStates(tab1PausedState, tab2StateAfter2ndDeath);
  assert.equal(tab1Synced.lives, 1, 'Tab 1 has 1 life left and is not blocked by Game Over');

  // Tab 1 unpauses and completes Level 2 with victory
  const tab1Won = gameReducer(
    { ...tab1Synced, storageKey: 'test-user', hydrated: true, revision: 3, persistedRevision: 3, isReset: false },
    {
      type: 'finishAttempt',
      storageKey: 'test-user',
      resetAt: 1000,
      level: 2,
      attemptId: pausedAttemptId,
      outcome: 'victory',
      points: 275,
    }
  );
  assert.equal(tab1Won.lives, 1, 'Lives should remain 1');
  assert.equal(tab1Won.score, 275, 'Score should be awarded for victory');
  assert.deepEqual(tab1Won.completedLevels, [2], 'Level 2 should be marked complete');

  unregisterActiveAttempt(pausedAttemptId);
});

test('P2: crash save snapshot recovery with prior lost life accounts for uncompleted attempt as defeat', () => {
  // Player previously lost 1 life on Level 1 (rawLostLives = 1, lives = 2)
  const priorDeath = { id: 'att-1-death', level: 1, ts: 500 };
  const crashSnapshot = {
    lives: 2,
    score: 0,
    completedLevels: [],
    scoresByLevel: {},
    attemptsByLevel: { 1: 1, 2: 1 },
    attemptEvents: [
      { id: 'att-1', level: 1, ts: 500 },
      { id: 'att-crash-l2', level: 2, ts: 1000 },
    ],
    completedAttemptIds: ['att-1'],
    deathsByLevel: { 1: 1 },
    deathEvents: [priorDeath],
    resetAt: 500,
    updatedAt: 1000,
  };

  const normalized = normalizeSavedState(crashSnapshot).saved;
  assert.equal(normalized.lives, 1, 'Uncompleted attempt in crash snapshot must deduct life from 2 to 1');
  assert.equal(normalized.deathEvents.length, 2, 'Total deaths must be 2');
  assert.equal(normalized.deathEvents.some(d => d.id === 'att-crash-l2-death'), true, 'Crash death must be recorded');
  assert.equal(normalized.deathsByLevel[2], 1, 'Level 2 deaths must be 1');
  assert.equal(normalized.completedAttemptIds.includes('att-crash-l2'), true, 'Crash attempt must be added to completedAttemptIds');
});

test('loadState tells a broken localStorage apart from saved data that was only repaired', () => {
  const storage = {};
  const mockWindow = {
    localStorage: {
      getItem: (k) => storage[k] ?? null,
      setItem: (k, v) => { storage[k] = String(v); },
      removeItem: (k) => { delete storage[k]; },
    },
  };
  global.window = mockWindow;
  global.localStorage = mockWindow.localStorage;
  try {
    storage['repaired'] = JSON.stringify({ lives: 'three', score: 0, completedLevels: [] });
    const repaired = loadState('repaired');
    assert.ok(repaired.error, 'invalid values must still be reported');
    assert.ok(!repaired.failed, 'repaired data is not a storage failure');

    global.localStorage = { getItem: () => { throw new Error('denied'); } };
    const broken = loadState('broken');
    assert.equal(broken.failed, true);
    assert.match(broken.error, /Could not load/);
  } finally {
    delete global.window;
    delete global.localStorage;
  }
});

test('P2: old tab finishAttemptSync with stale resetAt does not deduct life from new reset game', () => {
  const storage = {};
  const mockWindow = {
    localStorage: {
      getItem: (k) => storage[k] ?? null,
      setItem: (k, v) => { storage[k] = String(v); },
      removeItem: (k) => { delete storage[k]; },
    },
  };
  global.window = mockWindow;
  global.localStorage = mockWindow.localStorage;

  try {
    const storageKey = 'user-reset-test';

    // Tab 2 reset the game: save on disk has resetAt: 2000, lives: 3
    const freshGameOnDisk = {
      lives: 3,
      score: 0,
      completedLevels: [],
      scoresByLevel: {},
      attemptsByLevel: {},
      attemptEvents: [],
      completedAttemptIds: [],
      deathsByLevel: {},
      deathEvents: [],
      resetAt: 2000,
      updatedAt: 2000,
    };
    saveState(storageKey, freshGameOnDisk);

    // Tab 1 closes before receiving the reset notification.
    // Its attempt token has the old resetAt: 1000.
    const oldToken = {
      attemptId: 'att-tab1-old',
      level: 2,
      storageKey,
      resetAt: 1000,
    };

    const result = executeFinishAttemptSync(
      { token: oldToken, outcome: 'defeat' },
      storageKey,
      1000 // Tab 1 in-memory resetAt was still 1000
    );

    assert.equal(result, false, 'finishAttemptSync must return false when resetAt does not match disk');

    // Read back state from disk - it must NOT have lost a life!
    const diskAfter = loadState(storageKey).saved;
    assert.equal(diskAfter.lives, 3, 'New game on disk must keep 3 lives (NOT 2)');
    assert.equal(diskAfter.deathEvents.length, 0, 'No death event should be recorded in the new game');
    assert.equal(diskAfter.resetAt, 2000, 'resetAt must remain 2000');
  } finally {
    delete global.window;
    delete global.localStorage;
  }
});

test('P2: prior lost life on level 2 does not mask new crashed/abandoned attempt on level 2 (lives 2 -> 1)', () => {
  // Scenario:
  // 1. Old save has 1 life already lost on level 2 (lives: 2, deathsByLevel: { 2: 1 }, deathEvents: [{ id: 'd-1', level: 2, ts: 100 }])
  // 2. Player starts a new attempt on level 2 (attemptsByLevel: { 2: 2 }, attemptEvents: [att-crash-l2])
  // 3. Crash happens without normal completion
  // 4. Upon recovery, lives must be 1, NOT 2
  const priorDeath = { id: 'd-1', level: 2, ts: 100 };
  const crashState = {
    lives: 2,
    score: 0,
    completedLevels: [],
    scoresByLevel: {},
    attemptsByLevel: { 2: 2 },
    attemptEvents: [
      { id: 'att-crash-l2', level: 2, ts: 1000 },
    ],
    completedAttemptIds: [],
    deathsByLevel: { 2: 1 },
    deathEvents: [priorDeath],
    resetAt: 100,
    updatedAt: 1000,
  };

  const normalized = normalizeSavedState(crashState).saved;
  assert.equal(normalized.lives, 1, 'Lives must drop from 2 to 1 (new crashed attempt must not be masked by prior death)');
  assert.equal(normalized.deathEvents.length, 2, 'Total deaths must be 2');
  assert.equal(normalized.deathEvents.some(d => d.id === 'att-crash-l2-death'), true, 'New death event att-crash-l2-death must be recorded');
  assert.equal(normalized.deathsByLevel[2], 2, 'Level 2 deaths must be 2');
  assert.equal(normalized.completedAttemptIds.includes('att-crash-l2'), true, 'Crash attempt must be marked as completed');
});

test('P2: two prior lost lives on level 2 do not mask new crashed/abandoned attempt on level 2 (lives 1 -> 0, Game Over)', () => {
  // Scenario:
  // 1. Old save has 2 lives already lost on level 2 (lives: 1, deathsByLevel: { 2: 2 }, 2 death events)
  // 2. Player starts a 3rd attempt on level 2 (attemptsByLevel: { 2: 3 })
  // 3. Crash happens without normal completion
  // 4. Upon recovery, lives must be 0 (Game Over), NOT 1
  const crashState = {
    lives: 1,
    score: 0,
    completedLevels: [],
    scoresByLevel: {},
    attemptsByLevel: { 2: 3 },
    attemptEvents: [
      { id: 'att-crash-l2-third', level: 2, ts: 1000 },
    ],
    completedAttemptIds: [],
    deathsByLevel: { 2: 2 },
    deathEvents: [
      { id: 'd-1', level: 2, ts: 100 },
      { id: 'd-2', level: 2, ts: 200 },
    ],
    resetAt: 100,
    updatedAt: 1000,
  };

  const normalized = normalizeSavedState(crashState).saved;
  assert.equal(normalized.lives, 0, 'Lives must drop from 1 to 0 (Game Over)');
  assert.equal(normalized.deathEvents.length, 3, 'Total deaths must be 3');
  assert.equal(normalized.deathEvents.some(d => d.id === 'att-crash-l2-third-death'), true, 'New death event must be recorded');
  assert.equal(normalized.deathsByLevel[2], 3, 'Level 2 deaths must be 3');
  assert.equal(normalized.completedAttemptIds.includes('att-crash-l2-third'), true, 'Crash attempt must be marked as completed');
});

test('P2: normalizeSavedState reconciles partial deathEvents with deathsByLevel and raw lives', () => {
  // Scenario:
  // Saved state has 1 death event on level 1, but legacy deathsByLevel recorded { 1: 1, 2: 1 } (or lives: 1).
  // Older code only checked deathsByLevel if deathEvents.length === 0, dropping the level 2 death.
  // With the fix, death on level 2 is synthesized, deathsByLevel is kept in sync, and lives is 1.
  const stateWithPartialDeaths = {
    lives: 1,
    score: 0,
    completedLevels: [],
    scoresByLevel: {},
    attemptsByLevel: { 1: 1, 2: 1 },
    attemptEvents: [],
    completedAttemptIds: [],
    deathsByLevel: { 1: 1, 2: 1 },
    deathEvents: [
      { id: 'death-level-1-explicit', level: 1, ts: 100 },
    ],
    resetAt: 100,
    updatedAt: 200,
  };

  const normalized = normalizeSavedState(stateWithPartialDeaths).saved;
  assert.equal(normalized.lives, 1, 'Lives must be 1 (2 deaths total)');
  assert.equal(normalized.deathEvents.length, 2, 'Must have 2 death events');
  assert.equal(normalized.deathEvents.some(d => d.level === 2), true, 'Level 2 death must be present in deathEvents');
  assert.equal(normalized.deathsByLevel[1], 1, 'Level 1 deaths must be 1');
  assert.equal(normalized.deathsByLevel[2], 1, 'Level 2 deaths must be 1');
});

test('P2: legacy save with score 375, attempts {1: 1, 2: 2}, deaths {2: 1} migrates to {1: 175, 2: 200}, replay L1 keeps 375, improving L2 yields 425', () => {
  const legacy = {
    lives: 2,
    score: 375,
    completedLevels: [1, 2],
    attemptsByLevel: { 1: 1, 2: 2 },
    deathsByLevel: { 2: 1 },
    resetAt: 1000,
  };
  const norm = normalizeSavedState(legacy).saved;
  assert.equal(norm.score, 375);
  assert.equal(norm.scoresByLevel[1], 175, 'Level 1 with 1 attempt and 0 deaths gets 100 + 75 = 175');
  assert.equal(norm.scoresByLevel[2], 200, 'Level 2 with 1 death gets base 200');

  // Replay L1 for 150 points must not increase total score
  const replayL1 = gameReducer(
    { ...norm, storageKey: 'test-key', hydrated: true, revision: 0, persistedRevision: 0, isReset: false },
    {
      type: 'finishAttempt',
      storageKey: 'test-key',
      resetAt: 1000,
      level: 1,
      attemptId: 'att-1-replay',
      outcome: 'victory',
      points: 150,
    }
  );
  assert.equal(replayL1.score, 375, 'Replaying L1 for 150 points must keep total score at 375, NOT 400');
  assert.equal(replayL1.scoresByLevel[1], 175);

  // Improving L2 to 250 points must yield 425
  const improveL2 = gameReducer(
    { ...norm, storageKey: 'test-key', hydrated: true, revision: 0, persistedRevision: 0, isReset: false },
    {
      type: 'finishAttempt',
      storageKey: 'test-key',
      resetAt: 1000,
      level: 2,
      attemptId: 'att-2-improve',
      outcome: 'victory',
      points: 250,
    }
  );
  assert.equal(improveL2.score, 425, 'Improving L2 to 250 points must increase total score to 425');
  assert.equal(improveL2.scoresByLevel[2], 250);
});

test('P2: syncFromStorage retains completedAttemptIds and triggers persistence to prevent losing life on reload', () => {
  const baseDiskState = {
    lives: 3,
    score: 175,
    completedLevels: [1],
    scoresByLevel: { 1: 175 },
    attemptsByLevel: { 1: 1 },
    attemptEvents: [{ id: 'att-first', level: 1, ts: 1000 }],
    completedAttemptIds: ['att-first'],
    deathsByLevel: {},
    deathEvents: [],
    resetAt: 1000,
    updatedAt: 1000,
  };

  let tabAState = {
    ...baseDiskState,
    storageKey: 'user-key',
    hydrated: true,
    revision: 1,
    persistedRevision: 1,
    isReset: false,
  };

  tabAState = gameReducer(tabAState, {
    type: 'startAttempt',
    storageKey: 'user-key',
    resetAt: 1000,
    level: 1,
    attemptId: 'att-A',
  });

  const tabBDeathState = {
    ...baseDiskState,
    lives: 2,
    attemptsByLevel: { 1: 2 },
    attemptEvents: [
      { id: 'att-first', level: 1, ts: 1000 },
      { id: 'att-B', level: 1, ts: 1050 },
    ],
    completedAttemptIds: ['att-first', 'att-B'],
    deathsByLevel: { 1: 1 },
    deathEvents: [{ id: 'att-B-death', level: 1, ts: 1050 }],
    updatedAt: 1060,
  };

  tabAState = gameReducer(tabAState, {
    type: 'finishAttempt',
    storageKey: 'user-key',
    resetAt: 1000,
    level: 1,
    attemptId: 'att-A',
    outcome: 'victory',
    points: 150,
  });
  tabAState = { ...tabAState, persistedRevision: tabAState.revision };

  tabAState = gameReducer(tabAState, {
    type: 'syncFromStorage',
    storageKey: 'user-key',
    saved: tabBDeathState,
  });

  assert.ok(tabAState.revision > tabAState.persistedRevision, 'persistedRevision must NOT advance, requiring persistence');
  assert.ok(tabAState.completedAttemptIds.includes('att-A'), 'att-A must be in completedAttemptIds');
  assert.ok(tabAState.completedAttemptIds.includes('att-B'), 'att-B must be in completedAttemptIds');

  const diskSavedState = {
    ...tabAState,
  };
  const reloaded = normalizeSavedState(diskSavedState).saved;
  assert.equal(reloaded.lives, 2, 'Reloading state must have 2 lives (NOT 1)');
  assert.equal(reloaded.deathEvents.length, 1, 'Only Tab B defeat must be recorded');
  assert.equal(reloaded.deathEvents[0].id, 'att-B-death');
});

test('gameReducer startAttempt rejects attempts on locked levels', () => {
  const stateLevel1Done = {
    lives: 3,
    score: 100,
    completedLevels: [1],
    scoresByLevel: { 1: 100 },
    attemptsByLevel: { 1: 1 },
    attemptEvents: [{ id: 'att-1', level: 1, ts: 1000 }],
    completedAttemptIds: ['att-1'],
    deathsByLevel: {},
    deathEvents: [],
    resetAt: 1000,
    updatedAt: 1000,
    storageKey: 'test-key',
    hydrated: true,
    revision: 1,
    persistedRevision: 1,
    isReset: false,
  };

  // Attempting level 3 when only level 1 is done -> MUST be rejected (returns state unchanged)
  const rejectedState = gameReducer(stateLevel1Done, {
    type: 'startAttempt',
    storageKey: 'test-key',
    resetAt: 1000,
    level: 3,
    attemptId: 'att-3-bad',
  });
  assert.equal(rejectedState.attemptsByLevel[3], undefined);
  assert.equal(rejectedState.attemptEvents.length, 1);

  // Attempting level 2 when level 1 is done -> MUST succeed
  const acceptedState = gameReducer(stateLevel1Done, {
    type: 'startAttempt',
    storageKey: 'test-key',
    resetAt: 1000,
    level: 2,
    attemptId: 'att-2-ok',
  });
  assert.equal(acceptedState.attemptsByLevel[2], 1);
  assert.equal(acceptedState.attemptEvents.length, 2);
});

test('migrateGuestProgress merges guest progress into existing user progress instead of discarding', () => {
  const originalLocalStorage = global.localStorage;
  const originalWindow = global.window;
  const store = new Map();

  global.window = {};
  global.localStorage = {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, val) => store.set(key, String(val)),
    removeItem: (key) => store.delete(key),
  };

  try {
    const guestKey = getStorageKey(null);
    const userKey = getStorageKey('user-test-123');

    // Guest has completed levels 1, 2, 3 with score 450
    const guestState = {
      lives: 3,
      score: 450,
      completedLevels: [1, 2, 3],
      scoresByLevel: { 1: 100, 2: 150, 3: 200 },
      attemptsByLevel: { 1: 1, 2: 1, 3: 2 },
      attemptEvents: [],
      completedAttemptIds: [],
      deathsByLevel: {},
      deathEvents: [],
      resetAt: 1000,
      updatedAt: 1050,
    };
    store.set(guestKey, JSON.stringify(guestState));

    // User already had an old save with level 1 completed with score 120
    const userState = {
      lives: 3,
      score: 120,
      completedLevels: [1],
      scoresByLevel: { 1: 120 },
      attemptsByLevel: { 1: 1 },
      attemptEvents: [],
      completedAttemptIds: [],
      deathsByLevel: {},
      deathEvents: [],
      resetAt: 1000,
      updatedAt: 1020,
    };
    store.set(userKey, JSON.stringify(userState));

    const err = migrateGuestProgress('user-test-123');
    assert.equal(err, null);

    // Guest storage must be cleaned up
    assert.equal(store.has(guestKey), false);

    // User storage must contain the merged progress
    const mergedRaw = store.get(userKey);
    assert.ok(mergedRaw);
    const merged = JSON.parse(mergedRaw);

    assert.deepEqual(merged.completedLevels, [1, 2, 3]);
    // Score should reflect the best score for each level: 120 + 150 + 200 = 470
    assert.equal(merged.scoresByLevel[1], 120);
    assert.equal(merged.scoresByLevel[2], 150);
    assert.equal(merged.scoresByLevel[3], 200);
    assert.equal(merged.score, 470);
  } finally {
    global.localStorage = originalLocalStorage;
    global.window = originalWindow;
  }
});

test('isValidLevel strictly accepts integers 1 to 7 and rejects invalid inputs', () => {
  for (let lvl = 1; lvl <= 7; lvl += 1) {
    assert.equal(isValidLevel(lvl), true, `Level ${lvl} should be valid`);
  }
  assert.equal(isValidLevel(0), false, 'Level 0 should be invalid');
  assert.equal(isValidLevel(-1), false, 'Negative level should be invalid');
  assert.equal(isValidLevel(8), false, 'Level 8 should be invalid (max is 7)');
  assert.equal(isValidLevel(1.5), false, 'Non-integer level should be invalid');
  assert.equal(isValidLevel(NaN), false, 'NaN level should be invalid');
  assert.equal(isValidLevel(Infinity), false, 'Infinity level should be invalid');
  assert.equal(isValidLevel('1'), false, 'String level should be invalid');
  assert.equal(isValidLevel(null), false, 'null level should be invalid');
  assert.equal(isValidLevel(undefined), false, 'undefined level should be invalid');
});

module.exports = { normalizeSavedState, gameReducer };


function withStorage(run, { failWrites = false } = {}) {
  const store = {};
  const ls = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { if (failWrites) throw new Error('QuotaExceededError'); store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  };
  global.window = { localStorage: ls, addEventListener() {} };
  global.localStorage = ls;
  try {
    return run(store);
  } finally {
    delete global.window;
    delete global.localStorage;
  }
}

const ACCOUNT_1300 = {
  ...createDefaultSavedState(1000),
  completedLevels: [1, 2, 3, 4],
  scoresByLevel: { 1: 175, 2: 275, 3: 375, 4: 475 },
  score: 1300,
  attemptsByLevel: { 1: 1, 2: 1, 3: 1, 4: 1 },
  updatedAt: 1000,
};

test('F1: signing in after a guest reset keeps the account progress', () => {
  withStorage((store) => {
    store['js-quest-u1'] = JSON.stringify(ACCOUNT_1300);
    store['js-quest-guest'] = JSON.stringify({
      ...createDefaultSavedState(5000),
      completedLevels: [1],
      scoresByLevel: { 1: 175 },
      score: 175,
      attemptsByLevel: { 1: 1 },
      updatedAt: 5000,
    });
    assert.equal(migrateGuestProgress('u1'), null);
    const account = JSON.parse(store['js-quest-u1']);
    assert.equal(account.score, 1300);
    assert.deepEqual(account.completedLevels, [1, 2, 3, 4]);
    assert.equal(account.resetAt, 1000, 'the guest reset epoch must not replace the account one');
    assert.equal('js-quest-guest' in store, false);
  });
});

test('F2: unreadable guest data never overwrites the account', () => {
  withStorage((store) => {
    store['js-quest-u1'] = JSON.stringify(ACCOUNT_1300);
    store['js-quest-guest'] = '{broken';
    assert.equal(migrateGuestProgress('u1'), null);
    assert.equal(JSON.parse(store['js-quest-u1']).score, 1300);
    assert.equal('js-quest-guest' in store, false);
  });
});

test('F2: a failed write keeps both the account and the guest data for a later retry', () => {
  withStorage((store) => {
    // Seeded directly: every setItem fails in this storage.
    store['js-quest-u1'] = JSON.stringify(ACCOUNT_1300);
    store['js-quest-guest'] = JSON.stringify({ ...createDefaultSavedState(0), completedLevels: [1], scoresByLevel: { 1: 175 }, score: 175 });
    assert.match(migrateGuestProgress('u1'), /Could not migrate guest/);
    assert.equal(JSON.parse(store['js-quest-u1']).score, 1300);
    assert.equal('js-quest-guest' in store, true);
  }, { failWrites: true });
});

test('F2: a corrupted account is replaced by valid guest progress', () => {
  withStorage((store) => {
    store['js-quest-u1'] = '{broken';
    store['js-quest-guest'] = JSON.stringify({ ...createDefaultSavedState(0), completedLevels: [1], scoresByLevel: { 1: 175 }, score: 175 });
    assert.equal(migrateGuestProgress('u1'), null);
    assert.equal(JSON.parse(store['js-quest-u1']).score, 175);
  });
});

test('F3: "На головну" after Game Over only navigates, it does not wipe the progress', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'components', 'GameOverModal.tsx'), 'utf8');
  const homeButton = source.slice(source.lastIndexOf('<button', source.indexOf('На головну')), source.indexOf('На головну'));
  assert.doesNotMatch(homeButton, /resetGame\(\)/);
  assert.match(homeButton, /router\.push\('\/'\)/);
});

test('gameReducer finishAttempt(defeat) when hasDeath is already true still records completedAttemptIds and attemptEvents without double life loss', () => {
  const initialState = {
    lives: 2,
    score: 0,
    completedLevels: [],
    scoresByLevel: {},
    attemptsByLevel: { 1: 0 },
    attemptEvents: [],
    completedAttemptIds: [],
    deathsByLevel: { 1: 1 },
    deathEvents: [{ id: 'att-recovered-death', level: 1, ts: 1000 }],
    resetAt: 1000,
    updatedAt: 1000,
    storageKey: 'test-key',
    hydrated: true,
    revision: 1,
    persistedRevision: 1,
    isReset: false,
  };

  const nextState = gameReducer(initialState, {
    type: 'finishAttempt',
    storageKey: 'test-key',
    resetAt: 1000,
    level: 1,
    attemptId: 'att-recovered',
    outcome: 'defeat',
  });

  assert.equal(nextState.lives, 2, 'Must not deduct a second life');
  assert.ok(nextState.completedAttemptIds.includes('att-recovered'), 'Must record attemptId in completedAttemptIds');
  assert.equal(nextState.attemptsByLevel[1], 1, 'Must record attempt in attemptsByLevel if missing');
});


test('finishing an attempt whose start was trimmed from attemptEvents does not count it twice', () => {
  const base = {
    lives: 3,
    score: 100,
    completedLevels: [1],
    scoresByLevel: { 1: 100 },
    attemptsByLevel: {},
    attemptEvents: [],
    completedAttemptIds: [],
    deathsByLevel: {},
    deathEvents: [],
    resetAt: 1000,
    updatedAt: 1000,
    storageKey: 'test-key',
    hydrated: true,
    revision: 0,
    persistedRevision: 0,
    isReset: false,
  };
  const start = (state, attemptId) => gameReducer(state, { type: 'startAttempt', storageKey: 'test-key', resetAt: 1000, level: 2, attemptId });
  const startedAt = Date.now() - 60_000;
  // Level 2 left paused in one tab ...
  const pausedId = `test-key-att-2-${startedAt}-paused`;
  let state = start(base, pausedId);
  assert.equal(state.attemptsByLevel[2], 1);
  // ... while another tab plays a thousand more attempts: the paused start is trimmed from the list.
  for (let i = 0; i < 1000; i += 1) {
    state = start(state, `test-key-att-2-${startedAt + 1 + i}-x${i}`);
    state = gameReducer(state, { type: 'finishAttempt', storageKey: 'test-key', resetAt: 1000, level: 2, attemptId: `test-key-att-2-${startedAt + 1 + i}-x${i}`, outcome: 'defeat' });
    if (state.lives === 0) state = { ...state, lives: 3, deathEvents: [], deathsByLevel: {} };
  }
  assert.equal(state.attemptsByLevel[2], 1001);
  assert.equal(state.attemptEvents.some(e => e.id === pausedId), false, 'the paused start was trimmed');
  const finished = gameReducer(state, { type: 'finishAttempt', storageKey: 'test-key', resetAt: 1000, level: 2, attemptId: pausedId, outcome: 'victory', points: 50 });
  assert.equal(finished.attemptsByLevel[2], 1001, 'the trimmed attempt was already counted');
  assert.ok(finished.completedLevels.includes(2), 'the attempt itself still completes the level');

  // An attempt whose start was never recorded is still counted once.
  const unrecorded = gameReducer(base, { type: 'finishAttempt', storageKey: 'test-key', resetAt: 1000, level: 2, attemptId: `test-key-att-2-${Date.now()}-new`, outcome: 'defeat' });
  assert.equal(unrecorded.attemptsByLevel[2], 1);
  assert.equal(isAttemptStartCounted([], 'test-key-att-2-1-a'), false);
});

test('finishing an old attempt on page leave after 1000+ attempts takes one life, not two after reload', () => {
  const storage = {};
  const mockWindow = {
    localStorage: {
      getItem: (k) => storage[k] ?? null,
      setItem: (k, v) => { storage[k] = String(v); },
      removeItem: (k) => { delete storage[k]; },
      key: (i) => Object.keys(storage)[i] ?? null,
      get length() { return Object.keys(storage).length; },
    },
  };
  global.window = mockWindow;
  global.localStorage = mockWindow.localStorage;
  try {
    const storageKey = 'user-long-history';
    const t0 = Date.now() - 3_600_000;
    // The old attempt started first; then 1000 finished replays pushed its start out of attemptEvents.
    const oldId = `${storageKey}-att-1-${t0}-old`;
    const events = Array.from({ length: 1000 }, (_, i) => ({ id: `${storageKey}-att-1-${t0 + 1 + i}-r${i}`, level: 1, ts: t0 + 1 + i }));
    saveState(storageKey, {
      lives: 3,
      score: 100,
      completedLevels: [1],
      scoresByLevel: { 1: 100 },
      attemptsByLevel: { 1: 1001 },
      attemptEvents: events,
      completedAttemptIds: events.map(e => e.id),
      deathsByLevel: {},
      deathEvents: [],
      resetAt: 1000,
      updatedAt: t0,
    });

    const finished = executeFinishAttemptSync({ token: { attemptId: oldId, level: 1, storageKey, resetAt: 1000 }, outcome: 'defeat' }, storageKey, 1000);
    assert.equal(finished, true);
    assert.equal(JSON.parse(storage[storageKey]).lives, 2, 'the defeat takes one life');

    // Reload: no finished replay may now look abandoned.
    const reloaded = loadState(storageKey).saved;
    assert.equal(reloaded.lives, 2, 'still two lives after reload');
    assert.equal(reloaded.deathEvents.length, 1);
    assert.equal(reloaded.attemptsByLevel[1], 1001, 'the old attempt was already counted');
  } finally {
    delete global.window;
    delete global.localStorage;
  }
});

test('withCompletedAttemptId drops only ids whose start is no longer kept', () => {
  const { withCompletedAttemptId } = loadGameContextModule();
  const events = Array.from({ length: 1000 }, (_, i) => ({ id: `k-att-1-${i + 10}-e${i}`, level: 1, ts: i + 10 }));
  const completed = ['k-att-1-1-gone', ...events.slice(1).map(e => e.id)];
  const next = withCompletedAttemptId(completed, events[0].id, events);
  assert.equal(next.length, 1000);
  assert.equal(next.includes('k-att-1-1-gone'), false, 'the id without a kept start goes first');
  assert.ok(events.every(e => next.includes(e.id)), 'every kept start keeps its completion');
  assert.deepEqual(withCompletedAttemptId(['a'], 'a', []), ['a']);
});
