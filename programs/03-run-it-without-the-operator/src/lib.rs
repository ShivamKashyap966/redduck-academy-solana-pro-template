use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

pub mod ed25519;
pub mod error;
pub mod instructions;
pub mod state;

pub use ed25519::*;
pub use error::*;
pub use instructions::*;
pub use state::*;

declare_id!("HReKhsVu24hzPjuWzM5Ak5qr8LC1HvtUZdghEikbNA4s");

#[program]
pub mod operator_free {
    use super::*;

    pub fn initialize(
        ctx: Context<Initialize>,
        bot: Pubkey,
        oracle: Pubkey,
        max_price_age: i64,
    ) -> Result<()> {
        ctx.accounts.config.set_inner(Config {
            admin: ctx.accounts.admin.key(),
            bot,
            oracle,
            mint: ctx.accounts.mint.key(),
            price: 0,
            price_time: 0,
            max_price_age,
            bump: ctx.bumps.config,
        });
        Ok(())
    }

    pub fn accrue(ctx: Context<Accrue>, amount: u64) -> Result<()> {
        let user = &mut ctx.accounts.user;
        user.owner = ctx.accounts.owner.key();
        user.bump = ctx.bumps.user;
        user.pending = user
            .pending
            .checked_add(amount)
            .ok_or(RewardsError::MathOverflow)?;
        Ok(())
    }

    pub fn claim(ctx: Context<Claim>) -> Result<()> {
        instructions::claim(ctx)
    }

    pub fn set_price(ctx: Context<SetPrice>) -> Result<()> {
        instructions::set_price(ctx)
    }

    pub fn buy(ctx: Context<Buy>, lamports: u64) -> Result<()> {
        instructions::buy(ctx, lamports)
    }
}

/// Administrative instruction: protocol deployment and parameters.
#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(init, payer = admin, space = 8 + Config::INIT_SPACE, seeds = [b"config"], bump)]
    pub config: Account<'info, Config>,
    pub mint: Account<'info, Mint>,
    #[account(
        init,
        payer = admin,
        seeds = [b"vault"],
        bump,
        token::mint = mint,
        token::authority = config,
    )]
    pub vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

/// Administrative instruction: admin credits rewards to a user account.
#[derive(Accounts)]
pub struct Accrue<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump, has_one = admin)]
    pub config: Account<'info, Config>,
    /// CHECK: the user the reward is credited to; only their key is needed.
    pub owner: UncheckedAccount<'info>,
    #[account(
        init_if_needed,
        payer = admin,
        space = 8 + User::INIT_SPACE,
        seeds = [b"user", owner.key().as_ref()],
        bump,
    )]
    pub user: Account<'info, User>,
    pub system_program: Program<'info, System>,
}
