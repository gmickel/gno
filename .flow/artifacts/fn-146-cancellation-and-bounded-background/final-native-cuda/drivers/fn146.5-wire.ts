/** Raw loopback HTTP and stdio MCP. No native/model imports. */
export class HttpWire {
  session = "";
  version = "2025-06-18";
  constructor(public base: string, public save: (id: string, value: unknown) => Promise<void>) {
    const url = new URL(base);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port) throw Error("Owned loopback URL required");
  }
  async send(id: string, path: string, body?: unknown, signal?: AbortSignal, method = body === undefined ? "GET" : "POST") {
    const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream", origin: this.base };
    if (this.session && path === "/mcp") Object.assign(headers, { "mcp-session-id": this.session, "mcp-protocol-version": this.version });
    const start = Date.now();
    let text = "", status: number | undefined, responseHeaders: Record<string, string> | undefined;
    try {
      const response = await fetch(this.base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal });
      this.session = response.headers.get("mcp-session-id") ?? this.session;
      status = response.status; responseHeaders = Object.fromEntries(response.headers);
      if (response.body) {
        const decoder = new TextDecoder();
        for await (const chunk of response.body) text += decoder.decode(chunk, { stream: true });
        text += decoder.decode();
      }
      let parsed: unknown;
      try { parsed = JSON.parse(text); } catch {
        const events = text.split(/\r?\n\r?\n/).flatMap(block => {
          const data = block.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
          if (!data) return [];
          try { return [JSON.parse(data)]; } catch { return [{ unparsed: data }]; }
        });
        parsed = events.length === 1 ? events[0] : events;
      }
      const result = { status: response.status, headers: Object.fromEntries(response.headers), text, parsed, start, settled: Date.now() };
      await this.save(id, { request: { path, body, method }, ...result });
      if (path === "/mcp" && method === "DELETE" && response.ok) this.session = "";
      return result;
    } catch (error) { await this.save(id, { request: { path, body, method }, start, settled: Date.now(), status, headers: responseHeaders, partialText: text, error: String(error) }); throw error; }
  }
  async initialize() {
    if (this.session) return;
    const response: any = await this.send("mcp-initialize", "/mcp", { jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: this.version, capabilities: {}, clientInfo: { name: "fn1465-owned-qa", version: "1" } } });
    if (!response.parsed?.result?.protocolVersion) throw Error("MCP initialization failed");
    this.version = response.parsed.result.protocolVersion;
    await this.send("mcp-initialized", "/mcp", { jsonrpc: "2.0", method: "notifications/initialized" });
  }
}

export class StdioWire {
  private buffer = "";
  private pending = new Map<string | number, { resolve: (x: any) => void; reject: (e: Error) => void }>();
  readonly pumping: Promise<void>;
  constructor(public child: Bun.Subprocess<"pipe", "pipe", "pipe">, private save: (id: string, value: unknown) => Promise<void>) {
    this.pumping = this.pump();
  }
  private async pump() {
    const decoder = new TextDecoder();
    try {
      for await (const chunk of this.child.stdout) {
        this.buffer += decoder.decode(chunk, { stream: true });
        for (let end; (end = this.buffer.indexOf("\n")) >= 0;) {
          const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
          if (!line.trim()) continue;
          const row = JSON.parse(line); await this.save(`stdio-${row.id ?? "notification"}-${Date.now()}`, { raw: line, row });
          if (row.id !== undefined) { this.pending.get(row.id)?.resolve(row); this.pending.delete(row.id); }
        }
      }
    } finally { for (const value of this.pending.values()) value.reject(Error("stdio transport closed")); this.pending.clear(); }
  }
  send(message: any): Promise<any> {
    const result = message.id === undefined ? Promise.resolve(undefined) : new Promise((resolve, reject) => this.pending.set(message.id, { resolve, reject }));
    this.child.stdin.write(JSON.stringify(message) + "\n"); this.child.stdin.flush();
    return result;
  }
  async initialize() {
    await this.send({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fn1465-owned-qa", version: "1" } } });
    await this.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  }
  close() { this.child.stdin.end(); }
  retireCaller(id: string | number) { this.pending.get(id)?.reject(Error("Caller cancelled after MCP notification; native settlement observed independently")); this.pending.delete(id); }
}
