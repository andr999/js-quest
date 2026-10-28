// Рівень 6: Об'єкти та Ключі
"use client";
import { useCallback, useRef, useState, useEffect } from 'react';
import { useGame, type AttemptToken, type AttemptVerdict } from '@/app/context/GameContext';
import LevelLayout from '@/components/LevelLayout';
import GridRenderer from '@/components/GridRenderer';
import { usePathPlayback } from '@/hooks/usePathPlayback';
import { useResponsiveCell } from '@/hooks/useResponsiveCell';
import { checkRunnableCode, followsLevelData, getSandboxPlaybackPath, movesInLoop, runCodeInSandbox, type SandboxResult } from '@/utils/sandboxRunner';
import { LEVELS_CONFIG, computeLevelScore } from '@/utils/levelsConfig';
import { instructionsDataVariant, type Instruction } from '@/utils/levelData';

// The level passes the route to the learner's code as `instructions`. Every object has `steps`
// (1 for a turn), so repeat(item.steps, ...) or a for loop over steps works for any of them.
const INSTRUCTIONS: Instruction[] = [
    { command: 'move', steps: 2 },
    { command: 'turnRight', steps: 1 },
    { command: 'move', steps: 1 },
    { command: 'turnLeft', steps: 1 },
    { command: 'move', steps: 2 },
    { command: 'turnLeft', steps: 1 },
    { command: 'move', steps: 1 },
    { command: 'turnRight', steps: 1 },
    { command: 'turnRight', steps: 1 },
    { command: 'move', steps: 2 },
    { command: 'turnLeft', steps: 1 },
    { command: 'move', steps: 3 },
    { command: 'turnRight', steps: 1 },
    { command: 'move', steps: 2 },
    { command: 'turnRight', steps: 1 },
    { command: 'move', steps: 1 },
    { command: 'turnLeft', steps: 1 },
    { command: 'move', steps: 1 },
    { command: 'turnRight', steps: 1 },
    { command: 'move', steps: 2 },
    { command: 'turnRight', steps: 1 },
    { command: 'move', steps: 1 },
    { command: 'turnLeft', steps: 1 },
    { command: 'move', steps: 4 },
    { command: 'turnLeft', steps: 1 },
    { command: 'turnLeft', steps: 1 },
    { command: 'move', steps: 4 },
    { command: 'turnRight', steps: 1 },
    { command: 'move', steps: 2 },
    { command: 'turnLeft', steps: 1 },
    { command: 'move', steps: 3 },
    { command: 'turnRight', steps: 1 },
    { command: 'move', steps: 1 },
];

const initialCode = `// Напиши свій код тут!
// ⭐ Рівень 6: Об'єкти, Ключі та Небезпека!

// Маршрут записаний як масив ОБ'ЄКТІВ.
// Він уже лежить у змінній instructions — рівень сам передає його твоєму коду:
// instructions = [
//   // До ключа №1 (4,0)
//   { command: 'move', steps: 2 },
//   { command: 'turnRight', steps: 1 }, { command: 'move', steps: 1 },
//   { command: 'turnLeft', steps: 1 }, { command: 'move', steps: 2 },
//   { command: 'turnLeft', steps: 1 }, { command: 'move', steps: 1 }, // 🔑 Ключ 1
//   // Розворот і спуск у середній коридор
//   { command: 'turnRight', steps: 1 }, { command: 'turnRight', steps: 1 }, { command: 'move', steps: 2 },
//   { command: 'turnLeft', steps: 1 }, { command: 'move', steps: 3 },
//   { command: 'turnRight', steps: 1 }, { command: 'move', steps: 2 },
//   // Обхід ворога на (5,4) знизу
//   { command: 'turnRight', steps: 1 }, { command: 'move', steps: 1 },
//   { command: 'turnLeft', steps: 1 }, { command: 'move', steps: 1 },
//   { command: 'turnRight', steps: 1 }, { command: 'move', steps: 2 },
//   { command: 'turnRight', steps: 1 }, { command: 'move', steps: 1 },
//   // Лівий коридор до ключа №2 (0,4)
//   { command: 'turnLeft', steps: 1 }, { command: 'move', steps: 4 }, // 🔑 Ключ 2
//   // Розворот, повернення та спуск до нижнього ряду
//   { command: 'turnLeft', steps: 1 }, { command: 'turnLeft', steps: 1 }, { command: 'move', steps: 4 },
//   { command: 'turnRight', steps: 1 }, { command: 'move', steps: 2 },
//   // Праворуч повз ворога (3,6) до ключа №3 (7,6)
//   { command: 'turnLeft', steps: 1 }, { command: 'move', steps: 3 }, // 🔑 Ключ 3
//   { command: 'turnRight', steps: 1 }, { command: 'move', steps: 1 } // 🎯 Фініш
// ];
// Не оголошуй instructions ще раз — просто використовуй її.

// ТВОЄ ЗАВДАННЯ:
// Напиши цикл по масиву instructions, який читає поля command та steps кожного об'єкта!

// Підказка — як читати поля об'єкта в циклі:
// for (const item of instructions) {
//   if (item.command === 'move') {
//     repeat(item.steps, () => { move(); }); // або move(item.steps);
//   } else if (item.command === 'turnRight') {
//     turnRight();
//   } else if (item.command === 'turnLeft') {
//     turnLeft();
//   }
// }
`;

const LEVEL_NUMBER = 6;
const CONFIG = LEVELS_CONFIG[LEVEL_NUMBER];
const gridMap = CONFIG.gridMap;
const INIT_POS = CONFIG.initialPos;

const KEY_IDS = gridMap.flatMap((row, y) => row.flatMap((cell, x) => (cell === 'key' ? [`${x},${y}`] : [])));
const TOTAL_KEYS = KEY_IDS.length;

// The same code also runs with other instructions on a board made for them: only code that
// follows the instruction objects gets there too.
const INSTRUCTION_VARIANTS = [instructionsDataVariant('instructions', INSTRUCTIONS, TOTAL_KEYS)];

export default function Level6() {
    const [code, setCode] = useState(initialCode);
    const [position, setPosition] = useState(INIT_POS);
    const [log, setLog] = useState<string[]>([]);
    const [showRules, setShowRules] = useState(true);
    const [isVictory, setIsVictory] = useState(false);
    const [isDefeat, setIsDefeat] = useState(false);
    const [collectedKeyIds, setCollectedKeyIds] = useState<string[]>([]);
    const [isExecuting, setIsExecuting] = useState(false);

    const [defeatReason, setDefeatReason] = useState('');
    const { getAttempts, startAttempt, finishAttempt: finishAttemptTransaction, finishAttemptSync, storageKey, resetAt } = useGame();
    const { play: playPath, current: animStep, isAnimating, stop: stopAnim, path: animPath, index: animIndex } = usePathPlayback(150);
    const { cellSize: CELL, gap: GAP } = useResponsiveCell(48, 36);
    const attemptInProgressRef = useRef(false);
    const executionTokenRef = useRef(0);
    const attemptTokenRef = useRef<AttemptToken | null>(null);
    const pendingVerdictRef = useRef<AttemptVerdict | null>(null);
    const attempts = getAttempts(LEVEL_NUMBER);

    const dp = animStep || position;

    // Long runs are played back with the middle skipped, so once the animation ends the
    // sandbox result, not the replayed path, says which keys were collected.
    const collectedKeysNow = new Set<string>(isAnimating ? [] : collectedKeyIds);
    if (isAnimating) {
        animPath.slice(0, animIndex + 1).forEach(p => {
            if (p.keyPicked) collectedKeysNow.add(`${p.x},${p.y}`);
        });
    }

    const finishAttempt = (result: SandboxResult, newAttempts: number, token: AttemptToken) => {
        const replayPath = getSandboxPlaybackPath(result);
        const path = replayPath.length > 0 ? replayPath : [{ ...INIT_POS }];
        const consoleLog = result.events
            .filter((e): e is Extract<typeof e, { type: 'console' }> => e.type === 'console')
            .map(e => `💬 ${e.message}`);
        const pathLog = path.map(p => {
            let message = `(${p.x}, ${p.y}) ${p.dir}`;
            if (p.outOfBounds) message += ' [OUT]';
            else if (p.blocked) message += ' [WALL]';
            else if (p.killed) message += ' [KILLED]';
            else if (p.keyPicked) message += ' [🔑 КЛЮЧ ЗІБРАНО!]';
            return message;
        });
        const combinedLog = [...consoleLog, ...pathLog];
        setLog(result.ok || !result.error
            ? combinedLog
            : [...combinedLog, `❌ ${result.errorCode ?? 'ERROR'}: ${result.error}`]);

        const reachedGoal = gridMap[result.finalPos.y]?.[result.finalPos.x] === 'goal';
        const hasAllKeys = result.collectedKeys.length === TOTAL_KEYS;
        // The moves must be made in a loop, and the same code must follow other instructions too.
        const inLoop = movesInLoop(result);
        const followsInstructions = followsLevelData(result, INSTRUCTION_VARIANTS);
        const isWin = result.ok && reachedGoal && hasAllKeys && inLoop && followsInstructions;
        const points = computeLevelScore(CONFIG, result.steps, newAttempts);
        pendingVerdictRef.current = isWin ? { outcome: 'victory', points, finalPos: result.finalPos } : { outcome: 'defeat' };

        playPath(path, () => {
            attemptInProgressRef.current = false;
            attemptTokenRef.current = null;
            pendingVerdictRef.current = null;
            setPosition(result.finalPos);
            setCollectedKeyIds(result.collectedKeys);

            if (!result.ok) {
                const reason = result.error ?? 'Помилка виконання.';
                setDefeatReason(reason);
                setIsVictory(false);
                setIsDefeat(true);
                finishAttemptTransaction({ token, outcome: 'defeat' });
                return;
            }

            if (reachedGoal) {
                if (hasAllKeys) {
                    if (!isWin) {
                        const reason = !inLoop
                            ? 'Умова рівня: команди мають виконуватися з масиву обʼєктів instructions у циклі (наприклад, for...of по instructions зі зчитуванням step.command)!'
                            : 'Умова рівня: робот має йти саме за обʼєктами з instructions. Твій код перевірили ще й з іншими інструкціями — і там робот не дійшов до фінішу. Не переписуй маршрут вручну: читай command і steps з кожного обʼєкта.';
                        setDefeatReason(reason);
                        setLog(prev => [...prev, `⚠️ ${reason}`]);
                        setIsVictory(false);
                        setIsDefeat(true);
                        finishAttemptTransaction({ token, outcome: 'defeat' });
                        return;
                    }
                    const success = finishAttemptTransaction({ token, outcome: 'victory', points });
                    if (success) {
                        setIsVictory(true);
                        setIsDefeat(false);
                    }
                } else {
                    const reason = `Зібрано ключів: ${result.collectedKeys.length} з ${TOTAL_KEYS}. Потрібні всі!`;
                    setDefeatReason(reason);
                    setLog(prev => [...prev, `⚠️ ${reason}`]);
                    setIsDefeat(true);
                    finishAttemptTransaction({ token, outcome: 'defeat' });
                }
            } else {
                const reason = 'Робот не дістався фінішу!';
                setDefeatReason(reason);
                setLog(prev => [...prev, `⚠️ ${reason}`]);
                setIsDefeat(true);
                finishAttemptTransaction({ token, outcome: 'defeat' });
            }
        });
    };

    const executeCode = async () => {
        if (attemptInProgressRef.current || isAnimating) return;
        const preflightError = checkRunnableCode(code, ['instructions']);
        if (preflightError) {
            setLog([`⚠️ ${preflightError}`]);
            return;
        }
        const attemptToken = startAttempt(LEVEL_NUMBER);
        if (!attemptToken) return null;
        attemptTokenRef.current = attemptToken;
        attemptInProgressRef.current = true;
        const executionToken = ++executionTokenRef.current;
        const newAttempts = attempts + 1;
        setIsExecuting(true);
        setPosition(INIT_POS);
        setCollectedKeyIds([]);
        setLog([]);
        setIsVictory(false);
        setIsDefeat(false);
        setDefeatReason('');

        try {
            const result = await runCodeInSandbox({
                code,
                gridMap,
                initialPos: INIT_POS,
                mode: 'multi-key',
                throwOnOutOfBounds: true,
                data: { instructions: INSTRUCTIONS },
                variants: INSTRUCTION_VARIANTS,
            });
            if (executionToken !== executionTokenRef.current) return;
            setIsExecuting(false);
            finishAttempt(result, newAttempts, attemptToken);
        } catch (error) {
            if (executionToken !== executionTokenRef.current) return;
            attemptInProgressRef.current = false;
            attemptTokenRef.current = null;
            setIsExecuting(false);
            const reason = `WORKER_ERROR: ${error instanceof Error ? error.message : String(error)}`;
            setDefeatReason(reason);
            setLog([`❌ ${reason}`]);
            setIsDefeat(true);
            finishAttemptTransaction({ token: attemptToken, outcome: 'defeat' });
        }
    };

    const resetLevel = useCallback(() => {
        executionTokenRef.current += 1;
        const wasActive = attemptInProgressRef.current;
        const activeToken = attemptTokenRef.current;
        const verdict: AttemptVerdict = pendingVerdictRef.current ?? { outcome: 'defeat' };
        attemptTokenRef.current = null;
        attemptInProgressRef.current = false;
        pendingVerdictRef.current = null;
        setIsExecuting(false);
        stopAnim();
        if (wasActive && activeToken && verdict.outcome === 'victory') {
            const success = finishAttemptTransaction({ token: activeToken, outcome: 'victory', points: verdict.points });
            if (success) {
                if (verdict.finalPos) setPosition(verdict.finalPos);
                setCollectedKeyIds(KEY_IDS);
                setIsVictory(true);
                setIsDefeat(false);
                setDefeatReason('');
                return;
            }
        }
        setPosition(INIT_POS);
        setLog([]);
        setIsVictory(false);
        setIsDefeat(false);
        setDefeatReason('');
        setCollectedKeyIds([]);
        if (wasActive && activeToken && verdict.outcome !== 'victory') {
            finishAttemptTransaction({ token: activeToken, outcome: verdict.outcome, points: verdict.points });
        }
    }, [finishAttemptTransaction, stopAnim]);

    const lastStorageKeyRef = useRef(storageKey);
    useEffect(() => {
        if (storageKey !== lastStorageKeyRef.current) {
            lastStorageKeyRef.current = storageKey;
            attemptTokenRef.current = null;
            attemptInProgressRef.current = false;
            resetLevel();
            setCode(initialCode);
        }
    }, [storageKey, resetLevel]);

    const lastResetAtRef = useRef(resetAt);
    useEffect(() => {
        if (resetAt !== lastResetAtRef.current) {
            const shouldReset = resetAt > 0 || lastResetAtRef.current > 0;
            lastResetAtRef.current = resetAt;
            if (shouldReset) {
                attemptTokenRef.current = null;
                attemptInProgressRef.current = false;
                resetLevel();
                setCode(initialCode);
            }
        }
    }, [resetAt, resetLevel]);

    useEffect(() => {
        const handlePageLeave = () => {
            const activeToken = attemptTokenRef.current;
            if (activeToken) {
                const verdict: AttemptVerdict = pendingVerdictRef.current ?? { outcome: 'defeat' };
                attemptTokenRef.current = null;
                attemptInProgressRef.current = false;
                pendingVerdictRef.current = null;
                finishAttemptSync({ token: activeToken, outcome: verdict.outcome, points: verdict.points });
            }
        };

        window.addEventListener('beforeunload', handlePageLeave);
        window.addEventListener('pagehide', handlePageLeave);

        return () => {
            window.removeEventListener('beforeunload', handlePageLeave);
            window.removeEventListener('pagehide', handlePageLeave);
            handlePageLeave();
        };
    }, [finishAttemptSync]);

    return (
        <LevelLayout
            level={LEVEL_NUMBER}
            attempts={attempts}
            code={code}
            onCodeChange={setCode}
            editorDisabled={isExecuting || isAnimating}
            onRun={executeCode}
            onReset={resetLevel}
            resetDisabled={isExecuting}
            runDisabled={isExecuting || isAnimating}
            editorExtra={
                <div className="bg-yellow-100 px-3 py-1 rounded border border-yellow-300 text-yellow-800 font-bold">
                    🔑 Ключі: {collectedKeysNow.size} / {TOTAL_KEYS}
                </div>
            }
            showRules={showRules}
            onShowRules={() => setShowRules(true)}
            onHideRules={() => setShowRules(false)}
            rulesTitle="📜 Правила рівня 6: Об'єкти та Ключі"
            rulesContent={
                <ul className="list-disc pl-4 space-y-1">
                    <li>🎯 <strong>Мета:</strong> Зібрати всі ключі (🔑) і дійти до фінішу.</li>
                    <li>👾 <strong>Небезпека:</strong> На шляху 3 вороги! Обійди їх.</li>
                    <li>📦 <strong>Об&apos;єкти:</strong> <code>{`{ command: 'move', steps: 4 }`}</code> — масив <code>instructions</code> рівень передає твоєму коду. У поворотів теж є <code>steps: 1</code>.</li>
                    <li>🔍 <strong>Перевірка:</strong> код запускається ще й з іншими інструкціями — тож він має читати <code>command</code> і <code>steps</code>, а не повторювати маршрут вручну.</li>
                    <li>❤️ У тебе є 3 життя. Кожна невдала спроба забирає 1 життя!</li>
                </ul>
            }
            isVictory={isVictory}
            victory={{
                subtitle: 'Всі вороги пройдені!',
                description: 'Справжній майстер маневрів! 🗝️🚀',
                nextLevelHref: '/Levels/level7',
                showHomeLink: true,
            }}
            isDefeat={isDefeat}
            defeatSubtitle={defeatReason}
            log={log}
            gridClassName="w-full md:w-[500px]"
        >
            <GridRenderer
                gridMap={gridMap}
                cols={8}
                cellSize={CELL}
                gap={GAP}
                robotPos={dp}
                getCell={(cell, x, y) => {
                    if (cell === 'key') {
                        return { style: 'bg-yellow-50 border-yellow-200', content: collectedKeysNow.has(`${x},${y}`) ? '' : '🔑' };
                    }
                    return null;
                }}
            />
        </LevelLayout>
    );
}
