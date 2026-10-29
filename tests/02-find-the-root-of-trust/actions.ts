import { BN } from "@coral-xyz/anchor";
import {
  Ed25519Program,
  Keypair,
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";

import { sendIxs } from "../helpers";
import { VaultFixture } from "./fixture";

/** The message the oracle signs: vault, recipient token account, amount as u64 LE. */
export const withdrawalMessage = (
  vault: PublicKey,
  recipientTokens: PublicKey,
  amount: BN,
) =>
  Buffer.concat([
    vault.toBuffer(),
    recipientTokens.toBuffer(),
    amount.toArrayLike(Buffer, "le", 8),
  ]);

export const withdraw = async (
  env: VaultFixture,
  amount: BN,
  recipientTokens: PublicKey,
  signer: Keypair = env.oracle,
  allowlist?: PublicKey,
  instructions: PublicKey = SYSVAR_INSTRUCTIONS_PUBKEY,
  messageOverride?: Buffer,
) => {
  const signatureCheck = Ed25519Program.createInstructionWithPrivateKey({
    privateKey: signer.secretKey,
    message:
      messageOverride ?? withdrawalMessage(env.vault, recipientTokens, amount),
  });
  const ix = await env.program.methods
    .withdraw(amount)
    .accountsPartial({
      caller: env.payer.publicKey,
      mint: env.mint,
      recipientTokens,
      instructions,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();
  await sendIxs(env.context, [env.payer], signatureCheck, ix);
};

const u16 = (n: number) => {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
};

/** One instruction serialized in the layout `src/sysvar.rs` documents. */
const serializeSysvarIx = (ix: {
  programId: PublicKey;
  data: Buffer;
}): Buffer =>
  Buffer.concat([
    u16(0), // no accounts
    ix.programId.toBuffer(),
    u16(ix.data.length),
    ix.data,
  ]);

/**
 * A whole account payload with the instructions sysvar's layout holding one
 * instruction — what an attacker writes into an account of their own so
 * `load_instruction_unchecked` reads whatever they want.
 */
export const fakeInstructionsSysvar = (ix: {
  programId: PublicKey;
  data: Buffer;
}): Buffer => Buffer.concat([u16(1), u16(4), serializeSysvarIx(ix)]);
