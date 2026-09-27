import { Plugin } from "@opencode/plugin"
import { basename } from "path"
import { readFileSync, writeFileSync } from "fs"
import {
  loadConfig,
  isEventSoundEnabled,
  isEventNotificationEnabled,
  isEventCommandEnabled,
  isEventBellEnabled,
  getMessage,
  getSoundPath,
  getSoundVolume,
  getIconPath,
  interpolateMessage,
  getStatePath,
} from "./config"
import type { EventType, NotifierConfig } from "./config"
import { sendNotification } from "./notify"
import { playSound } from "./sound"
import { ringBell } from "./bell"
import { runCommand } from "./command"
import { isTerminalFocused, focusTerminal, captureStartupWindowId, isKDEJumpBackSupported } from "./focus"
import { shouldSuppressPermissionAlert, prunePermissionAlertState } from "./permission-dedupe"

const IDLE_POLL_INTERVAL_MS = 10000
const IDLE_CHECK_DELAY_MS = 30000
const IDLE_COMPLETE_DELAY_MS = 350

// Cooldown after firing a "complete" notification for a session so we don't
// spam when a session rapidly oscillates between idle and busy.
const IDLE_COMPLETE_COOLDOWN_MS = 60_000

export function isCLIClient(clientEnv?: string): boolean {
  return !clientEnv || clientEnv === "cli"
}

// ---- Session tracking state ----

// Tracks the last time the context hook fired per session (activity indicator)
const sessionLastContextAt = new Map<string, number>()

// Idle debounce: each pending idle event has a sequence number so late-arriving
// events from an older idle detection pass are silently discarded.
const sessionIdleSequence = new Map<string, number>()
const sessionErrorSuppressionAt = new Map<string, number>()
const sessionLastBusyAt = new Map<string, number>()
const pendingIdleTimers = new Map<string, ReturnType<typeof setTimeout>>()
const subagentSessionIds = new Set<string>()

// Last time we fired a "complete" notification per session (cooldown).
const sessionLastCompleteAt = new Map<string, number>()

type UnknownRecord = Record<string, unknown>

function asRecord(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" ? (value as UnknownRecord) : null
}

function getNestedRecord(root: unknown, ...path: string[]): UnknownRecord | null {
  let current: unknown = root
  for (const key of path) {
    const record = asRecord(current)
    if (!record || !(key in record)) {
      return null
    }
    current = record[key]
  }
  return asRecord(current)
}

function getStringField(record: UnknownRecord | null, key: string): string | null {
  if (!record) {
    return null
  }
  const value = record[key]
  return typeof value === "string" && value.length > 0 ? value : null
}

// ---- Turn counter ----

let globalTurnCount: number | null = null

function loadTurnCount(): number {
  try {
    const content = readFileSync(getStatePath(), "utf-8")
    const state = JSON.parse(content)
    if (typeof state.turn === "number" && Number.isFinite(state.turn) && state.turn >= 0) {
      return state.turn
    }
  } catch {}
  return 0
}

function saveTurnCount(count: number): void {
  try {
    writeFileSync(getStatePath(), JSON.stringify({ turn: count }))
  } catch {}
}

function incrementTurnCount(): number {
  if (globalTurnCount === null) {
    globalTurnCount = loadTurnCount()
  }
  globalTurnCount++
  saveTurnCount(globalTurnCount)
  return globalTurnCount
}

// ---- Memory cleanup ----

const cleanupInterval = setInterval(() => {
  const cutoff = Date.now() - 5 * 60 * 1000

  // Remove idle entries whose timers have already been cleared
  for (const [sessionID] of sessionIdleSequence) {
    if (!pendingIdleTimers.has(sessionID)) {
      sessionIdleSequence.delete(sessionID)
      subagentSessionIds.delete(sessionID)
    }
  }

  for (const [sessionID, timestamp] of sessionErrorSuppressionAt) {
    if (timestamp < cutoff) {
      sessionErrorSuppressionAt.delete(sessionID)
    }
  }

  for (const [sessionID, timestamp] of sessionLastBusyAt) {
    if (timestamp < cutoff) {
      sessionLastBusyAt.delete(sessionID)
    }
  }

  // Prune stale context-activity entries
  for (const [sessionID, lastAt] of sessionLastContextAt) {
    if (Date.now() - lastAt > 120_000) {
      sessionLastContextAt.delete(sessionID)
    }
  }

  prunePermissionAlertState(cutoff)

  // Prune stale complete-cooldown entries
  for (const [sessionID, timestamp] of sessionLastCompleteAt) {
    if (timestamp < cutoff) {
      sessionLastCompleteAt.delete(sessionID)
    }
  }
}, 5 * 60 * 1000)
cleanupInterval.unref()

// ---- Notification helpers ----

function getNotificationTitle(config: NotifierConfig, projectName: string | null): string {
  if (config.showProjectName && projectName) {
    return `OpenCode (${projectName})`
  }
  return "OpenCode"
}

function formatTimestamp(): string {
  const now = new Date()
  const h = String(now.getHours()).padStart(2, "0")
  const m = String(now.getMinutes()).padStart(2, "0")
  const s = String(now.getSeconds()).padStart(2, "0")
  return `${h}:${m}:${s}`
}

export function extractAgentNameFromSessionTitle(sessionTitle: unknown): string {
  if (typeof sessionTitle !== "string" || sessionTitle.length === 0) {
    return ""
  }

  const match = sessionTitle.match(/\s*\(@([^\s)]+)\s+subagent\)\s*$/)
  return match ? match[1] : ""
}

function shouldResolveAgentNameForEvent(config: NotifierConfig, eventType: EventType): boolean {
  if (getMessage(config, eventType).includes("{agentName}")) {
    return true
  }

  if (!config.command.enabled || !isEventCommandEnabled(config, eventType)) {
    return false
  }

  if (config.command.path.includes("{agentName}")) {
    return true
  }

  return (config.command.args ?? []).some((arg) => arg.includes("{agentName}"))
}

async function handleEvent(
  config: NotifierConfig,
  eventType: EventType,
  projectName: string | null,
  elapsedSeconds?: number | null,
  sessionTitle?: string | null,
  sessionID?: string | null,
  agentName?: string | null
): Promise<void> {
  if (config.suppressWhenFocused && isTerminalFocused()) {
    return
  }

  if (
    (eventType === "complete" || eventType === "subagent_complete") &&
    typeof elapsedSeconds === "number" &&
    Number.isFinite(elapsedSeconds) &&
    elapsedSeconds < config.minDuration
  ) {
    return
  }

  const promises: Promise<void>[] = []

  const timestamp = formatTimestamp()
  const turn = incrementTurnCount()

  const rawMessage = getMessage(config, eventType)
  const message = interpolateMessage(rawMessage, {
    sessionTitle: config.showSessionTitle ? sessionTitle : null,
    agentName,
    projectName,
    timestamp,
    turn,
  })

  const notificationEnabled = isEventNotificationEnabled(config, eventType)
  if (notificationEnabled) {
    const title = getNotificationTitle(config, projectName)
    const iconPath = getIconPath(config)
    const onNotificationClick = isKDEJumpBackSupported() ? () => void focusTerminal() : undefined
    promises.push(
      sendNotification(
        title,
        message,
        config.timeout,
        iconPath,
        config.notificationSystem,
        config.linux.grouping,
        onNotificationClick,
        config.windows.appID,
      )
    )
  }

  if (isEventSoundEnabled(config, eventType)) {
    const customSoundPath = getSoundPath(config, eventType)
    const ghosttyOnMac =
      process.platform === "darwin" &&
      config.notificationSystem === "ghostty" &&
      notificationEnabled &&
      config.suppressGhosttySound
    if (!ghosttyOnMac) {
      const soundVolume = getSoundVolume(config, eventType)
      promises.push(playSound(eventType, customSoundPath, soundVolume))
    }
  }

  if (isEventBellEnabled(config, eventType)) {
    promises.push(ringBell())
  }

  const minDuration = config.command?.minDuration
  const shouldSkipCommand =
    !isEventCommandEnabled(config, eventType) ||
    (typeof minDuration === "number" &&
      Number.isFinite(minDuration) &&
      minDuration > 0 &&
      typeof elapsedSeconds === "number" &&
      Number.isFinite(elapsedSeconds) &&
      elapsedSeconds < minDuration)

  if (!shouldSkipCommand) {
    runCommand(config, eventType, message, sessionTitle, agentName, projectName, timestamp, turn)
  }

  await Promise.allSettled(promises)
}

// ---- Event data helpers ----

interface SessionData {
  sessionID: string | null
  parentID: string | null
  title: string | null
}

function getEventData(event: unknown): SessionData {
  const data = getNestedRecord(event, "data")
  return {
    sessionID: getStringField(data, "sessionID"),
    parentID: getStringField(data, "parentID"),
    title: getStringField(data, "title"),
  }
}

function getSessionIDFromEvent(event: unknown): string | null {
  const data = getNestedRecord(event, "data")
  return getStringField(data, "sessionID")
}

export function getPermissionIDFromEvent(event: unknown): string | null {
  const data = getNestedRecord(event, "data")
  if (data) {
    const request = getNestedRecord(data, "request")
    return getStringField(request, "id") ?? getStringField(data, "id")
  }
  return null
}

// Grace period letting auto-approved requests resolve before checking the
// pending list. Without this wait, a freshly-asked permission always appears
// pending because the user hasn't had time to approve/deny yet.
export const PERMISSION_PENDING_GRACE_MS = 300

// Check whether a permission request is still awaiting approval.
// Fails open (returns true) so we never silently skip a real notification.
// Check whether a permission request is still awaiting approval
export async function isPermissionStillPending(
  ctx: any,
  sessionID: string,
  permissionID: string
): Promise<boolean> {
  if (!sessionID) {
    return true
  }
  try {
    const pending = await ctx.permission.list({ sessionID })
    const list = Array.isArray(pending) ? pending : []
    return list.some((p: { id?: string }) => p?.id === permissionID)
  } catch {
    return true
  }
}

// ---- Idle management ----

function clearPendingIdleTimer(sessionID: string): void {
  const timer = pendingIdleTimers.get(sessionID)
  if (!timer) {
    return
  }
  clearTimeout(timer)
  pendingIdleTimers.delete(sessionID)
}

function bumpSessionIdleSequence(sessionID: string): number {
  const next = (sessionIdleSequence.get(sessionID) ?? 0) + 1
  sessionIdleSequence.set(sessionID, next)
  return next
}

function hasCurrentSessionIdleSequence(sessionID: string, sequence: number): boolean {
  return sessionIdleSequence.get(sessionID) === sequence
}

function markSessionError(sessionID: string | null): void {
  if (!sessionID) {
    return
  }
  sessionErrorSuppressionAt.set(sessionID, Date.now())
  bumpSessionIdleSequence(sessionID)
  clearPendingIdleTimer(sessionID)
}

function markSessionBusy(sessionID: string): void {
  const now = Date.now()
  sessionLastBusyAt.set(sessionID, now)
  sessionErrorSuppressionAt.delete(sessionID)
  bumpSessionIdleSequence(sessionID)
  clearPendingIdleTimer(sessionID)
}

function shouldSuppressSessionIdle(sessionID: string, consume = true): boolean {
  const errorAt = sessionErrorSuppressionAt.get(sessionID)
  if (errorAt === undefined) {
    return false
  }
  const busyAt = sessionLastBusyAt.get(sessionID)
  if (typeof busyAt === "number" && busyAt > errorAt) {
    sessionErrorSuppressionAt.delete(sessionID)
    return false
  }
  if (consume) {
    sessionErrorSuppressionAt.delete(sessionID)
  }
  return true
}

// ---- Session API helpers ----

async function getElapsedSinceLastPrompt(ctx: any, sessionID: string, nowMs = Date.now()): Promise<number | null> {
  try {
    const messages = await ctx.session.context({ sessionID })
    if (!Array.isArray(messages)) {
      return null
    }
    let lastUserMessageTime: number | null = null
    for (const msg of messages) {
      const info = msg.info
      if (info.role === "user" && typeof info.time?.created === "number") {
        if (lastUserMessageTime === null || info.time.created > lastUserMessageTime) {
          lastUserMessageTime = info.time.created
        }
      }
    }
    if (lastUserMessageTime !== null) {
      return (nowMs - lastUserMessageTime) / 1000
    }
  } catch {
    // ignore
  }
  return null
}

interface SessionInfo {
  isChild: boolean
  title: string | null
}

async function getSessionInfo(ctx: any, sessionID: string): Promise<SessionInfo> {
  try {
    const session = await ctx.session.get({ sessionID })
    const title = typeof session?.title === "string" ? session.title : null
    return {
      isChild: !!session?.parentID,
      title,
    }
  } catch {
    return { isChild: false, title: null }
  }
}

async function processSessionIdle(
  ctx: any,
  config: NotifierConfig,
  projectName: string | null,
  sessionID: string,
  sequence: number,
  idleReceivedAtMs: number
): Promise<void> {
  if (!hasCurrentSessionIdleSequence(sessionID, sequence)) {
    return
  }

  if (shouldSuppressSessionIdle(sessionID)) {
    return
  }

  // Cooldown: don't fire "complete" more than once per session within
  // IDLE_COMPLETE_COOLDOWN_MS so we don't spam when a session rapidly
  // oscillates between idle and busy.
  const lastCompleteAt = sessionLastCompleteAt.get(sessionID)
  if (lastCompleteAt && Date.now() - lastCompleteAt < IDLE_COMPLETE_COOLDOWN_MS) {
    return
  }

  // Fast path: already known subagent — skip API call
  if (subagentSessionIds.has(sessionID)) {
    sessionLastCompleteAt.set(sessionID, Date.now())
    await handleEventWithElapsedTime(ctx, config, "subagent_complete", projectName, sessionID, idleReceivedAtMs, null)
    return
  }

  const sessionInfo = await getSessionInfo(ctx, sessionID)

  if (!hasCurrentSessionIdleSequence(sessionID, sequence)) {
    return
  }

  if (shouldSuppressSessionIdle(sessionID)) {
    return
  }

  if (!sessionInfo.isChild) {
    sessionLastCompleteAt.set(sessionID, Date.now())
    await handleEventWithElapsedTime(ctx, config, "complete", projectName, sessionID, idleReceivedAtMs, sessionInfo.title)
    return
  }

  subagentSessionIds.add(sessionID)
  sessionLastCompleteAt.set(sessionID, Date.now())
  await handleEventWithElapsedTime(
    ctx,
    config,
    "subagent_complete",
    projectName,
    sessionID,
    idleReceivedAtMs,
    sessionInfo.title
  )
}

function scheduleSessionIdle(ctx: any, config: NotifierConfig, projectName: string | null, sessionID: string): void {
  clearPendingIdleTimer(sessionID)
  const sequence = bumpSessionIdleSequence(sessionID)
  const idleReceivedAtMs = Date.now()

  const timer = setTimeout(() => {
    pendingIdleTimers.delete(sessionID)
    void processSessionIdle(ctx, config, projectName, sessionID, sequence, idleReceivedAtMs).catch(() => undefined)
  }, IDLE_COMPLETE_DELAY_MS)

  pendingIdleTimers.set(sessionID, timer)
}

async function handleEventWithElapsedTime(
  ctx: any,
  config: NotifierConfig,
  eventType: EventType,
  projectName: string | null,
  sessionID: string,
  elapsedReferenceNowMs?: number,
  preloadedSessionTitle?: string | null
): Promise<void> {
  const commandMinDuration = config.command?.minDuration
  const shouldLookupElapsedForCommand =
    !!config.command?.enabled &&
    typeof config.command?.path === "string" &&
    config.command.path.length > 0 &&
    typeof commandMinDuration === "number" &&
    Number.isFinite(commandMinDuration) &&
    commandMinDuration > 0

  const shouldLookupElapsedForNotification =
    typeof config.minDuration === "number" &&
    Number.isFinite(config.minDuration) &&
    config.minDuration > 0

  const shouldLookupElapsed = shouldLookupElapsedForCommand || shouldLookupElapsedForNotification

  let elapsedSeconds: number | null = null
  if (shouldLookupElapsed) {
    elapsedSeconds = await getElapsedSinceLastPrompt(ctx, sessionID, elapsedReferenceNowMs)
  }

  let sessionTitle: string | null = preloadedSessionTitle ?? null
  const shouldLookupSessionInfo =
    sessionID && !sessionTitle && (config.showSessionTitle || shouldResolveAgentNameForEvent(config, eventType))
  if (shouldLookupSessionInfo) {
    const info = await getSessionInfo(ctx, sessionID)
    sessionTitle = info.title
  }

  const agentName = extractAgentNameFromSessionTitle(sessionTitle)
  await handleEvent(config, eventType, projectName, elapsedSeconds, sessionTitle, sessionID, agentName)
}

// ---- Idle detection polling ----
// V2 has no session.idle event.  The context hook fires right before each model
// call inside the agent loop.  By tracking the last time it fired per session
// we can detect when a session goes idle (no model calls for IDLE_CHECK_DELAY_MS).

async function detectIdleSessions(ctx: any, config: NotifierConfig, projectName: string | null): Promise<void> {
  const now = Date.now()
  const toRemove: string[] = []

  for (const [sessionID, lastContextAt] of sessionLastContextAt) {
    if (now - lastContextAt > IDLE_CHECK_DELAY_MS) {
      if (isCLIClient(process.env.OPENCODE_CLIENT)) {
        const sequence = bumpSessionIdleSequence(sessionID)
        await processSessionIdle(ctx, config, projectName, sessionID, sequence, now).catch(() => undefined)
      } else {
        scheduleSessionIdle(ctx, config, projectName, sessionID)
      }
    } else if (now - lastContextAt > 120_000) {
      // Stale entry — no activity for 2 minutes
      toRemove.push(sessionID)
    }
  }

  for (const sid of toRemove) {
    sessionLastContextAt.delete(sid)
  }
}

// ---- Plugin definition ----

export default Plugin.define({
  id: "opencode-notifier",
  async setup(ctx) {
    captureStartupWindowId()

    const clientEnv = process.env.OPENCODE_CLIENT
    const initialConfig = loadConfig()
    if (clientEnv && clientEnv !== "cli" && !initialConfig.enableOnDesktop) {
      return
    }

    const getConfig = () => loadConfig()
    const projectName = ctx.location.directory
      ? initialConfig.showFullPath
        ? ctx.location.directory
        : basename(ctx.location.directory)
      : null

    // Fire client_connected right after plugin init.  CLI sessions skip the
    // delay because the process may exit before a timeout fires.
    const isCLI = isCLIClient(clientEnv)
    if (isCLI) {
      void handleEvent(getConfig(), "client_connected", projectName, null)
    } else {
      setTimeout(() => {
        void handleEvent(getConfig(), "client_connected", projectName, null)
      }, 100)
    }

    // ---- Session context hook (activity tracking) ----
    // Fires before every model call in the agent loop.  We use it to track
    // per-session activity; when a session hasn't called the context hook
    // for IDLE_CHECK_DELAY_MS we treat it as idle (generation complete).
    const contextRegistration = await ctx.session.hook("context", (event) => {
      sessionLastContextAt.set(event.sessionID, Date.now())
    })

    // ---- Permission hook ----
    // Fires when a permission rule is evaluated.  We fire a notification
    // for each evaluation and rely on the shared dedupe window to suppress
    // duplicates from rapid re-evaluations.
    const permissionRegistration = await ctx.permission.hook("evaluate", async (event: any) => {
      if (shouldSuppressPermissionAlert(null)) {
        return
      }

      const sessionID = event.sessionID ?? event.data?.sessionID ?? null
      const permissionID = event.requestID ?? event.data?.requestID ?? getPermissionIDFromEvent(event)

      // If we can resolve the permission, check if it's still pending after
      // the grace period so that auto-approved requests don't trigger
      // notifications.
      if (permissionID && sessionID) {
        await new Promise((resolve) => setTimeout(resolve, PERMISSION_PENDING_GRACE_MS))
        if (!(await isPermissionStillPending(ctx, sessionID, permissionID))) {
          return
        }
      }

      await handleEvent(getConfig(), "permission", projectName, null)
    })

    // ---- Prompt hook (user message detection) ----
    // Fires when a user prompt is admitted.  We fire "user_message" for
    // non-subagent sessions so the plugin can notify on new user input.
    const promptRegistration = await ctx.session.hook("prompt", async (event: any) => {
      const sessionID = event.sessionID
      if (!sessionID || !subagentSessionIds.has(sessionID)) {
        await handleEvent(getConfig(), "user_message", projectName, null, null, sessionID, null)
      }
    })

    // ---- Retry hook (error detection) ----
    // Fires when a provider request fails.  We detect non-retryable errors
    // (when the retry decision is "no") and fire an "error" notification.
    const retryRegistration = await ctx.session.hook("retry", async (event: any) => {
      const sessionID = event.sessionID
      if (event.decision?.retry !== false) {
        return
      }

      if (shouldSuppressSessionIdle(sessionID, false)) {
        return
      }

      const eventType: EventType =
        event.error?.type === "MessageAbortedError" ? "user_cancelled" : "error"

      markSessionError(sessionID)
      let sessionTitle: string | null = null
      if (sessionID && loadConfig().showSessionTitle) {
        const info = await getSessionInfo(ctx, sessionID)
        sessionTitle = info.title
      }
      await handleEventWithElapsedTime(
        ctx,
        getConfig(),
        eventType,
        projectName,
        sessionID,
        undefined,
        sessionTitle
      )
    })

    // ---- Event subscription (session lifecycle) ----
    // V2 provides `session.created` and `session.agent.selected` events that
    // let us track subagent sessions and fire "session_started" for new
    // top-level sessions.
    const eventController = new AbortController()
    void (async () => {
      for await (const event of ctx.event.subscribe({ signal: eventController.signal })) {
        if (event.type === "session.created") {
          const data = getEventData(event)
          if (data.parentID && data.sessionID) {
            subagentSessionIds.add(data.sessionID)
          } else if (data.sessionID) {
            await handleEvent(
              getConfig(),
              "session_started",
              projectName,
              null,
              data.title,
              data.sessionID,
              null
            )
          }
        }
      }
    })()

    // ---- Idle detection polling loop ----
    // Since V2 doesn't emit a session.idle event, we poll the context
    // activity timestamps periodically to detect when sessions become idle.
    const pollController = new AbortController()
    void (async () => {
      while (true) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, IDLE_POLL_INTERVAL_MS)
          pollController.signal.addEventListener("abort", () => {
            clearTimeout(timer)
            resolve()
          }, { once: true })
        })
        if (pollController.signal.aborted) {
          break
        }
        void detectIdleSessions(ctx, getConfig(), projectName).catch(() => undefined)
      }
    })()

    // ---- Cleanup ----
    // Abort subscriptions and dispose hooks on plugin unload.
    return () => {
      contextRegistration.dispose()
      permissionRegistration.dispose()
      promptRegistration.dispose()
      retryRegistration.dispose()
      eventController.abort()
      pollController.abort()
    }
  },
})
