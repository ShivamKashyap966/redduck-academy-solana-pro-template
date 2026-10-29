use anchor_lang::prelude::*;
use anchor_spl::token::{transfer_checked, Mint, Token, TokenAccount, TransferChecked};

use crate::{Config, RewardsError, User};

pub const FEE_BPS: u64 = 100; // 1%
pub const MAX_CALLER_FEE: u64 = 5_000_000; // 5 whole tokens (with 6 decimals)

/// Replaces `pay_reward`. Anyone can execute a claim for any user.
/// The user receives their pending reward minus a capped caller fee,
/// and the caller receives the fee to incentivize running decentralized crank bots.
/// If the user claims for themselves, no fee is deducted.
#[derive(Accounts)]
pub struct Claim<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"user", user.owner.as_ref()], bump = user.bump)]
    pub user: Account<'info, User>,
    #[account(address = config.mint)]
    pub mint: Account<'info, Mint>,
    #[account(mut, token::mint = mint, token::authority = user.owner)]
    pub user_tokens: Account<'info, TokenAccount>,
    #[account(mut, token::mint = mint, token::authority = caller)]
    pub caller_tokens: Account<'info, TokenAccount>,
    #[account(mut, seeds = [b"vault"], bump)]
    pub vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

pub fn claim(ctx: Context<Claim>) -> Result<()> {
    let amount = ctx.accounts.user.pending;
    require!(amount > 0, RewardsError::NothingToPay);
    ctx.accounts.user.pending = 0;

    let seeds: &[&[u8]] = &[b"config", &[ctx.accounts.config.bump]];

    if ctx.accounts.caller.key() == ctx.accounts.user.owner
        || ctx.accounts.caller_tokens.key() == ctx.accounts.user_tokens.key()
    {
        // The user claimed for themselves: no fee is deducted.
        transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.vault.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.user_tokens.to_account_info(),
                    authority: ctx.accounts.config.to_account_info(),
                },
                &[seeds],
            ),
            amount,
            ctx.accounts.mint.decimals,
        )?;
    } else {
        // Third-party caller claiming on behalf of the user:
        // Sized at 1% of pending reward, capped at MAX_CALLER_FEE (5 tokens).
        let fee = (amount * FEE_BPS / 10_000).min(MAX_CALLER_FEE);
        let user_amount = amount.checked_sub(fee).ok_or(RewardsError::MathOverflow)?;

        if user_amount > 0 {
            transfer_checked(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    TransferChecked {
                        from: ctx.accounts.vault.to_account_info(),
                        mint: ctx.accounts.mint.to_account_info(),
                        to: ctx.accounts.user_tokens.to_account_info(),
                        authority: ctx.accounts.config.to_account_info(),
                    },
                    &[seeds],
                ),
                user_amount,
                ctx.accounts.mint.decimals,
            )?;
        }

        if fee > 0 {
            transfer_checked(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    TransferChecked {
                        from: ctx.accounts.vault.to_account_info(),
                        mint: ctx.accounts.mint.to_account_info(),
                        to: ctx.accounts.caller_tokens.to_account_info(),
                        authority: ctx.accounts.config.to_account_info(),
                    },
                    &[seeds],
                ),
                fee,
                ctx.accounts.mint.decimals,
            )?;
        }
    }

    Ok(())
}
