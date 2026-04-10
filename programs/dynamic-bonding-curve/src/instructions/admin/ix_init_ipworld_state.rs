use anchor_lang::prelude::*;
use crate::state::IpworldState;

#[derive(Accounts)]
pub struct InitIpworldStateCtx<'info> {
    /// Deployer pays rent and becomes initial admin
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        init,
        payer = payer,
        space = IpworldState::LEN,
        seeds = [IpworldState::SEED],
        bump,
    )]
    pub ipworld_state: Account<'info, IpworldState>,

    pub system_program: Program<'info, System>,
}

pub fn handle_init_ipworld_state(
    ctx: Context<InitIpworldStateCtx>,
    authority: Pubkey,
) -> Result<()> {
    let state = &mut ctx.accounts.ipworld_state;
    state.authority = authority;
    state.admin = ctx.accounts.payer.key();
    state.bump = ctx.bumps.ipworld_state;
    Ok(())
}
