import { ArchiveIcon, ArchiveX, LoaderIcon, PlusIcon, RefreshCwIcon } from "lucide-react";
import { Link } from "@tanstack/react-router";
import type { CSSProperties } from "react";
import { useCallback, useMemo, useRef, useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import {
  type BackgroundActivityProfile,
  defaultInstanceIdForDriver,
  type CursorLocalHistoryDryRunResult,
  type CursorLocalHistoryImportResult,
  type ClaudeLocalHistoryDryRunResult,
  type ClaudeLocalHistoryImportResult,
  type LocalHistorySyncResult,
  type DesktopUpdateChannel,
  PROVIDER_DISPLAY_NAMES,
  ProviderDriverKind,
  type ProviderInstanceConfig,
  type ProviderInstanceId,
  type ScopedThreadRef,
  type SidebarProjectGroupingMode,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { safeErrorLogAttributes } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  DAILY_LOCAL_HISTORY_SYNC_INTERVAL,
  DEFAULT_ENVIRONMENT_IDENTIFICATION_MODE,
  DEFAULT_UNIFIED_SETTINGS,
  type EnvironmentIdentificationMode,
  MAX_GLASS_OPACITY,
  MIN_GLASS_OPACITY,
} from "@t3tools/contracts/settings";
import { resolveServerBackgroundActivitySettings } from "@t3tools/shared/backgroundActivitySettings";
import { createModelSelection } from "@t3tools/shared/model";
import * as Arr from "effect/Array";
import * as Duration from "effect/Duration";
import * as Equal from "effect/Equal";
import * as Result from "effect/Result";
import { APP_VERSION, HOSTED_APP_CHANNEL, HOSTED_APP_CHANNEL_LABEL } from "../../branding";
import {
  canCheckForUpdate,
  getDesktopUpdateButtonTooltip,
  getDesktopUpdateInstallConfirmationMessage,
  isDesktopUpdateButtonDisabled,
  resolveDesktopUpdateButtonAction,
} from "../../components/desktopUpdate.logic";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";
import {
  resolveEnvironmentIdentificationPillLabel,
  useEnvironmentStageLabel,
} from "../SidebarStageBackdrop";
import { isElectron } from "../../env";
import { buildHostedChannelSelectionUrl, type HostedAppChannel } from "../../hostedPairing";
import { useTheme } from "../../hooks/useTheme";
import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import { useThreadActions } from "../../hooks/useThreadActions";
import { useDesktopUpdateState } from "../../state/desktopUpdate";
import {
  getCustomModelOptionsByInstance,
  resolveAppModelSelectionState,
} from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { ensureLocalApi, readLocalApi } from "../../localApi";
import {
  primaryServerObservabilityAtom,
  primaryServerProvidersAtom,
  serverEnvironment,
} from "../../state/server";
import { usePrimaryEnvironment } from "../../state/environments";
import { useProjects } from "../../state/entities";
import { useArchivedThreadSnapshots } from "../../lib/archivedThreadsState";
import { formatRelativeTimeLabel, getRelativeTimeState } from "../../timestampFormat";
import { Button } from "../ui/button";
import { DraftInput } from "../ui/draft-input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { AddProviderInstanceDialog } from "./AddProviderInstanceDialog";
import {
  canOneClickUpdateProviderCandidate,
  collectProviderUpdateCandidates,
  hasOneClickUpdateProviderCandidate,
  isProviderUpdateActive,
  type ProviderUpdateCandidate,
} from "../ProviderUpdateLaunchNotification.logic";
import { ProviderInstanceCard } from "./ProviderInstanceCard";
import { DRIVER_OPTIONS, getDriverOption } from "./providerDriverMeta";
import {
  buildProviderInstanceUpdatePatch,
  formatDiagnosticsDescription,
  isProjectGroupingEnabled,
  projectGroupingModeFromToggle,
  readLastEnabledProjectGroupingMode,
  rememberEnabledProjectGroupingMode,
} from "./SettingsPanels.logic";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
  useRelativeTimeTick,
} from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { ProjectFavicon } from "../ProjectFavicon";
import { useAtomCommand } from "../../state/use-atom-command";

const THEME_OPTIONS = [
  {
    value: "system",
    label: "System",
  },
  {
    value: "light",
    label: "Light",
  },
  {
    value: "dark",
    label: "Dark",
  },
] as const;

const ENVIRONMENT_IDENTIFICATION_LABELS: Record<EnvironmentIdentificationMode, string> = {
  artwork: "Artwork",
  pill: "Version pill",
  none: "None",
};

const TIMESTAMP_FORMAT_LABELS = {
  locale: "System default",
  "12-hour": "12-hour",
  "24-hour": "24-hour",
} as const;

const BACKGROUND_ACTIVITY_PROFILE_LABELS: Record<BackgroundActivityProfile, string> = {
  balanced: "Balanced",
  performance: "Performance",
  "battery-saver": "Battery saver",
};

const BACKGROUND_ACTIVITY_PROFILE_DESCRIPTIONS: Record<BackgroundActivityProfile, string> = {
  balanced:
    "Pauses background probes when clients are idle, the host is locked, or low power mode is active.",
  performance: "Allows scoped background probes while any subscribed client remains connected.",
  "battery-saver": "Also pauses background probes when the host or client is on battery.",
};

const DEFAULT_DRIVER_KIND = ProviderDriverKind.make("codex");

function backgroundActivityProfileSettings(profile: BackgroundActivityProfile) {
  return {
    backgroundActivity: {
      schemaVersion: 1 as const,
      profile,
      overrides: {},
    },
  };
}

function withoutProviderInstanceKey<V>(
  record: Readonly<Record<ProviderInstanceId, V>> | undefined,
  key: ProviderInstanceId,
): Record<ProviderInstanceId, V> {
  const next = { ...record } as Record<ProviderInstanceId, V>;
  delete next[key];
  return next;
}

function withoutProviderInstanceFavorites(
  favorites: ReadonlyArray<{ readonly provider: ProviderInstanceId; readonly model: string }>,
  instanceId: ProviderInstanceId,
) {
  return favorites.filter((favorite) => favorite.provider !== instanceId);
}

const PROVIDER_SETTINGS = DRIVER_OPTIONS.map((definition) => ({
  provider: definition.value,
}));

const CURSOR_HISTORY_WORKSPACE_PREVIEW_LIMIT = 6;
const CURSOR_HISTORY_ERROR_PREVIEW_LIMIT = 4;
const CURSOR_HISTORY_SOURCE_PREVIEW_LIMIT = 5;
const CURSOR_HISTORY_IMPORT_BATCH_SIZE = 25;
const CLAUDE_HISTORY_IMPORT_BATCH_SIZE = 25;

function formatCursorHistoryNumber(value: number): string {
  return new Intl.NumberFormat().format(value);
}

function CursorHistoryMetric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border border-border/60 bg-background/60 px-3 py-2">
      <div className="font-mono text-sm font-semibold tabular-nums text-foreground">
        {formatCursorHistoryNumber(value)}
      </div>
      <div className="mt-0.5 text-[11px] text-muted-foreground">{label}</div>
    </div>
  );
}

function CursorLocalHistoryDryRunDetails({ result }: { result: CursorLocalHistoryDryRunResult }) {
  const previewWorkspaces = result.workspaces.slice(0, CURSOR_HISTORY_WORKSPACE_PREVIEW_LIMIT);
  const previewErrors = result.errors.slice(0, CURSOR_HISTORY_ERROR_PREVIEW_LIMIT);
  const previewSources = [
    result.roots.projectsDir,
    result.roots.chatsDir,
    result.roots.workspaceStorageDir,
  ].slice(0, CURSOR_HISTORY_SOURCE_PREVIEW_LIMIT);

  return (
    <div className="mt-3 space-y-3 rounded-xl border border-border/60 bg-muted/25 p-3">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <CursorHistoryMetric label="workspaces" value={result.workspaceCount} />
        <CursorHistoryMetric label="chats" value={result.chatCount} />
        <CursorHistoryMetric label="messages" value={result.messageCount} />
        <CursorHistoryMetric label="parse errors" value={result.parseErrorCount} />
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <div className="space-y-1.5">
          <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
            Top workspaces
          </div>
          <div className="space-y-1.5">
            {previewWorkspaces.length > 0 ? (
              previewWorkspaces.map((workspace) => (
                <div
                  key={workspace.workspaceKey}
                  className="rounded-lg border border-border/50 bg-background/70 px-2.5 py-2"
                >
                  <div className="truncate text-xs font-medium text-foreground">
                    {workspace.workspacePath ?? workspace.workspaceSlug ?? workspace.workspaceKey}
                  </div>
                  <div className="mt-0.5 text-[11px] text-muted-foreground">
                    {formatCursorHistoryNumber(workspace.chatCount)} chats ·{" "}
                    {formatCursorHistoryNumber(workspace.messageCount)} messages
                  </div>
                </div>
              ))
            ) : (
              <div className="rounded-lg border border-dashed border-border/60 px-2.5 py-2 text-xs text-muted-foreground">
                No local Cursor chats found yet.
              </div>
            )}
          </div>
        </div>

        <div className="space-y-1.5">
          <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
            Source roots
          </div>
          <div className="space-y-1.5">
            {previewSources.map((source) => (
              <code
                key={source}
                className="block truncate rounded-lg border border-border/50 bg-background/70 px-2.5 py-2 font-mono text-[11px] text-muted-foreground"
                title={source}
              >
                {source}
              </code>
            ))}
          </div>
        </div>
      </div>

      {previewErrors.length > 0 ? (
        <div className="space-y-1.5">
          <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-destructive/80">
            Scan issues
          </div>
          <div className="space-y-1.5">
            {previewErrors.map((error) => (
              <div
                key={`${error.kind}:${error.path}:${error.message}`}
                className="rounded-lg border border-destructive/20 bg-destructive/5 px-2.5 py-2"
              >
                <div className="text-xs font-medium text-destructive/90">{error.kind}</div>
                <div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
                  {error.path}
                </div>
                <div className="mt-1 text-[11px] text-muted-foreground">{error.message}</div>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ClaudeLocalHistoryDryRunDetails({ result }: { result: ClaudeLocalHistoryDryRunResult }) {
  const previewWorkspaces = result.workspaces.slice(0, CURSOR_HISTORY_WORKSPACE_PREVIEW_LIMIT);
  const previewErrors = result.errors.slice(0, CURSOR_HISTORY_ERROR_PREVIEW_LIMIT);

  return (
    <div className="mt-3 space-y-3 rounded-xl border border-border/60 bg-muted/25 p-3">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <CursorHistoryMetric label="workspaces" value={result.workspaceCount} />
        <CursorHistoryMetric label="chats" value={result.chatCount} />
        <CursorHistoryMetric label="messages" value={result.messageCount} />
        <CursorHistoryMetric label="parse errors" value={result.parseErrorCount} />
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        <div className="space-y-1.5">
          <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
            Top workspaces
          </div>
          <div className="space-y-1.5">
            {previewWorkspaces.length > 0 ? (
              previewWorkspaces.map((workspace) => (
                <div
                  key={workspace.workspaceKey}
                  className="rounded-lg border border-border/50 bg-background/70 px-2.5 py-2"
                >
                  <div className="truncate text-xs font-medium text-foreground">
                    {workspace.workspacePath ?? workspace.workspaceKey}
                  </div>
                  <div className="mt-0.5 text-[11px] text-muted-foreground">
                    {formatCursorHistoryNumber(workspace.chatCount)} chats ·{" "}
                    {formatCursorHistoryNumber(workspace.messageCount)} messages
                  </div>
                </div>
              ))
            ) : (
              <div className="rounded-lg border border-dashed border-border/60 px-2.5 py-2 text-xs text-muted-foreground">
                No local Claude Code chats found yet.
              </div>
            )}
          </div>
        </div>
        <div className="space-y-1.5">
          <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
            Source roots
          </div>
          <code
            className="block truncate rounded-lg border border-border/50 bg-background/70 px-2.5 py-2 font-mono text-[11px] text-muted-foreground"
            title={result.roots.projectsDir}
          >
            {result.roots.projectsDir}
          </code>
        </div>
      </div>
      {previewErrors.length > 0 ? (
        <div className="space-y-1.5">
          <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-destructive/80">
            Scan issues
          </div>
          {previewErrors.map((error) => (
            <div
              key={`${error.kind}:${error.path}:${error.message}`}
              className="rounded-lg border border-destructive/20 bg-destructive/5 px-2.5 py-2"
            >
              <div className="truncate font-mono text-[11px] text-muted-foreground">
                {error.path}
              </div>
              <div className="mt-1 text-[11px] text-muted-foreground">{error.message}</div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ProviderLastChecked({ lastCheckedAt }: { lastCheckedAt: string | null }) {
  useRelativeTimeTick();
  const lastCheckedRelative = getRelativeTimeState(lastCheckedAt);

  if (lastCheckedRelative.status === "missing") {
    return null;
  }

  if (lastCheckedRelative.status === "invalid") {
    return <span className="text-[11px] text-muted-foreground/50">Checked unavailable</span>;
  }

  return (
    <span className="text-[11px] text-muted-foreground/60">
      {lastCheckedRelative.suffix ? (
        <>
          Checked <span className="font-mono tabular-nums">{lastCheckedRelative.value}</span>{" "}
          {lastCheckedRelative.suffix}
        </>
      ) : (
        <>Checked {lastCheckedRelative.value}</>
      )}
    </span>
  );
}

function AboutVersionTitle() {
  return (
    <span className="inline-flex items-center gap-2">
      <span>Version</span>
      <code className="text-[11px] font-medium text-muted-foreground">{APP_VERSION}</code>
    </span>
  );
}

function AboutVersionSection() {
  const updateState = useDesktopUpdateState();
  const [isChangingUpdateChannel, setIsChangingUpdateChannel] = useState(false);

  const hasDesktopBridge = typeof window !== "undefined" && Boolean(window.desktopBridge);
  const selectedUpdateChannel = updateState?.channel ?? "latest";
  const selectedHostedAppChannel = hasDesktopBridge ? null : HOSTED_APP_CHANNEL;

  const handleUpdateChannelChange = useCallback(
    (channel: DesktopUpdateChannel) => {
      const bridge = window.desktopBridge;
      if (
        !bridge ||
        typeof bridge.setUpdateChannel !== "function" ||
        channel === selectedUpdateChannel
      ) {
        return;
      }

      setIsChangingUpdateChannel(true);
      void bridge
        .setUpdateChannel(channel)
        .catch((error: unknown) => {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not change update track",
              description: error instanceof Error ? error.message : "Update track change failed.",
            }),
          );
        })
        .finally(() => {
          setIsChangingUpdateChannel(false);
        });
    },
    [selectedUpdateChannel],
  );

  const handleButtonClick = useCallback(() => {
    const bridge = window.desktopBridge;
    if (!bridge) return;

    const action = updateState ? resolveDesktopUpdateButtonAction(updateState) : "none";

    if (action === "download") {
      void bridge.downloadUpdate().catch((error: unknown) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not download update",
            description: error instanceof Error ? error.message : "Download failed.",
          }),
        );
      });
      return;
    }

    if (action === "install") {
      const confirmed = window.confirm(
        getDesktopUpdateInstallConfirmationMessage(
          updateState ?? { availableVersion: null, downloadedVersion: null },
          navigator.platform,
        ),
      );
      if (!confirmed) return;
      void bridge.installUpdate().catch((error: unknown) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not install update",
            description: error instanceof Error ? error.message : "Install failed.",
          }),
        );
      });
      return;
    }

    if (typeof bridge.checkForUpdate !== "function") return;
    void bridge
      .checkForUpdate()
      .then((result) => {
        if (!result.checked) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not check for updates",
              description:
                result.state.message ?? "Automatic updates are not available in this build.",
            }),
          );
        }
      })
      .catch((error: unknown) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not check for updates",
            description: error instanceof Error ? error.message : "Update check failed.",
          }),
        );
      });
  }, [updateState]);

  const action = updateState ? resolveDesktopUpdateButtonAction(updateState) : "none";
  const buttonTooltip = updateState ? getDesktopUpdateButtonTooltip(updateState) : null;
  const buttonDisabled =
    action === "none"
      ? !canCheckForUpdate(updateState)
      : isDesktopUpdateButtonDisabled(updateState);

  const actionLabel: Record<string, string> = { download: "Download", install: "Install" };
  const statusLabel: Record<string, string> = {
    checking: "Checking…",
    downloading: "Downloading…",
    "up-to-date": "Up to Date",
  };
  const buttonLabel =
    actionLabel[action] ?? statusLabel[updateState?.status ?? ""] ?? "Check for Updates";
  const description =
    action === "download" || action === "install"
      ? "Update available."
      : "Current version of the application.";

  return (
    <>
      <SettingsRow
        title={<AboutVersionTitle />}
        description={description}
        control={
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="xs"
                  variant={action === "install" ? "default" : "outline"}
                  disabled={buttonDisabled}
                  onClick={handleButtonClick}
                >
                  {buttonLabel}
                </Button>
              }
            />
            {buttonTooltip ? <TooltipPopup>{buttonTooltip}</TooltipPopup> : null}
          </Tooltip>
        }
      />
      {hasDesktopBridge ? (
        <SettingsRow
          title="Update track"
          description="Stable follows full releases. Nightly follows the nightly desktop channel and can switch back to stable immediately."
          control={
            <Select
              value={selectedUpdateChannel}
              onValueChange={(value) => {
                handleUpdateChannelChange(value as DesktopUpdateChannel);
              }}
            >
              <SelectTrigger
                className="w-full sm:w-40"
                aria-label="Update track"
                disabled={isChangingUpdateChannel}
              >
                <SelectValue>
                  {selectedUpdateChannel === "nightly" ? "Nightly" : "Stable"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value="latest">
                  Stable
                </SelectItem>
                <SelectItem hideIndicator value="nightly">
                  Nightly
                </SelectItem>
              </SelectPopup>
            </Select>
          }
        />
      ) : selectedHostedAppChannel ? (
        <SettingsRow
          title="Update track"
          description="Switches the hosted app release channel."
          control={
            <Select
              value={selectedHostedAppChannel}
              onValueChange={(value) => {
                if (value === selectedHostedAppChannel) return;
                window.location.assign(
                  buildHostedChannelSelectionUrl({ channel: value as HostedAppChannel }),
                );
              }}
            >
              <SelectTrigger className="w-full sm:w-40" aria-label="Update track">
                <SelectValue>{HOSTED_APP_CHANNEL_LABEL}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value="latest">
                  Latest
                </SelectItem>
                <SelectItem hideIndicator value="nightly">
                  Nightly
                </SelectItem>
              </SelectPopup>
            </Select>
          }
        />
      ) : null}
    </>
  );
}

export function useSettingsRestore(onRestored?: () => void) {
  const { theme, setTheme } = useTheme();
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();

  const isGitWritingModelDirty = !Equal.equals(
    settings.textGenerationModelSelection ?? null,
    DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection ?? null,
  );

  const changedSettingLabels = useMemo(
    () => [
      ...(theme !== "system" ? ["Theme"] : []),
      ...(settings.glassOpacity !== DEFAULT_UNIFIED_SETTINGS.glassOpacity ? ["Glass opacity"] : []),
      ...(settings.environmentIdentificationMode !==
      DEFAULT_UNIFIED_SETTINGS.environmentIdentificationMode
        ? ["Environment identification"]
        : []),
      ...(settings.timestampFormat !== DEFAULT_UNIFIED_SETTINGS.timestampFormat
        ? ["Time format"]
        : []),
      ...(settings.sidebarThreadPreviewCount !== DEFAULT_UNIFIED_SETTINGS.sidebarThreadPreviewCount
        ? ["Visible threads"]
        : []),
      ...(settings.sidebarProjectGroupingMode !==
      DEFAULT_UNIFIED_SETTINGS.sidebarProjectGroupingMode
        ? ["Project Grouping"]
        : []),
      ...(settings.wordWrap !== DEFAULT_UNIFIED_SETTINGS.wordWrap ? ["Word wrap"] : []),
      ...(settings.diffIgnoreWhitespace !== DEFAULT_UNIFIED_SETTINGS.diffIgnoreWhitespace
        ? ["Diff whitespace changes"]
        : []),
      ...(settings.autoOpenPlanSidebar !== DEFAULT_UNIFIED_SETTINGS.autoOpenPlanSidebar
        ? ["Auto-open task panel"]
        : []),
      ...(settings.enableAssistantStreaming !== DEFAULT_UNIFIED_SETTINGS.enableAssistantStreaming
        ? ["Assistant output"]
        : []),
      ...(settings.enableProviderUpdateChecks !==
      DEFAULT_UNIFIED_SETTINGS.enableProviderUpdateChecks
        ? ["Provider update checks"]
        : []),
      ...(!Equal.equals(settings.backgroundActivity, DEFAULT_UNIFIED_SETTINGS.backgroundActivity)
        ? ["Background activity"]
        : []),
      ...(Duration.toMillis(settings.automaticGitFetchInterval) !==
      Duration.toMillis(DEFAULT_UNIFIED_SETTINGS.automaticGitFetchInterval)
        ? ["Automatic Git fetch interval"]
        : []),
      ...(settings.defaultThreadEnvMode !== DEFAULT_UNIFIED_SETTINGS.defaultThreadEnvMode
        ? ["New thread mode"]
        : []),
      ...(settings.newWorktreesStartFromOrigin !==
      DEFAULT_UNIFIED_SETTINGS.newWorktreesStartFromOrigin
        ? ["New worktrees start from origin"]
        : []),
      ...(settings.addProjectBaseDirectory !== DEFAULT_UNIFIED_SETTINGS.addProjectBaseDirectory
        ? ["Add project base directory"]
        : []),
      ...(settings.confirmThreadArchive !== DEFAULT_UNIFIED_SETTINGS.confirmThreadArchive
        ? ["Archive confirmation"]
        : []),
      ...(settings.confirmThreadDelete !== DEFAULT_UNIFIED_SETTINGS.confirmThreadDelete
        ? ["Delete confirmation"]
        : []),
      ...(isGitWritingModelDirty ? ["Git writing model"] : []),
    ],
    [
      isGitWritingModelDirty,
      settings.autoOpenPlanSidebar,
      settings.confirmThreadArchive,
      settings.confirmThreadDelete,
      settings.addProjectBaseDirectory,
      settings.defaultThreadEnvMode,
      settings.newWorktreesStartFromOrigin,
      settings.diffIgnoreWhitespace,
      settings.environmentIdentificationMode,
      settings.glassOpacity,
      settings.automaticGitFetchInterval,
      settings.enableAssistantStreaming,
      settings.enableProviderUpdateChecks,
      settings.sidebarProjectGroupingMode,
      settings.sidebarThreadPreviewCount,
      settings.timestampFormat,
      settings.wordWrap,
      theme,
    ],
  );

  const restoreDefaults = useCallback(async () => {
    if (changedSettingLabels.length === 0) return;
    const api = readLocalApi();
    const confirmed = await (api ?? ensureLocalApi()).dialogs.confirm(
      ["Restore default settings?", `This will reset: ${changedSettingLabels.join(", ")}.`].join(
        "\n",
      ),
    );
    if (!confirmed) return;

    setTheme("system");
    updateSettings({
      timestampFormat: DEFAULT_UNIFIED_SETTINGS.timestampFormat,
      wordWrap: DEFAULT_UNIFIED_SETTINGS.wordWrap,
      diffIgnoreWhitespace: DEFAULT_UNIFIED_SETTINGS.diffIgnoreWhitespace,
      environmentIdentificationMode: DEFAULT_UNIFIED_SETTINGS.environmentIdentificationMode,
      glassOpacity: DEFAULT_UNIFIED_SETTINGS.glassOpacity,
      sidebarThreadPreviewCount: DEFAULT_UNIFIED_SETTINGS.sidebarThreadPreviewCount,
      sidebarProjectGroupingMode: DEFAULT_UNIFIED_SETTINGS.sidebarProjectGroupingMode,
      autoOpenPlanSidebar: DEFAULT_UNIFIED_SETTINGS.autoOpenPlanSidebar,
      enableAssistantStreaming: DEFAULT_UNIFIED_SETTINGS.enableAssistantStreaming,
      enableProviderUpdateChecks: DEFAULT_UNIFIED_SETTINGS.enableProviderUpdateChecks,
      backgroundActivity: DEFAULT_UNIFIED_SETTINGS.backgroundActivity,
      backgroundActivityProfile: DEFAULT_UNIFIED_SETTINGS.backgroundActivityProfile,
      automaticGitFetchInterval: DEFAULT_UNIFIED_SETTINGS.automaticGitFetchInterval,
      providerHealthRefreshInterval: DEFAULT_UNIFIED_SETTINGS.providerHealthRefreshInterval,
      defaultThreadEnvMode: DEFAULT_UNIFIED_SETTINGS.defaultThreadEnvMode,
      newWorktreesStartFromOrigin: DEFAULT_UNIFIED_SETTINGS.newWorktreesStartFromOrigin,
      addProjectBaseDirectory: DEFAULT_UNIFIED_SETTINGS.addProjectBaseDirectory,
      confirmThreadArchive: DEFAULT_UNIFIED_SETTINGS.confirmThreadArchive,
      confirmThreadDelete: DEFAULT_UNIFIED_SETTINGS.confirmThreadDelete,
      textGenerationModelSelection: DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection,
    });
    onRestored?.();
  }, [changedSettingLabels, onRestored, setTheme, updateSettings]);

  return {
    changedSettingLabels,
    restoreDefaults,
  };
}

export function AppearanceSettingsPanel() {
  const { theme, setTheme } = useTheme();
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const environmentStageLabel = useEnvironmentStageLabel();
  const showEnvironmentIdentification =
    resolveEnvironmentIdentificationPillLabel(environmentStageLabel) !== null;
  const glassOpacityRatio =
    (settings.glassOpacity - MIN_GLASS_OPACITY) / (MAX_GLASS_OPACITY - MIN_GLASS_OPACITY);
  const glassOpacitySliderStyle = {
    "--glass-slider-progress": `${glassOpacityRatio * 100}%`,
    "--glass-slider-fill-offset": `${0.5 - glassOpacityRatio}rem`,
  } as CSSProperties;

  return (
    <SettingsPageContainer>
      <SettingsSection id="appearance" title="Appearance">
        <SettingsRow
          {...searchableSetting("theme")}
          description="Choose how T3 Code looks across the app."
          resetAction={
            theme !== "system" ? (
              <SettingResetButton label="theme" onClick={() => setTheme("system")} />
            ) : null
          }
          control={
            <Select
              value={theme}
              onValueChange={(value) => {
                if (value === "system" || value === "light" || value === "dark") {
                  setTheme(value);
                }
              }}
            >
              <SelectTrigger className="w-full sm:w-40" aria-label="Theme preference">
                <SelectValue>
                  {THEME_OPTIONS.find((option) => option.value === theme)?.label ?? "System"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {THEME_OPTIONS.map((option) => (
                  <SelectItem hideIndicator key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
        <SettingsRow
          {...searchableSetting("setting-glass-opacity")}
          description="Control how transparent glass surfaces are. Higher values make menus, dialogs, and the composer more solid."
          resetAction={
            settings.glassOpacity !== DEFAULT_UNIFIED_SETTINGS.glassOpacity ? (
              <SettingResetButton
                label="glass opacity"
                onClick={() =>
                  updateSettings({ glassOpacity: DEFAULT_UNIFIED_SETTINGS.glassOpacity })
                }
              />
            ) : null
          }
          control={
            <div className="flex w-full items-center gap-3 sm:w-52">
              <output
                className="min-w-12 rounded-md bg-muted px-2 py-1 text-center font-mono text-xs font-medium tabular-nums text-foreground"
                htmlFor="glass-opacity"
              >
                {settings.glassOpacity}%
              </output>
              <input
                aria-label="Glass opacity"
                className="glass-opacity-slider min-w-0 flex-1"
                id="glass-opacity"
                max={MAX_GLASS_OPACITY}
                min={MIN_GLASS_OPACITY}
                onChange={(event) => {
                  const glassOpacity = Number(event.currentTarget.value);
                  if (
                    Number.isInteger(glassOpacity) &&
                    glassOpacity >= MIN_GLASS_OPACITY &&
                    glassOpacity <= MAX_GLASS_OPACITY
                  ) {
                    updateSettings({ glassOpacity });
                  }
                }}
                step={5}
                style={glassOpacitySliderStyle}
                type="range"
                value={settings.glassOpacity}
              />
            </div>
          }
        />
        {showEnvironmentIdentification ? (
          <SettingsRow
            {...searchableSetting("environment-identification")}
            description="Choose how Dev and Nightly environments are identified."
            resetAction={
              settings.environmentIdentificationMode !== DEFAULT_ENVIRONMENT_IDENTIFICATION_MODE ? (
                <SettingResetButton
                  label="environment identification"
                  onClick={() =>
                    updateSettings({
                      environmentIdentificationMode: DEFAULT_ENVIRONMENT_IDENTIFICATION_MODE,
                    })
                  }
                />
              ) : null
            }
            control={
              <Select
                value={settings.environmentIdentificationMode}
                onValueChange={(value) => {
                  if (value === "artwork" || value === "pill" || value === "none") {
                    updateSettings({ environmentIdentificationMode: value });
                  }
                }}
              >
                <SelectTrigger className="w-full sm:w-40" aria-label="Environment identification">
                  <SelectValue>
                    {ENVIRONMENT_IDENTIFICATION_LABELS[settings.environmentIdentificationMode]}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {Object.entries(ENVIRONMENT_IDENTIFICATION_LABELS).map(([value, label]) => (
                    <SelectItem hideIndicator key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            }
          />
        ) : null}
        <SettingsRow
          {...searchableSetting("word-wrap")}
          description="Wrap long lines in code blocks, tables, diffs, and file previews by default."
          resetAction={
            settings.wordWrap !== DEFAULT_UNIFIED_SETTINGS.wordWrap ? (
              <SettingResetButton
                label="word wrapping"
                onClick={() => updateSettings({ wordWrap: DEFAULT_UNIFIED_SETTINGS.wordWrap })}
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.wordWrap}
              onCheckedChange={(checked) => updateSettings({ wordWrap: Boolean(checked) })}
              aria-label="Wrap code, tables, diffs, and file previews by default"
            />
          }
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}

export function GeneralSettingsPanel() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const lastEnabledProjectGroupingMode = useRef<SidebarProjectGroupingMode>(
    readLastEnabledProjectGroupingMode(),
  );
  const observability = useAtomValue(primaryServerObservabilityAtom);
  const serverProviders = useAtomValue(primaryServerProvidersAtom);
  const primaryEnvironment = usePrimaryEnvironment();
  const environmentId = primaryEnvironment?.environmentId ?? null;
  const scanCursorLocalHistory = useAtomCommand(serverEnvironment.cursorLocalHistoryDryRun, {
    reportFailure: false,
  });
  const importCursorLocalHistory = useAtomCommand(serverEnvironment.cursorLocalHistoryImport, {
    reportFailure: false,
  });
  const scanClaudeLocalHistory = useAtomCommand(serverEnvironment.claudeLocalHistoryDryRun, {
    reportFailure: false,
  });
  const importClaudeLocalHistory = useAtomCommand(serverEnvironment.claudeLocalHistoryImport, {
    reportFailure: false,
  });
  const syncLocalHistory = useAtomCommand(serverEnvironment.localHistorySyncNow, {
    reportFailure: false,
  });
  const [cursorHistoryDryRun, setCursorHistoryDryRun] =
    useState<CursorLocalHistoryDryRunResult | null>(null);
  const [cursorHistoryImport, setCursorHistoryImport] =
    useState<CursorLocalHistoryImportResult | null>(null);
  const [cursorHistoryImportProgress, setCursorHistoryImportProgress] = useState<{
    readonly completed: number;
    readonly total: number;
  } | null>(null);
  const [isScanningCursorHistory, setIsScanningCursorHistory] = useState(false);
  const [isImportingCursorHistory, setIsImportingCursorHistory] = useState(false);
  const [cursorHistoryError, setCursorHistoryError] = useState<string | null>(null);
  const [claudeHistoryDryRun, setClaudeHistoryDryRun] =
    useState<ClaudeLocalHistoryDryRunResult | null>(null);
  const [claudeHistoryImport, setClaudeHistoryImport] =
    useState<ClaudeLocalHistoryImportResult | null>(null);
  const [claudeHistoryImportProgress, setClaudeHistoryImportProgress] = useState<{
    readonly completed: number;
    readonly total: number;
  } | null>(null);
  const [isScanningClaudeHistory, setIsScanningClaudeHistory] = useState(false);
  const [isImportingClaudeHistory, setIsImportingClaudeHistory] = useState(false);
  const [claudeHistoryError, setClaudeHistoryError] = useState<string | null>(null);
  const [localHistorySyncResult, setLocalHistorySyncResult] =
    useState<LocalHistorySyncResult | null>(null);
  const [isSyncingLocalHistory, setIsSyncingLocalHistory] = useState(false);
  const [localHistorySyncError, setLocalHistorySyncError] = useState<string | null>(null);
  const diagnosticsDescription = formatDiagnosticsDescription({
    localTracingEnabled: observability?.localTracingEnabled ?? false,
    otlpTracesEnabled: observability?.otlpTracesEnabled ?? false,
    otlpTracesUrl: observability?.otlpTracesUrl,
    otlpMetricsEnabled: observability?.otlpMetricsEnabled ?? false,
    otlpMetricsUrl: observability?.otlpMetricsUrl,
  });

  const textGenerationModelSelection = resolveAppModelSelectionState(settings, serverProviders);
  const textGenInstanceId = textGenerationModelSelection.instanceId;
  const textGenModel = textGenerationModelSelection.model;
  const textGenModelOptions = textGenerationModelSelection.options;
  const gitModelInstanceEntries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(deriveProviderInstanceEntries(serverProviders), settings),
  );
  const textGenInstanceEntry = gitModelInstanceEntries.find(
    (entry) => entry.instanceId === textGenInstanceId,
  );
  const textGenProvider: ProviderDriverKind =
    textGenInstanceEntry?.driverKind ?? DEFAULT_DRIVER_KIND;
  const gitModelOptionsByInstance = getCustomModelOptionsByInstance(
    settings,
    serverProviders,
    textGenInstanceId,
    textGenModel,
  );
  const isGitWritingModelDirty = !Equal.equals(
    settings.textGenerationModelSelection ?? null,
    DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection ?? null,
  );
  const scanCursorHistory = useCallback(() => {
    if (environmentId === null) {
      setCursorHistoryError("No environment is selected.");
      return;
    }
    setIsScanningCursorHistory(true);
    setCursorHistoryError(null);
    void (async () => {
      const result = await scanCursorLocalHistory({
        environmentId,
        input: {},
      });
      setIsScanningCursorHistory(false);
      if (result._tag === "Failure") {
        if (isAtomCommandInterrupted(result)) return;
        const error = squashAtomCommandFailure(result);
        const message = error instanceof Error ? error.message : "Cursor history scan failed.";
        setCursorHistoryError(message);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not scan Cursor history",
            description: message,
          }),
        );
        return;
      }
      setCursorHistoryDryRun(result.value);
    })();
  }, [environmentId, scanCursorLocalHistory]);
  const importCursorHistory = useCallback(() => {
    if (environmentId === null) {
      setCursorHistoryError("No environment is selected.");
      return;
    }
    setIsImportingCursorHistory(true);
    setCursorHistoryImportProgress({ completed: 0, total: cursorHistoryDryRun?.chatCount ?? 0 });
    setCursorHistoryError(null);
    void (async () => {
      let offset = 0;
      let total = cursorHistoryDryRun?.chatCount ?? 0;
      let aggregate: CursorLocalHistoryImportResult = {
        totalCandidateCount: total,
        importedCandidateOffset: 0,
        importedCandidateLimit: 0,
        importedProjectCount: 0,
        importedThreadCount: 0,
        importedMessageCount: 0,
        skippedChatCount: 0,
        errors: [],
        threads: [],
      };

      try {
        do {
          const batch = await importCursorLocalHistory({
            environmentId,
            input: {
              offset,
              limit: CURSOR_HISTORY_IMPORT_BATCH_SIZE,
            },
          });
          if (batch._tag === "Failure") {
            if (isAtomCommandInterrupted(batch)) return;
            throw squashAtomCommandFailure(batch);
          }
          const result = batch.value;
          total = result.totalCandidateCount;
          const completed = Math.min(
            result.totalCandidateCount,
            result.importedCandidateOffset + result.importedCandidateLimit,
          );
          aggregate = {
            totalCandidateCount: result.totalCandidateCount,
            importedCandidateOffset: 0,
            importedCandidateLimit: completed,
            importedProjectCount: aggregate.importedProjectCount + result.importedProjectCount,
            importedThreadCount: aggregate.importedThreadCount + result.importedThreadCount,
            importedMessageCount: aggregate.importedMessageCount + result.importedMessageCount,
            skippedChatCount: aggregate.skippedChatCount + result.skippedChatCount,
            errors: [...aggregate.errors, ...result.errors],
            threads: [...aggregate.threads, ...result.threads],
          };
          setCursorHistoryImport(aggregate);
          setCursorHistoryImportProgress({ completed, total });
          offset = completed;
        } while (offset < total);

        toastManager.add(
          stackedThreadToast({
            type: "success",
            title: "Cursor history imported",
            description: `${formatCursorHistoryNumber(aggregate.importedThreadCount)} chats and ${formatCursorHistoryNumber(aggregate.importedMessageCount)} messages are now T3 threads.`,
          }),
        );
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : "Cursor history import failed.";
        setCursorHistoryError(message);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not import Cursor history",
            description: message,
          }),
        );
      } finally {
        setIsImportingCursorHistory(false);
        setCursorHistoryImportProgress(null);
      }
    })();
  }, [cursorHistoryDryRun?.chatCount, environmentId, importCursorLocalHistory]);

  const scanClaudeHistory = useCallback(() => {
    if (environmentId === null) {
      setClaudeHistoryError("No environment is selected.");
      return;
    }
    setIsScanningClaudeHistory(true);
    setClaudeHistoryError(null);
    void (async () => {
      const result = await scanClaudeLocalHistory({
        environmentId,
        input: {},
      });
      setIsScanningClaudeHistory(false);
      if (result._tag === "Failure") {
        if (isAtomCommandInterrupted(result)) return;
        const error = squashAtomCommandFailure(result);
        const message = error instanceof Error ? error.message : "Claude history scan failed.";
        setClaudeHistoryError(message);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not scan Claude history",
            description: message,
          }),
        );
        return;
      }
      setClaudeHistoryDryRun(result.value);
    })();
  }, [environmentId, scanClaudeLocalHistory]);

  const importClaudeHistory = useCallback(() => {
    if (environmentId === null) {
      setClaudeHistoryError("No environment is selected.");
      return;
    }
    setIsImportingClaudeHistory(true);
    setClaudeHistoryImportProgress({ completed: 0, total: claudeHistoryDryRun?.chatCount ?? 0 });
    setClaudeHistoryError(null);
    void (async () => {
      let offset = 0;
      let total = claudeHistoryDryRun?.chatCount ?? 0;
      let aggregate: ClaudeLocalHistoryImportResult = {
        totalCandidateCount: total,
        importedCandidateOffset: 0,
        importedCandidateLimit: 0,
        importedProjectCount: 0,
        importedThreadCount: 0,
        importedMessageCount: 0,
        skippedChatCount: 0,
        errors: [],
        threads: [],
      };

      try {
        do {
          const batch = await importClaudeLocalHistory({
            environmentId,
            input: {
              offset,
              limit: CLAUDE_HISTORY_IMPORT_BATCH_SIZE,
            },
          });
          if (batch._tag === "Failure") {
            if (isAtomCommandInterrupted(batch)) return;
            throw squashAtomCommandFailure(batch);
          }
          const result = batch.value;
          total = result.totalCandidateCount;
          const completed = Math.min(
            result.totalCandidateCount,
            result.importedCandidateOffset + result.importedCandidateLimit,
          );
          aggregate = {
            totalCandidateCount: result.totalCandidateCount,
            importedCandidateOffset: 0,
            importedCandidateLimit: completed,
            importedProjectCount: aggregate.importedProjectCount + result.importedProjectCount,
            importedThreadCount: aggregate.importedThreadCount + result.importedThreadCount,
            importedMessageCount: aggregate.importedMessageCount + result.importedMessageCount,
            skippedChatCount: aggregate.skippedChatCount + result.skippedChatCount,
            errors: [...aggregate.errors, ...result.errors],
            threads: [...aggregate.threads, ...result.threads],
          };
          setClaudeHistoryImport(aggregate);
          setClaudeHistoryImportProgress({ completed, total });
          offset = completed;
        } while (offset < total);

        toastManager.add(
          stackedThreadToast({
            type: "success",
            title: "Claude history imported",
            description: `${formatCursorHistoryNumber(aggregate.importedThreadCount)} chats and ${formatCursorHistoryNumber(aggregate.importedMessageCount)} messages are now T3 threads.`,
          }),
        );
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : "Claude history import failed.";
        setClaudeHistoryError(message);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not import Claude history",
            description: message,
          }),
        );
      } finally {
        setIsImportingClaudeHistory(false);
        setClaudeHistoryImportProgress(null);
      }
    })();
  }, [claudeHistoryDryRun?.chatCount, environmentId, importClaudeLocalHistory]);

  const syncLocalHistoryNow = useCallback(() => {
    if (environmentId === null) {
      setLocalHistorySyncError("No environment is selected.");
      return;
    }
    setIsSyncingLocalHistory(true);
    setLocalHistorySyncError(null);
    void (async () => {
      const result = await syncLocalHistory({
        environmentId,
        input: {},
      });
      setIsSyncingLocalHistory(false);
      if (result._tag === "Failure") {
        if (isAtomCommandInterrupted(result)) return;
        const error = squashAtomCommandFailure(result);
        const message = error instanceof Error ? error.message : "Local history sync failed.";
        setLocalHistorySyncError(message);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not sync local history",
            description: message,
          }),
        );
        return;
      }
      setLocalHistorySyncResult(result.value);
      const importedMessageCount =
        result.value.cursor.importedMessageCount + result.value.claude.importedMessageCount;
      const writebackMessageCount =
        result.value.cursor.writebackMessageCount + result.value.claude.writebackMessageCount;
      toastManager.add(
        stackedThreadToast({
          type: "success",
          title: "Local history synced",
          description: `${formatCursorHistoryNumber(importedMessageCount)} new messages imported${
            result.value.writebackEnabled
              ? ` and ${formatCursorHistoryNumber(writebackMessageCount)} written back`
              : ""
          }.`,
        }),
      );
    })();
  }, [environmentId, syncLocalHistory]);

  const localHistorySyncEnabled = Duration.toMillis(settings.localHistorySyncInterval) > 0;
  const localHistorySyncErrorCount = localHistorySyncResult
    ? localHistorySyncResult.cursor.importErrorCount +
      localHistorySyncResult.cursor.writebackErrorCount +
      localHistorySyncResult.claude.importErrorCount +
      localHistorySyncResult.claude.writebackErrorCount
    : 0;
  const backgroundActivityProfile = resolveServerBackgroundActivitySettings(settings).profile;

  return (
    <SettingsPageContainer>
      <SettingsSection title="General">
        <SettingsRow
          title="Project Grouping"
          description="Combine matching repositories across environments."
          resetAction={
            settings.sidebarProjectGroupingMode !==
            DEFAULT_UNIFIED_SETTINGS.sidebarProjectGroupingMode ? (
              <SettingResetButton
                label="project grouping"
                onClick={() =>
                  updateSettings({
                    sidebarProjectGroupingMode: DEFAULT_UNIFIED_SETTINGS.sidebarProjectGroupingMode,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={isProjectGroupingEnabled(settings.sidebarProjectGroupingMode)}
              onCheckedChange={(checked) => {
                if (!checked && settings.sidebarProjectGroupingMode !== "separate") {
                  lastEnabledProjectGroupingMode.current = settings.sidebarProjectGroupingMode;
                  rememberEnabledProjectGroupingMode(settings.sidebarProjectGroupingMode);
                }
                updateSettings({
                  sidebarProjectGroupingMode: projectGroupingModeFromToggle(
                    checked,
                    lastEnabledProjectGroupingMode.current,
                  ),
                });
              }}
              aria-label="Project Grouping"
            />
          }
        />

        <SettingsRow
          title="Time format"
          description="System default follows your browser or OS clock preference."
          resetAction={
            settings.timestampFormat !== DEFAULT_UNIFIED_SETTINGS.timestampFormat ? (
              <SettingResetButton
                label="time format"
                onClick={() =>
                  updateSettings({
                    timestampFormat: DEFAULT_UNIFIED_SETTINGS.timestampFormat,
                  })
                }
              />
            ) : null
          }
          control={
            <Select
              value={settings.timestampFormat}
              onValueChange={(value) => {
                if (value === "locale" || value === "12-hour" || value === "24-hour") {
                  updateSettings({ timestampFormat: value });
                }
              }}
            >
              <SelectTrigger className="w-full sm:w-40" aria-label="Timestamp format">
                <SelectValue>{TIMESTAMP_FORMAT_LABELS[settings.timestampFormat]}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value="locale">
                  {TIMESTAMP_FORMAT_LABELS.locale}
                </SelectItem>
                <SelectItem hideIndicator value="12-hour">
                  {TIMESTAMP_FORMAT_LABELS["12-hour"]}
                </SelectItem>
                <SelectItem hideIndicator value="24-hour">
                  {TIMESTAMP_FORMAT_LABELS["24-hour"]}
                </SelectItem>
              </SelectPopup>
            </Select>
          }
        />

        <SettingsRow
          title="Word wrap"
          description="Wrap long lines in code blocks, tables, diffs, and file previews by default."
          resetAction={
            settings.wordWrap !== DEFAULT_UNIFIED_SETTINGS.wordWrap ? (
              <SettingResetButton
                label="word wrapping"
                onClick={() =>
                  updateSettings({
                    wordWrap: DEFAULT_UNIFIED_SETTINGS.wordWrap,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.wordWrap}
              onCheckedChange={(checked) => updateSettings({ wordWrap: Boolean(checked) })}
              aria-label="Wrap code, tables, diffs, and file previews by default"
            />
          }
        />

        <SettingsRow
          title="Hide whitespace changes"
          description="Set whether the diff panel ignores whitespace-only edits by default."
          resetAction={
            settings.diffIgnoreWhitespace !== DEFAULT_UNIFIED_SETTINGS.diffIgnoreWhitespace ? (
              <SettingResetButton
                label="diff whitespace changes"
                onClick={() =>
                  updateSettings({
                    diffIgnoreWhitespace: DEFAULT_UNIFIED_SETTINGS.diffIgnoreWhitespace,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.diffIgnoreWhitespace}
              onCheckedChange={(checked) =>
                updateSettings({ diffIgnoreWhitespace: Boolean(checked) })
              }
              aria-label="Hide whitespace changes by default"
            />
          }
        />

        <SettingsRow
          title="Assistant output"
          description="Show token-by-token output while a response is in progress."
          resetAction={
            settings.enableAssistantStreaming !==
            DEFAULT_UNIFIED_SETTINGS.enableAssistantStreaming ? (
              <SettingResetButton
                label="assistant output"
                onClick={() =>
                  updateSettings({
                    enableAssistantStreaming: DEFAULT_UNIFIED_SETTINGS.enableAssistantStreaming,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.enableAssistantStreaming}
              onCheckedChange={(checked) =>
                updateSettings({ enableAssistantStreaming: Boolean(checked) })
              }
              aria-label="Stream assistant messages"
            />
          }
        />

        <SettingsRow
          title="Provider update checks"
          description="Check installed provider CLIs for newer available versions."
          resetAction={
            settings.enableProviderUpdateChecks !==
            DEFAULT_UNIFIED_SETTINGS.enableProviderUpdateChecks ? (
              <SettingResetButton
                label="provider update checks"
                onClick={() =>
                  updateSettings({
                    enableProviderUpdateChecks: DEFAULT_UNIFIED_SETTINGS.enableProviderUpdateChecks,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.enableProviderUpdateChecks}
              onCheckedChange={(checked) =>
                updateSettings({ enableProviderUpdateChecks: Boolean(checked) })
              }
              aria-label="Check provider versions"
            />
          }
        />

        <SettingsRow
          title="Background activity"
          description={BACKGROUND_ACTIVITY_PROFILE_DESCRIPTIONS[backgroundActivityProfile]}
          resetAction={
            !Equal.equals(
              settings.backgroundActivity,
              DEFAULT_UNIFIED_SETTINGS.backgroundActivity,
            ) ? (
              <SettingResetButton
                label="background activity"
                onClick={() =>
                  updateSettings({
                    backgroundActivity: DEFAULT_UNIFIED_SETTINGS.backgroundActivity,
                  })
                }
              />
            ) : null
          }
          control={
            <Select
              value={backgroundActivityProfile}
              onValueChange={(value) => {
                if (value === "balanced" || value === "performance" || value === "battery-saver") {
                  updateSettings(backgroundActivityProfileSettings(value));
                }
              }}
            >
              <SelectTrigger className="w-full sm:w-40" aria-label="Background activity profile">
                <SelectValue>
                  {BACKGROUND_ACTIVITY_PROFILE_LABELS[backgroundActivityProfile]}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {Object.entries(BACKGROUND_ACTIVITY_PROFILE_LABELS).map(([value, label]) => (
                  <SelectItem hideIndicator key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />

        <SettingsRow
          title="Auto-open task panel"
          description="Open the right-side plan and task panel automatically when steps appear."
          resetAction={
            settings.autoOpenPlanSidebar !== DEFAULT_UNIFIED_SETTINGS.autoOpenPlanSidebar ? (
              <SettingResetButton
                label="auto-open task panel"
                onClick={() =>
                  updateSettings({
                    autoOpenPlanSidebar: DEFAULT_UNIFIED_SETTINGS.autoOpenPlanSidebar,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.autoOpenPlanSidebar}
              onCheckedChange={(checked) =>
                updateSettings({ autoOpenPlanSidebar: Boolean(checked) })
              }
              aria-label="Open the task panel automatically"
            />
          }
        />

        <SettingsRow
          title="New threads"
          description="Pick the default workspace mode for newly created draft threads."
          resetAction={
            settings.defaultThreadEnvMode !== DEFAULT_UNIFIED_SETTINGS.defaultThreadEnvMode ||
            settings.newWorktreesStartFromOrigin !==
              DEFAULT_UNIFIED_SETTINGS.newWorktreesStartFromOrigin ? (
              <SettingResetButton
                label="new threads"
                onClick={() =>
                  updateSettings({
                    defaultThreadEnvMode: DEFAULT_UNIFIED_SETTINGS.defaultThreadEnvMode,
                    newWorktreesStartFromOrigin:
                      DEFAULT_UNIFIED_SETTINGS.newWorktreesStartFromOrigin,
                  })
                }
              />
            ) : null
          }
          control={
            <Select
              value={settings.defaultThreadEnvMode}
              onValueChange={(value) => {
                if (value === "local" || value === "worktree") {
                  updateSettings({ defaultThreadEnvMode: value });
                }
              }}
            >
              <SelectTrigger className="w-full sm:w-44" aria-label="Default thread mode">
                <SelectValue>
                  {settings.defaultThreadEnvMode === "worktree" ? "New worktree" : "Local"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value="local">
                  Local
                </SelectItem>
                <SelectItem hideIndicator value="worktree">
                  New worktree
                </SelectItem>
              </SelectPopup>
            </Select>
          }
        />

        {settings.defaultThreadEnvMode === "worktree" ? (
          <SettingsRow
            className="bg-muted/20 sm:pl-9"
            title="Start from origin"
            description="Creates the worktree from the latest matching branch on origin instead of your local branch."
            resetAction={
              settings.newWorktreesStartFromOrigin !==
              DEFAULT_UNIFIED_SETTINGS.newWorktreesStartFromOrigin ? (
                <SettingResetButton
                  label="new worktrees start from origin"
                  onClick={() =>
                    updateSettings({
                      newWorktreesStartFromOrigin:
                        DEFAULT_UNIFIED_SETTINGS.newWorktreesStartFromOrigin,
                    })
                  }
                />
              ) : null
            }
            control={
              <Switch
                checked={settings.newWorktreesStartFromOrigin}
                onCheckedChange={(checked) =>
                  updateSettings({ newWorktreesStartFromOrigin: Boolean(checked) })
                }
                aria-label="Start new worktrees from origin by default"
              />
            }
          />
        ) : null}

        <SettingsRow
          title="Add project starts in"
          description='Leave empty to use "~/" when the Add Project browser opens.'
          resetAction={
            settings.addProjectBaseDirectory !==
            DEFAULT_UNIFIED_SETTINGS.addProjectBaseDirectory ? (
              <SettingResetButton
                label="add project base directory"
                onClick={() =>
                  updateSettings({
                    addProjectBaseDirectory: DEFAULT_UNIFIED_SETTINGS.addProjectBaseDirectory,
                  })
                }
              />
            ) : null
          }
          control={
            <DraftInput
              className="w-full sm:w-72"
              value={settings.addProjectBaseDirectory}
              onCommit={(next) => updateSettings({ addProjectBaseDirectory: next })}
              placeholder="~/"
              spellCheck={false}
              aria-label="Add project base directory"
            />
          }
        />

        <SettingsRow
          title="Archive confirmation"
          description="Require a second click on the inline archive action before a thread is archived."
          resetAction={
            settings.confirmThreadArchive !== DEFAULT_UNIFIED_SETTINGS.confirmThreadArchive ? (
              <SettingResetButton
                label="archive confirmation"
                onClick={() =>
                  updateSettings({
                    confirmThreadArchive: DEFAULT_UNIFIED_SETTINGS.confirmThreadArchive,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.confirmThreadArchive}
              onCheckedChange={(checked) =>
                updateSettings({ confirmThreadArchive: Boolean(checked) })
              }
              aria-label="Confirm thread archiving"
            />
          }
        />

        <SettingsRow
          title="Delete confirmation"
          description="Ask before deleting a thread and its chat history."
          resetAction={
            settings.confirmThreadDelete !== DEFAULT_UNIFIED_SETTINGS.confirmThreadDelete ? (
              <SettingResetButton
                label="delete confirmation"
                onClick={() =>
                  updateSettings({
                    confirmThreadDelete: DEFAULT_UNIFIED_SETTINGS.confirmThreadDelete,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.confirmThreadDelete}
              onCheckedChange={(checked) =>
                updateSettings({ confirmThreadDelete: Boolean(checked) })
              }
              aria-label="Confirm thread deletion"
            />
          }
        />

        <SettingsRow
          title="Text generation model"
          description="Configure the model used for generated commit messages, PR titles, and similar Git text."
          resetAction={
            isGitWritingModelDirty ? (
              <SettingResetButton
                label="text generation model"
                onClick={() =>
                  updateSettings({
                    textGenerationModelSelection:
                      DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection,
                  })
                }
              />
            ) : null
          }
          control={
            <div className="flex flex-wrap items-center justify-end gap-1.5">
              <ProviderModelPicker
                activeInstanceId={textGenInstanceId}
                model={textGenModel}
                lockedProvider={null}
                instanceEntries={gitModelInstanceEntries}
                modelOptionsByInstance={gitModelOptionsByInstance}
                triggerVariant="outline"
                triggerClassName="min-w-0 max-w-none shrink-0 text-foreground/90 hover:text-foreground"
                onInstanceModelChange={(instanceId, model) => {
                  updateSettings({
                    textGenerationModelSelection: resolveAppModelSelectionState(
                      {
                        ...settings,
                        textGenerationModelSelection: createModelSelection(instanceId, model),
                      },
                      serverProviders,
                    ),
                  });
                }}
              />
              <TraitsPicker
                provider={textGenProvider}
                models={
                  // Use the exact instance's models (rather than the
                  // first-kind-match) so a custom text-gen instance like
                  // `codex_personal` gets its own model list, not the
                  // default Codex one.
                  textGenInstanceEntry?.models ?? []
                }
                model={textGenModel}
                prompt=""
                onPromptChange={() => {}}
                modelOptions={textGenModelOptions}
                allowPromptInjectedEffort={false}
                triggerVariant="outline"
                triggerClassName="min-w-0 max-w-none shrink-0 text-foreground/90 hover:text-foreground"
                onModelOptionsChange={(nextOptions) => {
                  updateSettings({
                    textGenerationModelSelection: resolveAppModelSelectionState(
                      {
                        ...settings,
                        textGenerationModelSelection: createModelSelection(
                          textGenInstanceId,
                          textGenModel,
                          nextOptions,
                        ),
                      },
                      serverProviders,
                    ),
                  });
                }}
              />
            </div>
          }
        />
      </SettingsSection>

      <SettingsSection title="Cursor history">
        <SettingsRow
          title="Local Cursor runs"
          description="Dry-run scan local Cursor agent/composer history. This reads Cursor files only; it does not import or write anything yet."
          status={
            cursorHistoryImportProgress ? (
              <>
                Importing{" "}
                <span className="font-mono tabular-nums">
                  {formatCursorHistoryNumber(cursorHistoryImportProgress.completed)}
                </span>{" "}
                /{" "}
                <span className="font-mono tabular-nums">
                  {formatCursorHistoryNumber(cursorHistoryImportProgress.total)}
                </span>{" "}
                chats.
              </>
            ) : cursorHistoryImport ? (
              <>
                Imported{" "}
                <span className="font-mono tabular-nums">
                  {formatCursorHistoryNumber(cursorHistoryImport.importedThreadCount)}
                </span>{" "}
                chats and{" "}
                <span className="font-mono tabular-nums">
                  {formatCursorHistoryNumber(cursorHistoryImport.importedMessageCount)}
                </span>{" "}
                messages. They are now normal T3 threads.
              </>
            ) : cursorHistoryDryRun ? (
              <>
                Last scan found{" "}
                <span className="font-mono tabular-nums">
                  {formatCursorHistoryNumber(cursorHistoryDryRun.chatCount)}
                </span>{" "}
                chats across{" "}
                <span className="font-mono tabular-nums">
                  {formatCursorHistoryNumber(cursorHistoryDryRun.workspaceCount)}
                </span>{" "}
                workspaces.
              </>
            ) : cursorHistoryError ? (
              <span className="text-destructive/80">{cursorHistoryError}</span>
            ) : (
              "Run a dry scan to preview what T3 Code can see."
            )
          }
          control={
            <div className="flex items-center gap-2">
              <Button
                size="xs"
                variant="outline"
                onClick={scanCursorHistory}
                disabled={isScanningCursorHistory || isImportingCursorHistory}
              >
                {isScanningCursorHistory ? (
                  <LoaderIcon className="size-3 animate-spin" />
                ) : (
                  <RefreshCwIcon className="size-3" />
                )}
                {isScanningCursorHistory ? "Scanning" : "Scan"}
              </Button>
              <Button
                size="xs"
                variant="default"
                onClick={importCursorHistory}
                disabled={isScanningCursorHistory || isImportingCursorHistory}
              >
                {isImportingCursorHistory ? <LoaderIcon className="size-3 animate-spin" /> : null}
                {isImportingCursorHistory && cursorHistoryImportProgress
                  ? `${formatCursorHistoryNumber(cursorHistoryImportProgress.completed)} / ${formatCursorHistoryNumber(cursorHistoryImportProgress.total)}`
                  : isImportingCursorHistory
                    ? "Importing"
                    : "Import"}
              </Button>
            </div>
          }
        >
          {cursorHistoryDryRun ? (
            <CursorLocalHistoryDryRunDetails result={cursorHistoryDryRun} />
          ) : null}
          {cursorHistoryImport ? (
            <div className="mt-3 rounded-xl border border-border/60 bg-muted/25 p-3 text-xs text-muted-foreground">
              {cursorHistoryImportProgress ? (
                <div className="mb-1">
                  Importing batch {formatCursorHistoryNumber(cursorHistoryImportProgress.completed)}{" "}
                  / {formatCursorHistoryNumber(cursorHistoryImportProgress.total)} chats.
                </div>
              ) : null}
              <div>
                Imported {formatCursorHistoryNumber(cursorHistoryImport.importedProjectCount)}{" "}
                projects, {formatCursorHistoryNumber(cursorHistoryImport.importedThreadCount)}{" "}
                threads, and {formatCursorHistoryNumber(cursorHistoryImport.importedMessageCount)}{" "}
                messages.
              </div>
              {cursorHistoryImport.skippedChatCount > 0 ? (
                <div className="mt-1 text-destructive/80">
                  Skipped {formatCursorHistoryNumber(cursorHistoryImport.skippedChatCount)} chats
                  without known workspace paths.
                </div>
              ) : null}
            </div>
          ) : null}
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="Claude history">
        <SettingsRow
          title="Local Claude Code runs"
          description="Scan and import Claude Code sessions from ~/.claude/projects. Claude Desktop cloud chats are not available locally."
          status={
            claudeHistoryImportProgress ? (
              <>
                Importing{" "}
                <span className="font-mono tabular-nums">
                  {formatCursorHistoryNumber(claudeHistoryImportProgress.completed)}
                </span>{" "}
                /{" "}
                <span className="font-mono tabular-nums">
                  {formatCursorHistoryNumber(claudeHistoryImportProgress.total)}
                </span>{" "}
                chats.
              </>
            ) : claudeHistoryImport ? (
              <>
                Imported{" "}
                <span className="font-mono tabular-nums">
                  {formatCursorHistoryNumber(claudeHistoryImport.importedThreadCount)}
                </span>{" "}
                chats and{" "}
                <span className="font-mono tabular-nums">
                  {formatCursorHistoryNumber(claudeHistoryImport.importedMessageCount)}
                </span>{" "}
                messages. They are now normal T3 threads.
              </>
            ) : claudeHistoryDryRun ? (
              <>
                Last scan found{" "}
                <span className="font-mono tabular-nums">
                  {formatCursorHistoryNumber(claudeHistoryDryRun.chatCount)}
                </span>{" "}
                chats across{" "}
                <span className="font-mono tabular-nums">
                  {formatCursorHistoryNumber(claudeHistoryDryRun.workspaceCount)}
                </span>{" "}
                workspaces.
              </>
            ) : claudeHistoryError ? (
              <span className="text-destructive/80">{claudeHistoryError}</span>
            ) : (
              "Run a dry scan to preview Claude Code history."
            )
          }
          control={
            <div className="flex items-center gap-2">
              <Button
                size="xs"
                variant="outline"
                onClick={scanClaudeHistory}
                disabled={isScanningClaudeHistory || isImportingClaudeHistory}
              >
                {isScanningClaudeHistory ? (
                  <LoaderIcon className="size-3 animate-spin" />
                ) : (
                  <RefreshCwIcon className="size-3" />
                )}
                {isScanningClaudeHistory ? "Scanning" : "Scan"}
              </Button>
              <Button
                size="xs"
                variant="default"
                onClick={importClaudeHistory}
                disabled={isScanningClaudeHistory || isImportingClaudeHistory}
              >
                {isImportingClaudeHistory ? <LoaderIcon className="size-3 animate-spin" /> : null}
                {isImportingClaudeHistory && claudeHistoryImportProgress
                  ? `${formatCursorHistoryNumber(claudeHistoryImportProgress.completed)} / ${formatCursorHistoryNumber(claudeHistoryImportProgress.total)}`
                  : isImportingClaudeHistory
                    ? "Importing"
                    : "Import"}
              </Button>
            </div>
          }
        >
          {claudeHistoryDryRun ? (
            <ClaudeLocalHistoryDryRunDetails result={claudeHistoryDryRun} />
          ) : null}
          {claudeHistoryImport ? (
            <div className="mt-3 rounded-xl border border-border/60 bg-muted/25 p-3 text-xs text-muted-foreground">
              {claudeHistoryImportProgress ? (
                <div className="mb-1">
                  Importing batch {formatCursorHistoryNumber(claudeHistoryImportProgress.completed)}{" "}
                  / {formatCursorHistoryNumber(claudeHistoryImportProgress.total)} chats.
                </div>
              ) : null}
              <div>
                Imported {formatCursorHistoryNumber(claudeHistoryImport.importedProjectCount)}{" "}
                projects, {formatCursorHistoryNumber(claudeHistoryImport.importedThreadCount)}{" "}
                threads, and {formatCursorHistoryNumber(claudeHistoryImport.importedMessageCount)}{" "}
                messages.
              </div>
              {claudeHistoryImport.skippedChatCount > 0 ? (
                <div className="mt-1 text-destructive/80">
                  Skipped {formatCursorHistoryNumber(claudeHistoryImport.skippedChatCount)} chats
                  without known workspace paths.
                </div>
              ) : null}
            </div>
          ) : null}
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="Local history sync">
        <SettingsRow
          title="Daily background sync"
          description="Once a day, pull new messages from already-imported Cursor and Claude Code chats into their T3 threads. Imports are incremental; unchanged chats are left alone."
          control={
            <Switch
              checked={localHistorySyncEnabled}
              onCheckedChange={(checked) =>
                updateSettings({
                  localHistorySyncInterval: checked
                    ? DAILY_LOCAL_HISTORY_SYNC_INTERVAL
                    : Duration.zero,
                })
              }
              aria-label="Toggle daily local history sync"
            />
          }
        />
        <SettingsRow
          title="Write back to Cursor/Claude files"
          description="Append T3-only messages to the original transcript files (Cursor agent-transcripts and ~/.claude/projects session files). This modifies Cursor and Claude Code history on disk — leave off unless you want two-way sync."
          control={
            <Switch
              checked={settings.localHistorySyncWriteback}
              onCheckedChange={(checked) => updateSettings({ localHistorySyncWriteback: checked })}
              aria-label="Toggle local history writeback"
            />
          }
        />
        <SettingsRow
          title="Sync now"
          description="Run an incremental sync of both sources immediately."
          status={
            isSyncingLocalHistory ? (
              "Syncing local history..."
            ) : localHistorySyncError ? (
              <span className="text-destructive/80">{localHistorySyncError}</span>
            ) : localHistorySyncResult ? (
              <>
                Last sync imported{" "}
                <span className="font-mono tabular-nums">
                  {formatCursorHistoryNumber(
                    localHistorySyncResult.cursor.importedMessageCount +
                      localHistorySyncResult.claude.importedMessageCount,
                  )}
                </span>{" "}
                messages
                {localHistorySyncResult.writebackEnabled ? (
                  <>
                    {" "}
                    and wrote back{" "}
                    <span className="font-mono tabular-nums">
                      {formatCursorHistoryNumber(
                        localHistorySyncResult.cursor.writebackMessageCount +
                          localHistorySyncResult.claude.writebackMessageCount,
                      )}
                    </span>
                  </>
                ) : null}
                .
                {localHistorySyncErrorCount > 0 ? (
                  <span className="text-destructive/80">
                    {" "}
                    {formatCursorHistoryNumber(localHistorySyncErrorCount)} errors.
                  </span>
                ) : null}
              </>
            ) : (
              "Runs the same incremental import as the scheduled sync."
            )
          }
          control={
            <Button
              size="xs"
              variant="outline"
              onClick={syncLocalHistoryNow}
              disabled={isSyncingLocalHistory}
            >
              {isSyncingLocalHistory ? (
                <LoaderIcon className="size-3 animate-spin" />
              ) : (
                <RefreshCwIcon className="size-3" />
              )}
              {isSyncingLocalHistory ? "Syncing" : "Sync now"}
            </Button>
          }
        />
      </SettingsSection>

      <SettingsSection title="About">
        {isElectron || HOSTED_APP_CHANNEL ? (
          <AboutVersionSection />
        ) : (
          <SettingsRow
            title={<AboutVersionTitle />}
            description="Current version of the application."
          />
        )}
        <SettingsRow
          title="Diagnostics"
          description={diagnosticsDescription}
          control={
            <Button render={<Link to="/settings/diagnostics" />} size="xs" variant="outline">
              View diagnostics
            </Button>
          }
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}

export function ProviderSettingsPanel() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const serverProviders = useAtomValue(primaryServerProvidersAtom);
  const primaryEnvironment = usePrimaryEnvironment();
  const refreshServerProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const updateProvider = useAtomCommand(serverEnvironment.updateProvider, {
    reportFailure: false,
  });
  const [isRefreshingProviders, setIsRefreshingProviders] = useState(false);
  const [isAddInstanceDialogOpen, setIsAddInstanceDialogOpen] = useState(false);
  const [updatingProviderDrivers, setUpdatingProviderDrivers] = useState<
    ReadonlySet<ProviderDriverKind>
  >(() => new Set());
  const [openInstanceDetails, setOpenInstanceDetails] = useState<Record<string, boolean>>({});
  const refreshingRef = useRef(false);

  const providerUpdateCandidates = useMemo(
    () => collectProviderUpdateCandidates(serverProviders),
    [serverProviders],
  );
  const providerUpdateCandidateByInstanceId = useMemo(
    () => new Map(providerUpdateCandidates.map((candidate) => [candidate.instanceId, candidate])),
    [providerUpdateCandidates],
  );
  const visibleProviderSettings = PROVIDER_SETTINGS.filter(
    (providerSettings) =>
      providerSettings.provider !== "cursor" ||
      serverProviders.some(
        (provider) =>
          provider.instanceId === defaultInstanceIdForDriver(ProviderDriverKind.make("cursor")),
      ),
  );
  const textGenerationModelSelection = resolveAppModelSelectionState(settings, serverProviders);
  const textGenInstanceId = textGenerationModelSelection.instanceId;
  const lastCheckedAt =
    serverProviders.length > 0
      ? serverProviders.reduce(
          (latest, provider) => (provider.checkedAt > latest ? provider.checkedAt : latest),
          serverProviders[0]!.checkedAt,
        )
      : null;

  const refreshProviders = useCallback(() => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    setIsRefreshingProviders(true);
    if (!primaryEnvironment) {
      refreshingRef.current = false;
      setIsRefreshingProviders(false);
      return;
    }
    void (async () => {
      const result = await refreshServerProviders({
        environmentId: primaryEnvironment.environmentId,
        input: {},
      });
      refreshingRef.current = false;
      setIsRefreshingProviders(false);
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        console.warn("Failed to refresh providers", {
          operation: "refresh-providers",
          environmentId: primaryEnvironment.environmentId,
          ...safeErrorLogAttributes(squashAtomCommandFailure(result)),
        });
      }
    })();
  }, [primaryEnvironment, refreshServerProviders]);

  const runProviderUpdate = useCallback(
    async (candidate: ProviderUpdateCandidate) => {
      if (!primaryEnvironment) return;
      let started = false;
      setUpdatingProviderDrivers((previous) => {
        if (previous.has(candidate.driver)) {
          return previous;
        }
        started = true;
        const next = new Set(previous);
        next.add(candidate.driver);
        return next;
      });
      if (!started) {
        return;
      }

      const result = await updateProvider({
        environmentId: primaryEnvironment.environmentId,
        input: {
          provider: candidate.driver,
          instanceId: candidate.instanceId,
        },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: `Could not update ${PROVIDER_DISPLAY_NAMES[candidate.driver] ?? candidate.driver}`,
            description:
              error instanceof Error
                ? error.message
                : "The provider update command could not be started.",
          }),
        );
      }
      setUpdatingProviderDrivers((previous) => {
        if (!previous.has(candidate.driver)) {
          return previous;
        }
        const next = new Set(previous);
        next.delete(candidate.driver);
        return next;
      });
    },
    [primaryEnvironment, updateProvider],
  );

  interface InstanceRow {
    readonly instanceId: ProviderInstanceId;
    readonly instance: ProviderInstanceConfig;
    readonly driver: ProviderDriverKind;
    readonly isDefault: boolean;
    readonly isDirty?: boolean;
  }

  const instancesByDriver = new Map<
    ProviderDriverKind,
    Array<[ProviderInstanceId, ProviderInstanceConfig]>
  >();
  for (const [rawId, instance] of Object.entries(settings.providerInstances ?? {})) {
    const driver = instance.driver;
    const list = instancesByDriver.get(driver) ?? [];
    list.push([rawId as ProviderInstanceId, instance]);
    instancesByDriver.set(driver, list);
  }

  const defaultSlotIdsBySource = new Set<string>(
    visibleProviderSettings.map((providerSettings) =>
      String(defaultInstanceIdForDriver(providerSettings.provider)),
    ),
  );

  const rows: InstanceRow[] = [];
  const visibleDriverKinds = new Set<ProviderDriverKind>(
    visibleProviderSettings.map((providerSettings) => providerSettings.provider),
  );

  for (const providerSettings of visibleProviderSettings) {
    type LegacyProviderSettings = (typeof settings.providers)[keyof typeof settings.providers];
    const legacyProviders = settings.providers as Record<string, LegacyProviderSettings>;
    const defaultLegacyProviders = DEFAULT_UNIFIED_SETTINGS.providers as Record<
      string,
      LegacyProviderSettings
    >;
    const driver = providerSettings.provider;
    const defaultInstanceId = defaultInstanceIdForDriver(driver);
    const explicitInstance = settings.providerInstances?.[defaultInstanceId];
    const legacyConfig = legacyProviders[providerSettings.provider]!;
    const defaultLegacyConfig = defaultLegacyProviders[providerSettings.provider]!;
    const effectiveInstance: ProviderInstanceConfig =
      explicitInstance ??
      ({
        driver,
        enabled: legacyConfig.enabled,
        config: legacyConfig,
      } satisfies ProviderInstanceConfig);
    const isDirty =
      explicitInstance !== undefined || !Equal.equals(legacyConfig, defaultLegacyConfig);
    rows.push({
      instanceId: defaultInstanceId,
      instance: effectiveInstance,
      driver,
      isDefault: true,
      isDirty,
    });
    for (const [id, instance] of instancesByDriver.get(providerSettings.provider) ?? []) {
      if (id === defaultInstanceId) continue;
      rows.push({ instanceId: id, instance, driver: instance.driver, isDefault: false });
    }
  }
  for (const [driver, list] of instancesByDriver) {
    if (visibleDriverKinds.has(driver)) continue;
    for (const [id, instance] of list) {
      rows.push({
        instanceId: id,
        instance,
        driver: instance.driver,
        isDefault: defaultSlotIdsBySource.has(String(id)),
      });
    }
  }

  const updateProviderInstance = (
    row: InstanceRow,
    next: ProviderInstanceConfig,
    options?: {
      readonly textGenerationModelSelection?: Parameters<
        typeof buildProviderInstanceUpdatePatch
      >[0]["textGenerationModelSelection"];
    },
  ) => {
    updateSettings(
      buildProviderInstanceUpdatePatch({
        settings,
        instanceId: row.instanceId,
        instance: next,
        driver: row.driver,
        isDefault: row.isDefault,
        textGenerationModelSelection: options?.textGenerationModelSelection,
      }),
    );
  };

  const deleteProviderInstance = (id: ProviderInstanceId) => {
    updateSettings({
      providerInstances: withoutProviderInstanceKey(settings.providerInstances, id),
      providerModelPreferences: withoutProviderInstanceKey(settings.providerModelPreferences, id),
      favorites: withoutProviderInstanceFavorites(settings.favorites ?? [], id),
    });
  };

  const updateProviderModelPreferences = (
    instanceId: ProviderInstanceId,
    next: {
      readonly hiddenModels: ReadonlyArray<string>;
      readonly modelOrder: ReadonlyArray<string>;
    },
  ) => {
    const hiddenModels = [...new Set(next.hiddenModels.filter((slug) => slug.trim().length > 0))];
    const modelOrder = [...new Set(next.modelOrder.filter((slug) => slug.trim().length > 0))];
    const rest = withoutProviderInstanceKey(settings.providerModelPreferences, instanceId);
    updateSettings({
      providerModelPreferences:
        hiddenModels.length === 0 && modelOrder.length === 0
          ? rest
          : {
              ...rest,
              [instanceId]: {
                hiddenModels,
                modelOrder,
              },
            },
    });
  };

  const updateProviderFavoriteModels = (
    instanceId: ProviderInstanceId,
    nextFavoriteModels: ReadonlyArray<string>,
  ) => {
    const favoriteModels = [
      ...new Set(
        Arr.filterMap(nextFavoriteModels, (slug) => {
          const trimmedSlug = slug.trim();
          return trimmedSlug.length > 0 ? Result.succeed(trimmedSlug) : Result.failVoid;
        }),
      ),
    ];
    updateSettings({
      favorites: [
        ...withoutProviderInstanceFavorites(settings.favorites ?? [], instanceId),
        ...favoriteModels.map((model) => ({ provider: instanceId, model })),
      ],
    });
  };

  const resetDefaultInstance = (driverKind: ProviderDriverKind) => {
    type LegacyProviderSettings = (typeof settings.providers)[keyof typeof settings.providers];
    const defaultLegacyProviders = DEFAULT_UNIFIED_SETTINGS.providers as Record<
      string,
      LegacyProviderSettings | undefined
    >;
    const defaultInstanceId = defaultInstanceIdForDriver(driverKind);
    const defaultLegacyProvider = defaultLegacyProviders[driverKind];
    if (defaultLegacyProvider === undefined) return;
    updateSettings({
      providers: {
        ...settings.providers,
        [driverKind]: defaultLegacyProvider,
      } as typeof settings.providers,
      providerInstances: withoutProviderInstanceKey(settings.providerInstances, defaultInstanceId),
      providerModelPreferences: withoutProviderInstanceKey(
        settings.providerModelPreferences,
        defaultInstanceId,
      ),
      favorites: withoutProviderInstanceFavorites(settings.favorites ?? [], defaultInstanceId),
    });
  };

  return (
    <SettingsPageContainer>
      <SettingsSection
        title="Providers"
        headerAction={
          <div className="flex items-center gap-1.5">
            <ProviderLastChecked lastCheckedAt={lastCheckedAt} />
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    className="size-5 rounded-sm p-0 text-muted-foreground hover:text-foreground"
                    onClick={() => setIsAddInstanceDialogOpen(true)}
                    aria-label="Add provider instance"
                  >
                    <PlusIcon className="size-3" />
                  </Button>
                }
              />
              <TooltipPopup side="top">Add provider instance</TooltipPopup>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    className="size-5 rounded-sm p-0 text-muted-foreground hover:text-foreground"
                    disabled={isRefreshingProviders}
                    onClick={() => void refreshProviders()}
                    aria-label="Refresh provider status"
                  >
                    {isRefreshingProviders ? (
                      <LoaderIcon className="size-3 animate-spin" />
                    ) : (
                      <RefreshCwIcon className="size-3" />
                    )}
                  </Button>
                }
              />
              <TooltipPopup side="top">Refresh provider status</TooltipPopup>
            </Tooltip>
          </div>
        }
      >
        {rows.map((row) => {
          const driverOption = getDriverOption(row.driver);
          const liveProvider = serverProviders.find(
            (candidate) => candidate.instanceId === row.instanceId,
          );
          const updateCandidate = liveProvider
            ? providerUpdateCandidateByInstanceId.get(liveProvider.instanceId)
            : undefined;
          const isDriverUpdateRunning =
            updateCandidate !== undefined &&
            (updatingProviderDrivers.has(updateCandidate.driver) ||
              serverProviders.some(
                (provider) =>
                  provider.driver === updateCandidate.driver && isProviderUpdateActive(provider),
              ));
          const showInlineUpdateButton =
            updateCandidate !== undefined &&
            hasOneClickUpdateProviderCandidate(updateCandidate, serverProviders);
          const canRunInlineUpdate =
            updateCandidate !== undefined &&
            canOneClickUpdateProviderCandidate(updateCandidate, serverProviders) &&
            !updatingProviderDrivers.has(updateCandidate.driver);
          const modelPreferences = settings.providerModelPreferences?.[row.instanceId] ?? {
            hiddenModels: [],
            modelOrder: [],
          };
          const favoriteModels = Arr.filterMap(settings.favorites ?? [], (favorite) =>
            favorite.provider === row.instanceId ? Result.succeed(favorite.model) : Result.failVoid,
          );
          const resetLabel = driverOption?.label ?? String(row.driver);
          const headerAction =
            row.isDefault && row.isDirty ? (
              <SettingResetButton
                label={`${resetLabel} provider settings`}
                onClick={() => resetDefaultInstance(row.driver)}
              />
            ) : null;
          return (
            <ProviderInstanceCard
              key={row.instanceId}
              instanceId={row.instanceId}
              instance={row.instance}
              driverOption={driverOption}
              liveProvider={liveProvider}
              isExpanded={openInstanceDetails[row.instanceId] ?? false}
              onExpandedChange={(open) =>
                setOpenInstanceDetails((existing) => ({
                  ...existing,
                  [row.instanceId]: open,
                }))
              }
              onUpdate={(next) => {
                const wasEnabled = row.instance.enabled ?? true;
                const isDisabling = next.enabled === false && wasEnabled;
                const shouldClearTextGen = isDisabling && textGenInstanceId === row.instanceId;
                if (shouldClearTextGen) {
                  updateProviderInstance(row, next, {
                    textGenerationModelSelection:
                      DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection,
                  });
                } else {
                  updateProviderInstance(row, next);
                }
              }}
              onDelete={row.isDefault ? undefined : () => deleteProviderInstance(row.instanceId)}
              headerAction={headerAction}
              hiddenModels={modelPreferences.hiddenModels}
              favoriteModels={favoriteModels}
              modelOrder={modelPreferences.modelOrder}
              onHiddenModelsChange={(hiddenModels) =>
                updateProviderModelPreferences(row.instanceId, {
                  ...modelPreferences,
                  hiddenModels,
                })
              }
              onFavoriteModelsChange={(favoriteModels) =>
                updateProviderFavoriteModels(row.instanceId, favoriteModels)
              }
              onModelOrderChange={(modelOrder) =>
                updateProviderModelPreferences(row.instanceId, {
                  ...modelPreferences,
                  modelOrder,
                })
              }
              onRunUpdate={
                showInlineUpdateButton && updateCandidate
                  ? () => {
                      if (!canRunInlineUpdate) {
                        return;
                      }
                      void runProviderUpdate(updateCandidate);
                    }
                  : undefined
              }
              isUpdating={showInlineUpdateButton ? isDriverUpdateRunning : undefined}
            />
          );
        })}
      </SettingsSection>

      {isAddInstanceDialogOpen ? (
        <AddProviderInstanceDialog open onOpenChange={setIsAddInstanceDialogOpen} />
      ) : null}
    </SettingsPageContainer>
  );
}

export function ArchivedThreadsPanel() {
  const projects = useProjects();
  const { unarchiveThread, confirmAndDeleteThread } = useThreadActions();
  const environmentIds = useMemo(
    () => [...new Set(projects.map((project) => project.environmentId))],
    [projects],
  );
  const {
    snapshots: archivedSnapshots,
    error: archiveError,
    isLoading: isLoadingArchive,
    refresh: refreshArchivedThreads,
  } = useArchivedThreadSnapshots(environmentIds);

  const archivedGroups = useMemo(() => {
    const projectsByEnvironmentAndId = new Map(
      archivedSnapshots.flatMap(({ environmentId, snapshot }) =>
        snapshot.projects.map(
          (project) =>
            [
              `${environmentId}:${project.id}`,
              {
                id: project.id,
                environmentId,
                name: project.title,
                cwd: project.workspaceRoot,
              },
            ] as const,
        ),
      ),
    );
    const threads = archivedSnapshots.flatMap(({ environmentId, snapshot }) =>
      snapshot.threads.map((thread) => ({
        ...thread,
        environmentId,
      })),
    );

    const archivedProjects = Array.from(projectsByEnvironmentAndId.values());
    const groups: Array<{
      readonly project: (typeof archivedProjects)[number];
      readonly threads: Array<(typeof threads)[number]>;
    }> = [];
    for (const project of archivedProjects) {
      const projectThreads: Array<(typeof threads)[number]> = [];
      for (const thread of threads) {
        if (thread.projectId === project.id && thread.environmentId === project.environmentId) {
          projectThreads.push(thread);
        }
      }
      if (projectThreads.length > 0) {
        groups.push({
          project,
          threads: projectThreads.toSorted((left, right) => {
            const leftKey = left.archivedAt ?? left.createdAt;
            const rightKey = right.archivedAt ?? right.createdAt;
            return rightKey.localeCompare(leftKey) || right.id.localeCompare(left.id);
          }),
        });
      }
    }
    return groups;
  }, [archivedSnapshots]);

  const handleArchivedThreadContextMenu = useCallback(
    async (threadRef: ScopedThreadRef, position: { x: number; y: number }) => {
      const api = readLocalApi();
      if (!api) return;
      const clicked = await api.contextMenu.show(
        [
          { id: "unarchive", label: "Unarchive" },
          { id: "delete", label: "Delete", destructive: true },
        ],
        position,
      );

      if (clicked === "unarchive") {
        const result = await unarchiveThread(threadRef);
        if (result._tag === "Success") {
          refreshArchivedThreads();
        } else if (!isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Failed to unarchive thread",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
        return;
      }

      if (clicked === "delete") {
        const result = await confirmAndDeleteThread(threadRef);
        if (result._tag === "Success") {
          refreshArchivedThreads();
        } else if (!isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Failed to delete thread",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
      }
    },
    [confirmAndDeleteThread, refreshArchivedThreads, unarchiveThread],
  );

  return (
    <SettingsPageContainer>
      {archivedGroups.length === 0 ? (
        <SettingsSection title="Archived threads">
          <SettingsRow
            title={
              <span className="inline-flex items-center gap-2">
                {isLoadingArchive ? (
                  <LoaderIcon className="size-3.5 animate-spin text-muted-foreground" />
                ) : (
                  <ArchiveIcon className="size-3.5 text-muted-foreground" />
                )}
                {isLoadingArchive
                  ? "Loading archived threads"
                  : archiveError
                    ? "Could not load archived threads"
                    : "No archived threads"}
              </span>
            }
            description={
              isLoadingArchive
                ? "Checking connected environments."
                : (archiveError ?? "Archived threads will appear here.")
            }
          />
        </SettingsSection>
      ) : (
        archivedGroups.map(({ project, threads: projectThreads }) => (
          <SettingsSection
            key={project.id}
            title={project.name}
            icon={<ProjectFavicon environmentId={project.environmentId} cwd={project.cwd} />}
          >
            {projectThreads.map((thread) => (
              <SettingsRow
                key={thread.id}
                onContextMenu={(event) => {
                  event.preventDefault();
                  void (async () => {
                    const result = await settlePromise(() =>
                      handleArchivedThreadContextMenu(
                        scopeThreadRef(thread.environmentId, thread.id),
                        {
                          x: event.clientX,
                          y: event.clientY,
                        },
                      ),
                    );
                    if (result._tag === "Failure") {
                      const error = squashAtomCommandFailure(result);
                      toastManager.add(
                        stackedThreadToast({
                          type: "error",
                          title: "Archived thread action failed",
                          description:
                            error instanceof Error ? error.message : "An error occurred.",
                        }),
                      );
                    }
                  })();
                }}
                title={thread.title}
                description={
                  <>
                    Archived {formatRelativeTimeLabel(thread.archivedAt ?? thread.createdAt)}
                    {" \u00b7 Created "}
                    {formatRelativeTimeLabel(thread.createdAt)}
                  </>
                }
                control={
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-7 shrink-0 cursor-pointer gap-1.5 px-2.5"
                    onClick={() => {
                      void (async () => {
                        const result = await unarchiveThread(
                          scopeThreadRef(thread.environmentId, thread.id),
                        );
                        if (result._tag === "Success") {
                          refreshArchivedThreads();
                          return;
                        }
                        if (!isAtomCommandInterrupted(result)) {
                          const error = squashAtomCommandFailure(result);
                          toastManager.add(
                            stackedThreadToast({
                              type: "error",
                              title: "Failed to unarchive thread",
                              description:
                                error instanceof Error ? error.message : "An error occurred.",
                            }),
                          );
                        }
                      })();
                    }}
                  >
                    <ArchiveX className="size-3.5" />
                    <span>Unarchive</span>
                  </Button>
                }
              />
            ))}
          </SettingsSection>
        ))
      )}
    </SettingsPageContainer>
  );
}
