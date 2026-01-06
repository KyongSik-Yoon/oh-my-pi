export type VoiceStopReason = "manual" | "silence" | "max" | "error";

export interface VoiceCaptureOptions {
	silenceMs: number;
	maxDurationMs: number;
	minSpeechMs: number;
	levelThreshold: number;
	chunkMs: number;
	preferredMimeType?: string;
}

export interface VoiceCaptureResult {
	blob: Blob | null;
	reason: VoiceStopReason;
	durationMs: number;
	mimeType: string | null;
}

const DEFAULT_CAPTURE_OPTIONS: VoiceCaptureOptions = {
	silenceMs: 1200,
	maxDurationMs: 20000,
	minSpeechMs: 500,
	levelThreshold: 0.02,
	chunkMs: 250,
	preferredMimeType: "audio/webm;codecs=opus",
};

export class VoiceCapture {
	private options: VoiceCaptureOptions;
	private stream?: MediaStream;
	private recorder?: MediaRecorder;
	private audioContext?: AudioContext;
	private analyser?: AnalyserNode;
	private data?: Float32Array<ArrayBuffer>;
	private chunks: Blob[] = [];
	private startedAt = 0;
	private speechDetectedAt?: number;
	private silenceStartedAt?: number;
	private stopResolver?: (result: VoiceCaptureResult) => void;
	private stopPromise?: Promise<VoiceCaptureResult>;
	private stopReason: VoiceStopReason = "manual";
	private monitorTimer?: number;
	private isStopping = false;
	private _isRecording = false;

	public get isRecording(): boolean {
		return this._isRecording;
	}

	constructor(options?: Partial<VoiceCaptureOptions>) {
		this.options = { ...DEFAULT_CAPTURE_OPTIONS, ...options };
	}

	async start(): Promise<VoiceCaptureResult> {
		if (this._isRecording && this.stopPromise) return this.stopPromise;
		if (!navigator.mediaDevices?.getUserMedia) {
			throw new Error("Media devices not available.");
		}
		if (typeof MediaRecorder === "undefined") {
			throw new Error("MediaRecorder not supported.");
		}
		this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });

		const mimeType = pickSupportedMimeType(this.options.preferredMimeType);
		this.recorder = mimeType ? new MediaRecorder(this.stream, { mimeType }) : new MediaRecorder(this.stream);

		this.chunks = [];
		this.startedAt = performance.now();
		this.speechDetectedAt = undefined;
		this.silenceStartedAt = undefined;
		this.stopReason = "manual";
		this.isStopping = false;
		this._isRecording = true;
		this.stopPromise = new Promise((resolve) => {
			this.stopResolver = resolve;
		});

		this.recorder.ondataavailable = (event: BlobEvent) => {
			if (event.data && event.data.size > 0) {
				this.chunks.push(event.data);
			}
		};
		this.recorder.onstop = () => {
			this.finish();
		};

		this.recorder.start(this.options.chunkMs);
		this.setupAnalyzer();
		this.startMonitor();

		return this.stopPromise;
	}

	async stop(reason: VoiceStopReason = "manual"): Promise<VoiceCaptureResult> {
		if (!this.recorder || !this._isRecording) {
			return { blob: null, reason, durationMs: 0, mimeType: null };
		}
		if (this.isStopping && this.stopPromise) {
			return this.stopPromise;
		}
		this.isStopping = true;
		this.stopReason = reason;
		this.recorder.stop();
		return this.stopPromise!;
	}

	private finish(): void {
		this._isRecording = false;
		const durationMs = Math.max(0, performance.now() - this.startedAt);
		const mimeType = this.recorder?.mimeType || null;
		const hasSpeech = this.speechDetectedAt !== undefined;
		const blob =
			hasSpeech && this.chunks.length > 0 ? new Blob(this.chunks, { type: mimeType || "audio/webm" }) : null;
		const result: VoiceCaptureResult = {
			blob,
			reason: this.stopReason,
			durationMs,
			mimeType,
		};
		this.cleanup();
		this.stopResolver?.(result);
	}

	private startMonitor(): void {
		this.monitorTimer = window.setInterval(() => {
			if (!this.analyser || !this.data || this.isStopping) return;

			this.analyser.getFloatTimeDomainData(this.data);
			const rms = getRms(this.data);
			const now = performance.now();

			if (rms >= this.options.levelThreshold) {
				if (!this.speechDetectedAt) {
					this.speechDetectedAt = now;
				}
				this.silenceStartedAt = undefined;
			} else if (this.speechDetectedAt) {
				if (!this.silenceStartedAt) {
					this.silenceStartedAt = now;
				} else if (
					now - this.silenceStartedAt >= this.options.silenceMs &&
					now - this.speechDetectedAt >= this.options.minSpeechMs
				) {
					void this.stop("silence");
					return;
				}
			}

			if (now - this.startedAt >= this.options.maxDurationMs) {
				void this.stop("max");
			}
		}, 100);
	}

	private setupAnalyzer(): void {
		if (!this.stream) return;
		this.audioContext = new AudioContext();
		this.analyser = this.audioContext.createAnalyser();
		this.analyser.fftSize = 2048;
		this.data = new Float32Array(this.analyser.fftSize);

		const source = this.audioContext.createMediaStreamSource(this.stream);
		source.connect(this.analyser);
	}

	private cleanup(): void {
		if (this.monitorTimer !== undefined) {
			clearInterval(this.monitorTimer);
			this.monitorTimer = undefined;
		}
		if (this.stream) {
			for (const track of this.stream.getTracks()) {
				track.stop();
			}
			this.stream = undefined;
		}
		if (this.audioContext) {
			void this.audioContext.close();
			this.audioContext = undefined;
		}
		this.analyser = undefined;
		this.data = undefined;
		this.recorder = undefined;
		this.chunks = [];
		this.isStopping = false;
	}
}

export interface TranscribeOptions {
	apiKey: string;
	model?: string;
	language?: string;
	prompt?: string;
}

export async function transcribeOpenAI(blob: Blob, options: TranscribeOptions): Promise<string> {
	const formData = new FormData();
	const filename = blob.type.includes("ogg") ? "voice.ogg" : "voice.webm";
	const file = new File([blob], filename, { type: blob.type || "audio/webm" });
	formData.append("file", file);
	formData.append("model", options.model || "whisper-1");
	if (options.language) formData.append("language", options.language);
	if (options.prompt) formData.append("prompt", options.prompt);

	const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${options.apiKey}`,
		},
		body: formData,
	});

	if (!response.ok) {
		throw new Error(`Transcription failed (${response.status})`);
	}

	const data = (await response.json()) as { text?: string };
	return data.text?.trim() || "";
}

export interface SpeechOptions {
	apiKey: string;
	model?: string;
	voice?: string;
	responseFormat?: "mp3" | "wav" | "opus";
	speed?: number;
}

export async function synthesizeOpenAI(text: string, options: SpeechOptions): Promise<Blob> {
	const response = await fetch("https://api.openai.com/v1/audio/speech", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${options.apiKey}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			model: options.model || "tts-1",
			voice: options.voice || "alloy",
			input: text,
			response_format: options.responseFormat || "mp3",
			speed: options.speed,
		}),
	});

	if (!response.ok) {
		throw new Error(`Speech synthesis failed (${response.status})`);
	}

	return response.blob();
}

function pickSupportedMimeType(preferred?: string): string | undefined {
	const candidates = [preferred, "audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/ogg"].filter(
		(value): value is string => typeof value === "string",
	);

	for (const candidate of candidates) {
		if (MediaRecorder.isTypeSupported(candidate)) {
			return candidate;
		}
	}
	return undefined;
}

function getRms(data: Float32Array): number {
	let sum = 0;
	for (let i = 0; i < data.length; i += 1) {
		const sample = data[i] ?? 0;
		sum += sample * sample;
	}
	return Math.sqrt(sum / data.length);
}
