export type ImageGenerationProgress =
  | { state: 'queued'; position: number; columns?: number }
  | { state: 'generating'; columns?: number };

interface QueuedGeneration {
  position: number;
  onProgress?: (progress: ImageGenerationProgress) => void;
  start: () => Promise<void>;
}

const waiting: QueuedGeneration[] = [];
let running = false;
interface ImageQueueState { generating: boolean; queued: number }
const listeners = new Set<(state: ImageQueueState) => void>();

export function onImageQueueChanged(listener: (state: ImageQueueState) => void): () => void {
  listener({ generating: running, queued: waiting.length });
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function notifyQueue(): void {
  for (const listener of listeners) {
    try { listener({ generating: running, queued: waiting.length }); }
    catch { /* A launcher update must not interrupt the shared queue. */ }
  }
}

function cancelled(): DOMException {
  return new DOMException('本次生图已取消。', 'AbortError');
}

function report(task: QueuedGeneration, progress: ImageGenerationProgress): void {
  try {
    task.onProgress?.(progress);
  } catch {
    // A view update must not interrupt a generation or block the queue.
  }
}

function updatePositions(): void {
  for (const task of [...waiting]) {
    // Progress callbacks may cancel other waiting tasks.
    const position = waiting.indexOf(task) + 1;
    if (position && task.position !== position) {
      task.position = position;
      report(task, { state: 'queued', position });
    }
  }
  notifyQueue();
}

async function drain(): Promise<void> {
  if (running) return;
  running = true;
  try {
    while (waiting.length) {
      const task = waiting.shift()!;
      await task.start();
    }
  } finally {
    running = false;
    notifyQueue();
  }
}

/** One shared FIFO for every image entry point; the operation includes response decoding. */
export function queueImageGeneration<T>(
  operation: () => Promise<T>,
  signal: AbortSignal,
  onProgress?: (progress: ImageGenerationProgress) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      reject(cancelled());
      return;
    }
    const cancel = () => {
      const index = waiting.indexOf(task);
      if (index < 0) return;
      waiting.splice(index, 1);
      signal.removeEventListener('abort', cancel);
      reject(cancelled());
      updatePositions();
    };
    const task: QueuedGeneration = {
      position: 0,
      onProgress,
      async start() {
        signal.removeEventListener('abort', cancel);
        try {
          if (signal.aborted) throw cancelled();
          report(task, { state: 'generating' });
          updatePositions();
          if (signal.aborted) throw cancelled();
          resolve(await operation());
        } catch (error) {
          reject(error);
        }
      },
    };
    waiting.push(task);
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
    if (running) updatePositions();
    else void drain();
  });
}
