import { addressFromHex, toHex0x } from "@groundhogchain/client";
import type { ContractAddress } from "@groundhogchain/protocol";

const IDS = ["alice", "bob", "carol"] as const;
const HEX = /^0x[0-9a-f]{64}$/;
export type DevelopmentPersonaId = (typeof IDS)[number];
export interface DevelopmentPersona {
  id: DevelopmentPersonaId;
  label: string;
  accountAddress: ContractAddress;
  accountAddressHex: string;
  privateKeyHex: string;
}
export type PublicDevelopmentPersona = Omit<
  DevelopmentPersona,
  "privateKeyHex"
>;

export function parseDevelopmentPersonas(
  serialized: string | undefined,
): DevelopmentPersona[] | null {
  if (!serialized?.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new Error("Development wallet configuration is invalid");
  }
  if (!Array.isArray(parsed) || parsed.length !== 3)
    throw new Error("Development wallet configuration is invalid");
  const personas = parsed.map((item): DevelopmentPersona => {
    if (!item || typeof item !== "object")
      throw new Error("Development wallet configuration is invalid");
    const value = item as Record<string, unknown>;
    if (
      typeof value.id !== "string" ||
      !IDS.includes(value.id as DevelopmentPersonaId) ||
      typeof value.label !== "string" ||
      typeof value.accountAddress !== "string" ||
      !HEX.test(value.accountAddress) ||
      typeof value.privateKey !== "string" ||
      !HEX.test(value.privateKey)
    )
      throw new Error("Development wallet configuration is invalid");
    const accountAddress = addressFromHex(value.accountAddress);
    return {
      id: value.id as DevelopmentPersonaId,
      label: value.label,
      accountAddress,
      accountAddressHex: toHex0x(accountAddress),
      privateKeyHex: value.privateKey,
    };
  });
  if (new Set(personas.map(({ id }) => id)).size !== 3)
    throw new Error("Development wallet configuration is invalid");
  return IDS.map((id) => personas.find((persona) => persona.id === id)!);
}

export function publicPersona({
  privateKeyHex: _,
  ...persona
}: DevelopmentPersona): PublicDevelopmentPersona {
  return persona;
}
export function preferenceKey(
  network: string,
  factory: ContractAddress,
): string {
  return `groundhog-token-launchpad:active-persona:v1:${network}:${toHex0x(factory)}`;
}
