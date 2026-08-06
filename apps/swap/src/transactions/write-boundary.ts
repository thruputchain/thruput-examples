import type { Invocation } from "@groundhogchain/protocol";

export interface SubmittedWrite {
  hash: string;
}

export interface WriteBoundary {
  submit(target: Invocation): Promise<SubmittedWrite>;
}

export class WriteUnavailableError extends Error {
  constructor() {
    super("State-changing actions require direct pubkey authorization support");
    this.name = "WriteUnavailableError";
  }
}

export const unavailableWriteBoundary: WriteBoundary = {
  submit: async () => Promise.reject(new WriteUnavailableError()),
};
