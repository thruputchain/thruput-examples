import { randomBytes } from "node:crypto";
import { open, readFile, stat } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import {
  addressFromHex,
  createPubkeyAccount,
  fixedBytes,
  fromHex0x,
  hashContract,
  PrivateKeySigner,
  toHex0x,
} from "@groundhogchain/client";
import { ERC20 } from "@groundhogchain/client/contracts";
import {
  codec,
  ContractType,
  gasAmount,
  HOG_ADDRESS,
  serialize,
  type Contract,
  type Invocation,
} from "@groundhogchain/protocol";
import { StandardTokenFactory } from "../../token-launchpad/src/contracts/generated/standard-token-factory.ts";
import { ERC20Metadata } from "../../token-launchpad/src/contracts/generated/standard-token.ts";
import {
  durableMkdir,
  executeStep,
  saveJson,
  type SeedJournal,
} from "../../../scripts/seed/seed-journal.ts";
import {
  canonicalAddress,
  type FaucetManifest,
  type FaucetToken,
} from "../src/domain.ts";
import { connectChain } from "../server/chain.ts";
import { acquireStateLock } from "../server/state-lock.ts";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const APP = fileURLToPath(new URL("..", import.meta.url));
const GAS = gasAmount(10_000_000n);
const SUPPLY = 1_000_000n * 1_000_000n;
const OPERATING_RESERVE = 1_000_000_000n;
const TOKEN_DETAILS = [
  { name: "Acorn", symbol: "ACORN" },
  { name: "Clover", symbol: "CLOVER" },
  { name: "Maple", symbol: "MAPLE" },
  { name: "Pebble", symbol: "PEBBLE" },
  { name: "Sprout", symbol: "SPROUT" },
] as const;

interface Deployment extends SeedJournal {
  scope: string;
  tokens: (FaucetToken & { nonce: string })[];
}

async function exists(path: string): Promise<boolean> {
  return stat(path)
    .then(() => true)
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    });
}

async function setup() {
  const directory = resolve(
    process.env.FAUCET_DEPLOY_DIR ?? join(APP, ".local/devnet"),
  );
  await durableMkdir(directory);
  const releaseLock = acquireStateLock(directory, "faucet setup process");
  try {
    const source = parseEnv(
      await readFile(
        resolve(
          process.env.LAUNCHPAD_APP_ENV ??
            join(ROOT, "apps/token-launchpad/.env.devnet"),
        ),
        "utf8",
      ),
    );
    const required = (key: string) => {
      const value = source[key];
      if (!value) throw new Error(`Missing ${key} in Launchpad environment.`);
      return value;
    };
    const rpc = new URL(
      process.env.GROUNDHOG_RPC_URL ?? required("VITE_GROUNDHOG_RPC_URL"),
    );
    if (
      rpc.protocol !== "https:" ||
      rpc.username ||
      rpc.password ||
      rpc.search ||
      rpc.hash
    ) {
      throw new Error(
        "Devnet setup requires an HTTPS RPC URL without credentials, query, or fragment.",
      );
    }
    const rpcUrl = rpc.href;
    const network = canonicalAddress(required("VITE_GROUNDHOG_NETWORK_ID"));
    const tokenFactory = addressFromHex(
      required("VITE_STANDARD_TOKEN_FACTORY_ADDRESS"),
    );
    const tokenHash = canonicalAddress(required("VITE_STANDARD_TOKEN_HASH"));
    const keyPath = join(directory, "signer.key");
    const statePath = join(directory, "deployment.json");
    if (!(await exists(keyPath))) {
      if (await exists(statePath))
        throw new Error(
          "Deployment key is missing; restore it before resuming.",
        );
      const file = await open(keyPath, "wx", 0o600);
      try {
        await file.writeFile(randomBytes(32));
        await file.sync();
      } finally {
        await file.close();
      }
    }
    const key = await readFile(keyPath);
    const account = createPubkeyAccount({
      signer: new PrivateKeySigner(new Uint8Array(key)),
    });
    key.fill(0);
    const chain = await connectChain(
      { network, rpcUrl, account: toHex0x(account.address) },
      keyPath,
    );
    const { client, wallet } = chain;
    const config = (
      await StandardTokenFactory.config.view({ client, contract: tokenFactory })
    ).value;
    if (
      toHex0x(config.token_code_hash) !== tokenHash ||
      config.creation_fee !== 0n ||
      toHex0x(config.native_token) !== toHex0x(HOG_ADDRESS)
    ) {
      throw new Error("Token factory configuration does not match this setup.");
    }
    const tokenScope = {
      network,
      tokenFactory: toHex0x(tokenFactory),
      tokenHash,
      account: toHex0x(account.address),
    };
    let state: Deployment;
    if (await exists(statePath)) {
      state = JSON.parse(await readFile(statePath, "utf8")) as Deployment;
      // Earlier journals also recorded pool infrastructure. Retain that history;
      // only the token identity determines whether this setup can resume.
      const savedScope = JSON.parse(state.scope) as Record<string, unknown>;
      if (
        Object.entries(tokenScope).some(
          ([key, value]) => savedScope[key] !== value,
        ) ||
        state.tokens.length !== 5
      ) {
        throw new Error(
          "Deployment scope changed. Restore the original configuration.",
        );
      }
    } else {
      const tokens: Deployment["tokens"] = [];
      for (const details of TOKEN_DETAILS) {
        const nonce = fixedBytes(randomBytes(32), 32);
        const address = (
          await StandardTokenFactory.predictToken.view({
            client,
            contract: tokenFactory,
            args: { creator: account.address, nonce },
          })
        ).value;
        tokens.push({
          ...details,
          address: toHex0x(address),
          nonce: toHex0x(nonce),
          decimals: 6,
        });
      }
      state = { scope: JSON.stringify(tokenScope), tokens, steps: {} };
      await saveJson(statePath, state);
    }
    const save = () => saveJson(statePath, state);
    const execute = async (
      name: string,
      invocation: Invocation,
      contractsToDeploy: Contract[] = [],
    ) => {
      console.log(name);
      await chain.verifyNetwork();
      return executeStep({
        name,
        intent: toHex0x(serialize(invocation, codec.Invocation)),
        journal: state,
        save,
        client,
        retryFailed: process.env.SEED_RETRY_FAILED === "1",
        prepare: async () => {
          if ((await wallet.getBalance()).rawBalance < OPERATING_RESERVE * 3n) {
            const result = await wallet.requestAirdrop();
            if (result.status.result !== "ok")
              throw new Error(
                "Devnet airdrop failed. Fund the deployment account and resume.",
              );
          }
          return wallet.signTransaction(
            await wallet.prepareExecution({
              invocation,
              gasLimit: GAS,
              contractsToDeploy,
              expiryBlocks: 1_000n,
            }),
          );
        },
      });
    };
    const artifact = JSON.parse(
      await readFile(
        join(
          ROOT,
          `apps/token-launchpad/public/contract-artifacts/${tokenHash}.json`,
        ),
        "utf8",
      ),
    );
    const tokenCode: Contract = {
      contract_type: ContractType.kRv32,
      rv32_contract: { data: fromHex0x(artifact.data) },
    };
    if (
      artifact.hash !== tokenHash ||
      toHex0x(hashContract(tokenCode)) !== tokenHash
    )
      throw new Error("Contract artifact hash mismatch.");
    for (const [index, token] of state.tokens.entries()) {
      const details = TOKEN_DETAILS[index]!;
      if (
        token.name !== details.name ||
        token.symbol !== details.symbol ||
        token.decimals !== 6
      )
        throw new Error("Saved token settings do not match this setup.");
      const address = addressFromHex(token.address);
      const nonce = fixedBytes(fromHex0x(token.nonce), 32);
      const predicted = (
        await StandardTokenFactory.predictToken.view({
          client,
          contract: tokenFactory,
          args: { creator: account.address, nonce },
        })
      ).value;
      if (toHex0x(predicted) !== token.address)
        throw new Error("Saved token address does not match its nonce.");
      await execute(
        `fund-${token.symbol}`,
        ERC20.transfer.invocation(HOG_ADDRESS, GAS, {
          receiver: address,
          amount: config.required_token_funding + OPERATING_RESERVE,
        }),
      );
      await execute(
        `create-${token.symbol}`,
        StandardTokenFactory.createToken.invocation(tokenFactory, GAS, {
          nonce,
          administrator: account.address,
          initialHolder: account.address,
          initialSupply: SUPPLY,
          name: token.name,
          symbol: token.symbol,
          decimals: BigInt(token.decimals),
        }),
        [tokenCode],
      );
      const options = { client, contract: address };
      if (
        (await ERC20Metadata.symbol.view(options)).value !== token.symbol ||
        (await ERC20.totalSupply.view(options)).value !== SUPPLY
      )
        throw new Error("Deployed token does not match its manifest.");
    }
    const manifest: FaucetManifest = {
      version: 1,
      network,
      rpcUrl,
      account: toHex0x(account.address),
      swapUrl:
        process.env.FAUCET_SWAP_URL ??
        "https://swap-production-66df.up.railway.app/pools",
      explorerUrl: "https://explorer.thruput.network",
      tokens: state.tokens.map(({ nonce: _nonce, ...token }) => token),
    };
    await saveJson(join(directory, "public.json"), manifest);
    console.log(
      `Five faucet tokens are ready.\nManifest: ${join(directory, "public.json")}\nFaucet account: ${manifest.account}`,
    );
  } finally {
    releaseLock();
  }
}

await setup().catch((error: unknown) => {
  console.error(
    error instanceof Error ? error.message : "Faucet setup failed.",
  );
  process.exitCode = 1;
});
