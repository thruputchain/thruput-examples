// @vitest-environment node

import { describe, expect, it } from "vitest";

import {
  developmentPrivateKeyDefinition,
  developmentPersonasDefinition,
  isAllowedRequest,
  isSameOriginLocalRequest,
  validateDevelopmentServerHost,
  validateRpcTarget,
} from "./vite.config";

describe("development private key boundary", () => {
  const canary = `0x${"a5".repeat(32)}`;

  it("does not define the private key for builds", () => {
    expect(
      developmentPrivateKeyDefinition("build", false, {
        GROUNDHOG_DEV_PRIVATE_KEY: canary,
      }),
    ).toBe("undefined");
  });

  it("defines the private key only while serving the development app", () => {
    expect(
      developmentPrivateKeyDefinition("serve", false, {
        GROUNDHOG_DEV_PRIVATE_KEY: canary,
      }),
    ).toBe(JSON.stringify(canary));
    expect(developmentPrivateKeyDefinition("serve", false, {})).toBe(
      "undefined",
    );
  });

  it("does not define the key for preview", () => {
    const environment = { GROUNDHOG_DEV_PRIVATE_KEY: canary };

    expect(developmentPrivateKeyDefinition("serve", true, environment)).toBe(
      "undefined",
    );
    expect(developmentPrivateKeyDefinition("serve", false, environment)).toBe(
      JSON.stringify(canary),
    );
  });

  it("does not define development credentials for a non-loopback RPC", () => {
    expect(
      developmentPrivateKeyDefinition(
        "serve",
        false,
        { GROUNDHOG_DEV_PRIVATE_KEY: canary },
        "https://rpc.example.com",
      ),
    ).toBe("undefined");
    expect(
      developmentPersonasDefinition(
        "serve",
        false,
        { GROUNDHOG_DEV_PERSONAS: "[]" },
        "https://rpc.example.com",
      ),
    ).toBe("undefined");
  });

  it("defines personas only for local development serve", () => {
    const personas = '[{"id":"alice"}]';
    expect(
      developmentPersonasDefinition("serve", false, {
        GROUNDHOG_DEV_PERSONAS: personas,
      }),
    ).toBe(JSON.stringify(personas));
    expect(
      developmentPersonasDefinition("build", false, {
        GROUNDHOG_DEV_PERSONAS: personas,
      }),
    ).toBe("undefined");
  });

  it("rejects exposing development credentials on a network host", () => {
    expect(() => validateDevelopmentServerHost("0.0.0.0", true)).toThrow(
      "loopback host",
    );
    expect(() => validateDevelopmentServerHost(true, true)).toThrow(
      "loopback host",
    );
    expect(() =>
      validateDevelopmentServerHost("127.0.0.1", true),
    ).not.toThrow();
    expect(() => validateDevelopmentServerHost("0.0.0.0", false)).not.toThrow();
  });
});

describe("local RPC proxy policy", () => {
  it.each([
    "groundhog_networkInfo",
    "groundhog_chainTip",
    "groundhog_getEvents",
    "groundhog_view",
    "groundhog_sendRawTransaction",
    "groundhog_getTransactionStatus",
    "groundhog_getTransactionReceipt",
  ])("allows %s", (method) => {
    expect(isAllowedRequest({ jsonrpc: "2.0", id: 1, method })).toBe(true);
  });

  it("rejects unrelated RPC methods and batches", () => {
    expect(isAllowedRequest({ method: "groundhog_deleteAllData" })).toBe(false);
    expect(isAllowedRequest([{ method: "groundhog_view" }])).toBe(false);
  });

  it("requires a loopback host and rejects cross-site requests", () => {
    expect(
      isSameOriginLocalRequest({
        headers: {
          host: "localhost:5173",
          origin: "http://localhost:5173",
          "sec-fetch-site": "same-origin",
        },
      }),
    ).toBe(true);
    expect(
      isSameOriginLocalRequest({
        headers: {
          host: "localhost:5173",
          origin: "https://attacker.example",
          "sec-fetch-site": "cross-site",
        },
      }),
    ).toBe(false);
    expect(
      isSameOriginLocalRequest({ headers: { host: "192.168.1.10:5173" } }),
    ).toBe(false);
    expect(
      isSameOriginLocalRequest({ headers: { host: "localhost:5173" } }),
    ).toBe(false);
    expect(
      isSameOriginLocalRequest({
        headers: {
          host: "localhost:5173",
          origin: "https://localhost:5173",
        },
      }),
    ).toBe(false);
  });

  it("rejects credential-bearing RPC targets before Vite serves the app", () => {
    expect(() =>
      validateRpcTarget("http://operator:secret@127.0.0.1:9545"),
    ).toThrow("must not contain credentials");
  });

  it("allows a remote RPC only for a registry-enabled production build", () => {
    expect(() =>
      validateRpcTarget("https://rpc.example.com", {
        command: "build",
        production: true,
        registryEnabled: true,
      }),
    ).not.toThrow();
    expect(() =>
      validateRpcTarget("https://rpc.example.com", {
        command: "build",
        production: true,
        registryEnabled: false,
      }),
    ).toThrow("loopback HTTP server");
    expect(() =>
      validateRpcTarget("https://rpc.example.com", {
        command: "serve",
        production: true,
        registryEnabled: true,
      }),
    ).toThrow("loopback HTTP server");
    expect(() =>
      validateRpcTarget("https://rpc.example.com", {
        command: "build",
        production: false,
        registryEnabled: true,
      }),
    ).toThrow("loopback HTTP server");
  });
});
