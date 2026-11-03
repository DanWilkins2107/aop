/** Tells open event streams that data changed. Carries no detail: clients just refetch. */
export class ChangeFeed {
  private readonly listeners = new Set<() => void>();

  get size(): number {
    return this.listeners.size;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notify(): void {
    for (const listener of this.listeners) listener();
  }
}
