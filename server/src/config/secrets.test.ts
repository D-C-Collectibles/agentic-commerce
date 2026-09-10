// Tests for #secrets-service: the `SECRETS_BACKEND` seam added on top of
// getSecret()/requireSecret()/getShardedSecret(). `SECRETS_BACKEND=env` (default) must
// behave identically to the pre-existing plain process.env reads; `SECRETS_BACKEND=ledger-ring`
// shells out to `wallet-cli ring decrypt --key <name>` (mocked here — no wallet-cli binary
// or Ledger device is required to run these tests), following the same
// `vi.hoisted` + `vi.mock` approach used for the Circle SDK in wallet.test.ts.

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const childProcessMockState = vi.hoisted(() => ({
  execFileSync: vi.fn<(...args: unknown[]) => string>(),
}));

vi.mock("node:child_process", () => ({
  execFileSync: childProcessMockState.execFileSync,
}));

// Fresh module instance per test so the ledger-ring in-memory cache (a module-level
// singleton) never leaks between tests.
async function freshSecrets() {
  vi.resetModules();
  return import("./secrets.js");
}

describe("#secrets-service SECRETS_BACKEND=env (default)", () => {
  const originalBackend = process.env.SECRETS_BACKEND;
  const originalJwtSecret = process.env.JWT_SECRET;
  const originalWorldRpSigningKey = process.env.WORLD_RP_SIGNING_KEY;

  beforeEach(() => {
    childProcessMockState.execFileSync.mockReset();
  });

  afterEach(() => {
    process.env.SECRETS_BACKEND = originalBackend;
    process.env.JWT_SECRET = originalJwtSecret;
    process.env.WORLD_RP_SIGNING_KEY = originalWorldRpSigningKey;
  });

  it("reads plain process.env when SECRETS_BACKEND is unset, unchanged from today", async () => {
    delete process.env.SECRETS_BACKEND;
    process.env.JWT_SECRET = "env-value";
    const { getSecret, SECRET_NAMES } = await freshSecrets();

    expect(getSecret(SECRET_NAMES.jwtSecret)).toBe("env-value");
    expect(childProcessMockState.execFileSync).not.toHaveBeenCalled();
  });

  it("reads plain process.env when SECRETS_BACKEND=env explicitly", async () => {
    process.env.SECRETS_BACKEND = "env";
    process.env.JWT_SECRET = "env-value-2";
    const { getSecret, SECRET_NAMES } = await freshSecrets();

    expect(getSecret(SECRET_NAMES.jwtSecret)).toBe("env-value-2");
    expect(childProcessMockState.execFileSync).not.toHaveBeenCalled();
  });

  it("requireSecret still throws its plain error when unset under env backend", async () => {
    delete process.env.SECRETS_BACKEND;
    delete process.env.WORLD_RP_SIGNING_KEY;
    const { requireSecret, SECRET_NAMES } = await freshSecrets();

    expect(() => requireSecret(SECRET_NAMES.worldRpSigningKey, "needed for world mode")).toThrow(
      /WORLD_RP_SIGNING_KEY is required \(needed for world mode\)/,
    );
  });
});

describe("#secrets-service SECRETS_BACKEND=ledger-ring", () => {
  const originalBackend = process.env.SECRETS_BACKEND;

  beforeEach(() => {
    childProcessMockState.execFileSync.mockReset();
    process.env.SECRETS_BACKEND = "ledger-ring";
  });

  afterAll(() => {
    process.env.SECRETS_BACKEND = originalBackend;
  });

  it("calls `wallet-cli ring decrypt --key <name>` and returns the decrypted value on success", async () => {
    childProcessMockState.execFileSync.mockReturnValue("decrypted-secret-value\n");
    const { getSecret, SECRET_NAMES } = await freshSecrets();

    const value = getSecret(SECRET_NAMES.circleEntitySecret);

    expect(value).toBe("decrypted-secret-value");
    expect(childProcessMockState.execFileSync).toHaveBeenCalledWith(
      "wallet-cli",
      ["ring", "decrypt", "--key", "CIRCLE_ENTITY_SECRET"],
      expect.objectContaining({ encoding: "utf8" }),
    );
  });

  it("caches the decrypted value so the CLI is only shelled out to once per key per process", async () => {
    childProcessMockState.execFileSync.mockReturnValue("cached-value");
    const { getSecret, SECRET_NAMES } = await freshSecrets();

    expect(getSecret(SECRET_NAMES.circleApiKey)).toBe("cached-value");
    expect(getSecret(SECRET_NAMES.circleApiKey)).toBe("cached-value");
    expect(getSecret(SECRET_NAMES.circleApiKey)).toBe("cached-value");

    expect(childProcessMockState.execFileSync).toHaveBeenCalledTimes(1);
  });

  it("throws naming the key, without leaking stderr/partial output, when the CLI exits non-zero", async () => {
    const cliError = new Error("some sensitive stderr output naming other ring keys");
    childProcessMockState.execFileSync.mockImplementation(() => {
      throw cliError;
    });
    const { getSecret, SECRET_NAMES } = await freshSecrets();

    let thrown: unknown;
    try {
      getSecret(SECRET_NAMES.jwtSecret);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain("JWT_SECRET");
    expect(message).not.toContain("sensitive stderr output");
  });

  it("throws naming the key when the CLI is not installed (ENOENT-style failure)", async () => {
    const enoentError = Object.assign(new Error("spawn wallet-cli ENOENT"), { code: "ENOENT" });
    childProcessMockState.execFileSync.mockImplementation(() => {
      throw enoentError;
    });
    const { getSecret, SECRET_NAMES } = await freshSecrets();

    expect(() => getSecret(SECRET_NAMES.worldRpSigningKey)).toThrow(/WORLD_RP_SIGNING_KEY/);
  });

  it("throws naming the key when the ring has no such key (empty stdout)", async () => {
    childProcessMockState.execFileSync.mockReturnValue("");
    const { getSecret, SECRET_NAMES } = await freshSecrets();

    expect(() => getSecret(SECRET_NAMES.jwtSecret)).toThrow(/JWT_SECRET/);
  });
});
