use anchor_lang::prelude::*;
use anchor_lang::solana_program::ed25519_program;
use anchor_lang::solana_program::instruction::Instruction;
use anchor_lang::solana_program::sysvar::instructions as ix_sysvar;

use crate::{Config, RewardsError};

/// What an Ed25519 instruction verified: the key that signed and the message.
pub struct Ed25519Signed {
    pub pubkey: Pubkey,
    pub message: Vec<u8>,
}

/// Parses a single-signature instruction built for the Ed25519 program (the layout
/// `Ed25519Program.createInstructionWithPrivateKey` produces): a 16-byte header with
/// offsets, then the public key, the signature and the message, all inside this instruction.
pub fn parse_ed25519(ix: &Instruction) -> Result<Ed25519Signed> {
    require_keys_eq!(ix.program_id, ed25519_program::ID, RewardsError::NotEd25519);
    let d = &ix.data;
    require!(d.len() >= 16 && d[0] == 1, RewardsError::MalformedEd25519);
    let u16_at = |i: usize| u16::from_le_bytes([d[i], d[i + 1]]) as usize;
    let (sig_ix, pk_off, pk_ix) = (u16_at(4), u16_at(6), u16_at(8));
    let (msg_off, msg_size, msg_ix) = (u16_at(10), u16_at(12), u16_at(14));
    require!(
        sig_ix == 0xffff && pk_ix == 0xffff && msg_ix == 0xffff,
        RewardsError::MalformedEd25519
    );
    require!(
        d.len() >= pk_off + 32 && d.len() >= msg_off + msg_size,
        RewardsError::MalformedEd25519
    );
    let mut pubkey = [0u8; 32];
    pubkey.copy_from_slice(&d[pk_off..pk_off + 32]);
    Ok(Ed25519Signed {
        pubkey: Pubkey::from(pubkey),
        message: d[msg_off..msg_off + msg_size].to_vec(),
    })
}

/// Replaces the bot-controlled `set_price`.
/// The caller provides a fresh price update signed by `config.oracle`
/// in an Ed25519 instruction immediately preceding this one in the same transaction.
#[derive(Accounts)]
pub struct SetPrice<'info> {
    pub caller: Signer<'info>,
    #[account(mut, seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    /// CHECK: Instructions sysvar account used to inspect the preceding Ed25519 instruction.
    #[account(address = ix_sysvar::ID)]
    pub instructions: UncheckedAccount<'info>,
}

pub fn set_price(ctx: Context<SetPrice>) -> Result<()> {
    let current_index = ix_sysvar::load_current_index_checked(&ctx.accounts.instructions.to_account_info())
        .map_err(|_| RewardsError::NotEd25519)?;
    require!(current_index > 0, RewardsError::NotEd25519);

    let prev_ix = ix_sysvar::load_instruction_at_checked(
        (current_index - 1) as usize,
        &ctx.accounts.instructions.to_account_info(),
    )
    .map_err(|_| RewardsError::MalformedEd25519)?;

    let signed = parse_ed25519(&prev_ix)?;
    require_keys_eq!(signed.pubkey, ctx.accounts.config.oracle, RewardsError::UnauthorizedOracle);

    require!(signed.message.len() >= 16, RewardsError::MalformedEd25519);
    let price = u64::from_le_bytes(
        signed.message[0..8]
            .try_into()
            .map_err(|_| RewardsError::MalformedEd25519)?,
    );
    let publish_time = i64::from_le_bytes(
        signed.message[8..16]
            .try_into()
            .map_err(|_| RewardsError::MalformedEd25519)?,
    );

    let now = Clock::get()?.unix_timestamp;
    require!(
        now >= publish_time - 5 && now - publish_time <= ctx.accounts.config.max_price_age,
        RewardsError::StalePrice
    );

    let config = &mut ctx.accounts.config;
    config.price = price;
    config.price_time = publish_time;

    Ok(())
}
