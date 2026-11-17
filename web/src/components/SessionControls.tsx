import { useEffect } from "react";
import {
  DEFAULT_PERMISSION_MODE,
  EFFORT_LEVELS,
  type PermissionMode,
  type Project,
} from "../../../shared/protocol";
import { markFor } from "../lib/marks";
import { roughName } from "../lib/models";
import { pickSetting, useRuri } from "../store";
import { AccountPicker } from "./AccountPicker";
import { ComboDropdown, Dropdown } from "./Dropdown";
import { ModelIcon, PickIcon } from "./Marks";

const PERMISSION_MODES = (
  [
    { value: "default", label: "Ask first" },
    { value: "acceptEdits", label: "Accept edits" },
    { value: "plan", label: "Plan mode" },
    { value: "bypassPermissions", label: "Bypass" },
  ] satisfies Array<{ value: PermissionMode; label: string }>
).map((mode) => ({ ...mode, icon: <PickIcon kind="permission" value={mode.value} /> }));

// no "default" entry — an unset effort simply IS the default chosen in
// Settings (the store's defaultEffort)
const EFFORT_OPTIONS = EFFORT_LEVELS.map((level) => ({
  value: level,
  label: level === "xhigh" ? "XHigh" : level[0]!.toUpperCase() + level.slice(1),
  icon: <PickIcon kind="effort" value={level} />,
}));

/** The composer's pickers: model, account, effort, permissions.
 *  `channelId` is who the pick is for — this chat (its session id) or Home
 *  — never the project: a pick is per chat. The account is the one
 *  exception, the project's for every chat in it (AccountPicker). */
export function SessionControls({
  project,
  channelId,
  compact = false,
}: {
  project: Project;
  channelId: string;
  /** The box is too narrow for three pickers: one, with the other two as
   *  rows inside it (ComboDropdown). */
  compact?: boolean;
}) {
  const allModels = useRuri((s) => s.models);
  const starredIds = useRuri((s) => s.starredModels);
  const defaultModel = useRuri((s) => s.defaultModel);
  // An unset model IS the crowned default — there is no "default" row.
  const current = project.model || defaultModel;
  // The picker shows starred models only (Settings holds the full catalog);
  // with nothing starred yet it falls back to everything. The current pick
  // stays listed even if it was unstarred since.
  const starred = allModels.filter((m) => starredIds.includes(m.value));
  const models = [...(starred.length > 0 ? starred : allModels)];
  const selected = allModels.find((m) => m.value === current);
  if (selected && !models.includes(selected)) models.push(selected);
  // before the catalog arrives, the trigger still needs a label
  if (!selected) models.push({ value: current, displayName: roughName(current) });
  // The dropdown shows wherever the mode can actually be honoured: Claude,
  // and any harness running a real agentic session (its sandbox or session
  // mode is set from this). A run-per-turn provider has no approval flow to
  // drive, so it still hides rather than offer a control that does nothing.
  const canSetPermissions = !selected?.provider || selected.agentic === true;
  const reportedEfforts = selected?.reasoningEfforts;
  const effortOptions = reportedEfforts?.length
    ? reportedEfforts.map((effort) => ({
        value: effort.value,
        label: effort.value === "xhigh" ? "XHigh" : effort.value[0]!.toUpperCase() + effort.value.slice(1),
        icon: <PickIcon kind="effort" value={effort.value} />,
      }))
    : selected
      ? []
      : EFFORT_OPTIONS;
  const defaultEffort = useRuri((s) => s.defaultEffort);
  const pickedEffort = project.effort || defaultEffort;
  const supportedEffort = effortOptions.some((option) => option.value === pickedEffort);
  const fallbackEffort = selected?.defaultEffort ?? effortOptions[0]?.value;
  // A project can carry xhigh from its previous model. Once a new catalog
  // says that choice is impossible, move to the model's own default rather
  // than silently asking the harness for a setting it will ignore.
  const selectedValue = selected?.value;
  useEffect(() => {
    if (!selectedValue || effortOptions.length === 0 || supportedEffort || !fallbackEffort) return;
    pickSetting(channelId, "effort", fallbackEffort);
  }, [selectedValue, pickedEffort, supportedEffort, fallbackEffort, effortOptions.length, channelId]);
  const modelOptions = models.map((m) => ({
    // the model's own name and its maker's mark — which harness serves it
    // is the Settings catalog's business, not the picker's
    value: m.value,
    label: m.displayName,
    icon: <ModelIcon pick={markFor(m.value, m)} />,
  }));
  const pickModel = (model: string) => pickSetting(channelId, "model", model);
  const effortValue = supportedEffort ? pickedEffort : (fallbackEffort ?? pickedEffort);
  const pickEffort = (effort: string) => pickSetting(channelId, "effort", effort);
  const pickMode = (mode: string) => pickSetting(channelId, "permissionMode", mode);
  // the harness the chat runs, which says whose accounts are offered
  const harness = selected?.provider ?? "claude";
  if (compact) {
    return (
      <div className="composer-controls">
        <ComboDropdown
          up
          title="Model, effort and permissions for this chat"
          value={current}
          options={modelOptions}
          onSelect={pickModel}
          subs={[
            ...(effortOptions.length > 0
              ? [
                  {
                    key: "effort",
                    label: "Effort level",
                    value: effortValue,
                    options: effortOptions,
                    onSelect: pickEffort,
                  },
                ]
              : []),
            ...(canSetPermissions
              ? [
                  {
                    key: "permissions",
                    label: "Permissions",
                    value: project.permissionMode ?? DEFAULT_PERMISSION_MODE,
                    options: PERMISSION_MODES,
                    onSelect: pickMode,
                  },
                ]
              : []),
          ]}
        />
        {/* the account stays a chip of its own even here: which one has
            room is the thing to see at a glance */}
        <AccountPicker channelId={channelId} provider={harness} />
      </div>
    );
  }
  return (
    <div className="composer-controls">
      <Dropdown
        up
        title="Model for this chat — new chats start on the last pick; star models in Settings to curate this list"
        value={current}
        options={modelOptions}
        onSelect={pickModel}
      />
      <AccountPicker channelId={channelId} provider={harness} />
      {effortOptions.length > 0 && (
        <Dropdown
          up
          title="Reasoning effort — choices reported by this model"
          value={effortValue}
          options={effortOptions}
          onSelect={pickEffort}
        />
      )}
      {canSetPermissions && (
        <Dropdown
          up
          title="Permission mode"
          value={project.permissionMode ?? DEFAULT_PERMISSION_MODE}
          options={PERMISSION_MODES}
          onSelect={pickMode}
        />
      )}
    </div>
  );
}
