const test = require('node:test');
const assert = require('node:assert/strict');
const { distanceMeters } = require('./geo');

test('distance is zero for identical coordinates', () => {
  assert.equal(distanceMeters(33.3, 44.4, 33.3, 44.4), 0);
});
test('distance is symmetric and positive for different coordinates', () => {
  const a = distanceMeters(33.3, 44.4, 33.31, 44.41);
  const b = distanceMeters(33.31, 44.41, 33.3, 44.4);
  assert.ok(a > 0);
  assert.ok(Math.abs(a - b) < 0.001);
});
