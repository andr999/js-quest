'use client';
import { useRef, useCallback, useState, useMemo } from 'react';
import { useGeneratorExecution } from './useGeneratorExecution';
export type { RobotGenerator, ExecutionState } from './useGeneratorExecution';
import type { RobotGenerator } from './useGeneratorExecution';

interface UseSteppedExecutionOptions {
  setup: (signal: AbortSignal) => RobotGenerator | null | Promise<RobotGenerator | null>;
  onComplete: () => void;
  onError: (err: Error) => void;
  speed?: number;
}

/**
 * Wraps useGeneratorExecution with ready-made handleRun / handleStep that
 * manage the idle → running → finished state machine and call the setup
 * factory at the right moment. All three callbacks are stored in refs so
 * callers never need to worry about stale closures or dep arrays.
 */
export function useSteppedExecution({
  setup,
  onComplete,
  onError,
  speed,
}: UseSteppedExecutionOptions) {
  const execution = useGeneratorExecution({ onComplete, onError, speed });
  const [isPreparing, setIsPreparing] = useState(false);
  const isPreparingRef = useRef(false);
  const preparationIdRef = useRef(0);
  const preparationControllerRef = useRef<AbortController | null>(null);
  const setupErrorRef = useRef(onError);
  setupErrorRef.current = onError;

  // Always holds the latest setup function — updated every render.
  const setupRef = useRef(setup);
  setupRef.current = setup;

  const { getExecutionState, start, run, stepOnce, reset: resetExecution } = execution;

  const prepare = useCallback(async () => {
    preparationControllerRef.current?.abort();
    const controller = new AbortController();
    preparationControllerRef.current = controller;
    const preparationId = ++preparationIdRef.current;
    isPreparingRef.current = true;
    setIsPreparing(true);
    try {
      const generator = await setupRef.current(controller.signal);
      return !controller.signal.aborted && preparationId === preparationIdRef.current
        ? generator
        : null;
    } catch (error) {
      if (preparationId === preparationIdRef.current) {
        setupErrorRef.current(error instanceof Error ? error : new Error(String(error)));
      }
      return null;
    } finally {
      if (preparationId === preparationIdRef.current) {
        isPreparingRef.current = false;
        setIsPreparing(false);
      }
    }
  }, []);

  // The state is read from the ref, not from this render: a second click right after the first
  // run was prepared (before React re-renders) must continue that run, not prepare a new one and
  // spend another attempt.
  const handleRun = useCallback(async () => {
    if (isPreparingRef.current) return;
    const state = getExecutionState();
    if (state === 'idle' || state === 'finished') {
      const gen = await prepare();
      if (gen) { start(gen); run(); }
    } else {
      run();
    }
  }, [getExecutionState, prepare, start, run]);

  const handleStep = useCallback(async () => {
    if (isPreparingRef.current) return;
    const state = getExecutionState();
    if (state === 'idle' || state === 'finished') {
      const gen = await prepare();
      if (gen) { start(gen); stepOnce(); }
    } else {
      stepOnce();
    }
  }, [getExecutionState, prepare, start, stepOnce]);

  const reset = useCallback(() => {
    preparationControllerRef.current?.abort();
    preparationControllerRef.current = null;
    preparationIdRef.current += 1;
    isPreparingRef.current = false;
    setIsPreparing(false);
    resetExecution();
  }, [resetExecution]);

  return useMemo(() => ({
    ...execution,
    reset,
    isPreparing,
    handleRun,
    handleStep,
  }), [execution, reset, isPreparing, handleRun, handleStep]);
}
