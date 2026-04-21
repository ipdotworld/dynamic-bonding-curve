#[cfg(test)]
mod test_panic_defense {
    use crate::{
        curve::{
            get_delta_amount_base_unsigned, get_delta_amount_quote_unsigned,
            get_next_sqrt_price_from_input, get_next_sqrt_price_from_output,
        },
        math::fee_math::get_fee_in_period,
        u128x128_math::Rounding,
        PoolError,
    };

    // -------------------------------------------------------------------------
    // Test 1: get_next_sqrt_price_from_input with zero sqrt_price
    // Expects PoolError::InvalidSqrtPrice, not a panic
    // -------------------------------------------------------------------------
    #[test]
    fn test_zero_sqrt_price_returns_invalid_error_not_panic() {
        let sqrt_price = 0u128; // zero price — must be caught by require!()
        let liquidity = 1_000_000u128;
        let amount_in = 100u64;

        let result = get_next_sqrt_price_from_input(sqrt_price, liquidity, amount_in, true);

        assert!(result.is_err(), "expected an error for zero sqrt_price");
        let err = result.unwrap_err();
        assert_eq!(
            err,
            anchor_lang::error!(PoolError::InvalidSqrtPrice),
            "expected PoolError::InvalidSqrtPrice"
        );
    }

    // -------------------------------------------------------------------------
    // Test 2: get_next_sqrt_price_from_output with zero sqrt_price
    // Expects PoolError::InvalidSqrtPrice
    // -------------------------------------------------------------------------
    #[test]
    fn test_zero_sqrt_price_on_output_path_returns_invalid_error() {
        let sqrt_price = 0u128;
        let liquidity = 1_000_000u128;
        let amount_out = 50u64;

        let result = get_next_sqrt_price_from_output(sqrt_price, liquidity, amount_out, false);

        assert!(result.is_err());
        let err = result.unwrap_err();
        assert_eq!(err, anchor_lang::error!(PoolError::InvalidSqrtPrice));
    }

    // -------------------------------------------------------------------------
    // Test 3: get_next_sqrt_price_from_input with zero liquidity
    // Expects PoolError::InsufficientLiquidity
    // -------------------------------------------------------------------------
    #[test]
    fn test_zero_liquidity_returns_insufficient_liquidity() {
        let sqrt_price = 1u128 << 64; // valid non-zero price (Q64.64 = 1.0)
        let liquidity = 0u128; // zero liquidity — must be caught by require!()
        let amount_in = 100u64;

        let result = get_next_sqrt_price_from_input(sqrt_price, liquidity, amount_in, false);

        assert!(result.is_err(), "expected an error for zero liquidity");
        let err = result.unwrap_err();
        assert_eq!(
            err,
            anchor_lang::error!(PoolError::InsufficientLiquidity),
            "expected PoolError::InsufficientLiquidity"
        );
    }

    // -------------------------------------------------------------------------
    // Test 4: get_delta_amount_base_unsigned with inverted sqrt prices
    // lower_sqrt_price > upper_sqrt_price → checked_sub underflow → MathOverflow
    // -------------------------------------------------------------------------
    #[test]
    fn test_inverted_sqrt_prices_returns_math_overflow() {
        let lower_sqrt_price = 2u128 << 64; // higher value in "lower" position
        let upper_sqrt_price = 1u128 << 64; // lower value in "upper" position
        let liquidity = 1_000_000u128;

        let result = get_delta_amount_base_unsigned(
            lower_sqrt_price,
            upper_sqrt_price,
            liquidity,
            Rounding::Down,
        );

        assert!(
            result.is_err(),
            "expected an error for inverted sqrt prices"
        );
        let err = result.unwrap_err();
        assert_eq!(
            err,
            anchor_lang::error!(PoolError::MathOverflow),
            "expected PoolError::MathOverflow for inverted price range"
        );
    }

    // -------------------------------------------------------------------------
    // Test 5: get_delta_amount_quote_unsigned with inverted sqrt prices
    // Same underflow path via get_delta_amount_quote_unsigned_unchecked
    // -------------------------------------------------------------------------
    #[test]
    fn test_inverted_sqrt_prices_quote_returns_math_overflow() {
        let lower_sqrt_price = 5u128 << 64;
        let upper_sqrt_price = 1u128 << 64;
        let liquidity = 500_000u128;

        let result = get_delta_amount_quote_unsigned(
            lower_sqrt_price,
            upper_sqrt_price,
            liquidity,
            Rounding::Up,
        );

        assert!(result.is_err());
        let err = result.unwrap_err();
        assert_eq!(err, anchor_lang::error!(PoolError::MathOverflow));
    }

    // -------------------------------------------------------------------------
    // Test 6: get_fee_in_period — checked_shr path
    // Normal call verifies function does not panic and returns Ok
    // -------------------------------------------------------------------------
    #[test]
    fn test_fee_in_period_normal_case_returns_ok() {
        // cliff = 10_000 bps (1%), reduction_factor = 500 (5%), period = 10
        let cliff_fee_numerator = 10_000u64;
        let reduction_factor = 500u64;
        let passed_period = 10u16;

        let result = get_fee_in_period(cliff_fee_numerator, reduction_factor, passed_period);

        assert!(
            result.is_ok(),
            "expected Ok for normal get_fee_in_period inputs"
        );
        let fee = result.unwrap();
        // Fee must be <= cliff and >= 0
        assert!(
            fee <= cliff_fee_numerator,
            "fee should not exceed cliff_fee_numerator"
        );
    }

    // -------------------------------------------------------------------------
    // Test 7: get_fee_in_period — zero period returns the cliff fee unchanged
    // -------------------------------------------------------------------------
    #[test]
    fn test_fee_in_period_zero_period_returns_cliff_fee() {
        let cliff_fee_numerator = 50_000u64;
        let reduction_factor = 1_000u64;
        let passed_period = 0u16;

        let result = get_fee_in_period(cliff_fee_numerator, reduction_factor, passed_period);

        assert!(result.is_ok());
        let fee = result.unwrap();
        // When passed_period == 0, pow returns 1 in Q64, so fee == cliff
        assert_eq!(fee, cliff_fee_numerator);
    }

    // -------------------------------------------------------------------------
    // Test 8: get_fee_in_period — reduction_factor = BASIS_POINT_MAX (10_000)
    // 1 - 1.0 = 0 → the base becomes 0 in Q64.64, which makes the pow
    // intermediate safe_sub underflow → function returns Err (MathOverflow).
    // This is the correct defensive behaviour: the contract rejects an invalid
    // 100% reduction parameter instead of silently returning 0 or panicking.
    // -------------------------------------------------------------------------
    #[test]
    fn test_fee_in_period_full_reduction_returns_error() {
        let cliff_fee_numerator = 100_000u64;
        let reduction_factor = 10_000u64; // = BASIS_POINT_MAX (invalid in practice)
        let passed_period = 5u16;

        let result = get_fee_in_period(cliff_fee_numerator, reduction_factor, passed_period);

        // The function must return Err rather than panicking
        assert!(
            result.is_err(),
            "reduction_factor == BASIS_POINT_MAX should return an error, not panic"
        );
    }
}
