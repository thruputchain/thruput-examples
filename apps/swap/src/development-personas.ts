import { addressFromHex, toHex0x } from "@groundhogchain/client";
import type { ContractAddress } from "@groundhogchain/protocol";

const PERSONA_IDS = ["alice", "bob", "carol"] as const;
const HEX_32 = /^0x[0-9a-f]{64}$/;

export type DevelopmentPersonaId = (typeof PERSONA_IDS)[number];

export interface DevelopmentPersona {
  id: DevelopmentPersonaId;
  label: string;
  accountAddress: ContractAddress;
  accountAddressHex: string;
  privateKeyHex: string;
}

export type PublicDevelopmentPersona = Omit<DevelopmentPersona, "privateKeyHex">;

export function publicDevelopmentPersona(
  persona: DevelopmentPersona,
): PublicDevelopmentPersona {
  const { privateKeyHex: _privateKeyHex, ...publicPersona } = persona;
  return publicPersona;
}

export class DevelopmentPersonaError extends Error {
  constructor(message = "Development wallet configuration is invalid") {
    super(message);
    this.name = "DevelopmentPersonaError";
  }
}

export function parseDevelopmentPersonas(
  serialized: string | undefined,
): DevelopmentPersona[] | null {
  if (serialized === undefined || serialized.trim() === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new DevelopmentPersonaError();
  }
  if (!Array.isArray(parsed) || parsed.length !== PERSONA_IDS.length) {
    throw new DevelopmentPersonaError();
  }
  const ids = new Set<string>();
  const addresses = new Set<string>();
  const privateKeys = new Set<string>();
  const personas = parsed.map((value): DevelopmentPersona => {
    if (typeof value !== "object" || value === null) {
      throw new DevelopmentPersonaError();
    }
    const candidate = value as Record<string, unknown>;
    if (
      typeof candidate.id !== "string"
      || !PERSONA_IDS.includes(candidate.id as DevelopmentPersonaId)
      || typeof candidate.label !== "string"
      || candidate.label.trim() === ""
      || typeof candidate.accountAddress !== "string"
      || !HEX_32.test(candidate.accountAddress)
      || typeof candidate.privateKey !== "string"
      || !HEX_32.test(candidate.privateKey)
      || ids.has(candidate.id)
      || addresses.has(candidate.accountAddress)
      || privateKeys.has(candidate.privateKey)
    ) throw new DevelopmentPersonaError();
    ids.add(candidate.id);
    addresses.add(candidate.accountAddress);
    privateKeys.add(candidate.privateKey);
    const accountAddress = addressFromHex(candidate.accountAddress);
    return {
      id: candidate.id as DevelopmentPersonaId,
      label: candidate.label.trim(),
      accountAddress,
      accountAddressHex: toHex0x(accountAddress),
      privateKeyHex: candidate.privateKey,
    };
  });
  if (PERSONA_IDS.some((id) => !ids.has(id))) {
    throw new DevelopmentPersonaError();
  }
  return PERSONA_IDS.map((id) => personas.find((persona) => persona.id === id)!);
}

export function personaPreferenceKey(
  networkIdHex: string,
  factoryAddress: ContractAddress,
): string {
  return [
    "groundhog-swap:active-persona:v1",
    networkIdHex,
    toHex0x(factoryAddress),
  ].join(":");
}

export function selectedDevelopmentPersona(
  personas: readonly DevelopmentPersona[],
  selectedId: string | null,
): DevelopmentPersona {
  return personas.find(({ id }) => id === selectedId) ?? personas[0]!;
}
