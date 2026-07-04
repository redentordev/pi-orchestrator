import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { getAgentDir, parseFrontmatter, renderDiff, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
type StatusView = "minimal" | "default" | "detailed";

type AgentName = "researcher" | "implementor" | "design";
type Role = "orchestrator" | "researcher" | "implementor" | "design";
type BillingOverride = "api" | "subscription";
type AuthType = "oauth" | "api_key";

interface RoleTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  requests: number;
  lastModel?: string;
}

interface UsageDelta {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  requests?: number;
  provider?: string;
  model?: string;
}

interface UsageSnapshot {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

interface OrchestratorRoleConfig {
  provider: string;
  model: string;
  thinking: ThinkingLevel;
}

interface OrchestratorConfig {
  orchestrator?: OrchestratorRoleConfig;
  statusWidget?: boolean;
  statusView?: StatusView;
}

interface AgentConfig {
  name: string;
  description: string;
  provider: string;
  model: string;
  thinking: ThinkingLevel;
  tools: string[];
  systemPrompt: string;
  billing?: BillingOverride;
}

interface ActivityItem {
  kind: "tool" | "text";
  toolCallId?: string;
  tool?: string;
  summary: string;
  detail?: string;
  isError?: boolean;
  pending?: boolean;
}

interface DelegationDetails {
  agent: string;
  provider: string;
  model: string;
  thinking: ThinkingLevel;
  cwd: string;
  sessionId: string;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cost: number;
  exitCode: number;
  stderr: string;
  activity: ActivityItem[];
  status: "running" | "done" | "failed";
  report?: string;
  droppedCount: number;
}

const delegateParams = Type.Object({
  task: Type.String({ description: "Specific task to delegate." }),
  cwd: Type.Optional(Type.String({ description: "Working directory for the delegated Pi process." })),
  sessionId: Type.Optional(
    Type.String({ description: "Session id from a previous delegation to continue that agent's session with retained context." }),
  ),
  thinking: Type.Optional(
    Type.Union(
      [
        Type.Literal("off"),
        Type.Literal("minimal"),
        Type.Literal("low"),
        Type.Literal("medium"),
        Type.Literal("high"),
        Type.Literal("xhigh"),
      ],
      { description: "Override the agent's default thinking level for this delegation." },
    ),
  ),
});

const diffParams = Type.Object({
  cwd: Type.Optional(Type.String({ description: "Working directory to inspect. Defaults to current project." })),
  paths: Type.Optional(Type.Array(Type.String(), { description: "Limit the diff to these pathspecs." })),
  maxBytes: Type.Optional(Type.Number({ description: "Cap on total diff output bytes. Default 80000." })),
});

const MAX_ACTIVITY_ITEMS = 200;
const MAX_ACTIVITY_DETAIL_BYTES = 120_000;
const MAX_EDIT_DETAIL_BYTES = 6_000;
const MAX_WRITE_DETAIL_BYTES = 2_000;
const MAX_BASH_DETAIL_BYTES = 1_500;
const UPDATE_THROTTLE_MS = 80;
const ROLES: Role[] = ["orchestrator", "researcher", "implementor", "design"];
const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];
const STATUS_VIEWS: StatusView[] = ["minimal", "default", "detailed"];

function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === "string" && THINKING_LEVELS.includes(value as ThinkingLevel);
}

function isStatusView(value: unknown): value is StatusView {
  return typeof value === "string" && STATUS_VIEWS.includes(value as StatusView);
}

function isBillingOverride(value: unknown): value is BillingOverride {
  return value === "api" || value === "subscription";
}

function zeroRoleTotals(): RoleTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, requests: 0 };
}

function zeroTotalsRecord(): Record<Role, RoleTotals> {
  return {
    orchestrator: zeroRoleTotals(),
    researcher: zeroRoleTotals(),
    implementor: zeroRoleTotals(),
    design: zeroRoleTotals(),
  };
}

function resetTotals(totals: Record<Role, RoleTotals>) {
  for (const role of ROLES) totals[role] = zeroRoleTotals();
}

function safeNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function modelLabel(provider: unknown, model: unknown): string | undefined {
  return typeof provider === "string" && provider.length > 0 && typeof model === "string" && model.length > 0
    ? `${provider}/${model}`
    : undefined;
}

function shortModelLabel(lastModel: string | undefined, dropProvider: boolean): string {
  if (!lastModel) return "unknown";
  if (!dropProvider) return lastModel;
  const slash = lastModel.indexOf("/");
  return slash >= 0 ? lastModel.slice(slash + 1) : lastModel;
}

function cachedPctLabel(cacheRead: number, cacheWrite: number, submitted: number): string {
  const cached = cacheRead + cacheWrite;
  if (!cached || !submitted) return "";
  return `${Math.round((cached / submitted) * 100)}% cached`;
}

const extensionDir = path.dirname(fileURLToPath(import.meta.url));

function bundledPath(...segments: string[]): string {
  return path.join(extensionDir, "..", ...segments);
}

function getUserAgentPath(name: AgentName): string {
  return path.join(getAgentDir(), "agents", `${name}.md`);
}

function getBundledAgentPath(name: AgentName): string {
  return bundledPath("agents", `${name}.md`);
}

function resolveAgentPath(name: AgentName): string {
  const userPath = getUserAgentPath(name);
  if (fs.existsSync(userPath)) return userPath;
  return getBundledAgentPath(name);
}

function getUserAppendSystemPath(): string {
  return path.join(getAgentDir(), "APPEND_SYSTEM.md");
}

function getBundledOrchestratorPromptPath(): string {
  return bundledPath("prompts", "orchestrator.md");
}

function zeroUsageSnapshot(): UsageSnapshot {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

function usageSnapshotFromUsage(usage: any): UsageSnapshot {
  return {
    input: safeNumber(usage?.input),
    output: safeNumber(usage?.output),
    cacheRead: safeNumber(usage?.cacheRead),
    cacheWrite: safeNumber(usage?.cacheWrite),
    cost: safeNumber(usage?.cost?.total),
  };
}

function usageDeltaFromSnapshots(
  previous: UsageSnapshot | undefined,
  next: UsageSnapshot | undefined,
  requests = 0,
  provider?: string,
  model?: string,
): UsageDelta {
  const before = previous ?? zeroUsageSnapshot();
  const after = next ?? zeroUsageSnapshot();
  return {
    input: Math.max(0, after.input - before.input),
    output: Math.max(0, after.output - before.output),
    cacheRead: Math.max(0, after.cacheRead - before.cacheRead),
    cacheWrite: Math.max(0, after.cacheWrite - before.cacheWrite),
    cost: Math.max(0, after.cost - before.cost),
    requests,
    provider,
    model,
  };
}

function usageDeltaFromUsage(usage: any, requests = 0, provider?: string, model?: string): UsageDelta {
  return { ...usageSnapshotFromUsage(usage), requests, provider, model };
}

function usageSnapshotsEqual(left: UsageSnapshot | undefined, right: UsageSnapshot | undefined): boolean {
  if (!left || !right) return left === right;
  return (
    left.input === right.input &&
    left.output === right.output &&
    left.cacheRead === right.cacheRead &&
    left.cacheWrite === right.cacheWrite &&
    left.cost === right.cost
  );
}

function hasUsageDeltaValues(delta: UsageDelta): boolean {
  return Boolean(delta.input || delta.output || delta.cacheRead || delta.cacheWrite || delta.cost || (delta.requests ?? 0));
}

function submittedInputCount(input: number, cacheRead: number, cacheWrite: number): number {
  return input + cacheRead + cacheWrite;
}

function addUsageDeltaToTotals(totals: Record<Role, RoleTotals>, role: Role, delta: UsageDelta) {
  const target = totals[role];
  target.input += delta.input;
  target.output += delta.output;
  target.cacheRead += delta.cacheRead;
  target.cacheWrite += delta.cacheWrite;
  target.cost += delta.cost;
  target.requests += delta.requests ?? 0;
  const label = modelLabel(delta.provider, delta.model);
  if (label) target.lastModel = label;
}

function hasRoleActivity(total: RoleTotals): boolean {
  return Boolean(total.requests || total.input || total.output || total.cacheRead || total.cacheWrite || total.cost);
}

function compactTokenCount(value: number): string {
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  if (abs < 10_000) return `${sign}${Math.round(abs)}`;
  if (abs < 100_000) return `${sign}${(abs / 1_000).toFixed(1)}k`;
  if (abs < 1_000_000) return `${sign}${Math.round(abs / 1_000)}k`;
  if (abs < 10_000_000) return `${sign}${(abs / 1_000_000).toFixed(1)}M`;
  return `${sign}${Math.round(abs / 1_000_000)}M`;
}

function getOrchestratorConfigPath(): string {
  return path.join(getAgentDir(), "orchestrator-config.json");
}

function normalizeOrchestratorConfig(value: any): OrchestratorConfig {
  const config: OrchestratorConfig = {};
  if (!value || typeof value !== "object") return config;

  const orchestrator = value.orchestrator;
  if (
    orchestrator &&
    typeof orchestrator === "object" &&
    typeof orchestrator.provider === "string" &&
    typeof orchestrator.model === "string"
  ) {
    config.orchestrator = {
      provider: orchestrator.provider,
      model: orchestrator.model,
      thinking: isThinkingLevel(orchestrator.thinking) ? orchestrator.thinking : "medium",
    };
  }
  if (typeof value.statusWidget === "boolean") config.statusWidget = value.statusWidget;
  if (isStatusView(value.statusView)) config.statusView = value.statusView;
  return config;
}

function loadOrchestratorConfig(): OrchestratorConfig {
  try {
    const filePath = getOrchestratorConfigPath();
    if (!fs.existsSync(filePath)) return {};
    return normalizeOrchestratorConfig(JSON.parse(fs.readFileSync(filePath, "utf8")));
  } catch {
    return {};
  }
}

function saveOrchestratorConfig(patch: Partial<OrchestratorConfig>): OrchestratorConfig {
  const current = loadOrchestratorConfig();
  const next: OrchestratorConfig = { ...current };
  if (patch.orchestrator) next.orchestrator = patch.orchestrator;
  if (typeof patch.statusWidget === "boolean") next.statusWidget = patch.statusWidget;
  if (isStatusView(patch.statusView)) next.statusView = patch.statusView;
  fs.mkdirSync(path.dirname(getOrchestratorConfigPath()), { recursive: true });
  fs.writeFileSync(getOrchestratorConfigPath(), `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}

function ensureUserAgentFile(role: AgentName): string {
  const filePath = getUserAgentPath(role);
  if (fs.existsSync(filePath)) return filePath;

  const fallbackPath = getBundledAgentPath(role);
  if (!fs.existsSync(fallbackPath)) {
    throw new Error(`Agent ${role} not found in ${filePath} or bundled fallback ${fallbackPath}`);
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.copyFileSync(fallbackPath, filePath);
  return filePath;
}

function updateAgentFrontmatter(role: AgentName, updates: { provider: string; model: string; thinking: ThinkingLevel }) {
  const filePath = ensureUserAgentFile(role);
  const content = fs.readFileSync(filePath, "utf8");
  const match = content.match(/^(---\r?\n)([\s\S]*?)(\r?\n---(?:\r?\n|$))/);
  if (!match) throw new Error(`Agent ${role} is missing a leading frontmatter block in ${filePath}`);

  const newline = match[1].includes("\r\n") || match[3].includes("\r\n") ? "\r\n" : "\n";
  const lines = match[2].length > 0 ? match[2].split(/\r?\n/) : [];
  for (const [key, value] of Object.entries(updates)) {
    const line = `${key}: ${value}`;
    const index = lines.findIndex((candidate) => new RegExp(`^\\s*${key}\\s*:`).test(candidate));
    if (index >= 0) lines[index] = line;
    else lines.push(line);
  }

  const next = `${match[1]}${lines.join(newline)}${match[3]}${content.slice(match[0].length)}`;
  fs.writeFileSync(filePath, next, "utf8");
}

function loadAgent(name: AgentName): AgentConfig {
  const filePath = resolveAgentPath(name);
  if (!fs.existsSync(filePath)) throw new Error(`Agent ${name} not found at ${filePath}`);
  const content = fs.readFileSync(filePath, "utf8");
  const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);
  const provider = frontmatter.provider?.trim();
  const model = frontmatter.model?.trim();
  const thinking = (frontmatter.thinking?.trim() || "medium") as ThinkingLevel;
  const billingValue = frontmatter.billing?.trim();
  const billing = isBillingOverride(billingValue) ? billingValue : undefined;
  const tools = (frontmatter.tools || "")
    .split(",")
    .map((tool) => tool.trim())
    .filter(Boolean);

  if (!provider || !model) {
    throw new Error(`Agent ${name} must define provider and model in ${filePath}`);
  }

  return {
    name: frontmatter.name || name,
    description: frontmatter.description || name,
    provider,
    model,
    thinking,
    tools,
    systemPrompt: body.trim(),
    billing,
  };
}

let bundledOrchestratorPromptCache: string | null | undefined;

function loadBundledOrchestratorPrompt(): string | undefined {
  if (fs.existsSync(getUserAppendSystemPath())) return undefined;
  if (bundledOrchestratorPromptCache !== undefined) return bundledOrchestratorPromptCache || undefined;

  const filePath = getBundledOrchestratorPromptPath();
  if (!fs.existsSync(filePath)) {
    bundledOrchestratorPromptCache = null;
    return undefined;
  }

  const text = fs.readFileSync(filePath, "utf8").trim();
  bundledOrchestratorPromptCache = text.length > 0 ? text : null;
  return bundledOrchestratorPromptCache || undefined;
}

function delegatePromptSnippet(role: AgentName, purpose: string, suffix = ""): string {
  const toolName = `delegate_${role}`;
  try {
    const agent = loadAgent(role);
    return `${toolName}: ${purpose} via ${agent.provider}/${agent.model}:${agent.thinking} (reconfigure with /agents).${suffix}`;
  } catch {
    return `${toolName}: ${purpose} via the configured ${role} model — see /agents.${suffix}`;
  }
}

function textFromMessage(message: any): string {
  if (!message || !Array.isArray(message.content)) return "";
  return message.content
    .filter((part: any) => part?.type === "text" && typeof part.text === "string")
    .map((part: any) => part.text)
    .join("\n");
}

function textFromContent(content: any): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part: any) => part?.type === "text" && typeof part.text === "string")
    .map((part: any) => part.text)
    .join("\n");
}

function oneLine(text: string, maxChars: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= maxChars) return collapsed;
  if (maxChars <= 1) return "…";
  return `${collapsed.slice(0, maxChars - 1)}…`;
}

function compactJson(value: unknown, maxChars: number): string {
  let text: string;
  try {
    text = JSON.stringify(value ?? {});
  } catch {
    text = String(value);
  }
  return oneLine(text, maxChars);
}

function capBytes(text: string, maxBytes: number, marker = "\n… truncated"): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const markerBytes = Buffer.byteLength(marker, "utf8");
  const bodyMaxBytes = Math.max(0, maxBytes - markerBytes);
  let capped = text.slice(0, bodyMaxBytes);
  while (Buffer.byteLength(capped, "utf8") > bodyMaxBytes) capped = capped.slice(0, -1);
  return `${capped}${marker}`;
}

function tailBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const marker = "… truncated\n";
  const tailMaxBytes = Math.max(0, maxBytes - Buffer.byteLength(marker, "utf8"));
  let tail = text.slice(Math.max(0, text.length - tailMaxBytes));
  while (Buffer.byteLength(tail, "utf8") > tailMaxBytes) tail = tail.slice(1);
  return `${marker}${tail}`;
}

function lineCount(text: string): number {
  return text.length > 0 ? text.split(/\r?\n/).length : 0;
}

function firstLines(text: string, maxLines: number): { text: string; truncated: boolean } {
  const lines = text.split(/\r?\n/);
  if (lines.length <= maxLines) return { text, truncated: false };
  return { text: lines.slice(0, maxLines).join("\n"), truncated: true };
}

function capLines(text: string, maxLines: number, fromEnd = false): { text: string; truncated: boolean } {
  const lines = text.split(/\r?\n/);
  if (lines.length <= maxLines) return { text, truncated: false };
  const kept = fromEnd ? lines.slice(-maxLines) : lines.slice(0, maxLines);
  return { text: kept.join("\n"), truncated: true };
}

function relPathForDisplay(value: unknown, cwd: string): string {
  if (typeof value !== "string" || value.length === 0) return "...";
  if (!path.isAbsolute(value)) return value;
  const relative = path.relative(cwd, value);
  if (relative === "") return ".";
  if (!relative.startsWith("..") && !path.isAbsolute(relative)) return relative;
  return value;
}

function pathArg(args: any): unknown {
  return args?.path ?? args?.file_path ?? args?.filePath;
}

function summarizeToolCall(toolName: string, args: any, cwd: string): string {
  switch (toolName) {
    case "edit":
      return `edit ${relPathForDisplay(pathArg(args), cwd)}`;
    case "write": {
      const content = typeof args?.content === "string" ? args.content : "";
      return `write ${relPathForDisplay(pathArg(args), cwd)} (${lineCount(content)} lines)`;
    }
    case "bash":
      return `bash ${oneLine(String(args?.command ?? "..."), 80)}`;
    case "read": {
      let summary = `read ${relPathForDisplay(pathArg(args), cwd)}`;
      const options: string[] = [];
      if (args?.offset !== undefined) options.push(`offset=${args.offset}`);
      if (args?.limit !== undefined) options.push(`limit=${args.limit}`);
      if (options.length > 0) summary += ` (${options.join(", ")})`;
      return summary;
    }
    case "grep": {
      const pattern = args?.pattern ?? args?.query;
      const target = pattern !== undefined && pattern !== "" ? pattern : (pathArg(args) ?? args?.path ?? ".");
      return `grep ${oneLine(String(target), 80)}`;
    }
    case "find": {
      const target = args?.pattern ?? pathArg(args) ?? ".";
      return `find ${oneLine(String(target), 80)}`;
    }
    case "ls":
      return `ls ${relPathForDisplay(pathArg(args) ?? ".", cwd)}`;
    default:
      return `${toolName} ${compactJson(args, 120)}`;
  }
}

function finishedToolDetail(toolName: string, args: any, result: any, cwd: string): { summary: string; detail?: string } {
  switch (toolName) {
    case "edit": {
      const diff = typeof result?.details?.diff === "string" ? result.details.diff : "";
      return {
        summary: `edit ${relPathForDisplay(pathArg(args), cwd)}`,
        detail: diff ? capBytes(diff, MAX_EDIT_DETAIL_BYTES) : undefined,
      };
    }
    case "write": {
      const content = typeof args?.content === "string" ? args.content : "";
      const lines = content.split(/\r?\n/);
      let preview = lines.slice(0, 30).join("\n");
      if (lines.length > 30) preview += `\n… ${lines.length - 30} more lines`;
      return {
        summary: `write ${relPathForDisplay(pathArg(args), cwd)} (${lineCount(content)} lines)`,
        detail: preview ? capBytes(preview, MAX_WRITE_DETAIL_BYTES) : undefined,
      };
    }
    case "bash": {
      const output = textFromContent(result?.content);
      return {
        summary: `bash ${oneLine(String(args?.command ?? "..."), 80)}`,
        detail: output ? tailBytes(output, MAX_BASH_DETAIL_BYTES) : undefined,
      };
    }
    case "read":
    case "grep":
    case "find":
    case "ls":
      return { summary: summarizeToolCall(toolName, args, cwd) };
    default:
      return { summary: summarizeToolCall(toolName, args, cwd) };
  }
}

function cloneActivity(activity: ActivityItem[]): ActivityItem[] {
  return activity.map((item) => ({ ...item }));
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }
  return { command: "pi", args };
}

async function runDelegatedAgent(
  agentName: AgentName,
  task: string,
  cwd: string,
  signal: AbortSignal | undefined,
  onUpdate: ((partial: AgentToolResult<DelegationDetails>) => void) | undefined,
  onUsageDelta: ((delta: UsageDelta) => void) | undefined,
  providedSessionId?: string,
  thinkingOverride?: ThinkingLevel,
): Promise<AgentToolResult<DelegationDetails>> {
  const agent = loadAgent(agentName);
  const sessionId = providedSessionId || randomUUID();
  const sessionDir = path.join(getAgentDir(), "subagent-sessions");
  const effectiveThinking = thinkingOverride ?? agent.thinking;
  const args = [
    "--mode",
    "json",
    "-p",
    "--session-dir",
    sessionDir,
    "--session-id",
    sessionId,
    "--no-extensions",
    "--provider",
    agent.provider,
    "--model",
    agent.model,
    "--thinking",
    effectiveThinking,
    "--append-system-prompt",
    agent.systemPrompt,
  ];

  if (agent.tools.length > 0) {
    args.push("--tools", agent.tools.join(","));
  }

  args.push(`Task from orchestrator:\n\n${task}`);

  const invocation = getPiInvocation(args);
  let stdoutBuffer = "";
  let stderr = "";
  let finalText = "";
  let stopReason = "";
  let errorMessage = "";
  let aborted = false;
  let turns = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let cost = 0;
  let usageSnapshot: UsageSnapshot | undefined;
  const activity: ActivityItem[] = [];
  const toolArgsById = new Map<string, any>();
  let droppedCount = 0;
  let storedDetailBytes = 0;
  let lastUpdateAt = 0;

  const dropOldActivity = () => {
    while (activity.length > MAX_ACTIVITY_ITEMS) {
      const dropped = activity.shift();
      if (!dropped) return;
      if (dropped.detail) storedDetailBytes -= Buffer.byteLength(dropped.detail, "utf8");
      droppedCount += 1;
    }
  };

  const pushActivity = (item: ActivityItem): ActivityItem => {
    activity.push(item);
    dropOldActivity();
    return item;
  };

  const setActivityDetail = (item: ActivityItem, detail: string | undefined) => {
    if (item.detail) storedDetailBytes -= Buffer.byteLength(item.detail, "utf8");
    delete item.detail;
    if (!detail) return;
    const detailBytes = Buffer.byteLength(detail, "utf8");
    if (storedDetailBytes + detailBytes > MAX_ACTIVITY_DETAIL_BYTES) return;
    item.detail = detail;
    storedDetailBytes += detailBytes;
  };

  const details = (exitCode: number, status: DelegationDetails["status"] = "running", report?: string): DelegationDetails => ({
    agent: agent.name,
    provider: agent.provider,
    model: agent.model,
    thinking: effectiveThinking,
    cwd,
    sessionId,
    turns,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    cost,
    exitCode,
    stderr,
    activity: cloneActivity(activity),
    status,
    report: report ?? (finalText || undefined),
    droppedCount,
  });

  const emitUpdate = (force = false) => {
    if (!onUpdate) return;
    const now = Date.now();
    if (!force && now - lastUpdateAt < UPDATE_THROTTLE_MS) return;
    lastUpdateAt = now;
    onUpdate({
      content: [{ type: "text", text: finalText || `Running ${agent.name}...` }],
      details: details(-1, "running"),
    });
  };

  const applyUsageDelta = (delta: UsageDelta) => {
    inputTokens += delta.input;
    outputTokens += delta.output;
    cacheReadTokens += delta.cacheRead;
    cacheWriteTokens += delta.cacheWrite;
    cost += delta.cost;
    onUsageDelta?.(delta);
  };

  const processLine = (line: string) => {
    if (!line.trim()) return;
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }

    if (event.type === "tool_execution_start") {
      const toolName = String(event.toolName ?? "tool");
      const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : undefined;
      const toolArgs = event.args ?? {};
      if (toolCallId) toolArgsById.set(toolCallId, toolArgs);
      pushActivity({
        kind: "tool",
        toolCallId,
        tool: toolName,
        summary: summarizeToolCall(toolName, toolArgs, cwd),
        pending: true,
      });
      emitUpdate(false);
    }

    if (event.type === "tool_execution_end") {
      const toolName = String(event.toolName ?? "tool");
      const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : undefined;
      const toolArgs = (toolCallId ? toolArgsById.get(toolCallId) : undefined) ?? event.args ?? {};
      let item = toolCallId
        ? activity.find((candidate) => candidate.kind === "tool" && candidate.toolCallId === toolCallId && candidate.pending)
        : undefined;
      if (!item) {
        item = pushActivity({
          kind: "tool",
          toolCallId,
          tool: toolName,
          summary: summarizeToolCall(toolName, toolArgs, cwd),
        });
      }
      const refined = finishedToolDetail(toolName, toolArgs, event.result, cwd);
      item.tool = toolName;
      item.summary = refined.summary;
      item.pending = false;
      item.isError = Boolean(event.isError);
      setActivityDetail(item, refined.detail);
      if (toolCallId) toolArgsById.delete(toolCallId);
      emitUpdate(true);
    }

    if (event.type === "message_update" && event.message?.role === "assistant" && event.message.usage) {
      const nextSnapshot = usageSnapshotFromUsage(event.message.usage);
      if (!usageSnapshotsEqual(usageSnapshot, nextSnapshot)) {
        const delta = usageDeltaFromSnapshots(usageSnapshot, nextSnapshot, 0, agent.provider, agent.model);
        usageSnapshot = nextSnapshot;
        if (hasUsageDeltaValues(delta)) {
          applyUsageDelta(delta);
          emitUpdate(false);
        }
      }
    }

    if (event.type === "message_end" && event.message?.role === "assistant") {
      const finalSnapshot = event.message.usage ? usageSnapshotFromUsage(event.message.usage) : undefined;
      const delta = usageDeltaFromSnapshots(usageSnapshot, finalSnapshot, 1, agent.provider, agent.model);
      usageSnapshot = undefined;
      turns += 1;
      applyUsageDelta(delta);

      const text = textFromMessage(event.message);
      if (text) {
        finalText = text;
        pushActivity({ kind: "text", summary: oneLine(text, 200) });
      }
      if (event.message.stopReason) stopReason = event.message.stopReason;
      if (event.message.errorMessage) errorMessage = event.message.errorMessage;
      emitUpdate(true);
    }
  };

  const exitCode = await new Promise<number>((resolve) => {
    const proc = spawn(invocation.command, invocation.args, {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        PI_TELEMETRY: process.env.PI_TELEMETRY || "0",
        PI_SKIP_VERSION_CHECK: process.env.PI_SKIP_VERSION_CHECK || "1",
        PI_CACHE_RETENTION: process.env.PI_CACHE_RETENTION || "long",
      },
    });

    proc.stdout.on("data", (data) => {
      stdoutBuffer += data.toString();
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() || "";
      for (const line of lines) processLine(line);
    });

    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      if (stdoutBuffer.trim()) processLine(stdoutBuffer);
      resolve(code ?? 0);
    });

    proc.on("error", () => resolve(1));

    if (signal) {
      const abort = () => {
        aborted = true;
        proc.kill("SIGTERM");
        setTimeout(() => {
          if (!proc.killed) proc.kill("SIGKILL");
        }, 5000);
      };
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    }
  });

  const failed = aborted || exitCode !== 0 || stopReason === "error" || Boolean(errorMessage);
  const fallback = errorMessage || stderr.trim() || (aborted ? `${agent.name} was aborted.` : "No output returned.");
  const resultText = finalText || fallback;
  const stderrTailBlock = failed && stderr.trim() ? `\n\nStderr (tail):\n\`\`\`\n${stderr.slice(-2000)}\n\`\`\`` : "";
  const resultBody = stderrTailBlock
    ? `${capOutput(resultText, Math.max(0, 32_000 - Buffer.byteLength(stderrTailBlock, "utf8")), "Delegation result")}${stderrTailBlock}`
    : capOutput(resultText, 32_000, "Delegation result");

  return {
    content: [
      {
        type: "text",
        text: `${resultBody}${delegationFooter(agent.name, sessionId, turns, inputTokens, outputTokens, cacheReadTokens, cost)}`,
      },
    ],
    details: details(exitCode, failed ? "failed" : "done", finalText || undefined),
    isError: failed,
  };
}

async function runGit(args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn("git", args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (data) => {
      stdout += data.toString();
    });
    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });
    proc.on("close", (code) => resolve({ code: code ?? 0, stdout, stderr }));
    proc.on("error", (error) => resolve({ code: 1, stdout, stderr: String(error) }));
  });
}

function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

function delegationFooter(
  agentName: string,
  sessionId: string,
  turns: number,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  cost: number,
): string {
  const costSegment = cost > 0 ? ` · $${cost.toFixed(4)}` : "";
  const turnLabel = `${formatCount(turns)} ${turns === 1 ? "turn" : "turns"}`;
  return `\n\n---\n[${agentName} · session ${sessionId} · ${turnLabel} · ${formatCount(inputTokens)} in / ${formatCount(outputTokens)} out · cache ${formatCount(cacheReadTokens)} read${costSegment}]`;
}

function capOutput(text: string, maxBytes: number, label = "Output"): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;

  const note = `\n\n[${label} truncated to ${formatCount(maxBytes)} bytes.]`;
  const noteBytes = Buffer.byteLength(note, "utf8");
  if (noteBytes >= maxBytes) {
    let cappedNote = note.slice(0, maxBytes);
    while (Buffer.byteLength(cappedNote, "utf8") > maxBytes) cappedNote = cappedNote.slice(0, -1);
    return cappedNote;
  }

  const bodyMaxBytes = maxBytes - noteBytes;
  let capped = text.slice(0, bodyMaxBytes);
  while (Buffer.byteLength(capped, "utf8") > bodyMaxBytes) capped = capped.slice(0, -1);
  return `${capped}${note}`;
}

function isDelegationDetails(details: any): details is DelegationDetails {
  return Boolean(details && typeof details === "object" && Array.isArray(details.activity) && typeof details.status === "string");
}

function formatDelegationStats(details: DelegationDetails): string {
  const turnLabel = `${formatCount(details.turns)} ${details.turns === 1 ? "turn" : "turns"}`;
  const submittedInputTokens = submittedInputCount(details.inputTokens, details.cacheReadTokens, details.cacheWriteTokens);
  const parts = [turnLabel, `${compactTokenCount(submittedInputTokens)}→${compactTokenCount(details.outputTokens)}`];
  const cachedPct = cachedPctLabel(details.cacheReadTokens, details.cacheWriteTokens, submittedInputTokens);
  if (cachedPct) parts.push(cachedPct);
  if (details.cost > 0) parts.push(`$${details.cost.toFixed(4)}`);
  return parts.join(" · ");
}

function delegateHeader(agentLabel: string, details: DelegationDetails, theme: any): string {
  const agent = theme.fg("accent", theme.bold(agentLabel));
  if (details.status === "running") {
    const toolCalls = details.activity.filter((item) => item.kind === "tool").length;
    const stats = `${formatCount(details.turns)} turns · ${formatCount(toolCalls)} tool calls`;
    return `${theme.fg("warning", "⏳")} ${agent} ${theme.fg("warning", "working…")} ${theme.fg("dim", `· ${stats}`)}`;
  }
  const stats = formatDelegationStats(details);
  const statsText = stats ? theme.fg("dim", ` · ${stats}`) : "";
  if (details.status === "failed") return `${theme.fg("error", "✗")} ${agent} ${theme.fg("error", "failed")}${statsText}`;
  return `${theme.fg("success", "✓")} ${agent} ${theme.fg("success", "done")}${statsText}`;
}

function activityLine(item: ActivityItem, theme: any): string {
  if (item.kind === "text") return theme.fg("muted", `✎ ${item.summary}`);
  const prefix = item.isError ? "✗ " : "→ ";
  const suffix = item.pending ? "…" : "";
  const line = `${prefix}${item.summary}${suffix}`;
  return theme.fg(item.isError ? "error" : "dim", line);
}

function addActivitySummaries(container: Container, details: DelegationDetails, theme: any, limit?: number) {
  const items = details.activity;
  const skippedInMemory = limit ? Math.max(0, items.length - limit) : 0;
  const earlier = details.droppedCount + skippedInMemory;
  if (earlier > 0) container.addChild(new Text(theme.fg("muted", `… ${formatCount(earlier)} earlier items`), 0, 0));
  const toShow = limit ? items.slice(-limit) : items;
  if (toShow.length === 0 && earlier === 0) {
    container.addChild(new Text(theme.fg("muted", "(no subagent activity yet)"), 0, 0));
    return;
  }
  for (const item of toShow) container.addChild(new Text(activityLine(item, theme), 0, 0));
}

function detailBlockText(item: ActivityItem, theme: any, maxLines = 40, fromEnd = false): string | null {
  if (!item.detail) return null;
  const capped = capLines(item.detail, maxLines, fromEnd);
  const truncatedLine = capped.truncated ? `\n${theme.fg("dim", "… truncated")}` : "";
  if (item.tool === "edit") return `${renderDiff(capped.text)}${truncatedLine}`;
  const indented = capped.text
    .split(/\r?\n/)
    .map((line) => theme.fg("dim", `    ${line}`))
    .join("\n");
  return `${indented}${truncatedLine}`;
}

function addToolDetail(container: Container, item: ActivityItem, theme: any, maxLines = 40, fromEnd = false) {
  const detail = detailBlockText(item, theme, maxLines, fromEnd);
  if (detail) container.addChild(new Text(detail, 0, 0));
}

function fullReportText(result: any, details?: DelegationDetails): string {
  return details?.report || textFromContent(result?.content) || "(no output)";
}

function makeDelegateRenderers(agentLabel: string) {
  return {
    renderCall(args: any, theme: any, _context: any) {
      const task = oneLine(String(args?.task ?? "..."), 100) || "...";
      let text = `${theme.fg("toolTitle", theme.bold(agentLabel))} ${theme.fg("accent", task)}`;
      if (args?.sessionId) text += theme.fg("dim", ` (resume ${String(args.sessionId).slice(0, 8)})`);
      if (args?.cwd) text += theme.fg("dim", ` cwd=${args.cwd}`);
      return new Text(text, 0, 0);
    },

    renderResult(result: any, { expanded, isPartial }: { expanded: boolean; isPartial: boolean }, theme: any, _context: any) {
      const details = result.details;
      if (!isDelegationDetails(details)) return new Text(textFromContent(result?.content) || "(no output)", 0, 0);

      const container = new Container();
      container.addChild(new Text(delegateHeader(agentLabel, details, theme), 0, 0));

      if (isPartial) {
        if (expanded) {
          addActivitySummaries(container, details, theme, 20);
          const detailItems = details.activity.filter((item) => item.kind === "tool" && item.detail).slice(-2);
          for (const item of detailItems) {
            container.addChild(new Text(activityLine(item, theme), 0, 0));
            addToolDetail(container, item, theme, 24);
          }
          return container;
        }

        addActivitySummaries(container, details, theme, 5);
        const lastFinished = [...details.activity]
          .reverse()
          .find((item) => item.kind === "tool" && !item.pending);
        if (lastFinished?.tool === "edit" && lastFinished.detail) addToolDetail(container, lastFinished, theme, 12, true);
        return container;
      }

      if (!expanded) {
        const report = textFromContent(result?.content) || details.report || "(no output)";
        const cappedReport = firstLines(report, 12);
        container.addChild(new Text(cappedReport.text, 0, 0));
        if (cappedReport.truncated) container.addChild(new Text(theme.fg("dim", "… report truncated"), 0, 0));
        container.addChild(new Text(theme.fg("dim", "ctrl+o to expand subagent activity"), 0, 0));
        return container;
      }

      container.addChild(new Text(theme.fg("muted", "── activity ──"), 0, 0));
      if (details.droppedCount > 0) {
        container.addChild(new Text(theme.fg("muted", `… ${formatCount(details.droppedCount)} earlier items`), 0, 0));
      }
      if (details.activity.length === 0) {
        container.addChild(new Text(theme.fg("muted", "(no subagent activity captured)"), 0, 0));
      }
      for (const item of details.activity) {
        container.addChild(new Text(activityLine(item, theme), 0, 0));
        if (item.kind === "tool") addToolDetail(container, item, theme, 40);
      }
      container.addChild(new Text(theme.fg("muted", "── report ──"), 0, 0));
      container.addChild(new Text(fullReportText(result, details), 0, 0));
      return container;
    },
  };
}

function capReviewSections(
  sections: { status: string; stat: string; diff: string; untracked: string },
  maxBytes: number,
): { status: string; stat: string; diff: string; untracked: string } {
  let remaining = maxBytes;
  const take = (text: string, label: string) => {
    if (!text || remaining <= 0) return "";
    const capped = capOutput(text, remaining, label);
    remaining -= Buffer.byteLength(capped, "utf8");
    return capped;
  };
  return {
    status: take(sections.status, "Git status"),
    stat: take(sections.stat, "Diff stats"),
    diff: take(sections.diff, "Diff"),
    untracked: take(sections.untracked, "Untracked diff"),
  };
}

function addReviewText(container: Container, text: string, theme: any, diff = false, spacer = true) {
  if (!text) return;
  container.addChild(new Text(diff ? renderDiff(text) : text, 0, 0));
  if (spacer) container.addChild(new Spacer(1));
}

function makeReviewDiffRenderers() {
  return {
    renderCall(args: any, theme: any, _context: any) {
      const cwd = args?.cwd || ".";
      let text = `${theme.fg("toolTitle", theme.bold("review_diff"))} ${theme.fg("accent", cwd)}`;
      if (Array.isArray(args?.paths) && args.paths.length > 0) text += theme.fg("dim", ` ${args.paths.join(" ")}`);
      return new Text(text, 0, 0);
    },

    renderResult(result: any, { expanded }: { expanded: boolean }, theme: any, _context: any) {
      const details = result.details as any;
      const content = textFromContent(result?.content) || "(no output)";
      const sections = details?.sections;
      if (!sections) return new Text(result.isError ? theme.fg("error", content) : content, 0, 0);

      const container = new Container();
      if (!expanded) {
        addReviewText(container, sections.status, theme, false, false);
        addReviewText(container, sections.stat, theme, false, false);
        container.addChild(new Text(theme.fg("dim", "ctrl+o for full colored diff"), 0, 0));
        return container;
      }

      addReviewText(container, sections.status, theme);
      addReviewText(container, sections.stat, theme);
      addReviewText(container, sections.diff, theme, true);
      addReviewText(container, sections.untracked, theme, true);
      if (details.truncated) container.addChild(new Text(theme.fg("warning", "Diff output truncated by maxBytes."), 0, 0));
      return container;
    },
  };
}

export default function orchestratorWorkflow(pi: ExtensionAPI) {
  const totals = zeroTotalsRecord();
  let config = loadOrchestratorConfig();
  let authTypes: Record<string, AuthType> | undefined;
  let orchestratorUsageSnapshot: UsageSnapshot | undefined;
  let statusWidgetTimer: ReturnType<typeof setTimeout> | undefined;
  let pendingStatusWidgetCtx: any;
  let lastStatusWidgetRenderAt = 0;

  const getAuthTypes = (): Record<string, AuthType> => {
    if (authTypes) return authTypes;
    authTypes = {};
    try {
      const authPath = path.join(getAgentDir(), "auth.json");
      if (!fs.existsSync(authPath)) return authTypes;
      const parsed = JSON.parse(fs.readFileSync(authPath, "utf8"));
      if (!parsed || typeof parsed !== "object") return authTypes;
      for (const [provider, value] of Object.entries(parsed as Record<string, any>)) {
        if (value?.type === "oauth" || value?.type === "api_key") authTypes[provider] = value.type;
      }
    } catch {
      authTypes = {};
    }
    return authTypes;
  };

  const getBillingOverride = (role: Role): BillingOverride | undefined => {
    if (role === "orchestrator") return undefined;
    try {
      return loadAgent(role).billing;
    } catch {
      return undefined;
    }
  };

  const getBillingSegment = (role: Role, provider: string | undefined, cost: number): { label: string; dollarCost: number } => {
    const override = getBillingOverride(role);
    if (override === "subscription") return { label: "sub", dollarCost: 0 };
    if (override === "api") return { label: `$${cost.toFixed(4)} api`, dollarCost: cost };

    const authType = provider ? getAuthTypes()[provider] : undefined;
    if (authType === "oauth") return { label: "sub", dollarCost: 0 };
    if (authType === "api_key") return { label: `$${cost.toFixed(4)} api`, dollarCost: cost };
    if (cost > 0) return { label: `$${cost.toFixed(4)}`, dollarCost: cost };
    return { label: "", dollarCost: 0 };
  };

  const getStatusView = (): StatusView => config.statusView ?? "default";
  const getActiveStatusRoles = (): Role[] => ROLES.filter((role) => hasRoleActivity(totals[role]));
  const statusRowPrefix = (index: number): string => (index === 0 ? "agents " : "  ");

  const aggregateStatusTotals = (activeRoles: Role[]) => {
    let requests = 0;
    let input = 0;
    let output = 0;
    let cacheRead = 0;
    let cacheWrite = 0;
    let totalDollarCost = 0;
    let hasSubscription = false;

    for (const role of activeRoles) {
      const total = totals[role];
      const provider = total.lastModel?.split("/")[0];
      const billing = getBillingSegment(role, provider, total.cost);
      requests += total.requests;
      input += total.input;
      output += total.output;
      cacheRead += total.cacheRead;
      cacheWrite += total.cacheWrite;
      totalDollarCost += billing.dollarCost;
      if (billing.label === "sub") hasSubscription = true;
    }

    return { requests, input, output, cacheRead, cacheWrite, totalDollarCost, hasSubscription };
  };

  const compactAggregateParts = (activeRoles: Role[], aggregate: ReturnType<typeof aggregateStatusTotals>): string[] => {
    const submitted = submittedInputCount(aggregate.input, aggregate.cacheRead, aggregate.cacheWrite);
    const parts = [
      `${activeRoles.length} ${activeRoles.length === 1 ? "role" : "roles"}`,
      `${formatCount(aggregate.requests)} req`,
      `${compactTokenCount(submitted)}→${compactTokenCount(aggregate.output)}`,
    ];
    const cachedPct = cachedPctLabel(aggregate.cacheRead, aggregate.cacheWrite, submitted);
    if (cachedPct) parts.push(cachedPct);
    if (aggregate.totalDollarCost > 0) parts.push(`$${aggregate.totalDollarCost.toFixed(4)} api`);
    if (aggregate.hasSubscription) parts.push("sub");
    return parts;
  };

  const compactCacheDetail = (cacheRead: number, cacheWrite: number, submitted: number): string => {
    const cachedPct = cachedPctLabel(cacheRead, cacheWrite, submitted).replace(" cached", "");
    return `cache ${compactTokenCount(cacheRead)}r/${compactTokenCount(cacheWrite)}w${cachedPct ? ` (${cachedPct})` : ""}`;
  };

  const refreshStatusWidgetNow = (ctx: any) => {
    if (config.statusWidget === false) {
      ctx.ui.setWidget("agent-status", undefined);
      return;
    }

    const activeRoles = getActiveStatusRoles();
    if (activeRoles.length === 0) {
      ctx.ui.setWidget("agent-status", undefined);
      return;
    }

    const view = getStatusView();
    const lines: string[] = [];

    if (view === "minimal") {
      lines.push(["agents", ...compactAggregateParts(activeRoles, aggregateStatusTotals(activeRoles))].join(" · "));
    } else if (view === "detailed") {
      activeRoles.forEach((role, index) => {
        const total = totals[role];
        const provider = total.lastModel?.split("/")[0];
        const billing = getBillingSegment(role, provider, total.cost);
        const submitted = submittedInputCount(total.input, total.cacheRead, total.cacheWrite);
        const parts = [
          role,
          total.lastModel || "unknown",
          `${formatCount(total.requests)} req`,
          `in ${compactTokenCount(submitted)}→out ${compactTokenCount(total.output)}`,
          compactCacheDetail(total.cacheRead, total.cacheWrite, submitted),
        ];
        if (billing.label) parts.push(billing.label);
        lines.push(`${statusRowPrefix(index)}${parts.join(" · ")}`);
      });
    } else {
      const providers = new Set(
        activeRoles.map((role) => totals[role].lastModel?.split("/")[0]).filter((value): value is string => Boolean(value)),
      );
      const dropProvider = providers.size <= 1;
      let totalDollarCost = 0;
      let payingRoles = 0;

      activeRoles.forEach((role, index) => {
        const total = totals[role];
        const provider = total.lastModel?.split("/")[0];
        const billing = getBillingSegment(role, provider, total.cost);
        totalDollarCost += billing.dollarCost;
        if (billing.dollarCost > 0) payingRoles += 1;

        const submitted = submittedInputCount(total.input, total.cacheRead, total.cacheWrite);
        const parts = [
          role,
          shortModelLabel(total.lastModel, dropProvider),
          `${formatCount(total.requests)} req`,
          `${compactTokenCount(submitted)}→${compactTokenCount(total.output)}`,
        ];
        const cachedPct = cachedPctLabel(total.cacheRead, total.cacheWrite, submitted);
        if (cachedPct) parts.push(cachedPct);
        if (billing.label) parts.push(billing.label);

        lines.push(`${statusRowPrefix(index)}${parts.join(" · ")}`);
      });

      if (payingRoles >= 2) lines.push(`  total · $${totalDollarCost.toFixed(4)}`);
    }

    ctx.ui.setWidget("agent-status", lines, { placement: "belowEditor" });
  };

  const refreshStatusWidget = (ctx: any, force = false) => {
    pendingStatusWidgetCtx = ctx;
    if (force) {
      if (statusWidgetTimer) clearTimeout(statusWidgetTimer);
      statusWidgetTimer = undefined;
      pendingStatusWidgetCtx = undefined;
      lastStatusWidgetRenderAt = Date.now();
      refreshStatusWidgetNow(ctx);
      return;
    }

    const now = Date.now();
    const elapsed = now - lastStatusWidgetRenderAt;
    if (elapsed >= 150 && !statusWidgetTimer) {
      pendingStatusWidgetCtx = undefined;
      lastStatusWidgetRenderAt = now;
      refreshStatusWidgetNow(ctx);
      return;
    }

    if (!statusWidgetTimer) {
      statusWidgetTimer = setTimeout(() => {
        const queuedCtx = pendingStatusWidgetCtx;
        pendingStatusWidgetCtx = undefined;
        statusWidgetTimer = undefined;
        lastStatusWidgetRenderAt = Date.now();
        if (queuedCtx) refreshStatusWidgetNow(queuedCtx);
      }, Math.max(0, 150 - elapsed));
    }
  };

  const recordUsageDelta = (role: Role, delta: UsageDelta, ctx: any, force = false) => {
    addUsageDeltaToTotals(totals, role, delta);
    refreshStatusWidget(ctx, force || Boolean(delta.requests));
  };

  const rebuildTotalsFromSession = (ctx: any) => {
    resetTotals(totals);
    for (const entry of ctx.sessionManager.getEntries()) {
      const message = entry?.message;
      if (!message) continue;
      if (message.role === "assistant") {
        addUsageDeltaToTotals(
          totals,
          "orchestrator",
          usageDeltaFromUsage(message.usage, 1, message.provider, message.model),
        );
        continue;
      }

      if (message.role !== "toolResult") continue;
      let role: Role | undefined;
      if (message.toolName === "delegate_researcher") role = "researcher";
      else if (message.toolName === "delegate_implementor") role = "implementor";
      else if (message.toolName === "delegate_design") role = "design";
      if (!role) continue;
      const details = message.details;
      if (!details || typeof details !== "object") continue;
      const hasDelegationStats =
        ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "cost"].some(
          (key) => typeof details[key] === "number",
        ) ||
        (typeof details.provider === "string" && typeof details.model === "string");
      if (!hasDelegationStats) continue;
      addUsageDeltaToTotals(totals, role, {
        input: safeNumber(details.inputTokens),
        output: safeNumber(details.outputTokens),
        cacheRead: safeNumber(details.cacheReadTokens),
        cacheWrite: safeNumber(details.cacheWriteTokens),
        cost: safeNumber(details.cost),
        requests: safeNumber(details.turns) || 1,
        provider: typeof details.provider === "string" ? details.provider : undefined,
        model: typeof details.model === "string" ? details.model : undefined,
      });
    }
  };

  const applyConfiguredOrchestrator = async (ctx: any) => {
    const configured = config.orchestrator;
    if (!configured) return;
    const model = ctx.modelRegistry.find(configured.provider, configured.model);
    if (!model) {
      ctx.ui.notify(`Configured orchestrator model not found: ${configured.provider}/${configured.model}`, "warning");
      return;
    }
    const ok = await pi.setModel(model);
    if (!ok) {
      ctx.ui.notify(`Configured orchestrator model is not available: ${configured.provider}/${configured.model}`, "warning");
      return;
    }
    pi.setThinkingLevel(configured.thinking);
  };

  const getModelOptions = (ctx: any) => {
    const preferred = ctx.modelRegistry.getAvailable();
    const models = preferred.length > 0 ? preferred : ctx.modelRegistry.getAll();
    const byKey = new Map<string, any>();
    for (const model of models) {
      if (typeof model?.provider !== "string" || typeof model?.id !== "string") continue;
      byKey.set(`${model.provider}/${model.id}`, model);
    }
    return [...byKey.keys()].sort((a, b) => a.localeCompare(b));
  };

  const selectModel = async (ctx: any): Promise<{ provider: string; model: string } | undefined> => {
    const options = getModelOptions(ctx);
    if (options.length === 0) {
      ctx.ui.notify("No models found in the model registry.", "error");
      return undefined;
    }

    let choice: string | undefined;
    if (options.length > 60) {
      const providers = [...new Set(options.map((option) => option.slice(0, option.indexOf("/"))))].sort((a, b) =>
        a.localeCompare(b),
      );
      const provider = await ctx.ui.select("Choose provider", providers);
      if (!provider) return undefined;
      choice = await ctx.ui.select(
        `Choose model for ${provider}`,
        options.filter((option) => option.startsWith(`${provider}/`)),
      );
    } else {
      choice = await ctx.ui.select("Choose model", options);
    }
    if (!choice) return undefined;
    const slash = choice.indexOf("/");
    if (slash <= 0) return undefined;
    return { provider: choice.slice(0, slash), model: choice.slice(slash + 1) };
  };

  const formatAgentsShow = (ctx: any): string => {
    const configured = config.orchestrator;
    const orchestratorProvider = ctx.model?.provider ?? configured?.provider ?? "unset";
    const orchestratorModel = ctx.model?.id ?? configured?.model ?? "unset";
    const orchestratorThinking = ctx.model ? pi.getThinkingLevel() : (configured?.thinking ?? pi.getThinkingLevel());
    const researcher = loadAgent("researcher");
    const implementor = loadAgent("implementor");
    const design = loadAgent("design");
    return [
      `orchestrator ${orchestratorProvider}/${orchestratorModel}:${orchestratorThinking}`,
      `researcher ${researcher.provider}/${researcher.model}:${researcher.thinking}`,
      `implementor ${implementor.provider}/${implementor.model}:${implementor.thinking}`,
      `design ${design.provider}/${design.model}:${design.thinking}`,
    ].join(" · ");
  };

  const formatStatusSummary = (): string => {
    const activeRoles = getActiveStatusRoles();
    const mode = config.statusWidget === false ? `off (${getStatusView()})` : getStatusView();
    if (activeRoles.length === 0) return ["agents", mode, "no activity"].join(" · ");
    return ["agents", mode, ...compactAggregateParts(activeRoles, aggregateStatusTotals(activeRoles))].join(" · ");
  };

  pi.registerTool({
    name: "delegate_researcher",
    label: "Researcher",
    description:
      "Delegate read-only codebase research to the researcher subagent. Use for context gathering, relevance mapping, use-case tracing, and architecture questions before implementation. Fire independent research questions as parallel calls.",
    promptSnippet: delegatePromptSnippet(
      "researcher",
      "read-only context and relevance research",
      " Fire independent questions as parallel calls.",
    ),
    parameters: delegateParams,
    executionMode: "parallel",
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const result = await runDelegatedAgent(
        "researcher",
        params.task,
        params.cwd || ctx.cwd,
        signal,
        onUpdate,
        (delta) => recordUsageDelta("researcher", delta, ctx),
        params.sessionId,
        params.thinking as ThinkingLevel | undefined,
      );
      refreshStatusWidget(ctx, true);
      return result;
    },
    ...makeDelegateRenderers("Researcher"),
  });

  pi.registerTool({
    name: "delegate_implementor",
    label: "Implementor",
    description:
      "Delegate implementation to the implementor subagent. Use this for all file edits, code generation, migrations, and targeted validation when useful.",
    promptSnippet: delegatePromptSnippet("implementor", "implementation and targeted validation"),
    promptGuidelines: [
      "All implementation work should be delegated to delegate_implementor and reviewed afterward with review_diff.",
      "For follow-up fixes or the next milestone of the same work, pass the previous delegation's sessionId to delegate_implementor to continue with retained context.",
    ],
    parameters: delegateParams,
    executionMode: "sequential",
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const result = await runDelegatedAgent(
        "implementor",
        params.task,
        params.cwd || ctx.cwd,
        signal,
        onUpdate,
        (delta) => recordUsageDelta("implementor", delta, ctx),
        params.sessionId,
        params.thinking as ThinkingLevel | undefined,
      );
      refreshStatusWidget(ctx, true);
      return result;
    },
    ...makeDelegateRenderers("Implementor"),
  });

  pi.registerTool({
    name: "delegate_design",
    label: "Design",
    description:
      "Delegate a design/UI/UX review-and-fix pass after UI-affecting implementation is complete. It inspects the changed surface, fixes visual/interaction/accessibility issues, and reports deferred UX concerns.",
    promptSnippet: delegatePromptSnippet("design", "design/UI/UX review-and-fix pass"),
    promptGuidelines: [
      "After UI-affecting implementation passes review_diff, run delegate_design scoped to the changed surface, then review_diff again. Skip it for changes with no UI impact.",
    ],
    parameters: delegateParams,
    executionMode: "sequential",
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const result = await runDelegatedAgent(
        "design",
        params.task,
        params.cwd || ctx.cwd,
        signal,
        onUpdate,
        (delta) => recordUsageDelta("design", delta, ctx),
        params.sessionId,
        params.thinking as ThinkingLevel | undefined,
      );
      refreshStatusWidget(ctx, true);
      return result;
    },
    ...makeDelegateRenderers("Design"),
  });

  pi.registerTool({
    name: "review_diff",
    label: "Review Diff",
    description:
      "Collect git status plus a combined staged+unstaged diff against HEAD and untracked file contents for orchestrator review, with an optional paths filter.",
    promptSnippet: "review_diff: inspect git status and combined diff before final orchestrator review.",
    parameters: diffParams,
    executionMode: "sequential",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = params.cwd || ctx.cwd;
      const paths = Array.isArray(params.paths)
        ? params.paths.filter((pathspec: unknown): pathspec is string => typeof pathspec === "string" && pathspec.length > 0)
        : [];
      const maxBytes = params.maxBytes ?? 80_000;
      const withPaths = (args: string[]) => (paths.length > 0 ? [...args, "--", ...paths] : args);
      const section = (title: string, body: string, empty = "(none)") => `# ${title}\n\n${body || empty}`;

      const inside = await runGit(["rev-parse", "--is-inside-work-tree"], cwd);
      if (inside.code !== 0 || inside.stdout.trim() !== "true") {
        return {
          content: [{ type: "text", text: `Not a git worktree: ${cwd}\n${inside.stderr}`.trim() }],
          details: { cwd, status: "not_git" },
          isError: true,
        };
      }

      const status = await runGit(withPaths(["status", "--short"]), cwd);
      const head = await runGit(["rev-parse", "--verify", "HEAD"], cwd);
      const statusSection = section("Git Status", status.stdout, "(clean)");
      const statSections: string[] = [];
      const diffSections: string[] = [];
      const untrackedSections: string[] = [];
      const sections = [statusSection];

      if (head.code === 0) {
        const stat = await runGit(withPaths(["diff", "HEAD", "--stat"]), cwd);
        const diff = await runGit(withPaths(["diff", "HEAD"]), cwd);
        const statSection = section("Diff Stat (HEAD)", stat.stdout);
        const diffSection = section("Diff (HEAD)", diff.stdout);
        statSections.push(statSection);
        diffSections.push(diffSection);
        sections.push(statSection, diffSection);
      } else {
        const stat = await runGit(withPaths(["diff", "--stat"]), cwd);
        const diff = await runGit(withPaths(["diff"]), cwd);
        const stagedStat = await runGit(withPaths(["diff", "--staged", "--stat"]), cwd);
        const stagedDiff = await runGit(withPaths(["diff", "--staged"]), cwd);
        const unstagedStatSection = section("Unstaged Diff Stat", stat.stdout);
        const unstagedDiffSection = section("Unstaged Diff", diff.stdout);
        const stagedStatSection = section("Staged Diff Stat", stagedStat.stdout);
        const stagedDiffSection = section("Staged Diff", stagedDiff.stdout);
        statSections.push(unstagedStatSection, stagedStatSection);
        diffSections.push(unstagedDiffSection, stagedDiffSection);
        sections.push(unstagedStatSection, unstagedDiffSection, stagedStatSection, stagedDiffSection);
      }

      const untracked = await runGit(withPaths(["ls-files", "--others", "--exclude-standard"]), cwd);
      const untrackedFiles = untracked.stdout
        .split(/\r?\n/)
        .filter((file) => file.length > 0);
      const diffableUntrackedFiles = untrackedFiles.slice(0, 20);
      const untrackedList =
        untrackedFiles.length > 20
          ? `${diffableUntrackedFiles.join("\n")}\n\n(${untrackedFiles.length - 20} more listed after diff sections.)`
          : untrackedFiles.join("\n");
      const untrackedSection = section("Untracked Files", untrackedList);
      untrackedSections.push(untrackedSection);
      sections.push(untrackedSection);

      if (diffableUntrackedFiles.length > 0) {
        const untrackedDiffSections: string[] = [];
        for (const file of diffableUntrackedFiles) {
          const diff = await runGit(["diff", "--no-index", "--", "/dev/null", file], cwd);
          const diffOutput = diff.stdout || (diff.stderr ? `Stderr:\n${diff.stderr}` : "(no diff output)");
          untrackedDiffSections.push(`## ${file}\n\n${capOutput(diffOutput, 20_000, "Untracked file diff")}`);
        }
        const untrackedDiffSection = section(
          untrackedFiles.length > 20 ? "Untracked File Diffs (first 20)" : "Untracked File Diffs",
          untrackedDiffSections.join("\n\n"),
        );
        untrackedSections.push(untrackedDiffSection);
        sections.push(untrackedDiffSection);

        if (untrackedFiles.length > 20) {
          const remainingUntrackedSection = section("Remaining Untracked Files", untrackedFiles.slice(20).join("\n"));
          untrackedSections.push(remainingUntrackedSection);
          sections.push(remainingUntrackedSection);
        }
      }

      const output = sections.join("\n\n");
      const cappedOutput = capOutput(output, maxBytes, "Diff output");
      const sectionDetails = capReviewSections(
        {
          status: statusSection,
          stat: statSections.join("\n\n"),
          diff: diffSections.join("\n\n"),
          untracked: untrackedSections.join("\n\n"),
        },
        maxBytes,
      );
      return {
        content: [{ type: "text", text: cappedOutput }],
        details: {
          cwd,
          status: status.stdout,
          truncated: Buffer.byteLength(output, "utf8") > maxBytes,
          output: cappedOutput,
          sections: sectionDetails,
        },
      };
    },
    ...makeReviewDiffRenderers(),
  });

  pi.registerCommand("agents-status", {
    description: "Configure the live agents status widget",
    getArgumentCompletions: (prefix) => {
      const values = [...STATUS_VIEWS, "off", "on", "show", "reset"];
      const filtered = values.filter((value) => value.startsWith((prefix || "").trim()));
      return filtered.length > 0 ? filtered.map((value) => ({ value, label: value })) : null;
    },
    handler: async (args, ctx) => {
      const action = (args || "").trim();
      if (isStatusView(action)) {
        config = saveOrchestratorConfig({ statusView: action, statusWidget: true });
        refreshStatusWidget(ctx, true);
        ctx.ui.notify(`Agents status view set to ${action}.`, "info");
        return;
      }
      if (action === "off") {
        config = saveOrchestratorConfig({ statusWidget: false });
        refreshStatusWidget(ctx, true);
        ctx.ui.notify("Agents status widget disabled.", "info");
        return;
      }
      if (action === "on") {
        config = saveOrchestratorConfig({ statusWidget: true });
        refreshStatusWidget(ctx, true);
        ctx.ui.notify(`Agents status widget enabled (${getStatusView()}).`, "info");
        return;
      }
      if (action === "show") {
        ctx.ui.notify(formatStatusSummary(), "info");
        return;
      }
      if (action === "reset") {
        resetTotals(totals);
        refreshStatusWidget(ctx, true);
        ctx.ui.notify("Agents status totals reset.", "info");
        return;
      }
      if (action) {
        ctx.ui.notify(`Unknown /agents-status argument: ${action}`, "error");
        return;
      }

      const currentIndex = STATUS_VIEWS.indexOf(getStatusView());
      const nextView = STATUS_VIEWS[(currentIndex + 1) % STATUS_VIEWS.length];
      config = saveOrchestratorConfig({ statusView: nextView, statusWidget: true });
      refreshStatusWidget(ctx, true);
      ctx.ui.notify(`Agents status view set to ${nextView}.`, "info");
    },
  });

  pi.registerCommand("agents", {
    description: "Configure per-role provider, model, and thinking level",
    getArgumentCompletions: (prefix) => {
      const values = ["show"];
      const filtered = values.filter((value) => value.startsWith((prefix || "").trim()));
      return filtered.length > 0 ? filtered.map((value) => ({ value, label: value })) : null;
    },
    handler: async (args, ctx) => {
      const action = (args || "").trim();
      if (action === "show") {
        ctx.ui.notify(formatAgentsShow(ctx), "info");
        return;
      }
      if (action) {
        ctx.ui.notify(`Unknown /agents argument: ${action}`, "error");
        return;
      }

      const role = (await ctx.ui.select("Configure which role?", ["orchestrator", "researcher", "implementor", "design"])) as Role | undefined;
      if (!role) return;
      const selected = await selectModel(ctx);
      if (!selected) return;
      const thinking = (await ctx.ui.select("Thinking level", THINKING_LEVELS)) as ThinkingLevel | undefined;
      if (!thinking) return;

      if (role === "orchestrator") {
        const model = ctx.modelRegistry.find(selected.provider, selected.model);
        if (!model) {
          ctx.ui.notify(`Model not found: ${selected.provider}/${selected.model}`, "error");
          return;
        }
        const ok = await pi.setModel(model);
        if (!ok) {
          ctx.ui.notify(`No configured auth for ${selected.provider}/${selected.model}; model not changed.`, "error");
          return;
        }
        pi.setThinkingLevel(thinking);
        config = saveOrchestratorConfig({ orchestrator: { provider: selected.provider, model: selected.model, thinking } });
        ctx.ui.notify(`orchestrator set to ${selected.provider}/${selected.model}:${thinking}`, "info");
        return;
      }

      updateAgentFrontmatter(role, { provider: selected.provider, model: selected.model, thinking });
      ctx.ui.notify(`${role} set to ${selected.provider}/${selected.model}:${thinking}; applies to the next delegation.`, "info");
    },
  });

  pi.on("before_agent_start", async (event) => {
    const prompt = loadBundledOrchestratorPrompt();
    if (!prompt) return;
    return { systemPrompt: `${event.systemPrompt}\n\n${prompt}` };
  });

  pi.on("message_update", async (event, ctx) => {
    const message = event.message;
    if (message?.role !== "assistant" || !message.usage) return;

    const nextSnapshot = usageSnapshotFromUsage(message.usage);
    if (usageSnapshotsEqual(orchestratorUsageSnapshot, nextSnapshot)) return;

    const delta = usageDeltaFromSnapshots(orchestratorUsageSnapshot, nextSnapshot, 0, message.provider, message.model);
    orchestratorUsageSnapshot = nextSnapshot;
    if (hasUsageDeltaValues(delta)) recordUsageDelta("orchestrator", delta, ctx);
  });

  pi.on("message_end", async (event, ctx) => {
    const message = event.message;
    if (message?.role !== "assistant") return;

    const finalSnapshot = message.usage ? usageSnapshotFromUsage(message.usage) : undefined;
    const delta = usageDeltaFromSnapshots(orchestratorUsageSnapshot, finalSnapshot, 1, message.provider, message.model);
    orchestratorUsageSnapshot = undefined;
    recordUsageDelta("orchestrator", delta, ctx, true);
  });

  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.setStatus("workflow", "orchestrator");
    config = loadOrchestratorConfig();
    orchestratorUsageSnapshot = undefined;
    rebuildTotalsFromSession(ctx);
    await applyConfiguredOrchestrator(ctx);
    refreshStatusWidget(ctx, true);
  });

  pi.on("session_shutdown", async () => {
    if (statusWidgetTimer) clearTimeout(statusWidgetTimer);
    statusWidgetTimer = undefined;
    pendingStatusWidgetCtx = undefined;
    orchestratorUsageSnapshot = undefined;
  });
}
