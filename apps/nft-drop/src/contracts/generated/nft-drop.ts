// Generated from nft_drop.spec.xdr - ERC165 interface v0.1.77
// Generated from nft_drop.spec.xdr - ERC721 interface v0.1.77
// Generated from nft_drop.spec.xdr - ERC721Metadata interface v0.1.77
// Generated from nft_drop.spec.xdr - NftDrop interface v0.1.0
// DO NOT EDIT. Re-run codegen to update.

import * as __gh_protocol from "@thruputchain/protocol";
import * as __gh_protocol_utils from "@thruputchain/protocol/utils";
import * as __gh_contract_spec from "@thruputchain/contract-spec";
import * as __gh_client_contract from "@thruputchain/client/contract";

const __gh_s = __gh_contract_spec.contractSpecString;

const __gh_entrypoints = {
  ERC165: {
    v0_1: {
      supportsInterface: __gh_protocol.contractEntrypointID(
        __gh_protocol_utils.fromHex("3acd1b20356d25f2"),
      ),
      supportsInterfaces: __gh_protocol.contractEntrypointID(
        __gh_protocol_utils.fromHex("3b573c6d1ab175c0"),
      ),
    },
  },
  ERC721: {
    v0_1: {
      approve: __gh_protocol.contractEntrypointID(
        __gh_protocol_utils.fromHex("cc24e01c1b697d48"),
      ),
      balanceOf: __gh_protocol.contractEntrypointID(
        __gh_protocol_utils.fromHex("1b65a9a60cdb9603"),
      ),
      getApproved: __gh_protocol.contractEntrypointID(
        __gh_protocol_utils.fromHex("495cbd0db39d21d3"),
      ),
      isApprovedForAll: __gh_protocol.contractEntrypointID(
        __gh_protocol_utils.fromHex("78da52fcdb2f3807"),
      ),
      ownerOf: __gh_protocol.contractEntrypointID(
        __gh_protocol_utils.fromHex("9170f43fdc2fafad"),
      ),
      safeTransferFrom: __gh_protocol.contractEntrypointID(
        __gh_protocol_utils.fromHex("e9ebaebcaea5637c"),
      ),
      setApprovalForAll: __gh_protocol.contractEntrypointID(
        __gh_protocol_utils.fromHex("8ffa0d8f3425f3b0"),
      ),
      transferFrom: __gh_protocol.contractEntrypointID(
        __gh_protocol_utils.fromHex("9190784266f9f05a"),
      ),
    },
  },
  ERC721Metadata: {
    v0_1: {
      name: __gh_protocol.contractEntrypointID(
        __gh_protocol_utils.fromHex("df07445c769b77ad"),
      ),
      symbol: __gh_protocol.contractEntrypointID(
        __gh_protocol_utils.fromHex("19ed75f9f22cf132"),
      ),
      tokenMetadata: __gh_protocol.contractEntrypointID(
        __gh_protocol_utils.fromHex("172528fd496e6555"),
      ),
      tokenUri: __gh_protocol.contractEntrypointID(
        __gh_protocol_utils.fromHex("4eb5d1e4106174d5"),
      ),
    },
  },
  NftDrop: {
    v0_1: {
      getConfig: __gh_protocol.contractEntrypointID(
        __gh_protocol_utils.fromHex("1e2532826633af7d"),
      ),
      getTrait: __gh_protocol.contractEntrypointID(
        __gh_protocol_utils.fromHex("8f9f74aa1c8647c9"),
      ),
      initialize: __gh_protocol.contractEntrypointID(
        __gh_protocol_utils.fromHex("00404da8f60c5b25"),
      ),
      mint: __gh_protocol.contractEntrypointID(
        __gh_protocol_utils.fromHex("9e30e5105195e023"),
      ),
      remaining: __gh_protocol.contractEntrypointID(
        __gh_protocol_utils.fromHex("498ef11737e1cb99"),
      ),
      traitCount: __gh_protocol.contractEntrypointID(
        __gh_protocol_utils.fromHex("fb90787f0dfb54e5"),
      ),
      traitsOf: __gh_protocol.contractEntrypointID(
        __gh_protocol_utils.fromHex("c7d10dacfde9a46b"),
      ),
    },
  },
} as const;

export namespace nft_drop {
  export namespace v0_1 {
    export namespace implementation {
      export interface DropConfig {
        creator: __gh_protocol.ContractAddress;
        name: string;
        symbol: string;
        supply: bigint;
        trait_count: bigint;
      }

      export interface DropDefinition {
        name: string;
        symbol: string;
        supply: bigint;
        traits: __gh_codegen.nft_drop$v0_1$implementation$Trait[];
      }

      export type DropError = 1n | 2n | 3n;

      export interface Trait {
        name: string;
        values: __gh_codegen.nft_drop$v0_1$implementation$TraitValue[];
      }

      export interface TraitValue {
        name: string;
        weight: bigint;
      }

      export interface TraitsRolled extends __gh_client_contract.DecodedContractEvent<
        "TraitsRolled",
        { owner: __gh_protocol.ContractAddress },
        {
          token_id: __gh_client_contract.FixedBytes<32>;
          traits: globalThis.Uint8Array;
        }
      > {}

      export interface TraitsRolledFilter {
        owner?: __gh_client_contract.ContractEventFilterValue<__gh_protocol.ContractAddress>;
      }
    }
  }
}

export namespace thruput_erc721_if {
  export namespace v0_1 {
    export interface OnchainMetadata {
      name: string;
      description: string;
      image: string;
    }

    export type TokenMetadata =
      | { case: "Uri"; value: readonly [string] }
      | {
          case: "Onchain";
          value: readonly [__gh_codegen.thruput_erc721_if$v0_1$OnchainMetadata];
        };

    export namespace error {
      export type ERC721Error = 1n | 2n | 3n | 4n | 5n | 6n;
    }

    export namespace events {
      export interface ApprovalEvent extends __gh_client_contract.DecodedContractEvent<
        "ApprovalEvent",
        {
          owner: __gh_protocol.ContractAddress;
          approved: __gh_protocol.ContractAddress;
        },
        { token_id: __gh_client_contract.FixedBytes<32> }
      > {}

      export interface ApprovalEventFilter {
        owner?: __gh_client_contract.ContractEventFilterValue<__gh_protocol.ContractAddress>;
        approved?: __gh_client_contract.ContractEventFilterValue<__gh_protocol.ContractAddress>;
      }

      export interface ApprovalForAllEvent extends __gh_client_contract.DecodedContractEvent<
        "ApprovalForAllEvent",
        {
          owner: __gh_protocol.ContractAddress;
          operator: __gh_protocol.ContractAddress;
        },
        { approved: boolean }
      > {}

      export interface ApprovalForAllEventFilter {
        owner?: __gh_client_contract.ContractEventFilterValue<__gh_protocol.ContractAddress>;
        operator?: __gh_client_contract.ContractEventFilterValue<__gh_protocol.ContractAddress>;
      }

      export interface BurnEvent extends __gh_client_contract.DecodedContractEvent<
        "BurnEvent",
        { from: __gh_protocol.ContractAddress },
        { token_id: __gh_client_contract.FixedBytes<32> }
      > {}

      export interface BurnEventFilter {
        from?: __gh_client_contract.ContractEventFilterValue<__gh_protocol.ContractAddress>;
      }

      export interface MintEvent extends __gh_client_contract.DecodedContractEvent<
        "MintEvent",
        { to: __gh_protocol.ContractAddress },
        { token_id: __gh_client_contract.FixedBytes<32> }
      > {}

      export interface MintEventFilter {
        to?: __gh_client_contract.ContractEventFilterValue<__gh_protocol.ContractAddress>;
      }

      export interface TransferEvent extends __gh_client_contract.DecodedContractEvent<
        "TransferEvent",
        {
          from: __gh_protocol.ContractAddress;
          to: __gh_protocol.ContractAddress;
        },
        { token_id: __gh_client_contract.FixedBytes<32> }
      > {}

      export interface TransferEventFilter {
        from?: __gh_client_contract.ContractEventFilterValue<__gh_protocol.ContractAddress>;
        to?: __gh_client_contract.ContractEventFilterValue<__gh_protocol.ContractAddress>;
      }
    }
  }
}

export namespace ERC165 {
  export namespace v0_1 {
    export interface SupportsInterfaceArgs {
      interfaceId: __gh_client_contract.FixedBytes<8>;
    }
    export type SupportsInterfaceResult = boolean;

    export interface SupportsInterfacesArgs {
      interfaceIds: __gh_client_contract.FixedBytes<8>[];
    }
    export type SupportsInterfacesResult = boolean[];

    export type DeclaredException = never;
    export type Exception =
      __gh_client_contract.ContractException<DeclaredException>;
  }
}

export namespace ERC721 {
  export namespace v0_1 {
    export interface ApproveArgs {
      to: __gh_protocol.ContractAddress;
      tokenId: __gh_client_contract.FixedBytes<32>;
    }
    export type ApproveResult = void;

    export interface BalanceOfArgs {
      owner: __gh_protocol.ContractAddress;
    }
    export type BalanceOfResult = bigint;

    export interface GetApprovedArgs {
      tokenId: __gh_client_contract.FixedBytes<32>;
    }
    export type GetApprovedResult = __gh_protocol.ContractAddress;

    export interface IsApprovedForAllArgs {
      owner: __gh_protocol.ContractAddress;
      operator: __gh_protocol.ContractAddress;
    }
    export type IsApprovedForAllResult = boolean;

    export interface OwnerOfArgs {
      tokenId: __gh_client_contract.FixedBytes<32>;
    }
    export type OwnerOfResult = __gh_protocol.ContractAddress;

    export interface SafeTransferFromArgs {
      from: __gh_protocol.ContractAddress;
      to: __gh_protocol.ContractAddress;
      tokenId: __gh_client_contract.FixedBytes<32>;
      data: globalThis.Uint8Array;
    }
    export type SafeTransferFromResult = void;

    export interface SetApprovalForAllArgs {
      operator: __gh_protocol.ContractAddress;
      approved: boolean;
    }
    export type SetApprovalForAllResult = void;

    export interface TransferFromArgs {
      from: __gh_protocol.ContractAddress;
      to: __gh_protocol.ContractAddress;
      tokenId: __gh_client_contract.FixedBytes<32>;
    }
    export type TransferFromResult = void;

    export type DeclaredException = {
      kind: "declared";
      name: "ERC721Error";
      selector: 0xd7c47adee89f0597n;
      value: __gh_codegen.thruput_erc721_if$v0_1$error$ERC721Error;
    };
    export type Exception =
      __gh_client_contract.ContractException<DeclaredException>;
  }
}

export namespace ERC721Metadata {
  export namespace v0_1 {
    export type NameArgs = void;
    export type NameResult = string;

    export type SymbolArgs = void;
    export type SymbolResult = string;

    export interface TokenMetadataArgs {
      tokenId: __gh_client_contract.FixedBytes<32>;
    }
    export type TokenMetadataResult =
      __gh_codegen.thruput_erc721_if$v0_1$TokenMetadata;

    export interface TokenUriArgs {
      tokenId: __gh_client_contract.FixedBytes<32>;
    }
    export type TokenUriResult = string;

    export type DeclaredException = {
      kind: "declared";
      name: "ERC721Error";
      selector: 0xd7c47adee89f0597n;
      value: __gh_codegen.thruput_erc721_if$v0_1$error$ERC721Error;
    };
    export type Exception =
      __gh_client_contract.ContractException<DeclaredException>;
  }
}

export namespace NftDrop {
  export namespace v0_1 {
    export type GetConfigArgs = void;
    export type GetConfigResult =
      __gh_codegen.nft_drop$v0_1$implementation$DropConfig;

    export interface GetTraitArgs {
      index: bigint;
    }
    export type GetTraitResult =
      __gh_codegen.nft_drop$v0_1$implementation$Trait;

    export interface InitializeArgs {
      creator: __gh_protocol.ContractAddress;
      definition: __gh_codegen.nft_drop$v0_1$implementation$DropDefinition;
    }
    export type InitializeResult = void;

    export type MintArgs = void;
    export type MintResult = __gh_client_contract.FixedBytes<32>;

    export type RemainingArgs = void;
    export type RemainingResult = bigint;

    export interface TraitCountArgs {
      index: bigint;
      value: bigint;
    }
    export type TraitCountResult = bigint;

    export interface TraitsOfArgs {
      tokenId: __gh_client_contract.FixedBytes<32>;
    }
    export type TraitsOfResult = globalThis.Uint8Array;

    export type DeclaredException =
      | {
          kind: "declared";
          name: "DropError";
          selector: 0x2902708a7cd962abn;
          value: __gh_codegen.nft_drop$v0_1$implementation$DropError;
        }
      | {
          kind: "declared";
          name: "ERC721Error";
          selector: 0xd7c47adee89f0597n;
          value: __gh_codegen.thruput_erc721_if$v0_1$error$ERC721Error;
        };
    export type Exception =
      __gh_client_contract.ContractException<DeclaredException>;
  }
}

export const spec: __gh_client_contract.ContractSpec = {
  interfaces: [
    {
      name: __gh_s("ERC165"),
      vers: __gh_s("0.1.77"),
      throws: [],
      methods: [
        {
          name: __gh_s("supports_interface"),
          args: [
            {
              name: __gh_s("interface_id"),
              ty: {
                v: __gh_contract_spec.ContractTypeKind.Array,
                array: {
                  element: { v: __gh_contract_spec.ContractTypeKind.U8 },
                  len: 8n,
                },
              },
            },
          ],
          return_type: { v: __gh_contract_spec.ContractTypeKind.Bool },
          effect: null,
        },
        {
          name: __gh_s("supports_interfaces"),
          args: [
            {
              name: __gh_s("interface_ids"),
              ty: {
                v: __gh_contract_spec.ContractTypeKind.Vector,
                vector: {
                  element: {
                    v: __gh_contract_spec.ContractTypeKind.Array,
                    array: {
                      element: { v: __gh_contract_spec.ContractTypeKind.U8 },
                      len: 8n,
                    },
                  },
                  max_len: 32n,
                },
              },
            },
          ],
          return_type: {
            v: __gh_contract_spec.ContractTypeKind.Vector,
            vector: {
              element: { v: __gh_contract_spec.ContractTypeKind.Bool },
              max_len: 32n,
            },
          },
          effect: null,
        },
      ],
    },
    {
      name: __gh_s("ERC721"),
      vers: __gh_s("0.1.77"),
      throws: [
        {
          selector: 0xd7c47adee89f0597n,
          ty: {
            v: __gh_contract_spec.ContractTypeKind.Named,
            named: {
              crate_name: __gh_s("thruput-erc721-if"),
              major: __gh_s("0.1"),
              module_path: __gh_s("thruput_erc721_if::error"),
              declared: __gh_s("ERC721Error"),
            },
          },
        },
      ],
      methods: [
        {
          name: __gh_s("approve"),
          args: [
            {
              name: __gh_s("to"),
              ty: { v: __gh_contract_spec.ContractTypeKind.Address },
            },
            {
              name: __gh_s("token_id"),
              ty: {
                v: __gh_contract_spec.ContractTypeKind.Array,
                array: {
                  element: { v: __gh_contract_spec.ContractTypeKind.U8 },
                  len: 32n,
                },
              },
            },
          ],
          return_type: { v: __gh_contract_spec.ContractTypeKind.Void },
          effect: null,
        },
        {
          name: __gh_s("balance_of"),
          args: [
            {
              name: __gh_s("owner"),
              ty: { v: __gh_contract_spec.ContractTypeKind.Address },
            },
          ],
          return_type: { v: __gh_contract_spec.ContractTypeKind.U64 },
          effect: null,
        },
        {
          name: __gh_s("get_approved"),
          args: [
            {
              name: __gh_s("token_id"),
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
          name: __gh_s("is_approved_for_all"),
          args: [
            {
              name: __gh_s("owner"),
              ty: { v: __gh_contract_spec.ContractTypeKind.Address },
            },
            {
              name: __gh_s("operator"),
              ty: { v: __gh_contract_spec.ContractTypeKind.Address },
            },
          ],
          return_type: { v: __gh_contract_spec.ContractTypeKind.Bool },
          effect: null,
        },
        {
          name: __gh_s("owner_of"),
          args: [
            {
              name: __gh_s("token_id"),
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
          name: __gh_s("safe_transfer_from"),
          args: [
            {
              name: __gh_s("from"),
              ty: { v: __gh_contract_spec.ContractTypeKind.Address },
            },
            {
              name: __gh_s("to"),
              ty: { v: __gh_contract_spec.ContractTypeKind.Address },
            },
            {
              name: __gh_s("token_id"),
              ty: {
                v: __gh_contract_spec.ContractTypeKind.Array,
                array: {
                  element: { v: __gh_contract_spec.ContractTypeKind.U8 },
                  len: 32n,
                },
              },
            },
            {
              name: __gh_s("data"),
              ty: {
                v: __gh_contract_spec.ContractTypeKind.Vector,
                vector: {
                  element: { v: __gh_contract_spec.ContractTypeKind.U8 },
                  max_len: 256n,
                },
              },
            },
          ],
          return_type: { v: __gh_contract_spec.ContractTypeKind.Void },
          effect: null,
        },
        {
          name: __gh_s("set_approval_for_all"),
          args: [
            {
              name: __gh_s("operator"),
              ty: { v: __gh_contract_spec.ContractTypeKind.Address },
            },
            {
              name: __gh_s("approved"),
              ty: { v: __gh_contract_spec.ContractTypeKind.Bool },
            },
          ],
          return_type: { v: __gh_contract_spec.ContractTypeKind.Void },
          effect: null,
        },
        {
          name: __gh_s("transfer_from"),
          args: [
            {
              name: __gh_s("from"),
              ty: { v: __gh_contract_spec.ContractTypeKind.Address },
            },
            {
              name: __gh_s("to"),
              ty: { v: __gh_contract_spec.ContractTypeKind.Address },
            },
            {
              name: __gh_s("token_id"),
              ty: {
                v: __gh_contract_spec.ContractTypeKind.Array,
                array: {
                  element: { v: __gh_contract_spec.ContractTypeKind.U8 },
                  len: 32n,
                },
              },
            },
          ],
          return_type: { v: __gh_contract_spec.ContractTypeKind.Void },
          effect: null,
        },
      ],
    },
    {
      name: __gh_s("ERC721Metadata"),
      vers: __gh_s("0.1.77"),
      throws: [
        {
          selector: 0xd7c47adee89f0597n,
          ty: {
            v: __gh_contract_spec.ContractTypeKind.Named,
            named: {
              crate_name: __gh_s("thruput-erc721-if"),
              major: __gh_s("0.1"),
              module_path: __gh_s("thruput_erc721_if::error"),
              declared: __gh_s("ERC721Error"),
            },
          },
        },
      ],
      methods: [
        {
          name: __gh_s("name"),
          args: [],
          return_type: { v: __gh_contract_spec.ContractTypeKind.String },
          effect: null,
        },
        {
          name: __gh_s("symbol"),
          args: [],
          return_type: { v: __gh_contract_spec.ContractTypeKind.String },
          effect: null,
        },
        {
          name: __gh_s("token_metadata"),
          args: [
            {
              name: __gh_s("token_id"),
              ty: {
                v: __gh_contract_spec.ContractTypeKind.Array,
                array: {
                  element: { v: __gh_contract_spec.ContractTypeKind.U8 },
                  len: 32n,
                },
              },
            },
          ],
          return_type: {
            v: __gh_contract_spec.ContractTypeKind.Named,
            named: {
              crate_name: __gh_s("thruput-erc721-if"),
              major: __gh_s("0.1"),
              module_path: __gh_s("thruput_erc721_if"),
              declared: __gh_s("TokenMetadata"),
            },
          },
          effect: null,
        },
        {
          name: __gh_s("token_uri"),
          args: [
            {
              name: __gh_s("token_id"),
              ty: {
                v: __gh_contract_spec.ContractTypeKind.Array,
                array: {
                  element: { v: __gh_contract_spec.ContractTypeKind.U8 },
                  len: 32n,
                },
              },
            },
          ],
          return_type: { v: __gh_contract_spec.ContractTypeKind.String },
          effect: null,
        },
      ],
    },
    {
      name: __gh_s("NftDrop"),
      vers: __gh_s("0.1.0"),
      throws: [
        {
          selector: 0x2902708a7cd962abn,
          ty: {
            v: __gh_contract_spec.ContractTypeKind.Named,
            named: {
              crate_name: __gh_s("nft-drop"),
              major: __gh_s("0.1"),
              module_path: __gh_s("nft_drop::implementation"),
              declared: __gh_s("DropError"),
            },
          },
        },
        {
          selector: 0xd7c47adee89f0597n,
          ty: {
            v: __gh_contract_spec.ContractTypeKind.Named,
            named: {
              crate_name: __gh_s("thruput-erc721-if"),
              major: __gh_s("0.1"),
              module_path: __gh_s("thruput_erc721_if::error"),
              declared: __gh_s("ERC721Error"),
            },
          },
        },
      ],
      methods: [
        {
          name: __gh_s("get_config"),
          args: [],
          return_type: {
            v: __gh_contract_spec.ContractTypeKind.Named,
            named: {
              crate_name: __gh_s("nft-drop"),
              major: __gh_s("0.1"),
              module_path: __gh_s("nft_drop::implementation"),
              declared: __gh_s("DropConfig"),
            },
          },
          effect: null,
        },
        {
          name: __gh_s("get_trait"),
          args: [
            {
              name: __gh_s("index"),
              ty: { v: __gh_contract_spec.ContractTypeKind.U32 },
            },
          ],
          return_type: {
            v: __gh_contract_spec.ContractTypeKind.Named,
            named: {
              crate_name: __gh_s("nft-drop"),
              major: __gh_s("0.1"),
              module_path: __gh_s("nft_drop::implementation"),
              declared: __gh_s("Trait"),
            },
          },
          effect: null,
        },
        {
          name: __gh_s("initialize"),
          args: [
            {
              name: __gh_s("creator"),
              ty: { v: __gh_contract_spec.ContractTypeKind.Address },
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
          return_type: { v: __gh_contract_spec.ContractTypeKind.Void },
          effect: null,
        },
        {
          name: __gh_s("mint"),
          args: [],
          return_type: {
            v: __gh_contract_spec.ContractTypeKind.Array,
            array: {
              element: { v: __gh_contract_spec.ContractTypeKind.U8 },
              len: 32n,
            },
          },
          effect: null,
        },
        {
          name: __gh_s("remaining"),
          args: [],
          return_type: { v: __gh_contract_spec.ContractTypeKind.U32 },
          effect: null,
        },
        {
          name: __gh_s("trait_count"),
          args: [
            {
              name: __gh_s("index"),
              ty: { v: __gh_contract_spec.ContractTypeKind.U32 },
            },
            {
              name: __gh_s("value"),
              ty: { v: __gh_contract_spec.ContractTypeKind.U32 },
            },
          ],
          return_type: { v: __gh_contract_spec.ContractTypeKind.U32 },
          effect: null,
        },
        {
          name: __gh_s("traits_of"),
          args: [
            {
              name: __gh_s("token_id"),
              ty: {
                v: __gh_contract_spec.ContractTypeKind.Array,
                array: {
                  element: { v: __gh_contract_spec.ContractTypeKind.U8 },
                  len: 32n,
                },
              },
            },
          ],
          return_type: {
            v: __gh_contract_spec.ContractTypeKind.Vector,
            vector: {
              element: { v: __gh_contract_spec.ContractTypeKind.U8 },
              max_len: 6n,
            },
          },
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
          declared: __gh_s("DropConfig"),
        },
        fields: [
          {
            name: __gh_s("creator"),
            ty: { v: __gh_contract_spec.ContractTypeKind.Address },
          },
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
            name: __gh_s("trait_count"),
            ty: { v: __gh_contract_spec.ContractTypeKind.U32 },
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
      v: __gh_contract_spec.ContractTypeDefKind.TypeDefEnum,
      enum_def: {
        name: {
          crate_name: __gh_s("nft-drop"),
          major: __gh_s("0.1"),
          module_path: __gh_s("nft_drop::implementation"),
          declared: __gh_s("DropError"),
        },
        variants: [
          { name: __gh_s("AlreadyInitialized"), value: 1n },
          { name: __gh_s("InvalidDefinition"), value: 2n },
          { name: __gh_s("SoldOut"), value: 3n },
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
          crate_name: __gh_s("thruput-erc721-if"),
          major: __gh_s("0.1"),
          module_path: __gh_s("thruput_erc721_if"),
          declared: __gh_s("OnchainMetadata"),
        },
        fields: [
          {
            name: __gh_s("name"),
            ty: { v: __gh_contract_spec.ContractTypeKind.String },
          },
          {
            name: __gh_s("description"),
            ty: { v: __gh_contract_spec.ContractTypeKind.String },
          },
          {
            name: __gh_s("image"),
            ty: { v: __gh_contract_spec.ContractTypeKind.String },
          },
        ],
      },
    },
    {
      v: __gh_contract_spec.ContractTypeDefKind.TypeDefUnion,
      union_def: {
        name: {
          crate_name: __gh_s("thruput-erc721-if"),
          major: __gh_s("0.1"),
          module_path: __gh_s("thruput_erc721_if"),
          declared: __gh_s("TokenMetadata"),
        },
        cases: [
          {
            name: __gh_s("Uri"),
            discriminant: 1n,
            case_type: {
              v: __gh_contract_spec.ContractUnionCaseKind.UnionCaseTuple,
              tuple: [{ v: __gh_contract_spec.ContractTypeKind.String }],
            },
          },
          {
            name: __gh_s("Onchain"),
            discriminant: 2n,
            case_type: {
              v: __gh_contract_spec.ContractUnionCaseKind.UnionCaseTuple,
              tuple: [
                {
                  v: __gh_contract_spec.ContractTypeKind.Named,
                  named: {
                    crate_name: __gh_s("thruput-erc721-if"),
                    major: __gh_s("0.1"),
                    module_path: __gh_s("thruput_erc721_if"),
                    declared: __gh_s("OnchainMetadata"),
                  },
                },
              ],
            },
          },
        ],
      },
    },
    {
      v: __gh_contract_spec.ContractTypeDefKind.TypeDefEnum,
      enum_def: {
        name: {
          crate_name: __gh_s("thruput-erc721-if"),
          major: __gh_s("0.1"),
          module_path: __gh_s("thruput_erc721_if::error"),
          declared: __gh_s("ERC721Error"),
        },
        variants: [
          { name: __gh_s("NonexistentToken"), value: 1n },
          { name: __gh_s("IncorrectOwner"), value: 2n },
          { name: __gh_s("InvalidReceiver"), value: 3n },
          { name: __gh_s("InsufficientApproval"), value: 4n },
          { name: __gh_s("InvalidApprover"), value: 5n },
          { name: __gh_s("NoTokenUri"), value: 6n },
        ],
      },
    },
  ],
  events: [
    {
      name: {
        crate_name: __gh_s("nft-drop"),
        major: __gh_s("0.1"),
        module_path: __gh_s("nft_drop::implementation"),
        declared: __gh_s("TraitsRolled"),
      },
      signature: __gh_protocol.topic(
        __gh_protocol_utils.fromHex(
          "f21926d6423d1786bf0825130c6b67f3968d8a695bad9331c1f54fcc6cd1e0da",
        ),
      ),
      topics: [
        {
          name: __gh_s("owner"),
          ty: { v: __gh_contract_spec.ContractTypeKind.Address },
        },
      ],
      fields: [
        {
          name: __gh_s("token_id"),
          ty: {
            v: __gh_contract_spec.ContractTypeKind.Array,
            array: {
              element: { v: __gh_contract_spec.ContractTypeKind.U8 },
              len: 32n,
            },
          },
        },
        {
          name: __gh_s("traits"),
          ty: {
            v: __gh_contract_spec.ContractTypeKind.Vector,
            vector: {
              element: { v: __gh_contract_spec.ContractTypeKind.U8 },
              max_len: 6n,
            },
          },
        },
      ],
    },
    {
      name: {
        crate_name: __gh_s("thruput-erc721-if"),
        major: __gh_s("0.1"),
        module_path: __gh_s("thruput_erc721_if::events"),
        declared: __gh_s("ApprovalEvent"),
      },
      signature: __gh_protocol.topic(
        __gh_protocol_utils.fromHex(
          "f30da8183f1742a9f0c376108079d19c55b7ff3089eb128eaf951b81cdaa5aae",
        ),
      ),
      topics: [
        {
          name: __gh_s("owner"),
          ty: { v: __gh_contract_spec.ContractTypeKind.Address },
        },
        {
          name: __gh_s("approved"),
          ty: { v: __gh_contract_spec.ContractTypeKind.Address },
        },
      ],
      fields: [
        {
          name: __gh_s("token_id"),
          ty: {
            v: __gh_contract_spec.ContractTypeKind.Array,
            array: {
              element: { v: __gh_contract_spec.ContractTypeKind.U8 },
              len: 32n,
            },
          },
        },
      ],
    },
    {
      name: {
        crate_name: __gh_s("thruput-erc721-if"),
        major: __gh_s("0.1"),
        module_path: __gh_s("thruput_erc721_if::events"),
        declared: __gh_s("ApprovalForAllEvent"),
      },
      signature: __gh_protocol.topic(
        __gh_protocol_utils.fromHex(
          "bcd47086a18e968bafea0d925a875857b659e8f28a930e5b35dfa0f3067c9041",
        ),
      ),
      topics: [
        {
          name: __gh_s("owner"),
          ty: { v: __gh_contract_spec.ContractTypeKind.Address },
        },
        {
          name: __gh_s("operator"),
          ty: { v: __gh_contract_spec.ContractTypeKind.Address },
        },
      ],
      fields: [
        {
          name: __gh_s("approved"),
          ty: { v: __gh_contract_spec.ContractTypeKind.Bool },
        },
      ],
    },
    {
      name: {
        crate_name: __gh_s("thruput-erc721-if"),
        major: __gh_s("0.1"),
        module_path: __gh_s("thruput_erc721_if::events"),
        declared: __gh_s("BurnEvent"),
      },
      signature: __gh_protocol.topic(
        __gh_protocol_utils.fromHex(
          "1b7285b9723bf05f5a613d4f51fd4359ee2a643564341604ed7fe74f398e15dc",
        ),
      ),
      topics: [
        {
          name: __gh_s("from"),
          ty: { v: __gh_contract_spec.ContractTypeKind.Address },
        },
      ],
      fields: [
        {
          name: __gh_s("token_id"),
          ty: {
            v: __gh_contract_spec.ContractTypeKind.Array,
            array: {
              element: { v: __gh_contract_spec.ContractTypeKind.U8 },
              len: 32n,
            },
          },
        },
      ],
    },
    {
      name: {
        crate_name: __gh_s("thruput-erc721-if"),
        major: __gh_s("0.1"),
        module_path: __gh_s("thruput_erc721_if::events"),
        declared: __gh_s("MintEvent"),
      },
      signature: __gh_protocol.topic(
        __gh_protocol_utils.fromHex(
          "e68e69ba40a8d49bd8b5667dba5fb82b6799f302ff84d9413f787750de916d83",
        ),
      ),
      topics: [
        {
          name: __gh_s("to"),
          ty: { v: __gh_contract_spec.ContractTypeKind.Address },
        },
      ],
      fields: [
        {
          name: __gh_s("token_id"),
          ty: {
            v: __gh_contract_spec.ContractTypeKind.Array,
            array: {
              element: { v: __gh_contract_spec.ContractTypeKind.U8 },
              len: 32n,
            },
          },
        },
      ],
    },
    {
      name: {
        crate_name: __gh_s("thruput-erc721-if"),
        major: __gh_s("0.1"),
        module_path: __gh_s("thruput_erc721_if::events"),
        declared: __gh_s("TransferEvent"),
      },
      signature: __gh_protocol.topic(
        __gh_protocol_utils.fromHex(
          "2c86fa41e5b2f782bf9974eef7d2ee03fc89cb6a2bcda3485a6c559d2a82c258",
        ),
      ),
      topics: [
        {
          name: __gh_s("from"),
          ty: { v: __gh_contract_spec.ContractTypeKind.Address },
        },
        {
          name: __gh_s("to"),
          ty: { v: __gh_contract_spec.ContractTypeKind.Address },
        },
      ],
      fields: [
        {
          name: __gh_s("token_id"),
          ty: {
            v: __gh_contract_spec.ContractTypeKind.Array,
            array: {
              element: { v: __gh_contract_spec.ContractTypeKind.U8 },
              len: 32n,
            },
          },
        },
      ],
    },
  ],
};

const __gh_codecs = __gh_client_contract.createContractCodecContext(
  spec.type_defs,
);

export const ERC165 = {
  v0_1: {
    supportsInterface: __gh_client_contract.defineContractMethod<
      ERC165.v0_1.SupportsInterfaceArgs,
      ERC165.v0_1.SupportsInterfaceResult,
      ERC165.v0_1.DeclaredException
    >({
      interfaceName: "ERC165",
      interfaceVersion: "0.1.77",
      abiName: "supports_interface",
      publicName: "supportsInterface",
      entrypoint: __gh_entrypoints.ERC165.v0_1.supportsInterface,
      effect: spec.interfaces[0]!.methods[0]!.effect,
      args: [
        {
          abiName: "interface_id",
          publicName: "interfaceId",
          type: spec.interfaces[0]!.methods[0]!.args[0]!.ty,
        },
      ],
      returnType: spec.interfaces[0]!.methods[0]!.return_type,
      throws: [],
      codecs: __gh_codecs,
    }),
    supportsInterfaces: __gh_client_contract.defineContractMethod<
      ERC165.v0_1.SupportsInterfacesArgs,
      ERC165.v0_1.SupportsInterfacesResult,
      ERC165.v0_1.DeclaredException
    >({
      interfaceName: "ERC165",
      interfaceVersion: "0.1.77",
      abiName: "supports_interfaces",
      publicName: "supportsInterfaces",
      entrypoint: __gh_entrypoints.ERC165.v0_1.supportsInterfaces,
      effect: spec.interfaces[0]!.methods[1]!.effect,
      args: [
        {
          abiName: "interface_ids",
          publicName: "interfaceIds",
          type: spec.interfaces[0]!.methods[1]!.args[0]!.ty,
        },
      ],
      returnType: spec.interfaces[0]!.methods[1]!.return_type,
      throws: [],
      codecs: __gh_codecs,
    }),
  },
} as const;

export const ERC721 = {
  v0_1: {
    approve: __gh_client_contract.defineContractMethod<
      ERC721.v0_1.ApproveArgs,
      ERC721.v0_1.ApproveResult,
      ERC721.v0_1.DeclaredException
    >({
      interfaceName: "ERC721",
      interfaceVersion: "0.1.77",
      abiName: "approve",
      publicName: "approve",
      entrypoint: __gh_entrypoints.ERC721.v0_1.approve,
      effect: spec.interfaces[1]!.methods[0]!.effect,
      args: [
        {
          abiName: "to",
          publicName: "to",
          type: spec.interfaces[1]!.methods[0]!.args[0]!.ty,
        },
        {
          abiName: "token_id",
          publicName: "tokenId",
          type: spec.interfaces[1]!.methods[0]!.args[1]!.ty,
        },
      ],
      returnType: spec.interfaces[1]!.methods[0]!.return_type,
      throws: [
        {
          selector: 0xd7c47adee89f0597n,
          name: "ERC721Error",
          type: spec.interfaces[1]!.throws[0]!.ty,
        },
      ],
      codecs: __gh_codecs,
    }),
    balanceOf: __gh_client_contract.defineContractMethod<
      ERC721.v0_1.BalanceOfArgs,
      ERC721.v0_1.BalanceOfResult,
      ERC721.v0_1.DeclaredException
    >({
      interfaceName: "ERC721",
      interfaceVersion: "0.1.77",
      abiName: "balance_of",
      publicName: "balanceOf",
      entrypoint: __gh_entrypoints.ERC721.v0_1.balanceOf,
      effect: spec.interfaces[1]!.methods[1]!.effect,
      args: [
        {
          abiName: "owner",
          publicName: "owner",
          type: spec.interfaces[1]!.methods[1]!.args[0]!.ty,
        },
      ],
      returnType: spec.interfaces[1]!.methods[1]!.return_type,
      throws: [
        {
          selector: 0xd7c47adee89f0597n,
          name: "ERC721Error",
          type: spec.interfaces[1]!.throws[0]!.ty,
        },
      ],
      codecs: __gh_codecs,
    }),
    getApproved: __gh_client_contract.defineContractMethod<
      ERC721.v0_1.GetApprovedArgs,
      ERC721.v0_1.GetApprovedResult,
      ERC721.v0_1.DeclaredException
    >({
      interfaceName: "ERC721",
      interfaceVersion: "0.1.77",
      abiName: "get_approved",
      publicName: "getApproved",
      entrypoint: __gh_entrypoints.ERC721.v0_1.getApproved,
      effect: spec.interfaces[1]!.methods[2]!.effect,
      args: [
        {
          abiName: "token_id",
          publicName: "tokenId",
          type: spec.interfaces[1]!.methods[2]!.args[0]!.ty,
        },
      ],
      returnType: spec.interfaces[1]!.methods[2]!.return_type,
      throws: [
        {
          selector: 0xd7c47adee89f0597n,
          name: "ERC721Error",
          type: spec.interfaces[1]!.throws[0]!.ty,
        },
      ],
      codecs: __gh_codecs,
    }),
    isApprovedForAll: __gh_client_contract.defineContractMethod<
      ERC721.v0_1.IsApprovedForAllArgs,
      ERC721.v0_1.IsApprovedForAllResult,
      ERC721.v0_1.DeclaredException
    >({
      interfaceName: "ERC721",
      interfaceVersion: "0.1.77",
      abiName: "is_approved_for_all",
      publicName: "isApprovedForAll",
      entrypoint: __gh_entrypoints.ERC721.v0_1.isApprovedForAll,
      effect: spec.interfaces[1]!.methods[3]!.effect,
      args: [
        {
          abiName: "owner",
          publicName: "owner",
          type: spec.interfaces[1]!.methods[3]!.args[0]!.ty,
        },
        {
          abiName: "operator",
          publicName: "operator",
          type: spec.interfaces[1]!.methods[3]!.args[1]!.ty,
        },
      ],
      returnType: spec.interfaces[1]!.methods[3]!.return_type,
      throws: [
        {
          selector: 0xd7c47adee89f0597n,
          name: "ERC721Error",
          type: spec.interfaces[1]!.throws[0]!.ty,
        },
      ],
      codecs: __gh_codecs,
    }),
    ownerOf: __gh_client_contract.defineContractMethod<
      ERC721.v0_1.OwnerOfArgs,
      ERC721.v0_1.OwnerOfResult,
      ERC721.v0_1.DeclaredException
    >({
      interfaceName: "ERC721",
      interfaceVersion: "0.1.77",
      abiName: "owner_of",
      publicName: "ownerOf",
      entrypoint: __gh_entrypoints.ERC721.v0_1.ownerOf,
      effect: spec.interfaces[1]!.methods[4]!.effect,
      args: [
        {
          abiName: "token_id",
          publicName: "tokenId",
          type: spec.interfaces[1]!.methods[4]!.args[0]!.ty,
        },
      ],
      returnType: spec.interfaces[1]!.methods[4]!.return_type,
      throws: [
        {
          selector: 0xd7c47adee89f0597n,
          name: "ERC721Error",
          type: spec.interfaces[1]!.throws[0]!.ty,
        },
      ],
      codecs: __gh_codecs,
    }),
    safeTransferFrom: __gh_client_contract.defineContractMethod<
      ERC721.v0_1.SafeTransferFromArgs,
      ERC721.v0_1.SafeTransferFromResult,
      ERC721.v0_1.DeclaredException
    >({
      interfaceName: "ERC721",
      interfaceVersion: "0.1.77",
      abiName: "safe_transfer_from",
      publicName: "safeTransferFrom",
      entrypoint: __gh_entrypoints.ERC721.v0_1.safeTransferFrom,
      effect: spec.interfaces[1]!.methods[5]!.effect,
      args: [
        {
          abiName: "from",
          publicName: "from",
          type: spec.interfaces[1]!.methods[5]!.args[0]!.ty,
        },
        {
          abiName: "to",
          publicName: "to",
          type: spec.interfaces[1]!.methods[5]!.args[1]!.ty,
        },
        {
          abiName: "token_id",
          publicName: "tokenId",
          type: spec.interfaces[1]!.methods[5]!.args[2]!.ty,
        },
        {
          abiName: "data",
          publicName: "data",
          type: spec.interfaces[1]!.methods[5]!.args[3]!.ty,
        },
      ],
      returnType: spec.interfaces[1]!.methods[5]!.return_type,
      throws: [
        {
          selector: 0xd7c47adee89f0597n,
          name: "ERC721Error",
          type: spec.interfaces[1]!.throws[0]!.ty,
        },
      ],
      codecs: __gh_codecs,
    }),
    setApprovalForAll: __gh_client_contract.defineContractMethod<
      ERC721.v0_1.SetApprovalForAllArgs,
      ERC721.v0_1.SetApprovalForAllResult,
      ERC721.v0_1.DeclaredException
    >({
      interfaceName: "ERC721",
      interfaceVersion: "0.1.77",
      abiName: "set_approval_for_all",
      publicName: "setApprovalForAll",
      entrypoint: __gh_entrypoints.ERC721.v0_1.setApprovalForAll,
      effect: spec.interfaces[1]!.methods[6]!.effect,
      args: [
        {
          abiName: "operator",
          publicName: "operator",
          type: spec.interfaces[1]!.methods[6]!.args[0]!.ty,
        },
        {
          abiName: "approved",
          publicName: "approved",
          type: spec.interfaces[1]!.methods[6]!.args[1]!.ty,
        },
      ],
      returnType: spec.interfaces[1]!.methods[6]!.return_type,
      throws: [
        {
          selector: 0xd7c47adee89f0597n,
          name: "ERC721Error",
          type: spec.interfaces[1]!.throws[0]!.ty,
        },
      ],
      codecs: __gh_codecs,
    }),
    transferFrom: __gh_client_contract.defineContractMethod<
      ERC721.v0_1.TransferFromArgs,
      ERC721.v0_1.TransferFromResult,
      ERC721.v0_1.DeclaredException
    >({
      interfaceName: "ERC721",
      interfaceVersion: "0.1.77",
      abiName: "transfer_from",
      publicName: "transferFrom",
      entrypoint: __gh_entrypoints.ERC721.v0_1.transferFrom,
      effect: spec.interfaces[1]!.methods[7]!.effect,
      args: [
        {
          abiName: "from",
          publicName: "from",
          type: spec.interfaces[1]!.methods[7]!.args[0]!.ty,
        },
        {
          abiName: "to",
          publicName: "to",
          type: spec.interfaces[1]!.methods[7]!.args[1]!.ty,
        },
        {
          abiName: "token_id",
          publicName: "tokenId",
          type: spec.interfaces[1]!.methods[7]!.args[2]!.ty,
        },
      ],
      returnType: spec.interfaces[1]!.methods[7]!.return_type,
      throws: [
        {
          selector: 0xd7c47adee89f0597n,
          name: "ERC721Error",
          type: spec.interfaces[1]!.throws[0]!.ty,
        },
      ],
      codecs: __gh_codecs,
    }),
  },
} as const;

export const ERC721Metadata = {
  v0_1: {
    name: __gh_client_contract.defineContractMethod<
      ERC721Metadata.v0_1.NameArgs,
      ERC721Metadata.v0_1.NameResult,
      ERC721Metadata.v0_1.DeclaredException
    >({
      interfaceName: "ERC721Metadata",
      interfaceVersion: "0.1.77",
      abiName: "name",
      publicName: "name",
      entrypoint: __gh_entrypoints.ERC721Metadata.v0_1.name,
      effect: spec.interfaces[2]!.methods[0]!.effect,
      args: [],
      returnType: spec.interfaces[2]!.methods[0]!.return_type,
      throws: [
        {
          selector: 0xd7c47adee89f0597n,
          name: "ERC721Error",
          type: spec.interfaces[2]!.throws[0]!.ty,
        },
      ],
      codecs: __gh_codecs,
    }),
    symbol: __gh_client_contract.defineContractMethod<
      ERC721Metadata.v0_1.SymbolArgs,
      ERC721Metadata.v0_1.SymbolResult,
      ERC721Metadata.v0_1.DeclaredException
    >({
      interfaceName: "ERC721Metadata",
      interfaceVersion: "0.1.77",
      abiName: "symbol",
      publicName: "symbol",
      entrypoint: __gh_entrypoints.ERC721Metadata.v0_1.symbol,
      effect: spec.interfaces[2]!.methods[1]!.effect,
      args: [],
      returnType: spec.interfaces[2]!.methods[1]!.return_type,
      throws: [
        {
          selector: 0xd7c47adee89f0597n,
          name: "ERC721Error",
          type: spec.interfaces[2]!.throws[0]!.ty,
        },
      ],
      codecs: __gh_codecs,
    }),
    tokenMetadata: __gh_client_contract.defineContractMethod<
      ERC721Metadata.v0_1.TokenMetadataArgs,
      ERC721Metadata.v0_1.TokenMetadataResult,
      ERC721Metadata.v0_1.DeclaredException
    >({
      interfaceName: "ERC721Metadata",
      interfaceVersion: "0.1.77",
      abiName: "token_metadata",
      publicName: "tokenMetadata",
      entrypoint: __gh_entrypoints.ERC721Metadata.v0_1.tokenMetadata,
      effect: spec.interfaces[2]!.methods[2]!.effect,
      args: [
        {
          abiName: "token_id",
          publicName: "tokenId",
          type: spec.interfaces[2]!.methods[2]!.args[0]!.ty,
        },
      ],
      returnType: spec.interfaces[2]!.methods[2]!.return_type,
      throws: [
        {
          selector: 0xd7c47adee89f0597n,
          name: "ERC721Error",
          type: spec.interfaces[2]!.throws[0]!.ty,
        },
      ],
      codecs: __gh_codecs,
    }),
    tokenUri: __gh_client_contract.defineContractMethod<
      ERC721Metadata.v0_1.TokenUriArgs,
      ERC721Metadata.v0_1.TokenUriResult,
      ERC721Metadata.v0_1.DeclaredException
    >({
      interfaceName: "ERC721Metadata",
      interfaceVersion: "0.1.77",
      abiName: "token_uri",
      publicName: "tokenUri",
      entrypoint: __gh_entrypoints.ERC721Metadata.v0_1.tokenUri,
      effect: spec.interfaces[2]!.methods[3]!.effect,
      args: [
        {
          abiName: "token_id",
          publicName: "tokenId",
          type: spec.interfaces[2]!.methods[3]!.args[0]!.ty,
        },
      ],
      returnType: spec.interfaces[2]!.methods[3]!.return_type,
      throws: [
        {
          selector: 0xd7c47adee89f0597n,
          name: "ERC721Error",
          type: spec.interfaces[2]!.throws[0]!.ty,
        },
      ],
      codecs: __gh_codecs,
    }),
  },
} as const;

export const NftDrop = {
  v0_1: {
    getConfig: __gh_client_contract.defineContractMethod<
      NftDrop.v0_1.GetConfigArgs,
      NftDrop.v0_1.GetConfigResult,
      NftDrop.v0_1.DeclaredException
    >({
      interfaceName: "NftDrop",
      interfaceVersion: "0.1.0",
      abiName: "get_config",
      publicName: "getConfig",
      entrypoint: __gh_entrypoints.NftDrop.v0_1.getConfig,
      effect: spec.interfaces[3]!.methods[0]!.effect,
      args: [],
      returnType: spec.interfaces[3]!.methods[0]!.return_type,
      throws: [
        {
          selector: 0x2902708a7cd962abn,
          name: "DropError",
          type: spec.interfaces[3]!.throws[0]!.ty,
        },
        {
          selector: 0xd7c47adee89f0597n,
          name: "ERC721Error",
          type: spec.interfaces[3]!.throws[1]!.ty,
        },
      ],
      codecs: __gh_codecs,
    }),
    getTrait: __gh_client_contract.defineContractMethod<
      NftDrop.v0_1.GetTraitArgs,
      NftDrop.v0_1.GetTraitResult,
      NftDrop.v0_1.DeclaredException
    >({
      interfaceName: "NftDrop",
      interfaceVersion: "0.1.0",
      abiName: "get_trait",
      publicName: "getTrait",
      entrypoint: __gh_entrypoints.NftDrop.v0_1.getTrait,
      effect: spec.interfaces[3]!.methods[1]!.effect,
      args: [
        {
          abiName: "index",
          publicName: "index",
          type: spec.interfaces[3]!.methods[1]!.args[0]!.ty,
        },
      ],
      returnType: spec.interfaces[3]!.methods[1]!.return_type,
      throws: [
        {
          selector: 0x2902708a7cd962abn,
          name: "DropError",
          type: spec.interfaces[3]!.throws[0]!.ty,
        },
        {
          selector: 0xd7c47adee89f0597n,
          name: "ERC721Error",
          type: spec.interfaces[3]!.throws[1]!.ty,
        },
      ],
      codecs: __gh_codecs,
    }),
    initialize: __gh_client_contract.defineContractMethod<
      NftDrop.v0_1.InitializeArgs,
      NftDrop.v0_1.InitializeResult,
      NftDrop.v0_1.DeclaredException
    >({
      interfaceName: "NftDrop",
      interfaceVersion: "0.1.0",
      abiName: "initialize",
      publicName: "initialize",
      entrypoint: __gh_entrypoints.NftDrop.v0_1.initialize,
      effect: spec.interfaces[3]!.methods[2]!.effect,
      args: [
        {
          abiName: "creator",
          publicName: "creator",
          type: spec.interfaces[3]!.methods[2]!.args[0]!.ty,
        },
        {
          abiName: "definition",
          publicName: "definition",
          type: spec.interfaces[3]!.methods[2]!.args[1]!.ty,
        },
      ],
      returnType: spec.interfaces[3]!.methods[2]!.return_type,
      throws: [
        {
          selector: 0x2902708a7cd962abn,
          name: "DropError",
          type: spec.interfaces[3]!.throws[0]!.ty,
        },
        {
          selector: 0xd7c47adee89f0597n,
          name: "ERC721Error",
          type: spec.interfaces[3]!.throws[1]!.ty,
        },
      ],
      codecs: __gh_codecs,
    }),
    mint: __gh_client_contract.defineContractMethod<
      NftDrop.v0_1.MintArgs,
      NftDrop.v0_1.MintResult,
      NftDrop.v0_1.DeclaredException
    >({
      interfaceName: "NftDrop",
      interfaceVersion: "0.1.0",
      abiName: "mint",
      publicName: "mint",
      entrypoint: __gh_entrypoints.NftDrop.v0_1.mint,
      effect: spec.interfaces[3]!.methods[3]!.effect,
      args: [],
      returnType: spec.interfaces[3]!.methods[3]!.return_type,
      throws: [
        {
          selector: 0x2902708a7cd962abn,
          name: "DropError",
          type: spec.interfaces[3]!.throws[0]!.ty,
        },
        {
          selector: 0xd7c47adee89f0597n,
          name: "ERC721Error",
          type: spec.interfaces[3]!.throws[1]!.ty,
        },
      ],
      codecs: __gh_codecs,
    }),
    remaining: __gh_client_contract.defineContractMethod<
      NftDrop.v0_1.RemainingArgs,
      NftDrop.v0_1.RemainingResult,
      NftDrop.v0_1.DeclaredException
    >({
      interfaceName: "NftDrop",
      interfaceVersion: "0.1.0",
      abiName: "remaining",
      publicName: "remaining",
      entrypoint: __gh_entrypoints.NftDrop.v0_1.remaining,
      effect: spec.interfaces[3]!.methods[4]!.effect,
      args: [],
      returnType: spec.interfaces[3]!.methods[4]!.return_type,
      throws: [
        {
          selector: 0x2902708a7cd962abn,
          name: "DropError",
          type: spec.interfaces[3]!.throws[0]!.ty,
        },
        {
          selector: 0xd7c47adee89f0597n,
          name: "ERC721Error",
          type: spec.interfaces[3]!.throws[1]!.ty,
        },
      ],
      codecs: __gh_codecs,
    }),
    traitCount: __gh_client_contract.defineContractMethod<
      NftDrop.v0_1.TraitCountArgs,
      NftDrop.v0_1.TraitCountResult,
      NftDrop.v0_1.DeclaredException
    >({
      interfaceName: "NftDrop",
      interfaceVersion: "0.1.0",
      abiName: "trait_count",
      publicName: "traitCount",
      entrypoint: __gh_entrypoints.NftDrop.v0_1.traitCount,
      effect: spec.interfaces[3]!.methods[5]!.effect,
      args: [
        {
          abiName: "index",
          publicName: "index",
          type: spec.interfaces[3]!.methods[5]!.args[0]!.ty,
        },
        {
          abiName: "value",
          publicName: "value",
          type: spec.interfaces[3]!.methods[5]!.args[1]!.ty,
        },
      ],
      returnType: spec.interfaces[3]!.methods[5]!.return_type,
      throws: [
        {
          selector: 0x2902708a7cd962abn,
          name: "DropError",
          type: spec.interfaces[3]!.throws[0]!.ty,
        },
        {
          selector: 0xd7c47adee89f0597n,
          name: "ERC721Error",
          type: spec.interfaces[3]!.throws[1]!.ty,
        },
      ],
      codecs: __gh_codecs,
    }),
    traitsOf: __gh_client_contract.defineContractMethod<
      NftDrop.v0_1.TraitsOfArgs,
      NftDrop.v0_1.TraitsOfResult,
      NftDrop.v0_1.DeclaredException
    >({
      interfaceName: "NftDrop",
      interfaceVersion: "0.1.0",
      abiName: "traits_of",
      publicName: "traitsOf",
      entrypoint: __gh_entrypoints.NftDrop.v0_1.traitsOf,
      effect: spec.interfaces[3]!.methods[6]!.effect,
      args: [
        {
          abiName: "token_id",
          publicName: "tokenId",
          type: spec.interfaces[3]!.methods[6]!.args[0]!.ty,
        },
      ],
      returnType: spec.interfaces[3]!.methods[6]!.return_type,
      throws: [
        {
          selector: 0x2902708a7cd962abn,
          name: "DropError",
          type: spec.interfaces[3]!.throws[0]!.ty,
        },
        {
          selector: 0xd7c47adee89f0597n,
          name: "ERC721Error",
          type: spec.interfaces[3]!.throws[1]!.ty,
        },
      ],
      codecs: __gh_codecs,
    }),
  },
} as const;

export const nft_drop = {
  v0_1: {
    implementation: {
      DropError: {
        AlreadyInitialized: 1n,
        InvalidDefinition: 2n,
        SoldOut: 3n,
      },
      TraitsRolled: __gh_client_contract.defineContractEvent<
        "TraitsRolled",
        nft_drop.v0_1.implementation.TraitsRolled["topics"],
        nft_drop.v0_1.implementation.TraitsRolled["fields"],
        nft_drop.v0_1.implementation.TraitsRolledFilter
      >({
        name: "TraitsRolled",
        signature: spec.events[0]!.signature,
        topics: [
          {
            name: "owner",
            type: spec.events[0]!.topics[0]!.ty,
            representation: "address",
          },
        ],
        fields: [
          { name: "token_id", type: spec.events[0]!.fields[0]!.ty },
          { name: "traits", type: spec.events[0]!.fields[1]!.ty },
        ],
        codecs: __gh_codecs,
      }),
    },
  },
} as const;

export const thruput_erc721_if = {
  v0_1: {
    error: {
      ERC721Error: {
        NonexistentToken: 1n,
        IncorrectOwner: 2n,
        InvalidReceiver: 3n,
        InsufficientApproval: 4n,
        InvalidApprover: 5n,
        NoTokenUri: 6n,
      },
    },
    events: {
      ApprovalEvent: __gh_client_contract.defineContractEvent<
        "ApprovalEvent",
        thruput_erc721_if.v0_1.events.ApprovalEvent["topics"],
        thruput_erc721_if.v0_1.events.ApprovalEvent["fields"],
        thruput_erc721_if.v0_1.events.ApprovalEventFilter
      >({
        name: "ApprovalEvent",
        signature: spec.events[1]!.signature,
        topics: [
          {
            name: "owner",
            type: spec.events[1]!.topics[0]!.ty,
            representation: "address",
          },
          {
            name: "approved",
            type: spec.events[1]!.topics[1]!.ty,
            representation: "address",
          },
        ],
        fields: [{ name: "token_id", type: spec.events[1]!.fields[0]!.ty }],
        codecs: __gh_codecs,
      }),
      ApprovalForAllEvent: __gh_client_contract.defineContractEvent<
        "ApprovalForAllEvent",
        thruput_erc721_if.v0_1.events.ApprovalForAllEvent["topics"],
        thruput_erc721_if.v0_1.events.ApprovalForAllEvent["fields"],
        thruput_erc721_if.v0_1.events.ApprovalForAllEventFilter
      >({
        name: "ApprovalForAllEvent",
        signature: spec.events[2]!.signature,
        topics: [
          {
            name: "owner",
            type: spec.events[2]!.topics[0]!.ty,
            representation: "address",
          },
          {
            name: "operator",
            type: spec.events[2]!.topics[1]!.ty,
            representation: "address",
          },
        ],
        fields: [{ name: "approved", type: spec.events[2]!.fields[0]!.ty }],
        codecs: __gh_codecs,
      }),
      BurnEvent: __gh_client_contract.defineContractEvent<
        "BurnEvent",
        thruput_erc721_if.v0_1.events.BurnEvent["topics"],
        thruput_erc721_if.v0_1.events.BurnEvent["fields"],
        thruput_erc721_if.v0_1.events.BurnEventFilter
      >({
        name: "BurnEvent",
        signature: spec.events[3]!.signature,
        topics: [
          {
            name: "from",
            type: spec.events[3]!.topics[0]!.ty,
            representation: "address",
          },
        ],
        fields: [{ name: "token_id", type: spec.events[3]!.fields[0]!.ty }],
        codecs: __gh_codecs,
      }),
      MintEvent: __gh_client_contract.defineContractEvent<
        "MintEvent",
        thruput_erc721_if.v0_1.events.MintEvent["topics"],
        thruput_erc721_if.v0_1.events.MintEvent["fields"],
        thruput_erc721_if.v0_1.events.MintEventFilter
      >({
        name: "MintEvent",
        signature: spec.events[4]!.signature,
        topics: [
          {
            name: "to",
            type: spec.events[4]!.topics[0]!.ty,
            representation: "address",
          },
        ],
        fields: [{ name: "token_id", type: spec.events[4]!.fields[0]!.ty }],
        codecs: __gh_codecs,
      }),
      TransferEvent: __gh_client_contract.defineContractEvent<
        "TransferEvent",
        thruput_erc721_if.v0_1.events.TransferEvent["topics"],
        thruput_erc721_if.v0_1.events.TransferEvent["fields"],
        thruput_erc721_if.v0_1.events.TransferEventFilter
      >({
        name: "TransferEvent",
        signature: spec.events[5]!.signature,
        topics: [
          {
            name: "from",
            type: spec.events[5]!.topics[0]!.ty,
            representation: "address",
          },
          {
            name: "to",
            type: spec.events[5]!.topics[1]!.ty,
            representation: "address",
          },
        ],
        fields: [{ name: "token_id", type: spec.events[5]!.fields[0]!.ty }],
        codecs: __gh_codecs,
      }),
    },
  },
} as const;

export type ERC165Event =
  | nft_drop.v0_1.implementation.TraitsRolled
  | thruput_erc721_if.v0_1.events.ApprovalEvent
  | thruput_erc721_if.v0_1.events.ApprovalForAllEvent
  | thruput_erc721_if.v0_1.events.BurnEvent
  | thruput_erc721_if.v0_1.events.MintEvent
  | thruput_erc721_if.v0_1.events.TransferEvent;

export function decodeEvent(__gh_event: {
  topics: globalThis.Uint8Array[];
  data: globalThis.Uint8Array;
}): ERC165Event | null {
  return (
    nft_drop.v0_1.implementation.TraitsRolled.decode(__gh_event) ??
    thruput_erc721_if.v0_1.events.ApprovalEvent.decode(__gh_event) ??
    thruput_erc721_if.v0_1.events.ApprovalForAllEvent.decode(__gh_event) ??
    thruput_erc721_if.v0_1.events.BurnEvent.decode(__gh_event) ??
    thruput_erc721_if.v0_1.events.MintEvent.decode(__gh_event) ??
    thruput_erc721_if.v0_1.events.TransferEvent.decode(__gh_event)
  );
}

// The types the namespaces above refer to, under names no declaration can capture.
export namespace __gh_codegen {
  export type nft_drop$v0_1$implementation$DropConfig =
    nft_drop.v0_1.implementation.DropConfig;
  export type nft_drop$v0_1$implementation$DropDefinition =
    nft_drop.v0_1.implementation.DropDefinition;
  export type nft_drop$v0_1$implementation$DropError =
    nft_drop.v0_1.implementation.DropError;
  export type nft_drop$v0_1$implementation$Trait =
    nft_drop.v0_1.implementation.Trait;
  export type nft_drop$v0_1$implementation$TraitValue =
    nft_drop.v0_1.implementation.TraitValue;
  export type thruput_erc721_if$v0_1$OnchainMetadata =
    thruput_erc721_if.v0_1.OnchainMetadata;
  export type thruput_erc721_if$v0_1$TokenMetadata =
    thruput_erc721_if.v0_1.TokenMetadata;
  export type thruput_erc721_if$v0_1$error$ERC721Error =
    thruput_erc721_if.v0_1.error.ERC721Error;
}
