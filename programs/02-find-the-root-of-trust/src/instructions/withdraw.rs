use anchor_lang::prelude::*;
use anchor_lang::solana_program::ed25519_program;
use anchor_lang::solana_program::instruction::Instruction;
use anchor_lang::solana_program::sysvar::instructions as ix_sysvar;
use anchor_spl::token::{transfer_checked, Mint, Token, TokenAccount, TransferChecked};

use crate::{load_instruction_unchecked, Config, VaultError};

/// What an Ed25519 instruction verified: the key that signed and the message.
pub struct Ed25519Signed {
    pub pubkey: Pubkey,
    pub message: Vec<u8>,
}

/// Parses a single-signature instruction built for the Ed25519 program (the layout
/// `Ed25519Program.createInstructionWithPrivateKey` produces): a 16-byte header with
/// offsets, then the public key, the signature and the message, all inside this instruction.
pub fn parse_ed25519(ix: &Instruction) -> Result<Ed25519Signed> {
    require_keys_eq!(ix.program_id, ed25519_program::ID, VaultError::NotEd25519);
    let d = &ix.data;
    require!(d.len() >= 16 && d[0] == 1, VaultError::MalformedEd25519);
    let u16_at = |i: usize| u16::from_le_bytes([d[i], d[i + 1]]) as usize;
    let (sig_ix, pk_off, pk_ix) = (u16_at(4), u16_at(6), u16_at(8));
    let (msg_off, msg_size, msg_ix) = (u16_at(10), u16_at(12), u16_at(14));
    require!(
        sig_ix == 0xffff && pk_ix == 0xffff && msg_ix == 0xffff,
        VaultError::MalformedEd25519
    );
    require!(
        d.len() >= pk_off + 32 && d.len() >= msg_off + msg_size,
        VaultError::MalformedEd25519
    );
    let mut pubkey = [0u8; 32];
    pubkey.copy_from_slice(&d[pk_off..pk_off + 32]);
    Ok(Ed25519Signed {
        pubkey: Pubkey::from(pubkey),
        message: d[msg_off..msg_off + msg_size].to_vec(),
    })
}

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
