import { useEffect } from "react";
import {
  DEFAULT_EFFORT,
  DEFAULT_PERMISSION_MODE,
  EFFORT_LEVELS,
  type PermissionMode,
  type Project,
} from "../../../shared/protocol";
import { roughName } from "../lib/models";
import { send, useRuri } from "../store";
import { ComboDropdown, Dropdown } from "./Dropdown";

const PERMISSION_MODES: Array<{ value: PermissionMode; label: string }> = [
  { value: "default", label: "Ask first" },
  { value: "acceptEdits", label: "Accept edits" },
  { value: "plan", label: "Plan mode" },
  { value: "bypassPermissions", label: "Bypass" },
];

// no "default" entry — an unset effort simply IS xhigh (DEFAULT_EFFORT)
const EFFORT_OPTIONS = EFFORT_LEVELS.map((level) => ({
  value: level,
  label: level === "xhigh" ? "XHigh" : level[0]!.toUpperCase() + level.slice(1),
}));

/** The composer's three pickers. `channelId` is who the pick is for — this
 *  chat (its session id) or Home — never the project: a pick is per chat. */
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
      }))
    : selected
      ? []
      : EFFORT_OPTIONS;
  const pickedEffort = project.effort || DEFAULT_EFFORT;
  const supportedEffort = effortOptions.some((option) => option.value === pickedEffort);
  const fallbackEffort = selected?.defaultEffort ?? effortOptions[0]?.value;
  // A project can carry xhigh from its previous model. Once a new catalog
  // says that choice is impossible, move to the model's own default rather
  // than silently asking the harness for a setting it will ignore.
  const selectedValue = selected?.value;
  useEffect(() => {
    if (!selectedValue || effortOptions.length === 0 || supportedEffort || !fallbackEffort) return;
    send({ type: "set_effort", projectId: channelId, effort: fallbackEffort });
  }, [selectedValue, pickedEffort, supportedEffort, fallbackEffort, effortOptions.length, channelId]);
  const modelOptions = models.map((m) => ({
    // the model's own name only — which harness serves it is the
    // Settings catalog's business, not the picker's
    value: m.value,
    label: m.displayName,
  }));
  const pickModel = (model: string) => send({ type: "set_model", projectId: channelId, model });
  const effortValue = supportedEffort ? pickedEffort : (fallbackEffort ?? pickedEffort);
  const pickEffort = (effort: string) => send({ type: "set_effort", projectId: channelId, effort });
  const pickMode = (mode: string) =>
    send({ type: "set_permission_mode", projectId: channelId, mode: mode as PermissionMode });
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
