use anchor_lang::prelude::*;
use anchor_lang::solana_program::sysvar::instructions as ix_sysvar;
use anchor_spl::token::{transfer_checked, Mint, Token, TokenAccount, TransferChecked};

use crate::{load_instruction_unchecked, parse_ed25519, Config, VaultError};

#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,
    /// The root of trust: whose signature may release funds. Its PDA seeds
    /// pin it to the one account `initialize` wrote; no caller can substitute it.
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(address = config.mint)]
    pub mint: Account<'info, Mint>,
    #[account(mut, seeds = [b"vault"], bump)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut, token::mint = mint)]
    pub recipient_tokens: Account<'info, TokenAccount>,
    /// CHECK: compared with the real instructions sysvar address before any
    /// data is read from it, so only the cluster-owned copy is ever trusted.
    #[account(address = ix_sysvar::ID @ VaultError::WrongInstructionsSysvar)]
    pub instructions: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}

/// The message an oracle signs for one withdrawal: vault, recipient token account, amount.
pub fn withdrawal_message(vault: &Pubkey, recipient_tokens: &Pubkey, amount: u64) -> Vec<u8> {
    let mut message = Vec::with_capacity(72);
    message.extend_from_slice(vault.as_ref());
    message.extend_from_slice(recipient_tokens.as_ref());
    message.extend_from_slice(&amount.to_le_bytes());
    message
}

pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
    // 1. The address constraint above already proved `instructions` is the real
    //    sysvar before a byte of it is read, so this entry belongs to this transaction.
    let signature_check = load_instruction_unchecked(0, &ctx.accounts.instructions)?;
    // 2. The check that ran is the Ed25519 program's: key and message come from it.
    let signed = parse_ed25519(&signature_check)?;
    // 3. The key must be one the config holds — never one the caller brought along.
    require!(
        ctx.accounts.config.oracles.contains(&signed.pubkey),
        VaultError::KeyNotAllowed
    );
    // 4. The signature must cover exactly this vault, this recipient, this amount.
    let expected = withdrawal_message(
        &ctx.accounts.vault.key(),
        &ctx.accounts.recipient_tokens.key(),
        amount,
    );
    require!(signed.message == expected, VaultError::MessageMismatch);

    let seeds: &[&[u8]] = &[b"config", &[ctx.accounts.config.bump]];
    transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.vault.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.recipient_tokens.to_account_info(),
                authority: ctx.accounts.config.to_account_info(),
            },
            &[seeds],
        ),
        amount,
        ctx.accounts.mint.decimals,
    )
}
