import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  bytesEqual,
  deriveContractAddress,
  fixedBytes,
  hashContract,
  toHex0x,
  type TransactionReceipt,
} from "@groundhogchain/client";
import {
  contractAddress,
  ContractType,
  ExecResult,
  gasAmount,
  HOG_ADDRESS,
  sha256Hash,
  type Contract,
  type Invocation,
  type SHA256Hash,
} from "@groundhogchain/protocol";
import { DevWallet } from "@groundhogchain/client/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  StandardTokenFactory,
  TokenCreated,
  type FactoryConfig,
} from "../generated/standard-token-factory.js";
import {
  ApprovalEvent,
  ERC20,
  ERC20Metadata,
  TransferEvent,
} from "../generated/standard-token.js";
import { TokenFactoryTestWallet } from "../generated/token-factory-test-wallet.js";
import { startLocalNode, type LocalAccount, type LocalNode } from "./local-node.js";

const childGas = gasAmount(10_000_000n);
const walletGas = gasAmount(100_000_000n);
const requiredTokenFunding = 350_770n;
const tokenSourceFunding = 352_004n;
const rowFunding = 12_000n;
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
    const factoryHash = hashContract(factoryContract);
    const tokenHash = hashContract(tokenContract);
    const testWalletHash = hashContract(testWalletContract);
    expect(toHex0x(tokenHash)).toBe(
      "0x798560d804b9c2461f3c12aa542bd54c8ca683997bb6bea0b8627ab51094f69f",
    );
    await deployContract(creator, byteHash(0x69), tokenHash, [tokenContract]);

    const factory = await deployFactory(
      creator,
      byteHash(0x70),
      factoryHash,
      [factoryContract],
      {
        token_code_hash: fixedBytes(tokenHash, 32),
        required_token_funding: requiredTokenFunding,
        native_token: HOG_ADDRESS,
        creation_fee: 0n,
        fee_recipient: null,
      },
    );

    const tokenNonce = fixedBytes(byteHash(0x71), 32);
    const predicted = (
      await StandardTokenFactory.predictToken.view({
        client: node.client,
        contract: factory,
        caller: creator.address,
        args: { creator: creator.address, nonce: tokenNonce },
      })
    ).value;
    await call(creator, [ERC20.transfer.invocation(HOG_ADDRESS, childGas, {
      receiver: predicted,
      amount: tokenSourceFunding,
    })]);

    const creation = await call(creator, [
      StandardTokenFactory.createToken.invocation(factory, childGas, {
        nonce: tokenNonce,
        administrator: creator.address,
        name: "Phase Seven Token",
        symbol: "P7",
        decimals: 7n,
        initialHolder: creator.address,
        initialSupply: 1_000n,
      }),
    ]);
    const created = StandardTokenFactory.createToken.decodeReturn(creation.returns[0]!);
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

    expect((await ERC20Metadata.name.view({ client: node.client, contract: created, caller: creator.address })).value).toBe("Phase Seven Token");
    expect((await ERC20Metadata.symbol.view({ client: node.client, contract: created, caller: creator.address })).value).toBe("P7");
    expect((await ERC20Metadata.decimals.view({ client: node.client, contract: created, caller: creator.address })).value).toBe(7n);
    await expectBalances(created, creator.address, 1_000n, 1_000n);

    const mint = await call(creator, [ERC20.mint.invocation(created, childGas, {
      receiver: creator.address,
      amount: 100n,
    })]);
    expect(TransferEvent.singleFromReceipt(mint.receipt, { contractAddress: created }).fields.amount).toBe(100n);
    await expectBalances(created, creator.address, 1_100n, 1_100n);

    await call(creator, [ERC20.transfer.invocation(HOG_ADDRESS, childGas, { receiver: created, amount: rowFunding })]);
    const transfer = await call(creator, [ERC20.transfer.invocation(created, childGas, {
      receiver: spender.address,
      amount: 200n,
    })]);
    expect(TransferEvent.singleFromReceipt(transfer.receipt, { contractAddress: created }).fields.amount).toBe(200n);
    expect((await ERC20.getBalanceOf.view({ client: node.client, contract: created, caller: creator.address, args: { addr: creator.address } })).value).toBe(900n);
    expect((await ERC20.getBalanceOf.view({ client: node.client, contract: created, caller: creator.address, args: { addr: spender.address } })).value).toBe(200n);

    await call(creator, [ERC20.transfer.invocation(HOG_ADDRESS, childGas, { receiver: created, amount: rowFunding })]);
    const approval = await call(creator, [ERC20.adjustAllowance.invocation(created, childGas, {
      spender: spender.address,
      diff: 150n,
    })]);
    expect(ApprovalEvent.singleFromReceipt(approval.receipt, { contractAddress: created }).fields.difference).toBe(150n);
    expect((await ERC20.allowance.view({ client: node.client, contract: created, caller: creator.address, args: { owner: creator.address, spender: spender.address } })).value).toBe(150n);

    await call(spender, [ERC20.transferFrom.invocation(created, childGas, {
      owner: creator.address,
      receiver: spender.address,
      amount: 75n,
    })]);
    expect((await ERC20.allowance.view({ client: node.client, contract: created, caller: creator.address, args: { owner: creator.address, spender: spender.address } })).value).toBe(75n);
    expect((await ERC20.getBalanceOf.view({ client: node.client, contract: created, caller: creator.address, args: { addr: creator.address } })).value).toBe(825n);
    expect((await ERC20.getBalanceOf.view({ client: node.client, contract: created, caller: creator.address, args: { addr: spender.address } })).value).toBe(275n);

    const burn = await call(creator, [ERC20.burn.invocation(created, childGas, {
      owner: spender.address,
      amount: 25n,
    })]);
    expect(TransferEvent.singleFromReceipt(burn.receipt, { contractAddress: created }).fields.amount).toBe(25n);
    expect((await ERC20.getBalanceOf.view({ client: node.client, contract: created, caller: creator.address, args: { addr: creator.address } })).value).toBe(825n);
    expect((await ERC20.getBalanceOf.view({ client: node.client, contract: created, caller: creator.address, args: { addr: spender.address } })).value).toBe(250n);
    expect((await ERC20.totalSupply.view({ client: node.client, contract: created, caller: creator.address })).value).toBe(1_075n);

    const testWallet = await deployContract(
      creator,
      byteHash(0x74),
      testWalletHash,
      [testWalletContract],
    );
    const topUpNonce = fixedBytes(byteHash(0x75), 32);
    const topUpToken = (await StandardTokenFactory.predictToken.view({
      client: node.client,
      contract: factory,
      caller: creator.address,
      args: { creator: creator.address, nonce: topUpNonce },
    })).value;
    await call(creator, [ERC20.transfer.invocation(HOG_ADDRESS, childGas, {
      receiver: topUpToken,
      amount: tokenSourceFunding,
    })]);
    const topUpCreation = await call(creator, [StandardTokenFactory.createToken.invocation(factory, childGas, {
      nonce: topUpNonce,
      administrator: creator.address,
      name: "Top-up Test Token",
      symbol: "TOP",
      decimals: 7n,
      initialHolder: testWallet,
      initialSupply: 10n,
    })]);
    expectAddress(StandardTokenFactory.createToken.decodeReturn(topUpCreation.returns[0]!), topUpToken);

    const unseen = contractAddress(new Uint8Array(32).fill(0x44));
    await call(creator, [TokenFactoryTestWallet.topUpAndTransfer.invocation(testWallet, childGas, {
      nativeToken: HOG_ADDRESS,
      token: topUpToken,
      receiver: unseen,
      hogAmount: rowFunding,
      tokenAmount: 1n,
    })]);
    expect((await ERC20.getBalanceOf.view({ client: node.client, contract: topUpToken, caller: creator.address, args: { addr: unseen } })).value).toBe(1n);
    expect((await ERC20.getBalanceOf.view({ client: node.client, contract: topUpToken, caller: creator.address, args: { addr: testWallet } })).value).toBe(9n);
    const tokenReserveAfterTopUp = (await node.client.getBalance(topUpToken)).rawBalance;
    expect(tokenReserveAfterTopUp).toBe(54_870n);

    const rollbackReceiver = contractAddress(new Uint8Array(32).fill(0x45));
    const walletHogBeforeRollback = (await node.client.getBalance(testWallet)).rawBalance;
    const failed = await call(creator, [TokenFactoryTestWallet.topUpAndTransfer.invocation(testWallet, childGas, {
      nativeToken: HOG_ADDRESS,
      token: topUpToken,
      receiver: rollbackReceiver,
      hogAmount: rowFunding,
      tokenAmount: 10_000n,
    })], [], false);
    expect(failed.receipt.execResult).toBe(ExecResult.ExecResultTxRootFrameReverted);
    expect((await node.client.getBalance(topUpToken)).rawBalance).toBe(tokenReserveAfterTopUp);
    expect((await node.client.getBalance(testWallet)).rawBalance).toBe(walletHogBeforeRollback);
    expect((await ERC20.getBalanceOf.view({ client: node.client, contract: topUpToken, caller: creator.address, args: { addr: rollbackReceiver } })).value).toBe(0n);

    const feeFactory = await deployFactory(
      creator,
      byteHash(0x72),
      factoryHash,
      [],
      {
        token_code_hash: fixedBytes(tokenHash, 32),
        required_token_funding: requiredTokenFunding,
        native_token: HOG_ADDRESS,
        creation_fee: creationFee,
        fee_recipient: spender.address,
      },
    );
    const feeNonce = fixedBytes(byteHash(0x73), 32);
    const feeToken = (await StandardTokenFactory.predictToken.view({
      client: node.client,
      contract: feeFactory,
      caller: creator.address,
      args: { creator: creator.address, nonce: feeNonce },
    })).value;
    await call(creator, [ERC20.transfer.invocation(HOG_ADDRESS, childGas, { receiver: feeToken, amount: tokenSourceFunding })]);
    await call(creator, [ERC20.transfer.invocation(HOG_ADDRESS, childGas, { receiver: HOG_ADDRESS, amount: nativeTokenFunding })]);
    await call(creator, [ERC20.adjustAllowance.invocation(HOG_ADDRESS, childGas, { spender: feeFactory, diff: creationFee })]);
    const treasuryBefore = (await node.client.getBalance(spender.address)).rawBalance;
    const creatorHogBeforeFee = (await node.client.getBalance(creator.address)).rawBalance;
    const feeCreation = await call(creator, [StandardTokenFactory.createToken.invocation(feeFactory, childGas, {
      nonce: feeNonce,
      administrator: creator.address,
      name: null,
      symbol: null,
      decimals: null,
      initialHolder: creator.address,
      initialSupply: 1n,
    })]);
    expectAddress(StandardTokenFactory.createToken.decodeReturn(feeCreation.returns[0]!), feeToken);
    expect(TokenCreated.allFromReceipt(feeCreation.receipt, { contractAddress: feeFactory })).toHaveLength(1);
    expect(TransferEvent.allFromReceipt(feeCreation.receipt, { contractAddress: HOG_ADDRESS })).toHaveLength(1);
    expect(TransferEvent.singleFromReceipt(feeCreation.receipt, { contractAddress: HOG_ADDRESS }).fields.amount).toBe(creationFee);
    expect(TransferEvent.singleFromReceipt(feeCreation.receipt, { contractAddress: feeToken }).fields.amount).toBe(1n);
    expect(feeCreation.receipt.events).toHaveLength(3);
    expectAddress(feeCreation.receipt.events[0]!.contractAddress, HOG_ADDRESS);
    expectAddress(feeCreation.receipt.events[1]!.contractAddress, feeToken);
    expectAddress(feeCreation.receipt.events[2]!.contractAddress, feeFactory);
    expect((await node.client.getBalance(spender.address)).rawBalance).toBe(treasuryBefore + creationFee);
    expect((await node.client.getBalance(creator.address)).rawBalance).toBe(creatorHogBeforeFee - creationFee - replayCacheCost);
    expect((await ERC20.allowance.view({ client: node.client, contract: HOG_ADDRESS, caller: creator.address, args: { owner: creator.address, spender: feeFactory } })).value).toBe(0n);

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

  async function deployFactory(
    owner: LocalAccount,
    nonce: SHA256Hash,
    factoryHash: SHA256Hash,
    contracts: Contract[],
    config: FactoryConfig,
  ) {
    const address = await deployContract(owner, nonce, factoryHash, contracts);
    await call(owner, [StandardTokenFactory.initialize.invocation(address, childGas, { config })]);
    expect((await StandardTokenFactory.config.view({ client: node.client, contract: address, caller: owner.address })).value).toEqual(config);
    return address;
  }

  async function call(
    account: LocalAccount,
    invocations: Invocation[],
    contracts: Contract[] = [],
    requireSuccess = true,
  ) {
    if (invocations.length !== 1) {
      throw new Error("The pinned dev wallet accepts one child invocation");
    }
    const hash = await account.wallet.execute({
      invocation: invocations[0]!,
      gasLimit: walletGas,
      contractsToDeploy: contracts,
    });
    const receipt = await account.wallet.waitForTransactionReceipt(hash, {
      timeoutMs: 30_000,
    });
    if (requireSuccess && receipt.execResult !== ExecResult.ExecResultOK) {
      throw new Error(
        `Wallet call failed with ${ExecResult[receipt.execResult]}, abort=${receipt.abortData ? toHex0x(receipt.abortData) : "none"}`,
      );
    }
    const returns = receipt.returnData ? [receipt.returnData] : [];
    return { receipt, returns };
  }

  async function deployContract(
    owner: LocalAccount,
    nonce: SHA256Hash,
    contractHash: SHA256Hash,
    contracts: Contract[],
  ) {
    const address = deriveContractAddress(owner.address, nonce, contractHash);
    const hash = await owner.wallet.sendInvocation({
      invocation: DevWallet.deploy.invocation(
        owner.address,
        walletGas,
        {
          nonce: fixedBytes(nonce, 32),
          contractHash: fixedBytes(contractHash, 32),
        },
      ),
      contractsToDeploy: contracts,
    });
    const receipt = await owner.wallet.waitForTransactionReceipt(hash, {
      timeoutMs: 30_000,
    });
    expect(receipt.execResult).toBe(ExecResult.ExecResultOK);
    expect(receipt.returnData).not.toBeNull();
    expectAddress(contractAddress(receipt.returnData!), address);
    return address;
  }

  async function indexedCreation(factory: ReturnType<typeof contractAddress>, receipt: TransactionReceipt) {
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
    token: ReturnType<typeof contractAddress>,
    holder: ReturnType<typeof contractAddress>,
    holderBalance: bigint,
    supply: bigint,
  ) {
    expect((await ERC20.getBalanceOf.view({ client: node.client, contract: token, caller: holder, args: { addr: holder } })).value).toBe(holderBalance);
    expect((await ERC20.totalSupply.view({ client: node.client, contract: token, caller: holder })).value).toBe(supply);
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
