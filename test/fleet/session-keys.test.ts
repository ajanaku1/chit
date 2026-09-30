import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_SALT, accountSalt } from "../../src/fleet/session-keys.js";

test("accountSalt: the first account keeps the salt every existing account was made with; each next one is its own, fixed", () => {
  assert.equal(accountSalt(0), DEFAULT_SALT);
  assert.notEqual(accountSalt(1), DEFAULT_SALT);
  assert.notEqual(accountSalt(1), accountSalt(2));
  assert.equal(accountSalt(3), accountSalt(3));
});
