// Decides tool calls with the shared permission rules and, for "ask", waits for
// my answer from a permission card (respondPermission). No timeout: a request
// waits until I answer or the run is stopped.

import { CONFIG } from "../../src/shared/config.ts";
import type { AgentStatus } from "../../src/shared/domain/agentTypes.ts";
import { explainPermission, type PermissionConfig, type PermissionDecision, type PermissionRequest } from "../../src/shared/domain/permissions.ts";
import { canonicalToolName, type ToolName } from "../../src/shared/domain/roles.ts";
import type { PermissionRequestedPayload, PermissionResolvedPayload } from "../../src/shared/events/eventPayloads.ts";
import { newId } from "../../src/shared/ids.ts";
import type { World } from "../world/World.ts";
import { describeTool } from "./claude/toolSummary.ts";

export type BrokerResult = { behavior: "allow" } | { behavior: "deny"; message: string };

export const DENIED_BY_USER = "The user denied this action.";
export const STOPPED_BY_USER = "The run was stopped by the user.";

interface PendingRequest {
  request: PermissionRequest;
  resolve(result: BrokerResult): void;
}

export interface PermissionBrokerDeps {
  world: World;
  /** Lets the AgentManager own status changes (and their events). */
  setStatus(agentId: string, status: AgentStatus, activity: string): void;
  config?: PermissionConfig;
}

export class PermissionBroker {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly deps: PermissionBrokerDeps;

  constructor(deps: PermissionBrokerDeps) {
    this.deps = deps;
  }

  /** `allowedTools` replaces the role's tool list for this run (chat only: none). */
  decide(
    agentId: string,
    toolName: string,
    input: unknown,
    signal?: AbortSignal,
    allowedTools?: readonly ToolName[],
  ): Promise<BrokerResult> {
    const { world } = this.deps;
    const agent = world.getAgent(agentId);
    const outcome = explainPermission(agent.role, toolName, input, this.deps.config ?? CONFIG, allowedTools);
    if (outcome.verdict === "allow") return Promise.resolve({ behavior: "allow" });
    if (outcome.verdict === "deny") {
      return Promise.resolve({ behavior: "deny", message: `Blocked by AI Agent World rules: ${outcome.reason}` });
    }
    if (signal?.aborted) return Promise.resolve({ behavior: "deny", message: STOPPED_BY_USER });

    const summary = describeTool(toolName, input, world.getProjectRoot(agent.projectId)).activity;
    const request: PermissionRequest = {
      id: newId("perm"),
      projectId: agent.projectId,
      agentId,
      toolName: canonicalToolName(toolName),
      summary,
      input,
      createdAt: world.now(),
    };

    return new Promise<BrokerResult>((resolve) => {
      this.pending.set(request.id, { request, resolve });
      world.pendingPermissions = [...world.pendingPermissions, request];
      world.changed();
      world.emit({
        type: "permission.requested",
        projectId: agent.projectId,
        agentId,
        message: `${agent.name} needs your OK: ${summary}`,
        severity: "warning",
        metadata: { request } satisfies PermissionRequestedPayload,
      });
      this.deps.setStatus(agentId, "waiting_permission", `Needs your OK: ${summary}`);
      signal?.addEventListener("abort", () => this.settle(request.id, "deny", STOPPED_BY_USER), { once: true });
    });
  }

  /** Answers a pending request (the respondPermission command). */
  respond(requestId: string, decision: PermissionDecision): void {
    const pending = this.pending.get(requestId);
    if (pending === undefined) throw new Error("Unknown or already answered permission request");
    this.settle(requestId, decision, DENIED_BY_USER);
    this.deps.setStatus(pending.request.agentId, "thinking", decision === "allow" ? "Continuing" : "Request denied");
  }

  /** Denies every pending request of an agent (its run was stopped). */
  denyAllFor(agentId: string, message: string = STOPPED_BY_USER): void {
    for (const { request } of [...this.pending.values()]) {
      if (request.agentId === agentId) this.settle(request.id, "deny", message);
    }
  }

  pendingFor(agentId: string): PermissionRequest[] {
    return [...this.pending.values()].map((p) => p.request).filter((r) => r.agentId === agentId);
  }

  private settle(requestId: string, decision: PermissionDecision, denyMessage: string): void {
    const pending = this.pending.get(requestId);
    if (pending === undefined) return;
    this.pending.delete(requestId);
    const { world } = this.deps;
    world.pendingPermissions = world.pendingPermissions.filter((r) => r.id !== requestId);
    world.changed();
    world.emit({
      type: "permission.resolved",
      projectId: pending.request.projectId,
      agentId: pending.request.agentId,
      message: `${pending.request.summary}: ${decision === "allow" ? "allowed" : "denied"}`,
      severity: decision === "allow" ? "success" : "warning",
      metadata: { requestId, decision } satisfies PermissionResolvedPayload,
    });
    pending.resolve(decision === "allow" ? { behavior: "allow" } : { behavior: "deny", message: denyMessage });
  }
}
