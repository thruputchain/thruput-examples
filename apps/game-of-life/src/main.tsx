import { createRoot } from "react-dom/client";
import { useState } from "react";
import { App } from "./app";
import {
  ConfigurationError,
  isLoopbackHostname,
  loadAppConfig,
  type AppConfig,
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
import "./styles.css";

const container = document.getElementById("root");
if (!container) throw new Error("Application root is missing");
const root = createRoot(container);
try {
  const config = loadAppConfig(import.meta.env);
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
  root.render(<ConfiguredApp config={config} personas={personas} />);
} catch (cause) {
  const message =
    cause instanceof ConfigurationError ||
    cause instanceof DevelopmentPersonaError
      ? cause.message
      : "Startup configuration could not be validated";
  root.render(
    <main className="grid min-h-dvh place-items-center bg-background p-6 text-foreground">
      <section
        role="alert"
        className="max-w-[52ch] rounded-lg border border-destructive/40 bg-panel p-5"
      >
        <h1 className="text-balance text-xl font-semibold">
          Invalid startup configuration
        </h1>
        <p className="mt-2 text-pretty text-base text-muted-foreground sm:text-sm">
          {message}
        </p>
      </section>
    </main>,
  );
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
          className="fixed right-3 bottom-3 z-50 rounded-md border border-destructive/40 bg-panel p-3 text-sm text-destructive"
        >
          {switchError}
        </p>
      ) : null}
    </>
  );
}
