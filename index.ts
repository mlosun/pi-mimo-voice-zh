/**
 * pi-mimo-voice-zh — 小米 MiMo 中文语音扩展
 *
 *   Ctrl+Shift+V  语音输入（MiMo ASR）
 *   Ctrl+Shift+S  语音输出开关/打断（MiMo TTS）
 *   agent_end     自动朗读回复
 *   配置           config.json
 */

/* eslint-disable */
// @ts-nocheck
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn, type ChildProcess } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

// ── 硬编码 API ────────────────────────────────────────────────────
const BASE_URL = "https://api.xiaomimimo.com/v1";
const TTS_MODEL = "mimo-v2.5-tts";
const ASR_MODEL = "mimo-v2.5-asr";

// ── 类型 ──────────────────────────────────────────────────────────
interface VoiceSettings {
	ttsEnabled: boolean;
	sttEnabled: boolean;
	voice: string;
	apiKey: string;
	sttShortcut: string;
	ttsShortcut: string;
}

// ── 路径 ──────────────────────────────────────────────────────────
const CONFIG_PATH = join(homedir(), ".pi", "mimo-voice-zh.json");

const DEFAULT_SETTINGS: VoiceSettings = {
	voice: "冰糖",
	apiKey: "",
	ttsEnabled: true,
	sttEnabled: true,
	ttsShortcut: "ctrl+shift+k",
	sttShortcut: "ctrl+shift+v",
};

// ── 持久化 ────────────────────────────────────────────────────────
function loadSettings(): VoiceSettings {
	try {
		if (existsSync(CONFIG_PATH)) {
			return {
				...DEFAULT_SETTINGS,
				...JSON.parse(readFileSync(CONFIG_PATH, "utf-8")),
			};
		}
	} catch {
		/* ignore */
	}
	return { ...DEFAULT_SETTINGS };
}

function saveSettings(cfg: VoiceSettings): void {
	try {
		mkdirSync(join(homedir(), ".pi"), { recursive: true });
		const existing = existsSync(CONFIG_PATH)
			? JSON.parse(readFileSync(CONFIG_PATH, "utf-8"))
			: {};
		writeFileSync(
			CONFIG_PATH,
			JSON.stringify({ ...existing, ...cfg }, null, 2),
			"utf-8",
		);
	} catch (e) {
		console.warn("[mimo-voice] save error:", e);
	}
}

// ── 状态 ──────────────────────────────────────────────────────────
let settings = loadSettings();
let speakGen = 0;
let currentPlayer: ChildProcess | null = null;
let recording = false;
let recorder: ChildProcess | null = null;
let tmpDir: string;

// ── 文本清洗 ──────────────────────────────────────────────────────
function cleanText(text: string): string {
	return text
		.replace(/```[\s\S]*?```/g, "")
		.replace(/`([^`]+)`/g, "$1")
		.replace(/\*\*([^*]+)\*\*/g, "$1")
		.replace(/__([^_]+)__/g, "$1")
		.replace(/\*([^*]+)\*/g, "$1")
		.replace(/_([^_]+)_/g, "$1")
		.replace(/~~([^~]+)~~/g, "$1")
		.replace(/[#>|\\]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

// ── 文本分段 ──────────────────────────────────────────────────────
// MiMo TTS 是 LLM 驱动的，单次调用文本过长会导致模型"跑偏"。
// 实测 ~3000 字无问题，~10000 字开始乱说。
// 按段落拆分：段落内语气自然连贯，段落间过渡也比逐句拆分平滑。
// 遇超长段落再兜底按句子拆分。
const MAX_CHUNK = 2000;

function splitChunks(text: string): string[] {
	const paragraphs = text
		.split(/\n{2,}/)
		.map((s) => s.trim())
		.filter(Boolean);
	const result: string[] = [];
	for (const p of paragraphs) {
		if (p.length <= MAX_CHUNK) {
			result.push(p);
		} else {
			// 超长段落兜底：按句子拆分
			const sentences = p
				.split(/(?<=[。！？])/)
				.map((s) => s.trim())
				.filter(Boolean);
			for (const s of sentences) result.push(s);
		}
	}
	return result;
}

// ── MiMo ASR ──────────────────────────────────────────────────────
async function callASR(wavPath: string): Promise<string | null> {
	if (!settings.apiKey) return null;
	try {
		const b64 = readFileSync(wavPath).toString("base64");
		const res = await fetch(`${BASE_URL}/chat/completions`, {
			method: "POST",
			headers: {
				"api-key": settings.apiKey,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				model: ASR_MODEL,
				messages: [
					{
						role: "user",
						content: [
							{
								type: "input_audio",
								input_audio: { data: `data:audio/wav;base64,${b64}` },
							},
						],
					},
				],
				asr_options: { language: "zh" },
			}),
		});
		if (!res.ok) return null;
		const data: any = await res.json();
		return data?.choices?.[0]?.message?.content || null;
	} catch (e: any) {
		console.warn("[mimo-voice] ASR:", e.message);
		return null;
	}
}

// ── MiMo TTS ──────────────────────────────────────────────────────
async function callTTS(text: string, voiceId: string): Promise<Buffer | null> {
	if (!settings.apiKey) return null;
	try {
		const res = await fetch(`${BASE_URL}/chat/completions`, {
			method: "POST",
			headers: {
				"api-key": settings.apiKey,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				model: TTS_MODEL,
				messages: [{ role: "assistant", content: text }],
				audio: { format: "wav", voice: voiceId },
			}),
		});
		if (!res.ok) return null;
		const data: any = await res.json();
		const b64 = data?.choices?.[0]?.message?.audio?.data;
		return b64 ? Buffer.from(b64, "base64") : null;
	} catch (e: any) {
		console.warn("[mimo-voice] TTS:", e.message);
		return null;
	}
}

// ── 播放 ──────────────────────────────────────────────────────────
function stopSpeak(): void {
	if (currentPlayer) {
		currentPlayer.kill("SIGTERM");
		currentPlayer = null;
	}
	speakGen++;
}

function playWav(wavPath: string, gen: number): void {
	currentPlayer = spawn("afplay", [wavPath], { stdio: "ignore" });
	currentPlayer.on("error", (err: Error) =>
		console.warn("[mimo-voice] afplay:", err.message),
	);
	currentPlayer.on("close", () => {
		try {
			unlinkSync(wavPath);
		} catch {
			/* ignore */
		}
		if (speakGen === gen) currentPlayer = null;
	});
}

function speakSentences(sentences: string[]): void {
	if (!sentences.length) return;
	stopSpeak();
	const gen = ++speakGen;
	let idx = 0;
	async function next(): Promise<void> {
		if (speakGen !== gen) return;
		if (idx >= sentences.length) {
			currentPlayer = null;
			return;
		}
		const s = sentences[idx++]!;
		if (!s) {
			await next();
			return;
		}
		const wav = await callTTS(s, settings.voice);
		if (!wav) {
			await next();
			return;
		}
		const p = join(tmpDir, `tts-${gen}-${idx}.wav`);
		writeFileSync(p, wav);
		playWav(p, gen);
		if (currentPlayer)
			await new Promise<void>((r) => currentPlayer!.once("close", r));
		await next();
	}
	next();
}

// ── STT handler ───────────────────────────────────────────────────
async function sttHandler(ctx: any): Promise<void> {
	try {
		if (!settings.sttEnabled) {
			ctx.ui.notify("ASR 已关闭", "warning");
			return;
		}
		if (!settings.apiKey) {
			ctx.ui.notify("请先设置 API Key（config.json）", "error");
			return;
		}

		if (recording) {
			if (recorder) {
				recorder.kill("SIGTERM");
				recorder = null;
			}
			recording = false;
			ctx.ui.setStatus(
				"mimo-voice",
				settings.ttsEnabled ? "🔔 TTS 开启" : "🔕 TTS 关闭",
			);
			ctx.ui.notify("识别中...", "info");
			await new Promise((r) => setTimeout(r, 500));

			const files = readdirSync(tmpDir)
				.filter((f: string) => f.startsWith("stt-"))
				.map((f: string) => join(tmpDir, f))
				.sort()
				.reverse();
			const p = files[0];
			if (!p) {
				ctx.ui.notify("录音文件丢失", "error");
				return;
			}

			const text = await callASR(p);
			try {
				unlinkSync(p);
			} catch {
				/* ignore */
			}
			if (text) {
				ctx.ui.setEditorText(text);
				ctx.ui.notify(`识别: ${text.slice(0, 40)}`, "success");
			} else {
				ctx.ui.notify("语音识别失败", "error");
			}
		} else {
			stopSpeak();
			recording = true;
			const p = join(tmpDir, `stt-${Date.now()}.wav`);
			recorder = spawn("sox", ["-d", "-r", "16000", "-c", "1", "-b", "16", p], {
				stdio: "ignore",
			});
			recorder.on("error", (err: Error) => {
				console.warn("[mimo-voice] sox:", err.message);
				recording = false;
				recorder = null;
				ctx.ui.notify(`录音失败: ${err.message}`, "error");
			});
			ctx.ui.setStatus("mimo-voice", "🔴 正在录音");
			ctx.ui.notify("🔴 录音中，再按快捷键停止", "info");
		}
	} catch (err: any) {
		console.error("[mimo-voice] STT:", err);
	}
}

// ── 入口 ──────────────────────────────────────────────────────────
export default function mimoVoiceZh(pi: ExtensionAPI) {
	tmpDir = mkdtempSync(join(tmpdir(), "pi-mimo-voice-zh-"));

	function updateStatus(ctx?: any) {
		if (ctx?.ui)
			ctx.ui.setStatus(
				"mimo-voice",
				settings.ttsEnabled ? "🔔 TTS 开启" : "🔕 TTS 关闭",
			);
	}

	pi.on("session_start", (_event, ctx) => {
		settings = loadSettings();
		saveSettings(settings);
		updateStatus(ctx);
	});

	// STT 快捷键
	pi.registerShortcut(settings.sttShortcut, {
		description: "MiMo 语音输入",
		handler: async (ctx: any) => sttHandler(ctx),
	});

	// TTS 快捷键
	pi.registerShortcut(settings.ttsShortcut, {
		description: "MiMo TTS 开关/打断",
		handler: async (ctx: any) => {
			if (currentPlayer) {
				stopSpeak();
				ctx.ui.notify("朗读已打断", "warning");
			} else {
				settings.ttsEnabled = !settings.ttsEnabled;
				saveSettings(settings);
				updateStatus(ctx);
				ctx.ui.notify(
					`TTS：${settings.ttsEnabled ? "开启" : "关闭"}`,
					settings.ttsEnabled ? "success" : "warning",
				);
			}
		},
	});

	// agent_end 自动朗读
	pi.on("agent_end", async (event) => {
		if (!settings.ttsEnabled || !settings.apiKey) return;
		const msgs = event.messages;
		if (!msgs?.length) return;
		const last = msgs[msgs.length - 1];
		if (last.role !== "assistant") return;
		const text = (last.content as any[])
			.filter((c: any) => c.type === "text")
			.map((c: any) => c.text)
			.join("");
		const cleaned = cleanText(text);
		if (!cleaned) return;
		speakSentences(splitChunks(cleaned));
	});

	pi.on("session_shutdown", () => {
		stopSpeak();
	});
}
