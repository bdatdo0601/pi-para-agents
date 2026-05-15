import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const EXTENSION_NAME = "pi-para-agents";
const LEGACY_EXTENSION_NAME = "tmux-agents";
const DEFAULT_DETACHED_SESSION = "pi-agents";
const STATUS_REFRESH_MS = 5000;
const ACTIVITY_FILE = "activity.json";

interface AgentRecord {
	id: string;
	cwd: string;
	promptPreview: string;
	promptPath: string;
	scriptPath: string;
	statusPath: string;
	logPath: string;
	sessionPath?: string;
	parentWindowId?: string;
	parentWindowName?: string;
	inheritedArgs?: string[];
	forkedFromSessionPath?: string;
	forkedFromEntryId?: string | null;
	createdAt: string;
	tmuxSession: string;
	tmuxWindowId: string;
	tmuxWindowName: string;
	attachedToParentSession: boolean;
	killedAt?: string;
}

interface TmuxWindowInfo {
	session: string;
	windowId: string;
	windowName: string;
	paneCommand: string;
	paneDead: boolean;
}

interface TmuxWindowsResult {
	windows: Map<string, TmuxWindowInfo>;
	ok: boolean;
}

type AgentActivityKind = "starting" | "in-progress" | "idle" | "needs-response" | "done" | "failed" | "missing" | "unknown";

interface AgentActivity {
	kind: AgentActivityKind;
	detail?: string;
	updatedAt: string;
	latestMessages?: string[];
}

interface ForkSource {
	sessionPath: string;
	leafId: string | null;
	entries: unknown[];
	version?: number;
}

interface SpawnAgentOptions {
	forkSource?: ForkSource;
}

interface AgentViewModel extends AgentRecord {
	status: string;
	statusKind: "running" | "exited" | "killed" | "missing" | "failed" | "unknown";
	activity: AgentActivity;
	conversationMessages: string[];
	currentPrompt: string;
	latestMessage: string;
	window?: TmuxWindowInfo;
	panePreview?: string[];
}

function configDir(): string {
	return process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
}

function stateDir(): string {
	return path.join(configDir(), EXTENSION_NAME);
}

function legacyStateDir(): string {
	return path.join(configDir(), LEGACY_EXTENSION_NAME);
}

function registryPath(): string {
	return path.join(stateDir(), "agents.json");
}

function legacyRegistryPath(): string {
	return path.join(legacyStateDir(), "agents.json");
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function shellArrayLiteral(values: string[]): string {
	return values.map((value) => shellQuote(value)).join(" ");
}

function inheritedPiArgsFromArgv(argv: string[]): string[] {
	const inherited: string[] = [];
	const valueFlags = new Set([
		"-e",
		"--extension",
		"--skill",
		"--prompt-template",
		"--theme",
		"--tools",
		"-t",
	]);
	const booleanFlags = new Set([
		"--no-extensions",
		"--no-skills",
		"--no-prompt-templates",
		"--no-themes",
		"--no-context-files",
		"-nc",
		"--no-builtin-tools",
		"-nbt",
		"--no-tools",
		"-nt",
	]);

	for (let i = 2; i < argv.length; i++) {
		const arg = argv[i];
		const equalsIndex = arg.indexOf("=");
		if (equalsIndex > 0) {
			const flag = arg.slice(0, equalsIndex);
			if (valueFlags.has(flag)) inherited.push(flag, arg.slice(equalsIndex + 1));
			continue;
		}
		if (valueFlags.has(arg)) {
			const value = argv[i + 1];
			if (value !== undefined) {
				inherited.push(arg, value);
				i++;
			}
			continue;
		}
		if (booleanFlags.has(arg)) inherited.push(arg);
	}

	return inherited;
}

function inheritedPiArgs(): string[] {
	return inheritedPiArgsFromArgv(process.argv);
}

function hasAnyFlag(args: string[], flags: string[]): boolean {
	const flagSet = new Set(flags);
	for (const arg of args) {
		const equalsIndex = arg.indexOf("=");
		const flag = equalsIndex > 0 ? arg.slice(0, equalsIndex) : arg;
		if (flagSet.has(flag)) return true;
	}
	return false;
}

function extensionArgValues(args: string[]): Set<string> {
	const values = new Set<string>();
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--extension" || arg === "-e") {
			const value = args[i + 1];
			if (value) values.add(path.resolve(value));
			i++;
			continue;
		}
		const equalsIndex = arg.indexOf("=");
		if (equalsIndex > 0) {
			const flag = arg.slice(0, equalsIndex);
			if (flag === "--extension" || flag === "-e") values.add(path.resolve(arg.slice(equalsIndex + 1)));
		}
	}
	return values;
}

function loadableExtensionPath(value: unknown): string | null {
	if (typeof value !== "string" || !value || value.startsWith("<")) return null;
	const resolved = path.resolve(value);
	return existsSync(resolved) ? resolved : null;
}

function explicitExtensionArgs(pi: ExtensionAPI, inheritedArgs: string[]): string[] {
	const seen = extensionArgValues(inheritedArgs);
	const paths = new Set<string>();
	const addPath = (value: unknown) => {
		const resolved = loadableExtensionPath(value);
		if (resolved && !seen.has(resolved)) paths.add(resolved);
	};

	try {
		for (const command of pi.getCommands?.() ?? []) {
			if ((command as any).source === "extension") addPath((command as any).sourceInfo?.path);
		}
	} catch {
		// Runtime may not be bound in tests/load smoke checks.
	}

	try {
		const activeTools = new Set(pi.getActiveTools?.() ?? []);
		for (const tool of pi.getAllTools?.() ?? []) {
			if (activeTools.has((tool as any).name)) addPath((tool as any).sourceInfo?.path);
		}
	} catch {
		// Runtime may not be bound in tests/load smoke checks.
	}

	// The parent may have loaded this extension via /reload from the user extension
	// directory without it being installed as a package. Make child loading explicit.
	addPath(path.join(configDir(), "extensions", EXTENSION_NAME, "index.ts"));

	return [...paths].flatMap((extensionPath) => ["--extension", extensionPath]);
}

function activeToolArgs(pi: ExtensionAPI, inheritedArgs: string[]): string[] {
	if (hasAnyFlag(inheritedArgs, ["--tools", "-t", "--no-tools", "-nt"])) return [];
	try {
		const activeTools = pi.getActiveTools?.() ?? [];
		return activeTools.length > 0 ? ["--tools", activeTools.join(",")] : [];
	} catch {
		return [];
	}
}

function childPiArgs(pi: ExtensionAPI): string[] {
	const inheritedArgs = inheritedPiArgs();
	return [...inheritedArgs, ...explicitExtensionArgs(pi, inheritedArgs), ...activeToolArgs(pi, inheritedArgs)];
}

function sessionFileTimestamp(timestamp: string): string {
	return timestamp.replace(/[:.]/g, "-");
}

function stripControlSequences(value: string): string {
	return value
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
		.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

function normalizeCwd(raw: string, baseCwd: string): string {
	const trimmed = raw.trim().replace(/^['"]|['"]$/g, "");
	return path.resolve(baseCwd, trimmed || ".");
}

function isAllCwdArg(raw: string): boolean {
	const value = raw.trim().toLowerCase();
	return value === "all" || value === "--all" || value === "*";
}

function promptPreview(prompt: string): string {
	const singleLine = prompt.replace(/\s+/g, " ").trim();
	return singleLine.length > 100 ? `${singleLine.slice(0, 97)}...` : singleLine;
}

function agentSessionPath(record: AgentRecord): string {
	return record.sessionPath ?? path.join(path.dirname(record.promptPath), "session.jsonl");
}

function agentActivityPath(record: AgentRecord): string {
	return path.join(path.dirname(record.statusPath), ACTIVITY_FILE);
}

function forkSourceFromContext(ctx: any): ForkSource {
	const sessionManager = ctx.sessionManager;
	const sessionPath = sessionManager?.getSessionFile?.();
	if (!sessionPath) {
		throw new Error("Current Pi session is not persisted, so it cannot be forked. Start a saved session or use /spawn instead.");
	}
	const leafId = sessionManager.getLeafId?.() ?? null;
	const branchEntries = leafId ? (sessionManager.getBranch?.(leafId) ?? []) : [];
	const allEntries = sessionManager.getEntries?.() ?? [];
	const entries = branchEntries.length > 0 ? branchEntries : allEntries;
	const version = sessionManager.getHeader?.()?.version;
	return { sessionPath, leafId, entries, version };
}

async function writeForkedSession(agentDir: string, cwd: string, source: ForkSource): Promise<string> {
	await fs.mkdir(agentDir, { recursive: true });
	const timestamp = new Date().toISOString();
	const sessionId = randomUUID();
	const sessionPath = path.join(agentDir, `${sessionFileTimestamp(timestamp)}_${sessionId}.jsonl`);
	const header = {
		type: "session",
		version: typeof source.version === "number" ? source.version : 3,
		id: sessionId,
		timestamp,
		cwd,
		parentSession: source.sessionPath,
	};
	const lines = [header, ...source.entries].map((entry) => JSON.stringify(entry));
	await fs.writeFile(sessionPath, `${lines.join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
	return sessionPath;
}

function compactText(text: string, maxLength = 180): string {
	const singleLine = stripControlSequences(text).replace(/\s+/g, " ").trim();
	return singleLine.length > maxLength ? `${singleLine.slice(0, maxLength - 1)}…` : singleLine;
}

function contentText(content: any): string {
	if (!content) return "";
	if (typeof content === "string") return content;
	if (Array.isArray(content)) return content.map(contentText).filter(Boolean).join(" ");
	if (typeof content.text === "string") return content.text;
	if (typeof content.content === "string") return content.content;
	if (Array.isArray(content.content)) return contentText(content.content);
	return "";
}

function messageText(message: any): string {
	return contentText(message?.content ?? message?.text ?? message);
}

function messageRole(message: any): string {
	const role = String(message?.role ?? "message");
	return role === "toolResult" ? "tool" : role;
}

function stripPromptFileMarkup(text: string): string {
	return text.replace(/<file name=["'][^"']+["']>\s*([\s\S]*?)\s*<\/file>/g, "$1");
}

function formatAgentMessageLine(role: string, text: string): string | null {
	const normalizedRole = role === "toolResult" ? "tool" : role;
	if (normalizedRole !== "assistant" && normalizedRole !== "user" && normalizedRole !== "tool") return null;
	const compact = compactText(stripPromptFileMarkup(text));
	return compact ? `${normalizedRole}: ${compact}` : null;
}

function formatConversationLine(role: string, text: string): string | null {
	if (role !== "assistant" && role !== "user") return null;
	return formatAgentMessageLine(role, text);
}

function sessionEntryConversationLine(entry: any): string | null {
	if (entry?.type !== "message") return null;
	const message = entry.message;
	const role = messageRole(message);
	return formatConversationLine(role, messageText(message));
}

function sessionEntryActivityLine(entry: any): string | null {
	if (entry?.type !== "message") return null;
	const message = entry.message;
	return formatAgentMessageLine(messageRole(message), messageText(message));
}

function activityMessageLines(activity: AgentActivity | null, limit = 6): string[] {
	const messages = activity?.latestMessages ?? [];
	return messages
		.map((line) => {
			const match = /^(user|assistant|tool|toolResult):\s*(.*)$/i.exec(line);
			if (match) return formatAgentMessageLine(match[1].toLowerCase(), match[2]);
			const compact = compactText(stripPromptFileMarkup(line));
			return compact ? `assistant: ${compact}` : null;
		})
		.filter((line): line is string => Boolean(line))
		.slice(-limit);
}

function isPaneUiLine(line: string): boolean {
	const text = compactText(line, 500);
	if (!text) return true;
	if (/^[─━═\-]{5,}$/.test(text)) return true;
	if (/^[╭╮╰╯│├└┌┐┘┬┴┼]/.test(text)) return true;
	if (/^[●◐✓✗]\s*(Todos?|#\d+)/i.test(text)) return true;
	if (/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s*Working/i.test(text)) return true;
	if (/\bWorking\.\.\.|\bElapsed\s+\d|\bPress ctrl\+o\b|\bescape interrupt\b/i.test(text)) return true;
	if (/\b\d+(?:\.\d+)?%\/[\d.]+[KMG]?\b/.test(text)) return true;
	if (/\((?:anthropic|openai|openai-codex|google|deepseek)\)\s+\S+\s+•/i.test(text)) return true;
	if (/^\[?(?:Context|Skills|Extensions|Commands)\]?$/i.test(text)) return true;
	if (/^(?:Observational memory|Codex usage limit|LSP Active|agents:|spawned ·|↳ spawned|pi-lens)\b/i.test(text)) return true;
	if (/^↳ spawned pi-para-agent /i.test(text)) return true;
	if (/^pi v\d+\.\d+\.\d+/i.test(text)) return true;
	if (/^Warning: tmux /i.test(text)) return true;
	if (/^~\/|^\/.*\([^)]*\)$/.test(text)) return true;
	if (/^(?:prompt file|session file|inherited pi args|cwd|Log|Run pi --session):/i.test(text)) return true;
	return false;
}

function paneConversationMessages(panePreview: string[], limit = 6): string[] {
	return panePreview
		.map((line) => compactText(stripPromptFileMarkup(line)))
		.filter((line) => line && !isPaneUiLine(line))
		.map((line) => (/^(user|assistant|tool):/i.test(line) ? line : `assistant: ${line}`))
		.slice(-limit);
}

function isPaneHeadingCandidate(line: string): boolean {
	if (line.length < 4 || line.length > 100) return false;
	if (/[.!?]$/.test(line)) return false;
	if (/^[`{}[\],]/.test(line)) return false;
	if (/^\^|^\d+\.\s|^[-+*/]/.test(line)) return false;
	if (/^["']?\w+["']?\s*:/.test(line)) return false;
	if (/^\w+(?:\.\w+)*\s*[+&|=<>]/.test(line)) return false;
	return true;
}

function paneLatestMessageLine(panePreview: string[]): string | null {
	const lines = panePreview.map((line) => compactText(stripPromptFileMarkup(line))).filter((line) => line && !isPaneUiLine(line));
	if (lines.length === 0) return null;
	const heading = [...lines].reverse().find(isPaneHeadingCandidate);
	return formatAgentMessageLine("assistant", heading ?? lines[lines.length - 1]);
}

async function readSessionConversation(record: AgentRecord, limit = 6): Promise<{ messages: string[]; activity: AgentActivity | null; currentPrompt: string }> {
	try {
		const raw = await fs.readFile(agentSessionPath(record), "utf8");
		const messages: string[] = [];
		const activityMessages: string[] = [];
		let lastRole = "";
		let lastAssistantText = "";
		let lastAssistantStopReason = "";
		let lastMessageText = "";
		let lastUserPrompt = "";
		for (const line of raw.split("\n")) {
			if (!line.trim()) continue;
			try {
				const parsed = JSON.parse(line);
				if (parsed?.type !== "message") continue;
				const message = parsed.message;
				const role = messageRole(message);
				const text = stripPromptFileMarkup(messageText(message));
				lastRole = role;
				lastMessageText = text;
				if (role === "user") {
					lastUserPrompt = text;
				}
				if (role === "assistant") {
					lastAssistantText = text;
					lastAssistantStopReason = String(message?.stopReason ?? "");
				}
				const lineText = sessionEntryConversationLine(parsed);
				if (lineText && messages[messages.length - 1] !== lineText) messages.push(lineText);
				const activityLine = sessionEntryActivityLine(parsed);
				if (activityLine && activityMessages[activityMessages.length - 1] !== activityLine) activityMessages.push(activityLine);
			} catch {
				// Ignore partial or malformed JSONL lines while a child session is writing.
			}
		}

		let activity: AgentActivity | null = null;
		if (lastRole === "assistant" && lastAssistantStopReason !== "toolUse") {
			const needsResponse = looksLikeNeedsResponse(lastAssistantText);
			activity = {
				kind: needsResponse ? "needs-response" : "idle",
				detail: needsResponse ? "waiting for user" : "waiting",
				updatedAt: new Date().toISOString(),
				latestMessages: activityMessages.slice(-4),
			};
		} else if (lastRole) {
			activity = {
				kind: "in-progress",
				detail: lastRole === "assistant" && lastAssistantStopReason === "toolUse" ? "using tool" : lastRole === "tool" ? "processing tool result" : "processing prompt",
				updatedAt: new Date().toISOString(),
				latestMessages: activityMessages.slice(-4),
			};
		} else if (lastMessageText) {
			activity = {
				kind: "in-progress",
				detail: "processing prompt",
				updatedAt: new Date().toISOString(),
				latestMessages: activityMessages.slice(-4),
			};
		}

		return { messages: messages.slice(-limit), activity, currentPrompt: compactText(lastUserPrompt) };
	} catch {
		return { messages: [], activity: null, currentPrompt: "" };
	}
}

function looksLikeNeedsResponse(text: string): boolean {
	const compact = stripControlSequences(text).replace(/\s+/g, " ").trim();
	if (!compact) return false;
	return /\?\s*$/.test(compact) || /\b(please confirm|choose one|which option|would you like|what would you like|can you provide|need your|waiting for you|let me know)\b/i.test(compact);
}

function normalizeActivity(activity: any): AgentActivity | null {
	if (!activity || typeof activity !== "object") return null;
	const kind = typeof activity.kind === "string" ? activity.kind : "unknown";
	const allowed = new Set<AgentActivityKind>(["starting", "in-progress", "idle", "needs-response", "done", "failed", "missing", "unknown"]);
	return {
		kind: allowed.has(kind as AgentActivityKind) ? (kind as AgentActivityKind) : "unknown",
		detail: typeof activity.detail === "string" ? activity.detail : undefined,
		updatedAt: typeof activity.updatedAt === "string" ? activity.updatedAt : new Date().toISOString(),
		latestMessages: Array.isArray(activity.latestMessages)
			? activity.latestMessages.map((line: unknown) => compactText(String(line))).filter(Boolean).slice(-4)
			: undefined,
	};
}

async function ensureStateDir(): Promise<void> {
	await fs.mkdir(stateDir(), { recursive: true });
}

async function migrateLegacyState(): Promise<void> {
	try {
		await fs.access(registryPath());
		return;
	} catch {
		// No new registry yet; try the legacy location from the original extension name.
	}

	try {
		await fs.access(legacyRegistryPath());
	} catch {
		return;
	}

	const oldRoot = legacyStateDir();
	const newRoot = stateDir();
	await ensureStateDir();
	for (const entry of await fs.readdir(oldRoot)) {
		const from = path.join(oldRoot, entry);
		const to = path.join(newRoot, entry);
		try {
			await fs.rename(from, to);
		} catch {
			// Leave conflicting files in the legacy directory.
		}
	}

	try {
		const raw = await fs.readFile(registryPath(), "utf8");
		const records = JSON.parse(raw) as AgentRecord[];
		if (!Array.isArray(records)) return;
		const migrated = records.map((record) => ({
			...record,
			promptPath: record.promptPath.replace(oldRoot, newRoot),
			scriptPath: record.scriptPath.replace(oldRoot, newRoot),
			statusPath: record.statusPath.replace(oldRoot, newRoot),
			logPath: record.logPath.replace(oldRoot, newRoot),
			sessionPath: record.sessionPath?.replace(oldRoot, newRoot),
		}));
		await fs.writeFile(registryPath(), `${JSON.stringify(migrated, null, 2)}\n`, "utf8");
	} catch {
		// Best-effort migration; loadRecords will surface malformed registry errors later.
	}
}

async function loadRecords(): Promise<AgentRecord[]> {
	await migrateLegacyState();
	try {
		const raw = await fs.readFile(registryPath(), "utf8");
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed) ? (parsed as AgentRecord[]).filter((record) => !record.killedAt) : [];
	} catch (error: any) {
		if (error?.code === "ENOENT") return [];
		throw error;
	}
}

async function saveRecords(records: AgentRecord[]): Promise<void> {
	await ensureStateDir();
	const target = registryPath();
	const tmp = `${target}.${process.pid}.tmp`;
	await fs.writeFile(tmp, `${JSON.stringify(records, null, 2)}\n`, "utf8");
	await fs.rename(tmp, target);
}

async function updateRecord(record: AgentRecord): Promise<void> {
	const records = await loadRecords();
	const index = records.findIndex((item) => item.id === record.id);
	if (index >= 0) records[index] = record;
	else records.push(record);
	await saveRecords(records);
}

async function removeRecord(id: string): Promise<AgentRecord | undefined> {
	const records = await loadRecords();
	const record = records.find((item) => item.id === id);
	if (!record) return undefined;
	await saveRecords(records.filter((item) => item.id !== id));
	return record;
}

async function readStatus(record: AgentRecord): Promise<string> {
	try {
		return (await fs.readFile(record.statusPath, "utf8")).trim() || "unknown";
	} catch {
		return "unknown";
	}
}

async function readActivity(record: AgentRecord): Promise<AgentActivity | null> {
	try {
		const raw = await fs.readFile(agentActivityPath(record), "utf8");
		return normalizeActivity(JSON.parse(raw));
	} catch {
		return null;
	}
}

function paneLooksBusy(panePreview: string[]): boolean {
	return panePreview.slice(-6).some((line) => {
		const text = stripControlSequences(line).trim();
		return /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s*Working\.\.\./i.test(text) || /^Elapsed\s+\d/i.test(text) || /^\$\s+\S/.test(text);
	});
}

function inferActivity(rawStatus: string, statusKind: AgentViewModel["statusKind"], hasWindow: boolean, panePreview: string[]): AgentActivity {
	let kind: AgentActivityKind = "unknown";
	let detail: string | undefined;
	const messages = panePreview.slice(-4).map((line) => compactText(line)).filter(Boolean);
	if (rawStatus === "starting") {
		kind = "starting";
		detail = "launching pi";
	} else if (statusKind === "failed") {
		kind = "failed";
		detail = rawStatus.replace(/^failed:?/, "").trim() || "failed";
	} else if (statusKind === "missing") {
		kind = hasWindow ? "unknown" : "missing";
		detail = "tmux window missing";
	} else if (statusKind === "exited") {
		kind = "done";
		detail = rawStatus.replace(/^exited:/, "exit ");
	} else if (statusKind === "running") {
		if (paneLooksBusy(panePreview)) {
			kind = "in-progress";
			detail = "working";
		} else {
			const latestText = messages.join(" ");
			kind = looksLikeNeedsResponse(latestText) ? "needs-response" : "idle";
			detail = kind === "needs-response" ? "waiting for user" : "waiting";
		}
	}
	return {
		kind,
		detail,
		updatedAt: new Date().toISOString(),
		latestMessages: messages,
	};
}

function activityAgeMs(activity: AgentActivity): number {
	const timestamp = Date.parse(activity.updatedAt);
	return Number.isFinite(timestamp) ? Date.now() - timestamp : Number.POSITIVE_INFINITY;
}

function reconcileActivity(
	rawStatus: string,
	statusKind: AgentViewModel["statusKind"],
	hasWindow: boolean,
	panePreview: string[],
	activity: AgentActivity | null,
): AgentActivity {
	const inferred = inferActivity(rawStatus, statusKind, hasWindow, panePreview);
	if (!activity) return inferred;
	if (statusKind === "exited" || statusKind === "failed" || statusKind === "missing") return inferred;
	if (paneLooksBusy(panePreview) && activity.kind !== "in-progress") return inferred;
	if (activity.kind === "starting" && (rawStatus !== "starting" || activityAgeMs(activity) > 5000)) return inferred;
	if (activity.kind === "in-progress" && activityAgeMs(activity) > 15000 && inferred.kind !== "unknown") return inferred;
	return activity;
}

function classifyStatus(rawStatus: string, hasWindow: boolean): AgentViewModel["statusKind"] {
	if ((rawStatus === "running" || rawStatus === "starting") && hasWindow) return "running";
	if (rawStatus.startsWith("exited:")) return "exited";
	if (rawStatus === "killed") return "killed";
	if (rawStatus.startsWith("failed")) return "failed";
	if (!hasWindow) return "missing";
	return "unknown";
}

function shouldPruneDeadRecord(statusKind: AgentViewModel["statusKind"], window: TmuxWindowInfo | undefined, tmuxListSucceeded: boolean): boolean {
	if (statusKind === "killed") return true;
	if (window?.paneDead) return true;
	if (!window && tmuxListSucceeded) return true;
	return false;
}

async function runTmux(
	pi: ExtensionAPI,
	args: string[],
	options: { allowFailure?: boolean; timeout?: number } = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
	const result = await pi.exec("tmux", args, { timeout: options.timeout ?? 5000 });
	const code = typeof result.code === "number" ? result.code : 0;
	const stdout = result.stdout ?? "";
	const stderr = result.stderr ?? "";
	if (code !== 0 && !options.allowFailure) {
		throw new Error(stderr.trim() || stdout.trim() || `tmux ${args.join(" ")} failed with exit code ${code}`);
	}
	return { stdout, stderr, code };
}

async function tmuxServerAvailable(pi: ExtensionAPI): Promise<boolean> {
	const result = await runTmux(pi, ["list-sessions", "-F", "#S"], { allowFailure: true });
	return result.code === 0;
}

async function listTmuxWindowsResult(pi: ExtensionAPI): Promise<TmuxWindowsResult> {
	const result = await runTmux(
		pi,
		["list-windows", "-a", "-F", "#{session_name}\t#{window_id}\t#{window_name}\t#{pane_current_command}\t#{pane_dead}"],
		{ allowFailure: true },
	);
	const windows = new Map<string, TmuxWindowInfo>();
	if (result.code !== 0) return { windows, ok: false };
	for (const line of result.stdout.split("\n")) {
		if (!line.trim()) continue;
		const [session, windowId, windowName, paneCommand, paneDead] = line.split("\t");
		if (!windowId) continue;
		windows.set(windowId, {
			session: session || "",
			windowId,
			windowName: windowName || "",
			paneCommand: paneCommand || "",
			paneDead: paneDead === "1",
		});
	}
	return { windows, ok: true };
}

async function listTmuxWindows(pi: ExtensionAPI): Promise<Map<string, TmuxWindowInfo>> {
	return (await listTmuxWindowsResult(pi)).windows;
}

async function capturePanePreview(pi: ExtensionAPI, windowId: string): Promise<string[]> {
	const result = await runTmux(pi, ["capture-pane", "-p", "-t", windowId, "-S", "-80"], { allowFailure: true });
	if (result.code !== 0) return [];
	const lines = result.stdout
		.split("\n")
		.map((line) => stripControlSequences(line).trimEnd())
		.filter((line) => line.trim().length > 0);
	return lines.slice(-60);
}

async function currentTmuxSession(pi: ExtensionAPI): Promise<string | null> {
	if (!process.env.TMUX) return null;
	const result = await runTmux(pi, ["display-message", "-p", "#S"], { allowFailure: true });
	if (result.code !== 0) return null;
	return result.stdout.trim() || null;
}

async function currentTmuxWindow(pi: ExtensionAPI): Promise<{ id: string; name: string } | null> {
	if (!process.env.TMUX) return null;
	const result = await runTmux(pi, ["display-message", "-p", "#{window_id}\t#{window_name}"], { allowFailure: true });
	if (result.code !== 0) return null;
	const [id, name] = result.stdout.trim().split("\t");
	return id ? { id, name: name || "" } : null;
}

async function ensureDetachedSession(pi: ExtensionAPI): Promise<string> {
	const sessionName = process.env.PI_TMUX_AGENT_SESSION || DEFAULT_DETACHED_SESSION;
	const hasSession = await runTmux(pi, ["has-session", "-t", sessionName], { allowFailure: true });
	if (hasSession.code === 0) return sessionName;

	await runTmux(pi, [
		"new-session",
		"-d",
		"-s",
		sessionName,
		"-n",
		"monitor",
		`bash -lc ${shellQuote(`echo 'pi tmux agent session: ${sessionName}'; echo 'Use /agent-list from pi, or switch windows here.'; exec \${SHELL:-/bin/bash} -l`)}`,
	]);
	return sessionName;
}

async function targetTmuxSession(pi: ExtensionAPI): Promise<{
	session: string;
	attachedToParentSession: boolean;
	parentWindowId?: string;
	parentWindowName?: string;
}> {
	const current = await currentTmuxSession(pi);
	if (current) {
		const parentWindow = await currentTmuxWindow(pi);
		return {
			session: current,
			attachedToParentSession: true,
			parentWindowId: parentWindow?.id,
			parentWindowName: parentWindow?.name,
		};
	}
	const detached = await ensureDetachedSession(pi);
	return { session: detached, attachedToParentSession: false };
}

async function generateAgentId(): Promise<string> {
	const existing = new Set((await loadRecords()).map((record) => record.id));
	for (let i = 0; i < 10; i++) {
		const id = randomBytes(3).toString("hex");
		if (!existing.has(id)) return id;
	}
	return randomBytes(6).toString("hex");
}

function returnHint(record: AgentRecord): { short: string; long: string } {
	if (record.attachedToParentSession) {
		const parent = record.parentWindowName ? `parent window ${record.parentWindowName}` : "the parent window";
		return {
			short: "spawned · ctrl+t l",
			long: `Return to the parent with ctrl+t then l, or switch back to ${parent}. Detach tmux with ctrl+t then d.`,
		};
	}
	return {
		short: "spawned · ctrl+t d",
		long: "Return to the parent Pi by detaching from tmux: press ctrl+t then d.",
	};
}

async function writeAgentScript(record: AgentRecord): Promise<void> {
	const sessionPath = agentSessionPath(record);
	const inheritedArgs = record.inheritedArgs ?? [];
	const hint = returnHint(record);
	const script = `#!/usr/bin/env bash
set +e
STATUS_FILE=${shellQuote(record.statusPath)}
PROMPT_FILE=${shellQuote(record.promptPath)}
SESSION_FILE=${shellQuote(sessionPath)}
AGENT_ID=${shellQuote(record.id)}
AGENT_CWD=${shellQuote(record.cwd)}
LOG_FILE=${shellQuote(record.logPath)}
ACTIVITY_FILE=${shellQuote(agentActivityPath(record))}
PARENT_WINDOW_ID=${shellQuote(record.parentWindowId ?? "")}
PARENT_WINDOW_NAME=${shellQuote(record.parentWindowName ?? "")}
RETURN_HINT=${shellQuote(hint.long)}
RETURN_HINT_SHORT=${shellQuote(hint.short)}
PI_INHERITED_ARGS=(${shellArrayLiteral(inheritedArgs)})

export PI_CODING_AGENT_DIR=${shellQuote(configDir())}
export PI_PARA_AGENT_ID="$AGENT_ID"
export PI_PARA_AGENT_CWD="$AGENT_CWD"
export PI_PARA_ACTIVITY_PATH="$ACTIVITY_FILE"
export PI_PARA_PARENT_WINDOW_ID="$PARENT_WINDOW_ID"
export PI_PARA_PARENT_WINDOW_NAME="$PARENT_WINDOW_NAME"
export PI_PARA_RETURN_HINT="$RETURN_HINT"
export PI_PARA_RETURN_HINT_SHORT="$RETURN_HINT_SHORT"

write_activity() {
  local kind="$1"
  local detail="$2"
  [ -n "$ACTIVITY_FILE" ] || return 0
  printf '{"kind":"%s","detail":"%s","updatedAt":"%s","latestMessages":[]}\n' "$kind" "$detail" "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" > "$ACTIVITY_FILE" 2>/dev/null || true
}

printf 'running\n' > "$STATUS_FILE"
write_activity "in-progress" "launching pi"
trap 'printf "killed\\n" > "$STATUS_FILE"; write_activity "failed" "killed"; exit 130' INT TERM HUP

cd "$AGENT_CWD" || {
  printf 'failed:cwd\n' > "$STATUS_FILE"
  write_activity "failed" "cwd"
  echo "Failed to cd into $AGENT_CWD"
  exec "\${SHELL:-/bin/bash}" -l
}

printf '\n[pi para agent %s]\n' "$AGENT_ID"
printf 'cwd: %s\n' "$AGENT_CWD"
printf 'prompt file: %s\n' "$PROMPT_FILE"
printf 'session file: %s\n' "$SESSION_FILE"
printf '%s\n\n' "$RETURN_HINT"
if [ "\${#PI_INHERITED_ARGS[@]}" -gt 0 ]; then
  printf 'inherited pi args:'
  printf ' %q' "\${PI_INHERITED_ARGS[@]}"
  printf '\n\n'
fi

pi "\${PI_INHERITED_ARGS[@]}" --session "$SESSION_FILE" "@$PROMPT_FILE"
code=$?
printf 'exited:%s\n' "$code" > "$STATUS_FILE"
write_activity "done" "exit $code"

printf '\n[pi para agent %s exited with code %s]\n' "$AGENT_ID" "$code"
printf 'Log: %s\n' "$LOG_FILE"
printf 'Run pi --session %s here to continue this agent. %s\n\n' "$SESSION_FILE" "$RETURN_HINT"
exec "\${SHELL:-/bin/bash}" -l
`;
	await fs.writeFile(record.scriptPath, script, { encoding: "utf8", mode: 0o700 });
}

async function spawnAgent(pi: ExtensionAPI, cwd: string, prompt: string, options: SpawnAgentOptions = {}): Promise<AgentRecord> {
	await ensureStateDir();
	const id = await generateAgentId();
	const agentDir = path.join(stateDir(), id);
	await fs.mkdir(agentDir, { recursive: true });

	const target = await targetTmuxSession(pi);
	const sessionPath = options.forkSource
		? await writeForkedSession(agentDir, cwd, options.forkSource)
		: path.join(agentDir, "session.jsonl");
	const record: AgentRecord = {
		id,
		cwd,
		promptPreview: promptPreview(prompt),
		promptPath: path.join(agentDir, "prompt.md"),
		scriptPath: path.join(agentDir, "start.sh"),
		statusPath: path.join(agentDir, "status"),
		logPath: path.join(agentDir, "tmux.log"),
		sessionPath,
		parentWindowId: target.parentWindowId,
		parentWindowName: target.parentWindowName,
		inheritedArgs: childPiArgs(pi),
		forkedFromSessionPath: options.forkSource?.sessionPath,
		forkedFromEntryId: options.forkSource?.leafId,
		createdAt: new Date().toISOString(),
		tmuxSession: target.session,
		tmuxWindowId: "",
		tmuxWindowName: `pi-${id}`,
		attachedToParentSession: target.attachedToParentSession,
	};

	await fs.writeFile(record.promptPath, prompt, { encoding: "utf8", mode: 0o600 });
	await fs.writeFile(record.statusPath, "starting\n", "utf8");
	await fs.writeFile(
		agentActivityPath(record),
		`${JSON.stringify({ kind: "starting", detail: "launching pi", updatedAt: new Date().toISOString(), latestMessages: [`user: ${compactText(prompt)}`] }, null, 2)}\n`,
		"utf8",
	);
	await fs.writeFile(record.logPath, "", "utf8");
	await writeAgentScript(record);

	const windowId = (
		await runTmux(pi, [
			"new-window",
			"-d",
			"-P",
			"-F",
			"#{window_id}",
			"-t",
			`${record.tmuxSession}:`,
			"-n",
			record.tmuxWindowName,
			"-c",
			record.cwd,
			`bash ${shellQuote(record.scriptPath)}`,
		])
	).stdout.trim();

	record.tmuxWindowId = windowId;
	await runTmux(pi, ["pipe-pane", "-o", "-t", record.tmuxWindowId, `cat >> ${shellQuote(record.logPath)}`], {
		allowFailure: true,
	});
	await updateRecord(record);
	return record;
}

async function defaultAgentListCwd(ctx: any): Promise<string> {
	if (process.env.PI_PARA_AGENT_CWD) return process.env.PI_PARA_AGENT_CWD;
	const childId = process.env.PI_PARA_AGENT_ID;
	if (childId) {
		try {
			const record = (await loadRecords()).find((item) => item.id === childId);
			if (record?.cwd) return record.cwd;
		} catch {
			// Fall through to ctx.cwd if the registry is not readable.
		}
	}
	return ctx.cwd;
}

async function listAgents(pi: ExtensionAPI, cwdFilter?: string): Promise<AgentViewModel[]> {
	const records = await loadRecords();
	const tmuxWindows = await listTmuxWindowsResult(pi);
	const windows = tmuxWindows.windows;
	const normalizedFilter = cwdFilter ? path.resolve(cwdFilter) : undefined;
	const agents: AgentViewModel[] = [];
	for (const record of records) {
		if (normalizedFilter && path.resolve(record.cwd) !== normalizedFilter) continue;
		const window = windows.get(record.tmuxWindowId);
		const rawStatus = await readStatus(record);
		const statusKind = classifyStatus(rawStatus, Boolean(window));
		if (shouldPruneDeadRecord(statusKind, window, tmuxWindows.ok)) {
			if (statusKind === "missing" || statusKind === "killed") {
				await fs.writeFile(record.statusPath, `${statusKind}\n`, "utf8").catch(() => undefined);
			}
			await removeRecord(record.id);
			continue;
		}
		const panePreview = window ? await capturePanePreview(pi, record.tmuxWindowId) : [];
		const sessionConversation = await readSessionConversation(record);
		const storedActivity = await readActivity(record);
		const reconciledActivity = reconcileActivity(rawStatus, statusKind, Boolean(window), panePreview, storedActivity);
		const shouldTrustLiveActivity = paneLooksBusy(panePreview) || (storedActivity?.kind === "in-progress" && activityAgeMs(storedActivity) <= 15000);
		const activity = statusKind === "running" && sessionConversation.activity && !shouldTrustLiveActivity ? sessionConversation.activity : reconciledActivity;
		const activityLines = activityMessageLines(activity);
		const paneMessages = paneConversationMessages(panePreview);
		const conversationMessages =
			sessionConversation.messages.length > 0
				? sessionConversation.messages
				: activityLines.length > 0
					? activityLines
					: paneMessages;
		const currentPrompt = sessionConversation.currentPrompt || record.promptPreview || "no prompt recorded";
		const latestMessage = chooseLatestMessage(activity, activityLines, conversationMessages, paneLatestMessageLine(panePreview));
		agents.push({
			...record,
			status: rawStatus,
			statusKind,
			activity,
			conversationMessages,
			currentPrompt,
			latestMessage,
			window,
			panePreview,
		});
	}
	return agents.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

async function findAgent(pi: ExtensionAPI, idPrefix: string): Promise<AgentViewModel | null> {
	const prefix = idPrefix.trim();
	if (!prefix) return null;
	const agents = await listAgents(pi);
	const exact = agents.find((agent) => agent.id === prefix);
	if (exact) return exact;
	const matches = agents.filter((agent) => agent.id.startsWith(prefix));
	return matches.length === 1 ? matches[0] : null;
}

async function attachAgent(
	pi: ExtensionAPI,
	ctx: any,
	agent: AgentViewModel,
	notify: (message: string, level?: "info" | "warning" | "error") => void,
): Promise<void> {
	const windows = await listTmuxWindows(pi);
	const window = windows.get(agent.tmuxWindowId);
	if (!window) {
		notify(`Agent ${agent.id} has no live tmux window.`, "warning");
		return;
	}

	if (process.env.TMUX) {
		await runTmux(pi, ["switch-client", "-t", agent.tmuxWindowId]);
		return;
	}

	await runTmux(pi, ["select-window", "-t", agent.tmuxWindowId], { allowFailure: true });
	const target = `${agent.tmuxSession}:${agent.tmuxWindowName}`;
	if (!ctx.hasUI || !ctx.ui?.custom) {
		notify(`Attach from a shell with: tmux attach -t ${shellQuote(target)}`, "info");
		return;
	}

	const exitCode = await ctx.ui.custom((tui: any, _theme: any, _keybindings: any, done: any) => {
		// Release Pi's TUI so tmux can own this terminal until the user detaches.
		// Keep the parent Pi process/event loop alive while attached; only the terminal UI is suspended.
		tui.stop();
		process.stdout.write("\x1b[2J\x1b[H");
		process.stdout.write(`Attaching to agent ${agent.id}. Detach with tmux prefix then d.\n`);
		process.stdout.write("Parent Pi UI is suspended while this terminal is attached; detach to resume it.\n\n");
		const child = spawn("tmux", ["attach-session", "-t", agent.tmuxSession], {
			stdio: "inherit",
			env: process.env,
		});
		let settled = false;
		const finish = (code: number) => {
			if (settled) return;
			settled = true;
			tui.start();
			tui.requestRender(true);
			done(code);
		};
		child.once("error", (error) => {
			process.stderr.write(`tmux attach failed: ${error.message}\n`);
			finish(1);
		});
		child.once("exit", (code, signal) => {
			finish(typeof code === "number" ? code : signal ? 1 : 0);
		});
		return { render: () => [], invalidate: () => {} };
	});

	if (exitCode && exitCode !== 0) {
		notify(`tmux attach exited with code ${exitCode}. Try: tmux attach -t ${shellQuote(target)}`, "warning");
	}
}

async function killAgent(pi: ExtensionAPI, agent: AgentViewModel): Promise<void> {
	const windows = await listTmuxWindows(pi);
	if (windows.has(agent.tmuxWindowId)) {
		await runTmux(pi, ["kill-window", "-t", agent.tmuxWindowId], { allowFailure: true });
	}
	await fs.writeFile(agent.statusPath, "killed\n", "utf8").catch(() => undefined);
	await removeRecord(agent.id);
}

async function killAgents(pi: ExtensionAPI, agents: AgentViewModel[]): Promise<{ killed: AgentViewModel[]; failed: { agent: AgentViewModel; error: unknown }[] }> {
	const killed: AgentViewModel[] = [];
	const failed: { agent: AgentViewModel; error: unknown }[] = [];
	for (const agent of agents) {
		try {
			await killAgent(pi, agent);
			killed.push(agent);
		} catch (error) {
			failed.push({ agent, error });
		}
	}
	return { killed, failed };
}

function formatAge(iso: string): string {
	const delta = Math.max(0, Date.now() - new Date(iso).getTime());
	const seconds = Math.floor(delta / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 48) return `${hours}h`;
	return `${Math.floor(hours / 24)}d`;
}

function statusIcon(_statusKind: AgentViewModel["statusKind"]): string {
	return "●";
}

function statusColor(theme: any, statusKind: AgentViewModel["statusKind"], text: string): string {
	switch (statusKind) {
		case "running":
			return theme.fg("success", text);
		case "exited":
			return theme.fg("muted", text);
		case "killed":
			return theme.fg("error", text);
		case "failed":
			return theme.fg("warning", text);
		case "missing":
			return theme.fg("dim", text);
		default:
			return theme.fg("dim", text);
	}
}

function activityLabel(activity: AgentActivity): string {
	switch (activity.kind) {
		case "in-progress":
			return "in progress";
		case "needs-response":
			return "needs response";
		case "idle":
			return "idle";
		case "starting":
			return "starting";
		case "done":
			return "done";
		case "failed":
			return "failed";
		case "missing":
			return "missing";
		default:
			return "unknown";
	}
}

function activityColor(theme: any, activity: AgentActivity, text: string): string {
	switch (activity.kind) {
		case "in-progress":
			return theme.fg("accent", text);
		case "needs-response":
			return theme.fg("warning", text);
		case "idle":
			return theme.fg("success", text);
		case "starting":
			return theme.fg("muted", text);
		case "done":
			return theme.fg("dim", text);
		case "failed":
			return theme.fg("error", text);
		case "missing":
			return theme.fg("dim", text);
		default:
			return theme.fg("dim", text);
	}
}

function latestNonUserLine(lines: string[]): string | null {
	return [...lines].reverse().find((line) => !/^user:/i.test(line)) ?? lines[lines.length - 1] ?? null;
}

function chooseLatestMessage(
	activity: AgentActivity,
	activityLines: string[],
	sessionLines: string[],
	paneLatest: string | null,
): string {
	if (activity.kind === "in-progress") {
		return paneLatest ?? latestNonUserLine(activityLines) ?? latestNonUserLine(sessionLines) ?? "agent is working";
	}
	return latestNonUserLine(sessionLines) ?? latestNonUserLine(activityLines) ?? paneLatest ?? "no activity yet";
}

function padToVisibleWidth(line: string, width: number): string {
	const currentWidth = visibleWidth(line);
	return currentWidth >= width ? line : `${line}${" ".repeat(width - currentWidth)}`;
}

function borderLines(theme: any, lines: string[], width: number): string[] {
	const innerWidth = Math.max(1, width - 2);
	const dim = (text: string) => theme.fg("dim", text);
	const top = dim(`╭${"─".repeat(innerWidth)}╮`);
	const bottom = dim(`╰${"─".repeat(innerWidth)}╯`);
	return [
		top,
		...lines.map((line) => `${dim("│")}${padToVisibleWidth(truncateToWidth(line, innerWidth), innerWidth)}${dim("│")}`),
		bottom,
	];
}

class AgentListView {
	private selected = 0;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(
		private agents: AgentViewModel[],
		private readonly cwdLabel: string,
		private readonly theme: any,
		private readonly onAction: (action: "attach" | "kill" | "refresh" | "close", agent?: AgentViewModel) => void,
	) {}

	setAgents(agents: AgentViewModel[]): void {
		this.agents = agents;
		if (this.selected >= this.agents.length) this.selected = Math.max(0, this.agents.length - 1);
		this.invalidate();
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.up) && this.selected > 0) {
			this.selected--;
			this.invalidate();
			return;
		}
		if (matchesKey(data, Key.down) && this.selected < this.agents.length - 1) {
			this.selected++;
			this.invalidate();
			return;
		}
		if (matchesKey(data, Key.enter) || data === "a") {
			const agent = this.agents[this.selected];
			if (agent) this.onAction("attach", agent);
			return;
		}
		if (data === "k") {
			const agent = this.agents[this.selected];
			if (agent) this.onAction("kill", agent);
			return;
		}
		if (data === "r") {
			this.onAction("refresh");
			return;
		}
		if (matchesKey(data, Key.escape) || data === "q") {
			this.onAction("close");
		}
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		const innerWidth = Math.max(1, width - 2);
		const lines: string[] = [];
		const title = `${this.theme.fg("accent", this.theme.bold("pi para agents"))} ${this.theme.fg("dim", this.cwdLabel)}`;
		lines.push(truncateToWidth(title, innerWidth));
		lines.push(truncateToWidth(this.theme.fg("dim", "↑↓ select • enter/a attach • k kill • r refresh • q/esc close"), innerWidth));
		lines.push("");

		if (this.agents.length === 0) {
			lines.push(truncateToWidth(this.theme.fg("muted", "No agents found."), innerWidth));
			this.cachedWidth = width;
			this.cachedLines = borderLines(this.theme, lines, width);
			return this.cachedLines;
		}

		for (let i = 0; i < this.agents.length; i++) {
			const agent = this.agents[i];
			const selected = i === this.selected;
			const prefix = selected ? this.theme.fg("accent", ">") : " ";
			const icon = statusColor(this.theme, agent.statusKind, statusIcon(agent.statusKind));
			const id = this.theme.fg("accent", agent.id);
			const state = activityColor(this.theme, agent.activity, activityLabel(agent.activity));
			const age = this.theme.fg("dim", formatAge(agent.createdAt));
			const window = agent.window ? this.theme.fg("muted", `${agent.tmuxSession}:${agent.window.windowName}`) : this.theme.fg("dim", "no-window");
			const detail = agent.activity.detail ? `${this.theme.fg("muted", " · ")}${this.theme.fg("dim", agent.activity.detail)}` : "";
			const firstLine = `${prefix} ${icon} ${id} ${state}${detail} ${age} ${window}`;
			lines.push(truncateToWidth(firstLine, innerWidth));
			const prompt = agent.currentPrompt || "no prompt recorded";
			lines.push(truncateToWidth(`  ${this.theme.fg("dim", "prompt:")} ${this.theme.fg("muted", prompt)}`, innerWidth));
			const latest = agent.latestMessage || "no activity yet";
			lines.push(truncateToWidth(`  ${this.theme.fg("dim", "latest:")} ${this.theme.fg("muted", latest)}`, innerWidth));
		}

		this.cachedWidth = width;
		this.cachedLines = borderLines(this.theme, lines, width);
		return this.cachedLines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

async function showAgentList(ctx: any, pi: ExtensionAPI, cwdFilter?: string): Promise<void> {
	let agents = await listAgents(pi, cwdFilter);
	const cwdLabel = cwdFilter ? cwdFilter : "all cwd";
	let interval: NodeJS.Timeout | undefined;
	let refreshing = false;

	const refresh = async (view?: AgentListView, requestRender?: () => void) => {
		if (refreshing) return;
		refreshing = true;
		try {
			agents = await listAgents(pi, cwdFilter);
			view?.setAgents(agents);
			requestRender?.();
		} finally {
			refreshing = false;
		}
	};

	try {
		const action = await ctx.ui.custom((tui: any, theme: any, _keybindings: any, done: any) => {
			let view: AgentListView;
			view = new AgentListView(agents, cwdLabel, theme, (selectedAction, agent) => {
				if (selectedAction === "close") {
					done(null);
					return;
				}
				if (selectedAction === "refresh") {
					void refresh(view, () => tui.requestRender());
					return;
				}
				if (selectedAction === "attach" && agent) {
					done({ type: "attach", agent });
					return;
				}
				if (selectedAction === "kill" && agent) {
					void (async () => {
						try {
							await killAgent(pi, agent);
							ctx.ui.notify(`Killed agent ${agent.id}`, "info");
							await updateFooterStatus(pi, ctx);
							await refresh(view, () => tui.requestRender());
						} catch (error: any) {
							ctx.ui.notify(`kill failed: ${error?.message ?? String(error)}`, "error");
						}
					})();
				}
			});
			interval = setInterval(() => void refresh(view, () => tui.requestRender()), 1000);
			return {
				render: (width: number) => view.render(width),
				invalidate: () => view.invalidate(),
				handleInput: (data: string) => {
					view.handleInput(data);
					tui.requestRender();
				},
			};
		}, {
			overlay: true,
			overlayOptions: {
				width: "90%",
				maxHeight: "90%",
				anchor: "center",
				margin: 1,
			},
		});

		if (!action) return;
		if (action.type === "attach") {
			await attachAgent(pi, ctx, action.agent, (message, level = "info") => ctx.ui.notify(message, level));
			return;
		}
	} finally {
		if (interval) clearInterval(interval);
	}
}

async function countLiveAgents(pi: ExtensionAPI, cwdFilter?: string): Promise<number> {
	const records = await loadRecords();
	const tmuxWindows = await listTmuxWindowsResult(pi);
	if (!tmuxWindows.ok) return 0;
	const normalizedFilter = cwdFilter ? path.resolve(cwdFilter) : undefined;
	let running = 0;
	for (const record of records) {
		if (normalizedFilter && path.resolve(record.cwd) !== normalizedFilter) continue;
		const window = tmuxWindows.windows.get(record.tmuxWindowId);
		if (!window || window.paneDead) continue;
		const rawStatus = await readStatus(record);
		if (classifyStatus(rawStatus, true) === "running") running++;
	}
	return running;
}

async function updateFooterStatus(pi: ExtensionAPI, ctx: any): Promise<void> {
	if (!ctx.hasUI) return;
	const cwd = await defaultAgentListCwd(ctx);
	const running = await countLiveAgents(pi, cwd).catch(() => 0);
	ctx.ui.setStatus(EXTENSION_NAME, running > 0 ? ctx.ui.theme.fg("accent", `agents:${running}`) : undefined);
	ctx.ui.setStatus(LEGACY_EXTENSION_NAME, undefined);
}

export default function (pi: ExtensionAPI) {
	let statusInterval: NodeJS.Timeout | undefined;
	let childActivityTimer: NodeJS.Timeout | undefined;
	let childPendingActivity: AgentActivity | undefined;
	const childLatestMessages: string[] = [];

	const rememberChildMessage = (role: string, text: string, replaceLatestRole = false) => {
		const compact = compactText(text);
		if (!compact) return;
		const normalizedRole = role === "toolResult" ? "tool" : role;
		const line = `${normalizedRole}: ${compact}`;
		const prefix = `${normalizedRole}:`;
		if (replaceLatestRole && childLatestMessages.length > 0 && childLatestMessages[childLatestMessages.length - 1].startsWith(prefix)) {
			childLatestMessages[childLatestMessages.length - 1] = line;
		} else if (childLatestMessages[childLatestMessages.length - 1] !== line) {
			childLatestMessages.push(line);
		}
		while (childLatestMessages.length > 8) childLatestMessages.shift();
	};

	const flushChildActivity = async () => {
		const activityPath = process.env.PI_PARA_ACTIVITY_PATH;
		if (!activityPath || !childPendingActivity) return;
		const activity = childPendingActivity;
		childPendingActivity = undefined;
		await fs.writeFile(activityPath, `${JSON.stringify(activity, null, 2)}\n`, "utf8").catch(() => undefined);
	};

	const setChildActivity = (kind: AgentActivityKind, detail?: string, immediate = false) => {
		if (!process.env.PI_PARA_AGENT_ID || !process.env.PI_PARA_ACTIVITY_PATH) return;
		childPendingActivity = {
			kind,
			detail,
			updatedAt: new Date().toISOString(),
			latestMessages: childLatestMessages.slice(-4),
		};
		if (immediate) {
			if (childActivityTimer) {
				clearTimeout(childActivityTimer);
				childActivityTimer = undefined;
			}
			void flushChildActivity();
			return;
		}
		if (!childActivityTimer) {
			childActivityTimer = setTimeout(() => {
				childActivityTimer = undefined;
				void flushChildActivity();
			}, 250);
		}
	};

	const rememberEventMessage = (message: any, replaceLatestRole = false) => {
		const text = messageText(message);
		if (!text) return;
		rememberChildMessage(messageRole(message), text, replaceLatestRole);
	};

	pi.on("session_start", async (_event, ctx) => {
		if (process.env.PI_PARA_AGENT_ID) {
			setChildActivity("idle", "spawned session", true);
		}
		if (!ctx.hasUI) return;
		if (process.env.PI_PARA_AGENT_ID) {
			const hint = process.env.PI_PARA_RETURN_HINT || "Return to the parent from tmux with ctrl+t.";
			const shortHint = process.env.PI_PARA_RETURN_HINT_SHORT || "spawned · ctrl+t d";
			const widgetLine = ctx.ui.theme.fg("dim", `↳ spawned pi-para-agent ${process.env.PI_PARA_AGENT_ID} · ${hint}`);
			ctx.ui.notify(`Parallel agent ${process.env.PI_PARA_AGENT_ID}. ${hint}`, "info");
			ctx.ui.setStatus(`${EXTENSION_NAME}:return`, ctx.ui.theme.fg("accent", shortHint));
			ctx.ui.setWidget(`${EXTENSION_NAME}:child`, [widgetLine], { placement: "belowEditor" });
		}
		await updateFooterStatus(pi, ctx);
		statusInterval = setInterval(() => void updateFooterStatus(pi, ctx), STATUS_REFRESH_MS);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (statusInterval) {
			clearInterval(statusInterval);
			statusInterval = undefined;
		}
		if (childActivityTimer) {
			clearTimeout(childActivityTimer);
			childActivityTimer = undefined;
		}
		await flushChildActivity();
		if (ctx.hasUI) {
			ctx.ui.setStatus(EXTENSION_NAME, undefined);
			ctx.ui.setStatus(LEGACY_EXTENSION_NAME, undefined);
			ctx.ui.setStatus(`${EXTENSION_NAME}:return`, undefined);
			ctx.ui.setWidget(`${EXTENSION_NAME}:child`, undefined);
		}
	});

	pi.on("before_agent_start", async (event) => {
		if (!process.env.PI_PARA_AGENT_ID) return;
		rememberChildMessage("user", event.prompt ?? "");
		setChildActivity("in-progress", "processing prompt", true);
	});

	pi.on("agent_start", async () => {
		setChildActivity("in-progress", "agent running");
	});

	pi.on("turn_start", async (event) => {
		setChildActivity("in-progress", `turn ${Number(event.turnIndex ?? 0) + 1}`);
	});

	pi.on("message_update", async (event) => {
		if (!process.env.PI_PARA_AGENT_ID) return;
		rememberEventMessage(event.message, true);
		setChildActivity("in-progress", "streaming response");
	});

	pi.on("message_end", async (event) => {
		if (!process.env.PI_PARA_AGENT_ID) return;
		rememberEventMessage(event.message, true);
		const role = messageRole(event.message);
		if (role !== "user") setChildActivity("in-progress", `${role} message`);
	});

	pi.on("tool_execution_start", async (event) => {
		if (!process.env.PI_PARA_AGENT_ID) return;
		rememberChildMessage("tool", `${event.toolName} started`);
		setChildActivity("in-progress", `tool ${event.toolName}`);
	});

	pi.on("tool_execution_update", async (event) => {
		if (!process.env.PI_PARA_AGENT_ID) return;
		setChildActivity("in-progress", `tool ${event.toolName}`);
	});

	pi.on("tool_execution_end", async (event) => {
		if (!process.env.PI_PARA_AGENT_ID) return;
		rememberChildMessage("tool", `${event.toolName} ${event.isError ? "failed" : "done"}`);
		setChildActivity("in-progress", `tool ${event.toolName} ${event.isError ? "failed" : "done"}`);
	});

	pi.on("agent_end", async (event) => {
		if (!process.env.PI_PARA_AGENT_ID) return;
		for (const message of event.messages ?? []) rememberEventMessage(message, true);
		const lastAssistant = [...(event.messages ?? [])].reverse().find((message: any) => messageRole(message) === "assistant");
		const text = lastAssistant ? messageText(lastAssistant) : "";
		setChildActivity(looksLikeNeedsResponse(text) ? "needs-response" : "idle", looksLikeNeedsResponse(text) ? "waiting for user" : "waiting", true);
	});

	pi.registerCommand("spawn", {
		description: "Spawn an interactive pi agent in a tmux window. Usage: /spawn <prompt>; bare /spawn opens a blank editor.",
		handler: async (args, ctx) => {
			try {
				const tmuxAvailable = process.env.TMUX ? true : await tmuxServerAvailable(pi).catch(() => false);
				if (!process.env.TMUX && !tmuxAvailable) {
					// ensureDetachedSession will create a server; this branch is only here to produce a better error if tmux is missing.
					await runTmux(pi, ["-V"]);
				}
				let prompt = args.trim();
				if (!prompt) {
					const entered = await ctx.ui.editor("Spawn tmux pi agent", "");
					prompt = entered?.trim() ?? "";
				}
				if (!prompt) {
					ctx.ui.notify("No prompt provided.", "warning");
					return;
				}
				const record = await spawnAgent(pi, ctx.cwd, prompt);
				await updateFooterStatus(pi, ctx);
				const where = record.attachedToParentSession
					? `window ${record.tmuxWindowName}`
					: `detached tmux session ${record.tmuxSession}`;
				ctx.ui.notify(`Spawned agent ${record.id} in ${where}.`, "info");
			} catch (error: any) {
				ctx.ui.notify(`spawn failed: ${error?.message ?? String(error)}`, "error");
			}
		},
	});

	pi.registerCommand("para-fork", {
		description: "Fork the current Pi session history into a new parallel tmux agent. Usage: /para-fork <prompt>",
		handler: async (args, ctx) => {
			try {
				if (ctx.isIdle?.() === false) await ctx.waitForIdle?.();
				let prompt = args.trim();
				if (!prompt) {
					const entered = await ctx.ui.editor("Fork current session into a parallel agent", "");
					prompt = entered?.trim() ?? "";
				}
				if (!prompt) {
					ctx.ui.notify("No prompt provided.", "warning");
					return;
				}
				const forkSource = forkSourceFromContext(ctx);
				const record = await spawnAgent(pi, ctx.cwd, prompt, { forkSource });
				await updateFooterStatus(pi, ctx);
				const where = record.attachedToParentSession
					? `window ${record.tmuxWindowName}`
					: `detached tmux session ${record.tmuxSession}`;
				ctx.ui.notify(`Forked current session into agent ${record.id} in ${where}.`, "info");
			} catch (error: any) {
				ctx.ui.notify(`para-fork failed: ${error?.message ?? String(error)}`, "error");
			}
		},
	});

	pi.registerCommand("agent-list", {
		description: "Show tmux pi agents for this cwd, or pass --all",
		handler: async (args, ctx) => {
			try {
				const defaultCwd = await defaultAgentListCwd(ctx);
				const cwdFilter = isAllCwdArg(args) ? undefined : normalizeCwd(args, defaultCwd);
				await showAgentList(ctx, pi, cwdFilter);
				await updateFooterStatus(pi, ctx);
			} catch (error: any) {
				ctx.ui.notify(`agent-list failed: ${error?.message ?? String(error)}`, "error");
			}
		},
	});

	pi.registerCommand("agent-attach", {
		description: "Attach/switch to a tmux pi agent by id prefix",
		handler: async (args, ctx) => {
			try {
				const agent = await findAgent(pi, args);
				if (!agent) {
					ctx.ui.notify("No matching agent. Use /agent-list.", "warning");
					return;
				}
				await attachAgent(pi, ctx, agent, (message, level = "info") => ctx.ui.notify(message, level));
			} catch (error: any) {
				ctx.ui.notify(`agent-attach failed: ${error?.message ?? String(error)}`, "error");
			}
		},
	});

	pi.registerCommand("kill-agent", {
		description: "Kill a tmux pi agent by id prefix",
		handler: async (args, ctx) => {
			try {
				const agent = await findAgent(pi, args);
				if (!agent) {
					ctx.ui.notify("No matching agent. Use /agent-list.", "warning");
					return;
				}
				await killAgent(pi, agent);
				await updateFooterStatus(pi, ctx);
				ctx.ui.notify(`Killed agent ${agent.id}.`, "info");
			} catch (error: any) {
				ctx.ui.notify(`kill-agent failed: ${error?.message ?? String(error)}`, "error");
			}
		},
	});

	pi.registerCommand("kill-all-agents", {
		description: "Kill all tmux pi agents for this cwd, or pass --all",
		handler: async (args, ctx) => {
			try {
				const allCwd = isAllCwdArg(args);
				const defaultCwd = await defaultAgentListCwd(ctx);
				const cwdFilter = allCwd ? undefined : normalizeCwd(args, defaultCwd);
				const agents = await listAgents(pi, cwdFilter);
				if (agents.length === 0) {
					ctx.ui.notify(allCwd ? "No agents found." : "No agents found for this cwd.", "info");
					return;
				}
				const { killed, failed } = await killAgents(pi, agents);
				await updateFooterStatus(pi, ctx);
				if (failed.length > 0) {
					const failedIds = failed.map(({ agent }) => agent.id).join(", ");
					ctx.ui.notify(`Killed ${killed.length}/${agents.length} agents. Failed: ${failedIds}.`, "warning");
					return;
				}
				ctx.ui.notify(`Killed ${killed.length} agent${killed.length === 1 ? "" : "s"}.`, "info");
			} catch (error: any) {
				ctx.ui.notify(`kill-all-agents failed: ${error?.message ?? String(error)}`, "error");
			}
		},
	});
}
