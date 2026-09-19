import { HOME_ID, type PermissionRequest } from "../../../shared/protocol";
import { harnessName } from "../lib/models";
import { Markdown } from "../markdown";
import { send, showError, useRuri } from "../store";
import { Icon, toolIcon } from "./chat/Icon";
import { NameCard } from "./NameCard";
import { QuestionCard } from "./Questions";

function permissionSummary(
  request: PermissionRequest,
  /** Whoever is asking — the harness this channel runs on. */
  asker: string,
): { title: string; body: React.ReactNode } {
  const input = (request.input ?? {}) as Record<string, unknown>;
  if (request.toolName === "ExitPlanMode" && typeof input["plan"] === "string") {
    return {
      title: `${asker} finished planning and wants to start building`,
      body: (
        <div className="permission-plan scroll-gate">
          <Markdown text={input["plan"] as string} />
        </div>
      ),
    };
  }
  const detail =
    typeof input["command"] === "string"
      ? (input["command"] as string)
      : typeof input["file_path"] === "string"
        ? (input["file_path"] as string)
        : undefined;
  return {
    title: `${asker} wants to use ${request.toolName}`,
    body: (
      <pre className="permission-input scroll-gate">{detail ?? JSON.stringify(request.input, null, 2)}</pre>
    ),
  };
}

export function PermissionBanner({ request }: { request: PermissionRequest }) {
  const models = useRuri((s) => s.models);
  const defaultModel = useRuri((s) => s.defaultModel);
  const model = useRuri(
    (s) =>
      s.projects.find((p) => p.sessions.some((x) => x.id === request.projectId))?.model ??
      (request.projectId === HOME_ID ? s.home.model : undefined),
  );
  const { title, body } = permissionSummary(request, harnessName(models, model, defaultModel));
  // one of your own agents asking, not the chat's model
  const from = useRuri((s) =>
    request.agent ? s.crew[request.projectId]?.find((a) => a.key === request.agent)?.description : undefined,
  );
  const respond = (allow: boolean, always = false) => {
    if (!send({ type: "permission_response", requestId: request.requestId, allow, always })) {
      showError("Not connected — the answer did not go through; try again once ruri is back.");
    }
  };
  return (
    <div className="permission-card">
      <div className="permission-head">
        <span className="permission-badge">
          <Icon d={toolIcon(request.toolName)} />
          {request.toolName}
        </span>
        {title}
      </div>
      {request.agent && <div className="permission-from">asked by your agent{from ? ` “${from}”` : ""}</div>}
      {body}
      <div className="permission-actions">
        <button className="primary" onClick={() => respond(true)}>
          Allow
        </button>
        <button onClick={() => respond(true, true)}>Always allow</button>
        <button className="ghost" onClick={() => respond(false)}>
          Deny
        </button>
      </div>
    </div>
  );
}

/** A card waiting on the user: a question, a naming, or an allow/deny. */
export function AskCard({ request }: { request: PermissionRequest }) {
  return request.kind === "question" ? (
    <QuestionCard request={request} />
  ) : request.kind === "component" ? (
    <NameCard request={request} />
  ) : (
    <PermissionBanner request={request} />
  );
}
