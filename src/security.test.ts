import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizePermissionMode,
  shouldAutoApproveTool,
  shouldAutoDenyConfirmation
} from "./security.js";

test("normalizes permission modes case-insensitively", () => {
  assert.equal(normalizePermissionMode("plan"), "plan");
  assert.equal(normalizePermissionMode("ACCEPTEDITS"), "acceptEdits");
  assert.equal(normalizePermissionMode("bypasspermissions"), "bypassPermissions");
  assert.equal(normalizePermissionMode("missing"), undefined);
});

test("permission modes decide automatic approval", () => {
  assert.equal(shouldAutoApproveTool("read", "default"), true);
  assert.equal(shouldAutoApproveTool("write", "default"), false);
  assert.equal(shouldAutoApproveTool("write", "acceptEdits"), true);
  assert.equal(shouldAutoApproveTool("execute", "acceptEdits"), false);
  assert.equal(shouldAutoApproveTool("execute", "bypassPermissions"), true);
});

test("dontAsk auto-denies confirmation prompts", () => {
  assert.equal(shouldAutoDenyConfirmation("dontAsk"), true);
  assert.equal(shouldAutoDenyConfirmation("default"), false);
});
