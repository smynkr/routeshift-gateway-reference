export interface SSEEvent {
  event?: string;
  data: string;
}

export class SSEParser {
  private buffer = '';

  push(chunk: string): SSEEvent[] {
    this.buffer += chunk;
    const events: SSEEvent[] = [];

    while (true) {
      const idx = this.buffer.indexOf('\n\n');
      if (idx === -1) break;

      const block = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 2);

      const event = this.parseBlock(block);
      if (event) events.push(event);
    }

    return events;
  }

  private parseBlock(block: string): SSEEvent | null {
    let event: string | undefined;
    const dataLines: string[] = [];

    for (const line of block.split('\n')) {
      if (line.startsWith('data: ')) {
        dataLines.push(line.slice(6));
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5));
      } else if (line.startsWith('event: ')) {
        event = line.slice(7);
      } else if (line.startsWith('event:')) {
        event = line.slice(6);
      }
    }

    if (dataLines.length === 0) return null;
    // Per SSE spec: multiple data: lines are concatenated with '\n'
    const data = dataLines.join('\n');
    return event ? { event, data } : { data };
  }
}
