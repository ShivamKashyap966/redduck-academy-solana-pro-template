use anchor_lang::prelude::*;

#[error_code]
pub enum VaultError {
    #[msg("Math overflow")]
    MathOverflow,
    #[msg("Too many keys in the allowlist")]
    TooManyKeys,
    #[msg("The instruction before this one is not an Ed25519 signature check")]
    NotEd25519,
    #[msg("The instructions account has an unexpected layout")]
    MalformedSysvar,
    #[msg("The Ed25519 instruction has an unexpected layout")]
    MalformedEd25519,
    #[msg("The signer is not in the config")]
    KeyNotAllowed,
    #[msg("The signed message does not match this withdrawal")]
    MessageMismatch,
    #[msg("The instructions account is not the real instructions sysvar")]
    WrongInstructionsSysvar,
    #[msg("At least one oracle key is required")]
    NoOracles,
}
