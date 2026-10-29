import { type Direction } from './robotEngine';

export interface LevelConfig {
  levelNum: number;
  name: string;
  baseScore: number;
  optimalSteps: number;
  initialPos: { x: number; y: number; dir: Direction };
  gridMap: string[][];
}

export const LEVELS_CONFIG: Record<number, LevelConfig> = {
  1: {
    levelNum: 1,
    name: 'Змінні',
    baseScore: 100,
    optimalSteps: 4,
    initialPos: { x: 0, y: 0, dir: 'right' },
    gridMap: [
      ['robot', 'empty', 'empty', 'empty', 'goal'],
      ['wall', 'wall', 'wall', 'empty', 'wall'],
    ],
  },
  2: {
    levelNum: 2,
    name: 'Умови',
    baseScore: 100,
    optimalSteps: 9,
    initialPos: { x: 0, y: 0, dir: 'right' },
    // The way turns twice, and `if (canMove()) move(); else turnRight();` in a loop follows it.
    // The edge of the board is a wall for canMove(), so the map has no wall frame of its own.
    gridMap: [
      ['robot', 'path', 'path', 'path'],
      ['wall', 'wall', 'wall', 'path'],
      ['wall', 'goal', 'path', 'path'],
    ],
  },
  3: {
    levelNum: 3,
    name: 'Цикли',
    baseScore: 100,
    optimalSteps: 15,
    initialPos: { x: 0, y: 1, dir: 'right' },
    gridMap: [
      // From the key, the same "move or turn right" loop reaches the goal along the right edge.
      ['wall', 'empty', 'empty', 'key', 'empty', 'empty'],
      ['robot', 'empty', 'wall', 'empty', 'empty', 'empty'],
      ['wall', 'empty', 'wall', 'empty', 'empty', 'empty'],
      ['wall', 'empty', 'empty', 'empty', 'wall', 'goal'],
    ],
  },
  4: {
    levelNum: 4,
    name: 'Функції',
    baseScore: 100,
    optimalSteps: 25,
    initialPos: { x: 0, y: 0, dir: 'right' },
    gridMap: [
      ['robot', 'path', 'path', 'wall', 'key', 'wall', 'path', 'path'],
      ['wall', 'wall', 'path', 'path', 'path', 'wall', 'path', 'wall'],
      ['path', 'path', 'path', 'enemy', 'path', 'path', 'path', 'path'],
      ['path', 'wall', 'wall', 'wall', 'wall', 'wall', 'path', 'path'],
      ['path', 'path', 'path', 'enemy', 'path', 'door', 'path', 'path'],
      ['wall', 'wall', 'wall', 'wall', 'path', 'wall', 'wall', 'wall'],
      ['path', 'path', 'path', 'path', 'path', 'path', 'path', 'path'],
      ['goal', 'wall', 'wall', 'wall', 'wall', 'wall', 'wall', 'wall'],
    ],
  },
  5: {
    levelNum: 5,
    name: 'Масиви',
    baseScore: 100,
    optimalSteps: 41,
    initialPos: { x: 0, y: 0, dir: 'right' },
    gridMap: [
      ['robot', 'path', 'path', 'key', 'path', 'path', 'path', 'wall'],
      ['wall', 'wall', 'path', 'wall', 'wall', 'wall', 'path', 'wall'],
      ['path', 'path', 'path', 'enemy', 'path', 'key', 'path', 'wall'],
      ['wall', 'wall', 'path', 'wall', 'wall', 'wall', 'path', 'wall'],
      ['path', 'path', 'path', 'path', 'path', 'path', 'path', 'path'],
      ['path', 'wall', 'wall', 'wall', 'path', 'path', 'path', 'wall'],
      ['path', 'key', 'path', 'path', 'path', 'enemy', 'path', 'goal'],
    ],
  },
  6: {
    levelNum: 6,
    name: 'Об\'єкти',
    baseScore: 100,
    optimalSteps: 49,
    initialPos: { x: 0, y: 0, dir: 'right' },
    gridMap: [
      ['robot', 'path', 'path', 'wall', 'key', 'wall', 'path', 'path'],
      ['wall', 'wall', 'path', 'path', 'path', 'wall', 'wall', 'wall'],
      ['path', 'path', 'path', 'enemy', 'path', 'path', 'path', 'path'],
      ['wall', 'wall', 'wall', 'wall', 'wall', 'wall', 'wall', 'path'],
      ['key', 'path', 'path', 'path', 'path', 'enemy', 'path', 'path'],
      ['path', 'wall', 'wall', 'wall', 'path', 'path', 'path', 'wall'],
      ['path', 'path', 'path', 'enemy', 'path', 'path', 'path', 'key'],
      ['wall', 'wall', 'wall', 'wall', 'wall', 'wall', 'wall', 'goal'],
    ],
  },
  7: {
    levelNum: 7,
    name: 'DOM',
    baseScore: 100,
    optimalSteps: 20,
    initialPos: { x: 0, y: 0, dir: 'right' },
    gridMap: [
      // The only way to the goal goes over the platform.
      ['robot', 'terminal', 'door', 'path', 'path'],
      ['wall', 'wall', 'path', 'wall', 'path'],
      ['button', 'path', 'path', 'wall', 'wall'],
      ['wall', 'wall', 'platform', 'wall', 'path'],
      ['wall', 'path', 'path', 'path', 'goal'],
    ],
  },
};

/** Total number of playable levels — derived from the config (single source of truth). */
export const TOTAL_LEVELS = Object.keys(LEVELS_CONFIG).length;

/** Bonus awarded when the solution is within 1.5× the optimal step count. */
const EFFICIENCY_BONUS = 50;
/** Bonus awarded for solving the level on the first attempt. */
const FIRST_TRY_BONUS = 25;

/**
 * Shared scoring formula used by every level.
 * @param cfg      the level's config
 * @param steps    how many engine steps the solution took
 * @param attempts the attempt number on which the level was solved (1-based)
 */
export function computeLevelScore(cfg: LevelConfig, steps: number, attempts: number): number {
  let points = cfg.baseScore * cfg.levelNum;
  if (steps <= cfg.optimalSteps * 1.5) points += EFFICIENCY_BONUS;
  if (attempts === 1) points += FIRST_TRY_BONUS;
  return points;
}
