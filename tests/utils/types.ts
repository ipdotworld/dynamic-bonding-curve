import { DynamicBondingCurve } from "../../target/types/dynamic_bonding_curve";
import { DynamicVault as Vault } from "./idl/dynamic_vault";
import { DynamicAmm } from "../utils/idl/dynamic_amm";
import { IdlAccounts, IdlTypes, Program } from "@coral-xyz/anchor";
import { CpAmm as DammV2 } from "./idl/damm_v2";
import { DynamicAmm as DammV1 } from "./idl/dynamic_amm";

export type VirtualCurveProgram = Program<DynamicBondingCurve>;

export type Pool = IdlAccounts<DynamicBondingCurve>["virtualPool"];
export type PoolConfig = IdlAccounts<DynamicBondingCurve>["poolConfig"];
export type TokenVerification =
  IdlAccounts<DynamicBondingCurve>["tokenVerification"];
export type PartnerMetadata =
  IdlAccounts<DynamicBondingCurve>["partnerMetadata"];
export type VirtualPoolMetadata =
  IdlAccounts<DynamicBondingCurve>["virtualPoolMetadata"];
// SPEC-DBC-AUDIT-001: ClaimFeeOperator (ClaimFeeOperator cluster) and
// MeteoraDammMigrationMetadata (DAMM v2 metadata instruction) accounts were
// removed from the program. Their helper type aliases are deleted accordingly.
export type LockEscrow = IdlAccounts<DynamicAmm>["lockEscrow"];
export type DammV1Pool = IdlAccounts<DammV1>["pool"];
export type DammV2Pool = IdlAccounts<DammV2>["pool"];
export type DynamicVault = IdlAccounts<Vault>["vault"];
export type BorshFeeTimeScheduler = IdlTypes<DammV2>["borshFeeTimeScheduler"];
export type PodAlignedFeeTimeScheduler =
  IdlTypes<DammV2>["podAlignedFeeTimeScheduler"];
export type PodAlignedFeeMarketCapScheduler =
  IdlTypes<DammV2>["podAlignedFeeMarketCapScheduler"];
