import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { geometryImage, geometryAnswer } from '../live/visual-fixture.ts';
import { sha256 } from '../../src/orchestration/requests.ts';

test('OFFLINE visual fixture: deterministic RGB pixels and conservative answer rubric, not a live vision test', async () => {
  const image = await geometryImage(); assert.equal(sha256(image), sha256(await geometryImage()));
  const { data, info } = await sharp(image).raw().toBuffer({ resolveWithObject: true });
  const pixel = (x: number, y: number) => [...data.subarray((y * info.width + x) * 3, (y * info.width + x) * 3 + 3)];
  assert.deepEqual(pixel(48, 56), [255, 0, 0]); assert.deepEqual(pixel(130, 56), [0, 0, 255]); assert.deepEqual(pixel(0, 0), [255, 255, 255]);
  for (const first of ['红色圆形，蓝色正方形。', '- 红色圆形\n- 蓝色方块', '图中有一个红色的圆和一个蓝色的正方形。',
    '图中有两个形状：左边是红色圆形，右边是蓝色正方形。', '图中左边是红色圆形，右边是蓝色正方形。',
    '1. 红色圆形\n2. 蓝色方块']) assert.equal(geometryAnswer(first, '红色。'), 'matches');
  for (const first of ['不是红色圆形，是蓝色方块', '蓝色圆形，红色方块。', '可能是红色圆形和蓝色方块', '']) assert.equal(geometryAnswer(first, '红色'), 'uncertain');
  assert.equal(geometryAnswer('红色圆形和蓝色方块', '蓝色'), 'uncertain');
});
