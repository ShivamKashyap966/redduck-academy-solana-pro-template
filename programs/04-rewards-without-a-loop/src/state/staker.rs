use anchor_lang::prelude::*;

use crate::error::PoolError;

pub const PRECISION: u128 = 1_000_000_000_000_000_000; // 1e18

#[account]
#[derive(InitSpace)]
pub struct Staker {
    pub owner: Pubkey,
    pub stake: u64,
    /// Value of pool.reward_per_token at staker's last settlement.
    pub reward_per_token_paid: u128,
    /// Rewards credited from past intervals and not yet claimed.
    pub pending: u64,
    pub bump: u8,
}

impl Staker {
    pub fn settle(&mut self, pool_reward_per_token: u128) -> Result<()> {
        if self.stake > 0 {
            let delta = pool_reward_per_token
                .checked_sub(self.reward_per_token_paid)
                .ok_or(PoolError::MathOverflow)?;
            let accrued = (self.stake as u128)
                .checked_mul(delta)
                .ok_or(PoolError::MathOverflow)?
                / PRECISION;
            self.pending = self
                .pending
                .checked_add(u64::try_from(accrued).map_err(|_| PoolError::MathOverflow)?)
                .ok_or(PoolError::MathOverflow)?;
        }
        self.reward_per_token_paid = pool_reward_per_token;
        Ok(())
    }
}
