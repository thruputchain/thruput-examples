// Generated from dev_wallet.spec.xdr - DevWallet interface v0.1.0
// DO NOT EDIT. Re-run codegen to update.

import type { ContractAddress } from "@groundhogchain/protocol";
import { contractEntrypointID } from "@groundhogchain/protocol";
import { fromHex } from "@groundhogchain/protocol/utils";
import { ContractTypeKind, contractSpecString } from "@groundhogchain/contract-spec";
import { type ContractSpec, createContractCodecContext, defineContractMethod, type ContractException, type FixedBytes } from "@groundhogchain/client/contract";

const s = contractSpecString;

const entrypoints = {
  DevWallet: {
    createWallet: contractEntrypointID(fromHex("78b187d37f222827")),
    deploy: contractEntrypointID(fromHex("f969542572bd6860")),
    doAction: contractEntrypointID(fromHex("a0fff94c64fbaf3c")),
    initialize: contractEntrypointID(fromHex("77b7af6606c91791")),
  },
} as const;

export interface DevWalletCreateWalletArgs {
  nonce: FixedBytes<32>;
  walletContractHash: FixedBytes<32>;
  owner: FixedBytes<32>;
}
export type DevWalletCreateWalletResult = ContractAddress;

export interface DevWalletDeployArgs {
  nonce: FixedBytes<32>;
  contractHash: FixedBytes<32>;
}
export type DevWalletDeployResult = ContractAddress;

export interface DevWalletDoActionArgs {
  invocationBytes: Uint8Array;
}
export type DevWalletDoActionResult = void;

export interface DevWalletInitializeArgs {
  owner: FixedBytes<32>;
}
export type DevWalletInitializeResult = void;

export type DevWalletDeclaredException = never;
export type DevWalletException = ContractException<DevWalletDeclaredException>;

export const spec: ContractSpec = {
  interfaces: [
    {
      name: s("DevWallet"),
      vers: s("0.1.0"),
      throws: [
      ],
      methods: [
        {
          name: s("create_wallet"),
          args: [
            { name: s("nonce"), ty: { v: ContractTypeKind.Array, array: { element: { v: ContractTypeKind.U8 }, len: 32n } } },
            { name: s("wallet_contract_hash"), ty: { v: ContractTypeKind.Array, array: { element: { v: ContractTypeKind.U8 }, len: 32n } } },
            { name: s("owner"), ty: { v: ContractTypeKind.Array, array: { element: { v: ContractTypeKind.U8 }, len: 32n } } },
          ],
          return_type: { v: ContractTypeKind.Address },
        },
        {
          name: s("deploy"),
          args: [
            { name: s("nonce"), ty: { v: ContractTypeKind.Array, array: { element: { v: ContractTypeKind.U8 }, len: 32n } } },
            { name: s("contract_hash"), ty: { v: ContractTypeKind.Array, array: { element: { v: ContractTypeKind.U8 }, len: 32n } } },
          ],
          return_type: { v: ContractTypeKind.Address },
        },
        {
          name: s("do_action"),
          args: [
            { name: s("invocation_bytes"), ty: { v: ContractTypeKind.Vector, vector: { element: { v: ContractTypeKind.U8 }, max_len: 4294967295n } } },
          ],
          return_type: { v: ContractTypeKind.Void },
        },
        {
          name: s("initialize"),
          args: [
            { name: s("owner"), ty: { v: ContractTypeKind.Array, array: { element: { v: ContractTypeKind.U8 }, len: 32n } } },
          ],
          return_type: { v: ContractTypeKind.Void },
        },
      ],
    },
  ],
  type_defs: [
  ],
  events: [
  ],
};

const codecs = createContractCodecContext(spec.type_defs);

export const DevWallet = {
  createWallet: defineContractMethod<
    DevWalletCreateWalletArgs,
    DevWalletCreateWalletResult,
    DevWalletDeclaredException
  >({
    entrypoint: entrypoints.DevWallet.createWallet,
    args: [
      {
        abiName: "nonce",
        publicName: "nonce",
        type: spec.interfaces[0]!.methods[0]!.args[0]!.ty,
      },
      {
        abiName: "wallet_contract_hash",
        publicName: "walletContractHash",
        type: spec.interfaces[0]!.methods[0]!.args[1]!.ty,
      },
      {
        abiName: "owner",
        publicName: "owner",
        type: spec.interfaces[0]!.methods[0]!.args[2]!.ty,
      },
    ],
    returnType: spec.interfaces[0]!.methods[0]!.return_type,
    throws: [
    ],
    codecs,
  }),
  deploy: defineContractMethod<
    DevWalletDeployArgs,
    DevWalletDeployResult,
    DevWalletDeclaredException
  >({
    entrypoint: entrypoints.DevWallet.deploy,
    args: [
      {
        abiName: "nonce",
        publicName: "nonce",
        type: spec.interfaces[0]!.methods[1]!.args[0]!.ty,
      },
      {
        abiName: "contract_hash",
        publicName: "contractHash",
        type: spec.interfaces[0]!.methods[1]!.args[1]!.ty,
      },
    ],
    returnType: spec.interfaces[0]!.methods[1]!.return_type,
    throws: [
    ],
    codecs,
  }),
  doAction: defineContractMethod<
    DevWalletDoActionArgs,
    DevWalletDoActionResult,
    DevWalletDeclaredException
  >({
    entrypoint: entrypoints.DevWallet.doAction,
    args: [
      {
        abiName: "invocation_bytes",
        publicName: "invocationBytes",
        type: spec.interfaces[0]!.methods[2]!.args[0]!.ty,
      },
    ],
    returnType: spec.interfaces[0]!.methods[2]!.return_type,
    throws: [
    ],
    codecs,
  }),
  initialize: defineContractMethod<
    DevWalletInitializeArgs,
    DevWalletInitializeResult,
    DevWalletDeclaredException
  >({
    entrypoint: entrypoints.DevWallet.initialize,
    args: [
      {
        abiName: "owner",
        publicName: "owner",
        type: spec.interfaces[0]!.methods[3]!.args[0]!.ty,
      },
    ],
    returnType: spec.interfaces[0]!.methods[3]!.return_type,
    throws: [
    ],
    codecs,
  }),
} as const;
