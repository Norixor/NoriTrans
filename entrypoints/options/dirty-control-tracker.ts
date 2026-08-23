export class DirtyControlTracker {
  private readonly versions = new Map<string, number>();
  private revision = 0;

  get size(): number {
    return this.versions.size;
  }

  has(id: string): boolean {
    return this.versions.has(id);
  }

  mark(id: string): void {
    this.versions.set(id, ++this.revision);
  }

  snapshot(): ReadonlyMap<string, number> {
    return new Map(this.versions);
  }

  confirm(snapshot: ReadonlyMap<string, number>): void {
    for (const [id, submittedVersion] of snapshot) {
      if (this.versions.get(id) === submittedVersion) {
        this.versions.delete(id);
      }
    }
  }
}
