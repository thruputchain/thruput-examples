// Generated from voting.spec.xdr - Voting interface v0.1.0
// DO NOT EDIT. Re-run codegen to update.

import * as __gh_protocol from "@thruputchain/protocol";
import * as __gh_protocol_utils from "@thruputchain/protocol/utils";
import * as __gh_contract_spec from "@thruputchain/contract-spec";
import * as __gh_client_contract from "@thruputchain/client/contract";

const __gh_s = __gh_contract_spec.contractSpecString;

const __gh_entrypoints = {
  Voting: {
    v0_1: {
      answer: __gh_protocol.contractEntrypointID(
        __gh_protocol_utils.fromHex("577c1d58a55c1c54"),
      ),
      closePoll: __gh_protocol.contractEntrypointID(
        __gh_protocol_utils.fromHex("7e3a46bbc22af8a8"),
      ),
      count: __gh_protocol.contractEntrypointID(
        __gh_protocol_utils.fromHex("4b8937bb941660d3"),
      ),
      createPoll: __gh_protocol.contractEntrypointID(
        __gh_protocol_utils.fromHex("9c04fe8e5fa64596"),
      ),
      editPoll: __gh_protocol.contractEntrypointID(
        __gh_protocol_utils.fromHex("ca3f5167ec7a9195"),
      ),
      getPoll: __gh_protocol.contractEntrypointID(
        __gh_protocol_utils.fromHex("9c41fe95f4edcf2e"),
      ),
      getQuestion: __gh_protocol.contractEntrypointID(
        __gh_protocol_utils.fromHex("d06addd9200f467d"),
      ),
      openPoll: __gh_protocol.contractEntrypointID(
        __gh_protocol_utils.fromHex("6cc2a37cecfaa284"),
      ),
      participantCount: __gh_protocol.contractEntrypointID(
        __gh_protocol_utils.fromHex("1358d69df38b0110"),
      ),
      tally: __gh_protocol.contractEntrypointID(
        __gh_protocol_utils.fromHex("fd65649da5671919"),
      ),
      vote: __gh_protocol.contractEntrypointID(
        __gh_protocol_utils.fromHex("d099810a321f1ee9"),
      ),
    },
  },
} as const;

export namespace voting {
  export namespace v0_1 {
    export namespace implementation {
      export interface Definition {
        title: string;
        description: string;
        questions: __gh_codegen.voting$v0_1$implementation$Question[];
      }

      export interface PollHeader {
        admin: __gh_protocol.ContractAddress;
        status: __gh_codegen.voting$v0_1$implementation$Status;
        title: string;
        description: string;
        question_count: bigint;
      }

      export interface Question {
        title: string;
        options: string[];
      }

      export type Status = 0n | 1n | 2n;

      export type VotingError = 1n | 2n | 3n | 4n | 5n | 6n | 7n;

      export interface PollCreated extends __gh_client_contract.DecodedContractEvent<
        "PollCreated",
        { id: bigint },
        { admin: __gh_protocol.ContractAddress }
      > {}

      export interface PollCreatedFilter {
        id?: __gh_client_contract.ContractEventFilterValue<bigint>;
      }
    }
  }
}

export namespace Voting {
  export namespace v0_1 {
    export interface AnswerArgs {
      id: bigint;
      voter: __gh_protocol.ContractAddress;
      question: bigint;
    }
    export type AnswerResult = bigint | null;

    export interface ClosePollArgs {
      id: bigint;
    }
    export type ClosePollResult = void;

    export type CountArgs = void;
    export type CountResult = bigint;

    export interface CreatePollArgs {
      definition: __gh_codegen.voting$v0_1$implementation$Definition;
    }
    export type CreatePollResult = bigint;

    export interface EditPollArgs {
      id: bigint;
      definition: __gh_codegen.voting$v0_1$implementation$Definition;
    }
    export type EditPollResult = void;

    export interface GetPollArgs {
      id: bigint;
    }
    export type GetPollResult =
      __gh_codegen.voting$v0_1$implementation$PollHeader;

    export interface GetQuestionArgs {
      id: bigint;
      question: bigint;
    }
    export type GetQuestionResult =
      __gh_codegen.voting$v0_1$implementation$Question;

    export interface OpenPollArgs {
      id: bigint;
    }
    export type OpenPollResult = void;

    export interface ParticipantCountArgs {
      id: bigint;
    }
    export type ParticipantCountResult = bigint;

    export interface TallyArgs {
      id: bigint;
      question: bigint;
      option: bigint;
    }
    export type TallyResult = bigint;

    export interface VoteArgs {
      id: bigint;
      question: bigint;
      option: bigint;
    }
    export type VoteResult = void;

    export type DeclaredException = {
      kind: "declared";
      name: "VotingError";
      selector: 0x5cee1280c1ea67d5n;
      value: __gh_codegen.voting$v0_1$implementation$VotingError;
    };
    export type Exception =
      __gh_client_contract.ContractException<DeclaredException>;
  }
}

export const spec: __gh_client_contract.ContractSpec = {
  interfaces: [
    {
      name: __gh_s("Voting"),
      vers: __gh_s("0.1.0"),
      throws: [
        {
          selector: 0x5cee1280c1ea67d5n,
          ty: {
            v: __gh_contract_spec.ContractTypeKind.Named,
            named: {
              crate_name: __gh_s("voting"),
              major: __gh_s("0.1"),
              module_path: __gh_s("voting::implementation"),
              declared: __gh_s("VotingError"),
            },
          },
        },
      ],
      methods: [
        {
          name: __gh_s("answer"),
          args: [
            {
              name: __gh_s("id"),
              ty: { v: __gh_contract_spec.ContractTypeKind.U64 },
            },
            {
              name: __gh_s("voter"),
              ty: { v: __gh_contract_spec.ContractTypeKind.Address },
            },
            {
              name: __gh_s("question"),
              ty: { v: __gh_contract_spec.ContractTypeKind.U32 },
            },
          ],
          return_type: {
            v: __gh_contract_spec.ContractTypeKind.Option,
            option_inner: { v: __gh_contract_spec.ContractTypeKind.U32 },
          },
          effect: null,
        },
        {
          name: __gh_s("close_poll"),
          args: [
            {
              name: __gh_s("id"),
              ty: { v: __gh_contract_spec.ContractTypeKind.U64 },
            },
          ],
          return_type: { v: __gh_contract_spec.ContractTypeKind.Void },
          effect: null,
        },
        {
          name: __gh_s("count"),
          args: [],
          return_type: { v: __gh_contract_spec.ContractTypeKind.U64 },
          effect: null,
        },
        {
          name: __gh_s("create_poll"),
          args: [
            {
              name: __gh_s("definition"),
              ty: {
                v: __gh_contract_spec.ContractTypeKind.Named,
                named: {
                  crate_name: __gh_s("voting"),
                  major: __gh_s("0.1"),
                  module_path: __gh_s("voting::implementation"),
                  declared: __gh_s("Definition"),
                },
              },
            },
          ],
          return_type: { v: __gh_contract_spec.ContractTypeKind.U64 },
          effect: null,
        },
        {
          name: __gh_s("edit_poll"),
          args: [
            {
              name: __gh_s("id"),
              ty: { v: __gh_contract_spec.ContractTypeKind.U64 },
            },
            {
              name: __gh_s("definition"),
              ty: {
                v: __gh_contract_spec.ContractTypeKind.Named,
                named: {
                  crate_name: __gh_s("voting"),
                  major: __gh_s("0.1"),
                  module_path: __gh_s("voting::implementation"),
                  declared: __gh_s("Definition"),
                },
              },
            },
          ],
          return_type: { v: __gh_contract_spec.ContractTypeKind.Void },
          effect: null,
        },
        {
          name: __gh_s("get_poll"),
          args: [
            {
              name: __gh_s("id"),
              ty: { v: __gh_contract_spec.ContractTypeKind.U64 },
            },
          ],
          return_type: {
            v: __gh_contract_spec.ContractTypeKind.Named,
            named: {
              crate_name: __gh_s("voting"),
              major: __gh_s("0.1"),
              module_path: __gh_s("voting::implementation"),
              declared: __gh_s("PollHeader"),
            },
          },
          effect: null,
        },
        {
          name: __gh_s("get_question"),
          args: [
            {
              name: __gh_s("id"),
              ty: { v: __gh_contract_spec.ContractTypeKind.U64 },
            },
            {
              name: __gh_s("question"),
              ty: { v: __gh_contract_spec.ContractTypeKind.U32 },
            },
          ],
          return_type: {
            v: __gh_contract_spec.ContractTypeKind.Named,
            named: {
              crate_name: __gh_s("voting"),
              major: __gh_s("0.1"),
              module_path: __gh_s("voting::implementation"),
              declared: __gh_s("Question"),
            },
          },
          effect: null,
        },
        {
          name: __gh_s("open_poll"),
          args: [
            {
              name: __gh_s("id"),
              ty: { v: __gh_contract_spec.ContractTypeKind.U64 },
            },
          ],
          return_type: { v: __gh_contract_spec.ContractTypeKind.Void },
          effect: null,
        },
        {
          name: __gh_s("participant_count"),
          args: [
            {
              name: __gh_s("id"),
              ty: { v: __gh_contract_spec.ContractTypeKind.U64 },
            },
          ],
          return_type: { v: __gh_contract_spec.ContractTypeKind.I128 },
          effect: null,
        },
        {
          name: __gh_s("tally"),
          args: [
            {
              name: __gh_s("id"),
              ty: { v: __gh_contract_spec.ContractTypeKind.U64 },
            },
            {
              name: __gh_s("question"),
              ty: { v: __gh_contract_spec.ContractTypeKind.U32 },
            },
            {
              name: __gh_s("option"),
              ty: { v: __gh_contract_spec.ContractTypeKind.U32 },
            },
          ],
          return_type: { v: __gh_contract_spec.ContractTypeKind.I128 },
          effect: null,
        },
        {
          name: __gh_s("vote"),
          args: [
            {
              name: __gh_s("id"),
              ty: { v: __gh_contract_spec.ContractTypeKind.U64 },
            },
            {
              name: __gh_s("question"),
              ty: { v: __gh_contract_spec.ContractTypeKind.U32 },
            },
            {
              name: __gh_s("option"),
              ty: { v: __gh_contract_spec.ContractTypeKind.U32 },
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
      v: __gh_contract_spec.ContractTypeDefKind.TypeDefStruct,
      struct_def: {
        name: {
          crate_name: __gh_s("voting"),
          major: __gh_s("0.1"),
          module_path: __gh_s("voting::implementation"),
          declared: __gh_s("Definition"),
        },
        fields: [
          {
            name: __gh_s("title"),
            ty: { v: __gh_contract_spec.ContractTypeKind.String },
          },
          {
            name: __gh_s("description"),
            ty: { v: __gh_contract_spec.ContractTypeKind.String },
          },
          {
            name: __gh_s("questions"),
            ty: {
              v: __gh_contract_spec.ContractTypeKind.Vector,
              vector: {
                element: {
                  v: __gh_contract_spec.ContractTypeKind.Named,
                  named: {
                    crate_name: __gh_s("voting"),
                    major: __gh_s("0.1"),
                    module_path: __gh_s("voting::implementation"),
                    declared: __gh_s("Question"),
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
          crate_name: __gh_s("voting"),
          major: __gh_s("0.1"),
          module_path: __gh_s("voting::implementation"),
          declared: __gh_s("PollHeader"),
        },
        fields: [
          {
            name: __gh_s("admin"),
            ty: { v: __gh_contract_spec.ContractTypeKind.Address },
          },
          {
            name: __gh_s("status"),
            ty: {
              v: __gh_contract_spec.ContractTypeKind.Named,
              named: {
                crate_name: __gh_s("voting"),
                major: __gh_s("0.1"),
                module_path: __gh_s("voting::implementation"),
                declared: __gh_s("Status"),
              },
            },
          },
          {
            name: __gh_s("title"),
            ty: { v: __gh_contract_spec.ContractTypeKind.String },
          },
          {
            name: __gh_s("description"),
            ty: { v: __gh_contract_spec.ContractTypeKind.String },
          },
          {
            name: __gh_s("question_count"),
            ty: { v: __gh_contract_spec.ContractTypeKind.U32 },
          },
        ],
      },
    },
    {
      v: __gh_contract_spec.ContractTypeDefKind.TypeDefStruct,
      struct_def: {
        name: {
          crate_name: __gh_s("voting"),
          major: __gh_s("0.1"),
          module_path: __gh_s("voting::implementation"),
          declared: __gh_s("Question"),
        },
        fields: [
          {
            name: __gh_s("title"),
            ty: { v: __gh_contract_spec.ContractTypeKind.String },
          },
          {
            name: __gh_s("options"),
            ty: {
              v: __gh_contract_spec.ContractTypeKind.Vector,
              vector: {
                element: { v: __gh_contract_spec.ContractTypeKind.String },
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
          crate_name: __gh_s("voting"),
          major: __gh_s("0.1"),
          module_path: __gh_s("voting::implementation"),
          declared: __gh_s("Status"),
        },
        variants: [
          { name: __gh_s("Draft"), value: 0n },
          { name: __gh_s("Open"), value: 1n },
          { name: __gh_s("Closed"), value: 2n },
        ],
      },
    },
    {
      v: __gh_contract_spec.ContractTypeDefKind.TypeDefEnum,
      enum_def: {
        name: {
          crate_name: __gh_s("voting"),
          major: __gh_s("0.1"),
          module_path: __gh_s("voting::implementation"),
          declared: __gh_s("VotingError"),
        },
        variants: [
          { name: __gh_s("NotFound"), value: 1n },
          { name: __gh_s("NotAdmin"), value: 2n },
          { name: __gh_s("WrongStatus"), value: 3n },
          { name: __gh_s("InvalidDefinition"), value: 4n },
          { name: __gh_s("InvalidSelection"), value: 5n },
          { name: __gh_s("AlreadyAnswered"), value: 6n },
          { name: __gh_s("LimitReached"), value: 7n },
        ],
      },
    },
  ],
  events: [
    {
      name: {
        crate_name: __gh_s("voting"),
        major: __gh_s("0.1"),
        module_path: __gh_s("voting::implementation"),
        declared: __gh_s("PollCreated"),
      },
      signature: __gh_protocol.topic(
        __gh_protocol_utils.fromHex(
          "0b160b3c0702bb7e84870823c2e25e57c97c290c39afa55919065fb86f924311",
        ),
      ),
      topics: [
        {
          name: __gh_s("id"),
          ty: { v: __gh_contract_spec.ContractTypeKind.U64 },
        },
      ],
      fields: [
        {
          name: __gh_s("admin"),
          ty: { v: __gh_contract_spec.ContractTypeKind.Address },
        },
      ],
    },
  ],
};

const __gh_codecs = __gh_client_contract.createContractCodecContext(
  spec.type_defs,
);

export const Voting = {
  v0_1: {
    answer: __gh_client_contract.defineContractMethod<
      Voting.v0_1.AnswerArgs,
      Voting.v0_1.AnswerResult,
      Voting.v0_1.DeclaredException
    >({
      interfaceName: "Voting",
      interfaceVersion: "0.1.0",
      abiName: "answer",
      publicName: "answer",
      entrypoint: __gh_entrypoints.Voting.v0_1.answer,
      effect: spec.interfaces[0]!.methods[0]!.effect,
      args: [
        {
          abiName: "id",
          publicName: "id",
          type: spec.interfaces[0]!.methods[0]!.args[0]!.ty,
        },
        {
          abiName: "voter",
          publicName: "voter",
          type: spec.interfaces[0]!.methods[0]!.args[1]!.ty,
        },
        {
          abiName: "question",
          publicName: "question",
          type: spec.interfaces[0]!.methods[0]!.args[2]!.ty,
        },
      ],
      returnType: spec.interfaces[0]!.methods[0]!.return_type,
      throws: [
        {
          selector: 0x5cee1280c1ea67d5n,
          name: "VotingError",
          type: spec.interfaces[0]!.throws[0]!.ty,
        },
      ],
      codecs: __gh_codecs,
    }),
    closePoll: __gh_client_contract.defineContractMethod<
      Voting.v0_1.ClosePollArgs,
      Voting.v0_1.ClosePollResult,
      Voting.v0_1.DeclaredException
    >({
      interfaceName: "Voting",
      interfaceVersion: "0.1.0",
      abiName: "close_poll",
      publicName: "closePoll",
      entrypoint: __gh_entrypoints.Voting.v0_1.closePoll,
      effect: spec.interfaces[0]!.methods[1]!.effect,
      args: [
        {
          abiName: "id",
          publicName: "id",
          type: spec.interfaces[0]!.methods[1]!.args[0]!.ty,
        },
      ],
      returnType: spec.interfaces[0]!.methods[1]!.return_type,
      throws: [
        {
          selector: 0x5cee1280c1ea67d5n,
          name: "VotingError",
          type: spec.interfaces[0]!.throws[0]!.ty,
        },
      ],
      codecs: __gh_codecs,
    }),
    count: __gh_client_contract.defineContractMethod<
      Voting.v0_1.CountArgs,
      Voting.v0_1.CountResult,
      Voting.v0_1.DeclaredException
    >({
      interfaceName: "Voting",
      interfaceVersion: "0.1.0",
      abiName: "count",
      publicName: "count",
      entrypoint: __gh_entrypoints.Voting.v0_1.count,
      effect: spec.interfaces[0]!.methods[2]!.effect,
      args: [],
      returnType: spec.interfaces[0]!.methods[2]!.return_type,
      throws: [
        {
          selector: 0x5cee1280c1ea67d5n,
          name: "VotingError",
          type: spec.interfaces[0]!.throws[0]!.ty,
        },
      ],
      codecs: __gh_codecs,
    }),
    createPoll: __gh_client_contract.defineContractMethod<
      Voting.v0_1.CreatePollArgs,
      Voting.v0_1.CreatePollResult,
      Voting.v0_1.DeclaredException
    >({
      interfaceName: "Voting",
      interfaceVersion: "0.1.0",
      abiName: "create_poll",
      publicName: "createPoll",
      entrypoint: __gh_entrypoints.Voting.v0_1.createPoll,
      effect: spec.interfaces[0]!.methods[3]!.effect,
      args: [
        {
          abiName: "definition",
          publicName: "definition",
          type: spec.interfaces[0]!.methods[3]!.args[0]!.ty,
        },
      ],
      returnType: spec.interfaces[0]!.methods[3]!.return_type,
      throws: [
        {
          selector: 0x5cee1280c1ea67d5n,
          name: "VotingError",
          type: spec.interfaces[0]!.throws[0]!.ty,
        },
      ],
      codecs: __gh_codecs,
    }),
    editPoll: __gh_client_contract.defineContractMethod<
      Voting.v0_1.EditPollArgs,
      Voting.v0_1.EditPollResult,
      Voting.v0_1.DeclaredException
    >({
      interfaceName: "Voting",
      interfaceVersion: "0.1.0",
      abiName: "edit_poll",
      publicName: "editPoll",
      entrypoint: __gh_entrypoints.Voting.v0_1.editPoll,
      effect: spec.interfaces[0]!.methods[4]!.effect,
      args: [
        {
          abiName: "id",
          publicName: "id",
          type: spec.interfaces[0]!.methods[4]!.args[0]!.ty,
        },
        {
          abiName: "definition",
          publicName: "definition",
          type: spec.interfaces[0]!.methods[4]!.args[1]!.ty,
        },
      ],
      returnType: spec.interfaces[0]!.methods[4]!.return_type,
      throws: [
        {
          selector: 0x5cee1280c1ea67d5n,
          name: "VotingError",
          type: spec.interfaces[0]!.throws[0]!.ty,
        },
      ],
      codecs: __gh_codecs,
    }),
    getPoll: __gh_client_contract.defineContractMethod<
      Voting.v0_1.GetPollArgs,
      Voting.v0_1.GetPollResult,
      Voting.v0_1.DeclaredException
    >({
      interfaceName: "Voting",
      interfaceVersion: "0.1.0",
      abiName: "get_poll",
      publicName: "getPoll",
      entrypoint: __gh_entrypoints.Voting.v0_1.getPoll,
      effect: spec.interfaces[0]!.methods[5]!.effect,
      args: [
        {
          abiName: "id",
          publicName: "id",
          type: spec.interfaces[0]!.methods[5]!.args[0]!.ty,
        },
      ],
      returnType: spec.interfaces[0]!.methods[5]!.return_type,
      throws: [
        {
          selector: 0x5cee1280c1ea67d5n,
          name: "VotingError",
          type: spec.interfaces[0]!.throws[0]!.ty,
        },
      ],
      codecs: __gh_codecs,
    }),
    getQuestion: __gh_client_contract.defineContractMethod<
      Voting.v0_1.GetQuestionArgs,
      Voting.v0_1.GetQuestionResult,
      Voting.v0_1.DeclaredException
    >({
      interfaceName: "Voting",
      interfaceVersion: "0.1.0",
      abiName: "get_question",
      publicName: "getQuestion",
      entrypoint: __gh_entrypoints.Voting.v0_1.getQuestion,
      effect: spec.interfaces[0]!.methods[6]!.effect,
      args: [
        {
          abiName: "id",
          publicName: "id",
          type: spec.interfaces[0]!.methods[6]!.args[0]!.ty,
        },
        {
          abiName: "question",
          publicName: "question",
          type: spec.interfaces[0]!.methods[6]!.args[1]!.ty,
        },
      ],
      returnType: spec.interfaces[0]!.methods[6]!.return_type,
      throws: [
        {
          selector: 0x5cee1280c1ea67d5n,
          name: "VotingError",
          type: spec.interfaces[0]!.throws[0]!.ty,
        },
      ],
      codecs: __gh_codecs,
    }),
    openPoll: __gh_client_contract.defineContractMethod<
      Voting.v0_1.OpenPollArgs,
      Voting.v0_1.OpenPollResult,
      Voting.v0_1.DeclaredException
    >({
      interfaceName: "Voting",
      interfaceVersion: "0.1.0",
      abiName: "open_poll",
      publicName: "openPoll",
      entrypoint: __gh_entrypoints.Voting.v0_1.openPoll,
      effect: spec.interfaces[0]!.methods[7]!.effect,
      args: [
        {
          abiName: "id",
          publicName: "id",
          type: spec.interfaces[0]!.methods[7]!.args[0]!.ty,
        },
      ],
      returnType: spec.interfaces[0]!.methods[7]!.return_type,
      throws: [
        {
          selector: 0x5cee1280c1ea67d5n,
          name: "VotingError",
          type: spec.interfaces[0]!.throws[0]!.ty,
        },
      ],
      codecs: __gh_codecs,
    }),
    participantCount: __gh_client_contract.defineContractMethod<
      Voting.v0_1.ParticipantCountArgs,
      Voting.v0_1.ParticipantCountResult,
      Voting.v0_1.DeclaredException
    >({
      interfaceName: "Voting",
      interfaceVersion: "0.1.0",
      abiName: "participant_count",
      publicName: "participantCount",
      entrypoint: __gh_entrypoints.Voting.v0_1.participantCount,
      effect: spec.interfaces[0]!.methods[8]!.effect,
      args: [
        {
          abiName: "id",
          publicName: "id",
          type: spec.interfaces[0]!.methods[8]!.args[0]!.ty,
        },
      ],
      returnType: spec.interfaces[0]!.methods[8]!.return_type,
      throws: [
        {
          selector: 0x5cee1280c1ea67d5n,
          name: "VotingError",
          type: spec.interfaces[0]!.throws[0]!.ty,
        },
      ],
      codecs: __gh_codecs,
    }),
    tally: __gh_client_contract.defineContractMethod<
      Voting.v0_1.TallyArgs,
      Voting.v0_1.TallyResult,
      Voting.v0_1.DeclaredException
    >({
      interfaceName: "Voting",
      interfaceVersion: "0.1.0",
      abiName: "tally",
      publicName: "tally",
      entrypoint: __gh_entrypoints.Voting.v0_1.tally,
      effect: spec.interfaces[0]!.methods[9]!.effect,
      args: [
        {
          abiName: "id",
          publicName: "id",
          type: spec.interfaces[0]!.methods[9]!.args[0]!.ty,
        },
        {
          abiName: "question",
          publicName: "question",
          type: spec.interfaces[0]!.methods[9]!.args[1]!.ty,
        },
        {
          abiName: "option",
          publicName: "option",
          type: spec.interfaces[0]!.methods[9]!.args[2]!.ty,
        },
      ],
      returnType: spec.interfaces[0]!.methods[9]!.return_type,
      throws: [
        {
          selector: 0x5cee1280c1ea67d5n,
          name: "VotingError",
          type: spec.interfaces[0]!.throws[0]!.ty,
        },
      ],
      codecs: __gh_codecs,
    }),
    vote: __gh_client_contract.defineContractMethod<
      Voting.v0_1.VoteArgs,
      Voting.v0_1.VoteResult,
      Voting.v0_1.DeclaredException
    >({
      interfaceName: "Voting",
      interfaceVersion: "0.1.0",
      abiName: "vote",
      publicName: "vote",
      entrypoint: __gh_entrypoints.Voting.v0_1.vote,
      effect: spec.interfaces[0]!.methods[10]!.effect,
      args: [
        {
          abiName: "id",
          publicName: "id",
          type: spec.interfaces[0]!.methods[10]!.args[0]!.ty,
        },
        {
          abiName: "question",
          publicName: "question",
          type: spec.interfaces[0]!.methods[10]!.args[1]!.ty,
        },
        {
          abiName: "option",
          publicName: "option",
          type: spec.interfaces[0]!.methods[10]!.args[2]!.ty,
        },
      ],
      returnType: spec.interfaces[0]!.methods[10]!.return_type,
      throws: [
        {
          selector: 0x5cee1280c1ea67d5n,
          name: "VotingError",
          type: spec.interfaces[0]!.throws[0]!.ty,
        },
      ],
      codecs: __gh_codecs,
    }),
  },
} as const;

export const voting = {
  v0_1: {
    implementation: {
      PollCreated: __gh_client_contract.defineContractEvent<
        "PollCreated",
        voting.v0_1.implementation.PollCreated["topics"],
        voting.v0_1.implementation.PollCreated["fields"],
        voting.v0_1.implementation.PollCreatedFilter
      >({
        name: "PollCreated",
        signature: spec.events[0]!.signature,
        topics: [
          {
            name: "id",
            type: spec.events[0]!.topics[0]!.ty,
            representation: "u64",
          },
        ],
        fields: [{ name: "admin", type: spec.events[0]!.fields[0]!.ty }],
        codecs: __gh_codecs,
      }),
      Status: {
        Draft: 0n,
        Open: 1n,
        Closed: 2n,
      },
      VotingError: {
        NotFound: 1n,
        NotAdmin: 2n,
        WrongStatus: 3n,
        InvalidDefinition: 4n,
        InvalidSelection: 5n,
        AlreadyAnswered: 6n,
        LimitReached: 7n,
      },
    },
  },
} as const;

export type VotingEvent = voting.v0_1.implementation.PollCreated;

export function decodeEvent(__gh_event: {
  topics: globalThis.Uint8Array[];
  data: globalThis.Uint8Array;
}): VotingEvent | null {
  return voting.v0_1.implementation.PollCreated.decode(__gh_event);
}

// The types the namespaces above refer to, under names no declaration can capture.
export namespace __gh_codegen {
  export type voting$v0_1$implementation$Definition =
    voting.v0_1.implementation.Definition;
  export type voting$v0_1$implementation$PollHeader =
    voting.v0_1.implementation.PollHeader;
  export type voting$v0_1$implementation$Question =
    voting.v0_1.implementation.Question;
  export type voting$v0_1$implementation$Status =
    voting.v0_1.implementation.Status;
  export type voting$v0_1$implementation$VotingError =
    voting.v0_1.implementation.VotingError;
}
