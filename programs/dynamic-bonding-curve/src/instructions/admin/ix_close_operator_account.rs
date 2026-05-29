use crate::state::Operator;
use anchor_lang::prelude::*;

/// Closes an `Operator` account.
///
/// The close is fully constraint-driven: the `close = rent_receiver` attribute on
/// `operator` tells Anchor to zero the account data, wipe its discriminator, and
/// transfer all remaining lamports to `rent_receiver` at the END of the instruction.
/// This is WHY `handle_close_operator_account` / the `close_operator_account`
/// entrypoint has an empty `Ok(())` body — it is NOT incomplete logic. Admin
/// authorization is enforced separately via the `#[access_control(is_admin(..))]`
/// guard on the entrypoint (see `lib.rs`).
#[derive(Accounts)]
pub struct CloseOperatorAccountCtx<'info> {
    #[account(
        mut,
        close = rent_receiver
    )]
    pub operator: AccountLoader<'info, Operator>,

    pub signer: Signer<'info>,

    /// CHECK: Account to receive rent fee
    #[account(mut)]
    pub rent_receiver: UncheckedAccount<'info>,
}
