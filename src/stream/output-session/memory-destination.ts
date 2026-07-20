import { AudioTranscoderError } from '../../errors.js';
import type { AudioStreamOutput, AudioStreamOutputChunk } from '../contracts.js';
import type { AudioTranscoderOutputMemoryReservation } from '../output-session.js';
import {
  invalidConfiguration,
  sessionDisposedError,
  type OutputDestination,
} from './internal.js';

const MEMORY_MAX_PAGE_BYTES = 1024 * 1024;
const MEMORY_TARGET_PAGE_COUNT = 512;

export function createMemoryDestination(
  budget: SessionMemoryBudget,
): OutputDestination {
  return new PagedMemoryDestination(budget);
}

export class SessionMemoryBudget {
  private reservedBytes = 0;

  constructor(readonly limitBytes: number) {}

  reserve(bytes: number): void {
    if (bytes > this.limitBytes - this.reservedBytes) {
      throw memoryBudgetExceeded(this, bytes);
    }
    this.reservedBytes += bytes;
  }

  release(bytes: number): void {
    this.reservedBytes -= bytes;
  }

  snapshot(): AudioTranscoderOutputMemoryReservation {
    return Object.freeze({
      limitBytes: this.limitBytes,
      reservedBytes: this.reservedBytes,
    });
  }
}

class PagedMemoryDestination implements OutputDestination {
  private allocatedBytes = 0;
  private blobController:
    | ReadableStreamDefaultController<Uint8Array<ArrayBuffer>>
    | undefined;
  private closed = false;
  private completion: Promise<Blob> | undefined;
  private disposal: Promise<void> | undefined;
  private discarded = false;
  private length = 0;
  private readonly pageBytes: number;
  private readonly pages = new Map<number, Uint8Array<ArrayBuffer>>();
  private reservationBytes = 0;
  readonly storage = 'memory' as const;
  readonly stream: AudioStreamOutput;

  constructor(private readonly budget: SessionMemoryBudget) {
    this.pageBytes = Math.max(
      1,
      Math.min(
        MEMORY_MAX_PAGE_BYTES,
        Math.ceil(budget.limitBytes / MEMORY_TARGET_PAGE_COUNT),
      ),
    );
    this.stream = new WritableStream<AudioStreamOutputChunk>({
      abort: () => this.discard(),
      close: () => {
        this.closed = true;
      },
      write: (chunk) => this.write(chunk),
    });
  }

  complete(mimeType: string): Promise<Blob> {
    if (!this.closed || this.discarded) {
      return Promise.reject(
        invalidConfiguration(
          'In-memory output must be closed before it is completed.',
        ),
      );
    }
    this.completion ??= this.createBlob(mimeType);
    return this.completion;
  }

  discard(): Promise<void> {
    this.discarded = true;
    this.blobController?.error(sessionDisposedError());
    this.pages.clear();
    this.disposal ??= (async () => {
      await this.completion?.catch(() => undefined);
      this.releaseReservation();
    })();
    return this.disposal;
  }

  private async createBlob(mimeType: string): Promise<Blob> {
    const completedBytes = this.length;
    const sourceReservationBytes = this.reservationBytes;
    this.budget.reserve(completedBytes);
    let committed = false;
    const pageCount = Math.ceil(this.length / this.pageBytes);
    let pageIndex = 0;
    const stream = new ReadableStream<Uint8Array<ArrayBuffer>>({
      start: (controller) => {
        this.blobController = controller;
      },
      pull: (controller) => {
        if (pageIndex >= pageCount) {
          controller.close();
          return;
        }
        const page =
          this.pages.get(pageIndex) ?? new Uint8Array(this.pageBytes);
        this.pages.delete(pageIndex);
        const remaining = this.length - pageIndex * this.pageBytes;
        controller.enqueue(
          page.subarray(0, Math.min(remaining, this.pageBytes)),
        );
        pageIndex += 1;
      },
    });

    try {
      // Consume and release source pages incrementally during Blob materialization.
      const rawBlob = await new Response(stream).blob();
      const blob = rawBlob.slice(0, rawBlob.size, mimeType);
      this.budget.release(sourceReservationBytes);
      this.reservationBytes = blob.size;
      this.allocatedBytes = 0;
      committed = true;
      return blob;
    } finally {
      if (!committed) {
        this.budget.release(completedBytes);
      }
      this.blobController = undefined;
      this.pages.clear();
    }
  }

  private write({ data, position }: AudioStreamOutputChunk): void {
    if (this.closed || this.discarded) {
      throw invalidConfiguration('In-memory output is closed.');
    }
    if (!Number.isSafeInteger(position) || position < 0) {
      throw invalidConfiguration('Output write position is invalid.');
    }
    if (data.byteLength === 0) {
      return;
    }
    const end = position + data.byteLength;
    if (!Number.isSafeInteger(end)) {
      throw memoryBudgetExceeded(this.budget, data.byteLength);
    }

    const nextLength = Math.max(this.length, end);
    let newPageCount = 0;
    const firstPage = Math.floor(position / this.pageBytes);
    const lastPage = Math.floor((end - 1) / this.pageBytes);
    for (let pageIndex = firstPage; pageIndex <= lastPage; pageIndex += 1) {
      if (!this.pages.has(pageIndex)) {
        newPageCount += 1;
      }
    }
    const nextAllocatedBytes =
      this.allocatedBytes + newPageCount * this.pageBytes;
    const nextReservationBytes = Math.max(nextAllocatedBytes, nextLength);
    this.budget.reserve(nextReservationBytes - this.reservationBytes);
    this.allocatedBytes = nextAllocatedBytes;
    this.reservationBytes = nextReservationBytes;

    let sourceOffset = 0;
    let writePosition = position;
    while (sourceOffset < data.byteLength) {
      const pageIndex = Math.floor(writePosition / this.pageBytes);
      const pageOffset = writePosition % this.pageBytes;
      const writableBytes = Math.min(
        this.pageBytes - pageOffset,
        data.byteLength - sourceOffset,
      );
      const page = this.getPage(pageIndex);
      page.set(
        data.subarray(sourceOffset, sourceOffset + writableBytes),
        pageOffset,
      );
      sourceOffset += writableBytes;
      writePosition += writableBytes;
    }
    this.length = nextLength;
  }

  private getPage(index: number): Uint8Array<ArrayBuffer> {
    const current = this.pages.get(index);
    if (current !== undefined) {
      return current;
    }
    const page = new Uint8Array(this.pageBytes);
    this.pages.set(index, page);
    return page;
  }

  private releaseReservation(): void {
    this.budget.release(this.reservationBytes);
    this.reservationBytes = 0;
    this.allocatedBytes = 0;
    this.length = 0;
  }
}

function memoryBudgetExceeded(
  budget: SessionMemoryBudget,
  requestedBytes: number,
): AudioTranscoderError {
  return new AudioTranscoderError(
    'RESOURCE_LIMIT_EXCEEDED',
    `Session memory budget exceeded: ${budget.snapshot().reservedBytes} bytes reserved, ` +
      `${requestedBytes} requested, ${budget.limitBytes} limit.`,
  );
}
