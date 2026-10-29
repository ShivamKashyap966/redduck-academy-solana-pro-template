import { assert } from "chai";
import {
  Ed25519Program,
  Keypair,
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
} from "@solana/web3.js";

import { oneToken, tokenBalance } from "../helpers";
import { VaultFixture, setupVault } from "./fixture";
import {
  fakeInstructionsSysvar,
  withdraw,
  withdrawalMessage,
} from "./actions";

const amount = () => oneToken().muln(100);

const catchError = async (
  promise: Promise<unknown>,
  expectedCode: string,
): Promise<void> => {
  let err: Error | null = null;
  try {
    await promise;
  } catch (e) {
    err = e as Error;
  }
  assert.isNotNull(err, "withdraw must fail");
  assert.include(
    err!.toString(),
    expectedCode,
    "withdraw must fail at the expected check",
  );
};

describe("02-find-the-root-of-trust", () => {
  let env: VaultFixture;

  beforeEach(async () => {
    env = await setupVault();
  });

  it("pays out a withdrawal the oracle signed", async () => {
    const before = await tokenBalance(env.context, env.payerTokens);
    await withdraw(env, amount(), env.payerTokens);
    const after = await tokenBalance(env.context, env.payerTokens);

    assert.equal((after - before).toString(), amount().toString());
    assert.equal(
      (await tokenBalance(env.context, env.vault)).toString(),
      oneToken().muln(900).toString(),
    );
  });

  it("rejects an exploit with a caller-created instructions sysvar account", async () => {
    // The exploit test from the vulnerable version: an attacker signs their own
    // message and places it in an account imitating the sysvar.
    const attacker = Keypair.generate();
    env.context.setAccount(attacker.publicKey, {
      lamports: 10_000_000_000,
      data: Buffer.alloc(0),
      owner: PublicKey.default,
      executable: false,
      rentEpoch: 0,
    });

    const fakeAllowlist = Keypair.generate();
    const fakeCheck = Ed25519Program.createInstructionWithPrivateKey({
      privateKey: attacker.secretKey,
      message: withdrawalMessage(env.vault, env.payerTokens, amount()),
    });
    const fakeSysvar = Keypair.generate();
    env.context.setAccount(fakeSysvar.publicKey, {
      lamports: 1_000_000,
      data: fakeInstructionsSysvar(fakeCheck),
      owner: new PublicKey("Sysvar1111111111111111111111111111111111111"),
      executable: false,
      rentEpoch: 0,
    });

    const before = await tokenBalance(env.context, env.payerTokens);
    const vaultBefore = await tokenBalance(env.context, env.vault);

    // Against the fixed program, this must be rejected at the sysvar check
    await catchError(
      withdraw(
        env,
        amount(),
        env.payerTokens,
        attacker,
        fakeAllowlist.publicKey,
        fakeSysvar.publicKey,
      ),
      "0x1777", // WrongInstructionsSysvar
    );

    assert.equal(
      (await tokenBalance(env.context, env.vault)).toString(),
      vaultBefore.toString(),
      "vault must remain untouched",
    );
    assert.equal(
      (await tokenBalance(env.context, env.payerTokens)).toString(),
      before.toString(),
      "recipient balance must remain untouched",
    );
  });

  it("rejects an instructions account that is not the real sysvar", async () => {
    // The oracle's signature is valid and the message matches: the only wrong
    // thing is that the sysvar-shaped data sits in an account of someone else.
    const fakeCheck = Ed25519Program.createInstructionWithPrivateKey({
      privateKey: env.oracle.secretKey,
      message: withdrawalMessage(env.vault, env.payerTokens, amount()),
    });
    const fakeSysvar = Keypair.generate();
    env.context.setAccount(fakeSysvar.publicKey, {
      lamports: 1_000_000,
      data: fakeInstructionsSysvar(fakeCheck),
      owner: new PublicKey("Sysvar1111111111111111111111111111111111111"),
      executable: false,
      rentEpoch: 0,
    });

    const vaultBefore = await tokenBalance(env.context, env.vault);
    await catchError(
      withdraw(
        env,
        amount(),
        env.payerTokens,
        env.oracle,
        env.allowlist,
        fakeSysvar.publicKey,
      ),
      "0x1777", // WrongInstructionsSysvar
    );

    assert.equal(
      (await tokenBalance(env.context, env.vault)).toString(),
      vaultBefore.toString(),
    );
  });

  it("rejects a signer that is not in the config", async () => {
    // Real sysvar, real signature, correct message — but the key is not one
    // the config holds.
    const intruder = Keypair.generate();
    env.context.setAccount(intruder.publicKey, {
      lamports: 10_000_000_000,
      data: Buffer.alloc(0),
      owner: PublicKey.default,
      executable: false,
      rentEpoch: 0,
    });

    const fakeAllowlist = Keypair.generate();
    const vaultBefore = await tokenBalance(env.context, env.vault);
    await catchError(
      withdraw(
        env,
        amount(),
        env.payerTokens,
        intruder,
        fakeAllowlist.publicKey,
        SYSVAR_INSTRUCTIONS_PUBKEY,
      ),
      "0x1775", // KeyNotAllowed
    );

    assert.equal(
      (await tokenBalance(env.context, env.vault)).toString(),
      vaultBefore.toString(),
    );
  });

  it("rejects a message that does not match the withdrawal", async () => {
    // The oracle signs over 200 tokens while the instruction withdraws 100.
    const wrongMessage = withdrawalMessage(
      env.vault,
      env.payerTokens,
      oneToken().muln(200),
    );

    const vaultBefore = await tokenBalance(env.context, env.vault);
    await catchError(
      withdraw(
        env,
        amount(),
        env.payerTokens,
        env.oracle,
        env.allowlist,
        SYSVAR_INSTRUCTIONS_PUBKEY,
        wrongMessage,
      ),
      "0x1776", // MessageMismatch
    );

    assert.equal(
      (await tokenBalance(env.context, env.vault)).toString(),
      vaultBefore.toString(),
    );
  });
});
