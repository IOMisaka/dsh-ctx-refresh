/**
 * dsh-ctx-refresh — host half.
 *
 * Registers two exact routes on the webServer:
 *   - POST /refresh-model-ctx  — manual refresh (settings card button);
 *   - GET  /ctx-refresh/state  — runtime state for client polling (syncing flag,
 *     last attempt/success timestamps, compact last result).
 *
 * Auto-sync: a settings namespace `dsh-ctx-refresh` carries { autoSyncEnabled,
 * autoSyncIntervalMinutes } (defaults: on, 30 min). Every user message entering
 * any agent inbox (`agent/inbox/inserted`) checks the persisted last-attempt
 * time; when the interval has elapsed a background refresh runs and its result
 * is recorded for the client to display. Attempts are gated by start-time so at
 * most one auto-sync runs per interval window, success or failure alike.
 *
 * For every llm-pi-ai provider route that carries an explicit model list, the
 * context window is resolved per model id through three tiers (first hit wins):
 *   1. openai        — OpenAI-compatible GET {baseURL}/models, fields
 *                      context_window / context_length (bearer auth from the
 *                      route's credential reference when configured);
 *   2. lm-studio     — LM Studio native GET {root}/api/v0/models, field
 *                      loaded_context_length: the actual runtime context the
 *                      backend has the model loaded at;
 *   3. ollama        — Ollama native per-model GET {root}/api/show?name=<id>,
 *                      field details.context_length.
 * where {root} is baseURL with a trailing /v1 stripped. Only tier 2/3 are tried
 * for ids the previous tiers left without a window, so an OpenAI gateway that
 * reports everything costs exactly one request. max_context_length (LM Studio)
 * is deliberately NOT used: it is an architecture ceiling, not the window the
 * backend will actually serve (num_ctx may be lower).
 *
 * Writes go through path-addressed settings mutations on llm-pi-ai. dsh-settings
 * applyPathOp descends only through plain objects — array indices are not
 * addressable — so each route is written as ONE op replacing the whole models
 * array with a copy that carries the new contextWindow values; every other
 * field of every entry passes through untouched. Routes without an explicit
 * list or endpoint are skipped and reported; a route is a hard error only when
 * every tier failed to fetch.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import z from '@deepseek-ai/schemastery'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'

export const name = 'dsh-ctx-refresh'
export const inject = ['webServer', 'settings']

const NS = 'llm-pi-ai'
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024
const FETCH_TIMEOUT_MS = 20000

/** Plugin-owned settings namespace (auto-sync configuration). */
const CtxRefreshConfigSchema = z.object({
	autoSyncEnabled: z.boolean().default(true),
	autoSyncIntervalMinutes: z.number().default(30)
})
const DEFAULT_CONFIG = { autoSyncEnabled: true, autoSyncIntervalMinutes: 30 }

/** Runtime state file (survives restarts): <DSH_HOME>/dsh-ctx-refresh/state.json */
const STATE_DIR = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'dsh-ctx-refresh')
const STATE_FILE = path.join(STATE_DIR, 'state.json')

function listingUrl(baseURL) {
	return `${String(baseURL).replace(/\/+$/, '')}/models`
}

/** Native API root: baseURL minus query/fragment, trailing slashes and one /v1. */
function nativeApiRoot(baseURL) {
	return String(baseURL).replace(/[?#].*$/, '').replace(/\/+$/, '').replace(/\/v1$/i, '')
}

function positiveInt(value) {
	return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined
}

/** Strip query/fragment so error text never carries credentials or params. */
function publicUrl(url) {
	return String(url).split(/[?#]/)[0]
}

async function readBounded(response, url) {
	const oversized = () => new Error(`${publicUrl(url)} answered with more than ${MAX_RESPONSE_BYTES} bytes`)
	const declared = Number(response.headers.get('content-length') ?? NaN)
	if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
		await response.body?.cancel()
		throw oversized()
	}
	if (response.body === null) return ''
	const reader = response.body.getReader()
	const chunks = []
	let total = 0
	try {
		for (;;) {
			const { done, value } = await reader.read()
			if (done) break
			total += value.byteLength
			if (total > MAX_RESPONSE_BYTES) throw oversized()
			chunks.push(value)
		}
	} finally {
		await reader.cancel().catch(() => {})
	}
	const body = new Uint8Array(total)
	let offset = 0
	for (const chunk of chunks) {
		body.set(chunk, offset)
		offset += chunk.byteLength
	}
	return new TextDecoder().decode(body)
}

async function fetchJson(url, headers) {
	const controller = new AbortController()
	const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
	let response
	try {
		response = await fetch(url, { headers: headers ?? {}, signal: controller.signal })
	} finally { clearTimeout(timer) }
	if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
	const text = await readBounded(response, url)
	let body
	try { body = JSON.parse(text) } catch { throw new Error('listing is not valid JSON') }
	return body
}

/** Tier 1: OpenAI-compatible listing → Map id→ctx (only ids that report one). */
async function fetchOpenAiListing(baseURL, apiKey) {
	const url = listingUrl(baseURL)
	const headers = {}
	if (apiKey !== undefined && apiKey !== '') headers['authorization'] = `Bearer ${apiKey}`
	const body = await fetchJson(url, headers)
	const data = Array.isArray(body?.data) ? body.data : null
	if (data === null) throw new Error('listing has no "data" array')
	const byId = new Map()
	for (const raw of data) {
		const id = typeof raw?.id === 'string' && raw.id !== '' ? raw.id : undefined
		if (id === undefined) continue
		const ctx = positiveInt(raw.context_window) ?? positiveInt(raw.context_length)
		if (ctx !== undefined) byId.set(id, ctx)
	}
	return { url, byId }
}

/** Tier 2: LM Studio native listing → Map id→loaded_context_length. */
async function fetchLmStudioListing(baseURL) {
	const url = `${nativeApiRoot(baseURL)}/api/v0/models`
	const body = await fetchJson(url)
	const data = Array.isArray(body?.data) ? body.data : null
	if (data === null) throw new Error('listing has no "data" array')
	const byId = new Map()
	for (const raw of data) {
		const id = typeof raw?.id === 'string' && raw.id !== '' ? raw.id : undefined
		if (id === undefined) continue
		const ctx = positiveInt(raw.loaded_context_length)
		if (ctx !== undefined) byId.set(id, ctx)
	}
	return { url, byId }
}

/** Tier 3: Ollama native per-model detail → details.context_length. */
async function fetchOllamaContext(baseURL, modelId) {
	const url = `${nativeApiRoot(baseURL)}/api/show?name=${encodeURIComponent(modelId)}`
	const body = await fetchJson(url)
	return positiveInt(body?.details?.context_length)
}

export function apply(ctx) {
	let busy = false
	// Persisted runtime state (loaded once, saved after every sync attempt).
	let lastAttemptMs = null
	let lastSuccessMs = null
	let lastResult = null

	function loadState() {
		try {
			const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
			if (!parsed || typeof parsed !== 'object') return
			lastAttemptMs = Number.isFinite(parsed.lastAttemptMs) ? parsed.lastAttemptMs : null
			lastSuccessMs = Number.isFinite(parsed.lastSuccessMs) ? parsed.lastSuccessMs : null
			lastResult = (parsed.lastResult && typeof parsed.lastResult === 'object') ? parsed.lastResult : null
		} catch {}
	}

	function persistState() {
		try {
			fs.mkdirSync(STATE_DIR, { recursive: true })
			fs.writeFileSync(STATE_FILE, JSON.stringify({ lastAttemptMs, lastSuccessMs, lastResult }))
		} catch (error) {
			ctx.logger?.warn(`dsh-ctx-refresh: state persist failed: ${String((error && error.message) || error)}`)
		}
	}

	loadState()

	/** Compact, JSON-safe summary of one refresh outcome for display + persistence. */
	function summarize(result) {
		return {
			ok: true,
			atMs: Date.now(),
			ms: result.ms,
			updatedCount: result.updated.length,
			unchangedModels: result.unchangedModels,
			noWindowModels: result.noWindowModels,
			skippedCount: result.skipped.length,
			errorCount: result.errors.length,
			errors: result.errors.slice(0, 5).map((e) => `${e.route}: ${String(e.error).slice(0, 200)}`)
		}
	}

	/** Shared refresh core (manual route + auto-sync hook). Resolves to the full result. */
	async function runRefresh() {
		const startedAt = Date.now()
		const cfg = ctx.settings.get(NS)
		const providers = (cfg && typeof cfg === 'object' && cfg.providers && typeof cfg.providers === 'object') ? cfg.providers : {}
		const updated = []
		const skipped = []
		const errors = []
		let unchangedModels = 0
		let noWindowModels = 0

		for (const [routeId, profile] of Object.entries(providers)) {
			if (!profile || typeof profile !== 'object') continue
			const models = Array.isArray(profile.models) ? profile.models : null
			if (models === null || models.length === 0) {
				skipped.push({ route: routeId, reason: 'no explicit model list' })
				continue
			}
			const baseURL = typeof profile.baseURL === 'string' && profile.baseURL.trim() !== '' ? profile.baseURL.trim() : null
			if (baseURL === null) {
				skipped.push({ route: routeId, reason: 'no endpoint configured' })
				continue
			}
			const modelIds = models.filter((m) => m && typeof m.id === 'string').map((m) => m.id)

			// One-shot bearer key from the route's credential reference; absent means unauthenticated.
			let apiKey
			try {
				const credentials = typeof ctx.get === 'function' ? ctx.get('credentials') : undefined
				if (typeof profile.apiKeyEnv === 'string' && profile.apiKeyEnv !== '' && credentials) {
					const resolved = await credentials.resolve(profile.apiKeyEnv)
					apiKey = resolved ? resolved.value : undefined
				}
			} catch {}

			// Tier 1: OpenAI-compatible listing.
			let openaiById = null
			let openaiError = null
			try {
				openaiById = (await fetchOpenAiListing(baseURL, apiKey)).byId
			} catch (error) {
				openaiError = String((error && error.message) || error)
			}

			// Tier 2: LM Studio native listing for ids tier 1 left without a window.
			let lmById = null
			let lmError = null
			const missingAfterOpenAi = modelIds.filter((id) => !openaiById?.has(id))
			if (missingAfterOpenAi.length > 0) {
				try {
					lmById = (await fetchLmStudioListing(baseURL)).byId
				} catch (error) {
					lmError = String((error && error.message) || error)
				}
			}

			// Tier 3: Ollama native per-model detail for ids still without a window.
			const ollamaCtx = new Map()
			const missingAfterLmStudio = modelIds.filter((id) => !openaiById?.has(id) && !(lmById !== null && lmById.has(id)))
			if (missingAfterLmStudio.length > 0) {
				await Promise.all(missingAfterLmStudio.map(async (id) => {
					try {
						const value = await fetchOllamaContext(baseURL, id)
						if (value !== undefined) ollamaCtx.set(id, value)
					} catch {}
				}))
			}

			if (openaiError !== null && lmError !== null && missingAfterLmStudio.length > 0 && ollamaCtx.size === 0) {
				errors.push({ route: routeId, error: `OpenAI /models: ${openaiError}; LM Studio /api/v0/models: ${lmError}; Ollama /api/show: no context_length` })
				continue
			}

			// Build the replacement models array; entries keep every field except contextWindow.
			const nextModels = []
			const routeUpdates = []
			let changedCount = 0
			models.forEach((model) => {
				if (!model || typeof model !== 'object' || typeof model.id !== 'string') {
					nextModels.push(model)
					return
				}
				let next, source
				if (openaiById && openaiById.has(model.id)) { next = openaiById.get(model.id); source = 'openai' }
				else if (lmById !== null && lmById.has(model.id)) { next = lmById.get(model.id); source = 'lm-studio(loaded)' }
				else if (ollamaCtx.has(model.id)) { next = ollamaCtx.get(model.id); source = 'ollama' }
				if (next === undefined) { noWindowModels += 1; nextModels.push(model); return } // backend reports no window: leave untouched
				if (model.contextWindow === next) { unchangedModels += 1; nextModels.push(model); return }
				nextModels.push({ ...model, contextWindow: next })
				routeUpdates.push({ route: routeId, model: model.id, from: typeof model.contextWindow === 'number' ? model.contextWindow : null, to: next, source })
				changedCount += 1
			})

			if (changedCount > 0) {
				try {
					await ctx.settings.mutate(NS, [{ op: 'set', path: ['providers', routeId, 'models'], value: nextModels }])
					updated.push(...routeUpdates)
				} catch (error) {
					errors.push({ route: routeId, error: `settings write failed: ${String((error && error.message) || error)}` })
				}
			}
		}

		return { ok: true, ms: Date.now() - startedAt, updated, unchangedModels, noWindowModels, skipped, errors }
	}

	/** Record one completed attempt (manual or auto) and persist it. */
	function recordAttempt(resultOrError, isResult) {
		if (isResult) {
			lastSuccessMs = Date.now()
			lastResult = summarize(resultOrError)
		} else {
			lastResult = { ok: false, atMs: Date.now(), message: String((resultOrError && resultOrError.message) || resultOrError).slice(0, 300) }
		}
		persistState()
	}

	/** Auto-sync entry: fire-and-forget so the inbox event never blocks. */
	async function runAutoSync() {
		if (busy) return
		busy = true
		lastAttemptMs = Date.now()
		try {
			const result = await runRefresh()
			recordAttempt(result, true)
			ctx.logger?.info(`dsh-ctx-refresh: auto-sync done in ${result.ms}ms — updated=${String(result.updated.length)} unchanged=${String(result.unchangedModels)} errors=${String(result.errors.length)}`)
		} catch (error) {
			recordAttempt(error, false)
			ctx.logger?.warn(`dsh-ctx-refresh: auto-sync failed: ${String((error && error.message) || error)}`)
		} finally {
			busy = false
		}
	}

	// ── settings namespace (auto-sync configuration; client card binds to it) ──
	let configGet = () => DEFAULT_CONFIG
	try {
		installSettingsSection(ctx, settingsNamespace('dsh-ctx-refresh'), CtxRefreshConfigSchema, DEFAULT_CONFIG, {
			setSource: (get) => { configGet = get },
			onChange: () => {}
		})
	} catch (error) {
		ctx.logger?.warn(`dsh-ctx-refresh: settings section install failed: ${String((error && error.message) || error)}`)
	}

	// ── auto-sync hook: any user message entering an agent inbox ──
	const disposeInbox = ctx.on('agent/inbox/inserted', () => {
		try {
			const cfg = configGet()
			if (cfg.autoSyncEnabled !== true) return
			if (busy) return
			const minutes = Number.isFinite(Number(cfg.autoSyncIntervalMinutes)) && Number(cfg.autoSyncIntervalMinutes) > 0 ? Number(cfg.autoSyncIntervalMinutes) : 30
			const intervalMs = Math.max(1, minutes) * 60000
			if (lastAttemptMs !== null && Date.now() - lastAttemptMs < intervalMs) return
			void runAutoSync()
		} catch {}
	})

	// ── routes ──
	const disposeManual = ctx.webServer.register({
		kind: 'exact',
		path: '/refresh-model-ctx',
		handler: async (req, res) => {
			if (req.method !== 'POST') {
				res.writeHead(405, { 'content-type': 'application/json' })
				res.end(JSON.stringify({ ok: false, message: 'method not allowed' }))
				return
			}
			if (busy) {
				res.writeHead(200, { 'content-type': 'application/json' })
				res.end(JSON.stringify({ ok: false, message: '刷新已在进行中，请稍候' }))
				return
			}
			busy = true
			lastAttemptMs = Date.now()
			try {
				const result = await runRefresh()
				recordAttempt(result, true)
				res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
				res.end(JSON.stringify(result))
			} catch (error) {
				recordAttempt(error, false)
				try {
					res.writeHead(500, { 'content-type': 'application/json' })
					res.end(JSON.stringify({ ok: false, message: String((error && error.message) || error) }))
				} catch {}
			} finally {
				busy = false
			}
		}
	})

	const disposeState = ctx.webServer.register({
		kind: 'exact',
		path: '/ctx-refresh/state',
		handler: (req, res) => {
			if (req.method !== 'GET') {
				res.writeHead(405, { 'content-type': 'application/json' })
				res.end(JSON.stringify({ ok: false, message: 'method not allowed' }))
				return
			}
			const cfg = configGet()
			res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
			res.end(JSON.stringify({
				ok: true,
				syncing: busy,
				autoSyncEnabled: cfg.autoSyncEnabled === true,
				intervalMinutes: Number.isFinite(Number(cfg.autoSyncIntervalMinutes)) ? Number(cfg.autoSyncIntervalMinutes) : 30,
				lastAttemptMs,
				lastSuccessMs,
				lastResult
			}))
		}
	})

	return () => { disposeInbox(); disposeManual(); disposeState() }
}
