import { beforeEach, describe, expect, it } from "vitest";
import {
  STORAGE_KEY,
  WrongPassphraseError,
  adopt,
  clearStored,
  isUnlocked,
  lock,
  open,
  parseEnvelope,
  readStored,
  seal,
  startSession,
  storedEnvelope,
  unlockStored,
  writeStored,
} from "./vault";

// src/test/setup.ts starts every test with an unlocked session; these
// tests begin from nothing instead
beforeEach(() => lock());

describe("sealing", () => {
  it("round-trips a value under the passphrase", async () => {
    await startSession("correct horse");
    const envelope = await seal({ a: 1, secret: "hunter2" });
    expect((await open(envelope, "correct horse")).value).toEqual({ a: 1, secret: "hunter2" });
  });

  // the whole point: nothing readable at rest
  it("keeps the value out of the envelope in the clear", async () => {
    await startSession("correct horse");
    const text = JSON.stringify(await seal({ secret: "hunter2" }));
    expect(text).not.toContain("hunter2");
    expect(parseEnvelope(JSON.parse(text))).not.toBeNull();
  });

  it("refuses the wrong passphrase", async () => {
    await startSession("correct horse");
    const envelope = await seal({ a: 1 });
    await expect(open(envelope, "wrong horse")).rejects.toBeInstanceOf(WrongPassphraseError);
  });

  // aes-gcm authenticates: an edited file doesn't decrypt to garbage
  it("refuses a tampered envelope", async () => {
    await startSession("correct horse");
    const envelope = await seal({ a: 1 });
    const data = envelope.data.startsWith("A") ? `B${envelope.data.slice(1)}` : `A${envelope.data.slice(1)}`;
    await expect(open({ ...envelope, data }, "correct horse")).rejects.toBeInstanceOf(WrongPassphraseError);
  });

  it("uses a fresh iv every time", async () => {
    await startSession("correct horse");
    const [a, b] = [await seal(1), await seal(1)];
    expect(a.iv).not.toBe(b.iv);
    expect(a.data).not.toBe(b.data);
  });

  it("won't seal while locked", async () => {
    await expect(seal(1)).rejects.toThrow(/locked/);
  });
});

describe("parseEnvelope", () => {
  it("rejects anything that isn't one", () => {
    expect(parseEnvelope(null)).toBeNull();
    expect(parseEnvelope({ version: 14, nodes: [] })).toBeNull();
    expect(parseEnvelope({ format: "proxmox.computer/vault", v: 2 })).toBeNull();
  });
});

describe("the stored copy", () => {
  it("writes and reads back under the session", async () => {
    await startSession("pass phrase");
    expect(await writeStored({ step: "network" })).toBe(true);
    expect(await readStored()).toEqual({ step: "network" });
    expect(window.localStorage.getItem(STORAGE_KEY)).not.toContain("network");
  });

  it("unlocks what's stored after a reload", async () => {
    await startSession("pass phrase");
    await writeStored({ step: "storage" });
    lock();
    expect(isUnlocked()).toBe(false);
    expect(await readStored()).toBeNull();
    expect(await unlockStored("pass phrase")).toEqual({ step: "storage" });
    expect(isUnlocked()).toBe(true);
  });

  it("stays locked on a wrong passphrase", async () => {
    await startSession("pass phrase");
    await writeStored({ step: "storage" });
    lock();
    await expect(unlockStored("nope")).rejects.toBeInstanceOf(WrongPassphraseError);
    expect(isUnlocked()).toBe(false);
  });

  // another tab or an import sealed it under another passphrase — never
  // overwrite that without the visitor unlocking it first
  it("counts as locked when the store was sealed under another key", async () => {
    await startSession("first");
    await writeStored({ n: 1 });
    await startSession("second");
    expect(isUnlocked()).toBe(false);
    expect(await readStored()).toBeNull();
  });

  // encryption is async, so saves can finish out of order
  it("keeps the newest of overlapping saves", async () => {
    await startSession("pass phrase");
    await Promise.all([writeStored({ n: 1 }), writeStored({ n: 2 }), writeStored({ n: 3 })]);
    expect(await readStored()).toEqual({ n: 3 });
  });

  it("adopts an opened envelope's key", async () => {
    await startSession("theirs");
    const envelope = await seal({ from: "file" });
    lock();
    const opened = await open(envelope, "theirs");
    adopt(opened);
    await writeStored(opened.value);
    expect(storedEnvelope()?.salt).toBe(envelope.salt);
    expect(await readStored()).toEqual({ from: "file" });
  });

  it("clears", async () => {
    await startSession("pass phrase");
    await writeStored(1);
    clearStored();
    expect(storedEnvelope()).toBeNull();
  });

  it("reads a legacy plain save as nothing stored", () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 14, nodes: [] }));
    expect(storedEnvelope()).toBeNull();
  });
});
