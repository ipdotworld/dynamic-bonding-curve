use crate::{
    constants::seeds::OPERATOR_PREFIX,
    state::{operator::validate_single_role_permission, Operator},
};
use anchor_lang::prelude::*;

#[event_cpi]
#[derive(Accounts)]
pub struct CreateOperatorAccountCtx<'info> {
    #[account(
        init,
        payer = payer,
        seeds = [
            OPERATOR_PREFIX.as_ref(),
            whitelisted_address.key().as_ref(),
        ],
        bump,
        space = 8 + Operator::INIT_SPACE
    )]
    pub operator: AccountLoader<'info, Operator>,

    /// CHECK: can be any address
    pub whitelisted_address: UncheckedAccount<'info>,

    pub signer: Signer<'info>,

    #[account(mut)]
    pub payer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handle_create_operator_account(
    ctx: Context<CreateOperatorAccountCtx>,
    permission: u128,
) -> Result<()> {
    // REQ-D-004: single valid role per operator account. Rejects zero, multi-bit
    // (multiple simultaneous roles), and reserved/dead slot bits.
    validate_single_role_permission(permission)?;

    let mut operator = ctx.accounts.operator.load_init()?;
    operator.initialize(ctx.accounts.whitelisted_address.key(), permission);
    Ok(())
}
