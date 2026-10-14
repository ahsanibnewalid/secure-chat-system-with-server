'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { validUsername, validPassword } = require('../src/validation');
const { hashPassword, verifyPassword, openStore } = require('../src/store');

test('username validation rejects malformed and oversized names', () => {
  assert.equal(validUsername('lab_user9'), true);
  assert.equal(validUsername('ab'), false);
  assert.equal(validUsername('bad-name'), false);
  assert.equal(validUsername('x'.repeat(25)), false);
  assert.equal(validUsername(null), false);
});

test('password policy enforces 12–128 UTF-8 bytes', () => {
  assert.equal(validPassword('correct horse battery'), true);
  assert.equal(validPassword('short'), false);
  assert.equal(validPassword('x'.repeat(129)), false);
  assert.equal(validPassword(null), false);
});

test('password hashes verify correctly and use independent salts', () => {
  const one = hashPassword('correct horse battery');
  const two = hashPassword('correct horse battery');
  assert.notEqual(one.salt, two.salt);
  assert.notEqual(one.hash, two.hash);
  assert.equal(verifyPassword('correct horse battery', one.salt, one.hash), true);
  assert.equal(verifyPassword('wrong password', one.salt, one.hash), false);
});

test('SQLite enables foreign keys and enforces allowed account roles', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scsp-security-'));
  let db;
  try {
    db = openStore(dir);
    assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
    assert.throws(() => db.prepare(
      "INSERT INTO users(id,username,salt,password_hash,role,created_at) VALUES(?,?,?,?,?,?)"
    ).run('id-1', 'test_user', 'salt', 'hash', 'superuser', new Date().toISOString()));
    assert.throws(() => db.prepare(
      "INSERT INTO sessions(token_hash,user_id,created_at,expires_at) VALUES(?,?,?,?)"
    ).run('token-hash', 'missing-user', new Date().toISOString(), Date.now() + 60000));
  } finally {
    if (db) db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
