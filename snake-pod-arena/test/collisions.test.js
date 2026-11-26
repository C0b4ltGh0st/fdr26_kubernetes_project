'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { Game, COLS, ROWS } = require('../src/game');
const { chooseMove } = require('../src/ai');

function addSnake(game, name, cells, [x, y]) {
  const snake = game.addSnake(name, game.snakes.size);
  snake.body = cells.map(([x, y]) => ({ x, y }));
  snake.dir = { x, y };
  snake.alive = true;
  return snake;
}

test('a shorter snake survives a side hit against a longer snake', () => {
  const game = new Game({ maxFood: 0, maxDeaths: 1 });
  const target = addSnake(game, 'target', [[5, 3], [5, 4], [5, 5]], [0, -1]);
  const attacker = addSnake(game, 'attacker', [[4, 4]], [1, 0]);
  const defeatedColumn = { body: target.body, color: target.color, dir: target.dir };

  game.step();

  assert.deepEqual(attacker.body[0], { x: 5, y: 4 });
  assert.equal(attacker.deaths, 0);
  assert.equal(target.deaths, 1);
  assert.deepEqual(game.collisionEffects, {
    impacts: [{ x: 5, y: 4 }],
    defeated: [defeatedColumn],
  });

  game.step();
  assert.deepEqual(game.collisionEffects, { impacts: [], defeated: [] });
});

for (const [headX, collision, impactX] of [[6, 'entering the same cell', 5], [5, 'swapping cells', 4.5]]) {
  test(`the longer snake wins when heads collide by ${collision}`, () => {
    const game = new Game({ maxFood: 0, maxDeaths: 1 });
    const shorter = addSnake(game, 'shorter', [[4, 4], [3, 4]], [1, 0]);
    const longer = addSnake(game, 'longer', [[headX, 4], [headX + 1, 4], [headX + 2, 4]], [-1, 0]);

    game.step();

    assert.deepEqual(longer.body[0], { x: headX - 1, y: 4 });
    assert.equal(longer.deaths, 0);
    assert.equal(shorter.deaths, 1);
    assert.deepEqual(game.collisionEffects.impacts, [{ x: impactX, y: 4 }]);
    assert.deepEqual(game.collisionEffects.defeated.map(column => column.color), [shorter.color]);
  });

  test(`equal-length snakes both die when heads collide by ${collision}`, () => {
    const game = new Game({ maxFood: 0, maxDeaths: 1 });
    const left = addSnake(game, 'left', [[4, 4], [3, 4]], [1, 0]);
    const right = addSnake(game, 'right', [[headX, 4], [headX + 1, 4]], [-1, 0]);

    game.step();

    assert.equal(left.deaths, 1);
    assert.equal(right.deaths, 1);
    assert.deepEqual(game.collisionEffects.impacts, [{ x: impactX, y: 4 }]);
    assert.deepEqual(game.collisionEffects.defeated.map(column => column.color), [left.color, right.color]);
  });
}

test('a bot goes for an open side hit against a longer snake', () => {
  const game = new Game({ maxFood: 0, maxDeaths: 1 });
  const bot = addSnake(game, 'bot', [[4, 4]], [1, 0]);
  const target = addSnake(game, 'target', [[5, 3], [5, 4], [5, 5]], [0, -1]);
  const world = { cols: COLS, rows: ROWS, snakes: [bot, target], foods: [] };

  assert.deepEqual(chooseMove(world, bot.name), { x: 1, y: 0 });
});
