import { useState, type ReactElement } from "react";
import { App } from "./app";
import {
  ConfigurationError,
  isLoopbackHostname,
  loadAppConfig,
  type AppConfig,
  type Environment,
} from "./config";
import {
  DevelopmentPersonaError,
  parseDevelopmentPersonas,
  personaPreferenceKey,
  publicDevelopmentPersona,
  selectedDevelopmentPersona,
  type DevelopmentPersonaId,
} from "./development-personas";
import { transactionScope, withTransactionLock } from "./transactions/records";

export function createWorldPage(environment: Environment): ReactElement {
  try {
    const config = loadAppConfig(environment);
    const personas = parseDevelopmentPersonas(
      import.meta.env.GROUNDHOG_DEV_PERSONAS,
    );
    if (personas && config.transactionProfiles === null)
      throw new ConfigurationError(
        "Development wallets require measured transaction profiles",
      );
    if (
      personas &&
      (!isLoopbackHostname(config.rpcUrl.hostname) ||
        !isLoopbackHostname(config.indexerUrl.hostname) ||
        !isLoopbackHostname(window.location.hostname))
    )
      throw new ConfigurationError(
        "Development wallets are restricted to an entirely loopback deployment",
      );
    return <ConfiguredApp config={config} personas={personas} />;
  } catch (cause) {
    if (cause instanceof DevelopmentPersonaError)
      throw new ConfigurationError(cause.message);
    throw cause;
  }
}

function ConfiguredApp({
  config,
  personas,
}: {
  readonly config: Readonly<AppConfig>;
  readonly personas: ReturnType<typeof parseDevelopmentPersonas>;
}) {
  const preferenceKey = personaPreferenceKey(
    config.networkId,
    config.contractAddress,
  );
  const [selectedId, setSelectedId] = useState(() =>
    personas ? sessionStorage.getItem(preferenceKey) : null,
  );
  const active = personas
    ? selectedDevelopmentPersona(personas, selectedId)
    : null;
  const [switchError, setSwitchError] = useState<string | null>(null);
  const switchPersona = async (id: DevelopmentPersonaId) => {
    if (!active || id === active.id) return;
    setSwitchError(null);
    try {
      await withTransactionLock(
        transactionScope(config, active.expectedCallerHex),
        async () => {
          sessionStorage.setItem(preferenceKey, id);
          setSelectedId(id);
        },
      );
    } catch (cause) {
      setSwitchError(
        cause instanceof Error
          ? cause.message
          : "Persona could not be switched",
      );
    }
  };
  return (
    <>
      <App
        config={config}
        transaction={
          active && personas && config.transactionProfiles
            ? {
                active,
                personas: personas.map(publicDevelopmentPersona),
                switchPersona,
              }
            : null
        }
      />
      {switchError ? (
        <p
          role="alert"
          className="fixed right-3 bottom-3 z-50 rounded-md border border-destructive/40 bg-panel p-3 text-base text-destructive sm:text-sm"
        >
          {switchError}
        </p>
      ) : null}
    </>
  );
}
