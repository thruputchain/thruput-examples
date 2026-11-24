// Generated from nft_drop_factory.spec.xdr - NftDropFactory interface v0.1.0
// DO NOT EDIT. Re-run codegen to update.

import * as __gh_protocol from "@thruputchain/protocol";
import * as __gh_protocol_utils from "@thruputchain/protocol/utils";
import * as __gh_contract_spec from "@thruputchain/contract-spec";
import * as __gh_client_contract from "@thruputchain/client/contract";

const __gh_s = __gh_contract_spec.contractSpecString;

const __gh_entrypoints = {
  NftDropFactory: {
    v0_1: {
      config: __gh_protocol.contractEntrypointID(
        __gh_protocol_utils.fromHex("617f93efab81831f"),
      ),
      createDrop: __gh_protocol.contractEntrypointID(
        __gh_protocol_utils.fromHex("618a86aeba10ebaf"),
      ),
      dropAt: __gh_protocol.contractEntrypointID(
        __gh_protocol_utils.fromHex("709f792dd79ec597"),
      ),
      dropCount: __gh_protocol.contractEntrypointID(
        __gh_protocol_utils.fromHex("a133f4ad95456df7"),
      ),
      initialize: __gh_protocol.contractEntrypointID(
        __gh_protocol_utils.fromHex("ed359ec991d11247"),
      ),
      predictDrop: __gh_protocol.contractEntrypointID(
        __gh_protocol_utils.fromHex("389a9e60a9fa2994"),
      ),
      requiredFunding: __gh_protocol.contractEntrypointID(
        __gh_protocol_utils.fromHex("4a5e8d996bc6defb"),
      ),
    },
  },
} as const;

export namespace nft_drop {
  export namespace v0_1 {
    export namespace implementation {
      export interface DropDefinition {
        name: string;
        symbol: string;
        supply: bigint;
        traits: __gh_codegen.nft_drop$v0_1$implementation$Trait[];
      }

      export interface Trait {
        name: string;
        values: __gh_codegen.nft_drop$v0_1$implementation$TraitValue[];
      }

      export interface TraitValue {
        name: string;
        weight: bigint;
      }
    }
  }
}

export namespace nft_drop_factory {
  export namespace v0_1 {
    export namespace implementation {
      export interface FactoryConfig {
        drop_code_hash: __gh_client_contract.FixedBytes<32>;
        base_funding: bigint;
        funding_per_token: bigint;
      }

      export type FactoryError = 1n | 2n | 3n | 4n;

      export interface DropCreated extends __gh_client_contract.DecodedContractEvent<
        "DropCreated",
        {
          drop: __gh_protocol.ContractAddress;
          creator: __gh_protocol.ContractAddress;
        },
        { index: bigint; supply: bigint }
      > {}

      export interface DropCreatedFilter {
        drop?: __gh_client_contract.ContractEventFilterValue<__gh_protocol.ContractAddress>;
        creator?: __gh_client_contract.ContractEventFilterValue<__gh_protocol.ContractAddress>;
      }
    }
  }
}

export namespace NftDropFactory {
  export namespace v0_1 {
    export type ConfigArgs = void;
    export type ConfigResult =
      __gh_codegen.nft_drop_factory$v0_1$implementation$FactoryConfig;

    export interface CreateDropArgs {
      nonce: __gh_client_contract.FixedBytes<32>;
      definition: __gh_codegen.nft_drop$v0_1$implementation$DropDefinition;
    }
    export type CreateDropResult = __gh_protocol.ContractAddress;

    export interface DropAtArgs {
      index: bigint;
    }
    export type DropAtResult = __gh_protocol.ContractAddress;

    export type DropCountArgs = void;
    export type DropCountResult = bigint;

    export interface InitializeArgs {
      config: __gh_codegen.nft_drop_factory$v0_1$implementation$FactoryConfig;
    }
    export type InitializeResult = void;

    export interface PredictDropArgs {
      creator: __gh_protocol.ContractAddress;
      nonce: __gh_client_contract.FixedBytes<32>;
    }
    export type PredictDropResult = __gh_protocol.ContractAddress;

    export interface RequiredFundingArgs {
      supply: bigint;
    }
    export type RequiredFundingResult = bigint;

    export type DeclaredException = {
      kind: "declared";
      name: "FactoryError";
      selector: 0xb8d3d1c2ee59bfb7n;
      value: __gh_codegen.nft_drop_factory$v0_1$implementation$FactoryError;
    };
    export type Exception =
      __gh_client_contract.ContractException<DeclaredException>;
  }
}

export const spec: __gh_client_contract.ContractSpec = {
  interfaces: [
    {
      name: __gh_s("NftDropFactory"),
      vers: __gh_s("0.1.0"),
      throws: [
        {
          selector: 0xb8d3d1c2ee59bfb7n,
          ty: {
            v: __gh_contract_spec.ContractTypeKind.Named,
            named: {
              crate_name: __gh_s("nft-drop-factory"),
              major: __gh_s("0.1"),
              module_path: __gh_s("nft_drop_factory::implementation"),
              declared: __gh_s("FactoryError"),
            },
          },
        },
      ],
      methods: [
        {
          name: __gh_s("config"),
          args: [],
          return_type: {
            v: __gh_contract_spec.ContractTypeKind.Named,
            named: {
              crate_name: __gh_s("nft-drop-factory"),
              major: __gh_s("0.1"),
              module_path: __gh_s("nft_drop_factory::implementation"),
              declared: __gh_s("FactoryConfig"),
            },
          },
          effect: null,
        },
        {
          name: __gh_s("create_drop"),
          args: [
            {
              name: __gh_s("nonce"),
              ty: {
                v: __gh_contract_spec.ContractTypeKind.Array,
                array: {
                  element: { v: __gh_contract_spec.ContractTypeKind.U8 },
                  len: 32n,
                },
              },
            },
            {
              name: __gh_s("definition"),
              ty: {
                v: __gh_contract_spec.ContractTypeKind.Named,
                named: {
                  crate_name: __gh_s("nft-drop"),
                  major: __gh_s("0.1"),
                  module_path: __gh_s("nft_drop::implementation"),
                  declared: __gh_s("DropDefinition"),
                },
              },
            },
          ],
          return_type: { v: __gh_contract_spec.ContractTypeKind.Address },
          effect: null,
        },
        {
          name: __gh_s("drop_at"),
          args: [
            {
              name: __gh_s("index"),
              ty: { v: __gh_contract_spec.ContractTypeKind.U64 },
            },
          ],
          return_type: { v: __gh_contract_spec.ContractTypeKind.Address },
          effect: null,
        },
        {
          name: __gh_s("drop_count"),
          args: [],
          return_type: { v: __gh_contract_spec.ContractTypeKind.U64 },
          effect: null,
        },
        {
          name: __gh_s("initialize"),
          args: [
            {
              name: __gh_s("config"),
              ty: {
                v: __gh_contract_spec.ContractTypeKind.Named,
                named: {
                  crate_name: __gh_s("nft-drop-factory"),
                  major: __gh_s("0.1"),
                  module_path: __gh_s("nft_drop_factory::implementation"),
                  declared: __gh_s("FactoryConfig"),
                },
              },
            },
          ],
          return_type: { v: __gh_contract_spec.ContractTypeKind.Void },
          effect: null,
        },
        {
          name: __gh_s("predict_drop"),
          args: [
            {
              name: __gh_s("creator"),
              ty: { v: __gh_contract_spec.ContractTypeKind.Address },
            },
            {
              name: __gh_s("nonce"),
              ty: {
                v: __gh_contract_spec.ContractTypeKind.Array,
                array: {
                  element: { v: __gh_contract_spec.ContractTypeKind.U8 },
                  len: 32n,
                },
              },
            },
          ],
          return_type: { v: __gh_contract_spec.ContractTypeKind.Address },
          effect: null,
        },
        {
          name: __gh_s("required_funding"),
          args: [
            {
              name: __gh_s("supply"),
              ty: { v: __gh_contract_spec.ContractTypeKind.U32 },
            },
          ],
          return_type: { v: __gh_contract_spec.ContractTypeKind.I128 },
          effect: null,
        },
      ],
    },
  ],
  type_defs: [
    {
      v: __gh_contract_spec.ContractTypeDefKind.TypeDefStruct,
      struct_def: {
        name: {
          crate_name: __gh_s("nft-drop"),
          major: __gh_s("0.1"),
          module_path: __gh_s("nft_drop::implementation"),
          declared: __gh_s("DropDefinition"),
        },
        fields: [
          {
            name: __gh_s("name"),
            ty: { v: __gh_contract_spec.ContractTypeKind.String },
          },
          {
            name: __gh_s("symbol"),
            ty: { v: __gh_contract_spec.ContractTypeKind.String },
          },
          {
            name: __gh_s("supply"),
            ty: { v: __gh_contract_spec.ContractTypeKind.U32 },
          },
          {
            name: __gh_s("traits"),
            ty: {
              v: __gh_contract_spec.ContractTypeKind.Vector,
              vector: {
                element: {
                  v: __gh_contract_spec.ContractTypeKind.Named,
                  named: {
                    crate_name: __gh_s("nft-drop"),
                    major: __gh_s("0.1"),
                    module_path: __gh_s("nft_drop::implementation"),
                    declared: __gh_s("Trait"),
                  },
                },
                max_len: 6n,
              },
            },
          },
        ],
      },
    },
    {
      v: __gh_contract_spec.ContractTypeDefKind.TypeDefStruct,
      struct_def: {
        name: {
          crate_name: __gh_s("nft-drop"),
          major: __gh_s("0.1"),
          module_path: __gh_s("nft_drop::implementation"),
          declared: __gh_s("Trait"),
        },
        fields: [
          {
            name: __gh_s("name"),
            ty: { v: __gh_contract_spec.ContractTypeKind.String },
          },
          {
            name: __gh_s("values"),
            ty: {
              v: __gh_contract_spec.ContractTypeKind.Vector,
              vector: {
                element: {
                  v: __gh_contract_spec.ContractTypeKind.Named,
                  named: {
                    crate_name: __gh_s("nft-drop"),
                    major: __gh_s("0.1"),
                    module_path: __gh_s("nft_drop::implementation"),
                    declared: __gh_s("TraitValue"),
                  },
                },
                max_len: 8n,
              },
            },
          },
        ],
      },
    },
    {
      v: __gh_contract_spec.ContractTypeDefKind.TypeDefStruct,
      struct_def: {
        name: {
          crate_name: __gh_s("nft-drop"),
          major: __gh_s("0.1"),
          module_path: __gh_s("nft_drop::implementation"),
          declared: __gh_s("TraitValue"),
        },
        fields: [
          {
            name: __gh_s("name"),
            ty: { v: __gh_contract_spec.ContractTypeKind.String },
          },
          {
            name: __gh_s("weight"),
            ty: { v: __gh_contract_spec.ContractTypeKind.U32 },
          },
        ],
      },
    },
    {
      v: __gh_contract_spec.ContractTypeDefKind.TypeDefStruct,
      struct_def: {
        name: {
          crate_name: __gh_s("nft-drop-factory"),
          major: __gh_s("0.1"),
          module_path: __gh_s("nft_drop_factory::implementation"),
          declared: __gh_s("FactoryConfig"),
        },
        fields: [
          {
            name: __gh_s("drop_code_hash"),
            ty: {
              v: __gh_contract_spec.ContractTypeKind.Array,
              array: {
                element: { v: __gh_contract_spec.ContractTypeKind.U8 },
                len: 32n,
              },
            },
          },
          {
            name: __gh_s("base_funding"),
            ty: { v: __gh_contract_spec.ContractTypeKind.I128 },
          },
          {
            name: __gh_s("funding_per_token"),
            ty: { v: __gh_contract_spec.ContractTypeKind.I128 },
          },
        ],
      },
    },
    {
      v: __gh_contract_spec.ContractTypeDefKind.TypeDefEnum,
      enum_def: {
        name: {
          crate_name: __gh_s("nft-drop-factory"),
          major: __gh_s("0.1"),
          module_path: __gh_s("nft_drop_factory::implementation"),
          declared: __gh_s("FactoryError"),
        },
        variants: [
          { name: __gh_s("AlreadyInitialized"), value: 1n },
          { name: __gh_s("InvalidConfig"), value: 2n },
          { name: __gh_s("InsufficientFunding"), value: 3n },
          { name: __gh_s("NotFound"), value: 4n },
        ],
      },
    },
  ],
  events: [
    {
      name: {
        crate_name: __gh_s("nft-drop-factory"),
        major: __gh_s("0.1"),
        module_path: __gh_s("nft_drop_factory::implementation"),
        declared: __gh_s("DropCreated"),
      },
      signature: __gh_protocol.topic(
        __gh_protocol_utils.fromHex(
          "25790963998b3bcfd4a5361f51711b5c8acc07ae1b6d05e8f58b7f5fb29f1638",
        ),
      ),
      topics: [
        {
          name: __gh_s("drop"),
          ty: { v: __gh_contract_spec.ContractTypeKind.Address },
        },
        {
          name: __gh_s("creator"),
          ty: { v: __gh_contract_spec.ContractTypeKind.Address },
        },
      ],
      fields: [
        {
          name: __gh_s("index"),
          ty: { v: __gh_contract_spec.ContractTypeKind.U64 },
        },
        {
          name: __gh_s("supply"),
          ty: { v: __gh_contract_spec.ContractTypeKind.U32 },
        },
      ],
    },
  ],
};

const __gh_codecs = __gh_client_contract.createContractCodecContext(
  spec.type_defs,
);

export const NftDropFactory = {
  v0_1: {
    config: __gh_client_contract.defineContractMethod<
      NftDropFactory.v0_1.ConfigArgs,
      NftDropFactory.v0_1.ConfigResult,
      NftDropFactory.v0_1.DeclaredException
    >({
      interfaceName: "NftDropFactory",
      interfaceVersion: "0.1.0",
      abiName: "config",
      publicName: "config",
      entrypoint: __gh_entrypoints.NftDropFactory.v0_1.config,
      effect: spec.interfaces[0]!.methods[0]!.effect,
      args: [],
      returnType: spec.interfaces[0]!.methods[0]!.return_type,
      throws: [
        {
          selector: 0xb8d3d1c2ee59bfb7n,
          name: "FactoryError",
          type: spec.interfaces[0]!.throws[0]!.ty,
        },
      ],
      codecs: __gh_codecs,
    }),
    createDrop: __gh_client_contract.defineContractMethod<
      NftDropFactory.v0_1.CreateDropArgs,
      NftDropFactory.v0_1.CreateDropResult,
      NftDropFactory.v0_1.DeclaredException
    >({
      interfaceName: "NftDropFactory",
      interfaceVersion: "0.1.0",
      abiName: "create_drop",
      publicName: "createDrop",
      entrypoint: __gh_entrypoints.NftDropFactory.v0_1.createDrop,
      effect: spec.interfaces[0]!.methods[1]!.effect,
      args: [
        {
          abiName: "nonce",
          publicName: "nonce",
          type: spec.interfaces[0]!.methods[1]!.args[0]!.ty,
        },
        {
          abiName: "definition",
          publicName: "definition",
          type: spec.interfaces[0]!.methods[1]!.args[1]!.ty,
        },
      ],
      returnType: spec.interfaces[0]!.methods[1]!.return_type,
      throws: [
        {
          selector: 0xb8d3d1c2ee59bfb7n,
          name: "FactoryError",
          type: spec.interfaces[0]!.throws[0]!.ty,
        },
      ],
      codecs: __gh_codecs,
    }),
    dropAt: __gh_client_contract.defineContractMethod<
      NftDropFactory.v0_1.DropAtArgs,
      NftDropFactory.v0_1.DropAtResult,
      NftDropFactory.v0_1.DeclaredException
    >({
      interfaceName: "NftDropFactory",
      interfaceVersion: "0.1.0",
      abiName: "drop_at",
      publicName: "dropAt",
      entrypoint: __gh_entrypoints.NftDropFactory.v0_1.dropAt,
      effect: spec.interfaces[0]!.methods[2]!.effect,
      args: [
        {
          abiName: "index",
          publicName: "index",
          type: spec.interfaces[0]!.methods[2]!.args[0]!.ty,
        },
      ],
      returnType: spec.interfaces[0]!.methods[2]!.return_type,
      throws: [
        {
          selector: 0xb8d3d1c2ee59bfb7n,
          name: "FactoryError",
          type: spec.interfaces[0]!.throws[0]!.ty,
        },
      ],
      codecs: __gh_codecs,
    }),
    dropCount: __gh_client_contract.defineContractMethod<
      NftDropFactory.v0_1.DropCountArgs,
      NftDropFactory.v0_1.DropCountResult,
      NftDropFactory.v0_1.DeclaredException
    >({
      interfaceName: "NftDropFactory",
      interfaceVersion: "0.1.0",
      abiName: "drop_count",
      publicName: "dropCount",
      entrypoint: __gh_entrypoints.NftDropFactory.v0_1.dropCount,
      effect: spec.interfaces[0]!.methods[3]!.effect,
      args: [],
      returnType: spec.interfaces[0]!.methods[3]!.return_type,
      throws: [
        {
          selector: 0xb8d3d1c2ee59bfb7n,
          name: "FactoryError",
          type: spec.interfaces[0]!.throws[0]!.ty,
        },
      ],
      codecs: __gh_codecs,
    }),
    initialize: __gh_client_contract.defineContractMethod<
      NftDropFactory.v0_1.InitializeArgs,
      NftDropFactory.v0_1.InitializeResult,
      NftDropFactory.v0_1.DeclaredException
    >({
      interfaceName: "NftDropFactory",
      interfaceVersion: "0.1.0",
      abiName: "initialize",
      publicName: "initialize",
      entrypoint: __gh_entrypoints.NftDropFactory.v0_1.initialize,
      effect: spec.interfaces[0]!.methods[4]!.effect,
      args: [
        {
          abiName: "config",
          publicName: "config",
          type: spec.interfaces[0]!.methods[4]!.args[0]!.ty,
        },
      ],
      returnType: spec.interfaces[0]!.methods[4]!.return_type,
      throws: [
        {
          selector: 0xb8d3d1c2ee59bfb7n,
          name: "FactoryError",
          type: spec.interfaces[0]!.throws[0]!.ty,
        },
      ],
      codecs: __gh_codecs,
    }),
    predictDrop: __gh_client_contract.defineContractMethod<
      NftDropFactory.v0_1.PredictDropArgs,
      NftDropFactory.v0_1.PredictDropResult,
      NftDropFactory.v0_1.DeclaredException
    >({
      interfaceName: "NftDropFactory",
      interfaceVersion: "0.1.0",
      abiName: "predict_drop",
      publicName: "predictDrop",
      entrypoint: __gh_entrypoints.NftDropFactory.v0_1.predictDrop,
      effect: spec.interfaces[0]!.methods[5]!.effect,
      args: [
        {
          abiName: "creator",
          publicName: "creator",
          type: spec.interfaces[0]!.methods[5]!.args[0]!.ty,
        },
        {
          abiName: "nonce",
          publicName: "nonce",
          type: spec.interfaces[0]!.methods[5]!.args[1]!.ty,
        },
      ],
      returnType: spec.interfaces[0]!.methods[5]!.return_type,
      throws: [
        {
          selector: 0xb8d3d1c2ee59bfb7n,
          name: "FactoryError",
          type: spec.interfaces[0]!.throws[0]!.ty,
        },
      ],
      codecs: __gh_codecs,
    }),
    requiredFunding: __gh_client_contract.defineContractMethod<
      NftDropFactory.v0_1.RequiredFundingArgs,
      NftDropFactory.v0_1.RequiredFundingResult,
      NftDropFactory.v0_1.DeclaredException
    >({
      interfaceName: "NftDropFactory",
      interfaceVersion: "0.1.0",
      abiName: "required_funding",
      publicName: "requiredFunding",
      entrypoint: __gh_entrypoints.NftDropFactory.v0_1.requiredFunding,
      effect: spec.interfaces[0]!.methods[6]!.effect,
      args: [
        {
          abiName: "supply",
          publicName: "supply",
          type: spec.interfaces[0]!.methods[6]!.args[0]!.ty,
        },
      ],
      returnType: spec.interfaces[0]!.methods[6]!.return_type,
      throws: [
        {
          selector: 0xb8d3d1c2ee59bfb7n,
          name: "FactoryError",
          type: spec.interfaces[0]!.throws[0]!.ty,
        },
      ],
      codecs: __gh_codecs,
    }),
  },
} as const;

export const nft_drop_factory = {
  v0_1: {
    implementation: {
      DropCreated: __gh_client_contract.defineContractEvent<
        "DropCreated",
        nft_drop_factory.v0_1.implementation.DropCreated["topics"],
        nft_drop_factory.v0_1.implementation.DropCreated["fields"],
        nft_drop_factory.v0_1.implementation.DropCreatedFilter
      >({
        name: "DropCreated",
        signature: spec.events[0]!.signature,
        topics: [
          {
            name: "drop",
            type: spec.events[0]!.topics[0]!.ty,
            representation: "address",
          },
          {
            name: "creator",
            type: spec.events[0]!.topics[1]!.ty,
            representation: "address",
          },
        ],
        fields: [
          { name: "index", type: spec.events[0]!.fields[0]!.ty },
          { name: "supply", type: spec.events[0]!.fields[1]!.ty },
        ],
        codecs: __gh_codecs,
      }),
      FactoryError: {
        AlreadyInitialized: 1n,
        InvalidConfig: 2n,
        InsufficientFunding: 3n,
        NotFound: 4n,
      },
    },
  },
} as const;

export type NftDropFactoryEvent =
  nft_drop_factory.v0_1.implementation.DropCreated;

export function decodeEvent(__gh_event: {
  topics: globalThis.Uint8Array[];
  data: globalThis.Uint8Array;
}): NftDropFactoryEvent | null {
  return nft_drop_factory.v0_1.implementation.DropCreated.decode(__gh_event);
}

// The types the namespaces above refer to, under names no declaration can capture.
export namespace __gh_codegen {
  export type nft_drop$v0_1$implementation$DropDefinition =
    nft_drop.v0_1.implementation.DropDefinition;
  export type nft_drop$v0_1$implementation$Trait =
    nft_drop.v0_1.implementation.Trait;
  export type nft_drop$v0_1$implementation$TraitValue =
    nft_drop.v0_1.implementation.TraitValue;
  export type nft_drop_factory$v0_1$implementation$FactoryConfig =
    nft_drop_factory.v0_1.implementation.FactoryConfig;
  export type nft_drop_factory$v0_1$implementation$FactoryError =
    nft_drop_factory.v0_1.implementation.FactoryError;
}
