import { assert } from "chai";
import { BN } from "@coral-xyz/anchor";
import {
  Ed25519Program,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";

import { oneToken, processTransaction, toBN, tokenBalance } from "../helpers";
import { MAX_PRICE_AGE, RewardsFixture, setupRewards } from "./fixture";

const ERROR_CODES: Record<string, string> = {
  MathOverflow: "0x1770",
  NothingToPay: "0x1771",
  StalePrice: "0x1772",
  NotEd25519: "0x1773",
  MalformedEd25519: "0x1774",
  UnauthorizedOracle: "0x1775",
};

/**
 * Builds the 16-byte message payload signed by config.oracle off-chain:
 * [price (8 bytes u64 le), timestamp (8 bytes i64 le)]
 */
export function priceMessage(price: BN, timestamp: number | BN | bigint): Buffer {
  const buf = Buffer.alloc(16);
  buf.writeBigUInt64LE(BigInt(price.toString()), 0);
  buf.writeBigInt64LE(BigInt(timestamp.toString()), 8);
  return buf;
}

/**
 * Constructs and submits a pull-price update transaction signed by config.oracle.
 * Proves that the price is brought by the transaction caller with NO team bot running.
 */
async function submitPullPrice(
  env: RewardsFixture,
  price: BN,
  timestamp?: number | BN | bigint,
  caller: Keypair = env.stranger,
  oracleKeypair: Keypair = env.oracle,
  options: { omitEd25519?: boolean; customMessage?: Buffer } = {},
): Promise<void> {
  let ts = timestamp;
  if (ts === undefined) {
    const clock = await env.context.banksClient.getClock();
    ts = clock.unixTimestamp;
  }

  const tx = new Transaction();

  if (!options.omitEd25519) {
    const message = options.customMessage ?? priceMessage(price, ts);
    const ed25519Ix = Ed25519Program.createInstructionWithPrivateKey({
      privateKey: oracleKeypair.secretKey,
      message,
    });
    tx.add(ed25519Ix);
  }

  const setPriceIx = await env.program.methods
    .setPrice()
    .accountsPartial({
      caller: caller.publicKey,
      config: env.config,
      instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
    })
    .instruction();
  tx.add(setPriceIx);

  await processTransaction(env.context, tx, [caller]);
}

/**
 * Admin credits rewards to a user (administrative path).
 */
async function adminAccrue(
  env: RewardsFixture,
  owner: PublicKey,
  amount: BN,
): Promise<void> {
  const ix = await env.program.methods
    .accrue(amount)
    .accountsPartial({ admin: env.payer.publicKey, owner })
    .instruction();
  await processTransaction(env.context, new Transaction().add(ix), [env.payer]);
}

/**
 * Permissionless claim: any caller can claim on behalf of any user.
 */
async function submitClaim(
  env: RewardsFixture,
  owner: PublicKey,
  ownerTokens: PublicKey,
  caller: Keypair = env.stranger,
  callerTokens: PublicKey = env.strangerTokens,
): Promise<void> {
  const ix = await env.program.methods
    .claim()
    .accountsPartial({
      caller: caller.publicKey,
      user: env.userAccount(owner),
      mint: env.mint,
      userTokens: ownerTokens,
      callerTokens,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();
  await processTransaction(env.context, new Transaction().add(ix), [caller]);
}

/**
 * Permissionless buy: any buyer buys tokens at config.price with SOL.
 */
async function submitBuy(
  env: RewardsFixture,
  buyer: Keypair,
  buyerTokens: PublicKey,
  lamports: BN,
): Promise<void> {
  const ix = await env.program.methods
    .buy(lamports)
    .accountsPartial({
      buyer: buyer.publicKey,
      mint: env.mint,
      buyerTokens,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();
  await processTransaction(env.context, new Transaction().add(ix), [buyer]);
}

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
  const errStr = err!.toString();
  const hex = ERROR_CODES[expectedError];
  const matched =
    errStr.includes(expectedError) || (hex !== undefined && errStr.includes(hex));
  assert.isTrue(
    matched,
    `Operation must fail with ${expectedError} (${hex}). Got: ${errStr}`,
  );
};

describe("03-run-it-without-the-operator", () => {
  let env: RewardsFixture;

  beforeEach(async () => {
    env = await setupRewards();
  });

  it("claims a reward for a user and buys tokens without any operator/bot running", async () => {
    // 1. Admin credits 100 tokens to user via administrative accrue
    await adminAccrue(env, env.user.publicKey, oneToken().muln(100));

    // 2. Stranger (neither admin nor bot) permissionlessly claims for the user
    await submitClaim(
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
    // Stranger receives 1 token as incentive fee for sending the transaction
    assert.equal(
      (await tokenBalance(env.context, env.strangerTokens)).toString(),
      oneToken().muln(1).toString(),
    );

    // 3. Stranger constructs the signed pull-oracle price update off-chain:
    // Price = 0.01 SOL per token (10_000_000 lamports)
    const price = toBN(LAMPORTS_PER_SOL / 100);
    const clock = await env.context.banksClient.getClock();
    const msg = priceMessage(price, clock.unixTimestamp);

    // Build the Ed25519 signature instruction directly in the test:
    const ed25519Ix = Ed25519Program.createInstructionWithPrivateKey({
      privateKey: env.oracle.secretKey,
      message: msg,
    });
    const setPriceIx = await env.program.methods
      .setPrice()
      .accountsPartial({
        caller: env.stranger.publicKey,
        config: env.config,
        instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .instruction();

    // Submit transaction containing [Ed25519 verify, setPrice] signed ONLY by stranger:
    const setPriceTx = new Transaction().add(ed25519Ix, setPriceIx);
    await processTransaction(env.context, setPriceTx, [env.stranger]);

    // 4. Stranger buys tokens for 0.1 SOL (receives 10 tokens) with no bot involved
    await submitBuy(
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

  it("proves atomic execution without operator: stranger verifies price and buys in one transaction", async () => {
    const price = toBN(LAMPORTS_PER_SOL / 100);
    const clock = await env.context.banksClient.getClock();
    const msg = priceMessage(price, clock.unixTimestamp);

    const ed25519Ix = Ed25519Program.createInstructionWithPrivateKey({
      privateKey: env.oracle.secretKey,
      message: msg,
    });
    const setPriceIx = await env.program.methods
      .setPrice()
      .accountsPartial({
        caller: env.stranger.publicKey,
        config: env.config,
        instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .instruction();
    const buyIx = await env.program.methods
      .buy(toBN(LAMPORTS_PER_SOL / 10))
      .accountsPartial({
        buyer: env.stranger.publicKey,
        mint: env.mint,
        buyerTokens: env.strangerTokens,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();

    // All three instructions bundled in a single transaction executed by stranger:
    const atomicTx = new Transaction().add(ed25519Ix, setPriceIx, buyIx);
    await processTransaction(env.context, atomicTx, [env.stranger]);

    assert.equal(
      (await tokenBalance(env.context, env.strangerTokens)).toString(),
      oneToken().muln(10).toString(),
    );
  });

  it("confirms no operator path remains: old bot key cannot write price without oracle signature", async () => {
    // If the old bot tries to call set_price directly without an Ed25519 instruction from config.oracle,
    // the transaction fails with NotEd25519 (0x1773).
    await catchError(
      submitPullPrice(
        env,
        toBN(LAMPORTS_PER_SOL / 100),
        undefined,
        env.bot,
        env.oracle,
        { omitEd25519: true },
      ),
      "NotEd25519",
    );
  });

  it("cannot claim twice for the same user", async () => {
    await adminAccrue(env, env.user.publicKey, oneToken().muln(100));
    await submitClaim(
      env,
      env.user.publicKey,
      env.userTokens,
      env.stranger,
      env.strangerTokens,
    );

    // Second claim must revert because user.pending was reset to 0
    await catchError(
      submitClaim(
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
    await adminAccrue(env, env.user.publicKey, oneToken().muln(50));
    await submitClaim(
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

  it("caps the caller fee at MAX_CALLER_FEE (5 tokens) for large payouts", async () => {
    // 1,000 tokens payout: 1% would be 10 tokens, but fee is hard-capped at 5 tokens
    await adminAccrue(env, env.user.publicKey, oneToken().muln(1000));
    await submitClaim(
      env,
      env.user.publicKey,
      env.userTokens,
      env.stranger,
      env.strangerTokens,
    );

    assert.equal(
      (await tokenBalance(env.context, env.strangerTokens)).toString(),
      oneToken().muln(5).toString(),
    );
    assert.equal(
      (await tokenBalance(env.context, env.userTokens)).toString(),
      oneToken().muln(995).toString(),
    );
  });

  it("refuses a price update that is too old (older than max_price_age)", async () => {
    const clock = await env.context.banksClient.getClock();
    const staleTime = clock.unixTimestamp - BigInt(MAX_PRICE_AGE + 10);

    await catchError(
      submitPullPrice(
        env,
        toBN(LAMPORTS_PER_SOL / 100),
        staleTime,
        env.stranger,
      ),
      "StalePrice",
    );
  });

  it("refuses a price update signed by an unauthorized key", async () => {
    const imposter = Keypair.generate();

    await catchError(
      submitPullPrice(
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
      submitPullPrice(
        env,
        toBN(LAMPORTS_PER_SOL / 100),
        undefined,
        env.stranger,
        env.oracle,
        { omitEd25519: true },
      ),
      "NotEd25519",
    );
  });

  it("refuses a malformed price message", async () => {
    const clock = await env.context.banksClient.getClock();
    const shortMessage = Buffer.alloc(8); // less than 16 bytes

    await catchError(
      submitPullPrice(
        env,
        toBN(LAMPORTS_PER_SOL / 100),
        clock.unixTimestamp,
        env.stranger,
        env.oracle,
        { customMessage: shortMessage },
      ),
      "MalformedEd25519",
    );
  });
});
