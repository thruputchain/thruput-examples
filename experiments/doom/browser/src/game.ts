import {
  PrivateKeySigner, createPubkeyAccount, createGroundhogClient, createWalletClient,
  createInvocation, addressFromHex, fromHex0x, toHex0x, hashSignedTransaction,
  hashFromHex, type ExecutableWalletClient, type GroundhogClient, type PubkeyAccount,
} from '@groundhogchain/client';
import { calldata, contractEntrypointID, gasAmount, networkHash, sha256Hash, ExecResult } from '@groundhogchain/protocol';
import { WebSocketTransport } from './transport.ts';

export interface DemoConfig {
  rpcUrl: string;
  contract: string;
  networkHash: string;
  artifactSha256: string;
  wadSha256: string;
}
export interface PendingTransaction { hash: string; method: number }
export interface TransactionSample {
  method: number; txHash: string; height: string; transactionMs: number;
  prepareMs: number; signMs: number; submitMs: number; receiptMs: number;
}
export interface Frame { tick: number; height: bigint; pixels: Uint8Array }
type StorageRead = {blockHeight: string | number; item: null | {kind: string; bytes?: string}};
const PAGE = 32768;
export const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** Public deterministic dev-1 key, used only on this disposable local node. */
export function demoAccount(): PubkeyAccount {
  return createPubkeyAccount({signer: new PrivateKeySigner(fromHex0x(
    '0xc3da17e061d562773d10e87e67b6fd65b281fac2ec5b15cc20f97e8d0b58e5c3'))});
}

export function storageKey(domain: number, index: number): Uint8Array {
  const key = new Uint8Array(32);
  key.set(new TextEncoder().encode('groundhog-doom-v'));
  const view = new DataView(key.buffer);
  view.setUint32(16, domain, true);
  view.setUint32(20, index, true);
  return key;
}

function words(...values: number[]): Uint8Array {
  const bytes = new Uint8Array(values.length * 4);
  values.forEach((value, index) => new DataView(bytes.buffer).setUint32(index * 4, value, true));
  return bytes;
}
function join(a: Uint8Array, b: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(a.length + b.length); bytes.set(a); bytes.set(b, a.length); return bytes;
}
function uint32(bytes: Uint8Array, offset = 0): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);
}
function equal(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

export class DoomGame {
  readonly samples: TransactionSample[] = [];
  pending: PendingTransaction | null = null;
  private busy = false;
  readonly config: DemoConfig;
  readonly transport: WebSocketTransport;
  readonly wallet: ExecutableWalletClient<GroundhogClient, PubkeyAccount>;
  private savePending: (pending: PendingTransaction | null) => void;
  private constructor(
    config: DemoConfig,
    transport: WebSocketTransport,
    wallet: ExecutableWalletClient<GroundhogClient, PubkeyAccount>,
    savePending: (pending: PendingTransaction | null) => void,
  ) {
    this.config = config;
    this.transport = transport;
    this.wallet = wallet;
    this.savePending = savePending;
  }

  static async connect(config: DemoConfig, savePending = (_pending: PendingTransaction | null) => {}): Promise<DoomGame> {
    const transport = await WebSocketTransport.connect(config.rpcUrl);
    try {
      const client = await createGroundhogClient({transport});
      const expected = networkHash(sha256Hash(fromHex0x('0x' + config.networkHash.replace(/^0x/, ''))));
      const actual = await client.getNetworkInfo();
      if (!equal(actual.networkHash, expected)) throw new Error('Node network identity differs from the demo configuration');
      const wallet = createWalletClient({client, account: demoAccount(), networkHash: expected});
      return new DoomGame(config, transport, wallet, savePending);
    } catch (error) { transport.close(); throw error; }
  }

  async storageBatch(keys: [number, number][]): Promise<{height: bigint; bytes: Uint8Array | null}[]> {
    const replies = await this.transport.batch(keys.map(([domain, index]) => ({
      method: 'groundhog_getStorageAt', params: [this.config.contract, toHex0x(storageKey(domain, index))],
    })));
    return replies.map(reply => {
      const read = reply as StorageRead;
      if (!read || read.blockHeight === undefined || read.item === undefined) throw new Error('Invalid storage response');
      if (read.item !== null && (read.item.kind !== 'bytestring' || typeof read.item.bytes !== 'string')) {
        throw new Error('Unexpected Doom storage item');
      }
      return {height: BigInt(read.blockHeight), bytes: read.item === null ? null : fromHex0x(read.item.bytes!)};
    });
  }
  async storage(domain: number, index: number): Promise<Uint8Array | null> {
    return (await this.storageBatch([[domain, index]]))[0].bytes;
  }

  async recover(pending: PendingTransaction): Promise<void> {
    this.pending = pending;
    await this.receipt(pending);
  }
  private async receipt(pending: PendingTransaction) {
    // The SDK returns committed execution failures as receipts; do not retry a call.
    const receipt = await this.wallet.waitForTransactionReceipt(hashFromHex(pending.hash), {
      timeoutMs: 60_000, pollingIntervalMs: 2,
    });
    this.pending = null;
    this.savePending(null);
    if (receipt.execResult !== ExecResult.ExecResultOK) {
      throw new Error(`Contract call ${pending.method} failed: ${pending.hash} (result ${receipt.execResult})`);
    }
    return receipt;
  }

  async call(method: number, data: Uint8Array = new Uint8Array(), gas = 50_000_000n): Promise<TransactionSample> {
    if (this.busy || this.pending) throw new Error('A transaction is already pending; wait for its receipt before continuing');
    this.busy = true;
    const start = performance.now();
    try {
      const entrypoint = new Uint8Array(8);
      new DataView(entrypoint.buffer).setBigUint64(0, BigInt(method));
      const transaction = await this.wallet.prepareExecution({
        invocation: createInvocation({invoked_address: addressFromHex(this.config.contract),
          entrypoint: contractEntrypointID(entrypoint), gas_limit: gasAmount(gas), calldata: calldata(data)}),
        gasLimit: gasAmount(gas), expiryBlocks: 1000n,
      });
      const prepared = performance.now();
      const signed = await this.wallet.signTransaction(transaction);
      const signedAt = performance.now();
      const hash = toHex0x(hashSignedTransaction(signed));
      this.pending = {hash, method};
      // Save before submission so a reload can observe an uncertain outcome.
      this.savePending(this.pending);
      const submittedHash = toHex0x(await this.wallet.sendTransaction(signed));
      if (submittedHash !== hash) throw new Error('Node returned a different transaction hash');
      const submitted = performance.now();
      const receipt = await this.receipt(this.pending);
      const done = performance.now();
      const sample = {method, txHash: hash, height: receipt.height.toString(),
        transactionMs: done - start, prepareMs: prepared - start, signMs: signedAt - prepared,
        submitMs: submitted - signedAt, receiptMs: done - submitted};
      this.samples.push(sample);
      return sample;
    } finally { this.busy = false; }
  }

  async initialize(wad: Uint8Array, progress: (message: string) => void): Promise<void> {
    const digest = toHex0x(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(wad)))).slice(2);
    if (digest !== this.config.wadSha256) throw new Error('WAD checksum does not match the deployed demo');
    const meta = await this.storage(0, 0);
    if (meta) {
      if (meta.length !== 80 || uint32(meta) !== 2 || uint32(meta, 12) !== wad.length) throw new Error('Incompatible saved Doom state');
      return;
    }
    const [uploaded, fragments] = await this.storageBatch([[0, 1], [0, 2]]);
    if (fragments.bytes) throw new Error('This contract has an old fragment upload; use a fresh demo data directory');
    const pages = Math.ceil(wad.length / PAGE);
    const count = uploaded.bytes ? uint32(uploaded.bytes) : 0;
    if (uploaded.bytes && (uploaded.bytes.length !== 8 || uint32(uploaded.bytes, 4) !== wad.length || count > pages)) {
      throw new Error('Existing upload does not match this WAD');
    }
    for (let index = 0; index < count; index++) {
      if (!equal((await this.storage(1, index)) ?? new Uint8Array(), wad.subarray(index * PAGE, (index + 1) * PAGE))) {
        throw new Error('An uploaded WAD page differs');
      }
    }
    for (let index = count; index < pages; index++) {
      progress(`Uploading WAD ${index + 1}/${pages}`);
      await this.call(0, join(words(index, wad.length), wad.subarray(index * PAGE, (index + 1) * PAGE)));
    }
    progress('Initializing E1M1…');
    await this.call(1, new Uint8Array(), 200_000_000n);
  }

  async frame(minimumTick = 0): Promise<Frame> {
    const deadline = performance.now() + 2000;
    let failure: unknown = new Error('No consistent committed frame available');
    do {
      try {
        const [meta, first, second] = await this.storageBatch([[0, 0], [3, 0], [3, 1]]);
        if (meta.height === first.height && meta.height === second.height) {
          if (!meta.bytes || meta.bytes.length !== 80 || uint32(meta.bytes) !== 2 || !first.bytes || !second.bytes) throw new Error('Doom is not initialized');
          const pixels = join(first.bytes, second.bytes);
          if (pixels.length !== 64768) throw new Error('Invalid committed frame size');
          const tick = uint32(meta.bytes, 4);
          if (tick >= minimumTick) return {tick, height: meta.height, pixels};
        }
      } catch (error) { failure = error; }
      await delay(5);
    } while (performance.now() < deadline);
    throw failure;
  }

  async step(tick: number, keys: Uint8Array): Promise<Frame> {
    if (!Number.isInteger(tick) || tick < 0 || tick >= 0xffffffff || keys.length !== 32) throw new Error('Invalid Doom input');
    await this.call(2, join(words(tick), keys));
    return this.frame(tick + 1);
  }
  close(): void { this.transport.close(); }
}
