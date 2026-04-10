use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    ed25519_program,
    sysvar::instructions::{load_current_index_checked, load_instruction_at_checked},
};
use borsh::BorshDeserialize;
use crate::state::IpworldState;

/// Verifies that the previous instruction in the transaction is an Ed25519Program
/// signature verification, signed by `ipworld_state.authority`, and deserializes
/// the signed message into the expected struct T.
///
/// Transaction layout expected:
///   ix[N-1]: Ed25519Program.verify(signature, authority_pubkey, message)
///   ix[N]:   DBC instruction that calls this helper
///
/// Standard Solana pattern used by Switchboard, Pyth, Wormhole.
pub fn verify_authority_sig<T: BorshDeserialize>(
    sysvar: &AccountInfo,
    state: &IpworldState,
) -> Result<T> {
    // 1. Get our instruction index
    let current_idx = load_current_index_checked(sysvar)
        .map_err(|_| error!(IpworldAuthError::SysvarLoadFailed))?;

    require!(current_idx > 0, IpworldAuthError::MissingEd25519Ix);

    // 2. Load the previous instruction — must be Ed25519Program
    let ed25519_ix = load_instruction_at_checked((current_idx - 1) as usize, sysvar)
        .map_err(|_| error!(IpworldAuthError::SysvarLoadFailed))?;

    require!(
        ed25519_ix.program_id == ed25519_program::ID,
        IpworldAuthError::MissingEd25519Ix
    );

    // 3. Parse the Ed25519 instruction data
    // Layout: [num_signatures(1), padding(1), sig_offset(2), sig_len(2),
    //          pubkey_offset(2), pubkey_len(2), msg_offset(2), msg_len(2),
    //          pubkey(32), signature(64), message(variable)]
    let ix_data = &ed25519_ix.data;
    require!(ix_data.len() >= 112, IpworldAuthError::InvalidEd25519Data); // 16 header + 32 pubkey + 64 sig

    let num_signatures = ix_data[0];
    require!(num_signatures == 1, IpworldAuthError::InvalidEd25519Data);

    // Ed25519 instruction header layout (per signature):
    //   [0]: num_signatures, [1]: padding
    //   [2..4]: signature_offset, [4..6]: signature_instruction_index
    //   [6..8]: public_key_offset, [8..10]: public_key_instruction_index
    //   [10..12]: message_data_offset, [12..14]: message_data_size, [14..16]: message_instruction_index
    let pubkey_offset = u16::from_le_bytes([ix_data[6], ix_data[7]]) as usize;
    let msg_offset = u16::from_le_bytes([ix_data[10], ix_data[11]]) as usize;
    let msg_len = u16::from_le_bytes([ix_data[12], ix_data[13]]) as usize;

    require!(
        ix_data.len() >= pubkey_offset + 32,
        IpworldAuthError::InvalidEd25519Data
    );
    require!(
        ix_data.len() >= msg_offset + msg_len,
        IpworldAuthError::InvalidEd25519Data
    );

    // 4. Verify the signing pubkey matches our authority
    let signer_pubkey = Pubkey::try_from(&ix_data[pubkey_offset..pubkey_offset + 32])
        .map_err(|_| error!(IpworldAuthError::InvalidEd25519Data))?;

    require!(
        signer_pubkey == state.authority,
        IpworldAuthError::UnauthorizedSigner
    );

    // 5. Deserialize the signed message into the expected struct
    let msg_bytes = &ix_data[msg_offset..msg_offset + msg_len];
    let auth_data = T::try_from_slice(msg_bytes)
        .map_err(|_| error!(IpworldAuthError::InvalidAuthPayload))?;

    Ok(auth_data)
}

#[error_code]
pub enum IpworldAuthError {
    #[msg("Failed to load instructions sysvar")]
    SysvarLoadFailed,
    #[msg("Missing Ed25519 program instruction before this instruction")]
    MissingEd25519Ix,
    #[msg("Invalid Ed25519 instruction data")]
    InvalidEd25519Data,
    #[msg("Signer does not match ipworld authority")]
    UnauthorizedSigner,
    #[msg("Failed to deserialize auth payload")]
    InvalidAuthPayload,
}
