#[cfg(test)]
mod test_fee_distribution {
    // SPEC-DBC-004 Phase 2 — REQ-S-006: production fee distribution helpers
    // are now sourced from `state/fee.rs`. The local re-definitions previously
    // mirrored the apply_swap_result inline logic; both sites converged to
    // `state::fee::distribute_quote_fee` / `distribute_base_fee` as part of
    // Phase 2 sub-step 2.3. The test bodies below exercise the production
    // module directly via `.expect(...)` for the `Result<...>` return type.
    //
    // SPEC-DBC-004 Phase 3 — REQ-I-001: `distribute_quote_fee` is now 3-way
    // (ip_owner + airdrop + treasury). `creator_share` and the `creator`
    // recipient bucket were removed alongside `creator_quote_fee`.
    use crate::{
        safe_math::SafeMath,
        state::config::FEE_SHARE_PRECISION,
        state::fee::{distribute_base_fee, distribute_quote_fee},
    };

    // =========================================================================
    // QUOTE FEE DISTRIBUTION TESTS (3-way: ip_owner + airdrop + treasury)
    // =========================================================================

    // -------------------------------------------------------------------------
    // Test 1: Even split — total_fee divisible by all shares
    // Shares: ip_owner=20%, airdrop=10% → treasury=70%
    // With a fee of 1_000_000 every portion divides evenly.
    // -------------------------------------------------------------------------
    #[test]
    fn test_quote_fee_even_split_sums_to_total() {
        let total_fee = 1_000_000u64;
        let ip_owner_share = 200_000u32; // 20%
        let airdrop_share = 100_000u32; // 10%

        let (ip_owner, airdrop, treasury) =
            distribute_quote_fee(total_fee, ip_owner_share, airdrop_share)
                .expect("distribute_quote_fee");

        assert_eq!(ip_owner, 200_000, "ip_owner should be 20%");
        assert_eq!(airdrop, 100_000, "airdrop should be 10%");
        assert_eq!(treasury, 700_000, "treasury should be 70%");

        // Invariant: no value is created
        let sum = ip_owner
            .safe_add(airdrop)
            .unwrap()
            .safe_add(treasury)
            .unwrap();
        assert_eq!(sum, total_fee, "parts must sum to total fee");
    }

    // -------------------------------------------------------------------------
    // Test 2: Odd split — total_fee NOT divisible by all shares.
    // Ensure total distributed <= total_fee (no value creation).
    // Remainder goes to treasury via subtraction (never rounds up).
    // -------------------------------------------------------------------------
    #[test]
    fn test_quote_fee_odd_split_no_value_creation() {
        let total_fee = 1_000_007u64; // not cleanly divisible
        let ip_owner_share = 200_000u32; // 20%
        let airdrop_share = 100_000u32; // 10%

        let (ip_owner, airdrop, treasury) =
            distribute_quote_fee(total_fee, ip_owner_share, airdrop_share)
                .expect("distribute_quote_fee");

        let sum = ip_owner
            .safe_add(airdrop)
            .unwrap()
            .safe_add(treasury)
            .unwrap();

        // Critical invariant: we never distribute more than we have
        assert!(
            sum <= total_fee,
            "distributed amount ({sum}) must not exceed total_fee ({total_fee})"
        );
        assert_eq!(
            sum, total_fee,
            "treasury absorbs all dust — parts must still sum to total"
        );
    }

    // -------------------------------------------------------------------------
    // Test 3: Zero shares — ip_owner_share=0, airdrop_share=0
    // Everything goes to treasury.
    // -------------------------------------------------------------------------
    #[test]
    fn test_quote_fee_zero_shares_all_to_treasury() {
        let total_fee = 500_000u64;
        let ip_owner_share = 0u32;
        let airdrop_share = 0u32;

        let (ip_owner, airdrop, treasury) =
            distribute_quote_fee(total_fee, ip_owner_share, airdrop_share)
                .expect("distribute_quote_fee");

        assert_eq!(ip_owner, 0, "ip_owner must be zero");
        assert_eq!(airdrop, 0, "airdrop must be zero");
        assert_eq!(treasury, total_fee, "treasury must receive everything");
    }

    // -------------------------------------------------------------------------
    // Test 4: Max shares — both shares set near (FEE_SHARE_PRECISION/2)
    // ip_owner=49%, airdrop=49% → treasury gets 2% remainder.
    // -------------------------------------------------------------------------
    #[test]
    fn test_quote_fee_max_shares_treasury_gets_minimal_remainder() {
        let total_fee = 1_000_000u64;
        // 49% + 49% = 98%; treasury gets the remaining 2%
        let ip_owner_share = 490_000u32;
        let airdrop_share = 490_000u32;

        let (ip_owner, airdrop, treasury) =
            distribute_quote_fee(total_fee, ip_owner_share, airdrop_share)
                .expect("distribute_quote_fee");

        // Treasury is the residual — ensures no value leaks
        let expected_treasury = total_fee - ip_owner - airdrop;
        assert_eq!(treasury, expected_treasury);

        // Treasury must be a small positive value (20_000 = 2%)
        assert!(treasury > 0, "treasury should be positive with leftover");

        let sum = ip_owner
            .safe_add(airdrop)
            .unwrap()
            .safe_add(treasury)
            .unwrap();
        assert_eq!(sum, total_fee);
    }

    // =========================================================================
    // BASE FEE DISTRIBUTION TESTS
    // =========================================================================

    // -------------------------------------------------------------------------
    // Test 5: Even base fee split
    // token_airdrop_share = 30% → ip_treasury = 70%
    // -------------------------------------------------------------------------
    #[test]
    fn test_base_fee_even_split_sums_to_total() {
        let total_fee = 2_000_000u64;
        let token_airdrop_share = 300_000u32; // 30%

        let (token_airdrop, ip_treasury) = distribute_base_fee(total_fee, token_airdrop_share)
            .expect("distribute_base_fee");

        assert_eq!(token_airdrop, 600_000, "token_airdrop should be 30%");
        assert_eq!(ip_treasury, 1_400_000, "ip_treasury should be 70%");
        assert_eq!(
            token_airdrop.safe_add(ip_treasury).unwrap(),
            total_fee,
            "parts must sum to total fee"
        );
    }

    // -------------------------------------------------------------------------
    // Test 6: Zero token_airdrop_share — everything goes to ip_treasury
    // -------------------------------------------------------------------------
    #[test]
    fn test_base_fee_zero_airdrop_share_all_to_treasury() {
        let total_fee = 300_000u64;
        let token_airdrop_share = 0u32;

        let (token_airdrop, ip_treasury) = distribute_base_fee(total_fee, token_airdrop_share)
            .expect("distribute_base_fee");

        assert_eq!(token_airdrop, 0);
        assert_eq!(ip_treasury, total_fee);
    }

    // -------------------------------------------------------------------------
    // Test 7: Full token_airdrop_share (100%) — everything goes to token_airdrop
    // -------------------------------------------------------------------------
    #[test]
    fn test_base_fee_full_airdrop_share_nothing_to_treasury() {
        let total_fee = 750_000u64;
        let token_airdrop_share = FEE_SHARE_PRECISION; // 100%

        let (token_airdrop, ip_treasury) = distribute_base_fee(total_fee, token_airdrop_share)
            .expect("distribute_base_fee");

        assert_eq!(token_airdrop, total_fee);
        assert_eq!(ip_treasury, 0);
    }

    // -------------------------------------------------------------------------
    // Test 8: Odd base fee — no value creation with rounding down
    // -------------------------------------------------------------------------
    #[test]
    fn test_base_fee_odd_amount_no_value_creation() {
        let total_fee = 999_999u64;
        let token_airdrop_share = 333_333u32; // ~33.3333%

        let (token_airdrop, ip_treasury) = distribute_base_fee(total_fee, token_airdrop_share)
            .expect("distribute_base_fee");

        let sum = token_airdrop.safe_add(ip_treasury).unwrap();
        assert_eq!(sum, total_fee, "parts must sum to total fee exactly");
        assert!(
            token_airdrop <= total_fee,
            "token_airdrop must not exceed total"
        );
    }
}
