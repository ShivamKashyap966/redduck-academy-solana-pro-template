import { Program } from "@coral-xyz/anchor";
import { ProgramTestContext } from "solana-bankrun";
import { Keypair, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";

import { OracleVault } from "../../target/types/oracle_vault";
import idl from "../../target/idl/oracle_vault.json";
import {
  createMintAndFund,
  findPDA,
  initBankrun,
  oneToken,
  sendIxs,
} from "../helpers";

export interface VaultFixture {
  context: ProgramTestContext;
  program: Program<OracleVault>;
  payer: Keypair;
  oracle: Keypair;
  config: PublicKey;
  vault: PublicKey;
  mint: PublicKey;
  payerTokens: PublicKey;
  allowlist?: PublicKey;
}

export const setupVault = async (): Promise<VaultFixture> => {
  const { context, program, accounts } = await initBankrun(idl as OracleVault);
  const payer = context.payer;
  const oracle = accounts[0];

  const config = findPDA(["config"], program)[0];
  const vault = findPDA(["vault"], program)[0];
  const { mint, ata: payerTokens } = await createMintAndFund(
    context,
    payer,
    payer.publicKey,
    oneToken().muln(1_000_000),
  );

  // The oracle key is written into the config PDA at initialization: this is
  // the only place the program ever learns who may sign a withdrawal.
  const initIx = await program.methods
    .initialize([oracle.publicKey])
    .accountsPartial({
      admin: payer.publicKey,
      mint,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();
  await sendIxs(context, [payer], initIx);

  const depositIx = await program.methods
    .deposit(oneToken().muln(1_000))
    .accountsPartial({
      depositor: payer.publicKey,
      mint,
      depositorTokens: payerTokens,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();
  await sendIxs(context, [payer], depositIx);

  return {
    context,
    program,
    payer,
    oracle,
    config,
    vault,
    mint,
    payerTokens,
    allowlist: Keypair.generate().publicKey,
  };
};
