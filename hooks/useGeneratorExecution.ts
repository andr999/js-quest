'use client';

import { useState, useRef, useEffect, useCallback } from 'react';

export type ExecutionState = 'idle' | 'running' | 'paused' | 'finished';

export type GeneratorYield = { type: 'line', line: number } | void;
export type RobotGenerator = Generator<GeneratorYield, void, unknown>;

interface UseGeneratorExecutionOptions {
  /** Called when generator completes (result.done === true) */
  onComplete: () => void;
  /** Called when generator throws */
  onError: (err: Error) => void;
  /** Delay between steps in auto-run mode (ms, default 200) */
  speed?: number;
}

export function useGeneratorExecution(options: UseGeneratorExecutionOptions) {
  // Store callbacks in refs to always call the latest version (prevents stale closures)
  const onCompleteRef = useRef(options.onComplete);
  const onErrorRef = useRef(options.onError);
  onCompleteRef.current = options.onComplete;
  onErrorRef.current = options.onError;

  const [executionState, setExecutionStateValue] = useState<ExecutionState>('idle');
  // The same state, readable synchronously: a click handled before React re-renders (e.g. right
  // after start()) must see 'paused', not the 'idle' of its render.
  const stateRef = useRef<ExecutionState>('idle');
  const setExecutionState = useCallback((next: ExecutionState | ((prev: ExecutionState) => ExecutionState)) => {
    const value = typeof next === 'function' ? next(stateRef.current) : next;
    stateRef.current = value;
    setExecutionStateValue(value);
  }, []);
  const getExecutionState = useCallback(() => stateRef.current, []);
  const [currentLine, setCurrentLine] = useState<number | null>(null);
  const generatorRef = useRef<RobotGenerator | null>(null);
  const [tick, setTick] = useState(0);

  /** Execute one generator step. Returns true if generator can continue. */
  const step = useCallback((): boolean => {
    const gen = generatorRef.current;
    if (!gen) return false;
    try {
      const result = gen.next();
      if (result.done) {
        generatorRef.current = null;
        setExecutionState('finished');
        setCurrentLine(null);
        onCompleteRef.current();
        return false;
      }
      if (result.value?.type === 'line') {
        setCurrentLine(result.value.line);
      }
      setTick(t => t + 1);
    } catch (err) {
      generatorRef.current = null;
      setExecutionState('finished');
      setCurrentLine(null);
      onErrorRef.current(err instanceof Error ? err : new Error(String(err)));
      return false;
    }
    return true;
  }, [setExecutionState]);

  // Auto-run animation loop
  useEffect(() => {
    if (executionState !== 'running') return;
    const timer = setTimeout(() => {
      const ok = step();
      if (!ok) setExecutionState('finished');
    }, options.speed ?? 200);
    return () => clearTimeout(timer);
  }, [executionState, tick, step, options.speed, setExecutionState]);

  /** Initialize with a new generator (starts in paused state) */
  const start = useCallback((gen: RobotGenerator) => {
    generatorRef.current = gen;
    setCurrentLine(null);
    setTick(0);
    setExecutionState('paused');
  }, [setExecutionState]);

  /** Switch to auto-running mode */
  const run = useCallback(() => {
    setExecutionState('running');
  }, [setExecutionState]);

  /** Pause auto-running */
  const pause = useCallback(() => {
    setExecutionState(prev => prev === 'running' ? 'paused' : prev);
  }, [setExecutionState]);

  /** Execute a single step (pauses if currently running) */
  const stepOnce = useCallback(() => {
    setExecutionState(prev => prev === 'running' ? 'paused' : prev);
    step();
  }, [step, setExecutionState]);

  /** Reset to idle state */
  const reset = useCallback(() => {
    generatorRef.current = null;
    setExecutionState('idle');
    setCurrentLine(null);
    setTick(0);
  }, [setExecutionState]);

  return {
    executionState,
    getExecutionState,
    currentLine,
    start,
    run,
    pause,
    stepOnce,
    step,
    reset,
  };
}
