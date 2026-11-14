/**
 * A workspace's explainer agents. Each request borrows an idle agent, or a new one while fewer
 * than `max` exist, so requests made together run together instead of one after another. Past
 * `max`, requests wait for an agent to come back.
 */
export class AgentPool {
  private readonly idle: string[] = [];
  /** Borrowed agents, with the generation they were borrowed in. */
  private readonly busy = new Map<string, number>();
  /** Agents owned by the pool, idle or borrowed, including ones being created. */
  private size = 0;
  /** Requests waiting for an agent: handed one, or null when a slot opened to create one. */
  private readonly waiters: Array<(id: string | null) => void> = [];
  /** Bumped by `retireAll`; agents borrowed before it are discarded when they come back. */
  private generation = 0;
  private readonly ready: Promise<void>;
  private readonly max: number;
  private readonly create: () => Promise<string>;
  private readonly discard: (id: string) => Promise<void>;

  constructor(
    max: number,
    create: () => Promise<string>,
    discard: (id: string) => Promise<void>,
    /** Agents left from an earlier run of the plugin, reused before any new one is created. */
    existing: Promise<string[]>,
  ) {
    this.max = max;
    this.create = create;
    this.discard = discard;
    this.ready = existing.then(
      (ids) => {
        this.idle.push(...ids);
        this.size += ids.length;
      },
      (cause) => console.error("Could not list existing explainers:", cause),
    );
  }

  async acquire(): Promise<string> {
    await this.ready;
    for (;;) {
      const id =
        this.idle.pop() ??
        (this.size < this.max ? await this.grow() : await new Promise<string | null>((resolve) => this.waiters.push(resolve)));
      if (id) {
        this.busy.set(id, this.generation);
        return id;
      }
    }
  }

  /** Returns a borrowed agent; `keep: false` discards it, as after a failed or overgrown turn. */
  async release(id: string, keep: boolean): Promise<void> {
    const generation = this.busy.get(id);
    this.busy.delete(id);
    if (keep && generation === this.generation) {
      const waiter = this.waiters.shift();
      if (waiter) waiter(id);
      else this.idle.push(id);
      return;
    }
    this.size--;
    this.waiters.shift()?.(null);
    await this.discard(id);
  }

  /**
   * Discards every agent: idle ones now, borrowed ones when they come back. Returns how many
   * agents that covers.
   */
  async retireAll(): Promise<number> {
    await this.ready;
    this.generation++;
    const idle = this.idle.splice(0);
    this.size -= idle.length;
    for (let i = 0; i < idle.length; i++) this.waiters.shift()?.(null);
    await Promise.all(idle.map((id) => this.discard(id)));
    return idle.length + this.busy.size;
  }

  private async grow(): Promise<string> {
    this.size++;
    try {
      return await this.create();
    } catch (cause) {
      this.size--;
      this.waiters.shift()?.(null);
      throw cause;
    }
  }
}
