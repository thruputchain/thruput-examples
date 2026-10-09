import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  bytesEqual,
  fixedBytes,
  gasAmount,
  hashContract,
  prepareContractDeployment,
  toHex0x,
  TransactionExecutionError,
  type ContractCall,
  type TransactionReceipt,
} from "@groundhogchain/client";
import {
  contractAddress,
  ContractType,
  ExecResult,
  HOG_ADDRESS,
  sha256Hash,
  type Contract,
  type ContractAddress,
  type Invocation,
  type SHA256Hash,
} from "@groundhogchain/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  StandardTokenFactory,
  standard_token_factory_if,
  type standard_token_factory_if as FactoryTypes,
} from "../generated/standard-token-factory.js";
import {
  ERC20,
  ERC20Clawback,
  ERC20Metadata,
  groundhog_erc20_if,
} from "../generated/standard-token.js";
import { TokenFactoryTestWallet } from "../generated/token-factory-test-wallet.js";
import { startLocalNode, type LocalAccount, type LocalNode } from "./local-node.js";

type FactoryConfig = FactoryTypes.v0_1.factory.FactoryConfig;
const TokenCreated = standard_token_factory_if.v0_1.events.TokenCreated;
const { AllowanceChangeEvent, BurnEvent, MintEvent, TransferEvent } =
  groundhog_erc20_if.v0_1.events;

const childGas = gasAmount(10_000_000n);
const walletGas = gasAmount(100_000_000n);
const requiredTokenFunding = 365_690n;
const tokenSourceFunding = 366_924n;
const rowFunding = 12_000n;
const contractFunding = 1_000_000n;
const nativeTokenFunding = 1_000_000n;
const creationFee = 25n;
const replayCacheCost = 7n;

describe.sequential("standard token factory on a clean local node", () => {
  let node: LocalNode;

  beforeAll(async () => {
    node = await startLocalNode();
  }, 60_000);

  afterAll(async () => {
    await node?.stop();
  }, 15_000);

  it("operates generated bindings, events, fees, and atomic reserve top-ups", async () => {
    const [creator, spender] = node.accounts;
    if (!creator || !spender) throw new Error("Local node did not provide two accounts");

    const factoryContract = await loadContract("standard_token_factory.rv32a");
    const tokenContract = await loadContract("standard_token.rv32a");
    const testWalletContract = await loadContract("token_factory_test_wallet.rv32a");
    const tokenHash = hashContract(tokenContract);

    const factory = await deployFactory(creator, byteHash(0x70), factoryContract, {
      token_code_hash: fixedBytes(tokenHash, 32),
      required_token_funding: requiredTokenFunding,
      native_token: HOG_ADDRESS,
      creation_fee: 0n,
      fee_recipient: null,
    });

    const tokenNonce = fixedBytes(byteHash(0x71), 32);
    const predicted = await predictToken(factory, creator, tokenNonce);
    await call(creator, [hogTransfer(predicted, tokenSourceFunding)]);

    // The first creation attaches the token's code; later ones deploy by hash.
    const createCall = StandardTokenFactory.v0_1.createToken.call({
      contract: factory,
      gasLimit: childGas,
      args: {
        nonce: tokenNonce,
        administrator: creator.address,
        name: "Phase Seven Token",
        symbol: "P7",
        decimals: 7n,
        initialHolder: creator.address,
        initialSupply: 1_000n,
      },
    });
    const creation = await call(creator, [createCall], [tokenContract]);
    const created = creation.values[0] as ContractAddress;
    expectAddress(created, predicted);

    const createdEvent = TokenCreated.singleFromReceipt(creation.receipt, {
      contractAddress: factory,
    });
    expectAddress(createdEvent.topics.token, created);
    expectAddress(createdEvent.topics.creator, creator.address);
    expectAddress(createdEvent.fields.administrator, creator.address);
    expectAddress(createdEvent.fields.initial_holder, creator.address);
    expect(createdEvent.fields.initial_supply).toBe(1_000n);
    expect(createdEvent.fields.name).toBe("Phase Seven Token");
    expect(createdEvent.fields.symbol).toBe("P7");
    expect(createdEvent.fields.decimals).toBe(7n);
    expect(bytesEqual(createdEvent.fields.token_code_hash, tokenHash)).toBe(true);
    expect(MintEvent.singleFromReceipt(creation.receipt, { contractAddress: created }).fields.amount).toBe(1_000n);

    const indexed = await indexedCreation(factory, creation.receipt);
    expect(indexed.sequenceNumber).toBe(1);
    expect(bytesEqual(indexed.event.contractAddress, creation.receipt.events[1]!.contractAddress)).toBe(true);
    expect(indexed.event.topics).toEqual(creation.receipt.events[1]!.topics);
    expect(indexed.event.data).toEqual(creation.receipt.events[1]!.data);
    expect(TokenCreated.decode(indexed.event)).toEqual({
      name: createdEvent.name,
      topics: createdEvent.topics,
      fields: createdEvent.fields,
    });

    expect((await ERC20Metadata.v0_1.name.view({ client: node.client, contract: created, caller: creator.address })).value).toBe("Phase Seven Token");
    expect((await ERC20Metadata.v0_1.symbol.view({ client: node.client, contract: created, caller: creator.address })).value).toBe("P7");
    expect((await ERC20Metadata.v0_1.decimals.view({ client: node.client, contract: created, caller: creator.address })).value).toBe(7n);
    await expectBalances(created, creator.address, 1_000n, 1_000n);

    const mint = await call(creator, [ERC20.v0_1.mint.call({
      contract: created,
      gasLimit: childGas,
      args: { receiver: creator.address, amount: 100n },
    })]);
    expect(MintEvent.singleFromReceipt(mint.receipt, { contractAddress: created }).fields.amount).toBe(100n);
    await expectBalances(created, creator.address, 1_100n, 1_100n);

    await call(creator, [hogTransfer(created, rowFunding)]);
    const transfer = await call(creator, [ERC20.v0_1.transfer.call({
      contract: created,
      gasLimit: childGas,
      args: { receiver: spender.address, amount: 200n },
    })]);
    expect(TransferEvent.singleFromReceipt(transfer.receipt, { contractAddress: created }).fields.amount).toBe(200n);
    expect(await balanceOf(created, creator.address)).toBe(900n);
    expect(await balanceOf(created, spender.address)).toBe(200n);

    await call(creator, [hogTransfer(created, rowFunding)]);
    const approval = await call(creator, [ERC20.v0_1.adjustAllowance.call({
      contract: created,
      gasLimit: childGas,
      args: { spender: spender.address, difference: 150n },
    })]);
    expect(AllowanceChangeEvent.singleFromReceipt(approval.receipt, { contractAddress: created }).fields.difference).toBe(150n);
    expect(await allowance(created, creator.address, spender.address)).toBe(150n);

    await call(spender, [ERC20.v0_1.transferFrom.call({
      contract: created,
      gasLimit: childGas,
      args: { owner: creator.address, receiver: spender.address, amount: 75n },
    })]);
    expect(await allowance(created, creator.address, spender.address)).toBe(75n);
    expect(await balanceOf(created, creator.address)).toBe(825n);
    expect(await balanceOf(created, spender.address)).toBe(275n);

    // The administrator destroys tokens from any holder, no allowance needed.
    const clawback = await call(creator, [ERC20Clawback.v0_1.clawback.call({
      contract: created,
      gasLimit: childGas,
      args: { from: spender.address, amount: 25n },
    })]);
    expect(BurnEvent.singleFromReceipt(clawback.receipt, { contractAddress: created }).fields.amount).toBe(25n);
    expect(await balanceOf(created, creator.address)).toBe(825n);
    expect(await balanceOf(created, spender.address)).toBe(250n);
    expect((await ERC20.v0_1.totalSupply.view({ client: node.client, contract: created, caller: creator.address })).value).toBe(1_075n);

    const testWallet = await deploy(creator, byteHash(0x74), testWalletContract, {
      gasLimit: walletGas,
      amount: contractFunding,
    });
    const topUpNonce = fixedBytes(byteHash(0x75), 32);
    const topUpToken = await predictToken(factory, creator, topUpNonce);
    await call(creator, [hogTransfer(topUpToken, tokenSourceFunding)]);
    const topUpCreation = await call(creator, [StandardTokenFactory.v0_1.createToken.call({
      contract: factory,
      gasLimit: childGas,
      args: {
        nonce: topUpNonce,
        administrator: creator.address,
        name: "Top-up Test Token",
        symbol: "TOP",
        decimals: 7n,
        initialHolder: testWallet,
        initialSupply: 10n,
      },
    })]);
    expectAddress(topUpCreation.values[0] as ContractAddress, topUpToken);

    const unseen = contractAddress(new Uint8Array(32).fill(0x44));
    await call(creator, [TokenFactoryTestWallet.v0_1.topUpAndTransfer.call({
      contract: testWallet,
      gasLimit: childGas,
      args: {
        nativeToken: HOG_ADDRESS,
        token: topUpToken,
        receiver: unseen,
        hogAmount: rowFunding,
        tokenAmount: 1n,
      },
    })]);
    expect(await balanceOf(topUpToken, unseen)).toBe(1n);
    expect(await balanceOf(topUpToken, testWallet)).toBe(9n);
    const tokenReserveAfterTopUp = (await node.client.getBalance(topUpToken)).rawBalance;
    expect(tokenReserveAfterTopUp).toBe(950n);

    const rollbackReceiver = contractAddress(new Uint8Array(32).fill(0x45));
    const walletHogBeforeRollback = (await node.client.getBalance(testWallet)).rawBalance;
    const failed = await call(creator, [TokenFactoryTestWallet.v0_1.topUpAndTransfer.call({
      contract: testWallet,
      gasLimit: childGas,
      args: {
        nativeToken: HOG_ADDRESS,
        token: topUpToken,
        receiver: rollbackReceiver,
        hogAmount: rowFunding,
        tokenAmount: 10_000n,
      },
    })], [], false);
    expect(failed.receipt.execResult).toBe(ExecResult.ExecResultTxRootFrameReverted);
    expect((await node.client.getBalance(topUpToken)).rawBalance).toBe(tokenReserveAfterTopUp);
    expect((await node.client.getBalance(testWallet)).rawBalance).toBe(walletHogBeforeRollback);
    expect(await balanceOf(topUpToken, rollbackReceiver)).toBe(0n);

    const feeFactory = await deployFactory(creator, byteHash(0x72), factoryContract, {
      token_code_hash: fixedBytes(tokenHash, 32),
      required_token_funding: requiredTokenFunding,
      native_token: HOG_ADDRESS,
      creation_fee: creationFee,
      fee_recipient: spender.address,
    });
    const feeNonce = fixedBytes(byteHash(0x73), 32);
    const feeToken = await predictToken(feeFactory, creator, feeNonce);
    await call(creator, [hogTransfer(feeToken, tokenSourceFunding)]);
    // A new allowance on the native token needs the native token's own reserve.
    const nativeTokenAirdrop = await node.client.requestAirdrop({ recipient: HOG_ADDRESS });
    expect(nativeTokenAirdrop.status.result).toBe("ok");
    expect(nativeTokenAirdrop.rawAmount).toBeGreaterThanOrEqual(nativeTokenFunding);
    await call(creator, [ERC20.v0_1.adjustAllowance.call({
      contract: HOG_ADDRESS,
      gasLimit: childGas,
      args: { spender: feeFactory, difference: creationFee },
    })]);
    const treasuryBefore = (await node.client.getBalance(spender.address)).rawBalance;
    const creatorHogBeforeFee = (await node.client.getBalance(creator.address)).rawBalance;
    const feeCreation = await call(creator, [StandardTokenFactory.v0_1.createToken.call({
      contract: feeFactory,
      gasLimit: childGas,
      args: {
        nonce: feeNonce,
        administrator: creator.address,
        name: null,
        symbol: null,
        decimals: null,
        initialHolder: creator.address,
        initialSupply: 1n,
      },
    })]);
    expectAddress(feeCreation.values[0] as ContractAddress, feeToken);
    expect(TokenCreated.allFromReceipt(feeCreation.receipt, { contractAddress: feeFactory })).toHaveLength(1);
    expect(TransferEvent.allFromReceipt(feeCreation.receipt, { contractAddress: HOG_ADDRESS })).toHaveLength(1);
    expect(TransferEvent.singleFromReceipt(feeCreation.receipt, { contractAddress: HOG_ADDRESS }).fields.amount).toBe(creationFee);
    expect(MintEvent.singleFromReceipt(feeCreation.receipt, { contractAddress: feeToken }).fields.amount).toBe(1n);
    expect(feeCreation.receipt.events).toHaveLength(3);
    expectAddress(feeCreation.receipt.events[0]!.contractAddress, HOG_ADDRESS);
    expectAddress(feeCreation.receipt.events[1]!.contractAddress, feeToken);
    expectAddress(feeCreation.receipt.events[2]!.contractAddress, feeFactory);
    expect((await node.client.getBalance(spender.address)).rawBalance).toBe(treasuryBefore + creationFee);
    expect((await node.client.getBalance(creator.address)).rawBalance).toBe(creatorHogBeforeFee - creationFee - replayCacheCost);
    expect(await allowance(HOG_ADDRESS, creator.address, feeFactory)).toBe(0n);

    console.log(JSON.stringify({
      runtime: node.manifest.producer,
      protocol: node.manifest.protocol,
      factory: toHex0x(factory),
      token: toHex0x(created),
      creationTx: toHex0x(creation.receipt.txHash),
      creationHeight: creation.receipt.height.toString(),
      feeCreationTx: toHex0x(feeCreation.receipt.txHash),
      indexedSequence: indexed.sequenceNumber,
    }));
  }, 120_000);

  // Funding, deployment and initialization commit atomically, so nobody can
  // initialize the factory between its deployment and its configuration.
  async function deployFactory(
    owner: LocalAccount,
    nonce: SHA256Hash,
    contract: Contract,
    config: FactoryConfig,
  ) {
    const address = await deploy(owner, nonce, contract, {
      gasLimit: walletGas,
      amount: contractFunding,
      initializer: StandardTokenFactory.v0_1.initialize.invocation(
        prepareContractDeployment({ deployer: owner.address, contract, deploymentNonce: nonce }).address,
        childGas,
        { config },
      ),
    });
    expect((await StandardTokenFactory.v0_1.config.view({ client: node.client, contract: address, caller: owner.address })).value).toEqual(config);
    return address;
  }

  async function deploy(
    owner: LocalAccount,
    nonce: SHA256Hash,
    contract: Contract,
    options: { gasLimit: typeof walletGas; amount: bigint; initializer?: Invocation },
  ) {
    const deployment = prepareContractDeployment({
      deployer: owner.address,
      contract,
      deploymentNonce: nonce,
    });
    const { receipt, address } = await owner.wallet.deployContractAndWait(
      deployment,
      options,
      { timeoutMs: 30_000 },
    );
    expect(receipt.execResult).toBe(ExecResult.ExecResultOK);
    expectAddress(address, deployment.address);
    return address;
  }

  async function call(
    account: LocalAccount,
    calls: readonly ContractCall[],
    contracts: Contract[] = [],
    requireSuccess = true,
  ): Promise<{ receipt: TransactionReceipt; values: readonly unknown[] }> {
    try {
      const result = await account.wallet.executeCallsAndWait(
        { calls, gasLimit: walletGas, contractsToDeploy: contracts },
        { timeoutMs: 30_000 },
      );
      return { receipt: result.receipt, values: result.values };
    } catch (error) {
      if (!requireSuccess && error instanceof TransactionExecutionError) {
        return { receipt: error.receipt, values: [] };
      }
      if (error instanceof TransactionExecutionError) {
        const { receipt } = error;
        throw new Error(
          `Wallet call failed with ${ExecResult[receipt.execResult]}, abort=${receipt.abortData ? toHex0x(receipt.abortData) : "none"}`,
        );
      }
      throw error;
    }
  }

  function hogTransfer(receiver: ContractAddress, amount: bigint) {
    return ERC20.v0_1.transfer.call({
      contract: HOG_ADDRESS,
      gasLimit: childGas,
      args: { receiver, amount },
    });
  }

  async function predictToken(
    factory: ContractAddress,
    creator: LocalAccount,
    nonce: ReturnType<typeof fixedBytes<32>>,
  ) {
    return (
      await StandardTokenFactory.v0_1.predictToken.view({
        client: node.client,
        contract: factory,
        caller: creator.address,
        args: { creator: creator.address, nonce },
      })
    ).value;
  }

  async function balanceOf(token: ContractAddress, addr: ContractAddress) {
    return (await ERC20.v0_1.getBalanceOf.view({ client: node.client, contract: token, caller: addr, args: { addr } })).value;
  }

  async function allowance(token: ContractAddress, owner: ContractAddress, spender: ContractAddress) {
    return (await ERC20.v0_1.allowance.view({ client: node.client, contract: token, caller: owner, args: { owner, spender } })).value;
  }

  async function indexedCreation(factory: ContractAddress, receipt: TransactionReceipt) {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const page = await node.client.getEvents({
        filters: [TokenCreated.filter({ contractAddresses: [factory] })],
        order: "ascending",
        anchor: { height: receipt.height },
        limit: 10,
      });
      if (page.latestBlock >= receipt.height) {
        expect(page.events).toHaveLength(1);
        return page.events[0]!;
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
    }
    throw new Error(`Event index did not reach block ${receipt.height}`);
  }

  async function expectBalances(
    token: ContractAddress,
    holder: ContractAddress,
    holderBalance: bigint,
    supply: bigint,
  ) {
    expect(await balanceOf(token, holder)).toBe(holderBalance);
    expect((await ERC20.v0_1.totalSupply.view({ client: node.client, contract: token, caller: holder })).value).toBe(supply);
  }
});

function byteHash(value: number): SHA256Hash {
  return sha256Hash(new Uint8Array(32).fill(value));
}

async function loadContract(filename: string): Promise<Contract> {
  const repository = resolve(import.meta.dirname, "../../..");
  const root = resolve(
    process.env["GROUNDHOG_ARTIFACT_ROOT"] ??
      resolve(repository, "target/groundhog"),
  );
  return {
    contract_type: ContractType.kRv32,
    rv32_contract: { data: await readFile(resolve(root, filename)) },
  };
}

function expectAddress(actual: Uint8Array, expected: Uint8Array): void {
  expect(toHex0x(actual)).toBe(toHex0x(expected));
}
