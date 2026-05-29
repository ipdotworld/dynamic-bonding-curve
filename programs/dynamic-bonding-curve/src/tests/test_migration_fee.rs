use crate::migration_handler::calculate_concentrated_initial_liquidity;
use crate::migration_handler::ConcentratedLiquidity;
use crate::migration_handler::MigrationHandler;
use crate::utils_math::safe_mul_div_cast_u128;
use crate::{
    constants::{
        fee::PROTOCOL_LIQUIDITY_MIGRATION_FEE_BPS, BASIS_POINT_MAX, MAX_SQRT_PRICE, MIN_SQRT_PRICE,
    },
    safe_math::SafeMath,
    u128x128_math::Rounding,
};

use proptest::prelude::*;
use ruint::aliases::U256;

proptest! {
    #[test]
    fn test_damm_v2_protocol_migration_fee(
        migration_quote_amount in 100_000_000u64..u64::MAX,
        migration_sqrt_price in MIN_SQRT_PRICE..MAX_SQRT_PRICE
    ) {
         let price = U256::from(migration_sqrt_price)
            .safe_mul(U256::from(migration_sqrt_price))
            .unwrap();

        let (migration_base_amount, _rem) =
                U256::from(migration_quote_amount).safe_shl(128).unwrap().div_rem(price);
        let  migration_base_amount: u64 = migration_base_amount.try_into().unwrap();


        let initial_liquidity = calculate_concentrated_initial_liquidity(migration_base_amount, migration_quote_amount, migration_sqrt_price).unwrap();

        if initial_liquidity == 0 {
            return Ok(());
        }

        let liquidity_handler = ConcentratedLiquidity{migration_sqrt_price};
        let (base_fee_amount, quote_fee_amount) = liquidity_handler.get_migration_protocol_fees(
             migration_base_amount,
            migration_quote_amount,
            PROTOCOL_LIQUIDITY_MIGRATION_FEE_BPS,
          ).unwrap();

        let excluced_fee_migration_base_amount = migration_base_amount.checked_sub(base_fee_amount).unwrap();
        let excluced_fee_migration_quote_amount = migration_quote_amount.checked_sub(quote_fee_amount).unwrap();

        let excluded_fee_initial_liquidity = calculate_concentrated_initial_liquidity(excluced_fee_migration_base_amount, excluced_fee_migration_quote_amount, migration_sqrt_price).unwrap();

        let fee_liquidity = initial_liquidity.checked_sub(excluded_fee_initial_liquidity).unwrap();

        let fee_liquidity_bps = safe_mul_div_cast_u128(fee_liquidity, BASIS_POINT_MAX.into(), initial_liquidity, Rounding::Down).unwrap();

        // println!("fee_liquidity_bps {} {} {} {} {}",  fee_liquidity_bps, migration_base_amount, migration_quote_amount, base_fee_amount, quote_fee_amount);
        assert!(fee_liquidity_bps <= PROTOCOL_LIQUIDITY_MIGRATION_FEE_BPS.into());
    }
}

// Removed dead tests in SPEC-DBC-AUDIT-001 Phase 8 (F-001): the
// `test_compounding_protocol_migration_fee` test and the two `test_damm_v1_*`
// tests exercised the removed `CompoundingLiquidity` handler / DAMM v1
// (MeteoraDammDisabled) migration path. Both are firewall-unreachable in
// production (REQ-I-002 + MeteoraDammDisabled rejected at config creation), so
// the code they tested was deleted. The live DAMM v2 ConcentratedLiquidity path
// remains covered by `test_damm_v2_protocol_migration_fee` above.
