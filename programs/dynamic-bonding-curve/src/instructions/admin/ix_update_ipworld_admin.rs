use anchor_lang::prelude::*;
use crate::state::IpworldState;

#[derive(Accounts)]
pub struct UpdateIpworldAdminCtx<'info> {
    /// Must be current admin
    #[account(
        constraint = admin.key() == ipworld_state.admin
    )]
    pub admin: Signer<'info>,

    #[account(
        mut,
        seeds = [IpworldState::SEED],
        bump = ipworld_state.bump,
    )]
    pub ipworld_state: Account<'info, IpworldState>,
}

pub fn handle_update_ipworld_admin(
    ctx: Context<UpdateIpworldAdminCtx>,
    new_admin: Pubkey,
) -> Result<()> {
    ctx.accounts.ipworld_state.admin = new_admin;
    Ok(())
}
