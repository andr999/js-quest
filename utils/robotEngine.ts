export type Direction = 'up' | 'right' | 'down' | 'left';

const DIRS: Direction[] = ['up', 'right', 'down', 'left'];

export function getDelta(dir: Direction): [number, number] {
  switch (dir) {
    case 'right': return [1, 0];
    case 'left':  return [-1, 0];
    case 'up':    return [0, -1];
    case 'down':  return [0, 1];
  }
}

/** Convert a direction to CSS rotation degrees */
export function getRotation(dir: Direction): number {
  switch (dir) {
    case 'right': return 0;
    case 'down':  return 90;
    case 'left':  return 180;
    case 'up':    return 270;
  }
}

/** Custom error thrown when the robot is killed by an enemy */
export class DeathError extends Error {
  constructor() {
    super('KILLED');
    this.name = 'DeathError';
  }
}

export interface RobotPos {
  x: number;
  y: number;
  dir: Direction;
  blocked?: boolean;
  outOfBounds?: boolean;
  killed?: boolean;
  keyPicked?: boolean;
}

export interface RobotEngineConfig {
  gridMap: string[][];
  initialPos: RobotPos;
  maxSteps?: number;
  /** Custom wall check — e.g. doors that are locked, platforms that are inactive */
  isWall?: (x: number, y: number) => boolean;
  /** If true, move() throws on out-of-bounds instead of calling onOutOfBounds and returning */
  throwOnOutOfBounds?: boolean;
  /** Called after step counter increments */
  onStep?: (steps: number) => void;
  /** Called when robot successfully moves to a new cell */
  onMove?: (pos: RobotPos, cellContent: string) => void;
  /** Called when robot is blocked by a wall */
  onBlocked?: (pos: RobotPos) => void;
  /** Called when robot tries to move out of bounds */
  onOutOfBounds?: (pos: RobotPos) => void;
  /** Called when robot turns */
  onTurn?: (pos: RobotPos) => void;
}

/**
 * @deprecated This standalone engine is not used in production. All learner-code execution,
 * grid checks, wall blocking, key pickups, and DOM virtual simulation are handled inside
 * `public/code-runner.worker.js` via `utils/sandboxRunner.ts`.
 */
export function createRobotEngine(config: RobotEngineConfig) {
  const { gridMap, maxSteps = 2000, throwOnOutOfBounds = false } = config;
  let pos: RobotPos = { ...config.initialPos };
  let steps = 0;

  const isOutOfBounds = (x: number, y: number) =>
    y < 0 || y >= gridMap.length || x < 0 || !gridMap[y] || x >= gridMap[y].length;

  const defaultIsWall = (x: number, y: number) => gridMap[y]?.[x] === 'wall';
  const checkWall = config.isWall ?? defaultIsWall;

  const checkStepLimit = () => {
    if (steps > maxSteps) {
      throw new Error('Занадто багато кроків! Можливо, нескінченний цикл.');
    }
  };

  const move = () => {
    steps++;
    config.onStep?.(steps);
    checkStepLimit();

    const [dx, dy] = getDelta(pos.dir);
    const nx = pos.x + dx;
    const ny = pos.y + dy;

    if (isOutOfBounds(nx, ny)) {
      pos = { ...pos, outOfBounds: true, blocked: true };
      config.onOutOfBounds?.(pos);
      if (throwOnOutOfBounds) throw new Error('OUT_OF_BOUNDS');
      return;
    }

    if (!checkWall(nx, ny)) {
      const cellContent = gridMap[ny]?.[nx] ?? 'path';
      pos = { ...pos, x: nx, y: ny, blocked: false, outOfBounds: false };
      config.onMove?.(pos, cellContent);
    } else {
      pos = { ...pos, blocked: true, outOfBounds: false };
      config.onBlocked?.(pos);
    }
  };

  const turnRight = () => {
    steps++;
    config.onStep?.(steps);
    checkStepLimit();
    pos = { ...pos, dir: DIRS[(DIRS.indexOf(pos.dir) + 1) % 4], blocked: false, outOfBounds: false };
    config.onTurn?.(pos);
  };

  const turnLeft = () => {
    steps++;
    config.onStep?.(steps);
    checkStepLimit();
    pos = { ...pos, dir: DIRS[(DIRS.indexOf(pos.dir) - 1 + 4) % 4], blocked: false, outOfBounds: false };
    config.onTurn?.(pos);
  };

  const isWallAhead = () => {
    const [dx, dy] = getDelta(pos.dir);
    const nx = pos.x + dx;
    const ny = pos.y + dy;
    return isOutOfBounds(nx, ny) || checkWall(nx, ny);
  };

  return {
    move,
    turnRight,
    turnLeft,
    isWallAhead,
    canMove: () => !isWallAhead(),
    isGoalReached: () => gridMap[pos.y]?.[pos.x] === 'goal',
    getPos: () => pos,
    getSteps: () => steps,
  };
}
