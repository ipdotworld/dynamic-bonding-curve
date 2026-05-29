use crate::assert_eq_admin;
use crate::state::{Operator, OperatorPermission, VirtualPool};
use crate::PoolError;
use anchor_lang::prelude::*;

// check whether the signer is in admin list
pub fn is_admin(signer: &Pubkey) -> Result<()> {
    require!(assert_eq_admin(signer.key()), PoolError::InvalidAdmin);
    Ok(())
}

pub fn is_pool_creator<'info>(
    pool: &AccountLoader<'info, VirtualPool>,
    creator: &Pubkey,
) -> Result<()> {
    let pool = pool.load()?;
    require!(pool.creator.eq(creator), PoolError::Unauthorized);
    Ok(())
}

pub fn is_valid_operator_role<'info>(
    operator: &AccountLoader<'info, Operator>,
    signer: &Pubkey,
    permission: OperatorPermission,
) -> Result<()> {
    let operator = operator.load()?;

    if operator.whitelisted_address.eq(signer) && operator.is_permission_allow(permission) {
        Ok(())
    } else {
        err!(PoolError::InvalidPermission)
    }
}
