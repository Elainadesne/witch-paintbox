export type ModelTransport = 'nonstream' | 'stream' | 'compatible';

export interface ModelApiSettings {
  mode: 'tavern' | 'custom';
  url: string;
  key: string;
  model: string;
  maxTokens: number;
  temperature: number;
  transport: ModelTransport;
}

export interface ModelMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ModelRequestOptions {
  signal?: AbortSignal;
  /** Stream: text received so far. Nonstream/compatible: final text only. Excludes reasoning-only fields. */
  onText?: (text: string) => void;
}
