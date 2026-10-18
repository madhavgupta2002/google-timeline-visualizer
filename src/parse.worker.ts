/// <reference lib="webworker" />
import { collectDocument, finishDataset, newCollector } from './parse';

export type WorkerRequest = { files: File[] };
export type WorkerResponse =
  | { type: 'progress'; message: string }
  | { type: 'done'; dataset: ReturnType<typeof finishDataset> }
  | { type: 'error'; message: string };

const post = (message: WorkerResponse, transfer: Transferable[] = []) => (self as DedicatedWorkerGlobalScope).postMessage(message, transfer);

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  try {
    const out = newCollector();
    const { files } = event.data;
    for (const [index, file] of files.entries()) {
      post({ type: 'progress', message: `Reading ${file.name} (${index + 1}/${files.length}, ${(file.size / 1e6).toFixed(1)} MB)…` });
      const text = await file.text();
      post({ type: 'progress', message: `Parsing ${file.name}…` });
      collectDocument(JSON.parse(text), out);
    }
    post({ type: 'progress', message: 'Cleaning and merging locations…' });
    const dataset = finishDataset(out);
    post({ type: 'done', dataset }, [dataset.t.buffer, dataset.lat.buffer, dataset.lng.buffer, dataset.tz.buffer, dataset.kind.buffer]);
  } catch (error) {
    post({ type: 'error', message: error instanceof SyntaxError ? 'This file is not valid JSON.' : (error as Error).message });
  }
};
