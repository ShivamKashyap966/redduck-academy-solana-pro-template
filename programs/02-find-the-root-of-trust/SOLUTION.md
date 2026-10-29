# Solution

## The chain as you found it

`withdraw` made five checks, in this order. For each one, the account it
depends on, and whether the caller could have created that account:

1. **Read instruction 0 from `instructions`** (`load_instruction_unchecked`).
   Depends on the `instructions` account, declared as an `UncheckedAccount`
   with no `address`, no `seeds`, no owner constraint. The caller could pass
   any existing account — including one they created and filled with any bytes
   they liked.
2. **The loaded instruction is an Ed25519 check** (`parse_ed25519`). Depends
   on the instruction loaded in (1), so on the caller's account data. It checks
   `program_id == ed25519 program` and the layout offsets — but both are just
   fields inside that same attacker-written data, so the caller chooses them
   too. It returns the "signing key" and the "signed message".
3. **The key is allowed** (`allowlist.keys.contains(&signed.pubkey)`). Depends
   on the `allowlist` account, an `Account<Allowlist>` with no seeds, created
   by `create_allowlist` — which any signer may call with any keys. The caller
   could create that account themselves, listing their own key.
4. **The message matches the withdrawal** (compare against
   `withdrawal_message(vault, recipient_tokens, amount)`). Depends on the
   `vault` (a PDA seeded `["vault"]`, with `authority = config`), `recipient_tokens`
   and `amount`. This check is real — but the attacker simply signs the
   genuine message with their own key, so it passes for the wrong reason.
5. **Transfer signed by the config PDA** (seeds `["config"]`). Correct: the
   authority is the program's own PDA, not anything the caller brought.

## Where the chain ended

The whole chain ended at the **`instructions` account** — the first link.
Check (1) never asked *whose* account it was: no address comparison against
the real instructions sysvar, no owner check. Since checks (2) and (3) only
read data derived from it (and from a caller-created allowlist), every
downstream check inherited an attacker-chosen root.

The exploit test builds exactly that: an ordinary account whose data
serializes the sysvar layout the way `src/sysvar.rs` documents it — a `u16`
count, one offset, then a single instruction entry — whose entry is an
Ed25519 instruction for a key of the attacker's own, over the real
`withdrawal_message(vault, recipient_tokens, amount)`. It is passed as
`instructions` (together with an allowlist the attacker creates through
`create_allowlist`), the attacker signs `withdraw`, and the vault pays out.
Against the given program the test passed: the vault drained to the
attacker's account.

## The root

The root is now the **`config` PDA** (seeds `["config"]`), and it is anchored
to the cluster before anything else is trusted:

- **The caller cannot create it.** `initialize` is the only instruction with
  `init`, it requires the admin's signature, and a PDA cannot sign a
  transaction that creates itself. Before the admin runs, the account does
  not exist; after, every instruction pins it with
  `seeds = [b"config"], bump = config.bump`, so a look-alike account can
  never be substituted.
- **The caller cannot rewrite it.** `oracles` is written once, inside
  `initialize`; no later instruction mutates the account.
- **`instructions` is compared with the real sysvar before it is read.**
  `#[account(address = ix_sysvar::ID @ VaultError::WrongInstructionsSysvar)]`
  runs in account validation, before the handler touches a byte, so the data
  read afterwards is the cluster-owned sysvar contents — an entry that
  belongs to this transaction, verified by the runtime's Ed25519 precompile.
- **The Ed25519 key is compared with the config**: the parsed signing key
  must be in `config.oracles` (`KeyNotAllowed`), never in anything the caller
  brought. The caller-created allowlist and `create_allowlist` instruction were
  completely deleted; the program exposes only `initialize`, `deposit`, and
  `withdraw`, all rooted in the `config` PDA.
- **The Ed25519 parser validates the precompile program ID**: `parse_ed25519`
  is included directly in `withdraw.rs` and requires `ix.program_id == ed25519_program::ID`,
  header length >= 16 with single signature count = 1, offsets `0xffff`, and safe
  buffer bounds before reading public key and message.
- **The message is compared with the withdrawal**: `withdrawal_message` is
  built from `vault` (the `["vault"]` PDA with authority `config`), `recipient_tokens` (constrained
  to `config.mint`) and `amount` (the argument being executed), so a valid
  signature only ever covers this exact payout.

The fixed chain: real sysvar address (cluster) → entry 0 of the real sysvar
(this transaction) → Ed25519 program's verification (runtime) → key in
`config.oracles` (admin, at initialize) → message equals this vault, this
recipient, this amount (config PDA) → transfer signed by the config PDA.

The exploit test now asserts the other side of the same chain: it runs the
identical attack and requires the transaction to fail with `0x1777`
(`WrongInstructionsSysvar`) with the vault and recipient balances untouched —
the chain no longer reaches the signature checks at all, because it ends at
the address comparison.

## One root for every instruction

- **`initialize`** creates the root itself: `init` on `config` with
  `seeds = [b"config"]`, writes `admin`, `mint`, `oracles` and the bump, and
  initialises the `vault` token account with `authority = config`.
- **`deposit`** reads the same root: `config` is constrained with
  `seeds = [b"config"], bump = config.bump`, `mint` must equal
  `config.mint`, and `vault` is the `["vault"]` PDA.
- **`withdraw`** uses the same root for every decision: the same seeds
  constraint on `config`, `config.oracles` for the key, `config.mint` for the
  mint, and the transfer's signer seeds `["config", config.bump]` — the same
  PDA that `deposit` and `initialize` use.

There is exactly one config, one place that writes it, and every instruction
resolves it from the same seeds — the permissionless caller-created allowlist
(`create_allowlist` + `state/allowlist.rs`) was deleted, and `deposit` establishes
the same `config` PDA root of trust across every vault instruction.
