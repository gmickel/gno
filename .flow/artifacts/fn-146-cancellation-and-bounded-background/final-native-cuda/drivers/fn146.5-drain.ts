/** Incremental exact-byte pipe drain. Bun.write(stream/Response) is unsuitable for these child pipes. */
export async function drainStream(path: string, stream: ReadableStream<Uint8Array>) {
  const writer = Bun.file(path).writer();
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      writer.write(value);
      await writer.flush();
    }
  } finally {
    reader.releaseLock();
    await writer.end();
  }
}
