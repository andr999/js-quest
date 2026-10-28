// Рівень 2: Покрокове виконання з генераторами
"use client";
import { useCallback, useState, useRef, useEffect } from 'react';
import { useGame, type AttemptToken, type AttemptVerdict } from '@/app/context/GameContext';
import LevelLayout from '@/components/LevelLayout';
import GridRenderer from '@/components/GridRenderer';
import { useResponsiveCell } from '@/hooks/useResponsiveCell';
import { useSteppedExecution, type RobotGenerator } from '@/hooks/useSteppedExecution';
import { LEVELS_CONFIG, computeLevelScore } from '@/utils/levelsConfig';
import {
    checkRunnableCode,
    createSandboxGenerator,
    getSandboxPlaybackEvents,
    runCodeInSandbox,
    type SandboxEvent,
    type SandboxResult,
} from '@/utils/sandboxRunner';

const initialCode = `// Напиши свій код тут!
// ⭐ Рівень 2: Покрокове виконання!

// Доступні команди: move(), turnLeft(), turnRight()
// Умовні функції: canMove(), isWallAhead(), isGoalReached()

// 💡 Підказка: використовуй цикли та умови!
// while (!isGoalReached()) {
//   if (canMove()) {
//     move();
//   } else {
//     turnRight();
//   }
// }

// Твій код тут:
`;

const LEVEL_NUMBER = 2;
const CONFIG = LEVELS_CONFIG[LEVEL_NUMBER];
const gridMap = CONFIG.gridMap;
const INIT_POS = CONFIG.initialPos;

export default function Level2() {
    const [code, setCode] = useState(initialCode);
    const [position, setPosition] = useState(INIT_POS);
    const [log, setLog] = useState<string[]>([]);
    const [showRules, setShowRules] = useState(true);
    const [isVictory, setIsVictory] = useState(false);
    const [isDefeat, setIsDefeat] = useState(false);
    const [stepCount, setStepCount] = useState(0);

    const [defeatReason, setDefeatReason] = useState('');
    const { getAttempts, startAttempt, finishAttempt: finishAttemptTransaction, finishAttemptSync, storageKey, resetAt } = useGame();
    const { cellSize: CELL, gap: GAP } = useResponsiveCell(56, 40);

    const attempts = getAttempts(LEVEL_NUMBER);
    const resultRef = useRef<SandboxResult | null>(null);
    const attemptTokenRef = useRef<AttemptToken | null>(null);
    const pendingVerdictRef = useRef<AttemptVerdict | null>(null);
    const attemptInProgressRef = useRef(false);

    const applyEvent = (event: SandboxEvent) => {
        if (event.type === 'robot') {
            setPosition({ ...event.pos });
            setStepCount(event.step);
            const suffix = event.message ? ` [${event.message}]` : '';
            setLog(prev => [...prev, `(${event.pos.x}, ${event.pos.y}) ${event.pos.dir}${suffix}`]);
        } else if (event.type === 'console') {
            setLog(prev => [...prev, event.message]);
        }
    };

    const setup = async (signal: AbortSignal): Promise<RobotGenerator | null> => {
        const preflightError = checkRunnableCode(code);
        if (preflightError) {
            setLog([`⚠️ ${preflightError}`]);
            return null;
        }
        const attemptToken = startAttempt(LEVEL_NUMBER);
        if (!attemptToken) return null;
        attemptTokenRef.current = attemptToken;
        attemptInProgressRef.current = true;
        const newAttempts = attempts + 1;
        setIsVictory(false);
        setIsDefeat(false);
        setDefeatReason('');
        setLog([]);
        setStepCount(0);
        setPosition(INIT_POS);

        const result = await runCodeInSandbox({
            code,
            gridMap,
            initialPos: INIT_POS,
            mode: 'conditional',
            throwOnOutOfBounds: true,
        });
        if (signal.aborted || attemptTokenRef.current?.attemptId !== attemptToken.attemptId) return null;
        resultRef.current = result;
        const isWin = result.ok && gridMap[result.finalPos.y]?.[result.finalPos.x] === 'goal';
        pendingVerdictRef.current = isWin
            ? { outcome: 'victory', points: computeLevelScore(CONFIG, result.steps, newAttempts), finalPos: result.finalPos }
            : { outcome: 'defeat' };
        return createSandboxGenerator(getSandboxPlaybackEvents(result), applyEvent);
    };

    const execution = useSteppedExecution({
        setup,
        onComplete: () => {
            attemptInProgressRef.current = false;
            const result = resultRef.current;
            const attemptToken = attemptTokenRef.current;
            const verdict = pendingVerdictRef.current;
            attemptTokenRef.current = null;
            pendingVerdictRef.current = null;
            if (!result || !attemptToken) return;
            setPosition({ ...result.finalPos });
            setStepCount(result.steps);
            if (!result.ok) {
                const reason = result.error ?? 'Помилка виконання.';
                setDefeatReason(reason);
                setLog(prev => [...prev, `❌ ${reason}`]);
                setIsDefeat(true);
                finishAttemptTransaction({ token: attemptToken, outcome: 'defeat' });
            } else if (verdict?.outcome === 'victory') {
                const success = finishAttemptTransaction({ token: attemptToken, outcome: 'victory', points: verdict.points });
                if (success) {
                    setIsVictory(true);
                    setIsDefeat(false);
                }
            } else {
                const reason = 'Робот не дістався фінішу!';
                setDefeatReason(reason);
                setLog(prev => [...prev, `⚠️ ${reason}`]);
                setIsDefeat(true);
                finishAttemptTransaction({ token: attemptToken, outcome: 'defeat' });
            }
        },
        onError: (err) => {
            attemptInProgressRef.current = false;
            const attemptToken = attemptTokenRef.current;
            attemptTokenRef.current = null;
            pendingVerdictRef.current = null;
            const reason = `Runtime Error: ${err.message}`;
            setDefeatReason(reason);
            setIsDefeat(true);
            setLog(prev => [...prev, `❌ ${reason}`]);
            if (attemptToken) {
                finishAttemptTransaction({ token: attemptToken, outcome: 'defeat' });
            }
        },
        speed: 200,
    });

    const resetExecution = execution.reset;
    const getExecutionState = execution.getExecutionState;

    const resetLevel = useCallback(() => {
        const wasActive = attemptInProgressRef.current;
        const wasPaused = getExecutionState() === 'paused';
        const activeToken = attemptTokenRef.current;
        const verdict: AttemptVerdict = pendingVerdictRef.current ?? { outcome: 'defeat' };
        attemptTokenRef.current = null;
        attemptInProgressRef.current = false;
        pendingVerdictRef.current = null;
        if (wasActive && activeToken && verdict.outcome === 'victory') {
            const result = resultRef.current;
            resetExecution();
            const success = finishAttemptTransaction({ token: activeToken, outcome: 'victory', points: verdict.points });
            if (success) {
                if (result) {
                    setPosition({ ...result.finalPos });
                    setStepCount(result.steps);
                } else if (verdict.finalPos) {
                    setPosition({ ...verdict.finalPos });
                }
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
        setStepCount(0);
        resultRef.current = null;
        resetExecution();
        if (wasActive && activeToken && verdict.outcome !== 'victory') {
            finishAttemptTransaction({
                token: activeToken,
                outcome: wasPaused ? 'cancelled' : verdict.outcome,
                points: verdict.points,
            });
        }
    }, [finishAttemptTransaction, getExecutionState, resetExecution]);

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
            onCodeChange={(nextCode) => {
                if (getExecutionState() === 'paused') resetLevel();
                setCode(nextCode);
            }}
            editorDisabled={execution.isPreparing || execution.executionState === 'running'}
            editorDark
            currentLine={execution.currentLine}
            onRun={execution.handleRun}
            runDisabled={execution.isPreparing}
            onReset={resetLevel}
            resetDisabled={execution.isPreparing}
            isRunning={execution.executionState === 'running'}
            onPause={execution.pause}
            onStep={execution.handleStep}
            stepDisabled={execution.isPreparing || execution.executionState === 'running'}
            showRules={showRules}
            onShowRules={() => setShowRules(true)}
            onHideRules={() => setShowRules(false)}
            rulesTitle="📜 Правила рівня 2: Покрокове виконання"
            rulesContent={
                <ul className="list-disc pl-4 space-y-1">
                    <li>🎯 <strong>Мета:</strong> допоможи 🤖 роботу дістатися до 🎯 фінішу.</li>
                    <li>⌨️ Доступні команди: <code>move()</code>, <code>turnRight()</code>, <code>turnLeft()</code></li>
                    <li>🧠 Умовні функції: <code>canMove()</code>, <code>isWallAhead()</code>, <code>isGoalReached()</code></li>
                    <li>▶️ Натисни <strong>Запустити</strong> для автоматичного виконання або <strong>Крок</strong> для покрокового.</li>
                    <li>❤️ У тебе є 3 життя. Кожна невдала спроба забирає 1 життя!</li>
                </ul>
            }
            isVictory={isVictory}
            victory={{
                subtitle: 'Ви пройшли рівень 2!',
                description: 'Покрокове виконання освоєно! 🤖✨',
                nextLevelHref: '/Levels/level3',
                showHomeLink: true,
            }}
            isDefeat={isDefeat}
            defeatSubtitle={defeatReason || 'Робот вийшов за межі поля!'}
            log={log}
            stepCount={stepCount}
            logDark
            gridClassName="w-full md:w-[400px]"
        >
            <GridRenderer
                gridMap={gridMap}
                cols={6}
                cellSize={CELL}
                gap={GAP}
                robotPos={position}
            />
        </LevelLayout>
    );
}
