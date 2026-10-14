'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { hashPassword, verifyPassword } = require('../src/store');
const { validUsername, validPassword } = require('../src/server');

test('password hashes verify and use salts', () => {
  const a = hashPassword('a sufficiently long password');
  const b = hashPassword('a sufficiently long password');
  assert.notEqual(a.salt, b.salt);
  assert.notEqual(a.hash, b.hash);
  assert.equal(verifyPassword('a sufficiently long password', a.salt, a.hash), true);
  assert.equal(verifyPassword('wrong password', a.salt, a.hash), false);
});
test('username policy rejects malformed values', () => {
  assert.equal(validUsername('chat_user9'), true);
  for (const name of ['ab','has space','bad/name','',null,3]) assert.equal(validUsername(name), false);
});
test('password policy requires 12 to 128 bytes', () => {
  assert.equal(validPassword('123456789012'), true);
  assert.equal(validPassword('short'), false);
  assert.equal(validPassword('x'.repeat(129)), false);
  assert.equal(validPassword(null), false);
});
