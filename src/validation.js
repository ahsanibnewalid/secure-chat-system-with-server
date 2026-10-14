'use strict';

function validUsername(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9_]{3,24}$/.test(value);
}

function validPassword(value) {
  return typeof value === 'string' &&
    Buffer.byteLength(value, 'utf8') >= 12 &&
    Buffer.byteLength(value, 'utf8') <= 128;
}

module.exports = { validUsername, validPassword };
