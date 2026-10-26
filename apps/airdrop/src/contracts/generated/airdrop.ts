// Generated from airdrop.spec.xdr - Airdrop interface v0.1.0
// DO NOT EDIT. Re-run codegen to update.

import * as __gh_protocol from "@thruputchain/protocol";
import * as __gh_protocol_utils from "@thruputchain/protocol/utils";
import * as __gh_contract_spec from "@thruputchain/contract-spec";
import * as __gh_client_contract from "@thruputchain/client/contract";

const __gh_s = __gh_contract_spec.contractSpecString;

const __gh_entrypoints = {
  Airdrop: {
    v0_1: {
      claim: __gh_protocol.contractEntrypointID(
        __gh_protocol_utils.fromHex("a8196c0cfce50e1d"),
      ),
      config: __gh_protocol.contractEntrypointID(
        __gh_protocol_utils.fromHex("f6dce3659a7ee880"),
      ),
      eligible: __gh_protocol.contractEntrypointID(
        __gh_protocol_utils.fromHex("76a571675c57785b"),
      ),
      hasClaimed: __gh_protocol.contractEntrypointID(
        __gh_protocol_utils.fromHex("d17ee56513f77704"),
      ),
      initialize: __gh_protocol.contractEntrypointID(
        __gh_protocol_utils.fromHex("5659a5c2694b4f3c"),
      ),
    },
  },
} as const;

export namespace airdrop {
  export namespace v0_1 {
    export namespace implementation {
      export type AirdropError = 1n | 2n | 3n | 4n | 5n;

      export interface Configuration {
        rewards: __gh_codegen.airdrop$v0_1$implementation$Reward[];
        restricted: boolean;
      }

      export interface Reward {
        token: __gh_protocol.ContractAddress;
        amount: bigint;
      }

      export interface Claimed extends __gh_client_contract.DecodedContractEvent<
        "Claimed",
        { recipient: __gh_protocol.ContractAddress },
        {}
      > {}

      export interface ClaimedFilter {
        recipient?: __gh_client_contract.ContractEventFilterValue<__gh_protocol.ContractAddress>;
      }
    }
  }
}

export namespace Airdrop {
  export namespace v0_1 {
    export type ClaimArgs = void;
    export type ClaimResult = void;

    export type ConfigArgs = void;
    export type ConfigResult =
      __gh_codegen.airdrop$v0_1$implementation$Configuration;

    export interface EligibleArgs {
      address: __gh_protocol.ContractAddress;
    }
    export type EligibleResult = boolean;

    export interface HasClaimedArgs {
      address: __gh_protocol.ContractAddress;
    }
    export type HasClaimedResult = boolean;

    export interface InitializeArgs {
      rewards: __gh_codegen.airdrop$v0_1$implementation$Reward[];
      addresses: __gh_protocol.ContractAddress[];
    }
    export type InitializeResult = void;

    export type DeclaredException = {
      kind: "declared";
      name: "AirdropError";
      selector: 0x27a9bc15780df61bn;
      value: __gh_codegen.airdrop$v0_1$implementation$AirdropError;
    };
    export type Exception =
      __gh_client_contract.ContractException<DeclaredException>;
  }
}

export const spec: __gh_client_contract.ContractSpec = {
  interfaces: [
    {
      name: __gh_s("Airdrop"),
      vers: __gh_s("0.1.0"),
      throws: [
        {
          selector: 0x27a9bc15780df61bn,
          ty: {
            v: __gh_contract_spec.ContractTypeKind.Named,
            named: {
              crate_name: __gh_s("airdrop"),
              major: __gh_s("0.1"),
              module_path: __gh_s("airdrop::implementation"),
              declared: __gh_s("AirdropError"),
            },
          },
        },
      ],
      methods: [
        {
          name: __gh_s("claim"),
          args: [],
          return_type: { v: __gh_contract_spec.ContractTypeKind.Void },
          effect: null,
        },
        {
          name: __gh_s("config"),
          args: [],
          return_type: {
            v: __gh_contract_spec.ContractTypeKind.Named,
            named: {
              crate_name: __gh_s("airdrop"),
              major: __gh_s("0.1"),
              module_path: __gh_s("airdrop::implementation"),
              declared: __gh_s("Configuration"),
            },
          },
          effect: null,
        },
        {
          name: __gh_s("eligible"),
          args: [
            {
              name: __gh_s("address"),
              ty: { v: __gh_contract_spec.ContractTypeKind.Address },
            },
          ],
          return_type: { v: __gh_contract_spec.ContractTypeKind.Bool },
          effect: null,
        },
        {
          name: __gh_s("has_claimed"),
          args: [
            {
              name: __gh_s("address"),
              ty: { v: __gh_contract_spec.ContractTypeKind.Address },
            },
          ],
          return_type: { v: __gh_contract_spec.ContractTypeKind.Bool },
          effect: null,
        },
        {
          name: __gh_s("initialize"),
          args: [
            {
              name: __gh_s("rewards"),
              ty: {
                v: __gh_contract_spec.ContractTypeKind.Vector,
                vector: {
                  element: {
                    v: __gh_contract_spec.ContractTypeKind.Named,
                    named: {
                      crate_name: __gh_s("airdrop"),
                      major: __gh_s("0.1"),
                      module_path: __gh_s("airdrop::implementation"),
                      declared: __gh_s("Reward"),
                    },
                  },
                  max_len: 16n,
                },
              },
            },
            {
              name: __gh_s("addresses"),
              ty: {
                v: __gh_contract_spec.ContractTypeKind.Vector,
                vector: {
                  element: { v: __gh_contract_spec.ContractTypeKind.Address },
                  max_len: 256n,
                },
              },
            },
          ],
          return_type: { v: __gh_contract_spec.ContractTypeKind.Void },
          effect: null,
        },
      ],
    },
  ],
  type_defs: [
    {
      v: __gh_contract_spec.ContractTypeDefKind.TypeDefEnum,
      enum_def: {
        name: {
          crate_name: __gh_s("airdrop"),
          major: __gh_s("0.1"),
          module_path: __gh_s("airdrop::implementation"),
          declared: __gh_s("AirdropError"),
        },
        variants: [
          { name: __gh_s("NotInitialized"), value: 1n },
          { name: __gh_s("AlreadyInitialized"), value: 2n },
          { name: __gh_s("InvalidConfiguration"), value: 3n },
          { name: __gh_s("NotEligible"), value: 4n },
          { name: __gh_s("AlreadyClaimed"), value: 5n },
        ],
      },
    },
    {
      v: __gh_contract_spec.ContractTypeDefKind.TypeDefStruct,
      struct_def: {
        name: {
          crate_name: __gh_s("airdrop"),
          major: __gh_s("0.1"),
          module_path: __gh_s("airdrop::implementation"),
          declared: __gh_s("Configuration"),
        },
        fields: [
          {
            name: __gh_s("rewards"),
            ty: {
              v: __gh_contract_spec.ContractTypeKind.Vector,
              vector: {
                element: {
                  v: __gh_contract_spec.ContractTypeKind.Named,
                  named: {
                    crate_name: __gh_s("airdrop"),
                    major: __gh_s("0.1"),
                    module_path: __gh_s("airdrop::implementation"),
                    declared: __gh_s("Reward"),
                  },
                },
                max_len: 16n,
              },
            },
          },
          {
            name: __gh_s("restricted"),
            ty: { v: __gh_contract_spec.ContractTypeKind.Bool },
          },
        ],
      },
    },
    {
      v: __gh_contract_spec.ContractTypeDefKind.TypeDefStruct,
      struct_def: {
        name: {
          crate_name: __gh_s("airdrop"),
          major: __gh_s("0.1"),
          module_path: __gh_s("airdrop::implementation"),
          declared: __gh_s("Reward"),
        },
        fields: [
          {
            name: __gh_s("token"),
            ty: { v: __gh_contract_spec.ContractTypeKind.Address },
          },
          {
            name: __gh_s("amount"),
            ty: { v: __gh_contract_spec.ContractTypeKind.I128 },
          },
        ],
      },
    },
  ],
  events: [
    {
      name: {
        crate_name: __gh_s("airdrop"),
        major: __gh_s("0.1"),
        module_path: __gh_s("airdrop::implementation"),
        declared: __gh_s("Claimed"),
      },
      signature: __gh_protocol.topic(
        __gh_protocol_utils.fromHex(
          "ae6c8fe855a685889089626420ef706f35dcd7dd36a7c7f638eeb95e00f515e2",
        ),
      ),
      topics: [
        {
          name: __gh_s("recipient"),
          ty: { v: __gh_contract_spec.ContractTypeKind.Address },
        },
      ],
      fields: [],
    },
  ],
};

const __gh_codecs = __gh_client_contract.createContractCodecContext(
  spec.type_defs,
);

export const Airdrop = {
  v0_1: {
    claim: __gh_client_contract.defineContractMethod<
      Airdrop.v0_1.ClaimArgs,
      Airdrop.v0_1.ClaimResult,
      Airdrop.v0_1.DeclaredException
    >({
      interfaceName: "Airdrop",
      interfaceVersion: "0.1.0",
      abiName: "claim",
      publicName: "claim",
      entrypoint: __gh_entrypoints.Airdrop.v0_1.claim,
      effect: spec.interfaces[0]!.methods[0]!.effect,
      args: [],
      returnType: spec.interfaces[0]!.methods[0]!.return_type,
      throws: [
        {
          selector: 0x27a9bc15780df61bn,
          name: "AirdropError",
          type: spec.interfaces[0]!.throws[0]!.ty,
        },
      ],
      codecs: __gh_codecs,
    }),
    config: __gh_client_contract.defineContractMethod<
      Airdrop.v0_1.ConfigArgs,
      Airdrop.v0_1.ConfigResult,
      Airdrop.v0_1.DeclaredException
    >({
      interfaceName: "Airdrop",
      interfaceVersion: "0.1.0",
      abiName: "config",
      publicName: "config",
      entrypoint: __gh_entrypoints.Airdrop.v0_1.config,
      effect: spec.interfaces[0]!.methods[1]!.effect,
      args: [],
      returnType: spec.interfaces[0]!.methods[1]!.return_type,
      throws: [
        {
          selector: 0x27a9bc15780df61bn,
          name: "AirdropError",
          type: spec.interfaces[0]!.throws[0]!.ty,
        },
      ],
      codecs: __gh_codecs,
    }),
    eligible: __gh_client_contract.defineContractMethod<
      Airdrop.v0_1.EligibleArgs,
      Airdrop.v0_1.EligibleResult,
      Airdrop.v0_1.DeclaredException
    >({
      interfaceName: "Airdrop",
      interfaceVersion: "0.1.0",
      abiName: "eligible",
      publicName: "eligible",
      entrypoint: __gh_entrypoints.Airdrop.v0_1.eligible,
      effect: spec.interfaces[0]!.methods[2]!.effect,
      args: [
        {
          abiName: "address",
          publicName: "address",
          type: spec.interfaces[0]!.methods[2]!.args[0]!.ty,
        },
      ],
      returnType: spec.interfaces[0]!.methods[2]!.return_type,
      throws: [
        {
          selector: 0x27a9bc15780df61bn,
          name: "AirdropError",
          type: spec.interfaces[0]!.throws[0]!.ty,
        },
      ],
      codecs: __gh_codecs,
    }),
    hasClaimed: __gh_client_contract.defineContractMethod<
      Airdrop.v0_1.HasClaimedArgs,
      Airdrop.v0_1.HasClaimedResult,
      Airdrop.v0_1.DeclaredException
    >({
      interfaceName: "Airdrop",
      interfaceVersion: "0.1.0",
      abiName: "has_claimed",
      publicName: "hasClaimed",
      entrypoint: __gh_entrypoints.Airdrop.v0_1.hasClaimed,
      effect: spec.interfaces[0]!.methods[3]!.effect,
      args: [
        {
          abiName: "address",
          publicName: "address",
          type: spec.interfaces[0]!.methods[3]!.args[0]!.ty,
        },
      ],
      returnType: spec.interfaces[0]!.methods[3]!.return_type,
      throws: [
        {
          selector: 0x27a9bc15780df61bn,
          name: "AirdropError",
          type: spec.interfaces[0]!.throws[0]!.ty,
        },
      ],
      codecs: __gh_codecs,
    }),
    initialize: __gh_client_contract.defineContractMethod<
      Airdrop.v0_1.InitializeArgs,
      Airdrop.v0_1.InitializeResult,
      Airdrop.v0_1.DeclaredException
    >({
      interfaceName: "Airdrop",
      interfaceVersion: "0.1.0",
      abiName: "initialize",
      publicName: "initialize",
      entrypoint: __gh_entrypoints.Airdrop.v0_1.initialize,
      effect: spec.interfaces[0]!.methods[4]!.effect,
      args: [
        {
          abiName: "rewards",
          publicName: "rewards",
          type: spec.interfaces[0]!.methods[4]!.args[0]!.ty,
        },
        {
          abiName: "addresses",
          publicName: "addresses",
          type: spec.interfaces[0]!.methods[4]!.args[1]!.ty,
        },
      ],
      returnType: spec.interfaces[0]!.methods[4]!.return_type,
      throws: [
        {
          selector: 0x27a9bc15780df61bn,
          name: "AirdropError",
          type: spec.interfaces[0]!.throws[0]!.ty,
        },
      ],
      codecs: __gh_codecs,
    }),
  },
} as const;

export const airdrop = {
  v0_1: {
    implementation: {
      AirdropError: {
        NotInitialized: 1n,
        AlreadyInitialized: 2n,
        InvalidConfiguration: 3n,
        NotEligible: 4n,
        AlreadyClaimed: 5n,
      },
      Claimed: __gh_client_contract.defineContractEvent<
        "Claimed",
        airdrop.v0_1.implementation.Claimed["topics"],
        airdrop.v0_1.implementation.Claimed["fields"],
        airdrop.v0_1.implementation.ClaimedFilter
      >({
        name: "Claimed",
        signature: spec.events[0]!.signature,
        topics: [
          {
            name: "recipient",
            type: spec.events[0]!.topics[0]!.ty,
            representation: "address",
          },
        ],
        fields: [],
        codecs: __gh_codecs,
      }),
    },
  },
} as const;

export type AirdropEvent = airdrop.v0_1.implementation.Claimed;

export function decodeEvent(__gh_event: {
  topics: globalThis.Uint8Array[];
  data: globalThis.Uint8Array;
}): AirdropEvent | null {
  return airdrop.v0_1.implementation.Claimed.decode(__gh_event);
}

// The types the namespaces above refer to, under names no declaration can capture.
export namespace __gh_codegen {
  export type airdrop$v0_1$implementation$AirdropError =
    airdrop.v0_1.implementation.AirdropError;
  export type airdrop$v0_1$implementation$Configuration =
    airdrop.v0_1.implementation.Configuration;
  export type airdrop$v0_1$implementation$Reward =
    airdrop.v0_1.implementation.Reward;
}
