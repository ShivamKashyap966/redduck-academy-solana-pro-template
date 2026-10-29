use anchor_lang::prelude::*;
use anchor_lang::solana_program::sysvar::instructions as ix_sysvar;

use crate::{parse_ed25519, Config, RewardsError};

/// Replaces the bot-controlled `set_price`.
/// The caller provides a fresh price update signed by `config.oracle`
/// in an Ed25519 instruction immediately preceding this one in the same transaction.
#[derive(Accounts)]
pub struct SetPrice<'info> {
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
