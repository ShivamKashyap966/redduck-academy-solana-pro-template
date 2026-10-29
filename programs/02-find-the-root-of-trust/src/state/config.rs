use anchor_lang::prelude::*;

use super::allowlist::MAX_KEYS;

/// The root of trust: a PDA only `initialize` can write, carrying the keys
/// allowed to sign a withdrawal. Everything the program believes about an
/// oracle comes from here, not from any account the caller passes.
#[account]
#[derive(InitSpace)]
pub struct Config {
    pub admin: Pubkey,
    pub mint: Pubkey,
    #[max_len(MAX_KEYS)]
    pub oracles: Vec<Pubkey>,
    pub bump: u8,
}
