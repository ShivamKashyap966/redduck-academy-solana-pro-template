import { BN } from "@coral-xyz/anchor";
import {
  Ed25519Program,
  Keypair,
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";

import { sendIxs } from "../helpers";
import { RewardsFixture } from "./fixture";

export const accrue = async (
  env: RewardsFixture,
  owner: PublicKey,
  amount: BN,
) => {
  const ix = await env.program.methods
    .accrue(amount)
    .accountsPartial({ admin: env.payer.publicKey, owner })
    .instruction();
  await sendIxs(env.context, [env.payer], ix);
};

export const claim = async (
  env: RewardsFixture,
  owner: PublicKey,
  ownerTokens: PublicKey,
  caller: Keypair = env.stranger,
  callerTokens: PublicKey = env.strangerTokens,
) => {
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
  await sendIxs(env.context, [caller], ix);
};

export const priceMessage = (
  price: BN,
  timestamp: number | BN | bigint,
): Buffer => {
  const buf = Buffer.alloc(16);
  buf.writeBigUInt64LE(BigInt(price.toString()), 0);
  buf.writeBigInt64LE(BigInt(timestamp.toString()), 8);
  return buf;
};

export const setPrice = async (
  env: RewardsFixture,
  price: BN,
  timestamp?: number | BN | bigint,
  signer: Keypair = env.stranger,
  oracleKey: Keypair = env.oracle,
  omitSignatureCheck = false,
  messageOverride?: Buffer,
) => {
  let ts = timestamp;
  if (ts === undefined) {
    const clock = await env.context.banksClient.getClock();
    ts = clock.unixTimestamp;
  }

  const ix = await env.program.methods
    .setPrice()
    .accountsPartial({
      instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
    })
    .instruction();

  if (omitSignatureCheck) {
    await sendIxs(env.context, [signer], ix);
  } else {
    const signatureCheck = Ed25519Program.createInstructionWithPrivateKey({
      privateKey: oracleKey.secretKey,
      message: messageOverride ?? priceMessage(price, ts),
    });
    await sendIxs(env.context, [signer], signatureCheck, ix);
  }
};

export const buy = async (
  env: RewardsFixture,
  buyer: Keypair,
  buyerTokens: PublicKey,
  lamports: BN,
) => {
  const ix = await env.program.methods
    .buy(lamports)
    .accountsPartial({
      buyer: buyer.publicKey,
      mint: env.mint,
      buyerTokens,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();
  await sendIxs(env.context, [buyer], ix);
};
