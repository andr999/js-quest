import type { Direction } from './robotEngine';

export type RobotCommand = 'move' | 'turnLeft' | 'turnRight';

export interface Instruction {
  command: RobotCommand;
  steps?: number;
}

/**
 * Levels 5 and 6 hand their command data (route, instructions) to the learner's code. The same code
 * is then also run on a hidden variant: other data on a board built for that data. Code that follows
 * the data reaches the variant's goal too; a route copied into the code by hand, in any form, does not.
 */
export interface DataVariant {
  gridMap: string[][];
  initialPos: { x: number; y: number; dir: Direction };
  /** Values passed to the learner's code under these names instead of the level's own data. */
  data: Record<string, unknown>;
  keys: number;
}

const DIRECTIONS: Direction[] = ['up', 'right', 'down', 'left'];
const DELTAS: Record<Direction, [number, number]> = { up: [0, -1], right: [1, 0], down: [0, 1], left: [-1, 0] };

function mirror(command: RobotCommand): RobotCommand {
  if (command === 'turnLeft') return 'turnRight';
  if (command === 'turnRight') return 'turnLeft';
  return command;
}

/** Each run length takes the value of the next one, so no segment keeps its length. */
function rotate(values: number[]): number[] {
  return values.map((_, i) => values[(i + 1) % values.length]);
}

/**
 * Same length and the same kinds of commands, but every turn goes the other way and every run of
 * moves takes the length of the next run: turns copied by hand fail, and so do segment lengths.
 */
export function routeVariant(route: readonly RobotCommand[]): RobotCommand[] {
  const runs: number[] = [];
  let length = 0;
  for (const command of route) {
    if (command === 'move') {
      length += 1;
    } else if (length > 0) {
      runs.push(length);
      length = 0;
    }
  }
  if (length > 0) runs.push(length);
  const lengths = rotate(runs);

  const variant: RobotCommand[] = [];
  let run = 0;
  let inRun = false;
  for (const command of route) {
    if (command !== 'move') {
      inRun = false;
      variant.push(mirror(command));
    } else if (!inRun) {
      inRun = true;
      for (let k = 0; k < lengths[run]; k += 1) variant.push('move');
      run += 1;
    }
  }
  return variant;
}

/** The same transformation for instruction objects: turns mirrored, `steps` passed on to the next move. */
export function instructionsVariant(instructions: readonly Instruction[]): Instruction[] {
  const steps = rotate(instructions.filter(i => i.command === 'move' && i.steps !== undefined).map(i => i.steps as number));
  let next = 0;
  return instructions.map((instruction) => {
    if (instruction.command !== 'move') return { ...instruction, command: mirror(instruction.command) };
    if (instruction.steps === undefined) return { ...instruction };
    return { ...instruction, steps: steps[next++] };
  });
}

export function expandInstructions(instructions: readonly Instruction[]): RobotCommand[] {
  return instructions.flatMap(i => Array<RobotCommand>(i.command === 'move' ? i.steps ?? 1 : 1).fill(i.command));
}

/**
 * A board on which `commands` is the way to the goal: the cells it passes are open, everything else
 * is wall, and `keys` keys lie along the way.
 */
export function boardForCommands(commands: readonly RobotCommand[], keys = 3): Pick<DataVariant, 'gridMap' | 'initialPos' | 'keys'> {
  let x = 0;
  let y = 0;
  let dir = 1;
  const visited: [number, number][] = [[0, 0]];
  for (const command of commands) {
    if (command === 'turnRight') dir = (dir + 1) % 4;
    else if (command === 'turnLeft') dir = (dir + 3) % 4;
    else {
      const [dx, dy] = DELTAS[DIRECTIONS[dir]];
      x += dx;
      y += dy;
      visited.push([x, y]);
    }
  }
  const minX = Math.min(...visited.map(c => c[0]));
  const minY = Math.min(...visited.map(c => c[1]));
  const width = Math.max(...visited.map(c => c[0])) - minX + 3;
  const height = Math.max(...visited.map(c => c[1])) - minY + 3;
  const gridMap = Array.from({ length: height }, () => Array<string>(width).fill('wall'));
  const cells = visited.map(([cx, cy]) => [cx - minX + 1, cy - minY + 1] as [number, number]);
  for (const [cx, cy] of cells) gridMap[cy][cx] = 'path';

  const [startX, startY] = cells[0];
  const [goalX, goalY] = cells[cells.length - 1];
  const taken = new Set([`${startX},${startY}`, `${goalX},${goalY}`]);
  let placed = 0;
  for (let k = 1; k <= keys; k += 1) {
    const startIdx = Math.floor((cells.length * k) / (keys + 1));
    for (let offset = 0; offset < cells.length; offset += 1) {
      const i = (startIdx + offset) % cells.length;
      const id = `${cells[i][0]},${cells[i][1]}`;
      if (taken.has(id)) continue;
      taken.add(id);
      gridMap[cells[i][1]][cells[i][0]] = 'key';
      placed += 1;
      break;
    }
  }
  gridMap[goalY][goalX] = 'goal';
  return { gridMap, initialPos: { x: startX, y: startY, dir: 'right' }, keys: placed };
}

export function routeDataVariant(name: string, route: readonly RobotCommand[], keys = 3): DataVariant {
  const variant = routeVariant(route);
  return { ...boardForCommands(variant, keys), data: { [name]: variant } };
}

export function instructionsDataVariant(name: string, instructions: readonly Instruction[], keys = 3): DataVariant {
  const variant = instructionsVariant(instructions);
  return { ...boardForCommands(expandInstructions(variant), keys), data: { [name]: variant } };
}
