// Рівень 1: Основи руху
"use client";
import { useCallback, useRef, useState, useEffect } from 'react';
import { useGame, type AttemptToken, type AttemptVerdict } from '@/app/context/GameContext';
import LevelLayout from '@/components/LevelLayout';
import GridRenderer from '@/components/GridRenderer';
import { usePathPlayback } from '@/hooks/usePathPlayback';
import { useResponsiveCell } from '@/hooks/useResponsiveCell';
import { checkRunnableCode, getSandboxPlaybackPath, runCodeInSandbox, type SandboxResult } from '@/utils/sandboxRunner';
import { LEVELS_CONFIG, computeLevelScore } from '@/utils/levelsConfig';

const initialCode = `// Напишіть код, щоб робот дістався до фінішу
// 💡 Ви можете використовувати змінні для керування роботом!

// Приклади:
// let steps = 4;                       // Створити змінну
// for (let i = 0; i < steps; i++) {    // Використати цикл
//   move();
// }
// repeat(4, () => { move(); });        // Повторити дію 4 рази

// Ваш код тут:
`;

const LEVEL_NUMBER = 1;
const CONFIG = LEVELS_CONFIG[LEVEL_NUMBER];
const gridMap = CONFIG.gridMap;
const INIT_POS = CONFIG.initialPos;

export default function Level1() {
    const [code, setCode] = useState(initialCode);
    const [position, setPosition] = useState(INIT_POS);
    const [log, setLog] = useState<string[]>([]);
    const [showRules, setShowRules] = useState(true);
    const [defeatReason, setDefeatReason] = useState('');
    const [isVictory, setIsVictory] = useState(false);
    const [isDefeat, setIsDefeat] = useState(false);
    const [isExecuting, setIsExecuting] = useState(false);
    const { getAttempts, startAttempt, finishAttempt: finishAttemptTransaction, finishAttemptSync, storageKey, resetAt } = useGame();
    const { play: playPath, current: animStep, isAnimating, stop: stopAnim } = usePathPlayback(150);
    const { cellSize: CELL, gap: GAP } = useResponsiveCell(48, 40);
    const attemptInProgressRef = useRef(false);
    const executionTokenRef = useRef(0);
    const attemptTokenRef = useRef<AttemptToken | null>(null);
    const pendingVerdictRef = useRef<AttemptVerdict | null>(null);
    const attempts = getAttempts(LEVEL_NUMBER);

    const dp = animStep || position;

    const finishAttempt = (result: SandboxResult, newAttempts: number, token: AttemptToken) => {
        const replayPath = getSandboxPlaybackPath(result);
        const path = replayPath.length > 0 ? replayPath : [{ ...INIT_POS }];
        const consoleLog = result.events
            .filter((e): e is Extract<typeof e, { type: 'console' }> => e.type === 'console')
            .map(e => `💬 ${e.message}`);
        const pathLog = path.map(p =>
            `(${p.x}, ${p.y}) ${p.dir}${p.outOfBounds ? ' [OUT OF BOUNDS]' : p.blocked ? ' [WALL]' : ''}`
        );
        const combinedLog = [...consoleLog, ...pathLog];
        setLog(result.ok || !result.error
            ? combinedLog
            : [...combinedLog, `❌ ${result.errorCode ?? 'ERROR'}: ${result.error}`]);

        const isWin = result.ok && gridMap[result.finalPos.y]?.[result.finalPos.x] === 'goal';
        const points = computeLevelScore(CONFIG, result.steps, newAttempts);
        pendingVerdictRef.current = isWin ? { outcome: 'victory', points, finalPos: result.finalPos } : { outcome: 'defeat' };

        playPath(path, () => {
            attemptInProgressRef.current = false;
            attemptTokenRef.current = null;
            pendingVerdictRef.current = null;
            setPosition(result.finalPos);

            if (!result.ok) {
                const reason = result.error ?? 'Помилка виконання.';
                setDefeatReason(reason);
                setIsVictory(false);
                setIsDefeat(true);
                finishAttemptTransaction({ token, outcome: 'defeat' });
                return;
            }

            if (isWin) {
                const success = finishAttemptTransaction({ token, outcome: 'victory', points });
                if (success) {
                    setIsVictory(true);
                    setIsDefeat(false);
                }
            } else {
                const reason = 'Робот не дістався фінішу!';
                setDefeatReason(reason);
                setIsDefeat(true);
                finishAttemptTransaction({ token, outcome: 'defeat' });
            }
        });
    };

    const executeCode = async () => {
        if (attemptInProgressRef.current || isAnimating) return;
        const preflightError = checkRunnableCode(code);
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
        setLog([]);
        setIsVictory(false);
        setIsDefeat(false);
        setDefeatReason('');

        try {
            const result = await runCodeInSandbox({
                code,
                gridMap,
                initialPos: INIT_POS,
                mode: 'basic',
                throwOnOutOfBounds: true,
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
            showRules={showRules}
            onShowRules={() => setShowRules(true)}
            onHideRules={() => setShowRules(false)}
            rulesTitle="📜 Правила рівня 1: Перші кроки"
            rulesContent={
                <ul className="list-disc pl-4 space-y-1">
                    <li>🎯 <strong>Мета:</strong> провести робота 🤖 до 🟩 фінішу.</li>
                    <li>⌨️ <code>move()</code> — зробити крок вперед.</li>
                    <li>🔄 <code>turnRight()</code> — повернути праворуч.</li>
                    <li>🔄 <code>turnLeft()</code> — повернути ліворуч.</li>
                    <li>🧱 Крізь стіни пройти не можна: робот залишиться на місці.</li>
                    <li>❤️ У тебе є 3 життя. Кожна невдала спроба забирає 1 життя!</li>
                </ul>
            }
            isVictory={isVictory}
            victory={{
                subtitle: 'Ти успішно дійшов до мети!',
                description: 'Робот дістався фінішу! 🤖✨',
                nextLevelHref: '/Levels/level2',
            }}
            isDefeat={isDefeat}
            defeatSubtitle={defeatReason || 'Робот не дістався до фінішу!'}
            log={log}
            gridClassName="w-full md:w-[300px]"
        >
            <GridRenderer
                gridMap={gridMap}
                cols={5}
                cellSize={CELL}
                gap={GAP}
                robotPos={dp}
                getCell={(cell) => {
                    if (cell === 'goal') return { style: 'bg-green-400 border-green-500', content: '🟩' };
                    return null;
                }}
            />
        </LevelLayout>
    );
}
