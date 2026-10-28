"use client";

import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useReducer,
    useState,
    type ReactNode,
} from 'react';
import { useUser } from '@clerk/nextjs';
import { TOTAL_LEVELS } from '@/utils/levelsConfig';
import { type Direction } from '@/utils/robotEngine';

export interface DeathEvent {
    id: string;
    level: number;
    ts: number;
}

export interface AttemptEvent {
    id: string;
    level: number;
    ts: number;
}

export interface AttemptToken {
    attemptId: string;
    level: number;
    storageKey: string;
    resetAt: number;
}

/**
 * Outcome of an attempt that the sandbox has already decided while the robot is still
 * being animated. Recorded instead of a defeat if the player resets or leaves mid-animation.
 */
export interface AttemptVerdict {
    outcome: 'victory' | 'defeat';
    points?: number;
    finalPos?: { x: number; y: number; dir: Direction };
}

interface GameContextValue {
    lives: number;
    score: number;
    resetAt: number;
    storageKey: string;
    isGameOver: boolean;
    completedLevels: number[];
    attemptsByLevel: Record<number, number>;
    deathsByLevel: Record<number, number>;
    startAttempt: (level: number) => AttemptToken | null;
    finishAttempt: (params: {
        token: AttemptToken;
        outcome: 'victory' | 'defeat' | 'cancelled';
        points?: number;
    }) => boolean;
    finishAttemptSync: (params: {
        token: AttemptToken;
        outcome: 'victory' | 'defeat' | 'cancelled';
        points?: number;
    }) => boolean;
    recordAttempt: (level: number) => number;
    getAttempts: (level: number) => number;
    loseLife: (level?: number) => void;
    /** Completes a level and awards its points once, as one atomic update. */
    completeLevel: (level: number, points: number) => void;
    resetGame: () => void;
    isLevelUnlocked: (level: number) => boolean;
    isHydrated: boolean;
    /** A non-fatal localStorage error. Game play can continue in memory. */
    storageError: string | null;
    /** Saved progress was invalid and had to be repaired or reset; storage itself works. */
    storageNotice: string | null;
}

const GameContext = createContext<GameContextValue | null>(null);

export const DEFAULT_LIVES = 3;

export interface SavedState {
    lives: number;
    score: number;
    completedLevels: number[];
    scoresByLevel?: Record<number, number>;
    attemptsByLevel?: Record<number, number>;
    attemptEvents?: AttemptEvent[];
    completedAttemptIds?: string[];
    deathsByLevel?: Record<number, number>;
    deathEvents?: DeathEvent[];
    resetAt?: number;
    updatedAt?: number;
}

interface StoreState extends SavedState {
    storageKey: string | null;
    hydrated: boolean;
    revision: number;
    persistedRevision: number;
    isReset: boolean;
    scoresByLevel: Record<number, number>;
    attemptsByLevel: Record<number, number>;
    attemptEvents: AttemptEvent[];
    completedAttemptIds: string[];
    deathsByLevel: Record<number, number>;
    deathEvents: DeathEvent[];
    resetAt: number;
    updatedAt: number;
}

type StoreAction =
    | { type: 'hydrate'; storageKey: string; saved: SavedState }
    | { type: 'syncFromStorage'; storageKey: string; saved: SavedState }
    | { type: 'startAttempt'; storageKey: string; resetAt: number; level: number; attemptId: string }
    | { type: 'finishAttempt'; storageKey: string; resetAt: number; level: number; attemptId: string; outcome: 'victory' | 'defeat' | 'cancelled'; points?: number }
    | { type: 'recordAttempt'; storageKey: string; level: number }
    | { type: 'loseLife'; storageKey: string; level?: number }
    | { type: 'completeLevel'; storageKey: string; level: number; points: number }
    | { type: 'reset'; storageKey: string; resetAt: number }
    | { type: 'persisted'; storageKey: string; revision: number; saved: SavedState };

export interface LoadResult {
    saved: SavedState;
    error: string | null;
    isEmpty?: boolean;
    /** localStorage itself failed; without it `error` only says the saved data was repaired. */
    failed?: boolean;
}

export function createDefaultSavedState(resetAt = 0): SavedState {
    return {
        lives: DEFAULT_LIVES,
        score: 0,
        completedLevels: [],
        scoresByLevel: {},
        attemptsByLevel: {},
        attemptEvents: [],
        completedAttemptIds: [],
        deathsByLevel: {},
        deathEvents: [],
        resetAt,
        updatedAt: resetAt,
    };
}

export function getStorageKey(userId: string | null): string {
    return userId ? `js-quest-${userId}` : 'js-quest-guest';
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export const ACTIVE_ATTEMPT_PREFIX = 'js-quest-active-attempt-';
export const ACTIVE_HEARTBEAT_TTL_MS = 120_000;

const localActiveAttempts = new Set<string>();
let heartbeatIntervalId: ReturnType<typeof setInterval> | null = null;

function touchLocalActiveAttempts(): void {
    if (typeof window === 'undefined' || typeof localStorage === 'undefined') return;
    const now = Date.now();
    try {
        for (const id of localActiveAttempts) {
            localStorage.setItem(`${ACTIVE_ATTEMPT_PREFIX}${id}`, String(now));
        }
    } catch {
        // Ignore localStorage quota or access errors
    }
}

function ensureHeartbeatLoop(): void {
    if (typeof window === 'undefined') return;
    if (heartbeatIntervalId !== null) return;
    if (localActiveAttempts.size === 0) return;

    heartbeatIntervalId = setInterval(() => {
        if (localActiveAttempts.size === 0) {
            if (heartbeatIntervalId !== null) {
                clearInterval(heartbeatIntervalId);
                heartbeatIntervalId = null;
            }
            return;
        }
        touchLocalActiveAttempts();
    }, 2000);
}

if (typeof window !== 'undefined') {
    window.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
            touchLocalActiveAttempts();
        }
    });
    window.addEventListener('focus', touchLocalActiveAttempts);
}

export function registerActiveAttempt(attemptId: string): void {
    if (!attemptId) return;
    localActiveAttempts.add(attemptId);
    if (typeof window !== 'undefined' && typeof localStorage !== 'undefined') {
        try {
            localStorage.setItem(`${ACTIVE_ATTEMPT_PREFIX}${attemptId}`, String(Date.now()));
        } catch {
            // Ignore storage errors
        }
        ensureHeartbeatLoop();
    }
}

export function unregisterActiveAttempt(attemptId: string): void {
    if (!attemptId) return;
    localActiveAttempts.delete(attemptId);
    if (typeof window !== 'undefined' && typeof localStorage !== 'undefined') {
        try {
            localStorage.removeItem(`${ACTIVE_ATTEMPT_PREFIX}${attemptId}`);
        } catch {
            // Ignore storage errors
        }
    }
    if (localActiveAttempts.size === 0 && heartbeatIntervalId !== null) {
        clearInterval(heartbeatIntervalId);
        heartbeatIntervalId = null;
    }
}

export function unregisterAllLocalActiveAttempts(): void {
    const ids = Array.from(localActiveAttempts);
    for (const id of ids) {
        unregisterActiveAttempt(id);
    }
}

export function isAttemptActiveInBrowser(attemptId: string): boolean {
    if (!attemptId) return false;
    if (localActiveAttempts.has(attemptId)) return true;

    if (typeof window !== 'undefined' && typeof localStorage !== 'undefined') {
        try {
            const raw = localStorage.getItem(`${ACTIVE_ATTEMPT_PREFIX}${attemptId}`);
            if (!raw) return false;
            const ts = Number(raw);
            if (!Number.isSafeInteger(ts) || ts <= 0) return false;
            return (Date.now() - ts) < ACTIVE_HEARTBEAT_TTL_MS;
        } catch {
            return false;
        }
    }
    return false;
}

/** Only the newest attempt starts are kept in attemptEvents (see mergeSavedStates). */
const MAX_ATTEMPT_EVENTS = 1000;

/** When an attempt started, read from its id (`<storageKey>-att-<level>-<ms>-<random>`). */
function attemptStartTime(attemptId: string): number | null {
    const match = /-att-\d+-(\d+)-[a-z0-9]*$/.exec(attemptId);
    return match ? Number(match[1]) : null;
}

/**
 * Whether the start of this attempt is already counted in attemptsByLevel. The event list keeps only
 * the newest MAX_ATTEMPT_EVENTS starts, so an attempt older than all of them (say, left paused while
 * another tab played a thousand more) was counted and then trimmed, not never counted: finishing it
 * must not count it again. mergeSavedStates treats trimmed events the same way.
 */
export function isAttemptStartCounted(events: readonly AttemptEvent[], attemptId: string): boolean {
    if (events.some(e => e.id === attemptId)) return true;
    if (events.length < MAX_ATTEMPT_EVENTS) return false;
    const startedAt = attemptStartTime(attemptId);
    if (startedAt === null) return false;
    return startedAt <= Math.min(...events.map(e => e.ts || 0));
}

/**
 * completedAttemptIds with one more finished attempt, still bounded. Reloading treats an attempt
 * that is in attemptEvents but not in completedAttemptIds as abandoned and takes a life for it, so
 * when the list is full the ids dropped first are those whose start is no longer in attemptEvents
 * (nothing can mistake them for abandoned attempts), oldest first, never one that still is.
 */
export function withCompletedAttemptId(
    completedIds: readonly string[],
    attemptId: string,
    attemptEvents: readonly AttemptEvent[],
): string[] {
    const ids = completedIds.includes(attemptId) ? [...completedIds] : [...completedIds, attemptId];
    let excess = ids.length - MAX_ATTEMPT_EVENTS;
    if (excess <= 0) return ids;
    const kept = new Set(attemptEvents.map(e => e.id));
    const result: string[] = [];
    for (const id of ids) {
        if (excess > 0 && !kept.has(id)) {
            excess -= 1;
            continue;
        }
        result.push(id);
    }
    return excess > 0 ? result.slice(excess) : result;
}

function calculateLivesFromEvents(deathEvents: DeathEvent[], directLives?: number): number {
    const fromEvents = Math.max(0, DEFAULT_LIVES - deathEvents.length);
    if (directLives !== undefined && Number.isSafeInteger(directLives) && directLives >= 0 && directLives <= DEFAULT_LIVES) {
        return Math.min(fromEvents, directLives);
    }
    return fromEvents;
}

interface BonusAllocationSolution {
    eff: number[];
    ft: number[];
    usedPool: number;
}

function solveBonusDistribution(
    levels: number[],
    bonusPool: number,
    attemptsByLevel: Record<number, number>,
    existingBonuses: Record<number, number> = {},
    deathsByLevel: Record<number, number> = {}
): BonusAllocationSolution | null {
    const n = levels.length;
    if (n === 0 || bonusPool <= 0) return null;

    let bestSolution: BonusAllocationSolution | null = null;
    let bestScore = -Infinity;

    function search(idx: number, currentEff: number[], currentFt: number[], usedPool: number) {
        if (idx === n) {
            let score = usedPool * 1000000;
            const bonuses: number[] = [];
            for (let i = 0; i < n; i++) {
                bonuses.push(currentEff[i] + currentFt[i]);
            }

            const ftCount = currentFt.filter(f => f === 25).length;

            for (let i = 0; i < n; i++) {
                const lvl = levels[i];
                const att = attemptsByLevel[lvl] || 0;
                const d = deathsByLevel[lvl] || 0;
                const b = bonuses[i];
                // If a completed level was finished in 1 attempt and has 0 deaths, FIRST_TRY_BONUS (25) was earned!
                if (att === 1 && d === 0) {
                    if (currentFt[i] === 25) {
                        score += 100000;
                    } else {
                        score -= 100000;
                    }
                }
                // When multiple levels earn first-try bonuses (e.g. score 400),
                // earlier levels (like Level 1) naturally achieve efficiency bonuses (optimal steps)
                // before later levels do.
                if (ftCount >= 2) {
                    score += currentEff[i] * (TOTAL_LEVELS - lvl + 1) * 100;
                }

                // Deaths on a level make a first-try win less likely, but they may all come from replays
                // after the win, so this stays weaker than the single-attempt fact above.
                if (d > 0) {
                    score -= currentEff[i] * 500;
                    score -= currentFt[i] * 2000;
                }

                // Strongly penalize leaving a level without deaths with 0 bonus if another level receives >= 50 bonus
                if (b === 0 && d === 0 && bonuses.some(x => x >= 50)) {
                    score -= 50000;
                } else if (b === 0 && d === 0) {
                    score -= 5000;
                }

                // Prefer higher levels having >= bonuses when tied and neither died
                if (d === 0) {
                    score += b * lvl * 10;
                }
            }
            if (score > bestScore) {
                bestScore = score;
                bestSolution = { eff: [...currentEff], ft: [...currentFt], usedPool };
            }
            return;
        }

        const lvl = levels[idx];
        // A first-try win is never ruled out: extra attempts and deaths may all be replays made
        // after the level was already won ("Пройти знову"). Deaths only lower its likelihood (soft penalty above).
        const baseExisting = existingBonuses[lvl] || 0;

        const effOptions = [50, 0];
        const ftOptions = [25, 0];

        for (const eff of effOptions) {
            for (const ft of ftOptions) {
                const targetBonus = eff + ft;
                if (targetBonus >= baseExisting) {
                    const cost = targetBonus - baseExisting;
                    if (usedPool + cost <= bonusPool) {
                        currentEff[idx] = eff;
                        currentFt[idx] = ft;
                        search(idx + 1, currentEff, currentFt, usedPool + cost);
                    }
                }
            }
        }
    }

    search(0, new Array(n).fill(0), new Array(n).fill(0), 0);
    return bestSolution;
}

export function normalizeSavedState(value: unknown): LoadResult {
    if (!isRecord(value)) {
        return {
            saved: createDefaultSavedState(0),
            error: 'Saved progress had an invalid format and was reset.',
            isEmpty: true,
        };
    }

    const resetAt = Number.isSafeInteger(value.resetAt) && (value.resetAt as number) > 0
        ? (value.resetAt as number)
        : 0;
    const updatedAt = Number.isSafeInteger(value.updatedAt) && (value.updatedAt as number) > 0
        ? (value.updatedAt as number)
        : resetAt;

    // Parse and strictly validate death events (deduplicate & cap max count)
    const deathEvents: DeathEvent[] = [];
    const seenDeathIds = new Set<string>();
    if (Array.isArray(value.deathEvents)) {
        for (const item of value.deathEvents) {
            if (
                isRecord(item) &&
                typeof item.id === 'string' &&
                item.id.length > 0 &&
                item.id.length <= 100 &&
                !seenDeathIds.has(item.id) &&
                Number.isSafeInteger(item.level) &&
                (item.level as number) >= 1 &&
                (item.level as number) <= TOTAL_LEVELS
            ) {
                seenDeathIds.add(item.id);
                deathEvents.push({
                    id: item.id,
                    level: item.level as number,
                    ts: Number.isSafeInteger(item.ts) ? (item.ts as number) : 0,
                });
                if (deathEvents.length >= DEFAULT_LIVES * 10) break;
            }
        }
    }

    // Backwards compatibility: if deathEvents is empty but deathsByLevel exists (capped to DEFAULT_LIVES)
    const rawDeaths = isRecord(value.deathsByLevel) ? value.deathsByLevel : {};
    const deathsByLevel: Record<number, number> = {};
    for (const [k, v] of Object.entries(rawDeaths)) {
        const lvl = Number(k);
        if (Number.isSafeInteger(lvl) && lvl >= 1 && lvl <= TOTAL_LEVELS && Number.isSafeInteger(v) && (v as number) >= 0) {
            deathsByLevel[lvl] = Math.min(v as number, DEFAULT_LIVES);
        }
    }

    // Ensure deathEvents accounts for any legacy deathsByLevel counts per level
    for (let l = 1; l <= TOTAL_LEVELS; l += 1) {
        const legacyCount = Math.min(deathsByLevel[l] || 0, DEFAULT_LIVES);
        const existingCount = deathEvents.filter(e => e.level === l).length;
        for (let i = existingCount; i < legacyCount; i++) {
            if (deathEvents.length < DEFAULT_LIVES) {
                deathEvents.push({ id: `legacy-${l}-${i}`, level: l, ts: resetAt });
            }
        }
    }

    // Backwards compatibility: if total deathEvents is less than lost lives from raw lives
    const hasValidRawLives = Number.isSafeInteger(value.lives) && (value.lives as number) >= 0 && (value.lives as number) <= DEFAULT_LIVES;
    if (hasValidRawLives) {
        const rawLives = value.lives as number;
        if (rawLives < DEFAULT_LIVES) {
            const lost = DEFAULT_LIVES - rawLives;
            while (deathEvents.length < lost) {
                deathEvents.push({ id: `legacy-lives-${deathEvents.length}`, level: 1, ts: resetAt });
            }
        }
    }

    // Ensure deathsByLevel reflects all recorded deathEvents
    for (let l = 1; l <= TOTAL_LEVELS; l += 1) {
        const count = deathEvents.filter(d => d.level === l).length;
        if (count > (deathsByLevel[l] || 0)) {
            deathsByLevel[l] = count;
        }
    }

    // Parse and strictly validate attempt events
    const attemptEvents: AttemptEvent[] = [];
    const seenAttemptIds = new Set<string>();
    if (Array.isArray(value.attemptEvents)) {
        for (const item of value.attemptEvents) {
            if (
                isRecord(item) &&
                typeof item.id === 'string' &&
                item.id.length > 0 &&
                item.id.length <= 100 &&
                !seenAttemptIds.has(item.id) &&
                Number.isSafeInteger(item.level) &&
                (item.level as number) >= 1 &&
                (item.level as number) <= TOTAL_LEVELS
            ) {
                seenAttemptIds.add(item.id);
                attemptEvents.push({
                    id: item.id,
                    level: item.level as number,
                    ts: Number.isSafeInteger(item.ts) ? (item.ts as number) : 0,
                });
            }
        }
    }

    const sanitizedAttemptEvents = attemptEvents.length > 1000
        ? attemptEvents.slice(-1000)
        : attemptEvents;

    // Parse legacy attemptsByLevel without loss
    const rawAttempts = isRecord(value.attemptsByLevel) ? value.attemptsByLevel : {};
    const attemptsByLevel: Record<number, number> = {};
    for (const [k, v] of Object.entries(rawAttempts)) {
        const lvl = Number(k);
        if (Number.isSafeInteger(lvl) && lvl >= 1 && lvl <= TOTAL_LEVELS && Number.isSafeInteger(v) && (v as number) >= 0) {
            attemptsByLevel[lvl] = v as number;
        }
    }

    for (const e of sanitizedAttemptEvents) {
        attemptsByLevel[e.level] = Math.max(attemptsByLevel[e.level] || 0, 1);
    }
    for (let l = 1; l <= TOTAL_LEVELS; l += 1) {
        const count = sanitizedAttemptEvents.filter(e => e.level === l).length;
        if (count > (attemptsByLevel[l] || 0)) {
            attemptsByLevel[l] = count;
        }
    }

    // Parse scoresByLevel
    const rawScores = isRecord(value.scoresByLevel) ? value.scoresByLevel : {};
    const scoresByLevel: Record<number, number> = {};
    for (const [k, v] of Object.entries(rawScores)) {
        const lvl = Number(k);
        if (Number.isSafeInteger(lvl) && lvl >= 1 && lvl <= TOTAL_LEVELS && Number.isSafeInteger(v) && (v as number) >= 0) {
            scoresByLevel[lvl] = v as number;
        }
    }

    // Parse completedLevels
    const rawLevels = value.completedLevels;
    const validLevelValues = Array.isArray(rawLevels)
        ? rawLevels.filter((level): level is number => (
            Number.isSafeInteger(level) && level >= 1 && level <= TOTAL_LEVELS
        ))
        : [];
    const scoredLevels = Object.entries(scoresByLevel)
        .filter(([_, s]) => s > 0)
        .map(([l]) => Number(l))
        .filter(isValidLevel);
    const completedLevels = [...new Set([...validLevelValues, ...scoredLevels])].sort((a, b) => a - b);
    const validLevels = Array.isArray(rawLevels)
        && validLevelValues.length === rawLevels.length
        && completedLevels.length === rawLevels.length;

    // Completed levels without tracked attempts must have at least 1 attempt
    for (const lvl of completedLevels) {
        if (!attemptsByLevel[lvl] || attemptsByLevel[lvl] < 1) {
            attemptsByLevel[lvl] = 1;
        }
    }

    const completedAttemptIds: string[] = [];
    if (Array.isArray(value.completedAttemptIds)) {
        for (const id of value.completedAttemptIds) {
            if (typeof id === 'string' && id.length > 0 && id.length <= 100) {
                completedAttemptIds.push(id);
            }
        }
    }

    // Recover any abandoned / incomplete attempts (e.g. from browser reload F5 or crash)
    // Only applies if the state format explicitly tracks completedAttemptIds
    const hasExplicitCompletedAttemptIds = Array.isArray(value.completedAttemptIds);
    if (hasExplicitCompletedAttemptIds) {
        const rawLives = hasValidRawLives ? (value.lives as number) : DEFAULT_LIVES;
        const rawLostLives = Math.max(0, DEFAULT_LIVES - rawLives);
        let extraDeathsAllowed = Math.max(0, DEFAULT_LIVES - Math.max(deathEvents.length, rawLostLives));

        // Calculate unaccounted attempts per level:
        // attempts on this level that are not yet accounted for by known victories or recorded deaths
        const unaccountedAttemptsByLevel: Record<number, number> = {};
        for (let l = 1; l <= TOTAL_LEVELS; l++) {
            const total = attemptsByLevel[l] || 0;
            const completedVictoryAttempts = sanitizedAttemptEvents.filter(
                e => e.level === l && completedAttemptIds.includes(e.id) && !deathEvents.some(d => d.id === `${e.id}-death`)
            ).length;
            const victories = Math.max(completedVictoryAttempts, completedLevels.includes(l) ? 1 : 0);
            const deaths = deathEvents.filter(d => d.level === l).length;
            unaccountedAttemptsByLevel[l] = Math.max(0, total - (victories + deaths));
        }

        for (const att of sanitizedAttemptEvents) {
            if (!completedAttemptIds.includes(att.id)) {
                // If the attempt is active in an open browser tab, do not treat as dead (even on long pause)
                if (isAttemptActiveInBrowser(att.id)) {
                    continue;
                }
                // Short grace period for freshly started attempts in the current session
                if (Date.now() - (att.ts || 0) < 30_000) {
                    continue;
                }
                const deathId = `${att.id}-death`;
                const alreadyHasDeath = deathEvents.some(d => d.id === deathId);
                if (alreadyHasDeath) {
                    completedAttemptIds.push(att.id);
                } else if ((unaccountedAttemptsByLevel[att.level] || 0) > 0 && extraDeathsAllowed > 0 && deathEvents.length < DEFAULT_LIVES) {
                    deathEvents.push({ id: deathId, level: att.level, ts: att.ts });
                    deathsByLevel[att.level] = (deathsByLevel[att.level] || 0) + 1;
                    extraDeathsAllowed--;
                    unaccountedAttemptsByLevel[att.level]--;
                    completedAttemptIds.push(att.id);
                } else {
                    completedAttemptIds.push(att.id);
                }
            }
        }
    }

    // Ensure all surviving attempt events that were completed retain their completedAttemptIds
    const completedSet = new Set(completedAttemptIds);
    const sanitizedAttemptIds = new Set(sanitizedAttemptEvents.map(e => e.id));
    const sanitizedCompletedAttemptIds: string[] = [];
    for (const att of sanitizedAttemptEvents) {
        if (completedSet.has(att.id)) {
            sanitizedCompletedAttemptIds.push(att.id);
        }
    }
    for (const id of completedSet) {
        if (!sanitizedAttemptIds.has(id) && sanitizedCompletedAttemptIds.length < 1000) {
            sanitizedCompletedAttemptIds.push(id);
        }
    }

    const validDirectLives = hasValidRawLives ? (value.lives as number) : undefined;
    const lives = calculateLivesFromEvents(deathEvents, validDirectLives);
    const rawScore = Number.isSafeInteger(value.score) && (value.score as number) >= 0
        ? Math.min(Number.MAX_SAFE_INTEGER, value.score as number)
        : 0;

    // Allocate score to completed levels that are missing scoresByLevel (legacy saves)
    let currentSum = 0;
    for (const lvl of completedLevels) {
        currentSum += scoresByLevel[lvl] || 0;
    }

    const targetScore = Math.max(rawScore, currentSum);

    if (completedLevels.length > 0 && targetScore > currentSum) {
        const remainingDelta = targetScore - currentSum;
        const missingLevels = completedLevels.filter(l => !scoresByLevel[l] || scoresByLevel[l] === 0);

        if (missingLevels.length > 0) {
            let sumBase = 0;
            for (const lvl of missingLevels) {
                sumBase += lvl * 100;
            }

            if (remainingDelta <= sumBase) {
                const weights = missingLevels.map(l => l * 100);
                let allocated = 0;
                for (let i = 0; i < missingLevels.length; i++) {
                    const lvl = missingLevels[i];
                    if (i === missingLevels.length - 1) {
                        const portion = Math.max(0, remainingDelta - allocated);
                        scoresByLevel[lvl] = (scoresByLevel[lvl] || 0) + portion;
                    } else {
                        const remainingToAllocate = remainingDelta - allocated;
                        const remainingWeight = weights.slice(i).reduce((a, b) => a + b, 0);
                        const portion = remainingWeight > 0
                            ? Math.min(remainingToAllocate, Math.floor((remainingToAllocate * weights[i]) / remainingWeight))
                            : 0;
                        scoresByLevel[lvl] = (scoresByLevel[lvl] || 0) + portion;
                        allocated += portion;
                    }
                }
            } else {
                for (const lvl of missingLevels) {
                    scoresByLevel[lvl] = (scoresByLevel[lvl] || 0) + (lvl * 100);
                }
                let bonusPool = remainingDelta - sumBase;
                const solution = solveBonusDistribution(missingLevels, bonusPool, attemptsByLevel, {}, deathsByLevel);
                if (solution) {
                    for (let i = 0; i < missingLevels.length; i++) {
                        const lvl = missingLevels[i];
                        const bonus = solution.eff[i] + solution.ft[i];
                        scoresByLevel[lvl] = (scoresByLevel[lvl] || 0) + bonus;
                    }
                    bonusPool -= solution.usedPool;
                }

                if (bonusPool > 0) {
                    const sortedDesc = [...missingLevels].sort((a, b) => b - a);
                    for (const lvl of sortedDesc) {
                        if (bonusPool <= 0) break;
                        const cap = lvl * 100 + 75;
                        const headroom = Math.max(0, cap - (scoresByLevel[lvl] || 0));
                        if (headroom > 0) {
                            const add = Math.min(bonusPool, headroom);
                            scoresByLevel[lvl] = (scoresByLevel[lvl] || 0) + add;
                            bonusPool -= add;
                        }
                    }
                }

                if (bonusPool > 0) {
                    const sortedDesc = [...missingLevels].sort((a, b) => b - a);
                    const highest = sortedDesc[0];
                    scoresByLevel[highest] = (scoresByLevel[highest] || 0) + bonusPool;
                }
            }
        } else {
            let bonusPool = remainingDelta;
            const existingBonuses: Record<number, number> = {};
            for (const lvl of completedLevels) {
                existingBonuses[lvl] = Math.max(0, (scoresByLevel[lvl] || 0) - lvl * 100);
            }
            const solution = solveBonusDistribution(completedLevels, bonusPool, attemptsByLevel, existingBonuses, deathsByLevel);
            if (solution) {
                for (let i = 0; i < completedLevels.length; i++) {
                    const lvl = completedLevels[i];
                    const targetBonus = solution.eff[i] + solution.ft[i];
                    const existing = existingBonuses[lvl] || 0;
                    if (targetBonus > existing) {
                        const add = targetBonus - existing;
                        scoresByLevel[lvl] = (scoresByLevel[lvl] || 0) + add;
                    }
                }
                bonusPool -= solution.usedPool;
            }
            if (bonusPool > 0) {
                const sortedDesc = [...completedLevels].sort((a, b) => b - a);
                for (const lvl of sortedDesc) {
                    if (bonusPool <= 0) break;
                    const cap = lvl * 100 + 75;
                    const headroom = Math.max(0, cap - (scoresByLevel[lvl] || 0));
                    if (headroom > 0) {
                        const toAdd = Math.min(bonusPool, headroom);
                        scoresByLevel[lvl] = (scoresByLevel[lvl] || 0) + toAdd;
                        bonusPool -= toAdd;
                    }
                }
            }
            if (bonusPool > 0) {
                const sortedDesc = [...completedLevels].sort((a, b) => b - a);
                const highest = sortedDesc[0];
                scoresByLevel[highest] = (scoresByLevel[highest] || 0) + bonusPool;
            }
        }
    }

    const computedScoreFromLevels = Object.values(scoresByLevel).reduce((a, b) => a + b, 0);
    const validScore = Math.max(targetScore, computedScoreFromLevels);

    const wasSanitized = !hasValidRawLives || !Number.isSafeInteger(value.score) || (value.score as number) < 0 || !validLevels;

    return {
        saved: {
            lives,
            score: validScore,
            completedLevels,
            scoresByLevel,
            attemptsByLevel,
            attemptEvents: sanitizedAttemptEvents,
            completedAttemptIds: sanitizedCompletedAttemptIds,
            deathsByLevel,
            deathEvents,
            resetAt,
            updatedAt,
        },
        error: wasSanitized ? 'Saved progress contained invalid values and was safely normalized.' : null,
    };
}

export function storageFailure(operation: string, error: unknown): string {
    const details = error instanceof Error && error.message ? ` ${error.message}` : '';
    return `Could not ${operation} progress in local storage.${details}`;
}

export function loadState(storageKey: string): LoadResult {
    if (typeof window === 'undefined') {
        return { saved: createDefaultSavedState(0), error: null, isEmpty: true };
    }

    try {
        const raw = localStorage.getItem(storageKey);
        if (!raw) return { saved: createDefaultSavedState(0), error: null, isEmpty: true };
        return normalizeSavedState(JSON.parse(raw) as unknown);
    } catch (error) {
        return {
            saved: createDefaultSavedState(0),
            error: storageFailure('load', error),
            isEmpty: true,
            failed: true,
        };
    }
}

export function mergeSavedStates(rawBase: SavedState, rawIncoming: SavedState): SavedState {
    const base = normalizeSavedState(rawBase).saved;
    const incoming = normalizeSavedState(rawIncoming).saved;

    const baseReset = base.resetAt || 0;
    const incReset = incoming.resetAt || 0;

    // A more recent reset epoch completely supersedes older progress
    if (incReset > baseReset && incReset > 0) {
        return incoming;
    }
    if (baseReset > incReset && baseReset > 0) {
        return base;
    }

    const mergedLevels = [...new Set([...base.completedLevels, ...incoming.completedLevels])].sort((a, b) => a - b);

    // Merge scoresByLevel: preserve max points achieved for each level (Pointwise Maxima join-semilattice)
    const baseScores = base.scoresByLevel || {};
    const incScores = incoming.scoresByLevel || {};
    const mergedScoresByLevel: Record<number, number> = {};
    for (const l of mergedLevels) {
        const s1 = baseScores[l] || 0;
        const s2 = incScores[l] || 0;
        if (s1 > 0 || s2 > 0) {
            mergedScoresByLevel[l] = Math.max(s1, s2);
        }
    }

    const sumOfMergedScores = Object.values(mergedScoresByLevel).reduce((a, b) => a + b, 0);

    const mergedScore = mergedLevels.length > 0
        ? sumOfMergedScores
        : Math.min(Number.MAX_SAFE_INTEGER, Math.max(base.score, incoming.score));

    const baseEvents = base.attemptEvents || [];
    const incEvents = incoming.attemptEvents || [];

    const baseIds = new Set(baseEvents.map(e => e.id));
    const incIds = new Set(incEvents.map(e => e.id));

    const baseAttempts = base.attemptsByLevel || {};
    const incAttempts = incoming.attemptsByLevel || {};

    const baseGlobalMinTs = baseEvents.length >= MAX_ATTEMPT_EVENTS && baseEvents.length > 0
        ? Math.min(...baseEvents.map(e => e.ts || 0))
        : undefined;
    const incGlobalMinTs = incEvents.length >= MAX_ATTEMPT_EVENTS && incEvents.length > 0
        ? Math.min(...incEvents.map(e => e.ts || 0))
        : undefined;

    const baseMinTsByLevel: Record<number, number> = {};
    const incMinTsByLevel: Record<number, number> = {};

    for (let l = 1; l <= TOTAL_LEVELS; l++) {
        const bLvlEvents = baseEvents.filter(e => e.level === l);
        const bCount = baseAttempts[l] || 0;
        if (baseGlobalMinTs !== undefined && bCount > bLvlEvents.length) {
            baseMinTsByLevel[l] = baseGlobalMinTs;
        }

        const iLvlEvents = incEvents.filter(e => e.level === l);
        const iCount = incAttempts[l] || 0;
        if (incGlobalMinTs !== undefined && iCount > iLvlEvents.length) {
            incMinTsByLevel[l] = incGlobalMinTs;
        }
    }

    // Merge attemptsByLevel preserving all legacy counts + new attempt events
    const mergedAttempts: Record<number, number> = {};
    for (let l = 1; l <= TOTAL_LEVELS; l += 1) {
        const bCount = baseAttempts[l] || 0;
        const iCount = incAttempts[l] || 0;

        const newFromInc = incEvents.filter(e => {
            if (e.level !== l || baseIds.has(e.id)) return false;
            if (baseMinTsByLevel[l] !== undefined && (e.ts || 0) <= baseMinTsByLevel[l]) {
                return false; // Trimmed by base, already counted in bCount
            }
            return true;
        });

        const newFromBase = baseEvents.filter(e => {
            if (e.level !== l || incIds.has(e.id)) return false;
            if (incMinTsByLevel[l] !== undefined && (e.ts || 0) <= incMinTsByLevel[l]) {
                return false; // Trimmed by incoming, already counted in iCount
            }
            return true;
        });

        const countFromBase = bCount + newFromInc.length;
        const countFromInc = iCount + newFromBase.length;
        const total = Math.max(countFromBase, countFromInc);
        if (total > 0) mergedAttempts[l] = total;
    }

    // Merge unique attempt events (Grow-Only Set union, bounded to MAX_ATTEMPT_EVENTS)
    const attemptEventMap = new Map<string, AttemptEvent>();
    for (const e of baseEvents) {
        if (e && typeof e.id === 'string' && e.id) attemptEventMap.set(e.id, e);
    }
    for (const e of incEvents) {
        if (e && typeof e.id === 'string' && e.id) attemptEventMap.set(e.id, e);
    }

    let mergedAttemptEvents = Array.from(attemptEventMap.values());
    mergedAttemptEvents.sort((a, b) => (a.ts || 0) - (b.ts || 0));
    if (mergedAttemptEvents.length > MAX_ATTEMPT_EVENTS) {
        mergedAttemptEvents = mergedAttemptEvents.slice(-MAX_ATTEMPT_EVENTS);
    }

    // Ensure all surviving attempt events that were completed retain their completedAttemptIds
    const survivingAttemptIds = new Set(mergedAttemptEvents.map(e => e.id));
    const allCompletedIds = new Set([...(base.completedAttemptIds || []), ...(incoming.completedAttemptIds || [])]);
    const mergedCompletedAttemptIds: string[] = [];
    for (const e of mergedAttemptEvents) {
        if (allCompletedIds.has(e.id)) {
            mergedCompletedAttemptIds.push(e.id);
        }
    }
    for (const id of allCompletedIds) {
        if (!survivingAttemptIds.has(id) && mergedCompletedAttemptIds.length < MAX_ATTEMPT_EVENTS) {
            mergedCompletedAttemptIds.push(id);
        }
    }

    // Identify victory attempts across base and incoming (completed with no defeat death in that state)
    const baseVictoryAttempts = new Set<string>();
    for (const id of base.completedAttemptIds || []) {
        if (!base.deathEvents?.some(d => d.id === `${id}-death`)) {
            const att = baseEvents.find(e => e.id === id);
            if (att && !base.completedLevels?.includes(att.level)) {
                continue;
            }
            baseVictoryAttempts.add(id);
        }
    }
    const incVictoryAttempts = new Set<string>();
    for (const id of incoming.completedAttemptIds || []) {
        if (!incoming.deathEvents?.some(d => d.id === `${id}-death`)) {
            const att = incEvents.find(e => e.id === id);
            if (att && !incoming.completedLevels?.includes(att.level)) {
                continue;
            }
            incVictoryAttempts.add(id);
        }
    }
    const allVictoryAttemptIds = new Set([...baseVictoryAttempts, ...incVictoryAttempts]);

    // Merge unique death events (Grow-Only Set union, ignoring phantom crash-recovery deaths for victories)
    const deathEventMap = new Map<string, DeathEvent>();
    for (const e of base.deathEvents || []) {
        if (e && typeof e.id === 'string' && e.id) {
            const match = e.id.match(/^(.+)-death$/);
            if (match && incVictoryAttempts.has(match[1]) && !baseVictoryAttempts.has(match[1])) {
                continue; // Discard phantom crash-recovery death for an attempt completed as victory in incoming
            }
            deathEventMap.set(e.id, e);
        }
    }
    for (const e of incoming.deathEvents || []) {
        if (e && typeof e.id === 'string' && e.id) {
            const match = e.id.match(/^(.+)-death$/);
            if (match && baseVictoryAttempts.has(match[1]) && !incVictoryAttempts.has(match[1])) {
                continue; // Discard phantom crash-recovery death for an attempt completed as victory in base
            }
            deathEventMap.set(e.id, e);
        }
    }

    // Also handle legacy deathsByLevel (capped to DEFAULT_LIVES), ignoring phantom crash-recovery deaths
    const basePhantomDeathsByLevel: Record<number, number> = {};
    for (const d of base.deathEvents || []) {
        const match = d.id.match(/^(.+)-death$/);
        if (match && allVictoryAttemptIds.has(match[1])) {
            basePhantomDeathsByLevel[d.level] = (basePhantomDeathsByLevel[d.level] || 0) + 1;
        }
    }
    const incPhantomDeathsByLevel: Record<number, number> = {};
    for (const d of incoming.deathEvents || []) {
        const match = d.id.match(/^(.+)-death$/);
        if (match && allVictoryAttemptIds.has(match[1])) {
            incPhantomDeathsByLevel[d.level] = (incPhantomDeathsByLevel[d.level] || 0) + 1;
        }
    }

    const baseDeaths = base.deathsByLevel || {};
    const incDeaths = incoming.deathsByLevel || {};
    for (let l = 1; l <= TOTAL_LEVELS; l += 1) {
        const effBase = Math.max(0, (baseDeaths[l] || 0) - (basePhantomDeathsByLevel[l] || 0));
        const effInc = Math.max(0, (incDeaths[l] || 0) - (incPhantomDeathsByLevel[l] || 0));
        const legacyCount = Math.min(Math.max(effBase, effInc), DEFAULT_LIVES);
        const existingCount = Array.from(deathEventMap.values()).filter(e => e.level === l).length;
        for (let i = existingCount; i < legacyCount; i++) {
            const id = `legacy-${l}-${i}`;
            deathEventMap.set(id, { id, level: l, ts: Math.max(baseReset, incReset) });
        }
    }

    // Calculate effective direct lives excluding phantom deaths
    const basePhantomDeaths = (base.deathEvents || []).filter(d => {
        const match = d.id.match(/^(.+)-death$/);
        return match && allVictoryAttemptIds.has(match[1]);
    }).length;
    const incPhantomDeaths = (incoming.deathEvents || []).filter(d => {
        const match = d.id.match(/^(.+)-death$/);
        return match && allVictoryAttemptIds.has(match[1]);
    }).length;

    const baseLives = Number.isSafeInteger(base.lives) ? base.lives : DEFAULT_LIVES;
    const incLives = Number.isSafeInteger(incoming.lives) ? incoming.lives : DEFAULT_LIVES;
    const effectiveBaseLives = Math.min(DEFAULT_LIVES, baseLives + basePhantomDeaths);
    const effectiveIncLives = Math.min(DEFAULT_LIVES, incLives + incPhantomDeaths);
    const directLivesMin = Math.min(effectiveBaseLives, effectiveIncLives);
    if (directLivesMin < DEFAULT_LIVES) {
        const lost = DEFAULT_LIVES - directLivesMin;
        while (deathEventMap.size < lost) {
            const id = `legacy-min-loss-${deathEventMap.size}`;
            deathEventMap.set(id, { id, level: 1, ts: Math.max(baseReset, incReset) });
        }
    }

    const mergedDeathEvents = Array.from(deathEventMap.values());
    const mergedDeaths: Record<number, number> = {};
    for (const e of mergedDeathEvents) {
        mergedDeaths[e.level] = (mergedDeaths[e.level] || 0) + 1;
    }

    const mergedLives = Math.min(
        calculateLivesFromEvents(mergedDeathEvents),
        directLivesMin,
    );
    const updatedAt = Math.max(base.updatedAt || 0, incoming.updatedAt || 0, Date.now());

    return {
        lives: mergedLives,
        score: mergedScore,
        completedLevels: mergedLevels,
        scoresByLevel: mergedScoresByLevel,
        attemptsByLevel: mergedAttempts,
        attemptEvents: mergedAttemptEvents,
        completedAttemptIds: mergedCompletedAttemptIds,
        deathsByLevel: mergedDeaths,
        deathEvents: mergedDeathEvents,
        resetAt: Math.max(baseReset, incReset),
        updatedAt,
    };
}

export function saveState(storageKey: string, state: SavedState): string | null {
    if (typeof window === 'undefined') return null;

    try {
        localStorage.setItem(storageKey, JSON.stringify(state));
        return null;
    } catch (error) {
        return storageFailure('save', error);
    }
}

/**
 * When a guest signs in, carry their progress over to the user-scoped key
 * by merging with any existing user-scoped progress so guest achievements are not lost.
 */
export function migrateGuestProgress(userId: string): string | null {
    if (typeof window === 'undefined') return null;

    try {
        const guestKey = getStorageKey(null);
        const guestRaw = localStorage.getItem(guestKey);
        if (!guestRaw) return null;

        let guestSaved: SavedState;
        try {
            guestSaved = normalizeSavedState(JSON.parse(guestRaw)).saved;
        } catch {
            // Unreadable guest data must never replace the account: drop it and keep the account as is.
            localStorage.removeItem(guestKey);
            return null;
        }

        const userKey = getStorageKey(userId);
        const userRaw = localStorage.getItem(userKey);
        let userSaved: SavedState | null = null;
        if (userRaw) {
            try {
                userSaved = normalizeSavedState(JSON.parse(userRaw)).saved;
            } catch {
                userSaved = null; // corrupted account data: the guest progress replaces it
            }
        }

        // The guest and the account are separate profiles, so a reset of the guest profile must not
        // supersede the account's progress: the guest data is merged in at the account's reset epoch.
        const migrated = userSaved
            ? mergeSavedStates(userSaved, { ...guestSaved, resetAt: userSaved.resetAt || 0 })
            : guestSaved;

        // If this write fails the guest key is kept, so nothing is lost and the next sign-in retries.
        localStorage.setItem(userKey, JSON.stringify(migrated));
        localStorage.removeItem(guestKey);
        return null;
    } catch (error) {
        return storageFailure('migrate guest', error);
    }
}

export function isValidLevel(level: number): boolean {
    return Number.isSafeInteger(level) && level >= 1 && level <= TOTAL_LEVELS;
}

function normalizePoints(points: number): number | null {
    if (!Number.isFinite(points) || points < 0) return null;
    return Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(points));
}

function canApplyAction(state: StoreState, storageKey: string): boolean {
    return state.hydrated && state.storageKey === storageKey;
}

function markChanged(state: StoreState, changes: Partial<SavedState>, isReset = false): StoreState {
    return {
        ...state,
        ...changes,
        updatedAt: Date.now(),
        isReset,
        revision: state.revision + 1,
    };
}

const INITIAL_STORE_STATE: StoreState = {
    lives: DEFAULT_LIVES,
    score: 0,
    completedLevels: [],
    scoresByLevel: {},
    attemptsByLevel: {},
    attemptEvents: [],
    completedAttemptIds: [],
    deathsByLevel: {},
    deathEvents: [],
    resetAt: 0,
    updatedAt: 0,
    storageKey: null,
    hydrated: false,
    revision: 0,
    persistedRevision: 0,
    isReset: false,
};

export function gameReducer(state: StoreState, action: StoreAction): StoreState {
    switch (action.type) {
        case 'hydrate':
            return {
                ...action.saved,
                scoresByLevel: action.saved.scoresByLevel || {},
                attemptsByLevel: action.saved.attemptsByLevel || {},
                attemptEvents: action.saved.attemptEvents || [],
                completedAttemptIds: action.saved.completedAttemptIds || [],
                deathsByLevel: action.saved.deathsByLevel || {},
                deathEvents: action.saved.deathEvents || [],
                resetAt: action.saved.resetAt || 0,
                updatedAt: action.saved.updatedAt || 0,
                storageKey: action.storageKey,
                hydrated: true,
                revision: 0,
                persistedRevision: 0,
                isReset: false,
            };
        case 'syncFromStorage': {
            if (action.storageKey !== state.storageKey) return state;
            const merged = mergeSavedStates(state, action.saved);

            const hadUnpersistedLocalChanges = state.revision > state.persistedRevision;
            const hasNewerResetEpoch = (merged.resetAt || 0) > (action.saved.resetAt || 0);
            const mergedAttempts = merged.attemptsByLevel || {};
            const incomingAttempts = action.saved.attemptsByLevel || {};
            const hasExtraAttempts = Object.keys(mergedAttempts).some(
                k => (mergedAttempts[Number(k)] || 0) > (incomingAttempts[Number(k)] || 0)
            );
            const incomingCompletedSet = new Set(action.saved.completedAttemptIds || []);
            const hasExtraCompletedAttempts = (merged.completedAttemptIds || []).some(
                id => !incomingCompletedSet.has(id)
            );
            const incomingDeathSet = new Set((action.saved.deathEvents || []).map(d => d.id));
            const hasExtraDeathEvents = (merged.deathEvents || []).some(
                d => !incomingDeathSet.has(d.id)
            );
            const incomingAttemptSet = new Set((action.saved.attemptEvents || []).map(a => a.id));
            const hasExtraAttemptEvents = (merged.attemptEvents || []).some(
                a => !incomingAttemptSet.has(a.id)
            );
            const mergedScores = merged.scoresByLevel || {};
            const incomingScores = action.saved.scoresByLevel || {};
            const hasExtraScores = Object.keys(mergedScores).some(
                lvl => (mergedScores[Number(lvl)] || 0) > (incomingScores[Number(lvl)] || 0)
            );
            const hasExtraDataThanIncoming =
                hasNewerResetEpoch ||
                merged.score > action.saved.score ||
                merged.lives < action.saved.lives ||
                merged.completedLevels.length > action.saved.completedLevels.length ||
                ((merged.deathEvents?.length || 0) > (action.saved.deathEvents?.length || 0)) ||
                ((merged.attemptEvents?.length || 0) > (action.saved.attemptEvents?.length || 0)) ||
                hasExtraAttempts ||
                hasExtraCompletedAttempts ||
                hasExtraDeathEvents ||
                hasExtraAttemptEvents ||
                hasExtraScores;

            const nextRevision = Math.max(state.revision, state.persistedRevision) + 1;
            // If local state had unpersisted changes or has a newer reset epoch or extra data,
            // do NOT advance persistedRevision so the persist effect saves the merged state to disk!
            const newPersistedRevision = (hadUnpersistedLocalChanges || hasExtraDataThanIncoming)
                ? state.persistedRevision
                : nextRevision;

            return {
                ...state,
                ...merged,
                scoresByLevel: merged.scoresByLevel || {},
                attemptsByLevel: merged.attemptsByLevel || {},
                attemptEvents: merged.attemptEvents || [],
                completedAttemptIds: merged.completedAttemptIds || [],
                deathsByLevel: merged.deathsByLevel || {},
                deathEvents: merged.deathEvents || [],
                resetAt: merged.resetAt || 0,
                updatedAt: merged.updatedAt || 0,
                hydrated: true,
                revision: nextRevision,
                persistedRevision: newPersistedRevision,
                isReset: false,
            };
        }
        case 'startAttempt': {
            if (!canApplyAction(state, action.storageKey) || state.lives === 0 || !isValidLevel(action.level)) return state;
            if (state.resetAt !== action.resetAt) return state;
            const isUnlocked = action.level <= 1 || state.completedLevels.includes(action.level - 1);
            if (!isUnlocked) return state;

            const newEvent: AttemptEvent = { id: action.attemptId, level: action.level, ts: Date.now() };
            const updatedAttemptEvents = [...state.attemptEvents, newEvent].slice(-1000);
            const currentAttempts = state.attemptsByLevel[action.level] || 0;
            const updatedAttempts = {
                ...state.attemptsByLevel,
                [action.level]: currentAttempts + 1,
            };

            return markChanged(state, {
                attemptEvents: updatedAttemptEvents,
                attemptsByLevel: updatedAttempts,
            }, false);
        }
        case 'finishAttempt': {
            if (!canApplyAction(state, action.storageKey) || !isValidLevel(action.level)) return state;
            if (state.resetAt !== action.resetAt) return state;

            const deathEventId = `${action.attemptId}-death`;
            const hasDeath = state.deathEvents.some(d => d.id === deathEventId);
            const isAlreadyCompleted = state.completedAttemptIds.includes(action.attemptId);
            const hasAttemptEvent = isAttemptStartCounted(state.attemptEvents, action.attemptId);

            const updatedAttemptEvents = hasAttemptEvent
                ? state.attemptEvents
                : [...state.attemptEvents, { id: action.attemptId, level: action.level, ts: Date.now() }].slice(-1000);
            const updatedAttemptsByLevel = hasAttemptEvent
                ? state.attemptsByLevel
                : {
                    ...state.attemptsByLevel,
                    [action.level]: (state.attemptsByLevel[action.level] || 0) + 1,
                };

            const updatedCompletedAttemptIds = isAlreadyCompleted
                ? state.completedAttemptIds
                : withCompletedAttemptId(state.completedAttemptIds, action.attemptId, updatedAttemptEvents);

            if (action.outcome === 'victory') {
                const points = normalizePoints(action.points ?? 0) ?? 0;
                const currentLevelScore = state.scoresByLevel[action.level];
                if (
                    isAlreadyCompleted &&
                    !hasDeath &&
                    state.completedLevels.includes(action.level) &&
                    points <= (currentLevelScore ?? 0)
                ) {
                    return state;
                }

                // If this attempt was prematurely marked with a crash-recovery death, remove the phantom death
                let nextDeathEvents = state.deathEvents;
                let nextDeathsByLevel = state.deathsByLevel;
                if (hasDeath) {
                    nextDeathEvents = state.deathEvents.filter(d => d.id !== deathEventId);
                    nextDeathsByLevel = {
                        ...state.deathsByLevel,
                        [action.level]: Math.max(0, (state.deathsByLevel[action.level] || 1) - 1),
                    };
                }
                const newLives = calculateLivesFromEvents(nextDeathEvents);

                if (newLives === 0) {
                    return markChanged(state, {
                        attemptEvents: updatedAttemptEvents,
                        attemptsByLevel: updatedAttemptsByLevel,
                        deathEvents: nextDeathEvents,
                        deathsByLevel: nextDeathsByLevel,
                        lives: newLives,
                        completedAttemptIds: updatedCompletedAttemptIds,
                    }, false);
                }

                const alreadyCompleted = state.completedLevels.includes(action.level);
                const nextCompleted = alreadyCompleted
                    ? state.completedLevels
                    : [...state.completedLevels, action.level].sort((a, b) => a - b);
                const nextLevelScore = currentLevelScore !== undefined ? Math.max(currentLevelScore, points) : points;
                const nextScoresByLevel = {
                    ...state.scoresByLevel,
                    [action.level]: nextLevelScore,
                };
                let nextScore: number;
                if (alreadyCompleted) {
                    if (currentLevelScore !== undefined) {
                        nextScore = points > currentLevelScore ? state.score + (points - currentLevelScore) : state.score;
                    } else {
                        // Legacy save where level was completed before scoresByLevel tracking: points already included in state.score
                        nextScore = state.score;
                    }
                } else {
                    nextScore = Math.min(Number.MAX_SAFE_INTEGER, state.score + points);
                }

                return markChanged(state, {
                    score: nextScore,
                    scoresByLevel: nextScoresByLevel,
                    completedLevels: nextCompleted,
                    attemptEvents: updatedAttemptEvents,
                    attemptsByLevel: updatedAttemptsByLevel,
                    completedAttemptIds: updatedCompletedAttemptIds,
                    deathEvents: nextDeathEvents,
                    deathsByLevel: nextDeathsByLevel,
                    lives: newLives,
                }, false);
            }

            if (action.outcome === 'cancelled') {
                const filteredAttemptEvents = state.attemptEvents.filter(e => e.id !== action.attemptId);
                const hadExplicitEvent = filteredAttemptEvents.length < state.attemptEvents.length;
                const currentCount = state.attemptsByLevel[action.level] || 0;
                const nextAttemptsByLevel = hadExplicitEvent && currentCount > 0
                    ? { ...state.attemptsByLevel, [action.level]: currentCount - 1 }
                    : state.attemptsByLevel;
                return markChanged(state, {
                    attemptEvents: filteredAttemptEvents,
                    attemptsByLevel: nextAttemptsByLevel,
                    completedAttemptIds: withCompletedAttemptId(state.completedAttemptIds, action.attemptId, filteredAttemptEvents),
                }, false);
            }

            if (action.outcome === 'defeat') {
                if (hasDeath || state.lives === 0) {
                    if (isAlreadyCompleted && hasAttemptEvent) {
                        return state;
                    }
                    return markChanged(state, {
                        attemptEvents: updatedAttemptEvents,
                        attemptsByLevel: updatedAttemptsByLevel,
                        completedAttemptIds: updatedCompletedAttemptIds,
                    }, false);
                }
                const newDeath: DeathEvent = { id: deathEventId, level: action.level, ts: Date.now() };
                const updatedDeathEvents = [...state.deathEvents, newDeath];
                const updatedDeaths = {
                    ...state.deathsByLevel,
                    [action.level]: (state.deathsByLevel[action.level] || 0) + 1,
                };
                const newLives = calculateLivesFromEvents(updatedDeathEvents);

                return markChanged(state, {
                    attemptEvents: updatedAttemptEvents,
                    attemptsByLevel: updatedAttemptsByLevel,
                    deathEvents: updatedDeathEvents,
                    deathsByLevel: updatedDeaths,
                    lives: newLives,
                    completedAttemptIds: updatedCompletedAttemptIds,
                }, false);
            }

            return state;
        }
        case 'recordAttempt': {
            if (!canApplyAction(state, action.storageKey) || state.lives === 0 || !isValidLevel(action.level)) return state;
            const eventId = `${action.storageKey}-attempt-${action.level}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
            const newEvent: AttemptEvent = { id: eventId, level: action.level, ts: Date.now() };
            const updatedAttemptEvents = [...state.attemptEvents, newEvent].slice(-1000);
            const updatedAttempts = {
                ...state.attemptsByLevel,
                [action.level]: (state.attemptsByLevel[action.level] || 0) + 1,
            };
            return markChanged(state, {
                attemptEvents: updatedAttemptEvents,
                attemptsByLevel: updatedAttempts,
            }, false);
        }
        case 'loseLife': {
            if (!canApplyAction(state, action.storageKey) || state.lives === 0) return state;
            const targetLevel = action.level && isValidLevel(action.level) ? action.level : 1;
            const eventId = `${action.storageKey}-${targetLevel}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
            const newEvent: DeathEvent = { id: eventId, level: targetLevel, ts: Date.now() };
            const updatedEvents = [...state.deathEvents, newEvent];

            const updatedDeaths = { ...state.deathsByLevel, [targetLevel]: (state.deathsByLevel[targetLevel] || 0) + 1 };
            const newLives = calculateLivesFromEvents(updatedEvents);
            return markChanged(state, { deathEvents: updatedEvents, deathsByLevel: updatedDeaths, lives: newLives }, false);
        }
        case 'completeLevel': {
            if (!canApplyAction(state, action.storageKey) || state.lives === 0) return state;
            if (!isValidLevel(action.level)) return state;

            const points = normalizePoints(action.points);
            if (points === null) return state;

            const currentCompleted = state.completedLevels || [];
            const alreadyCompleted = currentCompleted.includes(action.level);
            const updatedCompletedLevels = alreadyCompleted
                ? currentCompleted
                : [...currentCompleted, action.level].sort((a, b) => a - b);

            const currentLevelScore = state.scoresByLevel ? state.scoresByLevel[action.level] : undefined;
            const nextLevelScore = currentLevelScore !== undefined ? Math.max(currentLevelScore, points) : points;
            const nextScoresByLevel = {
                ...(state.scoresByLevel || {}),
                [action.level]: nextLevelScore,
            };

            let nextScore: number;
            if (alreadyCompleted) {
                if (currentLevelScore !== undefined) {
                    nextScore = points > currentLevelScore ? state.score + (points - currentLevelScore) : state.score;
                } else {
                    nextScore = state.score;
                }
            } else {
                nextScore = Math.min(Number.MAX_SAFE_INTEGER, state.score + points);
            }

            return markChanged(state, {
                score: nextScore,
                scoresByLevel: nextScoresByLevel,
                completedLevels: updatedCompletedLevels,
            }, false);
        }
        case 'reset': {
            if (!canApplyAction(state, action.storageKey)) return state;
            const nextResetAt = Math.max(action.resetAt, (state.resetAt || 0) + 1);
            return markChanged(state, createDefaultSavedState(nextResetAt), true);
        }
        case 'persisted': {
            if (state.storageKey !== action.storageKey || action.revision <= state.persistedRevision) {
                return state;
            }
            const source = action.revision < state.revision
                ? mergeSavedStates(state, action.saved)
                : action.saved;
            return {
                ...state,
                ...source,
                scoresByLevel: source.scoresByLevel || {},
                attemptsByLevel: source.attemptsByLevel || {},
                attemptEvents: source.attemptEvents || [],
                completedAttemptIds: source.completedAttemptIds || [],
                deathsByLevel: source.deathsByLevel || {},
                deathEvents: source.deathEvents || [],
                resetAt: source.resetAt || 0,
                updatedAt: source.updatedAt || 0,
                persistedRevision: action.revision,
                isReset: false,
            };
        }
        default:
            return state;
    }
}

export function executeFinishAttemptSync(
    params: {
        token: AttemptToken;
        outcome: 'victory' | 'defeat' | 'cancelled';
        points?: number;
    },
    currentStorageKey?: string | null,
    currentResetAt?: number | null
): boolean {
    if (!params.token) return false;
    unregisterActiveAttempt(params.token.attemptId);
    const key = params.token.storageKey || currentStorageKey;
    if (!key) return false;
    if (params.token.storageKey && currentStorageKey && key !== params.token.storageKey) return false;
    if (currentResetAt !== undefined && currentResetAt !== null && (currentResetAt || 0) !== (params.token.resetAt || 0)) {
        return false;
    }

    if (typeof window !== 'undefined' && key) {
        try {
            const disk = loadState(key);
            if (disk.saved && !disk.isEmpty) {
                const diskResetAt = disk.saved.resetAt || 0;
                const tokenResetAt = params.token.resetAt || 0;
                if (diskResetAt !== tokenResetAt) {
                    return false;
                }
            }
            const currentSaved = (disk.saved && !disk.isEmpty) ? disk.saved : createDefaultSavedState(params.token.resetAt);
            const attemptId = params.token.attemptId;
            if (params.outcome === 'cancelled') {
                const existingEvents = currentSaved.attemptEvents || [];
                const filteredEvents = existingEvents.filter(e => e.id !== attemptId);
                const hadExplicitEvent = filteredEvents.length < existingEvents.length;
                const existingAttempts = { ...(currentSaved.attemptsByLevel || {}) };
                if (hadExplicitEvent && (existingAttempts[params.token.level] || 0) > 0) {
                    existingAttempts[params.token.level] -= 1;
                }
                const cancelledSaved: SavedState = {
                    ...currentSaved,
                    attemptsByLevel: existingAttempts,
                    attemptEvents: filteredEvents,
                    completedAttemptIds: withCompletedAttemptId(currentSaved.completedAttemptIds || [], attemptId, filteredEvents),
                    updatedAt: Date.now(),
                };
                saveState(key, cancelledSaved);
                return true;
            }
            const hasAttemptOnDisk = isAttemptStartCounted(currentSaved.attemptEvents || [], attemptId);
            const updatedAttemptEvents = hasAttemptOnDisk
                ? (currentSaved.attemptEvents || [])
                : [...(currentSaved.attemptEvents || []), { id: attemptId, level: params.token.level, ts: Date.now() }].slice(-1000);
            const updatedAttemptsByLevel = hasAttemptOnDisk
                ? { ...(currentSaved.attemptsByLevel || {}) }
                : {
                    ...(currentSaved.attemptsByLevel || {}),
                    [params.token.level]: ((currentSaved.attemptsByLevel || {})[params.token.level] || 0) + 1,
                };
            const deathEventId = `${attemptId}-death`;
            const updatedDeathEvents = [...(currentSaved.deathEvents || [])];
            const updatedDeaths = { ...(currentSaved.deathsByLevel || {}) };
            if (params.outcome === 'defeat' && currentSaved.lives > 0) {
                if (!updatedDeathEvents.some(d => d.id === deathEventId)) {
                    updatedDeathEvents.push({ id: deathEventId, level: params.token.level, ts: Date.now() });
                    updatedDeaths[params.token.level] = (updatedDeaths[params.token.level] || 0) + 1;
                }
            }
            if (params.outcome === 'victory') {
                const phantomIdx = updatedDeathEvents.findIndex(d => d.id === deathEventId);
                if (phantomIdx !== -1) {
                    const removed = updatedDeathEvents.splice(phantomIdx, 1)[0];
                    if ((updatedDeaths[removed.level] || 0) > 0) {
                        updatedDeaths[removed.level]--;
                    }
                }
            }
            const updatedCompletedAttemptIds = withCompletedAttemptId(currentSaved.completedAttemptIds || [], attemptId, updatedAttemptEvents);
            const newLives = calculateLivesFromEvents(updatedDeathEvents);

            let nextCompleted = currentSaved.completedLevels;
            let nextScore = currentSaved.score;
            const nextScoresByLevel = { ...(currentSaved.scoresByLevel || {}) };
            if (params.outcome === 'victory' && newLives > 0) {
                const points = normalizePoints(params.points ?? 0) ?? 0;
                const alreadyCompleted = currentSaved.completedLevels.includes(params.token.level);
                if (!alreadyCompleted) {
                    nextCompleted = [...currentSaved.completedLevels, params.token.level].sort((a, b) => a - b);
                }
                const currentLevelScore = nextScoresByLevel[params.token.level];
                const nextLevelScore = currentLevelScore !== undefined ? Math.max(currentLevelScore, points) : points;
                nextScoresByLevel[params.token.level] = nextLevelScore;
                if (alreadyCompleted) {
                    if (currentLevelScore !== undefined) {
                        nextScore = points > currentLevelScore ? currentSaved.score + (points - currentLevelScore) : currentSaved.score;
                    }
                } else {
                    nextScore = Math.min(Number.MAX_SAFE_INTEGER, currentSaved.score + points);
                }
            }

            const newSaved: SavedState = {
                ...currentSaved,
                score: nextScore,
                scoresByLevel: nextScoresByLevel,
                completedLevels: nextCompleted,
                attemptsByLevel: updatedAttemptsByLevel,
                attemptEvents: updatedAttemptEvents,
                deathEvents: updatedDeathEvents,
                deathsByLevel: updatedDeaths,
                completedAttemptIds: updatedCompletedAttemptIds,
                lives: newLives,
                updatedAt: Date.now(),
            };
            saveState(key, newSaved);
            return true;
        } catch {
            return false;
        }
    }
    return false;
}

export function GameProvider({ children }: { children: ReactNode }) {
    const { user, isLoaded } = useUser();
    const userId = user?.id ?? null;
    const storageKey = getStorageKey(userId);
    const [state, dispatch] = useReducer(gameReducer, INITIAL_STORE_STATE);
    const [storageError, setStorageError] = useState<string | null>(null);
    const [storageNotice, setStorageNotice] = useState<string | null>(null);

    // Hydrate the correct storage scope on first load and whenever the Clerk user changes.
    useEffect(() => {
        if (!isLoaded) return;

        const migrationError = userId ? migrateGuestProgress(userId) : null;
        const loaded = loadState(storageKey);
        setStorageError(migrationError ?? (loaded.failed ? loaded.error : null));
        setStorageNotice(loaded.failed ? null : loaded.error);
        dispatch({ type: 'hydrate', storageKey, saved: loaded.saved });
    }, [isLoaded, storageKey, userId]);

    // Cross-tab synchronization via the 'storage' event.
    useEffect(() => {
        if (!isLoaded || typeof window === 'undefined') return;

        const handleStorage = (event: StorageEvent) => {
            if (event.key !== storageKey) return;
            if (event.newValue === null) {
                dispatch({ type: 'hydrate', storageKey, saved: createDefaultSavedState(Date.now()) });
                return;
            }
            try {
                const parsed = JSON.parse(event.newValue);
                const normalized = normalizeSavedState(parsed);
                setStorageError(null);
                setStorageNotice(normalized.error);
                dispatch({ type: 'syncFromStorage', storageKey, saved: normalized.saved });
            } catch (err) {
                setStorageError(storageFailure('parse cross-tab update for', err));
            }
        };

        window.addEventListener('storage', handleStorage);
        return () => window.removeEventListener('storage', handleStorage);
    }, [isLoaded, storageKey]);

    // Persist snapshot.
    useEffect(() => {
        if (!state.hydrated || state.storageKey !== storageKey) return;
        if (state.revision === state.persistedRevision) return;

        let toSave: SavedState = {
            lives: state.lives,
            score: state.score,
            completedLevels: state.completedLevels,
            scoresByLevel: state.scoresByLevel,
            attemptsByLevel: state.attemptsByLevel,
            attemptEvents: state.attemptEvents,
            completedAttemptIds: state.completedAttemptIds,
            deathsByLevel: state.deathsByLevel,
            deathEvents: state.deathEvents,
            resetAt: state.resetAt,
            updatedAt: state.updatedAt,
        };

        if (!state.isReset) {
            const disk = loadState(storageKey);
            if (disk.saved && !disk.isEmpty) {
                toSave = mergeSavedStates(toSave, disk.saved);
            }
        }

        const error = saveState(storageKey, toSave);
        if (error) {
            setStorageError(error);
            return;
        }

        setStorageError(null);
        dispatch({ type: 'persisted', storageKey, revision: state.revision, saved: toSave });
    }, [state, storageKey]);

    const startAttempt = useCallback((level: number): AttemptToken | null => {
        if (!isLoaded || !state.hydrated || state.storageKey !== storageKey || state.lives === 0 || !isValidLevel(level)) {
            return null;
        }
        const isUnlocked = level <= 1 || state.completedLevels.includes(level - 1);
        if (!isUnlocked) {
            return null;
        }
        const attemptId = `${storageKey}-att-${level}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
        registerActiveAttempt(attemptId);
        dispatch({ type: 'startAttempt', storageKey, resetAt: state.resetAt, level, attemptId });
        return {
            attemptId,
            level,
            storageKey,
            resetAt: state.resetAt,
        };
    }, [isLoaded, state.hydrated, state.lives, state.resetAt, storageKey, state.storageKey, state.completedLevels]);

    const finishAttempt = useCallback((params: {
        token: AttemptToken;
        outcome: 'victory' | 'defeat' | 'cancelled';
        points?: number;
    }): boolean => {
        if (!isLoaded || !params.token) return false;
        unregisterActiveAttempt(params.token.attemptId);
        if (!state.hydrated || state.storageKey !== params.token.storageKey || state.resetAt !== params.token.resetAt) {
            return false;
        }
        dispatch({
            type: 'finishAttempt',
            storageKey: params.token.storageKey,
            resetAt: params.token.resetAt,
            level: params.token.level,
            attemptId: params.token.attemptId,
            outcome: params.outcome,
            points: params.points,
        });
        return true;
    }, [isLoaded, state.hydrated, state.storageKey, state.resetAt]);


    const finishAttemptSync = useCallback((params: {
        token: AttemptToken;
        outcome: 'victory' | 'defeat' | 'cancelled';
        points?: number;
    }): boolean => {
        const ok = executeFinishAttemptSync(params, storageKey, state.hydrated ? state.resetAt : undefined);
        if (ok) {
            dispatch({
                type: 'finishAttempt',
                storageKey: params.token.storageKey,
                resetAt: params.token.resetAt,
                level: params.token.level,
                attemptId: params.token.attemptId,
                outcome: params.outcome,
                points: params.points,
            });
        }
        return ok;
    }, [storageKey, state.hydrated, state.resetAt]);

    const recordAttempt = useCallback((level: number): number => {
        if (!isLoaded) return 1;
        dispatch({ type: 'recordAttempt', storageKey, level });
        return (state.attemptsByLevel[level] || 0) + 1;
    }, [isLoaded, storageKey, state.attemptsByLevel]);

    const getAttempts = useCallback((level: number): number => {
        return state.attemptsByLevel[level] || 0;
    }, [state.attemptsByLevel]);

    const loseLife = useCallback((level?: number) => {
        if (!isLoaded) return;
        dispatch({ type: 'loseLife', storageKey, level });
    }, [isLoaded, storageKey]);

    const completeLevel = useCallback((level: number, points: number) => {
        if (!isLoaded) return;
        dispatch({ type: 'completeLevel', storageKey, level, points });
    }, [isLoaded, storageKey]);

    const resetGame = useCallback(() => {
        if (!isLoaded) return;
        unregisterAllLocalActiveAttempts();
        dispatch({ type: 'reset', storageKey, resetAt: Date.now() });
    }, [isLoaded, storageKey]);

    const isLevelUnlocked = useCallback((level: number): boolean => {
        if (!isValidLevel(level)) return false;
        if (level === 1) return true;
        return state.completedLevels.includes(level - 1);
    }, [state.completedLevels]);

    const isHydrated = isLoaded && state.hydrated && state.storageKey === storageKey;
    const isGameOver = state.lives === 0 && isHydrated;

    return (
        <GameContext.Provider value={{
            lives: state.lives,
            score: state.score,
            resetAt: state.resetAt,
            storageKey,
            isGameOver,
            completedLevels: state.completedLevels,
            attemptsByLevel: state.attemptsByLevel,
            deathsByLevel: state.deathsByLevel,
            startAttempt,
            finishAttempt,
            finishAttemptSync,
            recordAttempt,
            getAttempts,
            loseLife,
            completeLevel,
            resetGame,
            isLevelUnlocked,
            isHydrated,
            storageError,
            storageNotice,
        }}>
            {children}
        </GameContext.Provider>
    );
}

export function useGame(): GameContextValue {
    const ctx = useContext(GameContext);
    if (!ctx) throw new Error('useGame must be used within a GameProvider');
    return ctx;
}
