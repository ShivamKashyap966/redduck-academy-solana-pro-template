import { assert } from "chai";
import { Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";

import { oneToken, toBN, tokenBalance } from "../helpers";
import { MAX_PRICE_AGE, RewardsFixture, setupRewards } from "./fixture";
import { accrue, buy, claim, setPrice } from "./actions";

const catchError = async (
  promise: Promise<unknown>,
  expectedError: string,
): Promise<void> => {
  let err: Error | null = null;
  try {
    await promise;
  } catch (e) {
    err = e as Error;
  }
  assert.isNotNull(err, "Operation must fail");
  assert.include(
    err!.toString(),
    expectedError,
    `Operation must fail with ${expectedError}`,
  );
};

describe("03-run-it-without-the-operator", () => {
  let env: RewardsFixture;

  beforeEach(async () => {
    env = await setupRewards();
  });

  it("claims a reward for a user and buys tokens without any operator/bot running", async () => {
    // 1. Admin accrues 100 tokens to user
    await accrue(env, env.user.publicKey, oneToken().muln(100));

    // 2. Stranger (neither admin nor bot) claims on behalf of the user
    await claim(
      env,
      env.user.publicKey,
      env.userTokens,
      env.stranger,
      env.strangerTokens,
    );

    // User receives 99 tokens (100 minus 1% caller fee)
    assert.equal(
      (await tokenBalance(env.context, env.userTokens)).toString(),
      oneToken().muln(99).toString(),
    );
    // Stranger receives 1 token as caller fee
    assert.equal(
      (await tokenBalance(env.context, env.strangerTokens)).toString(),
      oneToken().muln(1).toString(),
    );

    // 3. Stranger brings a signed pull price from the oracle: 1 token = 0.01 SOL
    await setPrice(env, toBN(LAMPORTS_PER_SOL / 100), undefined, env.stranger);

    // 4. Stranger buys tokens for 0.1 SOL (buys 10 tokens) with no bot involved
    await buy(
      env,
      env.stranger,
      env.strangerTokens,
      toBN(LAMPORTS_PER_SOL / 10),
    );

    // Stranger now has 1 (fee) + 10 (purchased) = 11 tokens
    assert.equal(
      (await tokenBalance(env.context, env.strangerTokens)).toString(),
      oneToken().muln(11).toString(),
    );
  });

  it("cannot claim twice for the same user", async () => {
    await accrue(env, env.user.publicKey, oneToken().muln(100));
    await claim(
      env,
      env.user.publicKey,
      env.userTokens,
      env.stranger,
      env.strangerTokens,
    );

    // Second claim must revert because user.pending was reset to 0
    await catchError(
      claim(
        env,
        env.user.publicKey,
        env.userTokens,
        env.stranger,
        env.strangerTokens,
      ),
      "NothingToPay",
    );
  });

  it("allows a user to claim for themselves without deducting a caller fee", async () => {
    await accrue(env, env.user.publicKey, oneToken().muln(50));
    await claim(
      env,
      env.user.publicKey,
      env.userTokens,
      env.user,
      env.userTokens,
    );

    // User gets 100% of their reward (50 tokens)
    assert.equal(
      (await tokenBalance(env.context, env.userTokens)).toString(),
      oneToken().muln(50).toString(),
    );
  });

  it("refuses a price update that is too old (older than max_price_age)", async () => {
    const clock = await env.context.banksClient.getClock();
    const staleTime = clock.unixTimestamp - BigInt(MAX_PRICE_AGE + 10);

    await catchError(
      setPrice(env, toBN(LAMPORTS_PER_SOL / 100), staleTime, env.stranger),
      "StalePrice",
    );
  });

  it("refuses a price update signed by an unauthorized key", async () => {
    const imposter = Keypair.generate();

    await catchError(
      setPrice(
        env,
        toBN(LAMPORTS_PER_SOL / 100),
        undefined,
        env.stranger,
        imposter,
      ),
      "UnauthorizedOracle",
    );
  });

  it("refuses set_price if the preceding instruction is not an Ed25519 signature verification", async () => {
    await catchError(
      setPrice(
        env,
        toBN(LAMPORTS_PER_SOL / 100),
        undefined,
        env.stranger,
        env.oracle,
        true, // omit signature check
      ),
      "NotEd25519",
    );
  });

  it("refuses a malformed price message", async () => {
    const clock = await env.context.banksClient.getClock();
    const shortMessage = Buffer.alloc(8); // less than 16 bytes

    await catchError(
      setPrice(
        env,
        toBN(LAMPORTS_PER_SOL / 100),
        clock.unixTimestamp,
        env.stranger,
        env.oracle,
        false,
        shortMessage,
      ),
      "MalformedEd25519",
    );
  });
});
