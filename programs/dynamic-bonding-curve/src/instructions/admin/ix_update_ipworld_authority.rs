use anchor_lang::prelude::*;
use crate::state::IpworldState;

#[derive(Accounts)]
pub struct UpdateIpworldAuthorityCtx<'info> {
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

pub fn handle_update_ipworld_authority(
    ctx: Context<UpdateIpworldAuthorityCtx>,
    new_authority: Pubkey,
) -> Result<()> {
    ctx.accounts.ipworld_state.authority = new_authority;
    Ok(())
}
