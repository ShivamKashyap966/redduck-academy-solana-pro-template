use anchor_lang::prelude::*;
use anchor_spl::token::{transfer_checked, Mint, Token, TokenAccount, TransferChecked};

use crate::{state::staker::PRECISION, Pool, PoolError};

#[derive(Accounts)]
pub struct AddRewards<'info> {
    pub funder: Signer<'info>,
    #[account(mut, seeds = [b"pool"], bump = pool.bump)]
    pub pool: Account<'info, Pool>,
    #[account(address = pool.mint)]
    pub mint: Account<'info, Mint>,
    #[account(mut, token::mint = mint, token::authority = funder)]
    pub funder_tokens: Account<'info, TokenAccount>,
    #[account(mut, seeds = [b"vault"], bump)]
    pub vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

pub fn add_rewards<'info>(
    ctx: Context<'_, '_, 'info, 'info, AddRewards<'info>>,
    amount: u64,
) -> Result<()> {
    let pool = &mut ctx.accounts.pool;
    let total_staked = pool.total_staked;
    require!(total_staked > 0, PoolError::NothingStaked);
    if amount == 0 {
        return Ok(());
    }

    transfer_checked(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.funder_tokens.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.funder.to_account_info(),
            },
        ),
        amount,
        ctx.accounts.mint.decimals,
    )?;

    // Calculate reward delta per staked token with high fixed-point precision (1e18)
    let reward_delta = (amount as u128)
        .checked_mul(PRECISION)
        .ok_or(PoolError::MathOverflow)?
        / (total_staked as u128);

    pool.reward_per_token = pool
        .reward_per_token
        .checked_add(reward_delta)
        .ok_or(PoolError::MathOverflow)?;

    // No staker loop: remaining accounts passed by caller are completely ignored
    Ok(())
}
