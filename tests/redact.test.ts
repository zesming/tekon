import test from "node:test";
import assert from "node:assert/strict";
import { redactSensitive } from "../src/redact.js";

test("redacts quoted sensitive values with spaces", () => {
  const redacted = redactSensitive(
    'SECRET="abc def" password: "input pass" --token "flag token" OPENAI_API_KEY sk-quoted',
  );

  assert.doesNotMatch(redacted, /abc|def|input pass|flag token|sk-quoted/);
  assert.match(redacted, /REDACTED/);
});
