import { Box, Button, Flex, Text, TextField } from "@radix-ui/themes";
import { RefreshCw, Server } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Spinner } from "./spinner";

import "./global-loading.css";

interface GlobalLoadingProps {
  error?: string | null;
  onRetry?: () => void;
  backendUrl?: string;
  onBackendUrlSubmit?: (value: string) => void;
}

/**
 * Global Loading Component
 *
 * Displayed when the application is initializing or waiting for the backend to become ready.
 */
export function GlobalLoading({ error, onRetry, backendUrl = "", onBackendUrlSubmit }: GlobalLoadingProps) {
  const { t } = useTranslation();
  const [serverUrl, setServerUrl] = useState(backendUrl);
  const [serverUrlError, setServerUrlError] = useState<string | null>(null);
  const hasError = Boolean(error);
  const spinnerLabel = hasError ? t("common.retryInitialization") : t("common.loading");

  return (
    <Box className="global-loading-shell">
      <Flex
        className="global-loading-stage"
        data-error={hasError ? "true" : "false"}
        direction="column"
        align="center"
        justify="center"
      >
        <Box
          className="global-loading-spinner-shell"
          data-error={hasError ? "true" : "false"}
        >
          <Spinner
            className="global-loading-spinner"
            size={24}
            aria-label={spinnerLabel}
          />
        </Box>

        {hasError ? (
          <Text
            as="p"
            className="global-loading-error"
            size="2"
          >
            {error}
          </Text>
        ) : null}

        {hasError ? (
          <Flex className="global-loading-actions" direction="column" gap="3">
            {onBackendUrlSubmit ? (
              <form
                className="global-loading-server-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  try {
                    onBackendUrlSubmit(serverUrl);
                  } catch {
                    setServerUrlError(t("common.backendUrlInvalid"));
                  }
                }}
              >
                <TextField.Root
                  size="3"
                  value={serverUrl}
                  onChange={(event) => {
                    setServerUrl(event.currentTarget.value);
                    setServerUrlError(null);
                  }}
                  placeholder={t("common.backendUrlPlaceholder")}
                  aria-label={t("common.backendUrlLabel")}
                >
                  <TextField.Slot><Server size={18} /></TextField.Slot>
                </TextField.Root>
                {serverUrlError ? <Text color="red" size="1">{serverUrlError}</Text> : null}
                <Button type="submit" size="3">{t("common.connectBackend")}</Button>
              </form>
            ) : null}
            <Button
              className="global-loading-retry"
              onClick={onRetry}
              variant="ghost"
              color="gray"
              aria-label={t("common.retryInitialization")}
            >
              <RefreshCw size={18} />
            </Button>
          </Flex>
        ) : null}
      </Flex>
    </Box>
  );
}
